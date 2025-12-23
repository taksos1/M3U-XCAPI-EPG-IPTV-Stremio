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
        if (!this.config) return;

        if (this.config.xtreamUrl && this.config.xtreamUsername && this.config.xtreamPassword) {
            console.log('[ADDON] Loading Xtream data from:', this.config.xtreamUrl);
            await this.loadXtreamData();
        }
    }

    getCachedData(key) {
        const cached = cache.get(key);
        if (cached && Date.now() - cached.timestamp < CACHE_TTL) return cached.data;
        cache.delete(key);
        return null;
    }

    setCachedData(key, data) {
        cache.set(key, { data, timestamp: Date.now() });
        if (cache.size > 100) cache.delete(cache.keys().next().value);
    }

    async loadXtreamData() {
        const { xtreamUrl, xtreamUsername, xtreamPassword } = this.config;
        const cacheKey = `iptv_data_${crypto.createHash('md5').update(xtreamUrl + xtreamUsername).digest('hex')}`;

        const cachedData = this.getCachedData(cacheKey);
        if (cachedData) {
            this.channels = cachedData.channels || [];
            this.movies = cachedData.movies || [];
            this.series = cachedData.series || [];
            this.categories = cachedData.categories || { live: [], movies: [], series: [] };
            return;
        }

        const base = `${xtreamUrl}/player_api.php?username=${encodeURIComponent(xtreamUsername)}&password=${encodeURIComponent(xtreamPassword)}`;

        try {
            // Fetch live streams
            const liveResp = await fetch(`${base}&action=get_live_streams`, { timeout: 15000 });
            const liveData = await liveResp.json();

            // Fetch VOD streams
            const vodResp = await fetch(`${base}&action=get_vod_streams`, { timeout: 15000 });
            const vodData = await vodResp.json();

            // Fetch series
            const seriesResp = await fetch(`${base}&action=get_series`, { timeout: 15000 });
            const seriesData = await seriesResp.json();

            // Fetch categories
            const liveCatResp = await fetch(`${base}&action=get_live_categories`, { timeout: 10000 });
            const liveCats = await liveCatResp.json();

            const vodCatResp = await fetch(`${base}&action=get_vod_categories`, { timeout: 10000 });
            const vodCats = await vodCatResp.json();

            const seriesCatResp = await fetch(`${base}&action=get_series_categories`, { timeout: 10000 });
            const seriesCats = await seriesCatResp.json();

            const liveCatMap = {};
            const vodCatMap = {};
            const seriesCatMap = {};

            if (Array.isArray(liveCats)) liveCats.forEach(cat => cat.category_id && (liveCatMap[cat.category_id] = cat.category_name));
            else if (liveCats && typeof liveCats === 'object') Object.keys(liveCats).forEach(k => liveCatMap[k] = liveCats[k].category_name || liveCats[k].name);

            if (Array.isArray(vodCats)) vodCats.forEach(cat => cat.category_id && (vodCatMap[cat.category_id] = cat.category_name));
            else if (vodCats && typeof vodCats === 'object') Object.keys(vodCats).forEach(k => vodCatMap[k] = vodCats[k].category_name || vodCats[k].name);

            if (Array.isArray(seriesCats)) seriesCats.forEach(cat => cat.category_id && (seriesCatMap[cat.category_id] = cat.category_name));
            else if (seriesCats && typeof seriesCats === 'object') Object.keys(seriesCats).forEach(k => seriesCatMap[k] = seriesCats[k].category_name || seriesCats[k].name);

            // Live channels
            if (Array.isArray(liveData)) {
                this.channels = liveData.map(item => ({
                    id: `live_${item.stream_id}`,
                    name: item.name,
                    type: 'tv',
                    url: `${xtreamUrl}/live/${xtreamUsername}/${xtreamPassword}/${item.stream_id}.m3u8`,
                    logo: item.stream_icon,
                    category: liveCatMap[item.category_id] || item.category || item.group_title || 'Live TV'
                }));
            }

            // Movies (VOD)
            if (Array.isArray(vodData)) {
                this.movies = vodData.map(item => ({
                    id: `vod_${item.stream_id}`,
                    name: item.name,
                    type: 'movie',
                    url: `${xtreamUrl}/movie/${xtreamUsername}/${xtreamPassword}/${item.stream_id}.${item.container_extension || 'mp4'}`,
                    poster: item.stream_icon,
                    category: vodCatMap[item.category_id] || item.category || item.group_title || 'Movies',
                    plot: item.plot || item.description,
                    year: item.releasedate ? new Date(item.releasedate).getFullYear() : null
                }));
            }

            // Series
            if (Array.isArray(seriesData)) {
                this.series = seriesData.map(item => ({
                    id: `series_${item.series_id}`,
                    name: item.name,
                    type: 'series',
                    url: `${xtreamUrl}/series/${xtreamUsername}/${xtreamPassword}/${item.series_id}`,
                    poster: item.cover,
                    category: seriesCatMap[item.category_id] || item.category || item.group_title || 'Series',
                    plot: item.plot || item.description,
                    year: item.releaseDate ? new Date(item.releaseDate).getFullYear() : null,
                    rating: item.rating,
                    genre: item.genre
                }));
            }

            // Preserve original category order
            this.categories.live = [];
            this.channels.forEach(c => { if (c.category && !this.categories.live.includes(c.category)) this.categories.live.push(c.category); });

            this.categories.movies = [];
            this.movies.forEach(m => { if (m.category && !this.categories.movies.includes(m.category)) this.categories.movies.push(m.category); });

            this.categories.series = [];
            this.series.forEach(s => { if (s.category && !this.categories.series.includes(s.category)) this.categories.series.push(s.category); });

            // Cache
            this.setCachedData(cacheKey, {
                channels: this.channels,
                movies: this.movies,
                series: this.series,
                categories: this.categories
            });

        } catch (error) {
            console.error('[IPTV] Failed to load data:', error.message);
            await this.tryAlternativeFormats();
        }
    }

    async tryAlternativeFormats() {
        const { xtreamUrl, xtreamUsername, xtreamPassword } = this.config;
        try {
            const m3uUrl = `${xtreamUrl}/get.php?username=${xtreamUsername}&password=${xtreamPassword}&type=m3u_plus&output=ts`;
            const m3uResp = await fetch(m3uUrl, { timeout: 15000 });
            if (m3uResp.ok) {
                const m3uContent = await m3uResp.text();
                this.parseM3UContent(m3uContent);
                return;
            }
        } catch (e) { console.log('[IPTV] M3U format failed:', e.message); }
    }

    parseM3UContent(content) {
        const lines = content.split('\n');
        const channels = [];
        let currentItem = null;

        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith('#EXTINF:')) {
                const match = trimmed.match(/#EXTINF:.*?,(.*)/);
                const groupMatch = trimmed.match(/group-title="([^"]+)"/);
                const logoMatch = trimmed.match(/tvg-logo="([^"]+)"/);
                if (match) currentItem = { name: match[1], category: groupMatch ? groupMatch[1] : 'Unknown', logo: logoMatch ? logoMatch[1] : null };
            } else if (trimmed && !trimmed.startsWith('#') && currentItem) {
                currentItem.url = trimmed;
                currentItem.id = `m3u_${crypto.randomBytes(8).toString('hex')}`;
                currentItem.type = 'tv';
                channels.push(currentItem);
                currentItem = null;
            }
        }

        this.channels = channels;
        this.categories.live = [];
        channels.forEach(c => { if (c.category && !this.categories.live.includes(c.category)) this.categories.live.push(c.category); });
        console.log(`[IPTV] Parsed M3U: ${channels.length} channels, ${this.categories.live.length} categories`);
    }

    getCatalogItems(type, genre, search) {
        let items = [];
        switch (type) {
            case 'tv': items = this.channels; break;
            case 'movie': items = this.movies; break;
            case 'series': items = this.series; break;
        }

        if (genre && !genre.startsWith('All')) items = items.filter(item => item.category === genre);
        if (search) items = items.filter(item => item.name.toLowerCase().includes(search.toLowerCase()) || item.category.toLowerCase().includes(search.toLowerCase()));

        return items; // keep original order
    }

    generateMeta(item) {
        const meta = { id: item.id, type: item.type, name: item.name, genres: [item.category] };
        if (item.type === 'tv') meta.poster = item.logo || `https://via.placeholder.com/300x400/333/fff?text=${encodeURIComponent(item.name)}`, meta.description = `📺 Live Channel: ${item.name}`;
        else meta.poster = item.poster || `https://via.placeholder.com/300x450/666/fff?text=${encodeURIComponent(item.name)}`, meta.description = item.plot || `${item.type === 'series' ? 'TV Show' : 'Movie'}: ${item.name}`, item.year && (meta.year = item.year);
        if (item.type === 'series') meta.videos = [];
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
                if (episodeData) return `${this.config.xtreamUrl}/series/${this.config.xtreamUsername}/${this.config.xtreamPassword}/${episodeData.id}.${episodeData.container_extension || 'mp4'}`;
            }
            return `${this.config.xtreamUrl}/series/${this.config.xtreamUsername}/${this.config.xtreamPassword}/${actualSeriesId}/${season}/${episode}.mp4`;
        } catch (error) { console.error(error.message); return `${this.config.xtreamUrl}/series/${this.config.xtreamUsername}/${this.config.xtreamPassword}/${seriesId.replace('series_', '')}/${season}/${episode}.mp4`; }
    }

    getStream(id) {
        if (id.includes(':')) {
            const [seriesId, season, episode] = id.split(':');
            return this.getEpisodeStream(seriesId, season, episode).then(url => ({ url, title: `${seriesId} - S${season}E${episode}`, behaviorHints: { notWebReady: true } }));
        }
        const allItems = [...this.channels, ...this.movies, ...this.series];
        const item = allItems.find(i => i.id === id);
        return item ? { url: item.url, title: item.name, behaviorHints: { notWebReady: true } } : null;
    }
}

module.exports = async function createAddon(config = {}) {
    const addon = new IPTVAddon(config);
    await addon.init();

    const manifest = {
        id: ADDON_ID,
        version: "2.0.0",
        name: ADDON_NAME,
        description: "Self-hosted IPTV addon with caching and natural IPTV sorting",
        logo: "https://via.placeholder.com/256x256/4CAF50/ffffff?text=IPTV",
        resources: ["catalog", "stream", "meta"],
        types: ["tv", "movie", "series"],
        catalogs: [
            { type: 'tv', id: 'iptv_live', name: 'IPTV', extra: [{ name: 'genre', options: ['All Channels', ...addon.categories.live.slice(0, 20)] }, { name: 'search' }, { name: 'skip' }] },
            { type: 'movie', id: 'iptv_movies', name: 'Movies', extra: [{ name: 'genre', options: ['All Movies', ...addon.categories.movies.slice(0, 15)] }, { name: 'search' }, { name: 'skip' }] },
            { type: 'series', id: 'iptv_series', name: 'Series', extra: [{ name: 'genre', options: ['All Series', ...addon.categories.series.slice(0, 10)] }, { name: 'search' }, { name: 'skip' }] }
        ],
        idPrefixes: ["live_", "vod_", "series_"],
        behaviorHints: { configurable: true, configurationRequired: false }
    };

    const builder = new addonBuilder(manifest);

    builder.defineCatalogHandler(async (args) => {
        const { type, id, extra = {} } = args;
        const items = addon.getCatalogItems(type, extra.genre, extra.search);
        const skip = parseInt(extra.skip) || 0;
        return { metas: items.slice(skip, skip + 100).map(item => addon.generateMeta(item)) };
    });

    builder.defineStreamHandler(async (args) => {
        try { const stream = await addon.getStream(args.id); return stream ? { streams: [stream] } : { streams: [] }; } 
        catch { return { streams: [] }; }
    });

    builder.defineMetaHandler(async (args) => {
        const allItems = [...addon.channels, ...addon.movies, ...addon.series];
        const item = allItems.find(i => i.id === args.id);
        if (!item) return { meta: null };
        const meta = addon.generateMeta(item);

        if (item.type === 'series') {
            try {
                const seriesId = item.id.replace('series_', '');
                const episodeUrl = `${addon.config.xtreamUrl}/player_api.php?username=${addon.config.xtreamUsername}&password=${addon.config.xtreamPassword}&action=get_series_info&series_id=${seriesId}`;
                const response = await fetch(episodeUrl, { timeout: 10000 });
                const seriesInfo = await response.json();
                meta.videos = [];

                if (seriesInfo && seriesInfo.episodes) {
                    Object.keys(seriesInfo.episodes).forEach(seasonNum => {
                        const season = seriesInfo.episodes[seasonNum];
                        if (Array.isArray(season)) season.forEach(ep => meta.videos.push({ id: `${item.id}:${seasonNum}:${ep.episode_num}`, title: ep.title || `Episode ${ep.episode_num}`, season: parseInt(seasonNum), episode: parseInt(ep.episode_num), overview: `Season ${seasonNum} Episode ${ep.episode_num}`, thumbnail: ep.info?.movie_image, released: ep.air_date, duration: ep.info?.duration_secs }));
                    });
                    meta.videos.sort((a, b) => a.season - b.season || a.episode - b.episode);
                } else meta.videos.push({ id: `${item.id}:1:1`, title: "Episode 1", season: 1, episode: 1, overview: "Episode info not available" });
            } catch { meta.videos.push({ id: `${item.id}:1:1`, title: "Episode 1", season: 1, episode: 1, overview: "Unable to load episode information" }); }
        }

        return { meta };
    });

    return builder.getInterface();
};
