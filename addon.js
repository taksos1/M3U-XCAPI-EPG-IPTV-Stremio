const { addonBuilder } = require('stremio-addon-sdk');
const fetch = require('node-fetch');
const crypto = require('crypto');

const ADDON_ID = 'org.stremio.iptv.selfhosted';
const ADDON_NAME = 'IPTV Self-Hosted';

// TMDB API Configuration
const TMDB_API_KEY = '39c92ba4f28e6dbf665df5b7e9174d21';
const TMDB_BASE_URL = 'https://api.themoviedb.org/3';

// Simple in-memory cache to reduce IPTV server load
const cache = new Map();
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes

// Debug logging flag
const DEBUG = false;

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

            // Build category maps - preserve API order
            const liveCatMap = {};
            const vodCatMap = {};
            const seriesCatMap = {};
            const liveCatOrder = [];
            const vodCatOrder = [];
            const seriesCatOrder = [];
            
            // Handle array format
            if (Array.isArray(liveCats)) {
                liveCats.forEach(cat => {
                    if (cat.category_id && cat.category_name) {
                        liveCatMap[cat.category_id] = cat.category_name;
                        liveCatOrder.push(cat.category_name);
                    }
                });
            }
            // Handle object format
            else if (liveCats && typeof liveCats === 'object') {
                Object.keys(liveCats).forEach(key => {
                    const cat = liveCats[key];
                    if (cat.category_name || cat.name) {
                        liveCatMap[key] = cat.category_name || cat.name;
                        liveCatOrder.push(cat.category_name || cat.name);
                    }
                });
            }
            
            if (Array.isArray(vodCats)) {
                vodCats.forEach(cat => {
                    if (cat.category_id && cat.category_name) {
                        vodCatMap[cat.category_id] = cat.category_name;
                        vodCatOrder.push(cat.category_name);
                    }
                });
            }
            else if (vodCats && typeof vodCats === 'object') {
                Object.keys(vodCats).forEach(key => {
                    const cat = vodCats[key];
                    if (cat.category_name || cat.name) {
                        vodCatMap[key] = cat.category_name || cat.name;
                        vodCatOrder.push(cat.category_name || cat.name);
                    }
                });
            }

            // Handle series categories
            if (Array.isArray(seriesCats)) {
                seriesCats.forEach(cat => {
                    if (cat.category_id && cat.category_name) {
                        seriesCatMap[cat.category_id] = cat.category_name;
                        seriesCatOrder.push(cat.category_name);
                    }
                });
            }
            else if (seriesCats && typeof seriesCats === 'object') {
                Object.keys(seriesCats).forEach(key => {
                    const cat = seriesCats[key];
                    if (cat.category_name || cat.name) {
                        seriesCatMap[key] = cat.category_name || cat.name;
                        seriesCatOrder.push(cat.category_name || cat.name);
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
                        rating: item.rating || item.rating_5based,
                        imdbId: item.imdb_id || item.imdb || item.tmdb_id || item.tmdb
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
                        rating: item.rating,
                        imdbId: item.imdb_id || item.imdb || item.tmdb_id || item.tmdb
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

            // Build category lists - use API order to match IPTV server
            this.categories.live = liveCatOrder;
            this.categories.movies = vodCatOrder;
            this.categories.series = seriesCatOrder;

            console.log(`[IPTV] Loaded: ${this.channels.length} channels, ${this.movies.length} movies, ${this.series.length} series`);
            console.log(`[IPTV] Live categories (${this.categories.live.length}):`, this.categories.live.slice(0, 10));
            console.log(`[IPTV] Movie categories (${this.categories.movies.length}):`, this.categories.movies.slice(0, 10));
            console.log(`[IPTV] Series categories (${this.categories.series.length}):`, this.categories.series.slice(0, 10));
            
            // Log sample items to check order
            if (this.movies.length > 0) {
                console.log('[IPTV] Sample movies (first 5):', this.movies.slice(0, 5).map(m => `${m.name} (${m.category})`));
            }
            if (this.series.length > 0) {
                console.log('[IPTV] Sample series (first 5):', this.series.slice(0, 5).map(s => `${s.name} (${s.category})`));
            }

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
            if (DEBUG) console.log(`[SEARCH] Searching for "${search}" in ${items.length} items`);
            
            // Check if search is an IMDb ID
            const isImdbId = search.startsWith('tt') && search.length > 2;
            
            if (isImdbId) {
                // Search by IMDb ID
                const imdbResult = items.find(item => item.imdbId === search);
                if (imdbResult) {
                    if (DEBUG) console.log(`[SEARCH] Found item by IMDb ID: ${imdbResult.name}`);
                    return [imdbResult];
                }
                return [];
            }
            
            // Fuzzy search with better matching
            const searchLower = search.toLowerCase();
            const searchResults = [];
            
            for (const item of items) {
                const itemName = (item.name || '').toLowerCase();
                const categoryName = (item.category || '').toLowerCase();
                
                // Exact match (highest priority)
                if (itemName === searchLower) {
                    searchResults.unshift({ item, score: 100 });
                }
                // Starts with search term (high priority)
                else if (itemName.startsWith(searchLower)) {
                    searchResults.push({ item, score: 80 });
                }
                // Contains search term (medium priority)
                else if (itemName.includes(searchLower) || categoryName.includes(searchLower)) {
                    searchResults.push({ item, score: 60 });
                }
                // Fuzzy match - check if words match
                else {
                    const searchWords = searchLower.split(/\s+/);
                    const itemWords = itemName.split(/\s+/);
                    let matchCount = 0;
                    
                    for (const searchWord of searchWords) {
                        if (itemWords.some(itemWord => itemWord.includes(searchWord) || searchWord.includes(itemWord))) {
                            matchCount++;
                        }
                    }
                    
                    // If at least 50% of words match
                    if (matchCount >= Math.ceil(searchWords.length * 0.5)) {
                        searchResults.push({ item, score: 40 });
                    }
                }
            }
            
            // Sort by score and limit to 100 results
            searchResults.sort((a, b) => b.score - a.score);
            const finalResults = searchResults.slice(0, 100).map(result => result.item);
            
            if (DEBUG) console.log(`[SEARCH] Found ${finalResults.length} results for "${search}"`);
            items = finalResults;
        }

        // Preserve original order from IPTV server
        return items;
    }

    async searchTMDB(name, type) {
        try {
            // Clean the name - remove year, extra spaces, special characters
            let cleanName = name
                .replace(/\(\d{4}\)/g, '')
                .replace(/\s*\(\s*\)/g, '')
                .replace(/\s+/g, ' ')
                .trim();
            
            // Try multiple search strategies
            const searchStrategies = [
                cleanName,  // Original name
                cleanName.split(' ')[0],  // First word only
                cleanName.replace(/\s*\(\s*\d+\s*\)\s*/g, '')  // Remove any remaining parentheses with numbers
            ];
            
            const searchType = type === 'series' ? 'tv' : 'movie';
            
            for (const searchName of searchStrategies) {
                if (!searchName || searchName.length < 2) continue;
                
                const url = `${TMDB_BASE_URL}/search/${searchType}?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(searchName)}&language=en-US`;
                
                try {
                    const response = await fetch(url, { timeout: 5000 });
                    const data = await response.json();
                    
                    if (DEBUG) console.log(`[TMDB] Search "${searchName}": Status ${response.status}, ${data.results?.length || 0} results`);
                    
                    if (data.results && data.results.length > 0) {
                        // Check multiple results for IMDb ID
                        for (let i = 0; i < Math.min(data.results.length, 5); i++) {
                            const result = data.results[i];
                            
                            if (DEBUG) console.log(`[TMDB] Result #${i + 1}: "${result.title || result.name}" (ID: ${result.id}, has imdb_id: ${!!result.imdb_id})`);
                            
                            // For TV shows, use external_ids endpoint
                            if (searchType === 'tv' && result.id) {
                                const externalIdsUrl = `${TMDB_BASE_URL}/tv/${result.id}/external_ids?api_key=${TMDB_API_KEY}`;
                                const externalIdsResponse = await fetch(externalIdsUrl, { timeout: 5000 });
                                const externalIdsData = await externalIdsResponse.json();
                                
                                if (DEBUG) console.log(`[TMDB] External IDs for "${result.name}": imdb_id: ${externalIdsData.imdb_id}`);
                                
                                if (externalIdsData.imdb_id) {
                                    return externalIdsData.imdb_id;
                                }
                            }
                            // For movies, try full details endpoint
                            else if (!result.imdb_id && result.id) {
                                const detailUrl = `${TMDB_BASE_URL}/movie/${result.id}?api_key=${TMDB_API_KEY}&language=en-US`;
                                const detailResponse = await fetch(detailUrl, { timeout: 5000 });
                                const detailData = await detailResponse.json();
                                
                                if (DEBUG) console.log(`[TMDB] Full details for "${result.title}": has imdb_id: ${!!detailData.imdb_id}`);
                                
                                if (detailData.imdb_id) {
                                    return detailData.imdb_id;
                                }
                            } else if (result.imdb_id) {
                                return result.imdb_id;
                            }
                        }
                    }
                } catch (fetchError) {
                    if (DEBUG) console.error(`[TMDB] Fetch error for "${searchName}":`, fetchError.message);
                }
            }
            
            return null;
        } catch (error) {
            if (DEBUG) console.error(`[TMDB] Error:`, error.message);
            return null;
        }
    }

    async fetchEpisodeImages(imdbId, season, episode) {
        try {
            // Check cache first
            const cacheKey = `episode_image_${imdbId}_S${season}E${episode}`;
            const cachedImage = this.getCachedData(cacheKey);
            if (cachedImage) {
                return cachedImage;
            }
            
            // Get TMDB ID from IMDb ID
            const findUrl = `${TMDB_BASE_URL}/find/${imdbId}?api_key=${TMDB_API_KEY}&external_source=imdb_id`;
            const findResponse = await fetch(findUrl, { timeout: 5000 });
            const findData = await findResponse.json();
            
            if (!findData.tv_results || findData.tv_results.length === 0) {
                return null;
            }
            
            const tmdbId = findData.tv_results[0].id;
            
            // Get episode images
            const imagesUrl = `${TMDB_BASE_URL}/tv/${tmdbId}/season/${season}/episode/${episode}/images?api_key=${TMDB_API_KEY}`;
            const imagesResponse = await fetch(imagesUrl, { timeout: 5000 });
            const imagesData = await imagesResponse.json();
            
            if (imagesData.stills && imagesData.stills.length > 0) {
                // Return the highest quality still image
                const still = imagesData.stills[0];
                const imageUrl = `https://image.tmdb.org/t/p/original${still.file_path}`;
                
                // Cache for 7 days
                this.setCachedData(cacheKey, imageUrl);
                
                return imageUrl;
            }
            
            return null;
        } catch (error) {
            if (DEBUG) console.error(`[TMDB] Error fetching episode images:`, error.message);
            return null;
        }
    }

    async fetchSeriesDetails(imdbId) {
        try {
            const cacheKey = `series_details_${imdbId}`;
            const cachedDetails = this.getCachedData(cacheKey);
            if (cachedDetails) {
                return cachedDetails;
            }
            
            // Get TMDB ID from IMDb ID
            const findUrl = `${TMDB_BASE_URL}/find/${imdbId}?api_key=${TMDB_API_KEY}&external_source=imdb_id`;
            const findResponse = await fetch(findUrl, { timeout: 5000 });
            const findData = await findResponse.json();
            
            if (!findData.tv_results || findData.tv_results.length === 0) {
                return null;
            }
            
            const tmdbId = findData.tv_results[0].id;
            
            // Get series details
            const detailsUrl = `${TMDB_BASE_URL}/tv/${tmdbId}?api_key=${TMDB_API_KEY}&language=en-US`;
            const detailsResponse = await fetch(detailsUrl, { timeout: 5000 });
            const detailsData = await detailsResponse.json();
            
            const seriesDetails = {
                overview: detailsData.overview,
                first_air_date: detailsData.first_air_date,
                rating: detailsData.vote_average,
                genres: detailsData.genres?.map(g => g.name) || [],
                runtime: detailsData.episode_run_time?.[0],
                networks: detailsData.networks?.map(n => n.name) || [],
                status: detailsData.status
            };
            
            // Cache for 24 hours
            this.setCachedData(cacheKey, seriesDetails);
            
            return seriesDetails;
        } catch (error) {
            if (DEBUG) console.error(`[TMDB] Error fetching series details:`, error.message);
            return null;
        }
    }

    async fetchMovieDetails(imdbId) {
        try {
            const cacheKey = `movie_details_${imdbId}`;
            const cachedDetails = this.getCachedData(cacheKey);
            if (cachedDetails) {
                return cachedDetails;
            }
            
            // Get TMDB ID from IMDb ID
            const findUrl = `${TMDB_BASE_URL}/find/${imdbId}?api_key=${TMDB_API_KEY}&external_source=imdb_id`;
            const findResponse = await fetch(findUrl, { timeout: 5000 });
            const findData = await findResponse.json();
            
            if (!findData.movie_results || findData.movie_results.length === 0) {
                return null;
            }
            
            const tmdbId = findData.movie_results[0].id;
            
            // Get movie details
            const detailsUrl = `${TMDB_BASE_URL}/movie/${tmdbId}?api_key=${TMDB_API_KEY}&language=en-US`;
            const detailsResponse = await fetch(detailsUrl, { timeout: 5000 });
            const detailsData = await detailsResponse.json();
            
            const movieDetails = {
                overview: detailsData.overview,
                release_date: detailsData.release_date,
                rating: detailsData.vote_average,
                genres: detailsData.genres?.map(g => g.name) || [],
                runtime: detailsData.runtime,
                production_companies: detailsData.production_companies?.map(c => c.name) || [],
                budget: detailsData.budget,
                revenue: detailsData.revenue
            };
            
            // Cache for 24 hours
            this.setCachedData(cacheKey, movieDetails);
            
            return movieDetails;
        } catch (error) {
            if (DEBUG) console.error(`[TMDB] Error fetching movie details:`, error.message);
            return null;
        }
    }

    // Test method to verify TMDB is working
    async testTMDB() {
        console.log('[TMDB] Testing TMDB integration with "The Matrix"...');
        const testId = await this.searchTMDB('The Matrix', 'movie');
        if (testId) {
            console.log(`[TMDB] Test PASSED - Found IMDb ID: ${testId}`);
        } else {
            console.log('[TMDB] Test FAILED - Could not find IMDb ID for "The Matrix"');
        }
        return testId;
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
            meta.description = `📺 ${item.name}`;
        } else {
            // Enhanced metadata for movies and series
            meta.poster = item.poster || `https://via.placeholder.com/300x450/666/fff?text=${encodeURIComponent(item.name)}`;
            
            // Extract year from name if present
            const yearMatch = item.name.match(/\((\d{4})\)/);
            const year = yearMatch ? yearMatch[1] : '';
            
            // Build detailed description
            let descriptionParts = [];
            
            // Type indicator
            descriptionParts.push(item.type === 'series' ? '📺 TV Series' : '🎬 Movie');
            
            // Year if available
            if (year) {
                descriptionParts.push(year);
            }
            
            // Rating if available (from IPTV server)
            if (item.rating) {
                const rating = parseFloat(item.rating);
                if (!isNaN(rating) && rating > 0) {
                    descriptionParts.push(`⭐ ${rating}/10`);
                }
            }
            
            // Category
            if (item.category) {
                descriptionParts.push(`📁 ${item.category}`);
            }
            
            meta.description = descriptionParts.join(' | ');
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
            
            if (!series) {
                console.error(`[STREAM] Series not found for ID: ${seriesId}`);
                return null;
            }
            
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
        
        if (!item) {
            console.error(`[STREAM] Item not found for ID: ${id}`);
            return null;
        }
        
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

    // Sort categories alphabetically for consistent display
    const sortedLiveCategories = [...addon.categories.live].sort((a, b) => a.localeCompare(b));
    const sortedMovieCategories = [...addon.categories.movies].sort((a, b) => a.localeCompare(b));
    const sortedSeriesCategories = [...addon.categories.series].sort((a, b) => a.localeCompare(b));

    const manifest = {
        id: ADDON_ID,
        version: "2.0.0",
        name: ADDON_NAME,
        resources: ["catalog", "stream", "meta"],
        types: ["tv", "movie", "series"],
        catalogs: [
            {
                type: 'tv',
                id: 'iptv_live',
                name: 'IPTV',
                extra: [
                    { name: 'genre', options: ['All', ...sortedLiveCategories] },
                    { name: 'search' },
                    { name: 'skip' }
                ]
            },
            {
                type: 'movie',
                id: 'iptv_movies',
                name: 'IPTV Movies',
                extra: [
                    { name: 'genre', options: ['All', ...sortedMovieCategories] },
                    { name: 'search' },
                    { name: 'skip' }
                ]
            },
            {
                type: 'series',
                id: 'iptv_series',
                name: 'IPTV Series',
                extra: [
                    { name: 'genre', options: ['All', ...sortedSeriesCategories] },
                    { name: 'search' },
                    { name: 'skip' }
                ]
            }
        ],
        idPrefixes: ["live_", "vod_", "series_"]
    };

    // Log manifest size and category counts
    console.log('[MANIFEST] Category counts:', {
        live: addon.categories.live.length,
        movies: addon.categories.movies.length,
        series: addon.categories.series.length
    });
    const manifestSize = JSON.stringify(manifest).length;
    console.log('[MANIFEST] Size:', manifestSize, 'bytes (limit: 8192 bytes)');
    if (manifestSize > 8192) {
        console.warn('[MANIFEST] WARNING: Manifest exceeds 8KB limit!');
    }

    const builder = new addonBuilder(manifest);

    builder.defineCatalogHandler(async (args) => {
        const { type, id, extra = {} } = args;
        if (DEBUG) console.log(`[CATALOG] Request: type=${type}, id=${id}`);
        
        const items = addon.getCatalogItems(type, extra.genre, extra.search);
        const skip = parseInt(extra.skip) || 0;
        const metas = items.slice(skip, skip + 100).map(item => addon.generateMeta(item));
        
        if (DEBUG) console.log(`[CATALOG] Returning ${metas.length} items for ${type}/${id}`);
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
        if (DEBUG) console.log(`[META] Request for ID: ${args.id}, type: ${args.type}`);
        
        const allItems = [...addon.channels, ...addon.movies, ...addon.series];
        const item = allItems.find(i => i.id === args.id);
        
        if (!item) {
            if (DEBUG) console.log(`[META] No item found for ID: ${args.id}`);
            return { meta: null };
        }
        
        const meta = addon.generateMeta(item);
        
        // Search TMDB for IMDb ID (for movies and series only)
        if (item.type === 'movie' || item.type === 'series') {
            try {
                // Check cache first
                const tmdbCacheKey = `tmdb_${item.name}_${item.type}`;
                const cachedImdbId = addon.getCachedData(tmdbCacheKey);
                
                if (cachedImdbId) {
                    console.log(`[TMDB] ✓ Cached: ${cachedImdbId} for "${item.name}"`);
                    meta.imdb_id = cachedImdbId;
                } else {
                    // Search TMDB for IMDb ID
                    const imdbId = await addon.searchTMDB(item.name, item.type);
                    if (imdbId) {
                        meta.imdb_id = imdbId;
                        // Cache the result for 24 hours
                        addon.setCachedData(tmdbCacheKey, imdbId);
                        console.log(`[TMDB] ✓ Found: ${imdbId} for "${item.name}"`);
                    } else {
                        console.log(`[TMDB] ✗ No IMDb ID for "${item.name}"`);
                    }
                }
                
                // For movies, fetch additional details from TMDB
                if (item.type === 'movie' && meta.imdb_id) {
                    try {
                        const movieDetails = await addon.fetchMovieDetails(meta.imdb_id);
                        if (movieDetails) {
                            // Enhance metadata with movie details
                            if (movieDetails.overview) {
                                const overview = movieDetails.overview.substring(0, 200);
                                meta.description = `🎬 ${item.name} | ${overview}...`;
                            }
                            if (movieDetails.rating) {
                                meta.description += ` | ⭐ ${movieDetails.rating.toFixed(1)}/10`;
                            }
                            if (movieDetails.genres && movieDetails.genres.length > 0) {
                                meta.genres = movieDetails.genres.slice(0, 3);
                            }
                            if (movieDetails.runtime) {
                                meta.description += ` | ⏱️ ${movieDetails.runtime}min`;
                            }
                            if (movieDetails.release_date) {
                                const year = movieDetails.release_date.substring(0, 4);
                                meta.description = meta.description.replace(year, '').trim();
                                meta.description += ` | ${year}`;
                            }
                        }
                    } catch (error) {
                        if (DEBUG) console.error(`[TMDB] Error fetching movie details:`, error.message);
                    }
                }
                
                // For series, fetch additional details from TMDB
                if (item.type === 'series' && meta.imdb_id) {
                    try {
                        const seriesDetails = await addon.fetchSeriesDetails(meta.imdb_id);
                        if (seriesDetails) {
                            // Enhance metadata with series details
                            if (seriesDetails.overview && !meta.description.includes('📺')) {
                                const overview = seriesDetails.overview.substring(0, 200);
                                meta.description = `📺 ${item.name} | ${overview}...`;
                            }
                            if (seriesDetails.rating) {
                                meta.description += ` | ⭐ ${seriesDetails.rating.toFixed(1)}/10`;
                            }
                            if (seriesDetails.genres && seriesDetails.genres.length > 0) {
                                meta.genres = seriesDetails.genres.slice(0, 3);
                            }
                            if (seriesDetails.runtime) {
                                meta.description += ` | ⏱️ ${seriesDetails.runtime}min`;
                            }
                            if (seriesDetails.status) {
                                meta.description += ` | ${seriesDetails.status}`;
                            }
                        }
                    } catch (error) {
                        if (DEBUG) console.error(`[TMDB] Error fetching series details:`, error.message);
                    }
                }
            } catch (error) {
                console.error(`[TMDB] Error:`, error.message);
            }
        }
        
        // For series, fetch actual episodes from Xtream API
        if (item.type === 'series') {
            try {
                const seriesId = item.id.replace('series_', '');
                const episodeUrl = `${addon.config.xtreamUrl}/player_api.php?username=${addon.config.xtreamUsername}&password=${addon.config.xtreamPassword}&action=get_series_info&series_id=${seriesId}`;
                
                const response = await fetch(episodeUrl, { timeout: 10000 });
                const seriesInfo = await response.json();
                
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
                                    overview: episode.plot || episode.info?.movie_image ? `Season ${seasonNum} Episode ${episode.episode_num}` : `Season ${seasonNum} Episode ${episode.episode_num}`,
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
                    
                    // Fetch episode images from TMDB if we have IMDb ID
                    if (meta.imdb_id) {
                        for (const video of videos) {
                            try {
                                const episodeImage = await addon.fetchEpisodeImages(meta.imdb_id, video.season, video.episode);
                                if (episodeImage) {
                                    video.thumbnail = episodeImage;
                                    if (DEBUG) console.log(`[TMDB] ✓ Episode image for S${video.season}E${video.episode}`);
                                }
                            } catch (error) {
                                if (DEBUG) console.error(`[TMDB] Error fetching episode image for S${video.season}E${video.episode}:`, error.message);
                            }
                        }
                    }
                    
                    meta.videos = videos;
                    
                    if (DEBUG) console.log(`[SERIES] Processed ${meta.videos.length} episodes for ${item.name}`);
                } else {
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
                if (DEBUG) console.error(`[SERIES] Error:`, error.message);
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
        
        if (DEBUG) console.log(`[META] Returning meta for ${item.name}`);
        return { meta };
    });

    return builder.getInterface();
};
