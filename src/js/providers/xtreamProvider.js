// xtreamProvider.js
// Extended to support series (shows) via Xtream API:
// - fetchData now retrieves series list when includeSeries !== false
// - fetchSeriesInfo lazily queries per-series episodes (get_series_info)
// episodes are transformed into Stremio 'videos' (season/episode).
const fetch = require('node-fetch');

async function fetchData(addonInstance) {
    const { config } = addonInstance;
    const {
        xtreamUrl,
        xtreamUsername,
        xtreamPassword,
        xtreamUseM3U,
        xtreamOutput
    } = config;

    if (!xtreamUrl || !xtreamUsername || !xtreamPassword) {
        throw new Error('Xtream credentials incomplete');
    }

    addonInstance.channels = [];
    addonInstance.movies = [];
    if (config.includeSeries !== false) addonInstance.series = [];
    addonInstance.epgData = {};

    if (xtreamUseM3U) {
        // M3U plus mode (series heuristic limited)
        const url =
            `${xtreamUrl}/get.php?username=${encodeURIComponent(xtreamUsername)}` +
            `&password=${encodeURIComponent(xtreamPassword)}` +
            `&type=m3u_plus` +
            (xtreamOutput ? `&output=${encodeURIComponent(xtreamOutput)}` : '');
        const resp = await fetch(url, {
            timeout: 30000,
            headers: { 'User-Agent': 'Stremio M3U/EPG Addon (xtreamProvider/m3u)' }
        });
        if (!resp.ok) throw new Error('Xtream M3U fetch failed');
        const text = await resp.text();
        const items = addonInstance.parseM3U(text);

        addonInstance.channels = items.filter(i => i.type === 'tv');
        addonInstance.movies = items.filter(i => i.type === 'movie');

        if (config.includeSeries !== false) {
            const seriesCandidates = items.filter(i => i.type === 'series');
            console.log(`[DEBUG] Found ${seriesCandidates.length} series candidates`);
            
            // Reduce duplication by grouping by cleaned series name and collect episodes
            const seen = new Map();
            const episodesBySeriesId = new Map();
            
            for (const sc of seriesCandidates) {
                // Comprehensive series name cleaning for all IPTV formats
                let baseName = sc.name;
                
                // Remove all common episode/season patterns
                baseName = baseName.replace(/\bS\d{1,2}E\d{1,2}\b.*$/i, '').trim();                    // S01E01
                baseName = baseName.replace(/\bSeason\s*\d+.*$/i, '').trim();                         // Season 1
                baseName = baseName.replace(/\bEpisode\s*\d+.*$/i, '').trim();                        // Episode 1
                baseName = baseName.replace(/\b\d{1,2}x\d{1,2}\b.*$/i, '').trim();                   // 1x01
                baseName = baseName.replace(/\bEp\s*\d+.*$/i, '').trim();                             // Ep 01
                baseName = baseName.replace(/\bE\d{1,3}\b.*$/i, '').trim();                           // E01
                baseName = baseName.replace(/\bPart\s*\d+.*$/i, '').trim();                           // Part 1
                baseName = baseName.replace(/\bChapter\s*\d+.*$/i, '').trim();                        // Chapter 1
                baseName = baseName.replace(/\[\d+\].*$/i, '').trim();                                // [01]
                baseName = baseName.replace(/\(\d+\).*$/i, '').trim();                                // (01)
                baseName = baseName.replace(/\b\d+\s*of\s*\d+.*$/i, '').trim();                      // 1 of 10
                baseName = baseName.replace(/\b\d+\/\d+.*$/i, '').trim();                             // 1/10
                baseName = baseName.replace(/\bSeries\s*\d+.*$/i, '').trim();                         // Series 1
                baseName = baseName.replace(/\bVol\s*\d+.*$/i, '').trim();                            // Vol 1
                baseName = baseName.replace(/\bVolume\s*\d+.*$/i, '').trim();                         // Volume 1
                baseName = baseName.replace(/\b\d{4}\.\d{2}\.\d{2}.*$/i, '').trim();                 // 2023.01.01
                baseName = baseName.replace(/\b\d{1,2}-\d{1,2}-\d{4}.*$/i, '').trim();              // 01-01-2023
                baseName = baseName.replace(/\b\d{2}\/\d{2}\/\d{4}.*$/i, '').trim();                // 01/01/2023
                
                // Remove common separators and clean up
                baseName = baseName.replace(/[-_\.\|]+$/, '').trim();                                 // Trailing separators
                baseName = baseName.replace(/\s+[-_\.\|]\s*$/, '').trim();                           // Spaced separators
                
                if (!baseName || baseName.length < 2) baseName = sc.name; // Fallback to original name
                
                const seriesId = cryptoHash(baseName);
                
                if (!seen.has(baseName)) {
                    seen.set(baseName, {
                        id: `iptv_series_${seriesId}`,
                        series_id: seriesId,
                        name: baseName,
                        type: 'series',
                        poster: sc.logo || sc.attributes?.['tvg-logo'],
                        plot: sc.attributes?.['plot'] || `Series: ${baseName}`,
                        category: sc.category,
                        attributes: {
                            'tvg-logo': sc.logo || sc.attributes?.['tvg-logo'],
                            'group-title': sc.category || sc.attributes?.['group-title'],
                            'plot': sc.attributes?.['plot'] || `Series: ${baseName}`
                        }
                    });
                    episodesBySeriesId.set(seriesId, []);
                    console.log(`[DEBUG] Created series: ${baseName} (ID: ${seriesId})`);
                }
                
                // Enhanced episode parsing for all formats
                let season = 1, episode = 1;
                const originalName = sc.name;
                
                // Try multiple episode patterns in order of specificity
                let episodeMatch = originalName.match(/\bS(\d{1,2})E(\d{1,2})\b/i);                  // S01E01
                if (episodeMatch) {
                    season = parseInt(episodeMatch[1], 10);
                    episode = parseInt(episodeMatch[2], 10);
                } else {
                    episodeMatch = originalName.match(/\bSeason\s*(\d+).*?Episode\s*(\d+)\b/i);       // Season 1 Episode 1
                    if (episodeMatch) {
                        season = parseInt(episodeMatch[1], 10);
                        episode = parseInt(episodeMatch[2], 10);
                    } else {
                        episodeMatch = originalName.match(/\b(\d{1,2})x(\d{1,2})\b/i);               // 1x01
                        if (episodeMatch) {
                            season = parseInt(episodeMatch[1], 10);
                            episode = parseInt(episodeMatch[2], 10);
                        } else {
                            episodeMatch = originalName.match(/\bEp\s*(\d+)/i);                       // Ep 01
                            if (episodeMatch) {
                                episode = parseInt(episodeMatch[1], 10);
                            } else {
                                episodeMatch = originalName.match(/\bE(\d{1,3})\b/i);                 // E01
                                if (episodeMatch) {
                                    episode = parseInt(episodeMatch[1], 10);
                                } else {
                                    episodeMatch = originalName.match(/\bPart\s*(\d+)/i);             // Part 1
                                    if (episodeMatch) {
                                        episode = parseInt(episodeMatch[1], 10);
                                    } else {
                                        episodeMatch = originalName.match(/\bChapter\s*(\d+)/i);      // Chapter 1
                                        if (episodeMatch) {
                                            episode = parseInt(episodeMatch[1], 10);
                                        } else {
                                            episodeMatch = originalName.match(/\[(\d+)\]/);           // [01]
                                            if (episodeMatch) {
                                                episode = parseInt(episodeMatch[1], 10);
                                            } else {
                                                episodeMatch = originalName.match(/\((\d+)\)/);       // (01)
                                                if (episodeMatch) {
                                                    episode = parseInt(episodeMatch[1], 10);
                                                } else {
                                                    episodeMatch = originalName.match(/\b(\d+)\s*of\s*\d+\b/i); // 1 of 10
                                                    if (episodeMatch) {
                                                        episode = parseInt(episodeMatch[1], 10);
                                                    } else {
                                                        episodeMatch = originalName.match(/\b(\d+)\/\d+\b/); // 1/10
                                                        if (episodeMatch) {
                                                            episode = parseInt(episodeMatch[1], 10);
                                                        } else {
                                                            // Date-based episodes
                                                            episodeMatch = originalName.match(/\b(\d{4})\.(\d{2})\.(\d{2})\b/); // 2023.01.01
                                                            if (episodeMatch) {
                                                                const year = parseInt(episodeMatch[1], 10);
                                                                const month = parseInt(episodeMatch[2], 10);
                                                                const day = parseInt(episodeMatch[3], 10);
                                                                season = year - 2020; // Arbitrary base year
                                                                episode = month * 100 + day; // MMDD format
                                                            } else {
                                                                // Sequential numbering fallback
                                                                episode = episodesBySeriesId.get(seriesId).length + 1;
                                                            }
                                                        }
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                
                // Add episode to the series
                const episodes = episodesBySeriesId.get(seriesId);
                const episodeData = {
                    id: `iptv_series_ep_${cryptoHash(sc.name + sc.url)}`,
                    title: sc.name,
                    season: season,
                    episode: episode,
                    url: sc.url,
                    thumbnail: sc.logo || sc.attributes?.['tvg-logo']
                };
                episodes.push(episodeData);
                
                console.log(`[DEBUG] Added episode: ${sc.name} -> S${season}E${episode} to series ${baseName}`);
            }
            
            // Fallback grouping for items that might be series but didn't match patterns
            const remainingItems = items.filter(i => i.type === 'tv' && !i.name.toLowerCase().includes('live'));
            const fallbackSeries = new Map();
            
            for (const item of remainingItems) {
                // Try to find potential series by similar names
                let potentialSeriesName = item.name;
                
                // Remove common suffixes that might indicate episodes
                potentialSeriesName = potentialSeriesName.replace(/\s*[-_\|]\s*\d+\s*$/, '').trim();
                potentialSeriesName = potentialSeriesName.replace(/\s*\d+\s*$/, '').trim();
                potentialSeriesName = potentialSeriesName.replace(/\s*HD\s*$/, '').trim();
                potentialSeriesName = potentialSeriesName.replace(/\s*FHD\s*$/, '').trim();
                potentialSeriesName = potentialSeriesName.replace(/\s*4K\s*$/, '').trim();
                
                // Only consider as potential series if name is long enough and contains certain keywords
                if (potentialSeriesName.length > 3 && 
                    (item.category?.toLowerCase().includes('show') || 
                     item.category?.toLowerCase().includes('series') ||
                     item.category?.toLowerCase().includes('drama') ||
                     item.category?.toLowerCase().includes('comedy'))) {
                    
                    const fallbackId = cryptoHash(potentialSeriesName);
                    
                    if (!seen.has(potentialSeriesName) && !fallbackSeries.has(potentialSeriesName)) {
                        fallbackSeries.set(potentialSeriesName, {
                            id: `iptv_series_${fallbackId}`,
                            series_id: fallbackId,
                            name: potentialSeriesName,
                            type: 'series',
                            poster: item.logo || item.attributes?.['tvg-logo'],
                            plot: `Series: ${potentialSeriesName}`,
                            category: item.category,
                            attributes: {
                                'tvg-logo': item.logo || item.attributes?.['tvg-logo'],
                                'group-title': item.category || item.attributes?.['group-title'],
                                'plot': `Series: ${potentialSeriesName}`
                            }
                        });
                        episodesBySeriesId.set(fallbackId, []);
                        console.log(`[DEBUG] Created fallback series: ${potentialSeriesName} (ID: ${fallbackId})`);
                    }
                    
                    // Add as episode
                    const episodes = episodesBySeriesId.get(fallbackId);
                    const episodeData = {
                        id: `iptv_series_ep_${cryptoHash(item.name + item.url)}`,
                        title: item.name,
                        season: 1,
                        episode: episodes.length + 1,
                        url: item.url,
                        thumbnail: item.logo || item.attributes?.['tvg-logo']
                    };
                    episodes.push(episodeData);
                    console.log(`[DEBUG] Added fallback episode: ${item.name} -> S1E${episodes.length} to series ${potentialSeriesName}`);
                }
            }
            
            // Merge fallback series with main series
            for (const fallbackSeries of fallbackSeries.values()) {
                seen.set(fallbackSeries.name, fallbackSeries);
            }
            
            addonInstance.series = Array.from(seen.values());
            
            // Store episodes for each series in the direct series episode index
            for (const [seriesId, episodes] of episodesBySeriesId.entries()) {
                addonInstance.directSeriesEpisodeIndex.set(seriesId, episodes);
                console.log(`[DEBUG] Stored ${episodes.length} episodes for series ID: ${seriesId}`);
            }
            
            console.log(`[DEBUG] Total series created: ${addonInstance.series.length} (including ${fallbackSeries.size} fallback series)`);
        }
    } else {
        // JSON API mode
        const base = `${xtreamUrl}/player_api.php?username=${encodeURIComponent(xtreamUsername)}&password=${encodeURIComponent(xtreamPassword)}`;
        // Fetch streams + category lists in parallel to map category_id -> category_name
        const [liveResp, vodResp, liveCatsResp, vodCatsResp] = await Promise.all([
            fetch(`${base}&action=get_live_streams`, { timeout: 30000 }),
            fetch(`${base}&action=get_vod_streams`, { timeout: 30000 }),
            fetch(`${base}&action=get_live_categories`, { timeout: 20000 }).catch(() => null),
            fetch(`${base}&action=get_vod_categories`, { timeout: 20000 }).catch(() => null)
        ]);

        if (!liveResp.ok) throw new Error('Xtream live streams fetch failed');
        if (!vodResp.ok) throw new Error('Xtream VOD streams fetch failed');
        const live = await liveResp.json();
        const vod = await vodResp.json();

        let liveCatMap = {};
        let vodCatMap = {};
        try {
            if (liveCatsResp && liveCatsResp.ok) {
                const arr = await liveCatsResp.json();
                if (Array.isArray(arr)) {
                    for (const c of arr) {
                        if (c && c.category_id && c.category_name)
                            liveCatMap[c.category_id] = c.category_name;
                    }
                }
            }
        } catch { /* ignore */ }
        try {
            if (vodCatsResp && vodCatsResp.ok) {
                const arr = await vodCatsResp.json();
                if (Array.isArray(arr)) {
                    for (const c of arr) {
                        if (c && c.category_id && c.category_name)
                            vodCatMap[c.category_id] = c.category_name;
                    }
                }
            }
        } catch { /* ignore */ }

        addonInstance.channels = (Array.isArray(live) ? live : []).map(s => {
            const cat = liveCatMap[s.category_id] || s.category_name || s.category_id || 'Live';
            return {
                id: `iptv_live_${s.stream_id}`,
                name: s.name,
                type: 'tv',
                url: `${xtreamUrl}/live/${xtreamUsername}/${xtreamPassword}/${s.stream_id}.m3u8`,
                logo: s.stream_icon,
                category: cat,
                epg_channel_id: s.epg_channel_id,
                attributes: {
                    'tvg-logo': s.stream_icon,
                    'tvg-id': s.epg_channel_id,
                    'group-title': cat
                }
            };
        });

        addonInstance.movies = (Array.isArray(vod) ? vod : []).map(s => {
            const cat = vodCatMap[s.category_id] || s.category_name || 'Movies';
            return {
                id: `iptv_vod_${s.stream_id}`,
                name: s.name,
                type: 'movie',
                url: `${xtreamUrl}/movie/${xtreamUsername}/${xtreamPassword}/${s.stream_id}.${s.container_extension}`,
                poster: s.stream_icon,
                plot: s.plot,
                year: s.releasedate ? new Date(s.releasedate).getFullYear() : null,
                category: cat,
                attributes: {
                    'tvg-logo': s.stream_icon,
                    'group-title': cat,
                    'plot': s.plot
                }
            };
        });

        if (config.includeSeries !== false) {
            try {
                const [seriesResp, seriesCatsResp] = await Promise.all([
                    fetch(`${base}&action=get_series`, { timeout: 35000 }),
                    fetch(`${base}&action=get_series_categories`, { timeout: 20000 }).catch(() => null)
                ]);
                let seriesCatMap = {};
                try {
                    if (seriesCatsResp && seriesCatsResp.ok) {
                        const arr = await seriesCatsResp.json();
                        if (Array.isArray(arr)) {
                            for (const c of arr) {
                                if (c && c.category_id && c.category_name)
                                    seriesCatMap[c.category_id] = c.category_name;
                            }
                        }
                    }
                } catch { /* ignore */ }
                if (seriesResp.ok) {
                    const seriesList = await seriesResp.json();
                    if (Array.isArray(seriesList)) {
                        addonInstance.series = seriesList.map(s => {
                            const cat = seriesCatMap[s.category_id] || s.category_name || 'Series';
                            return {
                                id: `iptv_series_${s.series_id}`,
                                series_id: s.series_id,
                                name: s.name,
                                type: 'series',
                                poster: s.cover,
                                plot: s.plot,
                                category: cat,
                                attributes: {
                                    'tvg-logo': s.cover,
                                    'group-title': cat,
                                    'plot': s.plot
                                }
                            };
                        });
                    }
                }
            } catch (e) {
                // Series optional
            }
        }
    }

    // EPG handling:
    if (config.enableEpg) {
        const customEpgUrl = config.epgUrl && typeof config.epgUrl === 'string' && config.epgUrl.trim() ? config.epgUrl.trim() : null;
        const epgSource = customEpgUrl
            ? customEpgUrl
            : `${xtreamUrl}/xmltv.php?username=${encodeURIComponent(xtreamUsername)}&password=${encodeURIComponent(xtreamPassword)}`;

        try {
            const epgResp = await fetch(epgSource, { timeout: 45000 });
            if (epgResp.ok) {
                const epgContent = await epgResp.text();
                addonInstance.epgData = await addonInstance.parseEPG(epgContent);
            }
        } catch {
            // Ignore EPG errors
        }
    }
}

async function fetchSeriesInfo(addonInstance, seriesId) {
    const { config } = addonInstance;
    if (!seriesId) return { videos: [] };
    
    // For m3u_plus mode, use the direct series episode index
    if (config.xtreamUseM3U) {
        const episodes = addonInstance.directSeriesEpisodeIndex.get(seriesId) || [];
        const videos = episodes.sort((a, b) => (a.season - b.season) || (a.episode - b.episode));
        return { videos, fetchedAt: Date.now() };
    }
    
    // For JSON API mode
    if (!config || !config.xtreamUrl || !config.xtreamUsername || !config.xtreamPassword) return { videos: [] };

    const base = `${config.xtreamUrl}/player_api.php?username=${encodeURIComponent(config.xtreamUsername)}&password=${encodeURIComponent(config.xtreamPassword)}`;
    try {
        const infoResp = await fetch(`${base}&action=get_series_info&series_id=${encodeURIComponent(seriesId)}`, { timeout: 25000 });
        if (!infoResp.ok) return { videos: [] };
        const infoJson = await infoResp.json();
        const videos = [];
        // Xtream returns episodes keyed by season: { "1": [ { id, title, container_extension, episode_num, season, ...}, ... ], "2": [...] }
        const episodesObj = infoJson.episodes || {};
        Object.keys(episodesObj).forEach(seasonKey => {
            const seasonEpisodes = episodesObj[seasonKey];
            if (Array.isArray(seasonEpisodes)) {
                for (const ep of seasonEpisodes) {
                    const epId = ep.id;
                    const container = ep.container_extension || 'mp4';
                    const url = `${config.xtreamUrl}/series/${encodeURIComponent(config.xtreamUsername)}/${encodeURIComponent(config.xtreamPassword)}/${epId}.${container}`;
                    videos.push({
                        id: `iptv_series_ep_${epId}`,
                        title: ep.title || `Episode ${ep.episode_num}`,
                        season: parseInt(ep.season || seasonKey, 10),
                        episode: parseInt(ep.episode_num || ep.episode || 0, 10),
                        released: ep.releasedate || ep.added || null,
                        thumbnail: ep.info?.movie_image || ep.info?.episode_image || ep.info?.cover_big || null,
                        url,
                        stream_id: epId
                    });
                }
            }
        });
        // Sort by season then episode
        videos.sort((a, b) => (a.season - b.season) || (a.episode - b.episode));
        return { videos, fetchedAt: Date.now() };
    } catch {
        return { videos: [] };
    }
}

function cryptoHash(text) {
    return require('crypto').createHash('md5').update(text).digest('hex').slice(0, 12);
}

module.exports = {
    fetchData,
    fetchSeriesInfo
};
