// direct-config.js (client pre-flight with CORS fallback via server /api/prefetch)
// Updated: If EPG fetch (browser + server) fails, continue WITHOUT EPG instead of aborting.
(function () {
    const form = document.getElementById('directForm');
    if (!form) {
        console.error('[DIRECT-CONFIG] #directForm not found');
        return;
    }

    const m3uInput       = document.getElementById('m3uUrl');
    const epgInput       = document.getElementById('epgUrl');
    const enableEpgChk   = document.getElementById('enableEpg');
    const epgOffsetInput = document.getElementById('epgOffsetHours');
    const debugChk       = document.getElementById('debugMode');

    const {
        showOverlay,
        hideOverlay,
        startPolling,
        buildUrls,
        setProgress,
        overlaySetMessage,
        appendDetail
    } = window.ConfigureCommon || {};

    if (!window.ConfigureCommon) {
        console.error('[DIRECT-CONFIG] ConfigureCommon not loaded.');
        return;
    }

    function validateUrl(u) {
        try {
            const x = new URL(u);
            return x.protocol === 'http:' || x.protocol === 'https:';
        } catch {
            return false;
        }
    }

    async function fetchTextBrowser(url, phaseLabel) {
        appendDetail(`→ (Browser) Fetching ${phaseLabel}: ${url}`);
        const res = await fetch(url, { method: 'GET' });
        if (!res.ok) throw new Error(`${phaseLabel} HTTP ${res.status}`);
        const txt = await res.text();
        appendDetail(`✔ (Browser) ${phaseLabel} ${txt.length.toLocaleString()} bytes`);
        return txt;
    }

    async function fetchTextServer(url, purpose) {
        appendDetail(`→ (Server) Prefetch ${purpose}: ${url}`);
        const res = await fetch('/api/prefetch', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url, purpose })
        });
        let payload = {};
        try { payload = await res.json(); } catch { /* ignore */ }
        if (!res.ok) {
            const msg = payload.error || `HTTP ${res.status}`;
            const detail = payload.detail ? ` (${payload.detail})` : '';
            throw new Error(`Server prefetch failed ${res.status} - ${msg}${detail}`);
        }
        if (!payload.ok || !payload.content) throw new Error('Server prefetch empty content');
        appendDetail(`✔ (Server) ${purpose} ${payload.bytes.toLocaleString()} bytes${payload.truncated ? ' (truncated)' : ''}`);
        return payload.content;
    }

    async function robustFetch(url, purpose, browserFirst = true) {
        if (browserFirst) {
            try {
                return await fetchTextBrowser(url, purpose);
            } catch (e) {
                appendDetail(`⚠ Browser fetch failed (${e.message}) → server fallback`);
            }
        }
        return await fetchTextServer(url, purpose);
    }

    function parseM3U(content) {
        const start = performance.now();
        const lines = content.split('\n');
        const items = [];
        let current = null;
        let processed = 0;
        for (const raw of lines) {
            const line = raw.trim();
            if (line.startsWith('#EXTINF:')) {
                const m = line.match(/#EXTINF:(-?\d+)(?:\s+(.*))?,(.*)/);
                if (m) {
                    current = {
                        duration: parseInt(m[1]),
                        attrs: parseAttrs(m[2] || ''),
                        name: (m[3] || '').trim()
                    };
                }
            } else if (line && !line.startsWith('#') && current) {
                current.url = line;
                items.push(current);
                current = null;
            }
            processed++;
            if (processed % 1500 === 0) {
                appendDetail(`… parsed ${processed}/${lines.length}`);
            }
        }
        const ms = (performance.now() - start).toFixed(1);
        appendDetail(`✔ Playlist parsed: ${items.length} entries (${ms} ms)`);
        return items;
    }

    function parseAttrs(str) {
        const out = {};
        const r = /(\w+(?:-\w+)*)="([^"]*)"/g;
        let m;
        while ((m = r.exec(str)) !== null) out[m[1]] = m[2];
        return out;
    }

    function quickEpgStats(xml) {
        const prog = xml.match(/<programme\s/gi);
        const ch   = xml.match(/<channel\s/gi);
        return {
            programmes: prog ? prog.length : 0,
            channels: ch ? ch.length : 0
        };
    }

    function uuid() {
        return (crypto && crypto.randomUUID)
            ? crypto.randomUUID()
            : 'id-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    }

    form.addEventListener('submit', async (e) => {
        e.preventDefault();

        const m3uUrl = m3uInput.value.trim();
        const enableEpgInitial = enableEpgChk.checked;
        const epgUrl = epgInput.value.trim();
        const epgOffsetHours = epgOffsetInput.value ? parseFloat(epgOffsetInput.value) : 0;
        const debug = !!(debugChk && debugChk.checked);

        if (!validateUrl(m3uUrl)) {
            alert('Invalid M3U URL');
            return;
        }
        if (enableEpgInitial && epgUrl && !validateUrl(epgUrl)) {
            alert('Invalid EPG URL');
            return;
        }

        showOverlay(true);
        overlaySetMessage('Pre-flight: Validating inputs…');
        setProgress(4, 'Starting');
        appendDetail('== PRE-FLIGHT CHECKS ==');
        appendDetail(`M3U URL: ${m3uUrl}`);
        if (enableEpgInitial && epgUrl) appendDetail(`EPG URL: ${epgUrl}`);
        appendDetail(`Debug logging: ${debug ? 'enabled' : 'disabled'}`);

        let enableEpgFinal = enableEpgInitial;
        try {
            // 1. Fetch Playlist
            setProgress(10, 'Fetching Playlist');
            let playlistText;
            try {
                playlistText = await robustFetch(m3uUrl, 'playlist', true);
            } catch (bFail) {
                appendDetail(`⚠ Playlist fetch initial attempt failed: ${bFail.message}`);
                playlistText = await robustFetch(m3uUrl, 'playlist', false);
            }

            // 2. Parse M3U
            setProgress(28, 'Parsing Playlist');
            const items = parseM3U(playlistText);
            if (!items.length) throw new Error('Empty playlist after parse');

            // Stats
            const approxMovies = items.filter(i =>
                /movie/i.test(i.name) || /\(\d{4}\)/.test(i.name)
            ).length;
            const approxTv = items.length - approxMovies;
            appendDetail(`Heuristic: ~${approxTv} TV / ~${approxMovies} Movie`);

            // 3. Optional EPG (non-fatal)
            let epgStats = { programmes: 0, channels: 0 };
            if (enableEpgInitial && epgUrl) {
                let epgTxt = null;
                setProgress(42, 'Fetching EPG');
                try {
                    try {
                        epgTxt = await robustFetch(epgUrl, 'epg', true);
                    } catch (epgFail) {
                        appendDetail(`⚠ EPG browser fetch failed: ${epgFail.message} → server fallback`);
                        epgTxt = await robustFetch(epgUrl, 'epg', false);
                    }
                } catch (finalEpgErr) {
                    appendDetail(`✖ EPG fetch failed after both attempts (${finalEpgErr.message}) – continuing WITHOUT EPG`);
                    enableEpgFinal = false;
                }

                if (enableEpgFinal && epgTxt) {
                    setProgress(50, 'Scanning EPG');
                    epgStats = quickEpgStats(epgTxt);
                    appendDetail(`✔ EPG scan: ${epgStats.programmes.toLocaleString()} programmes / ${epgStats.channels.toLocaleString()} channels`);
                }
            } else if (enableEpgInitial) {
                appendDetail('No EPG URL supplied; continuing without EPG.');
                enableEpgFinal = false;
            } else {
                appendDetail('EPG disabled by user.');
            }

            // 4. Build config token
            setProgress(60, 'Building token');
            const config = {
                provider: 'direct',
                m3uUrl,
                enableEpg: enableEpgFinal,
                debug: debug || undefined
            };
            if (enableEpgFinal && epgUrl) config.epgUrl = epgUrl;
            if (isFinite(epgOffsetHours) && epgOffsetHours !== 0) config.epgOffsetHours = epgOffsetHours;

            config.prescan = {
                entries: items.length,
                approxTv,
                approxMovies,
                epgProgrammes: enableEpgFinal ? epgStats.programmes : 0,
                epgChannels: enableEpgFinal ? epgStats.channels : 0
            };

            config.instanceId = config.instanceId || uuid();

            const { manifestUrl, stremioUrl } = buildUrls(config);
            appendDetail('✔ Token built');
            appendDetail('Manifest URL: ' + manifestUrl);
            appendDetail('Stremio URL: ' + stremioUrl);

            // 5. Start manifest polling
            setProgress(70, 'Waiting for manifest');
            appendDetail('== SERVER BUILD PHASE ==');
            appendDetail('Polling server…');
            startPolling(70);
        } catch (err) {
            console.error('[DIRECT-CONFIG] Pre-flight error', err);
            overlaySetMessage('Pre-flight failed');
            appendDetail('✖ Error: ' + (err.message || err.toString()));
            setProgress(100, 'Failed');
            appendDetail('Close overlay and adjust inputs to retry.');
            const status = document.getElementById('statusDetails');
            if (status && !document.getElementById('retryCloseBtn')) {
                const btn = document.createElement('button');
                btn.id = 'retryCloseBtn';
                btn.textContent = 'Close';
                btn.className = 'btn danger';
                btn.style.marginTop = '14px';
                btn.onclick = hideOverlay;
                status.parentElement.appendChild(btn);
            }
        }
    });
})();