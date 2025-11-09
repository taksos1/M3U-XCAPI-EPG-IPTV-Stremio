// directProvider.js
// Adds Direct M3U fetching with series detection & per-episode grouping.
// Series grouping heuristic looks for SxxEyy or "Season" patterns.
// Episodes are stored in addonInstance.directSeriesEpisodeIndex for quick meta/stream resolution.

const fetch = require('node-fetch');
const crypto = require('crypto');

function hash(str) {
    return crypto.createHash('md5').update(str).digest('hex').slice(0, 16);
}

function baseSeriesName(raw) {
    if (!raw) return '';
    let name = raw
        .replace(/\bS\d{1,2}E\d{1,2}\b.*$/i, '')
        .replace(/\bSeason\s?\d+.*$/i, '')
        .replace(/[-._]+$/,'')
        .trim();
    return name;
}

function extractSeasonEpisode(title) {
    // Returns { season, episode } or null
    let m = title.match(/\bS(\d{1,2})E(\d{1,2})\b/i);
    if (m) return { season: parseInt(m[1], 10), episode: parseInt(m[2], 10) };
    // Alternate "Season X Episode Y"
    m = title.match(/\bSeason\s?(\d{1,2}).*?\bEpisode\s?(\d{1,3})\b/i);
    if (m) return { season: parseInt(m[1], 10), episode: parseInt(m[2], 10) };
    // Alternate "Season X Ep Y"
    m = title.match(/\bSeason\s?(\d{1,2}).*?\bEp\s?(\d{1,3})\b/i);
    if (m) return { season: parseInt(m[1], 10), episode: parseInt(m[2], 10) };
    // "Sx Exx" compressed? (rare) Already covered by SNNENN pattern above.
    return null;
}

async function fetchData(addonInstance) {
    const { config } = addonInstance;
    const { m3uUrl } = config;

    if (!m3uUrl) throw new Error('Direct provider requires m3uUrl');

    addonInstance.channels = [];
    addonInstance.movies = [];
    addonInstance.series = [];
    addonInstance.directSeriesEpisodeIndex = new Map(); // reset
    addonInstance.epgData = {};

    // Fetch playlist
    let playlistText;
    {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 45000);
        try {
            const resp = await fetch(m3uUrl, {
                signal: controller.signal,
                headers: { 'User-Agent': 'Stremio M3U/EPG Addon (directProvider)' }
            });
            if (!resp.ok) throw new Error(`M3U fetch failed (${resp.status})`);
            playlistText = await resp.text();
        } finally {
            clearTimeout(timeout);
        }
    }

    const items = addonInstance.parseM3U(playlistText);

    // Separate by type (already heuristically assigned in parseM3U)
    addonInstance.channels = items.filter(i => i.type === 'tv');
    addonInstance.movies = items.filter(i => i.type === 'movie');

    if (config.includeSeries !== false) {
        // Build episode grouping from items of type 'series'
        const episodeItems = items.filter(i => i.type === 'series');
        const seriesMap = new Map(); // baseName -> series meta
        const episodesMap = new Map(); // seriesId -> episodes array

        for (const ep of episodeItems) {
            const baseName = baseSeriesName(ep.name);
            if (!baseName) continue;

            // Determine season/episode
            const se = extractSeasonEpisode(ep.name) || { season: 1, episode: 0 };
            const seriesHash = hash(baseName);
            const seriesId = `iptv_series_${seriesHash}`;

            if (!seriesMap.has(baseName)) {
                seriesMap.set(baseName, {
                    id: seriesId,
                    series_id: seriesHash,
                    name: baseName,
                    type: 'series',
                    poster: ep.logo || ep.attributes?.['tvg-logo'],
                    plot: ep.attributes?.['plot'] || '',
                    category: ep.category,
                    attributes: {
                        'tvg-logo': ep.logo || ep.attributes?.['tvg-logo'],
                        'group-title': ep.category || ep.attributes?.['group-title'],
                        'plot': ep.attributes?.['plot'] || ''
                    }
                });
                episodesMap.set(seriesId, []);
            }

            const episodeId = `iptv_series_ep_${hash(seriesId + ep.url + se.season + '_' + se.episode)}`;

            episodesMap.get(seriesId).push({
                id: episodeId,
                title: ep.name,
                season: se.season,
                episode: se.episode,
                released: null,
                thumbnail: ep.logo || ep.attributes?.['tvg-logo'] || null,
                url: ep.url,
                stream_id: episodeId
            });
        }

        // Sort episodes in each series
        for (const [sid, eps] of episodesMap.entries()) {
            eps.sort((a, b) => (a.season - b.season) || (a.episode - b.episode));
            addonInstance.directSeriesEpisodeIndex.set(sid.replace(/^iptv_series_/, ''), eps);
        }

        addonInstance.series = Array.from(seriesMap.values());
    }

    // EPG (optional)
    if (config.enableEpg && config.epgUrl) {
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 45000);
            let epgResp;
            try {
                epgResp = await fetch(config.epgUrl, {
                    signal: controller.signal,
                    headers: { 'User-Agent': 'Stremio M3U/EPG Addon (directProvider/epg)' }
                });
            } finally {
                clearTimeout(timeout);
            }
            if (epgResp && epgResp.ok) {
                const epgContent = await epgResp.text();
                addonInstance.epgData = await addonInstance.parseEPG(epgContent);
            }
        } catch {
            // ignore EPG errors
        }
    }
}

async function fetchSeriesInfo(addonInstance, seriesId) {
    // For direct provider we already have episodes in directSeriesEpisodeIndex
    if (!seriesId) return { videos: [] };
    // Accept either raw or with prefix
    const normalized = seriesId.toString().replace(/^iptv_series_/, '');
    const episodes = addonInstance.directSeriesEpisodeIndex.get(normalized) || [];
    return { videos: episodes, fetchedAt: Date.now() };
}

module.exports = {
    fetchData,
    fetchSeriesInfo
};