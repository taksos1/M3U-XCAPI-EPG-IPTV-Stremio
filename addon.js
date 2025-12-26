const { addonBuilder } = require('stremio-addon-sdk');
const fetch = require('node-fetch');
const crypto = require('crypto');

const ADDON_ID = 'org.stremio.iptv.selfhosted';
const ADDON_NAME = 'IPTV Self-Hosted';

// Simple in-memory cache to reduce IPTV server load
const cache = new Map();
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes

class IPTVAddon {
    constructor(config) {
        this.config = config;
        this.channels = [];
        this.movies = [];
        this.series = [];
        this.categories = {
            live: [],
            movies: [],
            series: []
        };
    }

    async init() {
        console.log('[ADDON] Initializing with config:', this.config ? 'present' : 'null');
        if (!this.config) {
            console.log('[ADDON] No config provided, using empty addon');
            return;
        }
        
        if (this.config.xtreamUrl && this.config.xtreamUsername && this.config.xtreamPassword) {
            console.log('[ADDON] Loading Xtream data from:', this.config.xtreamUrl);
            await this.loadXtreamData();
        } else {
            console.log('[ADDON] Missing Xtream credentials:', {
                url: !!this.config.xtreamUrl,
                username: !!this.config.xtreamUsername,
                password: !!this.config.xtreamPassword
            });
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
        cache.set(key, { data, timestamp: Date.now() });
        // Clean old cache entries
        if (cache.size > 100) {
            const oldestKey = cache.keys().next().value;
            cache.delete(oldestKey);
        }
    }

    async loadXtreamData() {
        const { xtreamUrl, xtreamUsername, xtreamPassword } = this.config;
        const cacheKey = `iptv_data_${crypto.createHash('md5').update(xtreamUrl + xtreamUsername).digest('hex')}`;
        
        // Check cache first to reduce server load
        const cachedData = this.getCachedData(cacheKey);
        if (cachedData) {
            console.log('[IPTV] Using cached data to reduce server load');
            this.channels = cachedData.channels || [];
            this.movies = cachedData.movies || [];
            this.series = cachedData.series || [];
            this.categories = cachedData.categories || { live: [], movies: [], series: [] };
            return;
        }

        const base = `${xtreamUrl}/player_api.php?username=${encodeURIComponent(xtreamUsername)}&password=${encodeURIComponent(xtreamPassword)}`;

        try {
            console.log('[IPTV] Loading fresh data from server...');
            
            // Test server connection with shorter timeout to avoid overload
            const testResp = await fetch(`${base}&action=get_live_categories`, { timeout: 5000 });
            if (!testResp.ok) {
                console.log('[IPTV] Server connection failed, trying alternative formats...');
                return await this.tryAlternativeFormats();
            }

            // Get live channels
            console.log('[IPTV] Fetching live streams...');
            const liveResp = await fetch(`${base}&action=get_live_streams`, { timeout: 15000 });
            const liveData = await liveResp.json();
            console.log(`[IPTV] Found ${Array.isArray(liveData) ? liveData.length : 0} live streams`);
            
            // Get VOD
            console.log('[IPTV] Fetching VOD streams...');
            const vodResp = await fetch(`${base}&action=get_vod_streams`, { timeout: 15000 });
            const vodData = await vodResp.json();
            console.log(`[IPTV] Found ${Array.isArray(vodData) ? vodData.length : 0} VOD streams`);

            // Get Series (separate endpoint)
            console.log('[IPTV] Fetching series streams...');
            const seriesResp = await fetch(`${base}&action=get_series`, { timeout: 15000 });
            const seriesData = await seriesResp.json();
            console.log(`[IPTV] Found ${Array.isArray(seriesData) ? seriesData.length : 0} series streams`);

            // Get categories
            console.log('[IPTV] Fetching categories...');
            const liveCatResp = await fetch(`${base}&action=get_live_categories`, { timeout: 10000 });
            const liveCats = await liveCatResp.json();
            console.log('[IPTV] Live categories response:', liveCats);
            
            const vodCatResp = await fetch(`${base}&action=get_vod_categories`, { timeout: 10000 });
            const vodCats = await vodCatResp.json();
            console.log('[IPTV] VOD categories response:', vodCats);

            // Get Series categories
            const seriesCatResp = await fetch(`${base}&action=get_series_categories`, { timeout: 10000 });
            const seriesCats = await seriesCatResp.json();
            console.log('[IPTV] Series categories response:', seriesCats);

            // Build category maps - handle different response formats
            const liveCatMap = {};
            const vodCatMap = {};
            const seriesCatMap = {};
            
            // Handle array format
            if (Array.isArray(liveCats)) {
                liveCats.forEach(cat => {
                    if (cat.category_id && cat.category_name) {
                        liveCatMap[cat.category_id] = cat.category_name;
                    }
                });
            }
            // Handle object format
            else if (liveCats && typeof liveCats === 'object') {
                Object.keys(liveCats).forEach(key => {
                    const cat = liveCats[key];
                    if (cat.category_name || cat.name) {
                        liveCatMap[key] = cat.category_name || cat.name;
                    }
                });
            }
            
            if (Array.isArray(vodCats)) {
                vodCats.forEach(cat => {
                    if (cat.category_id && cat.category_name) {
                        vodCatMap[cat.category_id] = cat.category_name;
                    }
                });
            }
            else if (vodCats && typeof vodCats === 'object') {
                Object.keys(vodCats).forEach(key => {
                    const cat = vodCats[key];
                    if (cat.category_name || cat.name) {
                        vodCatMap[key] = cat.category_name || cat.name;
                    }
                });
            }

            // Handle series categories
            if (Array.isArray(seriesCats)) {
                seriesCats.forEach(cat => {
                    if (cat.category_id && cat.category_name) {
                        seriesCatMap[cat.category_id] = cat.category_name;
                    }
                });
            }
            else if (seriesCats && typeof seriesCats === 'object') {
                Object.keys(seriesCats).forEach(key => {
                    const cat = seriesCats[key];
                    if (cat.category_name || cat.name) {
                        seriesCatMap[key] = cat.category_name || cat.name;
                    }
                });
            }

            console.log('[IPTV] Live category map:', liveCatMap);
            console.log('[IPTV] VOD category map:', vodCatMap);
            console.log('[IPTV] Series category map:', seriesCatMap);

            // Process live channels
            if (Array.isArray(liveData)) {
                this.channels = liveData.map(item => {
                    const category = liveCatMap[item.category_id] || item.category || item.group_title || 'Live TV';
                    return {
                        id: `live_${item.stream_id}`,
                        name: item.name,
                        type: 'tv',
                        url: `${xtreamUrl}/live/${xtreamUsername}/${xtreamPassword}/${item.stream_id}.m3u8`,
                        logo: item.stream_icon,
                        category: category
                    };
                });
            }

            // Process VOD as movies only
            if (Array.isArray(vodData)) {
                this.movies = vodData.map(item => {
                    const category = vodCatMap[item.category_id] || item.category || item.group_title || 'Movies';
                    
                    return {
                        id: `vod_${item.stream_id}`,
                        name: item.name,
                        type: 'movie',
                        url: `${xtreamUrl}/movie/${xtreamUsername}/${xtreamPassword}/${item.stream_id}.${item.container_extension || 'mp4'}`,
                        poster: item.stream_icon,
                        category: category,
                        plot: item.plot || item.description,
                        year: item.releasedate ? new Date(item.releasedate).getFullYear() : null
                    };
                });
            }

            // Process Series from dedicated endpoint
            if (Array.isArray(seriesData)) {
                this.series = seriesData.map(item => {
                    const category = seriesCatMap[item.category_id] || item.category || item.group_title || 'Series';
                    
                    return {
                        id: `series_${item.series_id}`,
                        name: item.name,
                        type: 'series',
                        url: `${xtreamUrl}/series/${xtreamUsername}/${xtreamPassword}/${item.series_id}`,
                        poster: item.cover,
                        category: category,
                        plot: item.plot || item.description,
                        year: item.releaseDate ? new Date(item.releaseDate).getFullYear() : null,
                        rating: item.rating,
                        genre: item.genre
                    };
                });
                
                console.log(`[IPTV] Series processed: ${this.series.length} items`);
                if (this.series.length > 0) {
                    console.log('Sample series found:', this.series.slice(0, 5).map(s => `${s.name} (${s.category})`));
                }
            } else {
                console.log('[IPTV] No series data found or invalid format');
                this.series = [];
            }

            // Fallback: Extract categories from content if API categories failed
            if (Object.keys(liveCatMap).length === 0 && this.channels.length > 0) {
                console.log('[IPTV] No API categories found, extracting from content...');
                this.extractCategoriesFromContent();
            }

            // Helper to merge and clean category arrays
            const mergeCategories = (itemCats, mapCats) => {
                const merged = new Set();
                // Add categories detected from items (channels/movies/series)
                itemCats.forEach(c => {
                    if (typeof c === 'string') {
                        const cleaned = c.trim();
                        if (cleaned) merged.add(cleaned);
                    }
                });
                // Add categories coming from the provider's category maps
                Object.values(mapCats || {}).forEach(c => {
                    if (typeof c === 'string') {
                        const cleaned = c.trim();
                        if (cleaned) merged.add(cleaned);
                    }
                });
                // Return sorted array (case-insensitive)
                return Array.from(merged).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
            };

            // Build category lists – now merging map-derived categories too
            this.categories.live = mergeCategories(this.channels.map(c => c.category), liveCatMap);
            this.categories.movies = mergeCategories(this.movies.map(m => m.category), vodCatMap);
            this.categories.series = mergeCategories(this.series.map(s => s.category), seriesCatMap);

            console.log(`[IPTV] Loaded: ${this.channels.length} channels, ${this.movies.length} movies, ${this.series.length} series`);
            console.log(`[IPTV] Live categories (${this.categories.live.length}):`, this.categories.live.slice(0, 10));
            console.log(`[IPTV] Movie categories (${this.categories.movies.length}):`, this.categories.movies.slice(0, 10));
            console.log(`[IPTV] Series categories (${this.categories.series.length}):`, this.categories.series.slice(0, 10));

            // Cache the data to reduce future server load
            this.setCachedData(cacheKey, {
                channels: this.channels,
                movies: this.movies,
                series: this.series,
                categories: this.categories
            });
            console.log('[IPTV] Data cached for 30 minutes to reduce server load');

        } catch (error) {
            console.error('[IPTV] Failed to load data:', error.message);
            console.log('[IPTV] Trying alternative methods...');
            await this.tryAlternativeFormats();
        }
    }

    async tryAlternativeFormats() {
        const { xtreamUrl, xtreamUsername, xtreamPassword } = this.config;
        
        try {
            console.log('[IPTV] Trying M3U format...');
            // Try M3U format
            const m3uUrl = `${xtreamUrl}/get.php?username=${xtreamUsername}&password=${xtreamPassword}&type=m3u_plus&output=ts`;
            const m3uResp = await fetch(m3uUrl, { timeout: 15000 });
            if (m3uResp.ok) {
                const m3uContent = await m3uResp.text();
                this.parseM3UContent(m3uContent);
                return;
            }
        } catch (e) {
            console.log('[IPTV] M3U format failed:', e.message);
        }

        try {
            console.log('[IPTV] Trying direct API calls...');
            // Try different API endpoints
            const endpoints = [
                'get_live_streams',
                'get_vod_streams', 
                'get_series'
            ];
            
            for (const endpoint of endpoints) {
                const url = `${xtreamUrl}/player_api.php?username=${xtreamUsername}&password=${xtreamPassword}&action=${endpoint}`;
                const resp = await fetch(url, { timeout: 10000 });
                if (resp.ok) {
                    const data = await resp.json();
                    console.log(`[IPTV] ${endpoint} response:`, Array.isArray(data) ? data.length : 'object');
                }
            }
        } catch (e) {
            console.log('[IPTV] Direct API failed:', e.message);
        }
    }

    parseM3UContent(content) {
        const lines = content.split('\n');
        const channels = [];
        let currentItem = null;

        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith('#EXTINF:')) {
                const match = trimmed.match(/#EXTINF:.*?,(.*)/);
                if (match) {
                    const name = match[1];
                    const groupMatch = trimmed.match(/group-title="([^"]+)"/);
                    const logoMatch = trimmed.match(/tvg-logo="([^"]+)"/);
                    
                    currentItem = {
                        name: name,
                        category: groupMatch ? groupMatch[1] : 'Unknown',
                        logo: logoMatch ? logoMatch[1] : null
                    };
                }
            } else if (trimmed && !trimmed.startsWith('#') && currentItem) {
                currentItem.url = trimmed;
                currentItem.id = `m3u_${crypto.randomBytes(8).toString('hex')}`;
                currentItem.type = 'tv';
                channels.push(currentItem);
                currentItem = null;
            }
        }

        this.channels = channels;
        this.categories.live = [...new Set(channels.map(c => c.category))].filter(Boolean).sort();
        console.log(`[IPTV] Parsed M3U: ${channels.length} channels, ${this.categories.live.length} categories`);
    }

    extractCategoriesFromContent() {
        // Extract categories from channel names if no API categories
        const commonCategories = ['Sports', 'News', 'Movies', 'Entertainment', 'Kids', 'Music', 'Documentary'];
        
        this.channels.forEach(channel => {
            if (!channel.category || channel.category === 'Live TV') {
                const name = channel.name.toLowerCase();
                for (const cat of commonCategories) {
                    if (name.includes(cat.toLowerCase())) {
                        channel.category = cat;
                        break;
                    }
                }
            }
        });
    }

    isSeriesCategory(category, name) {
        const categoryLower = category.toLowerCase();
        const nameLower = name.toLowerCase();
        
        // Exclude anime movies - they should be movies, not series
        const movieKeywords = ['movie', 'film', 'افلام', 'cinema'];
        if (movieKeywords.some(keyword => categoryLower.includes(keyword))) {
            return false;
        }
        
        // Strong series indicators in category
        const strongSeriesKeywords = ['talk show', 'مسلسل', 'برنامج', 'series'];
        if (strongSeriesKeywords.some(keyword => categoryLower.includes(keyword))) {
            return true;
        }
        
        // Check for clear episode patterns in name (Arabic and English)
        const episodePatterns = [
            /الحلقة\s*\d+/i,           // Arabic: الحلقة + number
            /حلقة\s*\d+/i,             // Arabic: حلقة + number  
            /الجزء\s*\d+/i,            // Arabic: الجزء + number
            /جزء\s*\d+/i,              // Arabic: جزء + number
            /s\d+e\d+/i,               // English: S01E01
            /season\s*\d+.*episode\s*\d+/i, // English: Season X Episode Y
            /\d+x\d+/i,                // English: 1x01
            /ep\s*\d+/i,               // English: Ep 1
            /episode\s*\d+/i           // English: Episode 1
        ];
        
        const hasEpisodePattern = episodePatterns.some(pattern => pattern.test(nameLower));
        
        // Only classify as series if it has clear episode patterns
        // This prevents anime movies from being classified as series
        return hasEpisodePattern;
    }

    getCatalogItems(type, genre, search) {
        let items = [];
        
        switch (type) {
            case 'tv':
                items = this.channels;
                break;
            case 'movie':
                items = this.movies;
                break;
            case 'series':
                items = this.series;
                break;
        }

        // Filter by genre
        if (genre && !genre.startsWith('All')) {
            items = items.filter(item => item.category === genre);
        }

        // Filter by search
        if (search) {
            const searchLower = search.toLowerCase();
            items = items.filter(item => 
                item.name.toLowerCase().includes(searchLower) ||
                item.category.toLowerCase().includes(searchLower)
            );
        }

        // Sort by category then name
        items.sort((a, b) => {
            if (a.category !== b.category) {
                return a.category.localeCompare(b.category);
            }
            return a.name.localeCompare(b.name);
        });

        return items;
    }

    generateMeta(item) {
        const meta = {
            id: item.id,
            type: item.type,
            name: item.name,
            genres: [item.category]
        };

        if (item.type === 'tv') {
            meta.poster = item.logo || `https://via.placeholder.com/300x400/333/fff?text=${encodeURIComponent(item.name)}`;
            meta.description = `📺 Live Channel: ${item.name}`;
        } else {
            meta.poster = item.poster || `https://via.placeholder.com/300x450/666/fff?text=${encodeURIComponent(item.name)}`;
            meta.description = item.plot || `${item.type === 'series' ? 'TV Show' : 'Movie'}: ${item.name}`;
            if (item.year) meta.year = item.year;
        }

        // For series, we'll populate episodes in the meta handler
        if (item.type === 'series') {
            meta.videos = [];
        }

        return meta;
    }

    async getEpisodeStream(seriesId, season, episode) {
        try {
            const actualSeriesId = seriesId.replace('series_', '');
            const episodeUrl = `${this.config.xtreamUrl}/player_api.php?username=${this.config.xtreamUsername}&password=${this.config.xtreamPassword}&action=get_series_info&series_id=${actualSeriesId}`;
            
            const response = await fetch(episodeUrl, { timeout: 10000 });
            const seriesInfo = await response.json();
            
            if (seriesInfo && seriesInfo.episodes && seriesInfo.episodes[season]) {
                const episodeData = seriesInfo.episodes[season].find(ep => ep.episode_num == episode);
                if (episodeData) {
                    // Use the actual stream URL from the episode data
                    return `${this.config.xtreamUrl}/series/${this.config.xtreamUsername}/${this.config.xtreamPassword}/${episodeData.id}.${episodeData.container_extension || 'mp4'}`;
                }
            }
            
            // Fallback to constructed URL
            return `${this.config.xtreamUrl}/series/${this.config.xtreamUsername}/${this.config.xtreamPassword}/${actualSeriesId}/${season}/${episode}.mp4`;
        } catch (error) {
            console.error(`[STREAM] Error fetching episode stream:`, error.message);
            // Fallback URL
            const actualSeriesId = seriesId.replace('series_', '');
            return `${this.config.xtreamUrl}/series/${this.config.xtreamUsername}/${this.config.xtreamPassword}/${actualSeriesId}/${season}/${episode}.mp4`;
        }
    }

    getStream(id) {
        // Handle episode IDs (format: series_id:season:episode)
        if (id.includes(':')) {
            const [seriesId, season, episode] = id.split(':');
            const series = this.series.find(s => s.id === seriesId);
            
            if (!series) return null;
            
            // Return a promise-based stream for episodes
            return this.getEpisodeStream(seriesId, season, episode).then(url => ({
                url: url,
                title: `${series.name} - S${season}E${episode}`,
                behaviorHints: { notWebReady: true }
            }));
        }
        
        // Handle regular items (channels, movies, series info)
        const allItems = [...this.channels, ...this.movies, ...this.series];
        const item = allItems.find(i => i.id === id);
        
        if (!item) return null;
        
        return {
            url: item.url,
            title: item.name,
            behaviorHints: { notWebReady: true }
        };
    }
}

module.exports = async function createAddon(config = {}) {
    console.log('[CREATE_ADDON] Received config:', config ? Object.keys(config) : 'null');
    const addon = new IPTVAddon(config);
    await addon.init();

    const manifest = {
        id: ADDON_ID,
        version: "2.0.0",
        name: ADDON_NAME,
        description: "Self-hosted IPTV addon with caching to reduce server load",
        logo: "https://via.placeholder.com/256x256/4CAF50/ffffff?text=IPTV",
        resources: ["catalog", "stream", "meta"],
        types: ["tv", "movie", "series"],
        catalogs: [
            {
                type: 'tv',
                id: 'iptv_live',
                name: 'IPTV',
                extra: [
                    { name: 'genre', options: ['All Channels', ...addon.categories.live] },
                    { name: 'search' },
                    { name: 'skip' }
                ]
            },
            {
                type: 'movie',
                id: 'iptv_movies',
                name: 'Movies',
                extra: [
                    { name: 'genre', options: ['All Movies', ...addon.categories.movies] },
                    { name: 'search' },
                    { name: 'skip' }
                ]
            },
            {
                type: 'series',
                id: 'iptv_series',
                name: 'Series',
                extra: [
                    { name: 'genre', options: ['All Series', ...addon.categories.series] },
                    { name: 'search' },
                    { name: 'skip' }
                ]
            }
        ],
        idPrefixes: ["live_", "vod_", "series_"],
        behaviorHints: {
            configurable: true,
            configurationRequired: false
        }
    };

    const builder = new addonBuilder(manifest);

    builder.defineCatalogHandler(async (args) => {
        const { type, id, extra = {} } = args;
        console.log(`[CATALOG] Request: type=${type}, id=${id}, genre=${extra.genre}, search=${extra.search}`);
        
        const items = addon.getCatalogItems(type, extra.genre, extra.search);
        const skip = parseInt(extra.skip) || 0;
        const metas = items.slice(skip, skip + 100).map(item => addon.generateMeta(item));
        
        console.log(`[CATALOG] Returning ${metas.length} items for ${type}/${id}`);
        return { metas };
    });

    builder.defineStreamHandler(async (args) => {
        try {
            const stream = await addon.getStream(args.id);
            return stream ? { streams: [stream] } : { streams: [] };
        } catch (error) {
            console.error(`[STREAM] Error getting stream for ${args.id}:`, error.message);
            return { streams: [] };
        }
    });

    builder.defineMetaHandler(async (args) => {
        console.log(`[META] Request for ID: ${args.id}, type: ${args.type}`);
        
        const allItems = [...addon.channels, ...addon.movies, ...addon.series];
        const item = allItems.find(i => i.id === args.id);
        
        if (!item) {
            console.log(`[META] No item found for ID: ${args.id}`);
            return { meta: null };
        }
        
        console.log(`[META] Found item: ${item.name}, type: ${item.type}`);
        const meta = addon.generateMeta(item);
        
        // For series, fetch actual episodes from Xtream API
        if (item.type === 'series') {
            try {
                const seriesId = item.id.replace('series_', '');
                const episodeUrl = `${addon.config.xtreamUrl}/player_api.php?username=${addon.config.xtreamUsername}&password=${addon.config.xtreamPassword}&action=get_series_info&series_id=${seriesId}`;
                
                console.log(`[SERIES] Fetching episodes for series ${seriesId}`);
                const response = await fetch(episodeUrl, { timeout: 10000 });
                const seriesInfo = await response.json();
                
                console.log(`[SERIES] Series info response:`, JSON.stringify(seriesInfo, null, 2));
                
                if (seriesInfo && seriesInfo.episodes) {
                    const videos = [];
                    
                    // Process all seasons and episodes
                    Object.keys(seriesInfo.episodes).forEach(seasonNum => {
                        const season = seriesInfo.episodes[seasonNum];
                        if (Array.isArray(season)) {
                            season.forEach(episode => {
                                videos.push({
                                    id: `${item.id}:${seasonNum}:${episode.episode_num}`,
                                    title: episode.title || `Episode ${episode.episode_num}`,
                                    season: parseInt(seasonNum),
                                    episode: parseInt(episode.episode_num),
                                    overview: `Season ${seasonNum} Episode ${episode.episode_num}`,
                                    thumbnail: episode.info?.movie_image,
                                    released: episode.air_date,
                                    duration: episode.info?.duration_secs
                                });
                            });
                        }
                    });
                    
                    // Sort episodes properly
                    videos.sort((a, b) => {
                        if (a.season !== b.season) return a.season - b.season;
                        return a.episode - b.episode;
                    });
                    
                    meta.videos = videos;
                    
                    console.log(`[SERIES] Processed ${meta.videos.length} episodes for ${item.name}`);
                    console.log(`[SERIES] Sample episodes:`, meta.videos.slice(0, 3).map(v => `${v.title} (S${v.season}E${v.episode})`));
                } else {
                    console.log(`[SERIES] No episodes found for series ${seriesId}`);
                    // Add placeholder if no episodes found
                    meta.videos = [{
                        id: `${item.id}:1:1`,
                        title: "Episode 1",
                        season: 1,
                        episode: 1,
                        overview: "Episode information not available"
                    }];
                }
            } catch (error) {
                console.error(`[SERIES] Error fetching episodes for ${item.name}:`, error.message);
                // Add placeholder on error
                meta.videos = [{
                    id: `${item.id}:1:1`,
                    title: "Episode 1",
                    season: 1,
                    episode: 1,
                    overview: "Unable to load episode information"
                }];
            }
        }
        
        console.log(`[META] Returning meta for ${item.name}:`, JSON.stringify(meta, null, 2));
        return { meta };
    });

    return builder.getInterface();
};
