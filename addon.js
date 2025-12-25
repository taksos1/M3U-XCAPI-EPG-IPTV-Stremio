const { addonBuilder } = require('stremio-addon-sdk');
const fetch = require('node-fetch');
const crypto = require('crypto');

const ADDON_ID = 'org.taksos.iptv.enhanced';
const ADDON_NAME = '🎬 Taksos IPTV Enhanced';

// Simple in-memory cache to reduce IPTV server load
const cache = new Map();
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes

class EnhancedIPTVAddon {
    constructor(config) {
        this.config = config;
        this.channels = [];
        this.movies = [];
        this.series = [];
        this.contentIndex = new Map(); // Fast lookup by name/title
        this.imdbIndex = new Map(); // IMDB ID mappings
    }

    async init() {
        console.log('[ENHANCED] Initializing addon...');
        if (!this.config) {
            console.log('[ENHANCED] No config provided');
            return;
        }

        if (this.config.xtreamUrl && this.config.xtreamUsername && this.config.xtreamPassword) {
            await this.loadXtreamData();
            this.buildSearchIndexes();
        }
    }

    getCachedData(key) {
        const cached = cache.get(key);
        if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
            return cached.data;
        }
        cache.delete(key);
        return null;
    }

    setCachedData(key, data) {
        const timestamp = Date.now();
        cache.set(key, { data, timestamp });

        // Clean old cache entries
        if (cache.size > 100) {
            const oldestKey = cache.keys().next().value;
            cache.delete(oldestKey);
        }
    }

    async loadXtreamData() {
        const { xtreamUrl, xtreamUsername, xtreamPassword } = this.config;
        const cacheKey = `iptv_enhanced_${crypto.createHash('md5').update(xtreamUrl + xtreamUsername).digest('hex')}`;

        const cachedData = this.getCachedData(cacheKey);
        if (cachedData) {
            console.log('[ENHANCED] Using cached data');
            this.channels = cachedData.channels || [];
            this.movies = cachedData.movies || [];
            this.series = cachedData.series || [];
            return;
        }

        const base = `${xtreamUrl}/player_api.php?username=${encodeURIComponent(xtreamUsername)}&password=${encodeURIComponent(xtreamPassword)}`;

        try {
            console.log('[ENHANCED] Loading fresh data...');

            // Load all content types
            const [liveData, vodData, seriesData] = await Promise.all([
                this.fetchWithRetry(`${base}&action=get_live_streams`),
                this.fetchWithRetry(`${base}&action=get_vod_streams`),
                this.fetchWithRetry(`${base}&action=get_series`)
            ]);

            // Process live channels
            this.channels = Array.isArray(liveData) ? liveData.map(item => ({
                id: `live_${item.stream_id}`,
                name: item.name,
                type: 'tv',
                url: `${xtreamUrl}/live/${xtreamUsername}/${xtreamPassword}/${item.stream_id}.m3u8`,
                logo: item.stream_icon,
                category: item.category_name || 'Live TV',
                streamType: 'live'
            })) : [];

            // Process movies
            this.movies = Array.isArray(vodData) ? vodData.map(item => ({
                id: `vod_${item.stream_id}`,
                name: item.name,
                type: 'movie',
                url: `${xtreamUrl}/movie/${xtreamUsername}/${xtreamPassword}/${item.stream_id}.${item.container_extension || 'mp4'}`,
                poster: item.stream_icon,
                category: item.category_name || 'Movies',
                plot: item.plot || null,
                year: item.year || null,
                streamType: 'movie'
            })) : [];

            // Process series
            this.series = Array.isArray(seriesData) ? seriesData.map(item => ({
                id: `series_${item.series_id}`,
                name: item.name,
                type: 'series',
                poster: item.cover,
                category: item.category_name || 'Series',
                plot: item.plot || null,
                year: item.year || null,
                rating: item.rating || null,
                genre: item.genre ? item.genre.split(',').map(g => g.trim()) : [],
                streamType: 'series'
            })) : [];

            // Cache the data
            this.setCachedData(cacheKey, {
                channels: this.channels,
                movies: this.movies,
                series: this.series
            });

            console.log(`[ENHANCED] Loaded ${this.channels.length} channels, ${this.movies.length} movies, ${this.series.length} series`);

        } catch (error) {
            console.error('[ENHANCED] Failed to load data:', error.message);
        }
    }

    async fetchWithRetry(url, retries = 3) {
        for (let i = 0; i < retries; i++) {
            try {
                const response = await fetch(url, { timeout: 15000 });
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                return await response.json();
            } catch (error) {
                if (i === retries - 1) throw error;
                await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
            }
        }
    }

    buildSearchIndexes() {
        console.log('[ENHANCED] Building search indexes...');

        const allContent = [...this.channels, ...this.movies, ...this.series];

        // Build name-based index with transliterations
        allContent.forEach(item => {
            const variations = this.getSearchVariations(item.name);
            variations.forEach(variation => {
                const key = variation.toLowerCase();
                if (!this.contentIndex.has(key)) {
                    this.contentIndex.set(key, []);
                }
                this.contentIndex.get(key).push(item);
            });
        });

        console.log(`[ENHANCED] Built index with ${this.contentIndex.size} search terms`);
    }

    getSearchVariations(name) {
        const variations = [name];

        // Add transliterations
        variations.push(...this.getTransliterations(name));

        // Add cleaned versions
        const cleaned = name.replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
        if (cleaned !== name) {
            variations.push(cleaned);
        }

        // Add word combinations
        const words = cleaned.split(' ').filter(w => w.length > 2);
        if (words.length > 1) {
            variations.push(...words);
        }

        return [...new Set(variations.filter(v => v && v.length > 0))];
    }

    getTransliterations(searchTerm) {
        const results = [searchTerm];
        const searchLower = searchTerm.toLowerCase().trim();

        // Enhanced letter mapping for better Arabic support
        const letterMap = {
            'a': ['ا', 'أ', 'إ', 'آ', 'ع'],
            'b': ['ب'],
            'c': ['ك', 'س'],
            'd': ['د', 'ض'],
            'e': ['ي', 'ع', 'ا'],
            'f': ['ف'],
            'g': ['ج', 'غ'],
            'h': ['ه', 'ح', 'خ'],
            'i': ['ي', 'ا'],
            'j': ['ج'],
            'k': ['ك', 'ق'],
            'l': ['ل'],
            'm': ['م'],
            'n': ['ن'],
            'o': ['و', 'ا'],
            'p': ['ب'],
            'q': ['ق', 'ك'],
            'r': ['ر'],
            's': ['س', 'ص', 'ش'],
            't': ['ت', 'ط'],
            'u': ['و', 'ا'],
            'v': ['ف', 'ب'],
            'w': ['و'],
            'x': ['كس', 'إكس'],
            'y': ['ي'],
            'z': ['ز', 'ظ']
        };

        // Common word mappings for popular content
        const commonWords = {
            'midterm': ['نصف المدة', 'ميد ترم', 'منتصف الفصل'],
            'paranormal': ['ما وراء الطبيعة', 'بارانورمال'],
            'omar': ['عمر'],
            'ahmed': ['أحمد', 'احمد'],
            'mohamed': ['محمد'],
            'ali': ['علي', 'على'],
            'hassan': ['حسن'],
            'series': ['مسلسل'],
            'movie': ['فيلم'],
            'episode': ['حلقة'],
            'season': ['موسم', 'سيزن'],
            'breaking bad': ['بريكنغ باد'],
            'money heist': ['بيت من ورق', 'لا كاسا دي بابيل'],
            'game of thrones': ['صراع العروش']
        };

        // Add common word translations
        Object.keys(commonWords).forEach(english => {
            if (searchLower.includes(english)) {
                results.push(...commonWords[english]);
            }
        });

        // Add reverse mappings (Arabic to English)
        const reverseMap = {
            'منتصف الفصل': ['midterm', 'mid term'],
            'نصف المدة': ['midterm', 'mid term'],
            'ميد ترم': ['midterm'],
            'ما وراء الطبيعة': ['paranormal'],
            'بارانورمال': ['paranormal'],
            'عمر': ['omar'],
            'أحمد': ['ahmed'],
            'احمد': ['ahmed'],
            'محمد': ['mohamed', 'muhammad'],
            'علي': ['ali'],
            'على': ['ali'],
            'مسلسل': ['series'],
            'فيلم': ['movie']
        };

        Object.keys(reverseMap).forEach(arabic => {
            if (searchLower.includes(arabic)) {
                results.push(...reverseMap[arabic]);
            }
        });

        // Generate letter-by-letter transliterations (limited to prevent explosion)
        let arabicVariations = [''];
        for (const char of searchLower) {
            if (letterMap[char]) {
                const newVariations = [];
                for (const variation of arabicVariations.slice(0, 5)) { // Limit variations
                    for (const arabicChar of letterMap[char].slice(0, 2)) { // Limit chars
                        newVariations.push(variation + arabicChar);
                    }
                }
                arabicVariations = newVariations;
            } else if (char === ' ') {
                arabicVariations = arabicVariations.map(v => v + ' ');
            } else {
                arabicVariations = arabicVariations.map(v => v + char);
            }
        }

        results.push(...arabicVariations.filter(v => v.length > 1));

        return [...new Set(results.filter(r => r && r.trim().length > 0))];
    }

    async smartSearch(query) {
        if (!query || query.length < 2) return [];

        const searchTerms = this.getSearchVariations(query);
        const results = new Map();

        // Search through indexed content
        searchTerms.forEach(term => {
            const key = term.toLowerCase();

            // Exact matches
            if (this.contentIndex.has(key)) {
                this.contentIndex.get(key).forEach(item => {
                    const id = item.id;
                    if (!results.has(id)) {
                        results.set(id, { ...item, matchScore: 100 });
                    } else {
                        results.get(id).matchScore = Math.max(results.get(id).matchScore, 100);
                    }
                });
            }

            // Partial matches
            for (const [indexKey, items] of this.contentIndex.entries()) {
                if (indexKey.includes(key) || key.includes(indexKey)) {
                    const score = key.length / indexKey.length * 50;
                    items.forEach(item => {
                        const id = item.id;
                        if (!results.has(id)) {
                            results.set(id, { ...item, matchScore: score });
                        } else {
                            results.get(id).matchScore = Math.max(results.get(id).matchScore, score);
                        }
                    });
                }
            }
        });

        // Sort by match score and return top results
        return Array.from(results.values())
            .sort((a, b) => b.matchScore - a.matchScore)
            .slice(0, 50);
    }

    async getIMDBMetadata(title, type = 'movie', year = null) {
        try {
            const cleanTitle = title
                .replace(/\d{4}.*$/, '')
                .replace(/[^\w\s]/g, ' ')
                .replace(/\s+/g, ' ')
                .trim();

            const searchTerms = [cleanTitle, ...this.getTransliterations(cleanTitle).slice(0, 3)];

            for (const searchTerm of searchTerms) {
                try {
                    const omdbKey = process.env.OMDB_API_KEY || 'demo';
                    const searchUrl = `https://www.omdbapi.com/?apikey=${omdbKey}&t=${encodeURIComponent(searchTerm)}&type=${type}&y=${year || ''}`;

                    const response = await fetch(searchUrl, { timeout: 5000 });
                    const data = await response.json();

                    if (data.Response === 'True') {
                        return {
                            imdbID: data.imdbID,
                            title: data.Title,
                            year: data.Year,
                            plot: data.Plot !== 'N/A' ? data.Plot : null,
                            poster: data.Poster !== 'N/A' ? data.Poster : null,
                            imdbRating: data.imdbRating !== 'N/A' ? data.imdbRating : null,
                            genre: data.Genre !== 'N/A' ? data.Genre.split(', ') : [],
                            director: data.Director !== 'N/A' ? data.Director : null,
                            actors: data.Actors !== 'N/A' ? data.Actors : null,
                            runtime: data.Runtime !== 'N/A' ? data.Runtime : null
                        };
                    }
                } catch (e) {
                    continue;
                }
            }
        } catch (error) {
            console.log(`[IMDB] Failed to fetch metadata for: ${title}`);
        }
        return null;
    }

    async generateMeta(item) {
        const meta = {
            id: item.id,
            type: item.type,
            name: item.name,
            genres: item.genre || [item.category]
        };

        // Get IMDB metadata for enhanced information
        if (item.type !== 'tv') {
            const imdbData = await this.getIMDBMetadata(
                item.name,
                item.type === 'series' ? 'series' : 'movie',
                item.year
            );

            if (imdbData) {
                meta.poster = imdbData.poster || item.poster;
                meta.description = imdbData.plot || item.plot;
                meta.imdbRating = imdbData.imdbRating;
                meta.genre = imdbData.genre.length ? imdbData.genre : meta.genres;
                meta.director = imdbData.director;
                meta.cast = imdbData.actors ? imdbData.actors.split(', ') : [];
                meta.runtime = imdbData.runtime;

                // Store IMDB mapping for future use
                this.imdbIndex.set(item.id, imdbData.imdbID);
            }
        }

        // Add series-specific data
        if (item.type === 'series') {
            try {
                const episodes = await this.getSeriesEpisodes(item.id);
                if (episodes.length > 0) {
                    meta.videos = episodes.map(ep => ({
                        id: ep.id,
                        title: ep.title,
                        season: ep.season,
                        episode: ep.episode,
                        overview: ep.overview,
                        thumbnail: ep.thumbnail,
                        released: ep.released
                    }));
                }
            } catch (error) {
                console.error(`[META] Failed to get episodes for ${item.name}:`, error.message);
            }
        }

        return meta;
    }

    async getSeriesEpisodes(seriesId) {
        const actualSeriesId = seriesId.replace('series_', '');
        const { xtreamUrl, xtreamUsername, xtreamPassword } = this.config;

        try {
            const episodeUrl = `${xtreamUrl}/player_api.php?username=${xtreamUsername}&password=${xtreamPassword}&action=get_series_info&series_id=${actualSeriesId}`;
            const response = await fetch(episodeUrl, { timeout: 10000 });
            const seriesInfo = await response.json();

            const episodes = [];
            if (seriesInfo.episodes) {
                Object.keys(seriesInfo.episodes).forEach(seasonNum => {
                    const seasonEpisodes = seriesInfo.episodes[seasonNum];
                    seasonEpisodes.forEach(episode => {
                        episodes.push({
                            id: `${seriesId}:${seasonNum}:${episode.episode_num}`,
                            title: episode.title || `Episode ${episode.episode_num}`,
                            season: parseInt(seasonNum),
                            episode: parseInt(episode.episode_num),
                            overview: episode.plot || '',
                            thumbnail: episode.info?.movie_image || null,
                            released: episode.air_date || null
                        });
                    });
                });
            }

            return episodes.sort((a, b) => {
                if (a.season !== b.season) return a.season - b.season;
                return a.episode - b.episode;
            });
        } catch (error) {
            console.error(`[EPISODES] Failed to get episodes for series ${actualSeriesId}:`, error.message);
            return [];
        }
    }

    async getStream(id) {
        console.log(`[STREAM] Getting stream for: ${id}`);

        // Handle series episodes
        if (id.includes(':')) {
            const [seriesId, season, episode] = id.split(':');
            const actualSeriesId = seriesId.replace('series_', '');

            try {
                const episodes = await this.getSeriesEpisodes(seriesId);
                const episodeData = episodes.find(ep =>
                    ep.season === parseInt(season) && ep.episode === parseInt(episode)
                );

                if (episodeData) {
                    const { xtreamUrl, xtreamUsername, xtreamPassword } = this.config;
                    const streamUrl = `${xtreamUrl}/series/${xtreamUsername}/${xtreamPassword}/${actualSeriesId}.${episode}.mp4`;

                    return {
                        streams: [{
                            url: streamUrl,
                            title: `📺 ${episodeData.title}`,
                            behaviorHints: {
                                notWebReady: true,
                                bingeGroup: `taksos-series-${actualSeriesId}`
                            }
                        }]
                    };
                }
            } catch (error) {
                console.error(`[STREAM] Episode stream error:`, error.message);
            }
        }

        // Handle direct content
        const allItems = [...this.channels, ...this.movies, ...this.series];
        const item = allItems.find(item => item.id === id);

        if (item && item.url) {
            return {
                streams: [{
                    url: item.url,
                    title: `🎬 ${item.name}`,
                    behaviorHints: {
                        notWebReady: true
                    }
                }]
            };
        }

        console.log(`[STREAM] No stream found for: ${id}`);
        return { streams: [] };
    }
}

// Create addon interface
async function createEnhancedAddon(config) {
    const addon = new EnhancedIPTVAddon(config);
    await addon.init();

    // Manifest with NO catalogs - only meta and stream resources
    // This makes content appear in main Stremio search, not separate sections
    const manifest = {
        id: ADDON_ID,
        version: "3.1.0",
        name: ADDON_NAME,
        description: "🚀 Enhanced IPTV integration that appears in main Stremio search with smart Arabic/English matching",
        logo: "https://i.imgur.com/X8K9YzF.png",
        background: "https://i.imgur.com/dQjTuXK.jpg",
        resources: ["meta", "stream"], // NO catalogs - this is key!
        types: ["tv", "movie", "series"],
        idPrefixes: ["live_", "vod_", "series_"], // Only respond to our content IDs
        behaviorHints: {
            configurable: true,
            configurationRequired: false
        }
    };

    const builder = new addonBuilder(manifest);

    // Meta handler - provides metadata for items found in Stremio's main search
    builder.defineMetaHandler(async (args) => {
        const { type, id } = args;
        console.log(`[META] Request for: ${type}/${id}`);

        try {
            // Find the item in our content
            const allItems = [...addon.channels, ...addon.movies, ...addon.series];
            const item = allItems.find(item => item.id === id);

            if (!item) {
                // This is the magic: when Stremio searches for "Midterm",
                // we search our content and return matches
                const searchResults = await addon.smartSearch(id);
                if (searchResults.length > 0) {
                    const bestMatch = searchResults[0];
                    const meta = await addon.generateMeta(bestMatch);
                    console.log(`[META] Found match via search: ${bestMatch.name}`);
                    return { meta };
                }
                throw new Error('Item not found');
            }

            const meta = await addon.generateMeta(item);
            console.log(`[META] Generated meta for: ${item.name}`);
            return { meta };

        } catch (error) {
            console.error(`[META] Error:`, error.message);
            throw new Error('Meta not available');
        }
    });

    // Stream handler - provides actual stream URLs
    builder.defineStreamHandler(async (args) => {
        const { type, id } = args;
        console.log(`[STREAM] Request for: ${type}/${id}`);

        try {
            const result = await addon.getStream(id);
            console.log(`[STREAM] Returning ${result.streams.length} streams for: ${id}`);
            return result;
        } catch (error) {
            console.error(`[STREAM] Error:`, error.message);
            return { streams: [] };
        }
    });

    return builder.getInterface();
}

module.exports = createEnhancedAddon;
