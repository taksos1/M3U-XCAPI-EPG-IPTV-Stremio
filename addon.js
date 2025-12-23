const { addonBuilder } = require('stremio-addon-sdk');
const fetch = require('node-fetch');
const crypto = require('crypto');

const ADDON_ID = 'org.stremio.iptv.selfhosted';
const ADDON_NAME = 'IPTV Self-Hosted';

/* =======================
   CACHE
======================= */
const cache = new Map();
const CACHE_TTL = 30 * 60 * 1000;

/* =======================
   CATEGORY NORMALIZATION
======================= */
const CATEGORY_MAPPINGS = {
  sport: 'Sports',
  sports: 'Sports',
  football: 'Sports',
  soccer: 'Sports',
  basketball: 'Sports',
  tennis: 'Sports',
  news: 'News',
  movies: 'Movies',
  movie: 'Movies',
  film: 'Movies',
  series: 'Series',
  tv: 'Series',
  kids: 'Kids',
  cartoon: 'Kids',
  music: 'Music',
  documentary: 'Documentary',
  religious: 'Religious',
};

/* =======================
   ADDON CLASS
======================= */
class IPTVAddon {
  constructor(config) {
    this.config = config;
    this.channels = [];
    this.movies = [];
    this.series = [];
    this.categories = { live: [], movies: [], series: [] };
  }

  normalizeCategory(category) {
    if (!category) return 'Other';
    const lower = category.toLowerCase().trim();
    if (CATEGORY_MAPPINGS[lower]) return CATEGORY_MAPPINGS[lower];
    return category
      .trim()
      .split(' ')
      .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
      .join(' ');
  }

  getCached(key) {
    const item = cache.get(key);
    if (item && Date.now() - item.time < CACHE_TTL) return item.data;
    cache.delete(key);
    return null;
  }

  setCached(key, data) {
    cache.set(key, { data, time: Date.now() });
  }

  async init() {
    if (!this.config?.xtreamUrl) return;
    await this.loadXtream();
  }

  async loadXtream() {
    const { xtreamUrl, xtreamUsername, xtreamPassword } = this.config;
    const cacheKey = crypto
      .createHash('md5')
      .update(xtreamUrl + xtreamUsername)
      .digest('hex');

    const cached = this.getCached(cacheKey);
    if (cached) {
      Object.assign(this, cached);
      return;
    }

    const base = `${xtreamUrl}/player_api.php?username=${encodeURIComponent(
      xtreamUsername
    )}&password=${encodeURIComponent(xtreamPassword)}`;

    const [
      liveStreams,
      vodStreams,
      seriesStreams,
      liveCats,
      vodCats,
      seriesCats,
    ] = await Promise.all([
      fetch(`${base}&action=get_live_streams`).then(r => r.json()),
      fetch(`${base}&action=get_vod_streams`).then(r => r.json()),
      fetch(`${base}&action=get_series`).then(r => r.json()),
      fetch(`${base}&action=get_live_categories`).then(r => r.json()),
      fetch(`${base}&action=get_vod_categories`).then(r => r.json()),
      fetch(`${base}&action=get_series_categories`).then(r => r.json()),
    ]);

    const liveCatMap = this.buildCategoryMap(liveCats);
    const vodCatMap = this.buildCategoryMap(vodCats);
    const seriesCatMap = this.buildCategoryMap(seriesCats);

    this.channels = this.processLive(liveStreams, liveCatMap);
    this.movies = this.processVOD(vodStreams, vodCatMap);
    this.series = this.processSeries(seriesStreams, seriesCatMap);

    this.categories.live = [...new Set(this.channels.map(i => i.category))];
    this.categories.movies = [...new Set(this.movies.map(i => i.category))];
    this.categories.series = [...new Set(this.series.map(i => i.category))];

    this.setCached(cacheKey, {
      channels: this.channels,
      movies: this.movies,
      series: this.series,
      categories: this.categories,
    });
  }

  buildCategoryMap(cats) {
    const map = {};
    if (Array.isArray(cats)) {
      cats.forEach(c => (map[c.category_id] = c.category_name));
    }
    return map;
  }

  processLive(data, catMap) {
    if (!Array.isArray(data)) return [];
    const { xtreamUrl, xtreamUsername, xtreamPassword } = this.config;

    return data.map(i => {
      const raw = catMap[i.category_id] || 'Live TV';
      return {
        id: `live_${i.stream_id}`,
        name: i.name,
        type: 'channel',
        url: `${xtreamUrl}/live/${xtreamUsername}/${xtreamPassword}/${i.stream_id}.ts`,
        logo: i.stream_icon,
        rawCategory: raw,
        category: this.normalizeCategory(raw),
      };
    });
  }

  processVOD(data, catMap) {
    if (!Array.isArray(data)) return [];
    const { xtreamUrl, xtreamUsername, xtreamPassword } = this.config;

    return data.map(i => {
      const raw = catMap[i.category_id] || 'Movies';
      return {
        id: `vod_${i.stream_id}`,
        name: i.name,
        type: 'movie',
        url: `${xtreamUrl}/movie/${xtreamUsername}/${xtreamPassword}/${i.stream_id}.${i.container_extension || 'mp4'}`,
        poster: i.stream_icon,
        category: this.normalizeCategory(raw),
        plot: i.plot,
      };
    });
  }

  processSeries(data, catMap) {
    if (!Array.isArray(data)) return [];
    const { xtreamUrl, xtreamUsername, xtreamPassword } = this.config;

    return data.map(i => {
      const raw = catMap[i.category_id] || 'Series';
      return {
        id: `series_${i.series_id}`,
        name: i.name,
        type: 'series',
        url: `${xtreamUrl}/series/${xtreamUsername}/${xtreamPassword}/${i.series_id}`,
        poster: i.cover,
        category: this.normalizeCategory(raw),
      };
    });
  }

  getCatalog(type, genre, search) {
    let list =
      type === 'channel'
        ? this.channels
        : type === 'movie'
        ? this.movies
        : this.series;

    if (genre && !genre.startsWith('All'))
      list = list.filter(i => i.category === genre);

    if (search) {
      const s = search.toLowerCase();
      list = list.filter(i => i.name.toLowerCase().includes(s));
    }

    return list;
  }

  getStream(id) {
    const all = [...this.channels, ...this.movies, ...this.series];
    const item = all.find(i => i.id === id);
    if (!item) return null;
    return { streams: [{ url: item.url }] };
  }
}

/* =======================
   EXPORT
======================= */
module.exports = async function createAddon(config = {}) {
  const addon = new IPTVAddon(config);
  await addon.init();

  const builder = new addonBuilder({
    id: ADDON_ID,
    version: '2.2.0',
    name: ADDON_NAME,
    description: 'Self-hosted IPTV addon',
    resources: ['catalog', 'stream'],
    types: ['channel', 'movie', 'series'],
    catalogs: [
      { type: 'channel', id: 'live', name: 'Live TV', extra: [{ name: 'genre' }, { name: 'search' }] },
      { type: 'movie', id: 'movies', name: 'Movies', extra: [{ name: 'genre' }, { name: 'search' }] },
      { type: 'series', id: 'series', name: 'Series', extra: [{ name: 'genre' }, { name: 'search' }] },
    ],
  });

  builder.defineCatalogHandler(({ type, extra }) => {
    const items = addon.getCatalog(type, extra.genre, extra.search);
    return { metas: items };
  });

  builder.defineStreamHandler(({ id }) => addon.getStream(id));

  return builder.getInterface();
};
