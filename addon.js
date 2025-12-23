const { addonBuilder } = require('stremio-addon-sdk');
const fetch = require('node-fetch');
const crypto = require('crypto');
const ADDON_ID = 'org.stremio.iptv.selfhosted';
const ADDON_NAME = 'IPTV Self-Hosted';
// Simple in-memory cache to reduce IPTV server load
const cache = new Map();
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes
// Category normalization and grouping
const CATEGORY_MAPPINGS = {
// Sports variations
'sport': 'Sports',
'sports': 'Sports',
'رياضة': 'Sports',
'deportes': 'Sports',
'football': 'Sports',
'soccer': 'Sports',
'basketball': 'Sports',
'tennis': 'Sports',
// News variations
'news': 'News',
'أخبار': 'News',
'noticias': 'News',
'breaking news': 'News',
// Movies variations
'movie': 'Movies',
'movies': 'Movies',
'film': 'Movies',
'films': 'Movies',
'cinema': 'Movies',
'افلام': 'Movies',
'películas': 'Movies',
// Series/Shows variations
'series': 'Series',
'tv show': 'Series',
'tv shows': 'Series',
'مسلسل': 'Series',
'مسلسلات': 'Series',
'series tv': 'Series',
// Entertainment variations
'entertainment': 'Entertainment',
'ترفيه': 'Entertainment',
'entretenimiento': 'Entertainment',
'variety': 'Entertainment',
// Kids variations
'kids': 'Kids',
'children': 'Kids',
'أطفال': 'Kids',
'infantil': 'Kids',
'cartoon': 'Kids',
'cartoons': 'Kids',
'animation': 'Kids',
// Music variations
'music': 'Music',
'موسيقى': 'Music',
'música': 'Music',
'concert': 'Music',
// Documentary variations
'documentary': 'Documentary',
'documentaries': 'Documentary',
'وثائقي': 'Documentary',
'documental': 'Documentary',
'nature': 'Documentary',
'history': 'Documentary',
// Religious variations
'religious': 'Religious',
'religion': 'Religious',
'ديني': 'Religious',
'religioso': 'Religious',
'islamic': 'Religious',
'christian': 'Religious',
};
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
this.rawCategories = {
live: new Map(),
movies: new Map(),
series: new Map()
};
}
normalizeCategory(category) {
if (!category) return 'Other';
const lower = category.toLowerCase().trim();
// Check exact matches first
if (CATEGORY_MAPPINGS[lower]) {
return CATEGORY_MAPPINGS[lower];
}
// Check partial matches
for (const [key, value] of Object.entries(CATEGORY_MAPPINGS)) {
if (lower.includes(key) || key.includes(lower)) {
return value;
}
}
// Return cleaned original if no match
return category.trim().split(' ')
.map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
.join(' ');
}
groupCategories(categories, type) {
const grouped = new Map();
categories.forEach(cat => {
const normalized = this.normalizeCategory(cat);
if (!grouped.has(normalized)) {
grouped.set(normalized, []);
}
grouped.get(normalized).push(cat);
});
// Store for reference
this.rawCategories[type] = grouped;
// Return sorted normalized categories
return Array.from(grouped.keys()).sort();
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
if (cache.size > 100) {
const oldestKey = cache.keys().next().value;
cache.delete(oldestKey);
}
}
async loadXtreamData() {
const { xtreamUrl, xtreamUsername, xtreamPassword } = this.config;
const cacheKey = iptv_data_${crypto.createHash('md5').update(xtreamUrl + xtreamUsername).digest('hex')};
const cachedData = this.getCachedData(cacheKey);
if (cachedData) {
console.log('[IPTV] Using cached data to reduce server load');
this.channels = cachedData.channels || [];
this.movies = cachedData.movies || [];
this.series = cachedData.series || [];
this.categories = cachedData.categories || { live: [], movies: [], series: [] };
this.rawCategories = cachedData.rawCategories || { live: new Map(), movies: new Map(), series: new Map() };
return;
}
const base = ${xtreamUrl}/player_api.php?username=${encodeURIComponent(xtreamUsername)}&password=${encodeURIComponent(xtreamPassword)};
try {
console.log('[IPTV] Loading fresh data from server...');
const testResp = await fetch(${base}&action=get_live_categories, { timeout: 5000 });
if (!testResp.ok) {
console.log('[IPTV] Server connection failed, trying alternative formats...');
return await this.tryAlternativeFormats();
}
// Get all data
console.log('[IPTV] Fetching all streams and categories...');
const [liveResp, vodResp, seriesResp, liveCatResp, vodCatResp, seriesCatResp] = await Promise.all([
fetch(${base}&action=get_live_streams, { timeout: 15000 }),
fetch(${base}&action=get_vod_streams, { timeout: 15000 }),
fetch(${base}&action=get_series, { timeout: 15000 }),
fetch(${base}&action=get_live_categories, { timeout: 10000 }),
fetch(${base}&action=get_vod_categories, { timeout: 10000 }),
fetch(${base}&action=get_series_categories, { timeout: 10000 })
]);
const [liveData, vodData, seriesData, liveCats, vodCats, seriesCats] = await Promise.all([
liveResp.json(),
vodResp.json(),
seriesResp.json(),
liveCatResp.json(),
vodCatResp.json(),
seriesCatResp.json()
]);
console.log([IPTV] Found ${Array.isArray(liveData) ? liveData.length : 0} live streams);
console.log([IPTV] Found ${Array.isArray(vodData) ? vodData.length : 0} VOD streams);
console.log([IPTV] Found ${Array.isArray(seriesData) ? seriesData.length : 0} series streams);
// Build category maps with better handling
const liveCatMap = this.buildCategoryMap(liveCats);
const vodCatMap = this.buildCategoryMap(vodCats);
const seriesCatMap = this.buildCategoryMap(seriesCats);
console.log([IPTV] Processed ${Object.keys(liveCatMap).length} live categories);
console.log([IPTV] Processed ${Object.keys(vodCatMap).length} VOD categories);
console.log([IPTV] Processed ${Object.keys(seriesCatMap).length} series categories);
// Process content with normalized categories
this.channels = this.processLiveChannels(liveData, liveCatMap, xtreamUrl, xtreamUsername, xtreamPassword);
this.movies = this.processMovies(vodData, vodCatMap, xtreamUrl, xtreamUsername, xtreamPassword);
this.series = this.processSeries(seriesData, seriesCatMap, xtreamUrl, xtreamUsername, xtreamPassword);
// Extract and normalize categories
const rawLiveCategories = [...new Set(this.channels.map(c => c.rawCategory).filter(Boolean))];
const rawMovieCategories = [...new Set(this.movies.map(m => m.rawCategory).filter(Boolean))];
const rawSeriesCategories = [...new Set(this.series.map(s => s.rawCategory).filter(Boolean))];
this.categories.live = this.groupCategories(rawLiveCategories, 'live');
this.categories.movies = this.groupCategories(rawMovieCategories, 'movies');
this.categories.series = this.groupCategories(rawSeriesCategories, 'series');
console.log([IPTV] Loaded: ${this.channels.length} channels, ${this.movies.length} movies, ${this.series.length} series);
console.log([IPTV] Live categories (${this.categories.live.length}):, this.categories.live);
console.log([IPTV] Movie categories (${this.categories.movies.length}):, this.categories.movies);
console.log([IPTV] Series categories (${this.categories.series.length}):, this.categories.series);
this.setCachedData(cacheKey, {
channels: this.channels,
movies: this.movies,
series: this.series,
categories: this.categories,
rawCategories: this.rawCategories
});
console.log('[IPTV] Data cached for 30 minutes to reduce server load');
} catch (error) {
console.error('[IPTV] Failed to load data:', error.message);
console.log('[IPTV] Trying alternative methods...');
await this.tryAlternativeFormats();
}
}
buildCategoryMap(cats) {
const catMap = {};
if (Array.isArray(cats)) {
cats.forEach(cat => {
if (cat.category_id && cat.category_name) {
catMap[cat.category_id] = cat.category_name;
}
});
} else if (cats && typeof cats === 'object') {
Object.keys(cats).forEach(key => {
const cat = cats[key];
if (cat.category_name || cat.name) {
catMap[key] = cat.category_name || cat.name;
}
});
}
return catMap;
}
processLiveChannels(liveData, catMap, url, user, pass) {
if (!Array.isArray(liveData)) return [];
return liveData.map(item => {
const rawCategory = catMap[item.category_id] || item.category || item.group_title || 'Live TV';
const normalizedCategory = this.normalizeCategory(rawCategory);
return {
id: live_${item.stream_id},
name: item.name,
type: 'channel',
url: ${url}/live/${user}/${pass}/${item.stream_id}.ts,
logo: item.stream_icon,
rawCategory: rawCategory,
category: normalizedCategory
};
});
}
processMovies(vodData, catMap, url, user, pass) {
if (!Array.isArray(vodData)) return [];
return vodData.map(item => {
const rawCategory = catMap[item.category_id] || item.category || item.group_title || 'Movies';
const normalizedCategory = this.normalizeCategory(rawCategory);
return {
id: vod_${item.stream_id},
name: item.name,
type: 'movie',
url: ${url}/movie/${user}/${pass}/${item.stream_id}.${item.container_extension || 'mp4'},
poster: item.stream_icon,
rawCategory: rawCategory,
category: normalizedCategory,
plot: item.plot || item.description,
year: item.releasedate ? new Date(item.releasedate).getFullYear() : null
};
});
}
processSeries(seriesData, catMap, url, user, pass) {
if (!Array.isArray(seriesData)) return [];
return seriesData.map(item => {
const rawCategory = catMap[item.category_id] || item.category || item.group_title || 'Series';
const normalizedCategory = this.normalizeCategory(rawCategory);
return {
id: series_${item.series_id},
name: item.name,
type: 'series',
url: ${url}/series/${user}/${pass}/${item.series_id},
poster: item.cover,
rawCategory: rawCategory,
category: normalizedCategory,
plot: item.plot || item.description,
year: item.releaseDate ? new Date(item.releaseDate).getFullYear() : null,
rating: item.rating,
genre: item.genre
};
});
}
async tryAlternativeFormats() {
const { xtreamUrl, xtreamUsername, xtreamPassword } = this.config;
try {
console.log('[IPTV] Trying M3U format...');
const m3uUrl = ${xtreamUrl}/get.php?username=${xtreamUsername}&password=${xtreamPassword}&type=m3u_plus&output=ts;
const m3uResp = await fetch(m3uUrl, { timeout: 15000 });
if (m3uResp.ok) {
const m3uContent = await m3uResp.text();
this.parseM3UContent(m3uContent);
return;
}
} catch (e) {
console.log('[IPTV] M3U format failed:', e.message);
}
}
parseM3UContent(content) {
const lines = content.split('\n');
const channels = [];
let currentItem = null;
for (const line of lines) {
const trimmed = line.trim();
if (trimmed.startsWith('#EXTINF:')) {
const match = trimmed.match(/#EXTINF:.?,(.)/);
if (match) {
const name = match[1];
const groupMatch = trimmed.match(/group-title="([^"]+)"/);
const logoMatch = trimmed.match(/tvg-logo="([^"]+)"/);
const rawCategory = groupMatch ? groupMatch[1] : 'Unknown';
currentItem = {
name: name,
rawCategory: rawCategory,
category: this.normalizeCategory(rawCategory),
logo: logoMatch ? logoMatch[1] : null
};
}
} else if (trimmed && !trimmed.startsWith('#') && currentItem) {
currentItem.url = trimmed;
currentItem.id = m3u_${crypto.randomBytes(8).toString('hex')};
currentItem.type = 'channel';
channels.push(currentItem);
currentItem = null;
}
}
this.channels = channels;
const rawCategories = [...new Set(channels.map(c => c.rawCategory).filter(Boolean))];
this.categories.live = this.groupCategories(rawCategories, 'live');
console.log([IPTV] Parsed M3U: ${channels.length} channels, ${this.categories.live.length} categories);
}
getCatalogItems(type, genre, search) {
let items = [];
switch (type) {
case 'channel':
items = this.channels;
break;
case 'movie':
items = this.movies;
break;
case 'series':
items = this.series;
break;
}
// Filter by genre (normalized category)
if (genre && !genre.startsWith('All')) {
items = items.filter(item => item.category === genre);
}
// Filter by search
if (search) {
const searchLower = search.toLowerCase();
items = items.filter(item =>
item.name.toLowerCase().includes(searchLower) ||
item.category.toLowerCase().includes(searchLower) ||
(item.rawCategory && item.rawCategory.toLowerCase().includes(searchLower))
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
if (item.type === 'channel') {
meta.poster = item.logo || https://via.placeholder.com/300x400/333/fff?text=${encodeURIComponent(item.name)};
meta.description = 📺 ${item.category} • ${item.name};
meta.background = meta.poster;
meta.logo = meta.poster;
} else if (item.type === 'movie') {
meta.poster = item.poster || https://via.placeholder.com/300x450/666/fff?text=${encodeURIComponent(item.name)};
meta.description = item.plot || ${item.category} • ${item.name};
if (item.year) meta.year = item.year;
} else if (item.type === 'series') {
meta.poster = item.poster || https://via.placeholder.com/300x450/666/fff?text=${encodeURIComponent(item.name)};
meta.description = item.plot || ${item.category} • ${item.name};
if (item.year) meta.year = item.year;
meta.videos = [];
}
return meta;
}
async getEPG(streamId) {
const cacheKey = epg_${streamId};
const cached = this.getCachedData(cacheKey);
if (cached) {
console.log([EPG] Using cached EPG for stream ${streamId});
return cached;
}
const base = ${this.config.xtreamUrl}/player_api.php?username=${this.config.xtreamUsername}&password=${this.config.xtreamPassword};
const epgUrl = ${base}&action=get_short_epg&stream_id=${streamId}&limit=20;
try {
const response = await fetch(epgUrl, { timeout: 5000 });
const data = await response.json();
const epgListings = data.epg_listings || [];
console.log([EPG] Fetched ${epgListings.length} programs for stream ${streamId});
this.setCachedData(cacheKey, epgListings);
return epgListings;
} catch (error) {
console.error([EPG] Error fetching EPG for ${streamId}:, error.message);
return [];
}
}
async getEpisodeStream(seriesId, season, episode) {
try {
const actualSeriesId = seriesId.replace('series_', '');
const episodeUrl = ${this.config.xtreamUrl}/player_api.php?username=${this.config.xtreamUsername}&password=${this.config.xtreamPassword}&action=get_series_info&series_id=${actualSeriesId};
const response = await fetch(episodeUrl, { timeout: 10000 });
const seriesInfo = await response.json();
if (seriesInfo && seriesInfo.episodes && seriesInfo.episodes[season]) {
const episodeData = seriesInfo.episodes[season].find(ep => ep.episode_num == episode);
if (episodeData) {
return ${this.config.xtreamUrl}/series/${this.config.xtreamUsername}/${this.config.xtreamPassword}/${episodeData.id}.${episodeData.container_extension || 'mp4'};
}
}
const actualSeriesId2 = seriesId.replace('series_', '');
return ${this.config.xtreamUrl}/series/${this.config.xtreamUsername}/${this.config.xtreamPassword}/${actualSeriesId2}/${season}/${episode}.mp4;
} catch (error) {
console.error([STREAM] Error fetching episode stream:, error.message);
const actualSeriesId = seriesId.replace('series_', '');
return ${this.config.xtreamUrl}/series/${this.config.xtreamUsername}/${this.config.xtreamPassword}/${actualSeriesId}/${season}/${episode}.mp4;
}
}
async getStream(id) {
if (id.includes(':')) {
const parts = id.split(':');
if (id.startsWith('series_')) {
const [seriesId, season, episode] = parts;
const series = this.series.find(s => s.id === seriesId);
if (!series) return null;
const url = await this.getEpisodeStream(seriesId, season, episode);
return {
url,
title: ${series.name} - S${season}E${episode},
behaviorHints: { notWebReady: true }
};
} else if (id.startsWith('live_')) {
const channelId = parts[0];
const channel = this.channels.find(c => c.id === channelId);
if (!channel) return null;
return {
url: channel.url,
title: channel.name,
behaviorHints: { notWebReady: true }
};
}
} else {
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
}
module.exports = async function createAddon(config = {}) {
console.log('[CREATE_ADDON] Received config:', config ? Object.keys(config) : 'null');
const addon = new IPTVAddon(config);
await addon.init();
const manifest = {
id: ADDON_ID,
version: "2.2.0",
name: ADDON_NAME,
description: "Self-hosted IPTV addon with smart categorization and EPG support",
logo: "https://via.placeholder.com/256x256/4CAF50/ffffff?text=IPTV",
resources: ["catalog", "stream", "meta"],
types: ["channel", "movie", "series"],
catalogs: [
{
type: 'channel',
id: 'iptv_live',
name: 'Live TV',
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
name: 'TV Series',
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
console.log([CATALOG] Request: type=${type}, id=${id}, genre=${extra.genre}, search=${extra.search});
const items = addon.getCatalogItems(type, extra.genre, extra.search);
const skip = parseInt(extra.skip) || 0;
const metas = items.slice(skip, skip + 100).map(item => addon.generateMeta(item));
console.log([CATALOG] Returning ${metas.length} items for ${type}/${id});
return { metas };
});
builder.defineStreamHandler(async (args) => {
try {
const stream = await addon.getStream(args.id);
return stream ? { streams: [stream] } : { streams: [] };
} catch (error) {
console.error([STREAM] Error getting stream for ${args.id}:, error.message);
return { streams: [] };
}
});
builder.defineMetaHandler(async (args) => {
console.log([META] Request for ID: ${args.id}, type: ${args.type});
const allItems = [...addon.channels, ...addon.movies, ...addon.series];
const item = allItems.find(i => i.id === args.id);
if (!item) {
console.log([META] No item found for ID: ${args.id});
return { meta: null };
}
console.log([META] Found item: ${item.name}, type: ${item.type});
const meta = addon.generateMeta(item);
if (item.type === 'channel') {
try {
const streamId = args.id.replace('live_', '');
const epg = await addon.getEPG(streamId);
meta.videos = epg.map((listing, index) => {
const startTime = listing.start.replace(' ', 'T') + 'Z'; // Assume UTC
const endTime = listing.end.replace(' ', 'T') + 'Z';
return {
id: ${args.id}:${listing.epg_id || index},
title: listing.title || 'Program',
overview: listing.description || 'No description available',
released: new Date(startTime).toISOString(),
duration: (Date.parse(endTime) - Date.parse(startTime)) / 1000
};
});
console.log([EPG] Added ${meta.videos.length} programs to channel meta);
} catch (error) {
console.error([META] Error adding EPG:, error.message);
meta.videos = [];
}
} else if (item.type === 'series') {
try {
const seriesId = item.id.replace('series_', '');
const episodeUrl = ${addon.config.xtreamUrl}/player_api.php?username=${addon.config.xtreamUsername}&password=${addon.config.xtreamPassword}&action=get_series_info&series_id=${seriesId};
console.log([SERIES] Fetching episodes for series ${seriesId});
const response = await fetch(episodeUrl, { timeout: 10000 });
const seriesInfo = await response.json();
if (seriesInfo && seriesInfo.episodes) {
const videos = [];
Object.keys(seriesInfo.episodes).forEach(seasonNum => {
const season = seriesInfo.episodes[seasonNum];
if (Array.isArray(season)) {
season.forEach(episode => {
videos.push({
id: ${item.id}:${seasonNum}:${episode.episode_num},
title: episode.title || Episode ${episode.episode_num},
season: parseInt(seasonNum),
episode: parseInt(episode.episode_num),
overview: Season ${seasonNum} Episode ${episode.episode_num},
thumbnail: episode.info?.movie_image,
released: episode.air_date,
duration: episode.info?.duration_secs
});
});
}
});
videos.sort((a, b) => {
if (a.season !== b.season) return a.season - b.season;
return a.episode - b.episode;
});
meta.videos = videos;
console.log([SERIES] Processed ${meta.videos.length} episodes for ${item.name});
} else {
console.log([SERIES] No episodes found for series ${seriesId});
meta.videos = [{
id: ${item.id}:1:1,
title: "Episode 1",
season: 1,
episode: 1,
overview: "Episode information not available"
}];
}
} catch (error) {
console.error([SERIES] Error fetching episodes for ${item.name}:, error.message);
meta.videos = [{
id: ${item.id}:1:1,
title: "Episode 1",
season: 1,
episode: 1,
overview: "Unable to load episode information"
}];
}
}
return { meta };
});
return builder.getInterface();
};
