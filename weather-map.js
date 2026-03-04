const WPC_ERO_LEGEND = {
    title: 'Excessive Rainfall Risk',
    entries: [
        { label: 'Marginal Risk (5%)', color: '#679966', dn: 1 },
        { label: 'Slight Risk (15%)', color: '#ffd24d', dn: 2 },
        { label: 'Moderate Risk (40%)', color: '#ff7f4d', dn: 3 },
        { label: 'High Risk (70%)', color: '#ff4d4d', dn: 4 }
    ]
};
const ZONE_GEOMETRY_FETCH_CONCURRENCY = 14;
const ZONE_GEOMETRY_MAX_PER_ALERT = 20;
// Fetch a single zone geometry with caching
async function fetchZoneGeometry(zoneUrl) {
    if (!zoneUrl) return null;
    if (zoneGeometryCache.has(zoneUrl)) return zoneGeometryCache.get(zoneUrl);
    if (zoneGeometryInflightCache.has(zoneUrl)) {
        try { return await zoneGeometryInflightCache.get(zoneUrl); } catch { return null; }
    }

    const requestPromise = (async () => {
        try {
            const r = await fetch(zoneUrl, { headers: { 'Accept': 'application/geo+json' } });
            if (!r.ok) throw new Error('HTTP ' + r.status);
            const j = await r.json();
            const geom = j && (j.geometry || (j.features && j.features[0] && j.features[0].geometry)) || null;
            zoneGeometryCache.set(zoneUrl, geom || null);
            return geom || null;
        } catch (e) {
            zoneGeometryCache.set(zoneUrl, null);
            return null;
        } finally {
            zoneGeometryInflightCache.delete(zoneUrl);
        }
    })();

    zoneGeometryInflightCache.set(zoneUrl, requestPromise);
    try {
        return await requestPromise;
    } catch {
        return null;
    }
}
function getStormReportBadgeCode(props = {}) {
    const t = String(props.typetext || props.type || '').toLowerCase();
    const code = String(props.type || '').toUpperCase();
    if (t.includes('tornado') || code === 'T') return 'T';
    if (t.includes('hail') || code === 'H') return 'H';
    if (t.includes('wind') || t.includes('tstm') || code === 'W' || code === 'G') return 'W';
    if (t.includes('snow') || code === 'S') return 'S';
    if (t.includes('damage') || code === 'D') return 'D';
    if (t.includes('flood') || code === 'F') return 'F';
    if (t.includes('rain') || t.includes('freez') || t.includes('ice') || code === 'R') return 'R';
    return 'R';
}

function getStormReportBadgeColor(props = {}) {
    const badge = getStormReportBadgeCode(props);
    return ({
        T: '#ef3340',
        H: '#00b84f',
        W: '#2e90ff',
        S: '#dbeafe',
        D: '#1f4eb6',
        F: '#0f5f36',
        R: '#06b6d4'
    })[badge] || '#60a5fa';
}

function buildCombinedClickItemsFromPoint(point) {
    if (!map || !point) return [];
    const layers = ['warnings-fill', 'warnings-points', STORM_REPORT_ICON_LAYER_ID, 'lsr-points']
        .filter((id) => { try { return !!map.getLayer(id); } catch { return false; } });
    if (!layers.length) return [];
    let raw = [];
    try { raw = map.queryRenderedFeatures(point, { layers }) || []; } catch { raw = []; }
    if (!raw.length) return [];
    const items = [];
    const seen = new Set();
    raw.forEach((ft) => {
        try {
            const layerId = String(ft?.layer?.id || '');
            const src = String(ft?.source || '');
            const isReport = layerId === STORM_REPORT_ICON_LAYER_ID || layerId === 'lsr-points' || src === 'lsr';
            if (isReport) {
                const p = ft.properties || {};
                const id = String(ft.id || `${p.valid || ''}-${p.typetext || ''}-${p.city || ''}-${p.state || ''}`);
                const key = `report:${id}`;
                if (seen.has(key)) return;
                seen.add(key);
                const title = String(p.typetext || p.type || 'Storm Report');
                const subtitle = [p.city, p.state].filter(Boolean).join(', ') || String(p.source || 'Report');
                items.push({
                    kind: 'report',
                    key,
                    feature: ft,
                    title,
                    subtitle,
                    color: getStormReportBadgeColor(p)
                });
                return;
            }
            const normalized = (weatherWarnings || []).find((w) => w && w.id === ft.id) || ft;
            const p = normalized.properties || {};
            const id = String(normalized.id || p.id || p.event || Math.random());
            const key = `warning:${id}`;
            if (seen.has(key)) return;
            seen.add(key);
            items.push({
                kind: 'warning',
                key,
                feature: normalized,
                title: String(p.event || 'Weather Warning'),
                subtitle: String(p.senderName || p.sender || p.aware || '').trim(),
                color: String(p._color || '#60a5fa')
            });
        } catch {}
    });
    return items;
}

function getTopOverlayInsertBeforeLayer() {
    const preferred = ['place-labels', 'state-labels', 'dark-labels', 'dark-labels-shadow'];
    for (const id of preferred) {
        try {
            if (map && map.getLayer(id)) return id;
        } catch {}
    }
    return undefined;
}

function getFrontOverlayMarkerLayers() {
    return [
        INFRA_LAYER_IDS?.hospitals,
        INFRA_LAYER_IDS?.shelters,
        INFRA_LAYER_IDS?.substations,
        INFRA_LAYER_IDS?.trailerParks,
        INFRA_LAYER_IDS?.camps,
        camerasLayerId,
        camerasLabelLayerId
    ].filter(Boolean);
}

function applyOverlayMarkerVisualBoost() {
    if (!map) return;
    const circleLayers = [
        INFRA_LAYER_IDS?.hospitals,
        INFRA_LAYER_IDS?.shelters,
        INFRA_LAYER_IDS?.substations,
        INFRA_LAYER_IDS?.trailerParks,
        INFRA_LAYER_IDS?.camps,
        camerasLayerId
    ].filter(Boolean);
    circleLayers.forEach((layerId) => {
        try {
            if (!map.getLayer(layerId)) return;
            map.setPaintProperty(layerId, 'circle-opacity', 1);
        } catch {}
    });
}

function keepWarningPolygonsBelowFrontMarkers() {
    if (!map) return;
    const firstFrontLayer = getFrontOverlayMarkerLayers().find((layerId) => {
        try { return !!map.getLayer(layerId); } catch { return false; }
    });
    if (!firstFrontLayer) return;
    ['warnings-fill', 'warnings-outline', 'warnings-points'].forEach((layerId) => {
        try {
            if (map.getLayer(layerId)) map.moveLayer(layerId, firstFrontLayer);
        } catch {}
    });
}

function getInfrastructureKindFromLayerId(layerId) {
    if (layerId === INFRA_LAYER_IDS?.hospitals) return 'hospital';
    if (layerId === INFRA_LAYER_IDS?.shelters) return 'shelter';
    if (layerId === INFRA_LAYER_IDS?.substations) return 'substation';
    if (layerId === INFRA_LAYER_IDS?.trailerParks) return 'trailer_park';
    if (layerId === INFRA_LAYER_IDS?.camps) return 'camp';
    return null;
}

function getFrontOverlayHit(point, paddingPx = 10) {
    if (!map || !point) return null;
    const layers = getFrontOverlayMarkerLayers().filter((id) => {
        try { return !!map.getLayer(id); } catch { return false; }
    });
    if (!layers.length) return null;
    const p = Number(paddingPx) || 0;
    const bbox = [
        [point.x - p, point.y - p],
        [point.x + p, point.y + p]
    ];
    let hits = [];
    try {
        hits = map.queryRenderedFeatures(bbox, { layers }) || [];
    } catch {
        hits = [];
    }
    if (!hits.length) return null;

    const sortPriority = (layerId) => {
        if (layerId === camerasLayerId || layerId === camerasLabelLayerId) return 0;
        return 1;
    };
    hits.sort((a, b) => {
        const la = String(a?.layer?.id || '');
        const lb = String(b?.layer?.id || '');
        const pa = sortPriority(la);
        const pb = sortPriority(lb);
        if (pa !== pb) return pa - pb;
        return 0;
    });
    return hits[0] || null;
}

function openFrontOverlayHit(hit, lngLat) {
    if (!hit) return false;
    const layerId = String(hit?.layer?.id || '');
    if (!layerId) return false;

    if (layerId === camerasLayerId || layerId === camerasLabelLayerId) {
        showCameraPopup(hit, {
            lngLat: lngLat || null,
            nearestWarningLabel: '',
            distanceKm: null
        });
        return true;
    }

    const infraKind = getInfrastructureKindFromLayerId(layerId);
    if (infraKind) {
        showInfrastructurePopup(
            {
                features: [hit],
                lngLat: lngLat || null
            },
            infraKind
        );
        return true;
    }

    return false;
}

function handleFrontOverlayClickPriority(event) {
    if (!event?.point) return false;
    const hit = getFrontOverlayHit(event.point, 10);
    if (!hit) return false;
    const opened = openFrontOverlayHit(hit, event.lngLat || null);
    if (!opened) return false;
    const stamp = event?.originalEvent?.timeStamp;
    if (stamp) map.__lastCompositeClickStamp = stamp;
    return true;
}

function bringCameraAndInfrastructureLayersToFront() {
    if (!map) return;
    const beforeLayer = getTopOverlayInsertBeforeLayer();
    const orderedLayers = getFrontOverlayMarkerLayers();
    orderedLayers.forEach((layerId) => {
        try {
            if (!map.getLayer(layerId)) return;
            if (beforeLayer && layerId !== beforeLayer) {
                map.moveLayer(layerId, beforeLayer);
            } else {
                map.moveLayer(layerId);
            }
        } catch {}
    });
    applyOverlayMarkerVisualBoost();
    keepWarningPolygonsBelowFrontMarkers();
}

function clickHitsCameraOrInfrastructure(point) {
    return !!getFrontOverlayHit(point, 10);
}

function openCombinedClickItem(item, coordinates) {
    if (!item || !item.feature) return;
    if (item.kind === 'report') {
        showStormReportDetailsFromFeature(item.feature, coordinates);
        return;
    }
    showWarningDetails(item.feature, coordinates);
}

function showOverlappingMenu(items, coordinates) {
    if (!Array.isArray(items) || items.length === 0) return;
    try { if (currentWarningPopup) { currentWarningPopup.remove(); currentWarningPopup = null; } } catch {}

    const entries = items.map((item, idx) => {
        const typeLabel = item.kind === 'report' ? 'Report' : 'Warning';
        const title = String(item.title || (item.kind === 'report' ? 'Storm Report' : 'Weather Warning'));
        const subtitle = String(item.subtitle || '').trim();
        return `
            <button class="popup-list-item ov-item ov-result-item" data-idx="${idx}">
                <span class="popup-dot" style="background:${item.color || '#60a5fa'};"></span>
                <span class="ov-result-text">
                    <span class="ov-result-type">${typeLabel}</span>
                    <span class="ov-result-title">${title}</span>
                    ${subtitle ? `<span class="ov-result-subtitle">${subtitle}</span>` : ''}
                </span>
            </button>`;
    }).join('');

    const html = `
        <div class="popup-card ov-results-card">
            <div class="popup-header">
                <span class="popup-title">MULTIPLE RESULTS</span>
            </div>
            <div class="popup-section">
                <div class="popup-list">${entries}</div>
            </div>
        </div>`;

    const popup = new maplibregl.Popup({ closeButton: true, closeOnClick: true, maxWidth: '360px', className: 'warning-popup storm-popup popup-theme' })
        .setLngLat(coordinates)
        .setHTML(html)
        .addTo(map);
    currentWarningPopup = popup;

    const container = popup.getElement();
    try {
        container.querySelectorAll('.ov-item').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                const idx = Number.parseInt(btn.getAttribute('data-idx'), 10);
                const sel = items[idx];
                try { if (currentWarningPopup) { currentWarningPopup.remove(); currentWarningPopup = null; } } catch {}
                openCombinedClickItem(sel, coordinates);
            });
        });
    } catch {}
}

// Ensure Hi-Res radar raster (NOWCoast) exists
function ensureHiResRadarLayer() {
    if (!map) return;
    try {
        if (!map.getSource(hresRadarSourceId)) {
            // Choose provider (default RainViewer). Allow override via localStorage.
            let provider = 'rainviewer';
            try { provider = localStorage.getItem('hresRadarProvider') || 'rainviewer'; } catch {}
            const tiles = provider === 'nowcoast' ? NOWCOAST_RADAR_TILES : RAINVIEWER_RADAR_TILES;
            map.addSource(hresRadarSourceId, {
                type: 'raster',
                tiles: [tiles],
                tileSize: 256,
                attribution: provider === 'nowcoast' ? ' © NOAA/NOWCoast' : ' © RainViewer'
            });
        }
        if (!map.getLayer(hresRadarLayerId)) {
            map.addLayer({
                id: hresRadarLayerId,
                type: 'raster',
                source: hresRadarSourceId,
                paint: {
                    // WeatherWise-like clarity
                    'raster-opacity': 0.92,
                    'raster-resampling': 'linear',
                    'raster-contrast': 0.08,
                    'raster-brightness-min': 0.9,
                    'raster-brightness-max': 1.05
                },
                layout: { 'visibility': 'none' }
            }, 'water-fill');
        }
        // Keep warning fills above radar
        try { if (map.getLayer('warnings-fill')) map.moveLayer('warnings-fill'); } catch {}
        try { if (map.getLayer('warnings-outline')) map.moveLayer('warnings-outline'); } catch {}
        bringCameraAndInfrastructureLayersToFront();
    } catch (e) {
        console.warn('ensureHiResRadarLayer error:', e);
    }
}

function toggleHiResRadarLayer() {
    if (!map) return false;
    ensureHiResRadarLayer();
    try {
        const vis = map.getLayoutProperty(hresRadarLayerId, 'visibility');
        const next = vis === 'none' ? 'visible' : 'none';
        map.setLayoutProperty(hresRadarLayerId, 'visibility', next);
        const on = (next === 'visible');
        // Hide the standard radar layer when hi-res is on
        try { if (map.getLayer('radar-layer')) map.setLayoutProperty('radar-layer', 'visibility', on ? 'none' : 'visible'); } catch {}
        console.log('[RADAR] hi-res ->', on);
        return on;
    } catch (e) {
        console.warn('toggleHiResRadarLayer error:', e);
        return false;
    }
}

// Fetch and add Radar Sites (NEXRAD) as points with labels
async function ensureRadarSitesLayer() {
    if (!map) return false;
    try {
        if (!map.getSource(radarSitesSourceId)) {
            // Try NWS API first; expected to return GeoJSON FeatureCollection of radar stations
            const candidates = [
                'https://api.weather.gov/radar/stations',
                // fallback to general stations filtered client-side (will show many sites if used)
                'https://api.weather.gov/stations'
            ];
            let data = null;
            for (const url of candidates) {
                try {
                    const r = await fetch(url, { headers: { 'Accept': 'application/geo+json' } });
                    if (r.ok) {
                        const j = await r.json();
                        if (j && j.type === 'FeatureCollection') { data = j; break; }
                    }
                } catch {}
            }
            if (!data) {
                console.warn('Radar sites fetch failed');
                return false;
            }
            // If using general stations, filter to ones likely radar by station identifier pattern (Kxxx) and has elevation/uniquemetadata
            try {
                if (data.features && candidates[1] && data.features.length > 0 && data.features[0].properties && !data.features[0].properties.radar) {
                    data.features = data.features.filter(f => {
                        const id = (f.properties && (f.properties.stationIdentifier || f.properties.id || '')) + '';
                        return /^K[A-Z0-9]{3}$/i.test(id);
                    });
                }
            } catch {}
            map.addSource(radarSitesSourceId, { type: 'geojson', data });
        }
        if (!map.getLayer(radarSitesLayerId)) {
            map.addLayer({
                id: radarSitesLayerId,
                type: 'circle',
                source: radarSitesSourceId,
                layout: { 'visibility': 'none' },
                paint: {
                    'circle-radius': [
                        'interpolate', ['linear'], ['zoom'],
                        3, 2,
                        6, 3,
                        9, 4,
                        12, 5
                    ],
                    'circle-color': '#00e0ff',
                    'circle-stroke-color': '#000',
                    'circle-stroke-width': 1.5,
                    'circle-opacity': 0.95
                }
            });
        }
        if (!map.getLayer(radarSitesLabelLayerId)) {
            map.addLayer({
                id: radarSitesLabelLayerId,
                type: 'symbol',
                source: radarSitesSourceId,
                layout: {
                    'visibility': 'none',
                    'text-field': [
                        'coalesce',
                        ['get', 'stationIdentifier'],
                        ['get', 'id'],
                        ['get', 'name']
                    ],
                    'text-font': ['Noto Sans Bold','Noto Sans Regular'],
                    'text-size': [
                        'interpolate', ['linear'], ['zoom'],
                        5, 10,
                        8, 12,
                        11, 14
                    ],
                    'text-offset': [0, 1.0],
                    'text-anchor': 'top'
                },
                paint: {
                    'text-color': '#ffffff',
                    'text-halo-color': '#000000',
                    'text-halo-width': 1.5
                }
            });
        }
        return true;
    } catch (e) {
        console.warn('ensureRadarSitesLayer error:', e);
        return false;
    }
}

async function toggleRadarSitesLayer() {
    const ok = await ensureRadarSitesLayer();
    if (!ok) return false;
    try {
        const cur = map.getLayoutProperty(radarSitesLayerId, 'visibility') || 'none';
        const next = cur === 'none' ? 'visible' : 'none';
        map.setLayoutProperty(radarSitesLayerId, 'visibility', next);
        map.setLayoutProperty(radarSitesLabelLayerId, 'visibility', next);
        const on = next === 'visible';
        console.log('[RADAR] sites ->', on);
        return on;
    } catch (e) {
        console.warn('toggleRadarSitesLayer error:', e);
        return false;
    }
}

function emptyCameraFeatureCollection() {
    return { type: 'FeatureCollection', features: [] };
}

function getCameraCycleToggleButton() {
    return document.getElementById('map-camera-cycle-btn') || document.getElementById('camera-cycle-toggle');
}

function getCameraCycleSettingsButton() {
    return document.getElementById('map-camera-settings-btn') || document.getElementById('camera-settings-toggle');
}

function getCameraCycleMenuElement() {
    return document.getElementById('camera-cycle-menu');
}

function loadCameraCycleSettings() {
    try {
        const raw = localStorage.getItem(CAMERA_CYCLE_SETTINGS_KEY);
        if (!raw) return;
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return;
        cameraCycleSettings = {
            intervalMs: Math.max(4000, Math.min(20000, Number(parsed.intervalMs) || DEFAULT_CAMERA_CYCLE_SETTINGS.intervalMs)),
            maxDistanceKm: Math.max(50, Math.min(350, Number(parsed.maxDistanceKm) || DEFAULT_CAMERA_CYCLE_SETTINGS.maxDistanceKm)),
            maxQueueSize: Math.max(6, Math.min(40, Number(parsed.maxQueueSize) || DEFAULT_CAMERA_CYCLE_SETTINGS.maxQueueSize)),
            perWarning: Math.max(1, Math.min(6, Number(parsed.perWarning) || DEFAULT_CAMERA_CYCLE_SETTINGS.perWarning))
        };
        cameraAutoCycleState.intervalMs = cameraCycleSettings.intervalMs;
    } catch {}
}

function saveCameraCycleSettings() {
    try {
        localStorage.setItem(CAMERA_CYCLE_SETTINGS_KEY, JSON.stringify(cameraCycleSettings));
    } catch {}
}

function syncCameraCycleMenuControls() {
    const intervalSelect = document.getElementById('camera-cycle-interval');
    const distanceSelect = document.getElementById('camera-cycle-distance');
    const maxCamsSelect = document.getElementById('camera-cycle-maxcams');
    if (intervalSelect) intervalSelect.value = String(cameraCycleSettings.intervalMs);
    if (distanceSelect) distanceSelect.value = String(cameraCycleSettings.maxDistanceKm);
    if (maxCamsSelect) maxCamsSelect.value = String(cameraCycleSettings.maxQueueSize);
}

function applyCameraCycleSettingsFromMenu({ persist = true } = {}) {
    const intervalSelect = document.getElementById('camera-cycle-interval');
    const distanceSelect = document.getElementById('camera-cycle-distance');
    const maxCamsSelect = document.getElementById('camera-cycle-maxcams');
    const intervalMs = Math.max(4000, Math.min(20000, Number(intervalSelect?.value) || DEFAULT_CAMERA_CYCLE_SETTINGS.intervalMs));
    const maxDistanceKm = Math.max(50, Math.min(350, Number(distanceSelect?.value) || DEFAULT_CAMERA_CYCLE_SETTINGS.maxDistanceKm));
    const maxQueueSize = Math.max(6, Math.min(40, Number(maxCamsSelect?.value) || DEFAULT_CAMERA_CYCLE_SETTINGS.maxQueueSize));
    cameraCycleSettings = {
        ...cameraCycleSettings,
        intervalMs,
        maxDistanceKm,
        maxQueueSize,
        perWarning: Math.max(1, Math.min(6, cameraCycleSettings.perWarning || DEFAULT_CAMERA_CYCLE_SETTINGS.perWarning))
    };
    cameraAutoCycleState.intervalMs = cameraCycleSettings.intervalMs;
    if (persist) saveCameraCycleSettings();
    try {
        if (cameraAutoCycleState.active) {
            cameraAutoCycleState.lastQueueBuiltAt = 0;
        }
    } catch {}
}

function toggleCameraCycleMenuHeader(event) {
    try {
        event && event.preventDefault && event.preventDefault();
        event && event.stopPropagation && event.stopPropagation();
    } catch {}
    const menu = getCameraCycleMenuElement();
    if (!menu) return false;
    const isOpen = !menu.hasAttribute('hidden');
    if (isOpen) {
        menu.setAttribute('hidden', '');
    } else {
        syncCameraCycleMenuControls();
        menu.removeAttribute('hidden');
    }
    return !isOpen;
}

function ensureCameraCycleMenuStyle() {
    if (document.getElementById('camera-cycle-menu-style')) return;
    const style = document.createElement('style');
    style.id = 'camera-cycle-menu-style';
    style.textContent = `
        .camera-cycle-control-wrapper {
            position: relative;
            display: inline-flex;
            align-items: center;
            gap: 0.32rem;
        }
        .map-camera-settings-btn {
            min-width: 2.05rem;
            padding-left: 0.58rem;
            padding-right: 0.58rem;
        }
        .camera-cycle-menu {
            position: absolute;
            top: calc(100% + 6px);
            right: 0;
            min-width: 220px;
            padding: 10px;
            display: flex;
            flex-direction: column;
            gap: 7px;
            background: rgba(6, 12, 23, 0.97);
            border: 1px solid rgba(92, 138, 196, 0.32);
            border-radius: 12px;
            box-shadow: 0 14px 26px rgba(0, 0, 0, 0.44);
            z-index: 12070;
        }
        .camera-cycle-menu-title {
            font-size: 0.74rem;
            font-weight: 700;
            letter-spacing: 0.08em;
            text-transform: uppercase;
            color: rgba(213, 233, 255, 0.95);
            padding-bottom: 4px;
            border-bottom: 1px solid rgba(120, 161, 204, 0.24);
        }
        .camera-cycle-menu-row {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 8px;
            font-size: 0.73rem;
            letter-spacing: 0.05em;
            text-transform: uppercase;
            color: rgba(216, 233, 252, 0.88);
        }
        .camera-cycle-menu-row select {
            background: rgba(8, 17, 33, 0.95);
            border: 1px solid rgba(96, 143, 196, 0.34);
            color: #e3f2ff;
            border-radius: 7px;
            padding: 4px 7px;
            font-size: 0.73rem;
            font-weight: 700;
            letter-spacing: 0.04em;
            min-width: 78px;
        }
        #camera-cycle-refresh-btn {
            border-radius: 8px;
            border: 1px solid rgba(112, 167, 222, 0.4);
            background: rgba(16, 33, 58, 0.94);
            color: #d9efff;
            font-size: 0.73rem;
            text-transform: uppercase;
            letter-spacing: 0.08em;
            font-weight: 700;
            padding: 6px 7px;
            cursor: pointer;
        }
        #camera-cycle-refresh-btn:hover {
            background: rgba(20, 43, 76, 0.98);
            border-color: rgba(133, 198, 255, 0.62);
        }
    `;
    document.head.appendChild(style);
}

function getCameraQueryBounds() {
    if (!map || typeof map.getBounds !== 'function') return null;
    try {
        const b = map.getBounds();
        let west = Number(b.getWest());
        let south = Number(b.getSouth());
        let east = Number(b.getEast());
        let north = Number(b.getNorth());
        if (![west, south, east, north].every(Number.isFinite)) return null;
        if (east < west) {
            west = -180;
            east = 180;
        }
        const lonPad = Math.max(0.2, (east - west) * 0.1);
        const latPad = Math.max(0.16, (north - south) * 0.1);
        let out = {
            west: Math.max(-180, west - lonPad),
            south: Math.max(-85, south - latPad),
            east: Math.min(180, east + lonPad),
            north: Math.min(85, north + latPad)
        };
        const lonSpan = out.east - out.west;
        const latSpan = out.north - out.south;
        const maxLonSpan = 6.5;
        const maxLatSpan = 5.2;
        if (lonSpan > maxLonSpan || latSpan > maxLatSpan) {
            const centerLon = (out.west + out.east) / 2;
            const centerLat = (out.south + out.north) / 2;
            out = {
                west: Math.max(-180, centerLon - (maxLonSpan / 2)),
                east: Math.min(180, centerLon + (maxLonSpan / 2)),
                south: Math.max(-85, centerLat - (maxLatSpan / 2)),
                north: Math.min(85, centerLat + (maxLatSpan / 2))
            };
        }
        return out;
    } catch {
        return null;
    }
}

function getCameraBoundsKey(bounds) {
    if (!bounds) return '';
    const zoom = map && typeof map.getZoom === 'function' ? map.getZoom() : 4;
    const precision = zoom >= 9 ? 2 : 1;
    return [
        bounds.west.toFixed(precision),
        bounds.south.toFixed(precision),
        bounds.east.toFixed(precision),
        bounds.north.toFixed(precision)
    ].join('|');
}

function shouldUseLocalCameraProxy() {
    try {
        if (typeof window === 'undefined' || !window.location) return false;
        const proto = String(window.location.protocol || '').toLowerCase();
        const host = String(window.location.hostname || '').toLowerCase();
        if (proto !== 'http:' && proto !== 'https:') return false;
        return host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0';
    } catch {
        return false;
    }
}

function buildLocalCameraProxyUrl(pathname, params = null) {
    try {
        if (typeof window === 'undefined' || !window.location) return pathname;
        const url = new URL(pathname, window.location.origin);
        if (params && typeof params === 'object') {
            Object.entries(params).forEach(([k, v]) => {
                if (v == null || v === '') return;
                url.searchParams.set(k, String(v));
            });
        }
        return url.toString();
    } catch {
        return pathname;
    }
}

function escapeCameraHtml(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function sanitizeHttpUrl(url) {
    try {
        const text = String(url || '').trim();
        if (!text) return '';
        const parsed = new URL(text);
        const protocol = String(parsed.protocol || '').toLowerCase();
        if (protocol !== 'http:' && protocol !== 'https:') return '';
        return parsed.toString();
    } catch {
        return '';
    }
}

function buildCameraOperatorTag(operator, sourceType) {
    const raw = String(operator || sourceType || '').trim();
    if (!raw) return 'DOT';
    const upper = raw.toUpperCase().replace(/\s+/g, ' ').trim();
    const compact = upper.replace(/[^A-Z0-9]/g, '');

    const explicit = upper.match(/\b([A-Z]{2,5}DOT)\b/);
    if (explicit && explicit[1]) return explicit[1];

    const stateShort = compact.match(/([A-Z]{2})DOT/);
    if (stateShort && stateShort[1]) return `${stateShort[1]}DOT`;

    if (/DEPARTMENT OF TRANSPORTATION|TRANSPORTATION/.test(upper)) {
        const words = upper
            .replace(/\b(DEPARTMENT|OF|TRANSPORTATION|STATE|THE)\b/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .split(' ')
            .filter(Boolean);
        if (words.length >= 1) {
            const prefix = words.slice(0, 3).map((w) => w[0]).join('');
            if (prefix.length >= 2) return `${prefix}DOT`;
        }
        return 'DOT';
    }

    if (compact.includes('DOT')) return 'DOT';
    return 'DOT';
}

function extractCameraNumber(name) {
    const raw = String(name || '').trim();
    if (!raw) return '';
    const cameraNum = raw.match(/(?:CAM(?:ERA)?|CCTV|ID|#)?\s*([A-Z]?\d{1,6}[A-Z]?)/i);
    return cameraNum && cameraNum[1] ? String(cameraNum[1]).toUpperCase() : '';
}

function buildCameraTinyLabel(name, operator, sourceType) {
    const dotName = buildCameraOperatorTag(operator, sourceType);
    const num = extractCameraNumber(name);
    return num ? `${dotName} CAM ${num}` : `${dotName} CAM`;
}

function getCameraSiteHost(url) {
    try {
        if (!url) return '';
        return new URL(url).host.replace(/^www\./i, '');
    } catch {
        return '';
    }
}

function hideCameraTopLeftPanel() {
    try {
        const panel = document.getElementById('snow-report-panel');
        if (!panel) return;
        panel.classList.remove('visible');
        panel.innerHTML = '';
    } catch {}
}

function renderCameraTopLeftPanel({
    title = 'TRAFFIC CAMERA',
    subtitle = '',
    tierText = 'CAM',
    website = '',
    image = '',
    warningText = '--',
    distanceText = '--',
    cycleText = '--'
} = {}) {
    const panel = document.getElementById('snow-report-panel');
    if (!panel) return;
    const safeWebsite = sanitizeHttpUrl(website || '');
    const safeImage = sanitizeHttpUrl(image || '');
    const safeHost = getCameraSiteHost(safeWebsite);

    let mediaHtml = '<div class="camera-top-media-empty">NO LIVE PREVIEW AVAILABLE</div>';
    if (safeImage) {
        mediaHtml = `<img class="camera-top-media-img" src="${escapeCameraHtml(safeImage)}" alt="Camera view" loading="lazy" referrerpolicy="no-referrer">`;
    } else if (safeWebsite) {
        mediaHtml = `
            <iframe class="camera-top-media-frame" src="${escapeCameraHtml(safeWebsite)}" title="Camera website preview" loading="lazy" referrerpolicy="strict-origin-when-cross-origin"></iframe>
            <div class="camera-top-media-note">If blocked, open the camera link below.</div>
        `;
    }

    panel.innerHTML = `
        <div class="camera-top-card">
            <button class="camera-top-close" type="button" aria-label="Close camera panel">&times;</button>
            <div class="camera-top-title">${escapeCameraHtml(String(title || 'TRAFFIC CAMERA').toUpperCase())}</div>
            <div class="camera-top-subtitle">${escapeCameraHtml((subtitle || '--').toUpperCase())}</div>
            <div class="camera-top-line"><span></span></div>
            <div class="camera-top-badges">
                <span class="camera-top-chip">${escapeCameraHtml(tierText || 'CAM')}</span>
                <span class="camera-top-chip">${escapeCameraHtml(`WARNING: ${warningText || '--'}`)}</span>
                <span class="camera-top-chip">${escapeCameraHtml(`DIST: ${distanceText || '--'}`)}</span>
                <span class="camera-top-chip">${escapeCameraHtml(`QUEUE: ${cycleText || '--'}`)}</span>
            </div>
            <div class="camera-top-media">${mediaHtml}</div>
            <div class="camera-top-foot">
                <div class="camera-top-source">${escapeCameraHtml(safeHost || 'NO CAMERA URL')}</div>
                ${safeWebsite ? `<a class="camera-top-link" href="${escapeCameraHtml(safeWebsite)}" target="_blank" rel="noopener noreferrer">OPEN CAMERA</a>` : ''}
            </div>
        </div>
    `;
    panel.classList.add('visible');
    panel.querySelector('.camera-top-close')?.addEventListener('click', hideCameraTopLeftPanel);
}

function getFeatureCoordinates(feature) {
    try {
        const g = feature?.geometry;
        if (!g) return null;
        if (g.type === 'Point' && Array.isArray(g.coordinates)) {
            const lon = Number(g.coordinates[0]);
            const lat = Number(g.coordinates[1]);
            if (Number.isFinite(lon) && Number.isFinite(lat)) return { lon, lat };
            return null;
        }
        const c = geometryCentroid(g);
        if (c && Number.isFinite(c.lng) && Number.isFinite(c.lat)) return { lon: c.lng, lat: c.lat };
        return null;
    } catch {
        return null;
    }
}

function haversineKm(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const toRad = (d) => d * Math.PI / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2)
        + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2))
        * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function scoreWarningForCameraCycle(eventName) {
    const txt = String(eventName || '').toUpperCase();
    if (txt.includes('TORNADO EMERGENCY')) return 120;
    if (txt.includes('TORNADO WARNING')) return 110;
    if (txt.includes('SEVERE THUNDERSTORM WARNING')) return 90;
    if (txt.includes('FLASH FLOOD WARNING')) return 80;
    if (txt.includes('FLOOD WARNING')) return 72;
    if (txt.includes('HURRICANE WARNING')) return 95;
    if (txt.includes('BLIZZARD WARNING') || txt.includes('WINTER STORM WARNING')) return 70;
    if (txt.includes('SPECIAL WEATHER STATEMENT')) return 45;
    return 50;
}

function extractActiveWarningCentersForCycle() {
    const now = Date.now();
    const centers = [];
    (weatherWarnings || []).forEach((warning) => {
        try {
            if (!warning || !warning.geometry) return;
            const p = warning.properties || {};
            const expires = Date.parse(p.expires || '');
            if (Number.isFinite(expires) && expires < now) return;
            const c = geometryCentroid(warning.geometry);
            if (!c || !Number.isFinite(c.lng) || !Number.isFinite(c.lat)) return;
            centers.push({
                id: warning.id || p.id || `${p.event || 'warning'}-${Math.random().toString(36).slice(2, 7)}`,
                lng: c.lng,
                lat: c.lat,
                event: String(p.event || 'Weather Warning'),
                severityScore: scoreWarningForCameraCycle(p.event),
                warning
            });
        } catch {}
    });
    centers.sort((a, b) => b.severityScore - a.severityScore);
    if (centers.length > 80) centers.length = 80;
    return centers;
}

function buildTrafficCameraBboxesForWarnings(maxCount = 8) {
    const centers = extractActiveWarningCentersForCycle().slice(0, maxCount);
    return centers.map((w) => ({
        west: Math.max(-180, w.lng - 1.35),
        south: Math.max(-85, w.lat - 1.0),
        east: Math.min(180, w.lng + 1.35),
        north: Math.min(85, w.lat + 1.0)
    }));
}

function buildTrafficCamerasOverpassQuery(boundsList) {
    const clauses = [];
    (boundsList || []).forEach((bounds) => {
        if (!bounds) return;
        const south = Number(bounds.south).toFixed(4);
        const west = Number(bounds.west).toFixed(4);
        const north = Number(bounds.north).toFixed(4);
        const east = Number(bounds.east).toFixed(4);
        const bbox = `(${south},${west},${north},${east})`;
        clauses.push(`node["man_made"="surveillance"]["operator"~"DOT|Department of Transportation|Transportation",i]${bbox};`);
        clauses.push(`way["man_made"="surveillance"]["operator"~"DOT|Department of Transportation|Transportation",i]${bbox};`);
        clauses.push(`relation["man_made"="surveillance"]["operator"~"DOT|Department of Transportation|Transportation",i]${bbox};`);
        clauses.push(`node["surveillance"="traffic"]["operator"~"DOT|Department of Transportation|Transportation",i]${bbox};`);
        clauses.push(`way["surveillance"="traffic"]["operator"~"DOT|Department of Transportation|Transportation",i]${bbox};`);
        clauses.push(`relation["surveillance"="traffic"]["operator"~"DOT|Department of Transportation|Transportation",i]${bbox};`);
        clauses.push(`node["camera:type"~"traffic|street",i]["operator"~"DOT|Department of Transportation|Transportation",i]${bbox};`);
        clauses.push(`way["camera:type"~"traffic|street",i]["operator"~"DOT|Department of Transportation|Transportation",i]${bbox};`);
        clauses.push(`relation["camera:type"~"traffic|street",i]["operator"~"DOT|Department of Transportation|Transportation",i]${bbox};`);
        clauses.push(`node["man_made"="surveillance"]["network"~"DOT|Department of Transportation|Transportation",i]${bbox};`);
        clauses.push(`way["man_made"="surveillance"]["network"~"DOT|Department of Transportation|Transportation",i]${bbox};`);
        clauses.push(`relation["man_made"="surveillance"]["network"~"DOT|Department of Transportation|Transportation",i]${bbox};`);
    });
    if (!clauses.length) return '';
    return `
[out:json][timeout:25];
(
  ${clauses.join('\n  ')}
);
out tags center;
    `.trim();
}

async function fetchRadarStationsAsCameraFallback(bounds) {
    try {
        const response = await fetch('https://api.weather.gov/radar/stations', {
            headers: { 'Accept': 'application/geo+json' }
        });
        if (!response.ok) throw new Error(`Radar stations ${response.status}`);
        const payload = await response.json();
        const featuresIn = Array.isArray(payload?.features) ? payload.features : [];
        const out = [];
        featuresIn.forEach((f, idx) => {
            const lon = Number(f?.geometry?.coordinates?.[0]);
            const lat = Number(f?.geometry?.coordinates?.[1]);
            if (!Number.isFinite(lon) || !Number.isFinite(lat)) return;
            if (bounds) {
                if (lon < bounds.west || lon > bounds.east || lat < bounds.south || lat > bounds.north) return;
            }
            const p = f.properties || {};
            out.push({
                type: 'Feature',
                id: `radarcam-${p.stationIdentifier || idx}`,
                geometry: { type: 'Point', coordinates: [lon, lat] },
                properties: {
                    name: p.name || p.stationIdentifier || 'Radar Site',
                    operator: p.stationIdentifier || 'NWS',
                    sourceType: 'NWS Radar Site',
                    cameraType: 'Radar',
                    website: '',
                    image: '',
                    tier: 1,
                    tinyLabel: buildCameraTinyLabel(
                        p.name || p.stationIdentifier || 'Radar Site',
                        p.stationIdentifier || 'NWS',
                        'NWS Radar Site'
                    ),
                    source: 'NWS Radar Stations'
                }
            });
        });
        if (out.length > 500) out.length = 500;
        return { type: 'FeatureCollection', features: out };
    } catch (error) {
        console.warn('fetchRadarStationsAsCameraFallback failed', error);
        return emptyCameraFeatureCollection();
    }
}

async function fetchMoDotCamerasGeoJSON(bounds = null) {
    try {
        const hasBounds =
            bounds &&
            Number.isFinite(Number(bounds.west)) &&
            Number.isFinite(Number(bounds.south)) &&
            Number.isFinite(Number(bounds.east)) &&
            Number.isFinite(Number(bounds.north));

        const proxyPreferred = shouldUseLocalCameraProxy();
        const requestUrls = [];
        if (proxyPreferred) {
            requestUrls.push(buildLocalCameraProxyUrl('/proxy/modot', hasBounds ? {
                west: Number(bounds.west),
                south: Number(bounds.south),
                east: Number(bounds.east),
                north: Number(bounds.north)
            } : null));
        }

        const params = new URLSearchParams({
            where: '1=1',
            outFields: 'CAM_ID,DESCRIPTION,URL1,URL2,REFR_RATE_MS,STREAM_ERROR',
            returnGeometry: 'true',
            outSR: '4326',
            f: 'geojson'
        });
        if (hasBounds) {
            params.set('geometry', `${Number(bounds.west)},${Number(bounds.south)},${Number(bounds.east)},${Number(bounds.north)}`);
            params.set('geometryType', 'esriGeometryEnvelope');
            params.set('inSR', '4326');
            params.set('spatialRel', 'esriSpatialRelIntersects');
        }
        requestUrls.push(`https://mapping.modot.mo.gov/arcgis/rest/services/TravelerInformation/NWSDATA/MapServer/0/query?${params.toString()}`);

        let payload = null;
        let lastError = null;
        for (const url of requestUrls) {
            try {
                const response = await fetch(url, { headers: { 'Accept': 'application/geo+json, application/json' } });
                if (!response.ok) {
                    lastError = new Error(`MoDOT cameras query failed (${response.status})`);
                    continue;
                }
                payload = await response.json();
                break;
            } catch (error) {
                lastError = error;
            }
        }
        if (!payload) throw (lastError || new Error('MoDOT cameras query failed'));

        const incoming = Array.isArray(payload?.features) ? payload.features : [];
        const features = [];
        const seen = new Set();

        incoming.forEach((f) => {
            const lon = Number(f?.geometry?.coordinates?.[0]);
            const lat = Number(f?.geometry?.coordinates?.[1]);
            if (!Number.isFinite(lon) || !Number.isFinite(lat)) return;
            const p = f?.properties || {};
            const camId = p.CAM_ID != null ? String(p.CAM_ID).trim() : '';
            const website = String(p.URL2 || p.URL1 || '').trim();
            const name = String(p.DESCRIPTION || '').trim() || (camId ? `Camera ${camId}` : 'MoDOT Camera');
            const dedupe = `${lat.toFixed(5)}|${lon.toFixed(5)}|${camId || name.toLowerCase()}`;
            if (seen.has(dedupe)) return;
            seen.add(dedupe);

            features.push({
                type: 'Feature',
                id: `modot-${camId || `${lat.toFixed(4)}-${lon.toFixed(4)}`}`,
                geometry: { type: 'Point', coordinates: [lon, lat] },
                properties: {
                    name,
                    operator: 'MoDOT',
                    sourceType: 'MO DOT Camera',
                    cameraType: 'traffic',
                    website,
                    image: '',
                    tier: 2,
                    tinyLabel: camId ? `MODOT CAM ${camId}` : buildCameraTinyLabel(name, 'MoDOT', 'MO DOT Camera'),
                    source: 'MoDOT Traveler Information'
                }
            });
        });

        if (features.length > 2500) features.length = 2500;
        return { type: 'FeatureCollection', features };
    } catch (error) {
        console.warn('fetchMoDotCamerasGeoJSON failed', error);
        return emptyCameraFeatureCollection();
    }
}

async function fetchTrafficCamerasOverpass(boundsOrList) {
    const list = Array.isArray(boundsOrList) ? boundsOrList : [boundsOrList];
    const clean = list.filter(Boolean).slice(0, 10);
    if (!clean.length) return emptyCameraFeatureCollection();
    const query = buildTrafficCamerasOverpassQuery(clean);
    if (!query) return emptyCameraFeatureCollection();

    try {
        const proxyPreferred = shouldUseLocalCameraProxy();
        const endpoints = proxyPreferred
            ? [buildLocalCameraProxyUrl('/proxy/overpass'), 'https://overpass-api.de/api/interpreter']
            : ['https://overpass-api.de/api/interpreter'];

        let payload = null;
        let lastError = null;
        for (const endpoint of endpoints) {
            try {
                const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
                let timeoutId = null;
                if (controller) {
                    timeoutId = setTimeout(() => {
                        try { controller.abort(); } catch {}
                    }, 22000);
                }
                const response = await fetch(endpoint, {
                    method: 'POST',
                    headers: {
                        'Accept': 'application/json',
                        'Content-Type': 'text/plain; charset=UTF-8'
                    },
                    body: query,
                    signal: controller ? controller.signal : undefined
                });
                if (timeoutId) clearTimeout(timeoutId);
                if (!response.ok) {
                    lastError = new Error(`Overpass camera query failed (${response.status})`);
                    continue;
                }
                payload = await response.json();
                break;
            } catch (error) {
                lastError = error;
            }
        }
        if (!payload) throw (lastError || new Error('Overpass camera query failed'));

        const elements = Array.isArray(payload?.elements) ? payload.elements : [];
        if (!elements.length) return emptyCameraFeatureCollection();

        const features = [];
        const seen = new Set();
        elements.forEach((el, idx) => {
            const lon = Number(el?.lon ?? el?.center?.lon);
            const lat = Number(el?.lat ?? el?.center?.lat);
            if (!Number.isFinite(lon) || !Number.isFinite(lat)) return;
            const tags = (el?.tags && typeof el.tags === 'object') ? el.tags : {};
            const name = String(tags.name || '').trim();
            const operator = String(tags.operator || tags.network || tags.owner || '').trim();
            const cameraType = String(tags['camera:type'] || tags.surveillance || tags.highway || '').trim();
            const descriptor = `${name} ${operator} ${cameraType}`.toUpperCase();
            const isDot = /\bDOT\b|DEPARTMENT OF TRANSPORTATION|TRANSPORTATION/i.test(descriptor);
            if (!isDot) return;
            const tier = 2;
            const sourceName = 'DOT Camera';
            const featureId = `cam-${el?.type || 'el'}-${el?.id || idx}-${lat.toFixed(4)}-${lon.toFixed(4)}`;
            const dedupe = `${lat.toFixed(5)}|${lon.toFixed(5)}|${(name || '').toLowerCase()}`;
            if (seen.has(dedupe)) return;
            seen.add(dedupe);

            features.push({
                type: 'Feature',
                id: featureId,
                geometry: { type: 'Point', coordinates: [lon, lat] },
                properties: {
                    name: name || sourceName,
                    operator,
                    sourceType: sourceName,
                    cameraType,
                    website: String(tags.website || tags.url || tags.contact_website || tags['contact:website'] || '').trim(),
                    image: String(tags.image || tags['camera:image'] || '').trim(),
                    tier,
                    tinyLabel: buildCameraTinyLabel(name || sourceName, operator, sourceName),
                    source: 'OpenStreetMap (Overpass)'
                }
            });
        });

        features.sort((a, b) => (Number(b.properties?.tier || 0) - Number(a.properties?.tier || 0)));
        if (features.length > 3000) features.length = 3000;
        return { type: 'FeatureCollection', features };
    } catch (error) {
        console.warn('fetchTrafficCamerasOverpass failed', error);
        return emptyCameraFeatureCollection();
    }
}

function ensureCameraPopupStyle() {
    if (document.getElementById('camera-popup-style')) return;
    const style = document.createElement('style');
    style.id = 'camera-popup-style';
    style.textContent = `
        #snow-report-panel { z-index: 2350 !important; }
        .camera-popup .maplibregl-popup-content {
            padding: 0 !important;
            border: none !important;
            border-radius: 10px !important;
            overflow: hidden !important;
            background: linear-gradient(150deg, rgba(8,19,38,0.98), rgba(5,14,29,0.98)) !important;
            color: #e7f4ff !important;
            box-shadow: 0 10px 26px rgba(0,0,0,0.42), 0 0 0 1px rgba(131,190,255,0.2) !important;
            min-width: 250px;
            font-family: 'Rajdhani', 'Inter', sans-serif;
        }
        .camera-popup .maplibregl-popup-tip { border-top-color: rgba(5,14,29,0.98) !important; }
        .camera-card { padding: 10px 12px 11px; border-left: 3px solid #22d3ee; }
        .camera-title { font-size: 1rem; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; }
        .camera-sub { margin-top: 4px; font-size: .82rem; opacity: .86; }
        .camera-kv { margin-top: 8px; display: flex; flex-direction: column; gap: 4px; border-top: 1px solid rgba(159,208,255,0.18); padding-top: 7px; }
        .camera-row { display: flex; justify-content: space-between; gap: 8px; align-items: flex-start; }
        .camera-k { font-size: .66rem; letter-spacing: .08em; opacity: .72; }
        .camera-v { font-size: .84rem; font-weight: 700; text-align: right; line-height: 1.2; }
        .camera-link { margin-top: 8px; display: inline-block; color: #7dd3fc; font-size: .78rem; font-weight: 700; text-decoration: none; border-bottom: 1px solid rgba(125,211,252,0.35); }
        .camera-top-card {
            position: relative;
            min-width: 326px;
            max-width: 382px;
            padding: 15px 15px 13px;
            background:
                radial-gradient(120% 100% at 24% 6%, rgba(255,255,255,0.08), rgba(255,255,255,0) 46%),
                linear-gradient(148deg, rgba(8,16,42,0.98) 0%, rgba(4,13,35,0.985) 48%, rgba(3,12,33,0.99) 100%);
            border: 1px solid rgba(187, 214, 255, 0.2);
            border-left: 2px solid #38bdf8;
            clip-path: polygon(0 0, calc(100% - 16px) 0, 100% 16px, 100% calc(100% - 16px), calc(100% - 16px) 100%, 0 100%);
            box-shadow: 0 0 0 1px rgba(255,255,255,0.07), 0 0 26px rgba(56,189,248,0.33), 0 14px 34px rgba(0,0,0,0.52);
            color: #f8fbff;
            font-family: 'Rajdhani', 'Inter', sans-serif;
            overflow: hidden;
        }
        .camera-top-close {
            position: absolute;
            top: 8px;
            right: 10px;
            width: 22px;
            height: 22px;
            border: 0;
            background: transparent;
            color: rgba(241,246,255,0.84);
            font-size: 20px;
            line-height: 1;
            cursor: pointer;
            padding: 0;
        }
        .camera-top-close:hover { color: #fff; }
        .camera-top-title {
            font-size: 1.92rem;
            line-height: 0.92;
            font-weight: 800;
            letter-spacing: .06em;
            text-transform: uppercase;
            margin-right: 18px;
        }
        .camera-top-subtitle {
            margin-top: 7px;
            font-size: 1rem;
            font-weight: 700;
            letter-spacing: .11em;
            text-transform: uppercase;
            color: rgba(222,236,255,0.84);
        }
        .camera-top-line { margin-top: 10px; position: relative; height: 8px; }
        .camera-top-line span {
            display: block;
            height: 2px;
            background: linear-gradient(90deg, rgba(255,255,255,0.08) 0%, rgba(56,189,248,0.4) 28%, rgba(255,255,255,0.92) 72%, rgba(255,255,255,0.14) 100%);
            box-shadow: 0 0 12px rgba(56,189,248,0.45);
        }
        .camera-top-badges {
            margin-top: 9px;
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 6px;
        }
        .camera-top-chip {
            border: 1px solid rgba(129,171,228,0.35);
            background: rgba(6,17,43,0.7);
            color: rgba(229,240,255,0.95);
            font-size: .78rem;
            letter-spacing: .05em;
            text-transform: uppercase;
            padding: 5px 6px;
            text-align: center;
            font-weight: 700;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }
        .camera-top-media {
            margin-top: 10px;
            border: 1px solid rgba(156,190,234,0.23);
            background: rgba(2,8,21,0.92);
            min-height: 170px;
            max-height: 210px;
            position: relative;
            overflow: hidden;
        }
        .camera-top-media-img,
        .camera-top-media-frame {
            display: block;
            width: 100%;
            height: 192px;
            border: 0;
            object-fit: cover;
            background: rgba(2, 8, 20, 0.96);
        }
        .camera-top-media-note {
            position: absolute;
            left: 0;
            right: 0;
            bottom: 0;
            padding: 4px 8px;
            font-size: .67rem;
            font-weight: 700;
            letter-spacing: .04em;
            color: rgba(205, 227, 251, 0.9);
            text-transform: uppercase;
            background: linear-gradient(180deg, rgba(2,8,21,0), rgba(2,8,21,0.95));
        }
        .camera-top-media-empty {
            min-height: 170px;
            display: flex;
            align-items: center;
            justify-content: center;
            text-align: center;
            padding: 16px;
            font-size: .78rem;
            letter-spacing: .08em;
            color: rgba(199, 221, 247, 0.9);
            text-transform: uppercase;
            font-weight: 700;
        }
        .camera-top-foot {
            margin-top: 9px;
            border-top: 1px solid rgba(157, 184, 222, 0.22);
            padding-top: 8px;
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 10px;
        }
        .camera-top-source {
            font-size: .73rem;
            letter-spacing: .06em;
            color: rgba(191, 212, 241, 0.86);
            text-transform: uppercase;
            font-weight: 700;
            min-width: 0;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }
        .camera-top-link {
            font-size: .73rem;
            letter-spacing: .07em;
            text-transform: uppercase;
            font-weight: 800;
            color: #9ad8ff;
            text-decoration: none;
            border: 1px solid rgba(93, 160, 220, 0.4);
            background: rgba(10, 25, 51, 0.76);
            padding: 4px 8px;
            border-radius: 3px;
            flex-shrink: 0;
        }
        .camera-top-link:hover { color: #d9f0ff; border-color: rgba(132, 200, 255, 0.6); }
    `;
    document.head.appendChild(style);
}

function bindCameraLayerInteractions() {
    if (!map || map.__cameraLayerBound) return;
    map.__cameraLayerBound = true;
    try {
        [camerasLayerId, camerasLabelLayerId].forEach((layerId) => {
            map.on('mouseenter', layerId, () => {
                try { map.getCanvas().style.cursor = 'pointer'; } catch {}
            });
            map.on('mouseleave', layerId, () => {
                try { map.getCanvas().style.cursor = ''; } catch {}
            });
            map.on('click', layerId, (event) => {
                const feature = event?.features?.[0];
                if (!feature) return;
                showCameraPopup(feature, {
                    lngLat: event.lngLat,
                    nearestWarningLabel: '',
                    distanceKm: null
                });
            });
        });
    } catch {}
}

function setCameraLayersVisibility(visibility) {
    const visible = visibility === 'visible';
    camerasState.visible = visible;
    try {
        if (map.getLayer(camerasLayerId)) map.setLayoutProperty(camerasLayerId, 'visibility', visibility);
        if (map.getLayer(camerasLabelLayerId)) map.setLayoutProperty(camerasLabelLayerId, 'visibility', visible ? 'visible' : 'none');
        if (!visible) hideCameraTopLeftPanel();
    } catch {}
}

function ensureCameraLayers() {
    if (!map) return false;
    try {
        if (!map.getSource(camerasSourceId)) {
            map.addSource(camerasSourceId, {
                type: 'geojson',
                data: emptyCameraFeatureCollection()
            });
        }
        const beforeLayer = map.getLayer('warnings-fill') ? 'warnings-fill' : undefined;
        if (!map.getLayer(camerasLayerId)) {
            map.addLayer({
                id: camerasLayerId,
                type: 'circle',
                source: camerasSourceId,
                layout: { visibility: 'none' },
                paint: {
                    'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, 2.9, 7, 3.8, 10, 4.8, 12, 5.8],
                    'circle-color': '#ff8c1a',
                    'circle-opacity': 0.94,
                    'circle-stroke-color': 'rgba(120, 54, 5, 0.95)',
                    'circle-stroke-width': 1.05
                }
            }, beforeLayer);
        }
        if (!map.getLayer(camerasLabelLayerId)) {
            map.addLayer({
                id: camerasLabelLayerId,
                type: 'symbol',
                source: camerasSourceId,
                minzoom: 5.6,
                layout: {
                    visibility: 'none',
                    'text-field': ['coalesce', ['get', 'tinyLabel'], ['slice', ['coalesce', ['get', 'name'], 'CAM'], 0, 16]],
                    'text-font': ['Noto Sans Bold', 'Noto Sans Regular'],
                    'text-size': ['interpolate', ['linear'], ['zoom'], 5.6, 7.1, 8, 7.3, 11, 8.1],
                    'text-offset': [0, 1.28],
                    'text-anchor': 'top',
                    'text-letter-spacing': 0.04,
                    'text-max-width': 8.2
                },
                paint: {
                    'text-color': '#dff3ff',
                    'text-halo-color': 'rgba(2, 8, 20, 0.95)',
                    'text-halo-width': 1.25
                }
            });
        }
        bringCameraAndInfrastructureLayersToFront();
        ensureCameraPopupStyle();
        bindCameraLayerInteractions();
        return true;
    } catch (error) {
        console.warn('ensureCameraLayers failed', error);
        return false;
    }
}

function showCameraPopup(feature, {
    lngLat = null,
    nearestWarningLabel = '',
    distanceKm = null,
    cycleIndex = null,
    cycleTotal = null
} = {}) {
    if (!map || !feature) return;
    try {
        if (currentCameraPopup) {
            currentCameraPopup.remove();
            currentCameraPopup = null;
        }
    } catch {}
    const p = feature.properties || {};
    const coords = getFeatureCoordinates(feature);
    const tierText = Number(p.tier || 0) >= 2 ? 'DOT' : (Number(p.tier || 0) >= 1 ? 'CITY' : 'TRAFFIC');
    const distanceText = Number.isFinite(Number(distanceKm)) ? `${Number(distanceKm).toFixed(1)} km` : '--';
    const warningText = nearestWarningLabel || '--';
    const cycleText = (Number.isFinite(cycleIndex) && Number.isFinite(cycleTotal) && cycleTotal > 0)
        ? `${cycleIndex}/${cycleTotal}`
        : '--';
    const website = sanitizeHttpUrl(p.website || '');
    if (website) {
        try {
            const w = window.open(website, '_blank', 'noopener,noreferrer');
            if (w) w.opener = null;
        } catch {}
    } else {
        renderCameraTopLeftPanel({
            title: p.name || 'DOT CAMERA',
            subtitle: p.operator || p.sourceType || 'DOT Camera',
            tierText,
            website: '',
            image: p.image || '',
            warningText,
            distanceText,
            cycleText
        });
    }
    try {
        const point = lngLat || (coords ? { lng: coords.lon, lat: coords.lat } : null);
        if (point && Number.isFinite(point.lng) && Number.isFinite(point.lat)) {
            triggerStormReportPulse(point, '#ff8c1a');
        }
    } catch {}
}

async function updateCamerasSource({ force = false } = {}) {
    if (!map) return false;
    const ok = ensureCameraLayers();
    if (!ok) return false;
    if (camerasState.loading) {
        camerasState.refreshQueued = true;
        return false;
    }
    const now = Date.now();
    const bounds = getCameraQueryBounds();
    const boundsKey = getCameraBoundsKey(bounds);
    if (!force && boundsKey && boundsKey === camerasState.lastBoundsKey && (now - camerasState.lastFetchAt) < (4 * 60 * 1000)) {
        return false;
    }

    camerasState.loading = true;
    try {
        const [osmBase, moDotBase] = await Promise.all([
            fetchTrafficCamerasOverpass(bounds),
            fetchMoDotCamerasGeoJSON(bounds)
        ]);
        let data = mergeCameraCollections([osmBase, moDotBase]);
        const warningBboxes = buildTrafficCameraBboxesForWarnings(8);
        if ((!data?.features || data.features.length < 8) && warningBboxes.length) {
            const focusedOsm = await fetchTrafficCamerasOverpass(warningBboxes);
            const focusedMerged = mergeCameraCollections([data, focusedOsm]);
            if ((focusedMerged?.features?.length || 0) > (data?.features?.length || 0)) {
                data = focusedMerged;
            }
        }
        camerasGeojsonCache = data && data.type === 'FeatureCollection' ? data : emptyCameraFeatureCollection();
        const src = map.getSource(camerasSourceId);
        if (src && typeof src.setData === 'function') {
            src.setData(camerasGeojsonCache);
        }
        camerasState.lastFetchAt = Date.now();
        camerasState.lastBoundsKey = boundsKey;
        return true;
    } catch (error) {
        console.warn('updateCamerasSource failed', error);
        return false;
    } finally {
        camerasState.loading = false;
        if (camerasState.refreshQueued) {
            camerasState.refreshQueued = false;
            scheduleCamerasSourceRefresh(700, true);
        }
    }
}

function scheduleCamerasSourceRefresh(delayMs = 1200, force = false) {
    if (camerasRefreshTimer) {
        clearTimeout(camerasRefreshTimer);
        camerasRefreshTimer = null;
    }
    camerasRefreshTimer = setTimeout(() => {
        camerasRefreshTimer = null;
        updateCamerasSource({ force }).catch(() => {});
    }, Math.max(0, Number(delayMs) || 0));
}

function mergeCameraCollections(collections = []) {
    const features = [];
    const seen = new Set();
    collections.forEach((collection) => {
        const list = Array.isArray(collection?.features) ? collection.features : [];
        list.forEach((f) => {
            const lon = Number(f?.geometry?.coordinates?.[0]);
            const lat = Number(f?.geometry?.coordinates?.[1]);
            if (!Number.isFinite(lon) || !Number.isFinite(lat)) return;
            const p = f?.properties || {};
            const key = `${lat.toFixed(5)}|${lon.toFixed(5)}|${String(p.website || '').toLowerCase()}|${String(p.name || '').toLowerCase()}`;
            if (seen.has(key)) return;
            seen.add(key);
            features.push(f);
        });
    });
    features.sort((a, b) => (Number(b?.properties?.tier || 0) - Number(a?.properties?.tier || 0)));
    if (features.length > 3500) features.length = 3500;
    return { type: 'FeatureCollection', features };
}

function buildCameraCycleQueue() {
    const features = Array.isArray(camerasGeojsonCache?.features) ? camerasGeojsonCache.features : [];
    if (!features.length) return [];
    const warningCenters = extractActiveWarningCentersForCycle();
    if (!warningCenters.length) {
        const center = map && typeof map.getCenter === 'function' ? map.getCenter() : { lng: -97, lat: 39 };
        return features
            .map((f) => {
                const c = getFeatureCoordinates(f);
                if (!c) return null;
                return {
                    feature: f,
                    warningLabel: 'No active warning',
                    distanceKm: haversineKm(center.lat, center.lng, c.lat, c.lon),
                    score: -haversineKm(center.lat, center.lng, c.lat, c.lon)
                };
            })
            .filter(Boolean)
            .sort((a, b) => b.score - a.score)
            .slice(0, cameraCycleSettings.maxQueueSize || 20);
    }

    const rankedByCamera = new Map();
    warningCenters.forEach((warning) => {
        const nearby = features
            .map((f) => {
                const c = getFeatureCoordinates(f);
                if (!c) return null;
                const d = haversineKm(warning.lat, warning.lng, c.lat, c.lon);
                if (!Number.isFinite(d) || d > (cameraCycleSettings.maxDistanceKm || 160)) return null;
                const tierBonus = Number(f?.properties?.tier || 0) * 12;
                const score = warning.severityScore * 1000 - (d * 10) + tierBonus;
                return { feature: f, distanceKm: d, score, warningLabel: warning.event };
            })
            .filter(Boolean)
            .sort((a, b) => b.score - a.score)
            .slice(0, cameraCycleSettings.perWarning || 3);

        nearby.forEach((entry) => {
            const id = String(entry.feature.id || `${entry.feature.geometry?.coordinates?.join(',')}`);
            const existing = rankedByCamera.get(id);
            if (!existing || entry.score > existing.score) {
                rankedByCamera.set(id, entry);
            }
        });
    });

    const queue = Array.from(rankedByCamera.values())
        .sort((a, b) => b.score - a.score)
        .slice(0, cameraCycleSettings.maxQueueSize || 20);
    return queue;
}

function stopCameraAutoCycle() {
    cameraAutoCycleState.active = false;
    cameraAutoCycleState.queue = [];
    cameraAutoCycleState.index = 0;
    cameraAutoCycleState.lastQueueBuiltAt = 0;
    if (cameraAutoCycleState.timerId) {
        clearTimeout(cameraAutoCycleState.timerId);
        cameraAutoCycleState.timerId = null;
    }
    try {
        if (currentCameraPopup) {
            currentCameraPopup.remove();
            currentCameraPopup = null;
        }
    } catch {}
    hideCameraTopLeftPanel();
    if (!camerasState.visible) {
        setCameraLayersVisibility('none');
    }
    setButtonActive('camera-cycle', false);
}

function advanceCameraAutoCycle() {
    if (!cameraAutoCycleState.active || !map) return;
    const now = Date.now();
    const needsQueue = (
        !Array.isArray(cameraAutoCycleState.queue) ||
        !cameraAutoCycleState.queue.length ||
        (now - cameraAutoCycleState.lastQueueBuiltAt) > 90 * 1000 ||
        cameraAutoCycleState.lastQueueWarningCount !== (weatherWarnings || []).length
    );
    if (needsQueue) {
        cameraAutoCycleState.queue = buildCameraCycleQueue();
        cameraAutoCycleState.lastQueueBuiltAt = now;
        cameraAutoCycleState.lastQueueWarningCount = (weatherWarnings || []).length;
        cameraAutoCycleState.index = 0;
    }
    if (!cameraAutoCycleState.queue.length) {
        cameraAutoCycleState.timerId = setTimeout(advanceCameraAutoCycle, 6000);
        return;
    }
    const i = cameraAutoCycleState.index % cameraAutoCycleState.queue.length;
    cameraAutoCycleState.index += 1;
    const item = cameraAutoCycleState.queue[i];
    const coords = getFeatureCoordinates(item.feature);
    if (coords) {
        try {
            map.flyTo({
                center: [coords.lon, coords.lat],
                zoom: Math.max(9.6, Number(map.getZoom?.() || 8)),
                speed: 0.72,
                curve: 1.32,
                essential: true
            });
        } catch {}
        showCameraPopup(item.feature, {
            lngLat: { lng: coords.lon, lat: coords.lat },
            nearestWarningLabel: item.warningLabel || '',
            distanceKm: item.distanceKm,
            cycleIndex: i + 1,
            cycleTotal: cameraAutoCycleState.queue.length
        });
    }
    cameraAutoCycleState.timerId = setTimeout(advanceCameraAutoCycle, cameraAutoCycleState.intervalMs);
}

async function startCameraAutoCycle() {
    if (!map) return false;
    setButtonActive('camera-cycle', true);
    ensureCameraLayers();
    setCameraLayersVisibility('visible');
    await updateCamerasSource({ force: true });
    cameraAutoCycleState.queue = buildCameraCycleQueue();
    cameraAutoCycleState.lastQueueBuiltAt = Date.now();
    cameraAutoCycleState.lastQueueWarningCount = (weatherWarnings || []).length;
    cameraAutoCycleState.index = 0;
    if (!cameraAutoCycleState.queue.length) {
        stopCameraAutoCycle();
        return false;
    }
    cameraAutoCycleState.active = true;
    setButtonActive('camera-cycle', true);
    advanceCameraAutoCycle();
    return true;
}

async function toggleCameraAutoCycleHeader(event) {
    try { event && event.preventDefault && event.preventDefault(); } catch {}
    if (!map) return false;
    const menu = getCameraCycleMenuElement();
    if (menu) menu.setAttribute('hidden', '');
    if (cameraAutoCycleState.active) stopCameraAutoCycle();

    let currentlyVisible = !!camerasState.visible;
    try {
        const layerVis = map.getLayer(camerasLayerId) ? map.getLayoutProperty(camerasLayerId, 'visibility') : 'none';
        currentlyVisible = currentlyVisible || layerVis === 'visible';
    } catch {}

    if (currentlyVisible) {
        setCameraLayersVisibility('none');
        setButtonActive('camera-cycle', false);
        return false;
    }

    const ready = ensureCameraLayers();
    if (!ready) {
        setButtonActive('camera-cycle', false);
        return false;
    }
    setCameraLayersVisibility('visible');
    await updateCamerasSource({ force: true });
    setButtonActive('camera-cycle', true);
    return true;
}

// Merge multiple Polygon/MultiPolygon geometries into a MultiPolygon without dissolving
function mergeToMultiPolygon(geometries) {
    const polys = [];
    for (const g of geometries) {
        if (!g) continue;
        if (g.type === 'Polygon') {
            polys.push(g.coordinates);
        } else if (g.type === 'MultiPolygon') {
            for (const c of g.coordinates) polys.push(c);
        }
    }
    if (!polys.length) return null;
    return { type: 'MultiPolygon', coordinates: polys };
}

// Dissolve/group warnings that were issued together into a single MultiPolygon feature
// Group key uses event + sender + sent timestamp (fallbacks to effective/onset)
function dissolveWarningsByIssuance(features) {
    if (!Array.isArray(features) || features.length === 0) return [];
    const groups = new Map();
    for (const f of features) {
        try {
            if (!f || !f.geometry || !f.properties) continue;
            const p = f.properties;
            const event = String(p.event || '').toUpperCase();
            const sender = String(p.senderName || p.sender || '').toUpperCase();
            const sent = String(p.sent || p.effective || p.onset || '').slice(0, 19); // ISO prefix to minute
            const key = `${event}|${sender}|${sent}`;
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(f);
        } catch {}
    }

    const dissolved = [];
    for (const [, list] of groups) {
        if (!list || list.length === 0) continue;
        if (list.length === 1) { dissolved.push(list[0]); continue; }
        try {
            const base = list[0];
            const geoms = list.map(x => x && x.geometry).filter(Boolean);
            const mergedGeom = mergeToMultiPolygon(geoms);
            const props = { ...(base.properties || {}) };
            // keep color and collect ids for debugging/inspection
            props._ids = list.map(x => x && (x.id || x.properties?.id)).filter(Boolean);
            const id = props._ids.join('|');
            dissolved.push({ type: 'Feature', id, properties: props, geometry: mergedGeom || base.geometry });
        } catch {
            dissolved.push(list[0]);
        }
    }
    return dissolved;
}

// For each alert missing geometry, attempt to build geometry from its affectedZones
async function enrichWarningsWithZoneGeometry(features) {
    if (!Array.isArray(features) || !features.length) return 0;

    const featureZoneRefs = [];
    const uniqueZoneUrls = new Set();

    for (const f of features) {
        try {
            if (!f || f.geometry) continue;
            const zones = (f.properties && f.properties.affectedZones) || [];
            if (!Array.isArray(zones) || zones.length === 0) continue;
            const limited = zones
                .map((z) => String(z || '').trim())
                .filter(Boolean)
                .slice(0, ZONE_GEOMETRY_MAX_PER_ALERT);
            if (!limited.length) continue;
            featureZoneRefs.push({ feature: f, zones: limited });
            limited.forEach((z) => uniqueZoneUrls.add(z));
        } catch {}
    }

    if (!featureZoneRefs.length || !uniqueZoneUrls.size) return 0;

    const zoneUrlList = Array.from(uniqueZoneUrls);
    const workerCount = Math.max(1, Math.min(ZONE_GEOMETRY_FETCH_CONCURRENCY, zoneUrlList.length));
    let idx = 0;
    const runners = new Array(workerCount).fill(0).map(async () => {
        while (idx < zoneUrlList.length) {
            const i = idx++;
            const zoneUrl = zoneUrlList[i];
            await fetchZoneGeometry(zoneUrl);
        }
    });
    await Promise.all(runners);

    let enrichedCount = 0;
    for (const entry of featureZoneRefs) {
        try {
            const geoms = entry.zones
                .map((zoneUrl) => zoneGeometryCache.get(zoneUrl))
                .filter(Boolean);
            if (!geoms.length) continue;
            const merged = mergeToMultiPolygon(geoms);
            if (!merged) continue;
            entry.feature.geometry = merged;
            enrichedCount += 1;
        } catch {}
    }

    return enrichedCount;
}
// Weather Map JavaScript
let map;
let weatherWarnings = [];
let radarLayer = null;
let satelliteLayer = null;
let warningLayers = [];
let precipTypeLayer = null;
let spcOutlookLayerId = null;
let spcOutlookSourceId = null;
let spcOutlookOutlineLayerId = null;
let spcOutlookState = {
    day: 'day1',
    category: 'cat',
    visible: false
};
let spcOutlookLastConvectiveCategory = 'cat';
let spcOutlookPreviousState = null;
let wpcEroState = {
    day: 'day1',
    visible: false
};
let wpcEroSourceId = null;
let wpcEroFillLayerId = null;
let wpcEroOutlineLayerId = null;
let wpcEroPreviousState = null;
let infrastructureState = {
    visible: false,
    loading: false,
    lastFetchAt: 0,
    lastBoundsKey: '',
    refreshQueued: false
};
let infrastructureRefreshTimer = null;
let powerOutageState = {
    visible: false,
    loading: false,
    lastFetchAt: 0,
    lastBoundsKey: '',
    refreshQueued: false
};
let powerOutageRefreshTimer = null;
let powerOutageCountyBase = null;
let powerOutageCountyIndex = null;
let powerOutageCountyLoadPromise = null;
let powerOutageHoverPopup = null;
let powerOutageHoveredFeatureId = null;
let isWeatherDataLoading = false;
let warningLoadSequence = 0;
let preloadedStormReportsData = null;
let preloadedStormReportsAt = 0;
let mapStartupProgressState = {
    active: false,
    total: 0,
    completed: 0,
    failed: 0,
    tasks: new Set()
};
let mapStartupProgressHideTimer = null;
const INFRASTRUCTURE_FEEDS = {
    outages: 'https://services.arcgis.com/pGfbNJoYypmNq86F/arcgis/rest/services/County_Power_Outages/FeatureServer/0',
    counties: 'https://services.arcgis.com/P3ePLMYs2RVChkJx/ArcGIS/rest/services/USA_Counties_Generalized_Boundaries/FeatureServer/0',
    hospitals: 'https://services1.arcgis.com/0MSEUqKaxRlEPj5g/arcgis/rest/services/Hospitals2/FeatureServer/0',
    shelters: 'https://gis.fema.gov/arcgis/rest/services/NSS/FEMA_NSS/FeatureServer/0',
    substations: 'https://services.arcgis.com/G4S1dGvn7PIgYd6Y/arcgis/rest/services/HIFLD_electric_power_substations/FeatureServer/0'
};
const POWER_OUTAGE_SOURCE_ID = 'power-outages-county-src';
const POWER_OUTAGE_GLOW_LAYER_ID = 'power-outages-county-fill';
const POWER_OUTAGE_LAYER_ID = 'power-outages-county-outline';
const POWER_OUTAGE_LABEL_LAYER_ID = 'power-outages-county-hover';
const POWER_OUTAGE_QUERY_REGIONS = [
    { west: -125, south: 24, east: -108, north: 37 },
    { west: -108, south: 24, east: -96, north: 37 },
    { west: -96, south: 24, east: -84, north: 37 },
    { west: -84, south: 24, east: -66, north: 37 },
    { west: -125, south: 37, east: -108, north: 50 },
    { west: -108, south: 37, east: -96, north: 50 },
    { west: -96, south: 37, east: -84, north: 50 },
    { west: -84, south: 37, east: -66, north: 50 },
    { west: -171, south: 51, east: -129, north: 72 }, // Alaska
    { west: -161.5, south: 18, east: -154, north: 23.5 }, // Hawaii
    { west: -68.5, south: 17.5, east: -64.5, north: 18.8 } // Puerto Rico
];
const INFRA_SOURCE_IDS = {
    outages: 'infra-power-outages-src',
    hospitals: 'infra-hospitals-src',
    shelters: 'infra-shelters-src',
    substations: 'infra-substations-src',
    trailerParks: 'infra-trailer-parks-src',
    camps: 'infra-camps-src'
};
const INFRA_LAYER_IDS = {
    outages: 'infra-power-outages',
    hospitals: 'infra-hospitals',
    shelters: 'infra-shelters',
    substations: 'infra-substations',
    trailerParks: 'infra-trailer-parks',
    camps: 'infra-camps'
};
const BASE_WARNING_LEGEND = [
    { label: 'Tornado Warning', color: '#ff3c1a' },
    { label: 'Severe T-Storm Warning', color: '#ffb300' },
    { label: 'Flood Warning', color: '#00e676' }
];
const SPC_CONVECTIVE_DAYS = ['day1', 'day2', 'day3'];
const SPC_EXTENDED_DAYS = ['day4', 'day5', 'day6', 'day7', 'day8'];
const SPC_SUPPORTED_DAYS = [...SPC_CONVECTIVE_DAYS, ...SPC_EXTENDED_DAYS];
const SPC_CATEGORY_LABELS = {
    cat: 'Categorical',
    torn: 'Tornado',
    wind: 'Wind',
    hail: 'Hail',
    prob: 'Probabilistic'
};

const SPC_LEGEND_SETS = {
    cat: {
        title: 'Risk Levels',
        entries: [
            { label: 'General Thunderstorms', color: '#808b96' },
            { label: 'Marginal Risk', color: '#76b041' },
            { label: 'Slight Risk', color: '#ffdd55' },
            { label: 'Enhanced Risk', color: '#ffa600' },
            { label: 'Moderate Risk', color: '#ff4c4c' },
            { label: 'High Risk', color: '#d433ff' }
        ]
    },
    torn: {
        title: 'Tornado Probabilities',
        entries: [
            { label: '2%', color: '#b4dbff' },
            { label: '5%', color: '#6fb7ff' },
            { label: '10%', color: '#2f89ff' },
            { label: '15%', color: '#ffb347' },
            { label: '30%', color: '#ff6b6b' },
            { label: '45%+', color: '#d433ff' }
        ]
    },
    wind: {
        title: 'Wind Probabilities',
        entries: [
            { label: '5%', color: '#9bd4ff' },
            { label: '15%', color: '#6fb7ff' },
            { label: '30%', color: '#2986ff' },
            { label: '45%', color: '#ffa600' },
            { label: '60%+', color: '#ff4c4c' }
        ]
    },
    hail: {
        title: 'Hail Probabilities',
        entries: [
            { label: '5%', color: '#c3eaff' },
            { label: '15%', color: '#75c0ff' },
            { label: '30%', color: '#3f9dff' },
            { label: '45%', color: '#ffae42' },
            { label: '60%+', color: '#d433ff' }
        ]
    },
    prob: {
        title: 'Day 4-8 Probabilities',
        entries: [
            { label: '15% Area', color: '#ffeb7f' },
            { label: '30% Area', color: '#ff6b6b' },
            { label: 'Too Low', color: '#5d6572' }
        ]
    },
    probDay3: {
        title: 'Day 3 Probabilities',
        entries: [
            { label: '5% Any Severe', color: '#9bd4ff' },
            { label: '15% Any Severe', color: '#ffeb7f' },
            { label: '30% Any Severe', color: '#ff6b6b' }
        ]
    }
};
// Cache for NWS zone geometries fetched via affectedZones links
const zoneGeometryCache = new Map(); // key: zone URL, value: GeoJSON geometry or null
const zoneGeometryInflightCache = new Map(); // key: zone URL, value: Promise<GeoJSON geometry|null>
// Track the currently open warning popup so we can close it when clicking elsewhere
let currentWarningPopup = null;
let lastOverlappingFeatures = [];
// Camera state
let camerasSourceId = 'cameras-src';
let camerasLayerId = 'cameras-layer';
let camerasLabelLayerId = 'cameras-labels';
let currentCameraPopup = null;
let camerasGeojsonCache = { type: 'FeatureCollection', features: [] };
let camerasRefreshTimer = null;
let camerasState = {
    loading: false,
    lastFetchAt: 0,
    lastBoundsKey: '',
    refreshQueued: false,
    visible: false
};
const CAMERA_CYCLE_SETTINGS_KEY = 'cameraCycleSettingsV1';
const DEFAULT_CAMERA_CYCLE_SETTINGS = {
    intervalMs: 7500,
    maxDistanceKm: 160,
    maxQueueSize: 20,
    perWarning: 3
};
let cameraCycleSettings = { ...DEFAULT_CAMERA_CYCLE_SETTINGS };
let cameraAutoCycleState = {
    active: false,
    queue: [],
    index: 0,
    timerId: null,
    intervalMs: DEFAULT_CAMERA_CYCLE_SETTINGS.intervalMs,
    lastQueueBuiltAt: 0,
    lastQueueWarningCount: 0
};
// NHC overlay state
let nhcLayerId = 'nhc-layer';
let nhcSourceId = 'nhc-src';
let nhcVisible = false;
// Hi-Res radar and radar sites
let hresRadarSourceId = 'radar-hres-src';
let hresRadarLayerId = 'radar-hres-layer';
let radarSitesSourceId = 'radar-sites-src';
let radarSitesLayerId = 'radar-sites-layer';
let radarSitesLabelLayerId = 'radar-sites-labels';

// NHC Atlantic active tropical cyclones (forecast cone + watch/warning coastline)
// ArcGIS tiled endpoint (z/y/x)
const NHC_ATL_TILES = 'https://idpgis.ncep.noaa.gov/arcgis/rest/services/NWS_Forecasts_Guidance_Warnings/NHC_Atl_trop_cyclones_active/MapServer/tile/{z}/{y}/{x}';

const RADAR_TILE_URL_TEMPLATE = 'https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/nexrad-n0q-900913/{z}/{x}/{y}.png';
// Hi-Res radar providers
// 1) RainViewer (reliable, CORS-enabled, latest nowcast)
const RAINVIEWER_RADAR_TILES = 'https://tilecache.rainviewer.com/v2/radar/nowcast/256/{z}/{x}/{y}/2/1_1.png';
// 2) NOAA NOWCoast NEXRAD mosaic (may be blocked/rate-limited in some environments)
const NOWCOAST_RADAR_TILES = 'https://nowcoast.noaa.gov/arcgis/rest/services/obs/radar_meteo_imagery_nexrad_time/MapServer/tile/{z}/{y}/{x}';

function buildFreshRadarTileUrls() {
    const cacheBust = Math.floor(Date.now() / 60000); // change once per minute to grab newest frames
    return [`${RADAR_TILE_URL_TEMPLATE}?cb=${cacheBust}`];
}

// Ensure the NHC raster source/layer exists (hidden by default)
function ensureNHCLayer() {
    if (!map) return;
    try {
        if (!map.getSource(nhcSourceId)) {
            map.addSource(nhcSourceId, {
                type: 'raster',
                tiles: [NHC_ATL_TILES],
                tileSize: 256,
                attribution: ' © NOAA/NHC'
            });
        }
        if (!map.getLayer(nhcLayerId)) {
            map.addLayer({
                id: nhcLayerId,
                type: 'raster',
                source: nhcSourceId,
                paint: {
                    'raster-opacity': 0.85,
                    'raster-resampling': 'linear'
                },
                layout: { 'visibility': 'none' }
            }, 'water-fill'); // place above basemap water fill
        }
        // Keep warnings above NHC overlay
        try { if (map.getLayer('warnings-fill')) map.moveLayer('warnings-fill'); } catch {}
        try { if (map.getLayer('warnings-outline')) map.moveLayer('warnings-outline'); } catch {}
        bringCameraAndInfrastructureLayersToFront();
    } catch (e) {
        console.warn('ensureNHCLayer error:', e);
    }
}

function toggleNHCLayer() {
    if (!map) return false;
    ensureNHCLayer();
    try {
        const vis = map.getLayoutProperty(nhcLayerId, 'visibility');
        const next = vis === 'none' ? 'visible' : 'none';
        map.setLayoutProperty(nhcLayerId, 'visibility', next);
        nhcVisible = (next === 'visible');
        console.log('[NHC] visibility ->', nhcVisible);
        if (nhcVisible) {
            // Optional: quick ping to one tile near Caribbean to surface errors in console
            try {
                const z = 5, x = 9, y = 12; // rough Caribbean tile at z=5
                const testUrl = NHC_ATL_TILES.replace('{z}', z).replace('{x}', x).replace('{y}', y);
                fetch(testUrl, { mode: 'cors' }).then(r => {
                    console.log('[NHC] sample tile status:', r.status);
                }).catch(err => console.warn('[NHC] sample tile failed:', err));
            } catch {}
            // If the current view is far from the tropics, nudge camera toward the Caribbean
            try {
                const center = map.getCenter();
                if (center && (center.lat > 40 || center.lat < -10)) {
                    map.flyTo({ center: [-80, 20], zoom: Math.max(map.getZoom(), 4.5) });
                }
            } catch {}
        }
        return nhcVisible;
    } catch (e) {
        console.warn('toggleNHCLayer error:', e);
        return false;
    }
}

// Initialize the weather map
async function initWeatherMap() {
    try {
        const containerEl = document.getElementById('weather-map');
        if (!containerEl) {
            console.error('weather-map container not found');
            return;
        }
        // Initialize MapLibre GL map
        // Prewarm WebGL context (if supported) to reduce initial stutter
        try { if (maplibregl && typeof maplibregl.prewarm === 'function') maplibregl.prewarm(); } catch {}

    
        map = new maplibregl.Map({
            container: 'weather-map',
            style: {
                version: 8,
                glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
                sources: {
                    // Dark base without labels
                    'dark-basemap': {
                        type: 'raster',
                        tiles: [
                            'https://cartodb-basemaps-a.global.ssl.fastly.net/dark_nolabels/{z}/{x}/{y}.png',
                            'https://cartodb-basemaps-b.global.ssl.fastly.net/dark_nolabels/{z}/{x}/{y}.png',
                            'https://cartodb-basemaps-c.global.ssl.fastly.net/dark_nolabels/{z}/{x}/{y}.png',
                            'https://cartodb-basemaps-d.global.ssl.fastly.net/dark_nolabels/{z}/{x}/{y}.png'
                        ],
                        tileSize: 256,
                        attribution: ' © OpenStreetMap contributors, © Carto'
                    },
                    // Labels-only overlay (white labels with black halos are baked in)
                    'dark-labels-src': {
                        type: 'raster',
                        tiles: [
                            'https://cartodb-basemaps-a.global.ssl.fastly.net/dark_only_labels/{z}/{x}/{y}.png',
                            'https://cartodb-basemaps-b.global.ssl.fastly.net/dark_only_labels/{z}/{x}/{y}.png',
                            'https://cartodb-basemaps-c.global.ssl.fastly.net/dark_only_labels/{z}/{x}/{y}.png',
                            'https://cartodb-basemaps-d.global.ssl.fastly.net/dark_only_labels/{z}/{x}/{y}.png'
                        ],
                        tileSize: 256,
                        attribution: ' © OpenStreetMap contributors, © Carto'
                    },
                    // OpenMapTiles demo vector source for water + place labels (no key)
                    'omt': {
                        type: 'vector',
                        tiles: ['https://demotiles.maplibre.org/tiles/v3/{z}/{x}/{y}.pbf'],
                        maxzoom: 14
                    }
                },
                layers: [
                    {
                        id: 'dark-basemap',
                        type: 'raster',
                        source: 'dark-basemap',
                        paint: {
                            // full desaturation for grayscale look
                            'raster-saturation': -1,
                            // keep a darker base to make overlays pop
                            'raster-brightness-min': 0.3,
                            'raster-brightness-max': 0.72,
                            // slightly higher contrast for clarity
                            'raster-contrast': 0.22
                        }
                    },
                    // Shadow pass to simulate a thin black outline under labels
                    {
                        id: 'dark-labels-shadow',
                        type: 'raster',
                        source: 'dark-labels-src',
                        paint: {
                            'raster-saturation': -1,
                            'raster-brightness-min': 0.0,
                            'raster-brightness-max': 0.0,
                            'raster-contrast': 0.0
                        }
                    },
                    {
                        id: 'dark-labels',
                        type: 'raster',
                        source: 'dark-labels-src',
                        paint: {
                            // keep labels crisp and bright in grayscale
                            'raster-saturation': -1,
                            'raster-brightness-min': 1.0,
                            'raster-brightness-max': 1.0,
                            'raster-contrast': 0.4
                        }
                    },
                    // Water fill overlay from vector source so we can set exact color
                    {
                        id: 'water-fill',
                        type: 'fill',
                        source: 'omt',
                        'source-layer': 'water',
                        paint: {
                            // neutral gray water to maintain full grayscale theme
                            'fill-color': '#6b6b6b',
                            'fill-opacity': 0.95
                        }
                    },
                    // City and place labels with white text and black halo
                    {
                        id: 'place-labels',
                        type: 'symbol',
                        source: 'omt',
                        'source-layer': 'place',
                        filter: ['in', ['get','class'], ['literal', ['city','town']]],
                        layout: {
                            'text-field': ['coalesce', ['get','name:latin'], ['get','name']],
                            'text-font': ['Noto Sans Bold','Noto Sans Regular'],
                            'text-size': [
                                'interpolate', ['linear'], ['zoom'],
                                4, 22,
                                6, 24,
                                8, 28,
                                10, 32,
                                12, 38
                            ],
                            'text-padding': 2,
                            'text-max-width': 8,
                            'text-letter-spacing': 0.02
                        },
                        paint: {
                            'text-color': '#FFFFFF',
                            'text-halo-color': '#000000',
                            'text-halo-width': 1.8,
                            // crisper halo edge for sharper perceived text
                            'text-halo-blur': 0.1,
                            'text-opacity': 1.0
                        }
                    },
                    // Smaller places (village/hamlet) only at higher zooms
                    {
                        id: 'place-small',
                        type: 'symbol',
                        source: 'omt',
                        'source-layer': 'place',
                        minzoom: 8,
                        filter: ['in', ['get','class'], ['literal', ['village','hamlet']]],
                        layout: {
                            'text-field': ['coalesce', ['get','name:latin'], ['get','name']],
                            'text-font': ['Noto Sans Bold','Noto Sans Regular'],
                            'text-size': [
                                'interpolate', ['linear'], ['zoom'],
                                8, 18,
                                10, 20,
                                12, 26
                            ],
                            'text-padding': 2,
                            'text-max-width': 8
                        },
                        paint: {
                            'text-color': '#FFFFFF',
                            'text-halo-color': '#000000',
                            'text-halo-width': 1.4,
                            'text-halo-blur': 0.1,
                            'text-opacity': 1.0
                        }
                    },
                    // State labels slightly larger
                    {
                        id: 'state-labels',
                        type: 'symbol',
                        source: 'omt',
                        'source-layer': 'place',
                        filter: ['==', ['get','class'], 'state'],
                        layout: {
                            'text-field': ['coalesce', ['get','name:latin'], ['get','name']],
                            'text-font': ['Noto Sans Bold','Noto Sans Regular'],
                            'text-size': [
                                'interpolate', ['linear'], ['zoom'],
                                4, 34,
                                6, 40,
                                8, 48,
                                10, 58
                            ],
                            'text-padding': 2,
                            'text-max-width': 10,
                            'text-letter-spacing': 0.015
                        },
                        paint: {
                            'text-color': '#FFFFFF',
                            'text-halo-color': '#000000',
                            'text-halo-width': 2.2,
                            'text-halo-blur': 0.1,
                            'text-opacity': 1.0
                        }
                    },
                    // State borders: admin level 4 boundaries in black
                    {
                        id: 'state-borders',
                        type: 'line',
                        source: 'omt',
                        'source-layer': 'boundary',
                        filter: ['all',
                            ['==', ['get','admin_level'], 4],
                            ['!=', ['get','maritime'], 1]
                        ],
                        paint: {
                            'line-color': '#000000',
                            'line-width': ['interpolate', ['linear'], ['zoom'], 4, 1.8, 6, 2.2, 8, 3.2, 10, 4.0],
                            'line-opacity': 1.0
                        }
                    }
                ]
            },
            center: [-98.5795, 39.8283], // Center on United States
            zoom: 4,
            maxZoom: 18,
            minZoom: 2,
            renderWorldCopies: true,
            pitchWithRotate: false,
            dragRotate: false,
            fadeDuration: 200
        });

        // Expose globally for outside access (e.g., resize on tab switch)
        window.map = map;

        // Defensive: hide overlay on map errors
        try {
            map.on('error', (e) => {
                console.warn('Map error:', e && e.error ? e.error : e);
                try { hideLoadingOverlay(); } catch {}
            });
        } catch {}

        // Fallback: hide overlay after a short delay even if some layers fail
        try { setTimeout(() => { try { hideLoadingOverlay(); } catch {} }, 7000); } catch {}

        // Hide overlay when rendering becomes idle the first time
        try { map.once('idle', () => { try { hideLoadingOverlay(); } catch {} }); } catch {}

        // Last resort: global error hides overlay so user isn't stuck
        try {
            window.addEventListener('error', () => { try { hideLoadingOverlay(); } catch {} }, { once: true });
            window.addEventListener('unhandledrejection', () => { try { hideLoadingOverlay(); } catch {} }, { once: true });
        } catch {}

        // Navigation and fullscreen controls intentionally omitted for a cleaner map UI

        // Wait for map to load
        map.on('load', async () => {
            console.log('Map loaded successfully');
            try {
                const canvas = map.getCanvas();
                if (canvas) {
                    canvas.style.imageRendering = 'crisp-edges';
                }
                const container = map.getContainer ? map.getContainer() : document.getElementById('weather-map');
                if (container && container.style) {
                    container.style.textRendering = 'optimizeLegibility';
                    container.style.webkitFontSmoothing = 'antialiased';
                    container.style.mozOsxFontSmoothing = 'grayscale';
                }
            } catch {}
            // Show base layers immediately to reduce perceived load time
            try { addRadarLayer(); } catch {}
            setupMapControls();
            updateMapInfo();
            // Hide loading overlay early; data will stream in as it arrives
            hideLoadingOverlay();
            // Initialize optional overlays defaults
            addPrecipTypeLayer();
            // Prepare NHC overlay (hidden by default)
            try { ensureNHCLayer(); } catch (e) { console.warn('NHC layer init failed:', e); }
            // Mark precip button active if present
            const ptBtn = document.getElementById('preciptype-toggle');
            if (ptBtn) ptBtn.classList.add('active');
            // Initialize camera layers hidden until user toggles Cameras on
            try { ensureCameraLayers(); setCameraLayersVisibility('none'); } catch (e) { console.warn('Cameras layer init failed:', e); }
            // Initialize outage/infrastructure layers hidden by default
            try { ensurePowerOutageLayers(); setPowerOutageLayerVisibility('none'); } catch (e) { console.warn('Power outage layers init failed:', e); }
            try { ensureInfrastructureLayers(); setInfrastructureLayerVisibility('none'); } catch (e) { console.warn('Infrastructure layers init failed:', e); }
            // Begin startup preloads immediately and show bottom progress bar.
            startMapStartupProgress(['warnings', 'cameras', 'powerOutages', 'infrastructure', 'stormReports']);
            const startupLoads = [
                runMapStartupTask('warnings', async () => {
                    await loadWeatherData();
                }),
                runMapStartupTask('cameras', async () => {
                    ensureCameraLayers();
                    setCameraLayersVisibility('none');
                    await updateCamerasSource({ force: true });
                }),
                runMapStartupTask('powerOutages', async () => {
                    ensurePowerOutageLayers();
                    setPowerOutageLayerVisibility('none');
                    await refreshPowerOutageData({ force: true, allowHidden: true });
                }),
                runMapStartupTask('infrastructure', async () => {
                    ensureInfrastructureLayers();
                    setInfrastructureLayerVisibility('none');
                    await refreshInfrastructureData({ force: true, allowHidden: true });
                }),
                runMapStartupTask('stormReports', async () => {
                    const data = await fetchStormReportsGeoJSON();
                    preloadedStormReportsData = data;
                    preloadedStormReportsAt = Date.now();
                })
            ];
            Promise.allSettled(startupLoads).then(() => {
                updateMapStartupProgressUi();
            });
            // Keep label shadow and labels on top for readability (shadow below labels)
            try { if (map.getLayer('dark-labels-shadow')) map.moveLayer('dark-labels-shadow'); } catch {}
            try { if (map.getLayer('dark-labels')) map.moveLayer('dark-labels'); } catch {}
            // Prefer vector labels (white with black halo) on top; hide raster labels
            try { if (map.getLayer('dark-labels')) map.setLayoutProperty('dark-labels','visibility','none'); } catch {}
            try { if (map.getLayer('dark-labels-shadow')) map.setLayoutProperty('dark-labels-shadow','visibility','none'); } catch {}
            try { if (map.getLayer('place-labels')) map.moveLayer('place-labels'); } catch {}
            try { if (map.getLayer('state-labels')) map.moveLayer('state-labels'); } catch {}
            // Keep state borders above base but below labels for readability
            try { if (map.getLayer('state-borders')) map.moveLayer('state-borders', 'place-labels'); } catch {}

            // Remove persistent Map Status box on the map page
            try { const info = document.querySelector('.map-info'); if (info) info.remove(); } catch {}
            // Remove any fullscreen button element that might be present in the DOM
            try { const fsBtn = document.getElementById('fullscreen-btn'); if (fsBtn) fsBtn.remove(); } catch {}

            // Explicitly remove HRRR overlay if present and clear stored URL
            try { if (map.getLayer('hrrr-layer')) map.removeLayer('hrrr-layer'); } catch {}
            try { if (map.getSource('hrrr')) map.removeSource('hrrr'); } catch {}
            try { localStorage.removeItem('hrrrTileUrl'); } catch {}

            // Initialize drawing UI (top button + overlay toolbar)
            try { initDrawingUI(); } catch (e) { console.warn('Drawing UI init failed:', e); }

            // Suppress any auto "new warning" popups on the map page
            try {
                // Common helper stubs other parts of the app may call
                window.showWarningDetails = function() { /* suppressed on map */ };
                window.renderStickyLatestWarning = function() { /* suppressed on map */ };
                // Remove any existing warning popups that might have been created before map init
                document.querySelectorAll('.maplibregl-popup.warning-popup,.warning-popup').forEach(el => {
                    try { el.remove(); } catch {}
                });
                // Add CSS guard to hide MapLibre popups (except storm report popups) and style for close button
                if (!document.getElementById('map-warning-suppress-css')) {
                    const st = document.createElement('style');
                    st.id = 'map-warning-suppress-css';
                    st.textContent = `
                        #weather-map .maplibregl-popup:not(.storm-popup){display:none!important}
                        #weather-map .map-warning-close{position:absolute;top:10px;right:10px;background:rgba(255,255,255,0.1);border:1px solid rgba(255,255,255,0.2);color:#fff;border-radius:6px;width:26px;height:26px;line-height:24px;font-size:18px;font-weight:400;cursor:pointer;z-index:10050;display:flex;align-items:center;justify-content:center}
                        #weather-map .map-warning-close:hover{background:rgba(255,255,255,0.18)}
                        .maplibregl-popup-close-button{font-size:18px!important;color:rgba(255,255,255,0.9)!important;background:rgba(255,255,255,0.1)!important;border:1px solid rgba(255,255,255,0.2)!important;border-radius:6px!important;width:26px!important;height:26px!important;padding:0!important;right:10px!important;top:10px!important}
                        .maplibregl-popup-close-button:hover{background:rgba(255,255,255,0.18)!important;color:#fff!important}
                    `;
                    document.head.appendChild(st);
                }
                // Floating clear button (hidden by default) to remove any warning panel on the map page
                let clearBtn = document.getElementById('clear-warning-panels');
                if (!clearBtn) {
                    clearBtn = document.createElement('button');
                    clearBtn.id = 'clear-warning-panels';
                    clearBtn.textContent = 'Clear Panel';
                    clearBtn.title = 'Remove warning panel';
                    clearBtn.style.cssText = 'position:absolute;top:12px;left:12px;z-index:10060;background:#111827;color:#fff;border:1px solid rgba(255,255,255,.25);padding:.3rem .5rem;border-radius:8px;font-weight:800;letter-spacing:.02em;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.35);display:none;';
                    const container = map.getContainer ? map.getContainer() : document.getElementById('weather-map') || document.body;
                    container.appendChild(clearBtn);
                }
                const hideClearBtn = () => { try { clearBtn.style.display = 'none'; } catch {} };
                const showClearBtn = () => { try { clearBtn.style.display = 'inline-block'; } catch {} };
                const removePanels = () => {
                    try {
                        const container = map.getContainer ? map.getContainer() : document.getElementById('weather-map') || document.body;
                        container.querySelectorAll('[id*="warning" i], [class*="warning" i]').forEach(el => {
                            if (el.classList && el.classList.contains('storm-popup')) return;
                            try { el.remove(); } catch {}
                        });
                        hideClearBtn();
                    } catch {}
                };
                try { clearBtn.onclick = removePanels; } catch {}
                // Also allow Esc key to clear panels while on map
                if (!map.__escClearBound) {
                    map.__escClearBound = true;
                    window.addEventListener('keydown', (e) => {
                        if (e.key === 'Escape') removePanels();
                    });
                }

                // Continuously remove any non-storm popups added later and manage clear button visibility
                if (!map.__popupSuppressor) {
                    const target = map.getContainer ? map.getContainer() : document.body;
                    const ensureCloseButton = (panel) => {
                        try {
                            if (!(panel instanceof HTMLElement)) return;
                            if (!panel.dataset || panel.dataset.xAttached === '1') return;
                            panel.style.position = panel.style.position || 'relative';
                            const btn = document.createElement('button');
                            btn.className = 'map-warning-close';
                            btn.textContent = '×';
                            btn.title = 'Close';
                            btn.addEventListener('click', (e) => { e.stopPropagation(); try { panel.remove(); } catch {} });
                            panel.appendChild(btn);
                            panel.dataset.xAttached = '1';
                        } catch {}
                    };
                    const sweep = () => {
                        // Remove any MapLibre popup that isn't a storm report popup
                        document.querySelectorAll('.maplibregl-popup').forEach(el => {
                            // Keep only storm report popups (explicit class set when we create them)
                            if (!el.classList.contains('storm-popup')) {
                                try { el.remove(); } catch {}
                            }
                        });
                        // For any custom warning panels within the map, add a close button instead of deleting
                        let found = false;
                        document.querySelectorAll('[id*="warning" i], [class*="warning" i]').forEach(el => {
                            if (el.classList && el.classList.contains('storm-popup')) return;
                            const withinMap = target.contains(el) || el.closest('#weather-map');
                            if (withinMap) { ensureCloseButton(el); found = true; }
                        });
                        if (found) showClearBtn(); else hideClearBtn();
                    };
                    const mo = new MutationObserver(() => sweep());
                    try { mo.observe(target, { childList: true, subtree: true }); } catch {}
                    map.__popupSuppressor = mo;
                    // Initial sweep
                    sweep();
                }
            } catch {}
        });

        // Update map info on move/zoom
        map.on('moveend', updateMapInfo);
        map.on('moveend', () => {
            if (powerOutageState.visible) {
                schedulePowerOutageRefresh(420, false, false);
            }
            if (infrastructureState.visible) {
                scheduleInfrastructureRefresh(420, false);
            }
            if (camerasState.visible || cameraAutoCycleState.active) {
                scheduleCamerasSourceRefresh(1300, false);
            }
        });
        map.on('zoomend', updateMapInfo);

        // Hook up place search (Nominatim)
        try {
            const input = document.getElementById('place-search');
            const btn = document.getElementById('place-search-btn');
            const runSearch = async () => {
                try {
                    if (!input || !input.value.trim()) return;
                    const q = encodeURIComponent(input.value.trim());
                    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=us&q=${q}`;
                    const resp = await fetch(url, { headers: { 'Accept': 'application/json', 'User-Agent': 'js-weather-overlay/1.0 (map search)' } });
                    const data = await resp.json();
                    const hit = Array.isArray(data) && data[0];
                    if (hit) {
                        const lat = parseFloat(hit.lat), lon = parseFloat(hit.lon);
                        if (isFinite(lat) && isFinite(lon)) {
                            map.flyTo({ center: [lon, lat], zoom: Math.max(map.getZoom(), 7) });
                        }
                    }
                } catch {}
            };
            if (btn) btn.addEventListener('click', (e) => { e.preventDefault(); runSearch(); });
            if (input) input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); runSearch(); }});
        } catch {}

        // Hook up "Locate Me" button
        try {
            const locBtn = document.getElementById('locate-me-btn');
            if (locBtn) {
                locBtn.addEventListener('click', async (e) => {
                    e.preventDefault();
                    if (!navigator.geolocation) return;
                    navigator.geolocation.getCurrentPosition(async (pos) => {
                        try {
                            const { latitude, longitude } = pos.coords || {};
                            if (!isFinite(latitude) || !isFinite(longitude)) return;
                            map.flyTo({ center: [longitude, latitude], zoom: Math.max(map.getZoom(), 9) });
                            // brief pulse marker
                            const srcId = 'me-src';
                            const layerId = 'me-layer';
                            try { if (map.getLayer(layerId)) map.removeLayer(layerId); } catch {}
                            try { if (map.getSource(srcId)) map.removeSource(srcId); } catch {}
                            map.addSource(srcId, { type: 'geojson', data: { type: 'Feature', geometry: { type: 'Point', coordinates: [longitude, latitude] }}});
                            map.addLayer({ id: layerId, type: 'circle', source: srcId, paint: {
                                'circle-radius': 10,
                                'circle-color': '#4ade80',
                                'circle-opacity': 0.8,
                                'circle-stroke-color': '#000',
                                'circle-stroke-width': 2
                            }});
                            setTimeout(() => { try { if (map.getLayer(layerId)) map.removeLayer(layerId); if (map.getSource(srcId)) map.removeSource(srcId); } catch {} }, 5000);
                        } catch {}
                    }, () => {}, { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 });
                });
            }
        } catch {}

        // Wire Storm Reports and HRRR toggles
        try {
            const hrrrBtn = document.getElementById('hrrr-toggle');
            const nhcBtn = document.getElementById('nhc-toggle');
            const hresRadarBtn = document.getElementById('hres-radar-toggle');
            const radarSitesBtn = document.getElementById('radar-sites-toggle');
            if (hrrrBtn) {
                hrrrBtn.addEventListener('click', async (e) => {
                    e.preventDefault();
                    const vis = await toggleHRRRLayer();
                    hrrrBtn.classList.toggle('active', vis);
                });
            }
            if (nhcBtn) {
                nhcBtn.addEventListener('click', (e) => {
                    e.preventDefault();
                    const vis = toggleNHCLayer();
                    nhcBtn.classList.toggle('active', vis);
                });
            }
            if (hresRadarBtn) {
                hresRadarBtn.addEventListener('click', (e) => {
                    e.preventDefault();
                    const vis = toggleHiResRadarLayer();
                    hresRadarBtn.classList.toggle('active', vis);
                });
            }
            if (radarSitesBtn) {
                radarSitesBtn.addEventListener('click', async (e) => {
                    e.preventDefault();
                    const vis = await toggleRadarSitesLayer();
                    radarSitesBtn.classList.toggle('active', vis);
                });
            }
        } catch {}

    } catch (error) {
        console.error('Error initializing weather map:', error);
        showError('Failed to initialize weather map');
    }
}

// Load weather warnings data
async function loadWeatherData(options = {}) {
    const waitForZoneEnrichment = !!options.waitForZoneEnrichment;
    if (isWeatherDataLoading) {
        return;
    }
    isWeatherDataLoading = true;
    const loadSeq = ++warningLoadSequence;
    try {
        console.log('Loading weather warnings...');
        
        // Fetch active weather warnings from NWS API
        const response = await fetch('https://api.weather.gov/alerts/active');
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        const data = await response.json();
        weatherWarnings = (data.features || []).filter(f => {
            try { return !/hydrologic\s+outlook/i.test(String(f?.properties?.event || '')); } catch { return true; }
        });

        // Add radar layer first (so warnings can be drawn above it)
        addRadarLayer();

        // Ensure warnings layers exist, then render immediately using native alert geometries.
        ensureWarningLayers();
        updateWarningsSource();
        try { renderStickyLatestWarning(); } catch {}

        console.log(`Loaded ${weatherWarnings.length} weather warnings`);

        const hasMissingZoneGeometry = weatherWarnings.some((f) => {
            if (!f || f.geometry) return false;
            const zones = (f.properties && f.properties.affectedZones) || [];
            return Array.isArray(zones) && zones.length > 0;
        });
        if (!hasMissingZoneGeometry) return;

        const enrichAndApply = async () => {
            const enrichedCount = await enrichWarningsWithZoneGeometry(weatherWarnings);
            if (!enrichedCount) return;
            // Ignore stale enrich completions from older fetch cycles.
            if (loadSeq !== warningLoadSequence) return;
            updateWarningsSource();
            try { renderStickyLatestWarning(); } catch {}
            console.log(`Enhanced ${enrichedCount} warnings with zone polygons`);
        };

        if (waitForZoneEnrichment) {
            await enrichAndApply();
        } else {
            enrichAndApply().catch((err) => {
                console.warn('Background warning-zone enrichment failed', err);
            });
        }
        
    } catch (error) {
        console.error('Error loading weather data:', error);
        showError('Failed to load weather data');
    } finally {
        isWeatherDataLoading = false;
    }
}

// Build a FeatureCollection of warnings that have geometry
let lastRenderedWarningsCount = 0;
function buildWarningsFeatureCollection() {
    // Prefer the global display mapping and color function from script.js
    const globalGetDisplay = (typeof window !== 'undefined' && typeof window.getDisplayEventName === 'function') ? window.getDisplayEventName : null;
    const globalGetColor = (typeof window !== 'undefined' && typeof window.getEventColor === 'function') ? window.getEventColor : null;
    const globalMap = (typeof window !== 'undefined' && window.EVENT_COLOR_MAP && typeof window.EVENT_COLOR_MAP.get === 'function') ? window.EVENT_COLOR_MAP : null;

    const localFallbackDisplay = (event, props) => {
        const e = (event || '').toUpperCase();
        const headline = (props?.headline || '').toUpperCase();
        const description = (props?.description || '').toUpperCase();
        if (e === 'TORNADO EMERGENCY' || headline.includes('TORNADO EMERGENCY') || description.includes('TORNADO EMERGENCY')) {
            return 'TORNADO EMERGENCY';
        }
        if (e === 'FLASH FLOOD EMERGENCY' || headline.includes('FLASH FLOOD EMERGENCY') || description.includes('FLASH FLOOD EMERGENCY')) {
            return 'FLASH FLOOD EMERGENCY';
        }
        if (e.includes('HURRICANE') && e.includes('WARNING')) return 'HURRICANE WARNING';
        if (e.includes('TROPICAL STORM') && e.includes('WARNING')) return 'TROPICAL STORM WARNING';
        return e.trim();
    };

    const getColorForEvent = (event, props) => {
        try {
            const display = (globalGetDisplay ? globalGetDisplay(event, props) : localFallbackDisplay(event, props));
            if (globalGetColor) {
                const c = globalGetColor(display);
                if (c) return c;
            }
            if (globalMap) {
                const key = String(display || '').toUpperCase();
                const c2 = globalMap.get(key);
                if (c2) return c2;
            }
        } catch {}
        return '#ffffff';
    };

    let features = (weatherWarnings || [])
        .filter(f => f && f.geometry && f.properties && !/hydrologic\s+outlook/i.test(String(f.properties.event || '')))
        .map(f => {
            try {
                const props = { ...(f.properties || {}) };
                const color = getColorForEvent(props.event, props);
                props._color = color;
                return { type: 'Feature', id: f.id, properties: props, geometry: f.geometry };
            } catch {
                return f; // fallback as-is
            }
        });

    // Group features that were issued together so they render as one MultiPolygon
    features = dissolveWarningsByIssuance(features);
    lastRenderedWarningsCount = features.length;
    return { type: 'FeatureCollection', features };
}

// Create warnings source and layers once
function ensureWarningLayers() {
    if (!map) return;
    const srcId = 'warnings';
    const fillId = 'warnings-fill';
    const lineId = 'warnings-outline';
    const pointId = 'warnings-points';

    if (!map.getSource(srcId)) {
        map.addSource(srcId, { type: 'geojson', data: buildWarningsFeatureCollection(), generateId: true });
    }

    // Color for layers pulled from per-feature _color to match warning cards exactly
    const colorMatch = ['coalesce', ['get', '_color'], '#ffffff'];

    const fillOpacity = ['match', ['get', 'event'],
        'PDS Tornado Warning', 0.65,
        'Tornado Emergency', 0.65,
        'Hurricane Warning', 0.55,
        'Hurricane Force Wind Warning', 0.55,
        'Tropical Storm Warning', 0.55,
        'Storm Surge Warning', 0.55,
        'Severe Thunderstorm Watch', 0.38,
        'Flash Flood Watch', 0.38,
        'Flood Watch', 0.38,
        'Hurricane Watch', 0.38,
        'Tropical Storm Watch', 0.38,
        'Storm Surge Watch', 0.38,
        'Winter Storm Watch', 0.38,
        /* default */ 0.34];

    if (!map.getLayer(fillId)) {
        map.addLayer({
            id: fillId,
            type: 'fill',
            source: srcId,
            paint: {
                'fill-color': colorMatch,
                'fill-opacity': fillOpacity
            }
        });
        warningLayers.push(fillId);
    }

    if (!map.getLayer(lineId)) {
        map.addLayer({
            id: lineId,
            type: 'line',
            source: srcId,
            paint: {
                'line-color': colorMatch,
                'line-width': 2,
                'line-opacity': 0.9
            }
        });
        warningLayers.push(lineId);
    }

    // Ensure radar sits beneath fills (for tint) and outlines stay on top to mask edges
    try {
        if (map.getLayer('radar-layer') && map.getLayer(fillId)) {
            map.moveLayer('radar-layer', fillId);
        }
    } catch {}
    try {
        if (map.getLayer(lineId)) {
            map.moveLayer(lineId);
        }
    } catch {}

    // Points for warnings that come as Point geometry
    if (!map.getLayer(pointId)) {
        map.addLayer({
            id: pointId,
            type: 'circle',
            source: srcId,
            filter: ['==', ['geometry-type'], 'Point'],
            paint: {
                'circle-radius': [
                    'interpolate', ['linear'], ['zoom'],
                    4, 4,
                    8, 6,
                    12, 8
                ],
                'circle-color': colorMatch,
                'circle-opacity': 0.9,
                'circle-stroke-color': '#ffffff',
                'circle-stroke-width': 1.5,
                'circle-stroke-opacity': 0.9
            }
        });
        warningLayers.push(pointId);
    }

    // Click handling: support overlapping warnings via a selection menu
    if (!map.__warningsClickBound) {
        const handleClick = (e) => {
            if (handleFrontOverlayClickPriority(e)) return;
            if (clickHitsCameraOrInfrastructure(e?.point)) return;
            const stamp = e?.originalEvent?.timeStamp;
            if (stamp && map.__lastCompositeClickStamp === stamp) return;
            if (stamp) map.__lastCompositeClickStamp = stamp;

            const items = buildCombinedClickItemsFromPoint(e.point);
            if (!items.length) return;
            if (items.length === 1) {
                openCombinedClickItem(items[0], e.lngLat);
                return;
            }
            showOverlappingMenu(items, e.lngLat);
        };
        map.on('click', fillId, handleClick);
        map.on('click', pointId, handleClick);
        map.on('mouseenter', fillId, () => { map.getCanvas().style.cursor = 'pointer'; });
        map.on('mouseleave', fillId, () => { map.getCanvas().style.cursor = ''; });
        map.on('mouseenter', pointId, () => { map.getCanvas().style.cursor = 'pointer'; });
        map.on('mouseleave', pointId, () => { map.getCanvas().style.cursor = ''; });
        map.__warningsClickBound = true;
    }
    bringCameraAndInfrastructureLayersToFront();
}

// Update the warnings source data without recreating layers
function updateWarningsSource() {
    if (!map) return;
    const src = map.getSource('warnings');
    const fc = buildWarningsFeatureCollection();
    if (src && src.setData) {
        src.setData(fc);
    }
}

// Add radar layer to the map
function addRadarLayer() {
    if (!map) return;

    const sourceId = 'radar';
    const layerId = 'radar-layer';
    const freshTiles = buildFreshRadarTileUrls();

    // Add or update radar source
    const existingSource = map.getSource(sourceId);
    if (existingSource) {
        if (typeof existingSource.setTiles === 'function') {
            existingSource.setTiles(freshTiles);
        } else {
            if (map.getLayer(layerId)) {
                map.setLayoutProperty(layerId, 'visibility', 'visible');
            } else {
                map.addSource(sourceId, {
                    type: 'raster',
                    tiles: freshTiles,
                    tileSize: 256
                });
                map.addLayer({
                    id: layerId,
                    type: 'raster',
                    source: sourceId,
                    paint: {
                        'raster-opacity': 0.55
                    }
                });
            }
        }
    } else {
        map.addSource(sourceId, {
            type: 'raster',
            tiles: freshTiles,
            tileSize: 256
        });
        map.addLayer({
            id: layerId,
            type: 'raster',
            source: sourceId,
            paint: {
                'raster-opacity': 0.55
            }
        });
    }

    // Add precipitation type layer
    if (!map.getSource('precipitation-type')) {
        addPrecipitationTypeLayer();
    } else {
        map.setLayoutProperty('precipitation-type-layer', 'visibility', 'visible');
    }

    radarLayer = layerId;
}

// Add precipitation type layer to the map (NEXRAD precipitation type - rain, snow, sleet, freezing rain)
function addPrecipitationTypeLayer() {
    if (!map) return;

    const sourceId = 'precipitation-type';
    const layerId = 'precipitation-type-layer';
    // Iowa State Mesonet: CONUS precipitation type mosaic with color-coded rain/snow/sleet/freezing rain
    const url = 'https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/ridge_radar_n0r_ptype_webmerc/{z}/{x}/{y}.png';

    if (map.getSource(sourceId)) {
        if (map.getLayer(layerId)) {
            map.removeLayer(layerId);
        }
        map.removeSource(sourceId);
    }

    map.addSource(sourceId, {
        type: 'raster',
        tiles: [url],
        tileSize: 256,
        minzoom: 0,
        maxzoom: 10
    });

    map.addLayer({
        id: layerId,
        type: 'raster',
        source: sourceId,
        paint: {
            'raster-opacity': 0.85,
            'raster-opacity-transition': { duration: 300 }
        }
    });
    // Ensure precip type is above radar so rain/snow/sleet/freezing rain colors show on top
    try {
        if (map.getLayer('radar-layer')) map.moveLayer('radar-layer', layerId);
    } catch {}

    return layerId;
}

// Add satellite layer to the map
function addSatelliteLayer() {
    if (!map) return;

    // Remove existing satellite layer
    if (satelliteLayer && map.getLayer(satelliteLayer)) {
        map.removeLayer(satelliteLayer);
    }
    if (map.getSource('satellite')) {
        map.removeSource('satellite');
    }

    // Add satellite source (using a sample satellite tile service)
    map.addSource('satellite', {
        type: 'raster',
        tiles: [
            'https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/goes-16-900913/{z}/{x}/{y}.png'
        ],
        tileSize: 256,
        opacity: 0.7
    });

    // Add satellite layer
    map.addLayer({
        id: 'satellite-layer',
        type: 'raster',
        source: 'satellite',
        paint: {
            'raster-opacity': 0.7
        }
    });

    satelliteLayer = 'satellite-layer';
}

// Setup map control buttons
function bindMapHeaderControlButton(button, handler) {
    if (!button || typeof handler !== 'function') return;
    const key = String(handler.name || 'handler');
    if (!button.__mapHeaderBoundHandlers) button.__mapHeaderBoundHandlers = {};
    if (button.__mapHeaderBoundHandlers[key]) return;
    button.__mapHeaderBoundHandlers[key] = true;
    try { button.setAttribute('type', 'button'); } catch {}
    // Clear inline/property handlers and use an explicit listener for reliability.
    try { button.onclick = null; } catch {}
    try { button.removeAttribute('onclick'); } catch {}
    button.addEventListener('click', (event) => {
        triggerMapButtonClickAnimation(button);
        try {
            event && event.preventDefault && event.preventDefault();
            event && event.stopPropagation && event.stopPropagation();
        } catch {}
        handler(event);
    });
}

function triggerMapButtonClickAnimation(button) {
    if (!button || !button.classList) return;
    button.classList.remove('map-btn-click-anim');
    try { void button.offsetWidth; } catch {}
    button.classList.add('map-btn-click-anim');
}

function normalizeSpcDay(day) {
    if (typeof day !== 'string') return 'day1';
    const normalized = day.trim().toLowerCase();
    return SPC_SUPPORTED_DAYS.includes(normalized) ? normalized : 'day1';
}

function isSpcExtendedRangeDay(day) {
    return SPC_EXTENDED_DAYS.includes(normalizeSpcDay(day));
}

function getSpcSelectableCategories(day = spcOutlookState.day) {
    const normalizedDay = normalizeSpcDay(day);
    if (isSpcExtendedRangeDay(normalizedDay)) return ['prob'];
    if (normalizedDay === 'day3') return ['cat', 'prob'];
    return ['cat', 'torn', 'wind', 'hail'];
}

function sanitizeSpcCategoryForDay(day, category, fallbackConvectiveCategory = spcOutlookLastConvectiveCategory || 'cat') {
    const normalizedDay = normalizeSpcDay(day);
    const normalizedCategory = typeof category === 'string' ? category.trim().toLowerCase() : '';
    if (isSpcExtendedRangeDay(normalizedDay)) return 'prob';
    if (normalizedDay === 'day3') {
        if (normalizedCategory === 'cat' || normalizedCategory === 'prob') return normalizedCategory;
        return 'prob';
    }
    if (normalizedCategory === 'cat' || normalizedCategory === 'torn' || normalizedCategory === 'wind' || normalizedCategory === 'hail') {
        return normalizedCategory;
    }
    return fallbackConvectiveCategory || 'cat';
}

function getSpcLegendSetKey() {
    if (isSpcExtendedRangeDay(spcOutlookState.day)) return 'prob';
    if (normalizeSpcDay(spcOutlookState.day) === 'day3' && spcOutlookState.category === 'prob') return 'probDay3';
    return spcOutlookState.category || 'cat';
}

function syncSpcCategoryUi() {
    const spcCategoryButton = document.getElementById('spc-category-button');
    const spcCategoryLabel = document.getElementById('spc-category-label');
    const spcCategoryMenu = document.getElementById('spc-category-menu');
    const normalizedDay = normalizeSpcDay(spcOutlookState.day);
    const extendedDay = isSpcExtendedRangeDay(normalizedDay);
    const allowedCategories = getSpcSelectableCategories(normalizedDay);
    const normalizedCategory = sanitizeSpcCategoryForDay(normalizedDay, spcOutlookState.category);
    if (spcOutlookState.category !== normalizedCategory) {
        spcOutlookState.category = normalizedCategory;
    }

    if (spcCategoryLabel) {
        const key = extendedDay ? 'prob' : (spcOutlookState.category || 'cat');
        spcCategoryLabel.textContent = SPC_CATEGORY_LABELS[key] || 'Categorical';
    }

    if (spcCategoryButton) {
        spcCategoryButton.classList.toggle('is-disabled', extendedDay);
        if (extendedDay) {
            spcCategoryButton.setAttribute('aria-disabled', 'true');
            spcCategoryButton.setAttribute('title', 'Days 4-8 are probabilistic only.');
        } else {
            spcCategoryButton.removeAttribute('aria-disabled');
            spcCategoryButton.removeAttribute('title');
        }
    }

    if (spcCategoryMenu) {
        if (extendedDay) spcCategoryMenu.setAttribute('hidden', '');
        spcCategoryMenu.querySelectorAll('button[data-category]').forEach(btn => {
            const category = String(btn.getAttribute('data-category') || '').trim().toLowerCase();
            const supported = !extendedDay && allowedCategories.includes(category);
            if (supported) {
                btn.removeAttribute('hidden');
                btn.removeAttribute('aria-disabled');
            } else {
                btn.setAttribute('hidden', '');
                btn.setAttribute('aria-disabled', 'true');
            }
        });
        highlightActiveMenuItem(spcCategoryMenu, extendedDay ? '' : spcOutlookState.category, 'data-category');
    }
}

async function applySpcDaySelection(day, opts = {}) {
    const spcOutlookToggle = opts.spcOutlookToggle || getSpcOutlookToggleButton();
    const spcDayMenu = opts.spcDayMenu || document.getElementById('spc-day-menu');
    const spcCategoryContainer = opts.spcCategoryContainer || document.getElementById('spc-category-container');
    if (!day) return;

    const normalizedDay = normalizeSpcDay(day);
    spcOutlookState.day = normalizedDay;
    const nextCategory = sanitizeSpcCategoryForDay(normalizedDay, spcOutlookState.category);
    spcOutlookState.category = nextCategory;
    if (nextCategory !== 'prob') {
        spcOutlookLastConvectiveCategory = nextCategory;
    }

    if (spcDayMenu) spcDayMenu.setAttribute('hidden', '');
    if (spcOutlookToggle) spcOutlookToggle.classList.add('active');
    if (spcCategoryContainer) spcCategoryContainer.removeAttribute('hidden');
    if (spcDayMenu) highlightActiveMenuItem(spcDayMenu, normalizedDay, 'data-day');
    syncSpcCategoryUi();

    try {
        await ensureSpcOutlookLayerVisible();
    } catch (e) {
        console.warn('SPC day selection failed:', e);
        // Fallback path in case source update throws during a refresh race.
        try {
            await addSpcOutlookLayer();
            if (spcOutlookLayerId && map?.getLayer(spcOutlookLayerId)) {
                map.setLayoutProperty(spcOutlookLayerId, 'visibility', 'visible');
            }
            if (spcOutlookOutlineLayerId && map?.getLayer(spcOutlookOutlineLayerId)) {
                map.setLayoutProperty(spcOutlookOutlineLayerId, 'visibility', 'visible');
            }
            spcOutlookState.visible = true;
        } catch (fallbackErr) {
            console.warn('SPC fallback failed:', fallbackErr);
        }
    }
    updateLegendBar();
}

function bindSpcDayMenuHandlers(spcDayMenu, spcOutlookToggle, spcCategoryContainer) {
    if (!spcDayMenu) return;
    if (spcDayMenu.__spcDayMenuBound) return;
    spcDayMenu.__spcDayMenuBound = true;
    spcDayMenu.addEventListener('click', async (event) => {
        const target = event.target;
        const btn = target && typeof target.closest === 'function' ? target.closest('button') : null;
        if (!btn || !spcDayMenu.contains(btn)) return;
        try {
            event.preventDefault();
            event.stopPropagation();
            if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();
        } catch {}

        const action = btn.getAttribute('data-action');
        if (action === 'hide') {
            hideSpcOutlook({ fromUser: true });
            spcDayMenu.setAttribute('hidden', '');
            return;
        }

        const day = btn.getAttribute('data-day');
        if (!day) return;
        await applySpcDaySelection(day, { spcOutlookToggle, spcDayMenu, spcCategoryContainer });
    });
}

function getSpcOutlookToggleButton() {
    return document.getElementById('map-spc-outlook-btn') || document.getElementById('spc-outlook-toggle');
}

function getStormReportsToggleButton() {
    return document.getElementById('map-storm-reports-btn') || document.getElementById('storm-reports-toggle');
}

function getPowerOutagesToggleButton() {
    return document.getElementById('map-outages-toggle') || document.getElementById('outages-toggle');
}

function getInfrastructureToggleButton() {
    return document.getElementById('map-infra-toggle') || document.getElementById('infrastructure-toggle');
}

function getDrawToggleTopButton() {
    return document.getElementById('map-draw-btn') || document.getElementById('draw-toggle-top');
}

function bindMapHeaderClickBridge() {
    if (document.__mapHeaderClickBridgeBound) return;
    document.__mapHeaderClickBridgeBound = true;

    const handlerMap = {
        'map-camera-cycle-btn': toggleCameraAutoCycleHeader,
        'map-camera-settings-btn': toggleCameraCycleMenuHeader,
        'map-outages-toggle': togglePowerOutagesHeader,
        'map-infra-toggle': toggleInfrastructureHeader,
        'map-spc-outlook-btn': toggleSpcOutlookHeader,
        'map-storm-reports-btn': toggleStormReportsHeader,
        // Fallback for legacy markup
        'camera-cycle-toggle': toggleCameraAutoCycleHeader,
        'camera-settings-toggle': toggleCameraCycleMenuHeader,
        'outages-toggle': togglePowerOutagesHeader,
        // Fallback for legacy markup
        'infrastructure-toggle': toggleInfrastructureHeader,
        // Fallbacks for legacy markup
        'spc-outlook-toggle': toggleSpcOutlookHeader,
        'storm-reports-toggle': toggleStormReportsHeader
    };

    const onDocClickCapture = (event) => {
        try {
            if (!document.body || !document.body.classList.contains('map-view')) return;
            const section = document.getElementById('map-section');
            if (!section || section.style.display === 'none') return;

            const target = event.target;
            const targetEl = (target && target.nodeType === 1) ? target : (target && target.parentElement ? target.parentElement : null);

            // Do not hijack clicks that belong to blocking overlays/modals.
            if (targetEl && typeof targetEl.closest === 'function') {
                const withinBlockingOverlay = targetEl.closest(
                    '#storm-reports-dashboard-overlay,' +
                    '#storm-reports-fallback-overlay,' +
                    '.storm-desk-overlay,' +
                    '.warning-modal-overlay,' +
                    '.forecast-settings-modal,' +
                    '#map-settings-modal'
                );
                if (withinBlockingOverlay) return;
            }

            if (target && typeof target.closest === 'function') {
                const directBtn = target.closest('#map-camera-cycle-btn,#map-camera-settings-btn,#map-outages-toggle,#map-infra-toggle,#map-spc-outlook-btn,#map-storm-reports-btn,#camera-cycle-toggle,#camera-settings-toggle,#outages-toggle,#infrastructure-toggle,#spc-outlook-toggle,#storm-reports-toggle');
                if (directBtn && directBtn.id && handlerMap[directBtn.id]) {
                    try {
                        event.preventDefault();
                        event.stopPropagation();
                        if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();
                    } catch {}
                    triggerMapButtonClickAnimation(directBtn);
                    try { handlerMap[directBtn.id](event); } catch {}
                    return;
                }
            }

            const x = Number(event.clientX);
            const y = Number(event.clientY);
            if (!Number.isFinite(x) || !Number.isFinite(y)) return;

            for (const [id, fn] of Object.entries(handlerMap)) {
                const btn = document.getElementById(id);
                if (!btn) continue;
                const rect = btn.getBoundingClientRect();
                if (rect.width < 2 || rect.height < 2) continue;
                if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
                    try {
                        event.preventDefault();
                        event.stopPropagation();
                        if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();
                    } catch {}
                    triggerMapButtonClickAnimation(btn);
                    try { fn(event); } catch {}
                    return;
                }
            }
        } catch {}
    };

    document.addEventListener('click', onDocClickCapture, true);
}

function setupMapControls() {
    bindMapHeaderClickBridge();
    loadCameraCycleSettings();
    ensureCameraCycleMenuStyle();

    // Radar toggle
    const radarToggle = document.getElementById('radar-toggle');
    if (radarToggle) {
        radarToggle.onclick = (event) => {
            triggerMapButtonClickAnimation(radarToggle);
            try { event && event.preventDefault && event.preventDefault(); } catch {}
            toggleLayer('radar');
        };
    }

    // Warnings toggle
    const warningsToggle = document.getElementById('warnings-toggle');
    if (warningsToggle) {
        warningsToggle.onclick = (event) => {
            triggerMapButtonClickAnimation(warningsToggle);
            try { event && event.preventDefault && event.preventDefault(); } catch {}
            toggleLayer('warnings');
        };
    }

    // Satellite toggle
    const satelliteToggle = document.getElementById('satellite-toggle');
    if (satelliteToggle) {
        satelliteToggle.onclick = (event) => {
            triggerMapButtonClickAnimation(satelliteToggle);
            try { event && event.preventDefault && event.preventDefault(); } catch {}
            toggleLayer('satellite');
        };
    }

    // Precipitation Type toggle
    const precipTypeToggle = document.getElementById('preciptype-toggle');
    if (precipTypeToggle) {
        precipTypeToggle.onclick = (event) => {
            triggerMapButtonClickAnimation(precipTypeToggle);
            try { event && event.preventDefault && event.preventDefault(); } catch {}
            toggleLayer('preciptype');
        };
    }

    // SPC outlook toggle
    const spcOutlookToggle = getSpcOutlookToggleButton();
    const spcDayMenu = document.getElementById('spc-day-menu');
    const spcCategoryContainer = document.getElementById('spc-category-container');
    const spcCategoryButton = document.getElementById('spc-category-button');
    const spcCategoryMenu = document.getElementById('spc-category-menu');
    const wpcEroToggle = document.getElementById('wpc-ero-toggle');
    const wpcEroDayMenu = document.getElementById('wpc-ero-day-menu');

    if (spcOutlookToggle) {
        bindMapHeaderControlButton(spcOutlookToggle, toggleSpcOutlookHeader);
    }

    if (spcDayMenu) {
        highlightActiveMenuItem(spcDayMenu, normalizeSpcDay(spcOutlookState.day), 'data-day');
        bindSpcDayMenuHandlers(spcDayMenu, spcOutlookToggle, spcCategoryContainer);
    }

    // Infrastructure toggle
    const powerOutagesBtn = getPowerOutagesToggleButton();
    if (powerOutagesBtn) {
        bindMapHeaderControlButton(powerOutagesBtn, togglePowerOutagesHeader);
    }
    const infrastructureBtn = getInfrastructureToggleButton();
    if (infrastructureBtn) {
        bindMapHeaderControlButton(infrastructureBtn, toggleInfrastructureHeader);
    }

    const cameraCycleBtn = getCameraCycleToggleButton();
    if (cameraCycleBtn) {
        bindMapHeaderControlButton(cameraCycleBtn, toggleCameraAutoCycleHeader);
    }
    const cameraSettingsBtn = getCameraCycleSettingsButton();
    const cameraCycleMenu = getCameraCycleMenuElement();
    const cameraCycleRefreshBtn = document.getElementById('camera-cycle-refresh-btn');
    const cameraCycleInterval = document.getElementById('camera-cycle-interval');
    const cameraCycleDistance = document.getElementById('camera-cycle-distance');
    const cameraCycleMaxCams = document.getElementById('camera-cycle-maxcams');
    syncCameraCycleMenuControls();
    if (cameraSettingsBtn) {
        bindMapHeaderControlButton(cameraSettingsBtn, toggleCameraCycleMenuHeader);
    }
    if (cameraCycleInterval && !cameraCycleInterval.__cameraCycleBound) {
        cameraCycleInterval.__cameraCycleBound = true;
        cameraCycleInterval.addEventListener('change', () => applyCameraCycleSettingsFromMenu({ persist: true }));
    }
    if (cameraCycleDistance && !cameraCycleDistance.__cameraCycleBound) {
        cameraCycleDistance.__cameraCycleBound = true;
        cameraCycleDistance.addEventListener('change', () => applyCameraCycleSettingsFromMenu({ persist: true }));
    }
    if (cameraCycleMaxCams && !cameraCycleMaxCams.__cameraCycleBound) {
        cameraCycleMaxCams.__cameraCycleBound = true;
        cameraCycleMaxCams.addEventListener('change', () => applyCameraCycleSettingsFromMenu({ persist: true }));
    }
    if (cameraCycleRefreshBtn && !cameraCycleRefreshBtn.__cameraCycleBound) {
        cameraCycleRefreshBtn.__cameraCycleBound = true;
        cameraCycleRefreshBtn.addEventListener('click', async (event) => {
            try {
                event && event.preventDefault && event.preventDefault();
                event && event.stopPropagation && event.stopPropagation();
            } catch {}
            applyCameraCycleSettingsFromMenu({ persist: true });
            await updateCamerasSource({ force: true });
            if (cameraAutoCycleState.active) {
                cameraAutoCycleState.lastQueueBuiltAt = 0;
            }
        });
    }

    if (spcCategoryButton && spcCategoryMenu) {
        syncSpcCategoryUi();
        spcCategoryButton.onclick = (event) => {
            try {
                event && event.preventDefault && event.preventDefault();
                event && event.stopPropagation && event.stopPropagation();
            } catch {}
            if (isSpcExtendedRangeDay(spcOutlookState.day)) {
                syncSpcCategoryUi();
                return;
            }
            const isOpen = !spcCategoryMenu.hasAttribute('hidden');
            if (isOpen) {
                spcCategoryMenu.setAttribute('hidden', '');
            } else {
                spcCategoryMenu.removeAttribute('hidden');
            }
        };

        spcCategoryMenu.querySelectorAll('button').forEach(btn => {
            btn.onclick = async (event) => {
                try {
                    event && event.preventDefault && event.preventDefault();
                    event && event.stopPropagation && event.stopPropagation();
                } catch {}
                const cat = btn.getAttribute('data-category');
                if (!cat) return;
                if (isSpcExtendedRangeDay(spcOutlookState.day)) {
                    spcCategoryMenu.setAttribute('hidden', '');
                    return;
                }
                const allowedCategories = getSpcSelectableCategories(spcOutlookState.day);
                if (!allowedCategories.includes(cat)) {
                    spcCategoryMenu.setAttribute('hidden', '');
                    return;
                }
                spcOutlookState.category = cat;
                if (cat !== 'prob') {
                    spcOutlookLastConvectiveCategory = cat;
                }
                syncSpcCategoryUi();
                spcCategoryMenu.setAttribute('hidden', '');
                await ensureSpcOutlookLayerVisible();
                updateLegendBar();
            };
        });
    }

    if (wpcEroToggle) {
        wpcEroToggle.onclick = (event) => {
            try { event && event.preventDefault && event.preventDefault(); } catch {}
            const open = !wpcEroDayMenu?.hasAttribute('hidden');
            if (open) {
                wpcEroDayMenu.setAttribute('hidden', '');
            } else {
                openWpcEroMenu(wpcEroDayMenu);
            }
        };
    }

    if (wpcEroDayMenu) {
        highlightActiveMenuItem(wpcEroDayMenu, wpcEroState.day, 'data-day');
        wpcEroDayMenu.querySelectorAll('button').forEach(btn => {
            btn.onclick = async (event) => {
                try {
                    event && event.preventDefault && event.preventDefault();
                    event && event.stopPropagation && event.stopPropagation();
                } catch {}
                const action = btn.getAttribute('data-action');
                if (action === 'hide') {
                    hideWpcEroLayer({ fromUser: true });
                    wpcEroDayMenu.setAttribute('hidden', '');
                    return;
                }
                const day = btn.getAttribute('data-day');
                if (!day) return;
                wpcEroState.day = day;
                wpcEroDayMenu.setAttribute('hidden', '');
                wpcEroState.visible = true;
                wpcEroToggle.classList.add('active');
                highlightActiveMenuItem(wpcEroDayMenu, day, 'data-day');
                await ensureWpcEroLayerVisible();
            };
        });
    }

    if (!document.__mapMenuCloserBound) {
        document.__mapMenuCloserBound = true;
        document.addEventListener('click', (event) => {
            const target = event.target;
            if (!(target instanceof Node)) return;
            const dayMenuEl = spcDayMenu;
            const catMenuEl = spcCategoryMenu;
            const eroMenuEl = wpcEroDayMenu;
            const camMenuEl = cameraCycleMenu;
            if (dayMenuEl && !dayMenuEl.hasAttribute('hidden')) {
                const toggleContains = spcOutlookToggle && spcOutlookToggle.contains(target);
                if (!dayMenuEl.contains(target) && !toggleContains) {
                    dayMenuEl.setAttribute('hidden', '');
                }
            }
            if (catMenuEl && !catMenuEl.hasAttribute('hidden')) {
                if (!catMenuEl.contains(target) && !spcCategoryContainer?.contains(target)) {
                    catMenuEl.setAttribute('hidden', '');
                }
            }
            if (eroMenuEl && !eroMenuEl.hasAttribute('hidden')) {
                const containsToggle = wpcEroToggle && wpcEroToggle.contains(target);
                if (!eroMenuEl.contains(target) && !containsToggle) {
                    eroMenuEl.setAttribute('hidden', '');
                }
            }
            if (camMenuEl && !camMenuEl.hasAttribute('hidden')) {
                const containsToggle = cameraSettingsBtn && cameraSettingsBtn.contains(target);
                if (!camMenuEl.contains(target) && !containsToggle) {
                    camMenuEl.setAttribute('hidden', '');
                }
            }
        });
    }

    // Add storm reports toggle button
    const stormReportsBtn = getStormReportsToggleButton();
    if (stormReportsBtn) {
        bindMapHeaderControlButton(stormReportsBtn, toggleStormReportsHeader);
    }

    // Fullscreen toggle
    const fullscreenBtn = document.getElementById('fullscreen-btn');
    if (fullscreenBtn) {
        fullscreenBtn.onclick = (event) => {
            try { event && event.preventDefault && event.preventDefault(); } catch {}
            if (document.fullscreenElement) {
                document.exitFullscreen();
            } else {
                document.documentElement.requestFullscreen();
            }
        };
    }

    updateLegendBar();
}

function toggleSpcOutlookHeader(event) {
    try { event && event.preventDefault && event.preventDefault(); } catch {}
    const spcDayMenu = document.getElementById('spc-day-menu');
    if (!spcDayMenu) return false;
    const currentlyVisible = !spcDayMenu.hasAttribute('hidden');
    if (currentlyVisible) {
        spcDayMenu.setAttribute('hidden', '');
    } else {
        openSpcDayMenu(spcDayMenu);
    }
    return true;
}

function toggleStormReportsHeader(event) {
    try { event && event.preventDefault && event.preventDefault(); } catch {}
    if (!map) return false;
    const isActive = toggleStormReportsLayer();
    setButtonActive('storm-reports', isActive);
    return isActive;
}

async function togglePowerOutagesHeader(event) {
    try { event && event.preventDefault && event.preventDefault(); } catch {}
    if (!map) return false;
    const isActive = await togglePowerOutageLayer();
    setButtonActive('power-outages', isActive);
    return isActive;
}

async function toggleInfrastructureHeader(event) {
    try { event && event.preventDefault && event.preventDefault(); } catch {}
    if (!map) return false;
    const isActive = await toggleInfrastructureLayer();
    setButtonActive('infrastructure', isActive);
    return isActive;
}

function toggleDrawHeader(event) {
    try { event && event.preventDefault && event.preventDefault(); } catch {}
    try { initDrawingUI(); } catch {}
    setDrawingActive(!drawingActive);
    return drawingActive;
}

// Toggle map layers
async function toggleLayer(layerType) {
    const button = document.querySelector(`[data-layer="${layerType}"]`);
    if (!button || !map) {
        updateLegendBar();
        return;
    }

    const isActive = button.classList.contains('active');

    switch (layerType) {
        case 'radar':
            if (isActive) {
                if (radarLayer && map.getLayer(radarLayer)) {
                    map.setLayoutProperty(radarLayer, 'visibility', 'none');
                }
                if (map.getLayer('precipitation-type-layer')) {
                    map.setLayoutProperty('precipitation-type-layer', 'visibility', 'none');
                }
                button.classList.remove('active');
            } else {
                if (radarLayer && map.getLayer(radarLayer)) {
                    map.setLayoutProperty(radarLayer, 'visibility', 'visible');
                } else {
                    addRadarLayer();
                }
                if (map.getLayer('precipitation-type-layer')) {
                    map.setLayoutProperty('precipitation-type-layer', 'visibility', 'visible');
                } else {
                    addPrecipitationTypeLayer();
                }
                button.classList.add('active');
            }
            break;

        case 'warnings':
            if (isActive) {
                warningLayers.forEach(layerId => {
                    if (map.getLayer(layerId)) {
                        map.setLayoutProperty(layerId, 'visibility', 'none');
                    }
                });
                if (cameraAutoCycleState.active) {
                    stopCameraAutoCycle();
                }
                button.classList.remove('active');
            } else {
                warningLayers.forEach(layerId => {
                    if (map.getLayer(layerId)) {
                        map.setLayoutProperty(layerId, 'visibility', 'visible');
                    }
                });
                button.classList.add('active');
            }
            break;

        case 'infrastructure': {
            const infraActive = await toggleInfrastructureLayer();
            setButtonActive('infrastructure', infraActive);
            break;
        }

        case 'power-outages': {
            const outagesActive = await togglePowerOutageLayer();
            setButtonActive('power-outages', outagesActive);
            break;
        }

        case 'satellite':
            if (isActive) {
                if (satelliteLayer && map.getLayer(satelliteLayer)) {
                    map.setLayoutProperty(satelliteLayer, 'visibility', 'none');
                }
                button.classList.remove('active');
            } else {
                if (satelliteLayer && map.getLayer(satelliteLayer)) {
                    map.setLayoutProperty(satelliteLayer, 'visibility', 'visible');
                } else {
                    addSatelliteLayer();
                }
                button.classList.add('active');
            }
            break;

        case 'preciptype':
            if (isActive) {
                if (precipTypeLayer && map.getLayer(precipTypeLayer)) {
                    map.setLayoutProperty(precipTypeLayer, 'visibility', 'none');
                }
                button.classList.remove('active');
            } else {
                if (precipTypeLayer && map.getLayer(precipTypeLayer)) {
                    map.setLayoutProperty(precipTypeLayer, 'visibility', 'visible');
                } else {
                    addPrecipTypeLayer();
                }
                button.classList.add('active');
            }
            break;

        case 'spc-outlook':
            if (spcOutlookState.visible) {
                hideSpcOutlook({ fromUser: true });
            } else {
                openSpcDayMenu(document.getElementById('spc-day-menu'));
            }
            updateLegendBar();
            return;

        case 'wpc-ero':
            if (wpcEroState.visible) {
                hideWpcEroLayer({ fromUser: true });
            } else {
                openWpcEroMenu(document.getElementById('wpc-ero-day-menu'));
            }
            updateLegendBar();
            return;

        default:
            break;
    }

    updateLegendBar();
}

async function ensureSpcOutlookLayerVisible() {
    await addSpcOutlookLayer();
    if (spcOutlookLayerId && map.getLayer(spcOutlookLayerId)) {
        map.setLayoutProperty(spcOutlookLayerId, 'visibility', 'visible');
    }
    if (spcOutlookOutlineLayerId && map.getLayer(spcOutlookOutlineLayerId)) {
        map.setLayoutProperty(spcOutlookOutlineLayerId, 'visibility', 'visible');
    }
    const button = document.querySelector('[data-layer="spc-outlook"]');
    if (button) button.classList.add('active');
    const catContainer = document.getElementById('spc-category-container');
    if (catContainer) catContainer.removeAttribute('hidden');
    syncSpcCategoryUi();

    if (!spcOutlookState.visible) {
        spcOutlookPreviousState = captureLayerStates();
    }
    applyOutlookFocus();
    spcOutlookState.visible = true;
    updateLegendBar();
}

function getSpcFillColorExpression() {
    return [
        'case',
        ['!=', ['coalesce', ['get', 'fill'], ['get', 'spc_fill'], ''], ''],
        ['coalesce', ['get', 'fill'], ['get', 'spc_fill']],
        ['match', ['to-number', ['coalesce', ['get', 'spc_rank'], ['get', 'DN'], -1]], 2, '#C1E9C1', 3, '#B7E496', 4, '#FFE066', 5, '#FFA647', 6, '#FF4D4D', 8, '#D433FF', 10, '#5DAEFF', 15, '#ffeb7f', 30, '#ff6b6b', 45, '#ff4c4c', 60, '#d433ff', 'rgba(0,0,0,0)']
    ];
}

function getSpcFillOpacityExpression() {
    return [
        'case',
        ['!=', ['coalesce', ['get', 'fill'], ['get', 'spc_fill'], ''], ''],
        0.3,
        ['>=', ['to-number', ['coalesce', ['get', 'spc_rank'], ['get', 'DN'], 0]], 2],
        0.28,
        0
    ];
}

function getSpcLineColorExpression() {
    return [
        'case',
        ['!=', ['coalesce', ['get', 'stroke'], ['get', 'spc_stroke'], ''], ''],
        ['coalesce', ['get', 'stroke'], ['get', 'spc_stroke']],
        ['match', ['to-number', ['coalesce', ['get', 'spc_rank'], ['get', 'DN'], -1]], 2, '#55BB55', 3, '#4B8B3B', 4, '#DDAA00', 5, '#CC6D1A', 6, '#C53030', 8, '#8B00D9', 10, '#1F6FBF', 15, '#ff9600', 30, '#ff3d3d', 45, '#d433ff', 60, '#8b00d9', 'rgba(0,0,0,0)']
    ];
}

function getSpcLineOpacityExpression() {
    return [
        'case',
        ['!=', ['coalesce', ['get', 'stroke'], ['get', 'spc_stroke'], ''], ''],
        0.9,
        ['>=', ['to-number', ['coalesce', ['get', 'spc_rank'], ['get', 'DN'], 0]], 2],
        0.88,
        0
    ];
}

function parseSpcProbabilityValue(value) {
    if (typeof value !== 'string') return null;
    const raw = value.trim();
    if (!raw) return null;
    if (/less\s+than/i.test(raw)) return 0;
    const pctMatch = raw.match(/(\d{1,2})\s*%/);
    if (pctMatch) {
        const pct = Number(pctMatch[1]);
        return Number.isFinite(pct) ? pct : null;
    }
    const numeric = Number.parseFloat(raw);
    if (!Number.isFinite(numeric)) return null;
    if (numeric > 0 && numeric < 1) return Math.round(numeric * 100);
    if (numeric >= 1 && numeric <= 100) return Math.round(numeric);
    return null;
}

function getSpcFallbackStyle({ day, category, dn, label, label2 }) {
    const text = `${String(label || '')} ${String(label2 || '')}`.toUpperCase();
    if (/^CIG\d*/i.test(String(label || '').trim())) {
        return { fill: '#888888', stroke: '#000000' };
    }
    if (text.includes('PREDICTABILITY TOO LOW') || /LESS\s+THAN/.test(text) || dn === 0) {
        return { fill: '', stroke: '' };
    }

    if (category === 'cat') {
        if (text.includes('TSTM') || text.includes('GENERAL THUNDERSTORMS') || dn === 2) return { fill: '#C1E9C1', stroke: '#55BB55' };
        if (text.includes('MRGL') || text.includes('MARGINAL') || dn === 3) return { fill: '#B7E496', stroke: '#4B8B3B' };
        if (text.includes('SLGT') || text.includes('SLIGHT') || dn === 4) return { fill: '#FFE066', stroke: '#DDAA00' };
        if (text.includes('ENH') || text.includes('ENHANCED') || dn === 5) return { fill: '#FFA647', stroke: '#CC6D1A' };
        if (text.includes('MDT') || text.includes('MODERATE') || dn === 6) return { fill: '#FF4D4D', stroke: '#C53030' };
        if (text.includes('HIGH') || dn === 8) return { fill: '#D433FF', stroke: '#8B00D9' };
        return { fill: '', stroke: '' };
    }

    const normalizedDay = normalizeSpcDay(day);
    const normalizedCategory = sanitizeSpcCategoryForDay(normalizedDay, category);
    if (normalizedDay === 'day3' && normalizedCategory === 'prob') {
        if (dn === 5) return { fill: '#9BD4FF', stroke: '#4E8DC2' };
        if (dn === 15) return { fill: '#FFEB7F', stroke: '#D7A500' };
        if (dn === 30) return { fill: '#FF6B6B', stroke: '#C43D3D' };
    }

    if (isSpcExtendedRangeDay(normalizedDay) || normalizedCategory === 'prob') {
        if (dn === 15) return { fill: '#FFEB7F', stroke: '#D7A500' };
        if (dn === 30) return { fill: '#FF6B6B', stroke: '#C43D3D' };
    }

    if (normalizedCategory === 'torn') {
        if (dn === 2) return { fill: '#B4DBFF', stroke: '#5D8BC1' };
        if (dn === 5) return { fill: '#6FB7FF', stroke: '#3C7FBA' };
        if (dn === 10) return { fill: '#2F89FF', stroke: '#1F5DAE' };
        if (dn === 15) return { fill: '#FFB347', stroke: '#CC7A1C' };
        if (dn === 30) return { fill: '#FF6B6B', stroke: '#C43D3D' };
        if (dn === 45) return { fill: '#D433FF', stroke: '#8B00D9' };
    } else {
        if (dn === 5) return { fill: '#9BD4FF', stroke: '#4E8DC2' };
        if (dn === 15) return { fill: '#6FB7FF', stroke: '#3E84C4' };
        if (dn === 30) return { fill: '#2986FF', stroke: '#1A55A6' };
        if (dn === 45) return { fill: '#FFA600', stroke: '#CC6D1A' };
        if (dn === 60) return { fill: '#FF4C4C', stroke: '#C53030' };
    }

    return { fill: '', stroke: '' };
}

function normalizeSpcOutlookGeoJson(geojson, { day, category }) {
    const features = Array.isArray(geojson?.features) ? geojson.features : [];
    const normalizedFeatures = features.map(feature => {
        if (!feature || typeof feature !== 'object') return null;
        const properties = { ...(feature.properties || {}) };
        const dnValue = Number.parseFloat(String(properties.DN ?? ''));
        const dn = Number.isFinite(dnValue) ? dnValue : parseSpcProbabilityValue(String(properties.LABEL || ''));
        const fallback = getSpcFallbackStyle({
            day,
            category,
            dn,
            label: properties.LABEL,
            label2: properties.LABEL2
        });
        const fill = String(properties.fill || '').trim();
        const stroke = String(properties.stroke || '').trim();
        if (!fill && fallback.fill) properties.spc_fill = fallback.fill;
        if (!stroke && fallback.stroke) properties.spc_stroke = fallback.stroke;
        if (Number.isFinite(dn)) properties.spc_rank = dn;
        return {
            ...feature,
            properties
        };
    }).filter(Boolean);
    return {
        ...(geojson && typeof geojson === 'object' ? geojson : {}),
        type: 'FeatureCollection',
        features: normalizedFeatures
    };
}

function buildSpcOutlookUrlCandidates(day = spcOutlookState.day, category = spcOutlookState.category) {
    const dayPart = normalizeSpcDay(day);
    const normalizedCategory = sanitizeSpcCategoryForDay(dayPart, category);
    const candidates = [];
    const pushCandidate = (url, resolvedCategory) => {
        if (!url) return;
        candidates.push({ url, resolvedCategory });
        if (url.endsWith('.lyr.geojson')) {
            candidates.push({ url: url.replace('.lyr.geojson', '.geojson'), resolvedCategory });
        }
    };

    if (isSpcExtendedRangeDay(dayPart)) {
        pushCandidate(`https://www.spc.noaa.gov/products/exper/day4-8/${dayPart}prob.lyr.geojson`, 'prob');
    } else if (dayPart === 'day3') {
        if (normalizedCategory === 'cat') {
            pushCandidate('https://www.spc.noaa.gov/products/outlook/day3otlk_cat.lyr.geojson', 'cat');
            pushCandidate('https://www.spc.noaa.gov/products/outlook/day3otlk_prob.lyr.geojson', 'prob');
        } else {
            pushCandidate('https://www.spc.noaa.gov/products/outlook/day3otlk_prob.lyr.geojson', 'prob');
            pushCandidate('https://www.spc.noaa.gov/products/outlook/day3otlk_cat.lyr.geojson', 'cat');
        }
    } else {
        const convectiveCategory = normalizedCategory === 'prob'
            ? (spcOutlookLastConvectiveCategory || 'cat')
            : normalizedCategory;
        pushCandidate(`https://www.spc.noaa.gov/products/outlook/${dayPart}otlk_${convectiveCategory}.lyr.geojson`, convectiveCategory);
        if (convectiveCategory !== 'cat') {
            pushCandidate(`https://www.spc.noaa.gov/products/outlook/${dayPart}otlk_prob.lyr.geojson`, 'prob');
            pushCandidate(`https://www.spc.noaa.gov/products/outlook/${dayPart}otlk_cat.lyr.geojson`, 'cat');
        }
    }

    const seen = new Set();
    return candidates.filter(candidate => {
        if (!candidate?.url || seen.has(candidate.url)) return false;
        seen.add(candidate.url);
        return true;
    });
}

async function fetchSpcOutlookGeoJson(day = spcOutlookState.day, category = spcOutlookState.category) {
    const candidates = buildSpcOutlookUrlCandidates(day, category);
    let lastError = null;
    for (const candidate of candidates) {
        try {
            const geojson = await fetchGeoJson(candidate.url);
            return {
                data: normalizeSpcOutlookGeoJson(geojson, { day, category: candidate.resolvedCategory }),
                resolvedCategory: candidate.resolvedCategory,
                sourceUrl: candidate.url
            };
        } catch (error) {
            lastError = error;
        }
    }
    if (lastError) throw lastError;
    throw new Error('No SPC outlook URL candidates available.');
}

async function addSpcOutlookLayer() {
    if (!map) return;
    const sourceId = spcOutlookSourceId || 'spc-outlook';
    const layerId = spcOutlookLayerId || 'spc-outlook-fill';
    const outlineId = 'spc-outlook-outline';
    const fetched = await fetchSpcOutlookGeoJson(spcOutlookState.day, spcOutlookState.category);
    const outlookData = fetched.data;
    const resolvedCategory = fetched.resolvedCategory;
    if (resolvedCategory && resolvedCategory !== spcOutlookState.category) {
        spcOutlookState.category = resolvedCategory;
        if (resolvedCategory !== 'prob') {
            spcOutlookLastConvectiveCategory = resolvedCategory;
        }
        syncSpcCategoryUi();
    }

    if (!map.getSource(sourceId)) {
        map.addSource(sourceId, {
            type: 'geojson',
            data: outlookData
        });
        spcOutlookSourceId = sourceId;
    } else {
        const src = map.getSource(sourceId);
        if (src && typeof src.setData === 'function') {
            src.setData(outlookData);
        }
    }

    if (!map.getLayer(layerId)) {
        const fillLayerConfig = {
            id: layerId,
            type: 'fill',
            source: sourceId,
            paint: {
                'fill-color': getSpcFillColorExpression(),
                'fill-opacity': getSpcFillOpacityExpression()
            }
        };
        if (map.getLayer('warnings-fill')) {
            map.addLayer(fillLayerConfig, 'warnings-fill');
        } else if (radarLayer && map.getLayer(radarLayer)) {
            map.addLayer(fillLayerConfig, radarLayer);
        } else {
            map.addLayer(fillLayerConfig);
        }
        spcOutlookLayerId = layerId;
    }

    if (!map.getLayer(outlineId)) {
        map.addLayer({
            id: outlineId,
            type: 'line',
            source: sourceId,
            paint: {
                'line-color': getSpcLineColorExpression(),
                'line-width': ['case', ['>=', ['to-number', ['coalesce', ['get', 'spc_rank'], ['get', 'DN'], 0]], 30], 2.2, 1.8],
                'line-opacity': getSpcLineOpacityExpression()
            }
        });
        spcOutlookOutlineLayerId = outlineId;
    }
}

function hideSpcOutlook({ fromUser } = {}) {
    spcOutlookState.visible = false;
    const button = document.querySelector('[data-layer="spc-outlook"]');
    if (button) button.classList.remove('active');
    if (spcOutlookLayerId && map?.getLayer(spcOutlookLayerId)) {
        map.setLayoutProperty(spcOutlookLayerId, 'visibility', 'none');
    }
    if (spcOutlookOutlineLayerId && map?.getLayer(spcOutlookOutlineLayerId)) {
        map.setLayoutProperty(spcOutlookOutlineLayerId, 'visibility', 'none');
    }
    const catContainer = document.getElementById('spc-category-container');
    if (catContainer) catContainer.setAttribute('hidden', '');
    if (fromUser) {
        const menu = document.getElementById('spc-category-menu');
        if (menu) menu.setAttribute('hidden', '');
        const dayMenu = document.getElementById('spc-day-menu');
        if (dayMenu) dayMenu.setAttribute('hidden', '');
    }

    restoreLayersAfterOutlook();
    updateLegendBar();
}

function openSpcDayMenu(menuEl) {
    if (!menuEl) return;
    if (menuEl.hasAttribute('hidden')) menuEl.removeAttribute('hidden');
    highlightActiveMenuItem(menuEl, normalizeSpcDay(spcOutlookState.day), 'data-day');
}

function highlightActiveMenuItem(container, value, attrName) {
    if (!container) return;
    container.querySelectorAll('button').forEach(btn => {
        const matches = attrName ? btn.getAttribute(attrName) === value : false;
        if (matches) {
            btn.classList.add('active');
        } else {
            btn.classList.remove('active');
        }
    });
}

async function fetchGeoJson(url) {
    const response = await fetch(url, { headers: { 'Accept': 'application/json' } });
    if (!response.ok) throw new Error(`Failed to load GeoJSON ${response.status}`);
    return response.json();
}

async function ensureWpcEroLayerVisible() {
    await addOrUpdateWpcEroLayer();
    if (wpcEroFillLayerId && map.getLayer(wpcEroFillLayerId)) {
        map.setLayoutProperty(wpcEroFillLayerId, 'visibility', 'visible');
    }
    if (wpcEroOutlineLayerId && map.getLayer(wpcEroOutlineLayerId)) {
        map.setLayoutProperty(wpcEroOutlineLayerId, 'visibility', 'visible');
    }
    const button = document.querySelector('[data-layer="wpc-ero"]');
    if (button) button.classList.add('active');
    if (!wpcEroState.visible) {
        wpcEroPreviousState = captureLayerStates();
    }
    applyOutlookFocus();
    wpcEroState.visible = true;
    updateLegendBar();
}

async function addOrUpdateWpcEroLayer() {
    if (!map) return;

    const sourceId = wpcEroSourceId || 'wpc-ero';
    const fillId = wpcEroFillLayerId || 'wpc-ero-fill';
    const outlineId = wpcEroOutlineLayerId || 'wpc-ero-outline';

    const eroUrl = buildWpcEroUrl(wpcEroState.day);
    const geojson = await fetchGeoJson(eroUrl);

    if (!map.getSource(sourceId)) {
        map.addSource(sourceId, {
            type: 'geojson',
            data: geojson
        });
        wpcEroSourceId = sourceId;
    } else {
        const src = map.getSource(sourceId);
        if (src && typeof src.setData === 'function') {
            src.setData(geojson);
        }
    }

    if (!map.getLayer(fillId)) {
        const beforeLayerId = (() => {
            if (spcOutlookLayerId && map.getLayer(spcOutlookLayerId)) return spcOutlookLayerId;
            if (radarLayer && map.getLayer(radarLayer)) return radarLayer;
            if (wpcEroOutlineLayerId && map.getLayer(wpcEroOutlineLayerId)) return wpcEroOutlineLayerId;
            return undefined;
        })();

        const fillConfig = {
            id: fillId,
            type: 'fill',
            source: sourceId,
            paint: {
                'fill-color': ['match', ['get', 'dn'], 4, '#ff4d4d', 3, '#ff7f4d', 2, '#ffd24d', /* default */ '#679966'],
                'fill-opacity': 0.32
            }
        };
        if (beforeLayerId) {
            map.addLayer(fillConfig, beforeLayerId);
        } else {
            map.addLayer(fillConfig);
        }
        wpcEroFillLayerId = fillId;
    }

    if (!map.getLayer(outlineId)) {
        map.addLayer({
            id: outlineId,
            type: 'line',
            source: sourceId,
            paint: {
                'line-color': '#ffffff',
                'line-width': 1.4,
                'line-opacity': 0.85
            }
        });
        wpcEroOutlineLayerId = outlineId;
    }
}

function buildWpcEroUrl(day) {
    const dayNumber = typeof day === 'string' && day.startsWith('day') ? day.replace('day', '') : '1';
    const layerIndex = Number(dayNumber) - 1;
    const index = Number.isFinite(layerIndex) && layerIndex >= 0 ? layerIndex : 0;
    return `https://mapservices.weather.noaa.gov/vector/rest/services/hazards/wpc_precip_hazards/MapServer/${index}/query?where=1%3D1&outFields=*&outSR=4326&f=pgeojson`;
}

function hideWpcEroLayer({ fromUser } = {}) {
    wpcEroState.visible = false;
    const button = document.querySelector('[data-layer="wpc-ero"]');
    if (button) button.classList.remove('active');
    if (wpcEroFillLayerId && map?.getLayer(wpcEroFillLayerId)) {
        map.setLayoutProperty(wpcEroFillLayerId, 'visibility', 'none');
    }
    if (wpcEroOutlineLayerId && map?.getLayer(wpcEroOutlineLayerId)) {
        map.setLayoutProperty(wpcEroOutlineLayerId, 'visibility', 'none');
    }
    if (fromUser) {
        const menu = document.getElementById('wpc-ero-day-menu');
        if (menu) menu.setAttribute('hidden', '');
    }
    restoreLayersAfterWpcEro();
    updateLegendBar();
}

function openWpcEroMenu(menuEl) {
    if (!menuEl) return;
    if (menuEl.hasAttribute('hidden')) menuEl.removeAttribute('hidden');
    highlightActiveMenuItem(menuEl, wpcEroState.day, 'data-day');
}

function infrastructureEmptyCollection() {
    return { type: 'FeatureCollection', features: [] };
}

function getInfrastructureBoundsEnvelope() {
    if (!map || typeof map.getBounds !== 'function') return null;
    try {
        const b = map.getBounds();
        let west = Number(b.getWest());
        let south = Number(b.getSouth());
        let east = Number(b.getEast());
        let north = Number(b.getNorth());
        if (![west, south, east, north].every(Number.isFinite)) return null;
        if (east < west) {
            west = -180;
            east = 180;
        }
        const lonPad = Math.max(0.18, (east - west) * 0.08);
        const latPad = Math.max(0.12, (north - south) * 0.08);
        west = Math.max(-180, west - lonPad);
        east = Math.min(180, east + lonPad);
        south = Math.max(-85, south - latPad);
        north = Math.min(85, north + latPad);
        return { west, south, east, north };
    } catch {
        return null;
    }
}

function getInfrastructureBoundsKey(bounds) {
    if (!bounds) return '';
    const zoom = map && typeof map.getZoom === 'function' ? map.getZoom() : 4;
    const precision = zoom >= 9 ? 2 : 1;
    return [
        bounds.west.toFixed(precision),
        bounds.south.toFixed(precision),
        bounds.east.toFixed(precision),
        bounds.north.toFixed(precision)
    ].join('|');
}

function infrastructureToNumber(value, fallback = 0) {
    const n = Number.parseFloat(String(value ?? '').replace(/[^\d.+-]/g, ''));
    return Number.isFinite(n) ? n : fallback;
}

function arcGisGeometryToGeoJson(geometry) {
    if (!geometry || typeof geometry !== 'object') return null;
    if (Number.isFinite(Number(geometry.x)) && Number.isFinite(Number(geometry.y))) {
        return {
            type: 'Point',
            coordinates: [Number(geometry.x), Number(geometry.y)]
        };
    }
    if (Array.isArray(geometry.points) && geometry.points.length) {
        const pt = geometry.points[0];
        if (Array.isArray(pt) && Number.isFinite(Number(pt[0])) && Number.isFinite(Number(pt[1]))) {
            return {
                type: 'Point',
                coordinates: [Number(pt[0]), Number(pt[1])]
            };
        }
    }
    if (Array.isArray(geometry.paths) && geometry.paths.length) {
        const paths = geometry.paths
            .map((path) => Array.isArray(path) ? path
                .map((coord) => (Array.isArray(coord) ? [Number(coord[0]), Number(coord[1])] : null))
                .filter((coord) => coord && Number.isFinite(coord[0]) && Number.isFinite(coord[1])) : [])
            .filter((path) => path.length >= 2);
        if (!paths.length) return null;
        if (paths.length === 1) {
            return { type: 'LineString', coordinates: paths[0] };
        }
        return { type: 'MultiLineString', coordinates: paths };
    }
    if (Array.isArray(geometry.rings) && geometry.rings.length) {
        const rings = geometry.rings
            .map((ring) => Array.isArray(ring) ? ring
                .map((coord) => (Array.isArray(coord) ? [Number(coord[0]), Number(coord[1])] : null))
                .filter((coord) => coord && Number.isFinite(coord[0]) && Number.isFinite(coord[1])) : [])
            .filter((ring) => ring.length >= 4);
        if (!rings.length) return null;
        if (rings.length === 1) {
            return { type: 'Polygon', coordinates: [rings[0]] };
        }
        return { type: 'MultiPolygon', coordinates: rings.map((ring) => [ring]) };
    }
    return null;
}

function arcGisFeatureToGeoJson(feature, sourceTag) {
    try {
        if (!feature) return null;
        const geometry = arcGisGeometryToGeoJson(feature.geometry);
        if (!geometry) return null;
        const attrs = (feature.attributes && typeof feature.attributes === 'object') ? feature.attributes : {};
        const featureId = attrs.OBJECTID || attrs.objectid || attrs.OBJECTID_1 || `${sourceTag}-${Math.random().toString(36).slice(2, 8)}`;
        return {
            type: 'Feature',
            id: featureId,
            geometry,
            properties: {
                ...attrs,
                _sourceTag: sourceTag
            }
        };
    } catch {
        return null;
    }
}

async function queryArcGisAsGeoJson({
    serviceUrl,
    outFields = '*',
    where = '1=1',
    maxFeatures = 1000,
    bounds = null,
    sourceTag = 'Infrastructure',
    orderByFields = ''
} = {}) {
    if (!serviceUrl) return infrastructureEmptyCollection();
    const pageSize = Math.max(50, Math.min(1000, Math.floor(maxFeatures || 1000)));
    const maxPages = Math.max(4, Math.min(24, Math.ceil((maxFeatures || 1000) / pageSize) + 2));
    const out = [];
    let offset = 0;
    const seenPageKeys = new Set();

    for (let page = 0; page < maxPages && out.length < maxFeatures; page += 1) {
        const params = new URLSearchParams({
            f: 'pjson',
            where,
            outFields,
            returnGeometry: 'true',
            outSR: '4326',
            resultRecordCount: String(Math.min(pageSize, maxFeatures - out.length)),
            resultOffset: String(offset)
        });
        if (orderByFields) params.set('orderByFields', orderByFields);
        if (bounds) {
            params.set('geometryType', 'esriGeometryEnvelope');
            params.set('spatialRel', 'esriSpatialRelIntersects');
            params.set('inSR', '4326');
            params.set('geometry', `${bounds.west},${bounds.south},${bounds.east},${bounds.north}`);
        }

        const url = `${serviceUrl}/query?${params.toString()}`;
        const response = await fetch(url, { headers: { 'Accept': 'application/json' } });
        if (!response.ok) {
            throw new Error(`ArcGIS query failed (${response.status})`);
        }
        const payload = await response.json();
        if (payload && payload.error) {
            throw new Error(payload.error.message || 'ArcGIS query error');
        }
        const features = Array.isArray(payload?.features) ? payload.features : [];
        if (!features.length) break;

        const pageSignature = features.slice(0, 3).map((f) => JSON.stringify(f?.attributes || {})).join('|');
        if (pageSignature && seenPageKeys.has(pageSignature)) break;
        if (pageSignature) seenPageKeys.add(pageSignature);

        features.forEach((feature) => {
            if (out.length >= maxFeatures) return;
            const normalized = arcGisFeatureToGeoJson(feature, sourceTag);
            if (normalized) out.push(normalized);
        });

        const exceeded = Boolean(payload?.exceededTransferLimit || payload?.transferLimitExceeded);
        if (!exceeded || features.length < pageSize) break;
        offset += features.length;
    }

    return { type: 'FeatureCollection', features: out };
}

async function fetchPowerOutagesNationwide() {
    return queryArcGisAsGeoJson({
        serviceUrl: INFRASTRUCTURE_FEEDS.outages,
        outFields: 'ObjectId,US_Full_FIPS,US_State_FIPS,US_County_FIPS,CountyName,CustomersOut,CustomersTracked,LastUpdatedDateTime',
        maxFeatures: 4200,
        sourceTag: 'Power Outages'
    });
}

async function fetchOverpassCriticalSites(bounds) {
    const empty = {
        trailerParks: infrastructureEmptyCollection(),
        camps: infrastructureEmptyCollection()
    };
    if (!bounds) return empty;

    const south = Number(bounds.south).toFixed(4);
    const west = Number(bounds.west).toFixed(4);
    const north = Number(bounds.north).toFixed(4);
    const east = Number(bounds.east).toFixed(4);
    const bbox = `(${south},${west},${north},${east})`;

    const query = `
[out:json][timeout:25];
(
  node["tourism"="camp_site"]${bbox};
  way["tourism"="camp_site"]${bbox};
  relation["tourism"="camp_site"]${bbox};
  node["tourism"="caravan_site"]${bbox};
  way["tourism"="caravan_site"]${bbox};
  relation["tourism"="caravan_site"]${bbox};
  node["residential"="mobile_home"]${bbox};
  way["residential"="mobile_home"]${bbox};
  relation["residential"="mobile_home"]${bbox};
  node["landuse"="mobile_home"]${bbox};
  way["landuse"="mobile_home"]${bbox};
  relation["landuse"="mobile_home"]${bbox};
  node["place"="mobile_home_park"]${bbox};
  way["place"="mobile_home_park"]${bbox};
  relation["place"="mobile_home_park"]${bbox};
  node["amenity"="trailer_park"]${bbox};
  way["amenity"="trailer_park"]${bbox};
  relation["amenity"="trailer_park"]${bbox};
);
out tags center;
    `.trim();

    try {
        const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
        let timeoutId = null;
        if (controller) {
            timeoutId = setTimeout(() => {
                try { controller.abort(); } catch {}
            }, 22000);
        }

        const response = await fetch('https://overpass-api.de/api/interpreter', {
            method: 'POST',
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'text/plain; charset=UTF-8'
            },
            body: query,
            signal: controller ? controller.signal : undefined
        });
        if (timeoutId) clearTimeout(timeoutId);
        if (!response.ok) throw new Error(`Overpass ${response.status}`);

        const payload = await response.json();
        const elements = Array.isArray(payload?.elements) ? payload.elements : [];
        if (!elements.length) return empty;

        const trailerFeatures = [];
        const campFeatures = [];
        const seen = new Set();

        elements.forEach((el, idx) => {
            const tags = (el && el.tags && typeof el.tags === 'object') ? el.tags : {};
            const lon = Number(el?.lon ?? el?.center?.lon);
            const lat = Number(el?.lat ?? el?.center?.lat);
            if (!Number.isFinite(lon) || !Number.isFinite(lat)) return;

            const tourism = String(tags.tourism || '').toLowerCase();
            const residential = String(tags.residential || '').toLowerCase();
            const landuse = String(tags.landuse || '').toLowerCase();
            const amenity = String(tags.amenity || '').toLowerCase();
            const place = String(tags.place || '').toLowerCase();
            const name = String(tags.name || tags.operator || tags.ref || '').trim();

            const isCamp = tourism === 'camp_site' || tourism === 'caravan_site';
            const isTrailer = (
                residential === 'mobile_home' ||
                landuse === 'mobile_home' ||
                place === 'mobile_home_park' ||
                amenity === 'trailer_park'
            );
            if (!isCamp && !isTrailer) return;

            const kind = isTrailer ? 'trailer_park' : 'camp';
            const dedupeKey = `${kind}|${lat.toFixed(4)}|${lon.toFixed(4)}|${(name || '').toLowerCase()}`;
            if (seen.has(dedupeKey)) return;
            seen.add(dedupeKey);

            const feature = {
                type: 'Feature',
                id: `osm-${kind}-${el?.id || idx}-${lat.toFixed(4)}-${lon.toFixed(4)}`,
                geometry: {
                    type: 'Point',
                    coordinates: [lon, lat]
                },
                properties: {
                    name: name || (isTrailer ? 'Trailer Park' : 'Camp'),
                    category: isTrailer ? 'Trailer Park' : 'Camp',
                    source: 'OpenStreetMap (Overpass)',
                    tourism: tags.tourism || '',
                    amenity: tags.amenity || '',
                    landuse: tags.landuse || '',
                    residential: tags.residential || '',
                    place: tags.place || '',
                    _sourceTag: 'OSM Overpass'
                }
            };

            if (isTrailer) {
                if (trailerFeatures.length < 1800) trailerFeatures.push(feature);
            } else if (campFeatures.length < 1800) {
                campFeatures.push(feature);
            }
        });

        return {
            trailerParks: { type: 'FeatureCollection', features: trailerFeatures },
            camps: { type: 'FeatureCollection', features: campFeatures }
        };
    } catch (error) {
        console.warn('fetchOverpassCriticalSites failed', error);
        return empty;
    }
}

function infrastructurePopupRow(label, value) {
    const safeLabel = escapeInfrastructureHtml(String(label || '').toUpperCase());
    const safeValue = escapeInfrastructureHtml(String(value || '--'));
    return `
        <div class="infra-popup-row">
            <span class="infra-popup-k">${safeLabel}</span>
            <span class="infra-popup-v">${safeValue}</span>
        </div>
    `;
}

function escapeInfrastructureHtml(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function getInfrastructureInsertBeforeLayer() {
    const preferred = ['warnings-fill', STORM_REPORT_ICON_LAYER_ID, 'lsr-points'];
    for (const id of preferred) {
        try {
            if (map && map.getLayer(id)) return id;
        } catch {}
    }
    return undefined;
}

function setInfrastructureSourceData(sourceId, collection) {
    try {
        const source = map?.getSource(sourceId);
        if (source && typeof source.setData === 'function') {
            source.setData(collection || infrastructureEmptyCollection());
        }
    } catch {}
}

function ensureInfrastructurePopupStyle() {
    if (document.getElementById('infra-popup-style')) return;
    const style = document.createElement('style');
    style.id = 'infra-popup-style';
    style.textContent = `
        .infrastructure-popup .maplibregl-popup-content{
            margin:0!important;
            padding:0!important;
            border:none!important;
            border-radius:12px!important;
            overflow:hidden!important;
            background:linear-gradient(150deg,rgba(12,19,39,0.98) 0%,rgba(8,14,30,0.98) 100%)!important;
            box-shadow:0 12px 30px rgba(0,0,0,0.45),0 0 0 1px rgba(170,194,232,0.14)!important;
            color:#e8f2ff!important;
            font-family:'Rajdhani','Inter',sans-serif;
        }
        .infrastructure-popup .maplibregl-popup-tip{border-top-color:rgba(8,14,30,0.98)!important}
        .infrastructure-popup.maplibregl-popup-anchor-top .maplibregl-popup-tip{border-bottom-color:rgba(8,14,30,0.98)!important}
        .infrastructure-popup.maplibregl-popup-anchor-bottom .maplibregl-popup-tip{border-top-color:rgba(8,14,30,0.98)!important}
        .infrastructure-popup.maplibregl-popup-anchor-left .maplibregl-popup-tip{border-right-color:rgba(8,14,30,0.98)!important}
        .infrastructure-popup.maplibregl-popup-anchor-right .maplibregl-popup-tip{border-left-color:rgba(8,14,30,0.98)!important}
        .infra-popup-card{min-width:250px;max-width:320px;padding:10px 12px 11px;border-left:3px solid var(--infra-accent,#38bdf8)}
        .infra-popup-title{font-size:1.03rem;font-weight:800;letter-spacing:.08em;text-transform:uppercase}
        .infra-popup-subtitle{margin-top:4px;font-size:.82rem;font-weight:600;opacity:.88;letter-spacing:.04em}
        .infra-popup-grid{margin-top:8px;border-top:1px solid rgba(170,194,232,0.18);padding-top:7px;display:flex;flex-direction:column;gap:5px}
        .infra-popup-row{display:flex;justify-content:space-between;gap:10px;align-items:flex-start}
        .infra-popup-k{font-size:.66rem;letter-spacing:.08em;opacity:.72}
        .infra-popup-v{font-size:.85rem;font-weight:700;line-height:1.2;text-align:right}
    `;
    document.head.appendChild(style);
}

function ensurePowerOutageOverlayElement() {
    const host = document.querySelector('.weather-map-content');
    if (!host) return null;
    let el = document.getElementById('power-outage-overlay');
    if (!el) {
        el = document.createElement('div');
        el.id = 'power-outage-overlay';
        el.className = 'power-outage-overlay';
        el.setAttribute('hidden', '');
        host.appendChild(el);
    }
    return el;
}

function renderPowerOutageOverlay(collection = infrastructureEmptyCollection()) {
    const el = ensurePowerOutageOverlayElement();
    if (!el) return;
    const features = (Array.isArray(collection?.features) ? collection.features : [])
        .filter((f) => Number(f?.properties?.impacted || 0) > 0)
        .sort((a, b) => Number(b?.properties?.impacted || 0) - Number(a?.properties?.impacted || 0));
    if (!powerOutageState.visible || !features.length) {
        el.setAttribute('hidden', '');
        el.innerHTML = '';
        return;
    }
    const totalWithoutPower = features.reduce((sum, f) => {
        const impacted = Number(f?.properties?.impacted || 0);
        return sum + (Number.isFinite(impacted) ? impacted : 0);
    }, 0);
    const rows = features
        .slice(0, 12)
        .map((f) => {
            const p = f.properties || {};
            const county = String(p.county || '').trim() || 'Unknown County';
            const state = String(p.state || '').trim() || '--';
            const impacted = Number(p.impacted || 0);
            const value = Number.isFinite(impacted) ? impacted.toLocaleString() : '--';
            return `<div class="power-outage-row"><span>${escapeInfrastructureHtml(`${county}, ${state}`)}</span><strong>${escapeInfrastructureHtml(value)}</strong></div>`;
        })
        .join('');

    el.innerHTML = `
        <div class="power-outage-header">COUNTY OUTAGES</div>
        <div class="power-outage-total">WITHOUT POWER: <strong>${escapeInfrastructureHtml(totalWithoutPower.toLocaleString())}</strong></div>
        <div class="power-outage-list">${rows || '<div class="power-outage-empty">No county outages in view.</div>'}</div>
    `;
    el.removeAttribute('hidden');
}

function normalizeOutageCountyName(value) {
    return String(value || '')
        .toUpperCase()
        .replace(/\b(COUNTY|PARISH|BOROUGH|CENSUS AREA|MUNICIPALITY)\b/g, '')
        .replace(/[^A-Z0-9]/g, '')
        .trim();
}

function normalizeOutageStateName(value) {
    return String(value || '')
        .toUpperCase()
        .replace(/[^A-Z]/g, '')
        .trim();
}

function normalizeOutageCountyFips(value) {
    const digits = String(value ?? '').replace(/\D/g, '');
    if (!digits) return '';
    if (digits.length >= 5) return digits.slice(-5);
    return digits.padStart(5, '0');
}

function outageCountyJoinKey(county, state) {
    const c = normalizeOutageCountyName(county);
    const s = normalizeOutageStateName(state);
    return c && s ? `${c}|${s}` : '';
}

function pointInRing(lon, lat, ring) {
    if (!Array.isArray(ring) || ring.length < 3) return false;
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
        const pi = ring[i];
        const pj = ring[j];
        const xi = Number(pi?.[0]);
        const yi = Number(pi?.[1]);
        const xj = Number(pj?.[0]);
        const yj = Number(pj?.[1]);
        if (![xi, yi, xj, yj].every(Number.isFinite)) continue;
        const intersects = ((yi > lat) !== (yj > lat))
            && (lon < ((xj - xi) * (lat - yi)) / ((yj - yi) || 1e-12) + xi);
        if (intersects) inside = !inside;
    }
    return inside;
}

function pointInPolygonGeometry(lon, lat, geometry) {
    if (!geometry) return false;
    if (geometry.type === 'Polygon') {
        const rings = geometry.coordinates || [];
        if (!rings.length || !pointInRing(lon, lat, rings[0])) return false;
        for (let i = 1; i < rings.length; i += 1) {
            if (pointInRing(lon, lat, rings[i])) return false;
        }
        return true;
    }
    if (geometry.type === 'MultiPolygon') {
        const polygons = geometry.coordinates || [];
        for (const polygon of polygons) {
            if (!Array.isArray(polygon) || !polygon.length) continue;
            if (!pointInRing(lon, lat, polygon[0])) continue;
            let inHole = false;
            for (let i = 1; i < polygon.length; i += 1) {
                if (pointInRing(lon, lat, polygon[i])) {
                    inHole = true;
                    break;
                }
            }
            if (!inHole) return true;
        }
    }
    return false;
}

function buildPowerOutageCountyIndex(collection = infrastructureEmptyCollection()) {
    const features = Array.isArray(collection?.features) ? collection.features : [];
    const cellSize = 2;
    const buckets = new Map();
    const bboxByIndex = new Map();
    const keyByIndex = new Map();
    const countyFallback = new Map();

    features.forEach((feature, index) => {
        const p = feature?.properties || {};
        const joinKey = String(p.joinKey || '');
        keyByIndex.set(index, joinKey);
        const countyNorm = normalizeOutageCountyName(p.county);
        if (countyNorm && joinKey) {
            const arr = countyFallback.get(countyNorm) || [];
            if (!arr.includes(joinKey)) arr.push(joinKey);
            countyFallback.set(countyNorm, arr);
        }

        const bbox = geometryToBbox(feature?.geometry);
        if (!bbox) return;
        const minLon = Number(bbox?.[0]?.[0]);
        const minLat = Number(bbox?.[0]?.[1]);
        const maxLon = Number(bbox?.[1]?.[0]);
        const maxLat = Number(bbox?.[1]?.[1]);
        if (![minLon, minLat, maxLon, maxLat].every(Number.isFinite)) return;
        bboxByIndex.set(index, [minLon, minLat, maxLon, maxLat]);

        const x0 = Math.floor((minLon + 180) / cellSize);
        const y0 = Math.floor((minLat + 90) / cellSize);
        const x1 = Math.floor((maxLon + 180) / cellSize);
        const y1 = Math.floor((maxLat + 90) / cellSize);
        for (let x = x0; x <= x1; x += 1) {
            for (let y = y0; y <= y1; y += 1) {
                const bucketKey = `${x}|${y}`;
                const list = buckets.get(bucketKey) || [];
                list.push(index);
                buckets.set(bucketKey, list);
            }
        }
    });

    return { cellSize, buckets, bboxByIndex, keyByIndex, countyFallback };
}

function findPowerOutageCountyKey(lon, lat, countyName = '') {
    if (!powerOutageCountyIndex || !powerOutageCountyBase) return '';
    const { cellSize, buckets, bboxByIndex, keyByIndex, countyFallback } = powerOutageCountyIndex;
    const x = Math.floor((lon + 180) / cellSize);
    const y = Math.floor((lat + 90) / cellSize);
    const candidates = buckets.get(`${x}|${y}`) || [];
    const features = Array.isArray(powerOutageCountyBase?.features) ? powerOutageCountyBase.features : [];

    for (const index of candidates) {
        const bbox = bboxByIndex.get(index);
        if (!bbox) continue;
        if (lon < bbox[0] || lon > bbox[2] || lat < bbox[1] || lat > bbox[3]) continue;
        const feature = features[index];
        if (!feature?.geometry) continue;
        if (pointInPolygonGeometry(lon, lat, feature.geometry)) {
            return String(keyByIndex.get(index) || '');
        }
    }

    const fallback = countyFallback.get(normalizeOutageCountyName(countyName));
    return Array.isArray(fallback) && fallback.length ? String(fallback[0]) : '';
}

async function ensurePowerOutageCountyBaseData() {
    if (powerOutageCountyBase?.features?.length) return powerOutageCountyBase;
    if (powerOutageCountyLoadPromise) return powerOutageCountyLoadPromise;
    powerOutageCountyLoadPromise = (async () => {
        const countiesRaw = await queryArcGisAsGeoJson({
            serviceUrl: INFRASTRUCTURE_FEEDS.counties,
            outFields: 'OBJECTID,NAME,STATE_NAME,STATE_ABBR,FIPS,COUNTY_FIPS,STATE_FIPS',
            maxFeatures: 4200,
            sourceTag: 'US Counties',
            orderByFields: 'STATE_NAME ASC, NAME ASC'
        });
        const mapped = (Array.isArray(countiesRaw?.features) ? countiesRaw.features : [])
            .filter((f) => f?.geometry && (f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon'))
            .map((feature, index) => {
                const p = feature.properties || {};
                const county = String(p.NAME || p.name || '').trim();
                const state = String(p.STATE_NAME || p.state_name || '').trim();
                const stateAbbr = String(p.STATE_ABBR || p.state_abbr || '').trim();
                const countyFips = String(p.FIPS || p.fips || p.COUNTY_FIPS || '').trim();
                const id = countyFips || String(p.OBJECTID || p.objectid || `county-${index + 1}`);
                const joinKey = outageCountyJoinKey(county, stateAbbr || state);
                return {
                    type: 'Feature',
                    id,
                    geometry: feature.geometry,
                    properties: {
                        county,
                        state,
                        stateAbbr,
                        countyFips,
                        joinKey,
                        countyLabel: `${county}${stateAbbr ? `, ${stateAbbr}` : ''}`
                    }
                };
            });
        powerOutageCountyBase = { type: 'FeatureCollection', features: mapped };
        powerOutageCountyIndex = buildPowerOutageCountyIndex(powerOutageCountyBase);
        return powerOutageCountyBase;
    })().finally(() => {
        powerOutageCountyLoadPromise = null;
    });
    return powerOutageCountyLoadPromise;
}

function aggregatePowerOutagesByCounty(collection = infrastructureEmptyCollection()) {
    const countyFeatures = Array.isArray(powerOutageCountyBase?.features) ? powerOutageCountyBase.features : [];
    if (!countyFeatures.length) return infrastructureEmptyCollection();

    const outageFeatures = Array.isArray(collection?.features) ? collection.features : [];
    const totalsByCountyKey = new Map();
    const countyKeyByFips = new Map();

    countyFeatures.forEach((feature) => {
        const p = feature?.properties || {};
        const joinKey = String(p.joinKey || '');
        if (!joinKey) return;
        const fips = normalizeOutageCountyFips(p.countyFips || p.FIPS || p.fips || '');
        if (fips) countyKeyByFips.set(fips, joinKey);
    });

    outageFeatures.forEach((feature) => {
        const p = feature?.properties || {};
        const impacted = infrastructureToNumber(
            p.CustomersOut
            ?? p.customersOut
            ?? p.impacted
            ?? p.ImpactedCustomers
            ?? p.impacted_customers
            ?? p.customers_out
            ?? p.customerswithoutpower
            ?? p.cust_a,
            0
        );
        if (!(impacted > 0)) return;
        const stateFips = String(p.US_State_FIPS ?? p.us_state_fips ?? '').replace(/\D/g, '');
        const countyFipsPart = String(p.US_County_FIPS ?? p.us_county_fips ?? p.COUNTY_FIPS ?? p.county_fips ?? '').replace(/\D/g, '');
        const directCountyFips = normalizeOutageCountyFips(
            p.US_Full_FIPS
            ?? p.us_full_fips
            ?? p.USFullFips
            ?? (stateFips && countyFipsPart ? `${stateFips.padStart(2, '0')}${countyFipsPart.padStart(3, '0')}` : '')
        );

        let countyKey = directCountyFips ? String(countyKeyByFips.get(directCountyFips) || '') : '';
        if (!countyKey) {
            const g = feature?.geometry;
            const lon = Number(g?.type === 'Point' ? g.coordinates?.[0] : NaN);
            const lat = Number(g?.type === 'Point' ? g.coordinates?.[1] : NaN);
            if (!Number.isFinite(lon) || !Number.isFinite(lat)) return;
            countyKey = findPowerOutageCountyKey(lon, lat, p.County || p.county || p.CountyName || p.countyName || '');
        }
        if (!countyKey) return;
        totalsByCountyKey.set(countyKey, Number(totalsByCountyKey.get(countyKey) || 0) + impacted);
    });

    const merged = countyFeatures.map((feature) => {
        const p = feature?.properties || {};
        const countyKey = String(p.joinKey || '');
        const impacted = Math.max(0, Math.round(Number(totalsByCountyKey.get(countyKey) || 0)));
        return {
            type: 'Feature',
            id: feature.id,
            geometry: feature.geometry,
            properties: {
                ...p,
                impacted,
                impactedText: impacted.toLocaleString()
            }
        };
    });

    return { type: 'FeatureCollection', features: merged };
}

function clearPowerOutageHover() {
    if (!map) return;
    if (powerOutageHoveredFeatureId !== null && powerOutageHoveredFeatureId !== undefined) {
        try {
            map.setFeatureState({ source: POWER_OUTAGE_SOURCE_ID, id: powerOutageHoveredFeatureId }, { hover: false });
        } catch {}
    }
    powerOutageHoveredFeatureId = null;
    try { map.getCanvas().style.cursor = ''; } catch {}
    try { if (powerOutageHoverPopup) powerOutageHoverPopup.remove(); } catch {}
}

function ensurePowerOutageLayers() {
    if (!map) return;
    if (!map.getSource(POWER_OUTAGE_SOURCE_ID)) {
        map.addSource(POWER_OUTAGE_SOURCE_ID, { type: 'geojson', data: infrastructureEmptyCollection() });
    }

    const beforeLayer = getInfrastructureInsertBeforeLayer();

    if (!map.getLayer(POWER_OUTAGE_GLOW_LAYER_ID)) {
        map.addLayer({
            id: POWER_OUTAGE_GLOW_LAYER_ID,
            type: 'fill',
            source: POWER_OUTAGE_SOURCE_ID,
            layout: { visibility: 'none' },
            paint: {
                'fill-color': [
                    'case',
                    ['>=', ['coalesce', ['to-number', ['get', 'impacted']], 0], 100000], '#dc2626',
                    ['>=', ['coalesce', ['to-number', ['get', 'impacted']], 0], 25000], '#ea580c',
                    ['>=', ['coalesce', ['to-number', ['get', 'impacted']], 0], 5000], '#f97316',
                    ['>=', ['coalesce', ['to-number', ['get', 'impacted']], 0], 1000], '#f59e0b',
                    ['>', ['coalesce', ['to-number', ['get', 'impacted']], 0], 0], '#facc15',
                    '#1f2937'
                ],
                'fill-opacity': [
                    'case',
                    ['>', ['coalesce', ['to-number', ['get', 'impacted']], 0], 0],
                    ['interpolate', ['linear'], ['coalesce', ['to-number', ['get', 'impacted']], 0], 1, 0.24, 1000, 0.3, 5000, 0.44, 25000, 0.56, 100000, 0.68],
                    0.14
                ]
            }
        }, beforeLayer);
    }

    if (!map.getLayer(POWER_OUTAGE_LAYER_ID)) {
        map.addLayer({
            id: POWER_OUTAGE_LAYER_ID,
            type: 'line',
            source: POWER_OUTAGE_SOURCE_ID,
            layout: { visibility: 'none' },
            paint: {
                'line-color': [
                    'case',
                    ['boolean', ['feature-state', 'hover'], false], '#f8fafc',
                    ['>', ['coalesce', ['to-number', ['get', 'impacted']], 0], 0], 'rgba(255,238,201,0.58)',
                    'rgba(148,163,184,0.46)'
                ],
                'line-width': [
                    'case',
                    ['boolean', ['feature-state', 'hover'], false], 1.8,
                    ['>', ['coalesce', ['to-number', ['get', 'impacted']], 0], 0], 0.9,
                    0.35
                ],
                'line-opacity': 0.95
            }
        }, beforeLayer);
    }

    if (!map.getLayer(POWER_OUTAGE_LABEL_LAYER_ID)) {
        map.addLayer({
            id: POWER_OUTAGE_LABEL_LAYER_ID,
            type: 'fill',
            source: POWER_OUTAGE_SOURCE_ID,
            layout: { visibility: 'none' },
            paint: {
                'fill-color': '#ffffff',
                'fill-opacity': ['case', ['boolean', ['feature-state', 'hover'], false], 0.14, 0]
            }
        }, beforeLayer);
    }

    try {
        if (!map.__powerOutageInteractionsBound) {
            map.__powerOutageInteractionsBound = true;
            ensureInfrastructurePopupStyle();
            map.on('mousemove', POWER_OUTAGE_GLOW_LAYER_ID, (event) => {
                const feature = event?.features?.[0];
                if (!feature) return;
                const featureId = feature.id;
                if (powerOutageHoveredFeatureId !== featureId) {
                    clearPowerOutageHover();
                    if (featureId !== null && featureId !== undefined) {
                        try {
                            map.setFeatureState({ source: POWER_OUTAGE_SOURCE_ID, id: featureId }, { hover: true });
                            powerOutageHoveredFeatureId = featureId;
                        } catch {}
                    }
                }

                const p = feature.properties || {};
                const county = String(p.county || p.NAME || '').trim() || 'Unknown County';
                const state = String(p.stateAbbr || p.state || '').trim();
                const impacted = Math.max(0, Number(p.impacted || 0));
                const countyLabel = `${county}${state ? `, ${state}` : ''}`;

                try { map.getCanvas().style.cursor = 'pointer'; } catch {}
                if (!powerOutageHoverPopup) {
                    powerOutageHoverPopup = new maplibregl.Popup({
                        closeButton: false,
                        closeOnClick: false,
                        className: 'infrastructure-popup',
                        maxWidth: '260px'
                    });
                }
                powerOutageHoverPopup
                    .setLngLat(event.lngLat)
                    .setHTML(`
                        <div class="infra-popup-card" style="--infra-accent:#f59e0b;min-width:200px">
                            <div class="infra-popup-title">Power Outage</div>
                            <div class="infra-popup-subtitle">${escapeInfrastructureHtml(countyLabel)}</div>
                            <div class="infra-popup-grid">
                                ${infrastructurePopupRow('Without Power', impacted.toLocaleString())}
                            </div>
                        </div>
                    `)
                    .addTo(map);
            });
            map.on('mouseleave', POWER_OUTAGE_GLOW_LAYER_ID, () => {
                clearPowerOutageHover();
            });
        }
    } catch {}
}

function setPowerOutageLayerVisibility(visibility) {
    const visible = visibility === 'visible';
    [POWER_OUTAGE_GLOW_LAYER_ID, POWER_OUTAGE_LAYER_ID, POWER_OUTAGE_LABEL_LAYER_ID].forEach((layerId) => {
        try {
            if (map?.getLayer(layerId)) map.setLayoutProperty(layerId, 'visibility', visible ? 'visible' : 'none');
        } catch {}
    });
    powerOutageState.visible = visible;
    setButtonActive('power-outages', visible);
    if (!visible) {
        clearPowerOutageHover();
        const el = ensurePowerOutageOverlayElement();
        if (el) {
            el.setAttribute('hidden', '');
            el.innerHTML = '';
        }
    }
}

function schedulePowerOutageRefresh(delayMs = 360, force = false, allowHidden = false) {
    if (powerOutageRefreshTimer) {
        clearTimeout(powerOutageRefreshTimer);
        powerOutageRefreshTimer = null;
    }
    powerOutageRefreshTimer = setTimeout(() => {
        powerOutageRefreshTimer = null;
        refreshPowerOutageData({ force, allowHidden }).catch(() => {});
    }, Math.max(0, Number(delayMs) || 0));
}

async function refreshPowerOutageData({ force = false, allowHidden = false } = {}) {
    if (!map || (!powerOutageState.visible && !allowHidden)) return false;
    if (powerOutageState.loading) {
        powerOutageState.refreshQueued = true;
        return false;
    }

    const now = Date.now();
    if (!force && (now - powerOutageState.lastFetchAt) < 45000) {
        return false;
    }

    powerOutageState.loading = true;
    try {
        await ensurePowerOutageCountyBaseData();
        const outagesRaw = await fetchPowerOutagesNationwide();
        const aggregated = aggregatePowerOutagesByCounty(outagesRaw);
        const source = map.getSource(POWER_OUTAGE_SOURCE_ID);
        if (source && typeof source.setData === 'function') {
            clearPowerOutageHover();
            source.setData(aggregated);
        }
        if (powerOutageState.visible) renderPowerOutageOverlay(aggregated);
        powerOutageState.lastFetchAt = Date.now();
        powerOutageState.lastBoundsKey = 'nationwide';
        return true;
    } catch (error) {
        console.warn('refreshPowerOutageData failed', error);
        return false;
    } finally {
        powerOutageState.loading = false;
        if (powerOutageState.refreshQueued) {
            powerOutageState.refreshQueued = false;
            schedulePowerOutageRefresh(280, true, allowHidden);
        }
    }
}

async function togglePowerOutageLayer() {
    if (!map) return false;
    ensurePowerOutageLayers();
    if (powerOutageState.visible) {
        setPowerOutageLayerVisibility('none');
        updateLegendBar();
        return false;
    }
    setPowerOutageLayerVisibility('visible');
    updateLegendBar();
    await refreshPowerOutageData({ force: true, allowHidden: false });
    return true;
}

function ensureInfrastructureLayers() {
    if (!map) return;

    Object.values(INFRA_SOURCE_IDS).forEach((sourceId) => {
        if (!map.getSource(sourceId)) {
            map.addSource(sourceId, { type: 'geojson', data: infrastructureEmptyCollection() });
        }
    });

    const beforeLayer = getInfrastructureInsertBeforeLayer();

    if (!map.getLayer(INFRA_LAYER_IDS.hospitals)) {
        map.addLayer({
            id: INFRA_LAYER_IDS.hospitals,
            type: 'circle',
            source: INFRA_SOURCE_IDS.hospitals,
            layout: { visibility: 'none' },
            paint: {
                'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, 2.5, 7, 4, 10, 5.2, 12, 6.3],
                'circle-color': '#38bdf8',
                'circle-opacity': 0.86,
                'circle-stroke-color': 'rgba(8,47,73,0.95)',
                'circle-stroke-width': 1
            }
        }, beforeLayer);
    }

    if (!map.getLayer(INFRA_LAYER_IDS.shelters)) {
        map.addLayer({
            id: INFRA_LAYER_IDS.shelters,
            type: 'circle',
            source: INFRA_SOURCE_IDS.shelters,
            layout: { visibility: 'none' },
            paint: {
                'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, 2.7, 7, 4.3, 10, 5.6, 12, 6.8],
                'circle-color': '#22c55e',
                'circle-opacity': 0.86,
                'circle-stroke-color': 'rgba(20,83,45,0.95)',
                'circle-stroke-width': 1.1
            }
        }, beforeLayer);
    }

    if (!map.getLayer(INFRA_LAYER_IDS.substations)) {
        map.addLayer({
            id: INFRA_LAYER_IDS.substations,
            type: 'circle',
            source: INFRA_SOURCE_IDS.substations,
            layout: { visibility: 'none' },
            paint: {
                'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, 2.4, 7, 3.8, 10, 5, 12, 6.1],
                'circle-color': '#a78bfa',
                'circle-opacity': 0.82,
                'circle-stroke-color': 'rgba(46,16,101,0.92)',
                'circle-stroke-width': 1
            }
        }, beforeLayer);
    }

    if (!map.getLayer(INFRA_LAYER_IDS.trailerParks)) {
        map.addLayer({
            id: INFRA_LAYER_IDS.trailerParks,
            type: 'circle',
            source: INFRA_SOURCE_IDS.trailerParks,
            layout: { visibility: 'none' },
            paint: {
                'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, 2.8, 7, 4.8, 10, 6.2, 12, 7.4],
                'circle-color': '#fb7185',
                'circle-opacity': 0.9,
                'circle-stroke-color': 'rgba(136,19,55,0.95)',
                'circle-stroke-width': 1.1
            }
        }, beforeLayer);
    }

    if (!map.getLayer(INFRA_LAYER_IDS.camps)) {
        map.addLayer({
            id: INFRA_LAYER_IDS.camps,
            type: 'circle',
            source: INFRA_SOURCE_IDS.camps,
            layout: { visibility: 'none' },
            paint: {
                'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, 2.8, 7, 4.6, 10, 6, 12, 7.2],
                'circle-color': '#166534',
                'circle-opacity': 0.88,
                'circle-stroke-color': 'rgba(4,78,38,0.96)',
                'circle-stroke-width': 1.1
            }
        }, beforeLayer);
    }

    bringCameraAndInfrastructureLayersToFront();
    ensureInfrastructurePopupStyle();
    bindInfrastructureInteractions();
}

function setInfrastructureLayerVisibility(visibility) {
    [
        INFRA_LAYER_IDS.hospitals,
        INFRA_LAYER_IDS.shelters,
        INFRA_LAYER_IDS.substations,
        INFRA_LAYER_IDS.trailerParks,
        INFRA_LAYER_IDS.camps
    ].forEach((layerId) => {
        try {
            if (map?.getLayer(layerId)) map.setLayoutProperty(layerId, 'visibility', visibility);
        } catch {}
    });
    const visible = visibility === 'visible';
    infrastructureState.visible = visible;
    setButtonActive('infrastructure', visible);
}

function showInfrastructurePopup(event, layerKind) {
    if (!event || !Array.isArray(event.features) || !event.features.length) return;
    const feature = event.features[0];
    const p = feature.properties || {};
    const kind = String(layerKind || p._kind || 'Infrastructure');
    const accents = {
        outage: '#f59e0b',
        hospital: '#38bdf8',
        shelter: '#22c55e',
        substation: '#a78bfa',
        trailer_park: '#fb7185',
        camp: '#166534'
    };
    const accent = accents[kind] || '#60a5fa';
    let title = 'Infrastructure';
    let subtitle = '';
    let rows = '';

    if (kind === 'outage') {
        title = 'Power Outage';
        subtitle = p.utility || p.provider || p.UtilityCompany || 'Utility Provider';
        rows += infrastructurePopupRow('Impacted', Number.isFinite(Number(p.impacted)) ? Number(p.impacted).toLocaleString() : '--');
        rows += infrastructurePopupRow('County', [p.county || p.COUNTY || '', p.state || p.STATE || ''].filter(Boolean).join(', ') || '--');
        rows += infrastructurePopupRow('Source', p.source || p._sourceTag || 'ArcGIS');
    } else if (kind === 'hospital') {
        title = 'Hospital';
        subtitle = p.name || p.NAME || 'Hospital';
        rows += infrastructurePopupRow('Type', p.type || p.TYPE || '--');
        rows += infrastructurePopupRow('Location', [p.city || p.CITY || '', p.state || p.STATE || ''].filter(Boolean).join(', ') || '--');
    } else if (kind === 'shelter') {
        title = 'Shelter';
        subtitle = p.name || p.shelter_name || 'Shelter';
        rows += infrastructurePopupRow('Address', p.address || p.address_1 || '--');
        rows += infrastructurePopupRow('Location', [p.city || '', p.state || ''].filter(Boolean).join(', ') || '--');
    } else if (kind === 'substation') {
        title = 'Substation';
        subtitle = p.name || p.NAME || 'Electric Substation';
        rows += infrastructurePopupRow('Max Voltage', p.maxVoltage || p.MAX_VOLT || '--');
        rows += infrastructurePopupRow('Location', [p.city || p.CITY || '', p.state || p.STATE || ''].filter(Boolean).join(', ') || '--');
    } else if (kind === 'trailer_park') {
        title = 'Trailer Park';
        subtitle = p.name || p.NAME || 'Mobile Home Community';
        rows += infrastructurePopupRow('Category', p.category || 'Trailer Park');
        rows += infrastructurePopupRow('Source', p.source || p._sourceTag || '--');
    } else {
        title = 'Camp';
        subtitle = p.name || p.NAME || 'Camp Site';
        rows += infrastructurePopupRow('Category', p.category || 'Camp');
        rows += infrastructurePopupRow('Source', p.source || p._sourceTag || '--');
    }

    const lngLat = event.lngLat || (() => {
        try {
            const geom = feature?.geometry;
            if (geom?.type === 'Point' && Array.isArray(geom.coordinates)) {
                return { lng: Number(geom.coordinates[0]), lat: Number(geom.coordinates[1]) };
            }
            if (geom?.type === 'LineString' && Array.isArray(geom.coordinates) && geom.coordinates.length) {
                return { lng: Number(geom.coordinates[0][0]), lat: Number(geom.coordinates[0][1]) };
            }
        } catch {}
        return null;
    })();
    if (!lngLat || !Number.isFinite(lngLat.lng) || !Number.isFinite(lngLat.lat)) return;

    const html = `
        <div class="infra-popup-card" style="--infra-accent:${accent}">
            <div class="infra-popup-title">${escapeInfrastructureHtml(title)}</div>
            <div class="infra-popup-subtitle">${escapeInfrastructureHtml(subtitle || '--')}</div>
            <div class="infra-popup-grid">${rows}</div>
        </div>
    `;

    new maplibregl.Popup({
        closeButton: true,
        closeOnClick: true,
        className: 'infrastructure-popup',
        maxWidth: '330px'
    })
        .setLngLat(lngLat)
        .setHTML(html)
        .addTo(map);
}

function bindInfrastructureInteractions() {
    if (!map || map.__infraInteractionsBound) return;
    map.__infraInteractionsBound = true;
    const bindingMap = [
        { layerId: INFRA_LAYER_IDS.hospitals, kind: 'hospital' },
        { layerId: INFRA_LAYER_IDS.shelters, kind: 'shelter' },
        { layerId: INFRA_LAYER_IDS.substations, kind: 'substation' },
        { layerId: INFRA_LAYER_IDS.trailerParks, kind: 'trailer_park' },
        { layerId: INFRA_LAYER_IDS.camps, kind: 'camp' }
    ];

    bindingMap.forEach(({ layerId, kind }) => {
        try {
            map.on('mouseenter', layerId, () => {
                try { map.getCanvas().style.cursor = 'pointer'; } catch {}
            });
            map.on('mouseleave', layerId, () => {
                try { map.getCanvas().style.cursor = ''; } catch {}
            });
            map.on('click', layerId, (event) => {
                showInfrastructurePopup(event, kind);
            });
        } catch {}
    });
}

function scheduleInfrastructureRefresh(delayMs = 360, force = false, allowHidden = false) {
    if (infrastructureRefreshTimer) {
        clearTimeout(infrastructureRefreshTimer);
        infrastructureRefreshTimer = null;
    }
    infrastructureRefreshTimer = setTimeout(() => {
        infrastructureRefreshTimer = null;
        refreshInfrastructureData({ force, allowHidden }).catch(() => {});
    }, Math.max(0, Number(delayMs) || 0));
}

async function refreshInfrastructureData({ force = false, allowHidden = false } = {}) {
    if (!map || (!infrastructureState.visible && !allowHidden)) return false;
    if (infrastructureState.loading) {
        infrastructureState.refreshQueued = true;
        return false;
    }

    const now = Date.now();
    const bounds = getInfrastructureBoundsEnvelope();
    const boundsKey = getInfrastructureBoundsKey(bounds);
    if (!force && boundsKey && boundsKey === infrastructureState.lastBoundsKey && (now - infrastructureState.lastFetchAt) < 16000) {
        return false;
    }

    infrastructureState.loading = true;
    try {
        const zoom = Number(map.getZoom?.() || 4);
        const fetchExposureSites = zoom >= 6;

        const [hospitalsRes, sheltersRes, substationsRes, exposureSitesRes] = await Promise.allSettled([
            queryArcGisAsGeoJson({
                serviceUrl: INFRASTRUCTURE_FEEDS.hospitals,
                outFields: 'OBJECTID,NAME,CITY,STATE,TYPE,STATUS',
                maxFeatures: 1600,
                bounds,
                sourceTag: 'Hospitals'
            }),
            queryArcGisAsGeoJson({
                serviceUrl: INFRASTRUCTURE_FEEDS.shelters,
                outFields: 'OBJECTID,shelter_name,address_1,city,state,status',
                maxFeatures: 1200,
                bounds,
                sourceTag: 'Shelters'
            }),
            queryArcGisAsGeoJson({
                serviceUrl: INFRASTRUCTURE_FEEDS.substations,
                outFields: 'OBJECTID,NAME,CITY,STATE,MAX_VOLT,OPERATORS',
                maxFeatures: 1800,
                bounds,
                sourceTag: 'Substations'
            }),
            fetchExposureSites
                ? fetchOverpassCriticalSites(bounds)
                : Promise.resolve({ trailerParks: infrastructureEmptyCollection(), camps: infrastructureEmptyCollection() })
        ]);

        if (hospitalsRes.status === 'fulfilled') {
            const features = hospitalsRes.value.features.map((f) => ({
                ...f,
                properties: {
                    ...(f.properties || {}),
                    name: f.properties?.name || f.properties?.NAME || '',
                    city: f.properties?.city || f.properties?.CITY || '',
                    state: f.properties?.state || f.properties?.STATE || '',
                    type: f.properties?.type || f.properties?.TYPE || ''
                }
            }));
            setInfrastructureSourceData(INFRA_SOURCE_IDS.hospitals, { type: 'FeatureCollection', features });
        }

        if (sheltersRes.status === 'fulfilled') {
            const features = sheltersRes.value.features.map((f) => ({
                ...f,
                properties: {
                    ...(f.properties || {}),
                    name: f.properties?.name || f.properties?.shelter_name || '',
                    city: f.properties?.city || '',
                    state: f.properties?.state || '',
                    address: f.properties?.address || f.properties?.address_1 || ''
                }
            }));
            setInfrastructureSourceData(INFRA_SOURCE_IDS.shelters, { type: 'FeatureCollection', features });
        }

        if (substationsRes.status === 'fulfilled') {
            const features = substationsRes.value.features.map((f) => ({
                ...f,
                properties: {
                    ...(f.properties || {}),
                    name: f.properties?.name || f.properties?.NAME || '',
                    city: f.properties?.city || f.properties?.CITY || '',
                    state: f.properties?.state || f.properties?.STATE || '',
                    maxVoltage: f.properties?.maxVoltage || f.properties?.MAX_VOLT || ''
                }
            }));
            setInfrastructureSourceData(INFRA_SOURCE_IDS.substations, { type: 'FeatureCollection', features });
        }

        if (exposureSitesRes.status === 'fulfilled') {
            const trailerParks = exposureSitesRes.value?.trailerParks || infrastructureEmptyCollection();
            const camps = exposureSitesRes.value?.camps || infrastructureEmptyCollection();
            setInfrastructureSourceData(INFRA_SOURCE_IDS.trailerParks, trailerParks);
            setInfrastructureSourceData(INFRA_SOURCE_IDS.camps, camps);
        }

        infrastructureState.lastFetchAt = Date.now();
        infrastructureState.lastBoundsKey = boundsKey;
        return true;
    } catch (error) {
        console.warn('refreshInfrastructureData failed', error);
        return false;
    } finally {
        infrastructureState.loading = false;
        if (infrastructureState.refreshQueued) {
            infrastructureState.refreshQueued = false;
            scheduleInfrastructureRefresh(280, true, allowHidden);
        }
    }
}

async function toggleInfrastructureLayer() {
    if (!map) return false;
    ensureInfrastructureLayers();

    const currentlyVisible = infrastructureState.visible;
    if (currentlyVisible) {
        setInfrastructureLayerVisibility('none');
        updateLegendBar();
        return false;
    }

    setInfrastructureLayerVisibility('visible');
    updateLegendBar();
    await refreshInfrastructureData({ force: true });
    return true;
}

function captureLayerStates() {
    return {
        radarActive: isButtonActive('radar'),
        precipActive: isButtonActive('preciptype'),
        warningsActive: isButtonActive('warnings'),
        outagesActive: isButtonActive('power-outages') || powerOutageState.visible,
        infrastructureActive: isButtonActive('infrastructure') || infrastructureState.visible
    };
}

function applyOutlookFocus() {
    if (cameraAutoCycleState.active) {
        stopCameraAutoCycle();
    }
    setLayerVisibility(radarLayer, 'none');
    setPrecipVisibility('none');
    toggleWarningLayers('none');
    setPowerOutageLayerVisibility('none');
    setInfrastructureLayerVisibility('none');
    setButtonActive('radar', false);
    setButtonActive('preciptype', false);
    setButtonActive('warnings', false);
    setButtonActive('power-outages', false);
    setButtonActive('infrastructure', false);
}

function restoreLayersAfterOutlook() {
    const prev = spcOutlookPreviousState;
    spcOutlookPreviousState = null;
    if (!prev) return;

    setLayerVisibility(radarLayer, prev.radarActive ? 'visible' : 'none');
    setButtonActive('radar', !!prev.radarActive);

    setPrecipVisibility(prev.precipActive ? 'visible' : 'none');
    setButtonActive('preciptype', !!prev.precipActive);

    toggleWarningLayers(prev.warningsActive ? 'visible' : 'none');
    setButtonActive('warnings', !!prev.warningsActive);

    if (prev.outagesActive) {
        ensurePowerOutageLayers();
        setPowerOutageLayerVisibility('visible');
        schedulePowerOutageRefresh(90, true, false);
    } else {
        setPowerOutageLayerVisibility('none');
    }

    if (prev.infrastructureActive) {
        ensureInfrastructureLayers();
        setInfrastructureLayerVisibility('visible');
        scheduleInfrastructureRefresh(80, true);
    } else {
        setInfrastructureLayerVisibility('none');
    }
}

function restoreLayersAfterWpcEro() {
    const prev = wpcEroPreviousState;
    wpcEroPreviousState = null;
    if (!prev) return;

    setLayerVisibility(radarLayer, prev.radarActive ? 'visible' : 'none');
    setButtonActive('radar', !!prev.radarActive);

    setPrecipVisibility(prev.precipActive ? 'visible' : 'none');
    setButtonActive('preciptype', !!prev.precipActive);

    toggleWarningLayers(prev.warningsActive ? 'visible' : 'none');
    setButtonActive('warnings', !!prev.warningsActive);

    if (prev.outagesActive) {
        ensurePowerOutageLayers();
        setPowerOutageLayerVisibility('visible');
        schedulePowerOutageRefresh(90, true, false);
    } else {
        setPowerOutageLayerVisibility('none');
    }

    if (prev.infrastructureActive) {
        ensureInfrastructureLayers();
        setInfrastructureLayerVisibility('visible');
        scheduleInfrastructureRefresh(80, true);
    } else {
        setInfrastructureLayerVisibility('none');
    }
}

function setLayerVisibility(layerId, visibility) {
    try {
        if (!layerId || !map?.getLayer(layerId)) return;
        map.setLayoutProperty(layerId, 'visibility', visibility);
    } catch {}
}

function toggleWarningLayers(visibility) {
    try {
        warningLayers.forEach(layerId => {
            if (map?.getLayer(layerId)) {
                map.setLayoutProperty(layerId, 'visibility', visibility);
            }
        });
    } catch {}
}

function setPrecipVisibility(visibility) {
    try {
        if (map) {
            // Handle radar layer
            if (radarLayer && map.getLayer(radarLayer)) {
                map.setLayoutProperty(radarLayer, 'visibility', visibility);
            }
            // Handle precipitation type layer
            if (map.getLayer('precipitation-type-layer')) {
                map.setLayoutProperty('precipitation-type-layer', 'visibility', visibility);
            }
        }
    } catch (e) {
        console.warn('setPrecipVisibility failed', e);
    }
}

function setButtonActive(layerName, isActive) {
    let button = document.querySelector(`[data-layer="${layerName}"]`) || document.getElementById(`${layerName}-toggle`);
    if (!button && layerName === 'power-outages') button = getPowerOutagesToggleButton();
    if (!button && layerName === 'storm-reports') button = getStormReportsToggleButton();
    if (!button && layerName === 'spc-outlook') button = getSpcOutlookToggleButton();
    if (!button && layerName === 'infrastructure') button = getInfrastructureToggleButton();
    if (!button && layerName === 'draw') button = getDrawToggleTopButton();
    if (button) {
        if (isActive) {
            button.classList.add('active');
        } else {
            button.classList.remove('active');
        }
    }
}

function isButtonActive(layerName) {
    let button = document.querySelector(`[data-layer="${layerName}"]`);
    if (!button && layerName === 'power-outages') button = getPowerOutagesToggleButton();
    if (!button && layerName === 'storm-reports') button = getStormReportsToggleButton();
    if (!button && layerName === 'spc-outlook') button = getSpcOutlookToggleButton();
    if (!button && layerName === 'infrastructure') button = getInfrastructureToggleButton();
    if (!button && layerName === 'draw') button = getDrawToggleTopButton();
    return !!(button && button.classList.contains('active'));
}

function updateLegendBar() {
    const legendEl = document.getElementById('legend-bar');
    if (!legendEl) return;

    // Hide the default legend bar as we're using a custom overlay
    legendEl.setAttribute('hidden', '');
    
    // Create or update the active layers overlay
    updateActiveLayersOverlay();
}

function updateActiveLayersOverlay() {
    let overlay = document.getElementById('active-layers-overlay');
    
    // Create the overlay if it doesn't exist
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'active-layers-overlay';
        overlay.className = 'active-layers-overlay';
        document.querySelector('.weather-map-content').appendChild(overlay);
        
        // Add CSS for the overlay
        const style = document.createElement('style');
        style.textContent = `
            .active-layers-overlay {
                position: absolute;
                bottom: 20px;
                left: 20px;
                background: rgba(0, 0, 0, 0.7);
                border-radius: 8px;
                padding: 12px 16px;
                color: white;
                font-family: 'Inter', sans-serif;
                font-size: 14px;
                z-index: 1000;
                backdrop-filter: blur(5px);
                border: 1px solid rgba(255, 255, 255, 0.1);
                max-width: 300px;
                box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
            }
            .active-layers-overlay h3 {
                margin: 0 0 10px 0;
                font-size: 16px;
                font-weight: 600;
                color: #fff;
                text-transform: uppercase;
                letter-spacing: 0.5px;
            }
            .precip-legend {
                display: flex;
                flex-direction: column;
                gap: 6px;
            }
            .precip-item {
                display: flex;
                align-items: center;
                gap: 8px;
            }
            .precip-color {
                width: 20px;
                height: 12px;
                border-radius: 2px;
            }
            .precip-label {
                font-size: 13px;
            }
            .spc-outlook-legend {
                margin-top: 10px;
                padding-top: 10px;
                border-top: 1px solid rgba(255, 255, 255, 0.1);
            }
            .infrastructure-legend {
                margin-top: 10px;
                padding-top: 10px;
                border-top: 1px solid rgba(255, 255, 255, 0.1);
            }
        `;
        document.head.appendChild(style);
    }
    
    // Check which layers are active
    const isSpcOutlookActive = spcOutlookState.visible;
    const isPowerOutagesActive = powerOutageState.visible;
    const isInfrastructureActive = infrastructureState.visible;
    
    // Build the content based on active layers
    let content = '';
    
    // Add SPC Outlook legend if active
    if (isSpcOutlookActive) {
        const legendSet = SPC_LEGEND_SETS[getSpcLegendSetKey()] || SPC_LEGEND_SETS.cat;
        const dayLabel = String(spcOutlookState.day || 'day1').toUpperCase().replace('DAY', 'DAY ');
        const outlookLegend = `
            <div class="spc-outlook-legend">
                <h3>${dayLabel} ${legendSet.title.toUpperCase()}</h3>
                ${legendSet.entries.map(entry => `
                    <div class="precip-item">
                        <div class="precip-color" style="background: ${entry.color || '#ccc'}"></div>
                        <span class="precip-label">${entry.label}</span>
                    </div>
                `).join('')}
            </div>
        `;
        content += outlookLegend;
    }

    if (isPowerOutagesActive) {
        const outageLegend = `
            <div class="infrastructure-legend">
                <h3>POWER OUTAGES</h3>
                <div class="precip-item">
                    <div class="precip-color" style="background:#facc15"></div>
                    <span class="precip-label">1 - 999 customers</span>
                </div>
                <div class="precip-item">
                    <div class="precip-color" style="background:#f59e0b"></div>
                    <span class="precip-label">1,000 - 4,999</span>
                </div>
                <div class="precip-item">
                    <div class="precip-color" style="background:#f97316"></div>
                    <span class="precip-label">5,000 - 24,999</span>
                </div>
                <div class="precip-item">
                    <div class="precip-color" style="background:#ea580c"></div>
                    <span class="precip-label">25,000 - 99,999</span>
                </div>
                <div class="precip-item">
                    <div class="precip-color" style="background:#dc2626"></div>
                    <span class="precip-label">100,000+</span>
                </div>
            </div>
        `;
        content += outageLegend;
    }

    if (isInfrastructureActive) {
        const infrastructureLegend = `
            <div class="infrastructure-legend">
                <h3>INFRASTRUCTURE</h3>
                <div class="precip-item">
                    <div class="precip-color" style="background:#38bdf8"></div>
                    <span class="precip-label">Hospitals</span>
                </div>
                <div class="precip-item">
                    <div class="precip-color" style="background:#22c55e"></div>
                    <span class="precip-label">Shelters</span>
                </div>
                <div class="precip-item">
                    <div class="precip-color" style="background:#a78bfa"></div>
                    <span class="precip-label">Substations</span>
                </div>
                <div class="precip-item">
                    <div class="precip-color" style="background:#fb7185"></div>
                    <span class="precip-label">Trailer Parks</span>
                </div>
                <div class="precip-item">
                    <div class="precip-color" style="background:#166534"></div>
                    <span class="precip-label">Camps</span>
                </div>
            </div>
        `;
        content += infrastructureLegend;
    }
    
    // Show or hide the overlay based on content
    if (content) {
        overlay.innerHTML = content;
        overlay.style.display = 'block';
    } else {
        overlay.style.display = 'none';
    }
}

function renderLegendBar(title, entries) {
    const legendEl = document.getElementById('legend-bar');
    if (!legendEl) return;
    legendEl.removeAttribute('hidden');
    const titleHtml = `<span class="legend-title">${title}</span>`;
    const entriesHtml = entries.map(entry => {
        const { label, color } = entry;
        const safeColor = color || '#ccc';
        return `<span class="legend-entry"><span class="legend-swatch" style="background:${safeColor}"></span>${label}</span>`;
    }).join('');
    legendEl.innerHTML = `${titleHtml}${entriesHtml}`;
}

// Show warning details popup
function showWarningDetails(warning, coordinates) {
    const props = warning && warning.properties ? warning.properties : {};
    try { if (currentWarningPopup) { currentWarningPopup.remove(); currentWarningPopup = null; } } catch {}
    try {
        if (typeof window !== 'undefined' && typeof window.setMapHudSelectedWarning === 'function') {
            window.setMapHudSelectedWarning(warning);
        }
    } catch {}
    // Map warning details are shown in the fixed top-left HUD card.
    return;
    const getDisplay = (typeof window !== 'undefined' && typeof window.getDisplayEventName === 'function') ? window.getDisplayEventName : (e)=>String(e||'').toUpperCase();
    const getHaz = (typeof window !== 'undefined' && typeof window.getHazardText === 'function') ? window.getHazardText : ()=>'';
    const getWhat = (typeof window !== 'undefined' && typeof window.getWhatText === 'function') ? window.getWhatText : ()=>'';
    const getImpacts = (typeof window !== 'undefined' && typeof window.getImpactsText === 'function') ? window.getImpactsText : ()=>'';
    const getSource = (typeof window !== 'undefined' && typeof window.getSourceText === 'function') ? window.getSourceText : ()=>'';

    const displayEvent = getDisplay(props.event, props);
    const title = displayEvent || props.event || 'Weather Warning';
    const color = props._color || '#60a5fa';

    // Build WeatherWise deep link to radar centered on the warning
    const wwLink = (() => {
        const geom = warning && warning.geometry;
        if (!geom || !geom.coordinates) return null;
        let lat = 0, lon = 0, n = 0;
        try {
            if (geom.type === 'Polygon') {
                const ring = geom.coordinates[0] || [];
                ring.forEach(([x, y]) => { lon += x; lat += y; n++; });
            } else if (geom.type === 'MultiPolygon') {
                const ring = (geom.coordinates[0] && geom.coordinates[0][0]) || [];
                ring.forEach(([x, y]) => { lon += x; lat += y; n++; });
            } else if (geom.type === 'Point') {
                lon = geom.coordinates[0];
                lat = geom.coordinates[1];
                n = 1;
            }
            if (!n) return null;
            lat /= n; lon /= n;
            const base = 'https://web.weatherwise.app/?utm_medium=social&utm_source=ww_share';
            return `${base}#map=9.84/${lat.toFixed(4)}/${lon.toFixed(4)}&m=RADAR&sc=GOES-East&sp=ABI_GeoColor&mid=HRRR-SUBHOURLY&mr=CONUS`;
        } catch { return null; }
    })();

    // Build location chips similar to cards
    const chipsHTML = (() => {
        const area = props.areaDesc || '';
        if (!area) return '';
        const entries = area.split(';').map(s => s.trim()).filter(Boolean);
        const states = new Set();
        entries.forEach(entry => {
            let county = entry, state = '';
            const parts = entry.split(',');
            if (parts.length >= 2) {
                county = parts[0].trim();
                state = parts[1].trim();
            } else {
                const m = entry.split(/\s+/);
                const last = m[m.length - 1];
                if (/^[A-Z]{2}$/.test(last)) { state = last; county = m.slice(0, -1).join(' '); }
            }
            if (state) states.add(state);
        });
        const stateChips = Array.from(states).map(s => `<span style="display:inline-block;padding:.2rem .5rem;border-radius:999px;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.2);color:#ddd;margin:0 .25rem .25rem 0;font-size:.72rem;font-weight:700;">${s}</span>`).join('');
        return `<div style="margin:.35rem 0 .25rem; display:flex; flex-wrap:wrap;">${stateChips}</div>`;
    })();

    // Time progress like the cards
    const timeHTML = (() => {
        if (!props.sent || !props.expires) return '';
        const sentDate = new Date(props.sent);
        const expDate = new Date(props.expires);
        const now = new Date();
        const totalMs = Math.max(0, expDate - sentDate);
        const remainMs = Math.max(0, expDate - now);
        const pct = totalMs > 0 ? Math.max(0, Math.min(100, (remainMs / totalMs) * 100)) : 0;
        const fmt = (d) => {
            try {
                return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            } catch { return d.toISOString().slice(11,16); }
        };
        return `
            <div style="margin:.5rem 0 .4rem">
                <div style="display:flex;justify-content:space-between;align-items:center;color:rgba(255,255,255,.9);font-weight:700;font-size:.8rem;margin-bottom:.25rem;gap:.75rem">
                    <span style="display:inline-flex;gap:.4rem;align-items:center"><span style="opacity:.75">Issued</span><span>${fmt(sentDate)}</span></span>
                    <span style="display:inline-flex;gap:.4rem;align-items:center"><span style="opacity:.75">Expires</span><span>${fmt(expDate)}</span></span>
                </div>
                <div style="height:6px;background:rgba(255,255,255,.08);border-radius:999px;overflow:hidden;position:relative;">
                    <div style="height:100%;width:${pct}%;background:${color};border-radius:999px"></div>
                </div>
            </div>`;
    })();

    // Section text similar to cards (What for certain events)
    const uEvent = String(displayEvent || '').toUpperCase();
    const isFloodWarnOrAdvisory = (uEvent.includes('FLOOD') && (uEvent.includes('WARNING') || uEvent.includes('ADVISORY')));
    const useWhat = (uEvent === 'WINTER STORM WARNING' || uEvent === 'WINTER WEATHER ADVISORY' || isFloodWarnOrAdvisory);
    const sectionLabel = useWhat ? 'What:' : 'Hazard:';
    const sectionText = useWhat ? (getWhat(props) || '') : (getHaz(props) || '');
    const hazardHTML = sectionText ? `<div style="margin:.35rem 0 .2rem"><div style="font-weight:800;color:#ffcc66;margin-bottom:.15rem">${sectionLabel}</div><div style="color:rgba(255,255,255,.9)">${sectionText}</div></div>` : '';

    
    // Metrics similar to cards with hide rules
    const isWatch = uEvent.includes('WATCH');
    const hideAllMetrics = (uEvent === 'WINTER STORM WARNING' || uEvent === 'WINTER WEATHER ADVISORY' || isWatch || uEvent === 'FREEZE WARNING' || uEvent === 'AIR QUALITY ALERT');
    let metricsHTML = '';
    if (!hideAllMetrics) {
        const isFloodFamily = (uEvent === 'FLASH FLOOD WARNING' || uEvent === 'FLOOD WARNING' || uEvent === 'FLOOD ADVISORY');
        let windVal = '';
        if (!isFloodFamily && props.parameters && props.parameters.maxWindGust) {
            const windValRaw = Array.isArray(props.parameters.maxWindGust) ? props.parameters.maxWindGust[0] : props.parameters.maxWindGust;
            windVal = String(windValRaw).replace(/\s*MPH\s*$/i, '') + ' MPH';
        }
        let hailVal = '';
        if (!isFloodFamily && props.parameters && props.parameters.maxHailSize) {
            const hailValRaw = Array.isArray(props.parameters.maxHailSize) ? props.parameters.maxHailSize[0] : props.parameters.maxHailSize;
            hailVal = String(hailValRaw) + ' IN';
        }
        const sourceText = getSource(props) || '—';
        const showSource = (uEvent !== 'FLOOD WARNING' && uEvent !== 'FLOOD ADVISORY');
        metricsHTML = `
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:.4rem;margin-top:.4rem">
            ${!isFloodFamily ? `<div style=\"background:rgba(0,0,0,.25);border:1px solid rgba(255,255,255,.08);border-radius:8px;padding:.4rem .5rem\">\n                <div style=\"color:rgba(255,255,255,.7);font-size:.7rem;font-weight:700\">MAX WIND</div>\n                <div style=\"color:#fff;font-size:.95rem;font-weight:800\">${windVal || '—'}</div>\n            </div>` : ''}
            ${!isFloodFamily ? `<div style=\"background:rgba(0,0,0,.25);border:1px solid rgba(255,255,255,.08);border-radius:8px;padding:.4rem .5rem\">\n                <div style=\"color:rgba(255,255,255,.7);font-size:.7rem;font-weight:700\">MAX HAIL</div>\n                <div style=\"color:#fff;font-size:.95rem;font-weight:800\">${hailVal || '—'}</div>\n            </div>` : ''}
            ${showSource ? `<div style=\"background:rgba(0,0,0,.25);border:1px solid rgba(255,255,255,.08);border-radius:8px;padding:.4rem .5rem\">\n                <div style=\"color:rgba(255,255,255,.7);font-size:.7rem;font-weight:700\">SOURCE</div>\n                <div style=\"color:#ffcc66;font-size:.95rem;font-weight:800\">${sourceText}</div>\n            </div>` : ''}
        </div>`;
    }

    // Details section: concise body text from description
    const fullDesc = String(props.description || '').trim();
    const detailsHTML = fullDesc ? `<div style="margin:.35rem 0 .2rem"><div style="font-weight:800;color:#ffcc66;margin-bottom:.15rem">Details</div><div style="color:rgba(255,255,255,.9);line-height:1.45">${fullDesc.replace(/\n/g,'<br>')}</div></div>` : '';

    // NWS product link if available
    const nwsLink = (props && (props.id || props.url)) ? (props.url || props.id) : '';

    // Close any existing popup before opening a new one
    try { if (currentWarningPopup) { currentWarningPopup.remove(); currentWarningPopup = null; } } catch {}
    const popup = new maplibregl.Popup({ closeButton: true, closeOnClick: true, className: 'warning-popup storm-popup popup-theme' });
    const content = buildClassicPanelHTML(warning, { includeLinks: true });

    popup.setLngLat(coordinates).setHTML(`<div class="popup-card">${content}</div>`).addTo(map);
    currentWarningPopup = popup;

    // One-time: if user clicks outside the map container, close the popup
    if (!map.__outsidePopupCloserBound) {
        document.addEventListener('click', (e) => {
            try {
                if (!currentWarningPopup) return;
                const mapEl = document.getElementById('weather-map');
                if (!mapEl) return;
                if (mapEl.contains(e.target)) return; // clicks inside map handled by closeOnClick
                currentWarningPopup.remove();
                currentWarningPopup = null;
            } catch {}
        });
        map.__outsidePopupCloserBound = true;
    }
}

// Build a classic stacked panel like the examples (title, expires, areas first for all types)
function buildClassicPanelHTML(warning, options = {}) {
    try {
        const props = warning?.properties || {};
        const getDisplay = (typeof window !== 'undefined' && typeof window.getDisplayEventName === 'function') ? window.getDisplayEventName : (e)=>String(e||'').toUpperCase();
        const getSource = (typeof window !== 'undefined' && typeof window.getSourceText === 'function') ? window.getSourceText : ()=>'';
        const getPeople = (typeof window !== 'undefined' && typeof window.getPeopleAffected === 'function') ? window.getPeopleAffected : ()=>null;
        const displayEvent = getDisplay(props.event, props);
        const color = props._color || '#60a5fa';

        const header = `
            <div class="popup-header">
                <span class="popup-title">${escapeHtmlLite(displayEvent)}</span>
            </div>`;

        // Expires in X minutes
        const remainMin = (() => {
            if (!props.expires) return null;
            const now = new Date();
            const exp = new Date(props.expires);
            return Math.max(0, Math.round((exp - now) / 60000));
        })();
        const expiresRow = remainMin != null ? row('EXPIRES', `IN ${remainMin} MINUTES`, color) : '';

        // Areas: show the full county/area list from the warning
        const areasText = (() => {
            const area = String(props.areaDesc || '');
            if (!area) return '';
            const formatArea = (entry) => {
                const text = String(entry || '').trim().toUpperCase();
                if (!text) return '';
                const helper = (typeof window !== 'undefined' && typeof window.formatAreaWithState === 'function')
                    ? window.formatAreaWithState
                    : null;
                try {
                    return helper ? String(helper(text) || text).toUpperCase() : text;
                } catch {
                    return text;
                }
            };
            const parts = area
                .split(';')
                .map((s) => formatArea(s))
                .filter(Boolean);
            if (!parts.length) return '';
            const seen = new Set();
            const unique = [];
            parts.forEach((part) => {
                const key = String(part).toUpperCase();
                if (seen.has(key)) return;
                seen.add(key);
                unique.push(part);
            });
            return unique.join(', ');
        })();
        const areasRow = areasText ? row('AREAS', areasText, color) : '';

        // Population
        const people = getPeople(props);
        const fmtNum = (n)=>{ try { return Number(n).toLocaleString(); } catch { return String(n||''); } };
        const popRow = people ? row('POPULATION', fmtNum(people), color) : '';

        // Source
        const sourceTxt = (getSource(props) || '').trim();
        const sourceRow = sourceTxt ? row('SOURCE', sourceTxt.toUpperCase(), color) : '';

        // Metrics (hail/wind)
        const uEvent = String(displayEvent || '').toUpperCase();
        const params = props.parameters || {};
        const hail = Array.isArray(params.maxHailSize) ? params.maxHailSize[0] : params.maxHailSize;
        const wind = Array.isArray(params.maxWindGust) ? params.maxWindGust[0] : params.maxWindGust;
        const isFloodFamily = (uEvent === 'FLASH FLOOD WARNING' || uEvent === 'FLOOD WARNING' || uEvent === 'FLOOD ADVISORY');
        const hailRow = (!isFloodFamily && hail != null) ? row('MAX HAIL', `${String(hail)} IN`, color) : '';
        const windRow = wind != null ? row('MAX WIND', `${String(wind).toString().replace(/\s*MPH\s*$/i,'')} MPH`, color) : '';

        // Tornado indicator
        const descU = String(props.description||'').toUpperCase();
        let tornadoRow = '';
        if (uEvent.includes('SEVERE THUNDERSTORM')) {
            if (descU.includes('TORNADO POSSIBLE')) tornadoRow = row('TORNADO', 'POSSIBLE', color, true);
        } else if (uEvent.includes('TORNADO WARNING')) {
            const val = sourceTxt.toUpperCase().includes('RADAR') ? 'RADAR INDICATED' : '—';
            tornadoRow = row('TORNADO', val, color, true);
        }

        // Flood hazard/damage threat
        let floodHazard = '';
        let damageThreat = '';
        if (uEvent.includes('FLOOD')) {
            const m = descU.match(/CONSIDERABLE|CATASTROPHIC/);
            if (m) damageThreat = row('DAMAGE THREAT', m[0], color, true);
            const hz = (()=>{ const mm = descU.match(/HAZARD\s*[:.\-–—]*\s*([\s\S]*?)(?:\n\s*\n|\n\s*(IMPACTS|SOURCE|WHAT|WHERE|WHEN)\b)/i); return mm && mm[1] ? mm[1].toString().trim().toUpperCase() : ''; })();
            if (hz) floodHazard = row('HAZARD', hz, color);
        }

        const panel = `
        <div style="background:transparent;border:none;overflow:visible;min-width:280px;max-width:380px">
            ${header}
            ${expiresRow}
            ${areasRow}
            ${popRow}
            ${sourceRow}
            ${hailRow}
            ${windRow}
            ${tornadoRow}
            ${floodHazard}
            ${damageThreat}
            ${options.includeLinks ? actions(warning) : ''}
        </div>`;
        return panel;
    } catch {
        return '<div style="color:#fff;background:#111;padding:10px;border-radius:8px">Warning details unavailable</div>';
    }

    function row(label, value, color, emphasize = false) {
        const bg = colorize(color, .85);
        const strong = emphasize ? 'font-weight:900;color:#ffeb3b' : 'font-weight:800;color:#fff';
        return `<div style=\"background:${bg};padding:.6rem .8rem;border-top:1px solid rgba(0,0,0,.25);text-shadow:0 1px 0 rgba(0,0,0,.25)\">\n            <span style=\"opacity:.95;color:#111;background:rgba(255,255,255,.7);padding:.1rem .35rem;border-radius:3px;font-weight:900;letter-spacing:.06em;font-size:.72rem;margin-right:.5rem\">${label}:\</span>\n            <span style=\"${strong};letter-spacing:.02em\">${escapeHtmlLite(value)}\</span>\n        </div>`;
    }

    function actions(warn) {
        const geomLink = (() => {
            const geom = warn?.geometry; if (!geom) return null;
            try {
                let lat=0,lon=0,n=0; if (geom.type==='Polygon'){(geom.coordinates[0]||[]).forEach(([x,y])=>{lon+=x;lat+=y;n++;});}
                else if (geom.type==='MultiPolygon'){const ring=(geom.coordinates[0]&&geom.coordinates[0][0])||[];ring.forEach(([x,y])=>{lon+=x;lat+=y;n++;});}
                else if (geom.type==='Point'){lon=geom.coordinates[0];lat=geom.coordinates[1];n=1;}
                if (!n) return null; lat/=n; lon/=n; return `https://web.weatherwise.app/#map=9.8/${lat.toFixed(4)}/${lon.toFixed(4)}&m=RADAR`;
            } catch { return null; }
        })();
        const nws = warn?.properties?.url || warn?.properties?.id || '';
        return `<div style=\"display:flex;gap:.5rem;justify-content:flex-end;padding:.6rem .8rem;background:#0b0b12;border-top:1px solid rgba(255,255,255,.1)\">\n            ${geomLink ? `<a target=\"_blank\" rel=\"noopener\" href=\"${geomLink}\" style=\"background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.18);color:#fff;text-decoration:none;font-weight:800;font-size:.75rem;border-radius:6px;padding:.4rem .6rem\">WeatherWise</a>`:''}\n            ${nws ? `<a target=\"_blank\" rel=\"noopener\" href=\"${nws}\" style=\"background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.18);color:#fff;text-decoration:none;font-weight:800;font-size:.75rem;border-radius:6px;padding:.4rem .6rem\">NWS Product</a>`:''}\n        </div>`;
    }

    function escapeHtmlLite(s){
        return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    }

    function colorize(hex, alpha){
        if (!hex || !/^#?[0-9a-f]{6}$/i.test(hex)) return `rgba(255,255,255,0.08)`;
        const h = hex.replace('#',''); const r=parseInt(h.slice(0,2),16), g=parseInt(h.slice(2,4),16), b=parseInt(h.slice(4,6),16);
        return `rgba(${r},${g},${b},${alpha})`;
    }
}

// Sticky latest-warning overlay: disabled for a cleaner map UI
let latestStickyId = null;
function renderStickyLatestWarning() {
    try {
        const existing = document.getElementById('latest-warning-panel');
        if (existing && existing.parentElement) existing.parentElement.removeChild(existing);
    } catch {}
    return; // no-op
}

// Update map information display
function updateMapInfo() {
    if (!map) return;

    const center = map.getCenter();
    const zoom = map.getZoom().toFixed(1);
    
    const centerElement = document.getElementById('map-center');
    const zoomElement = document.getElementById('map-zoom');
    const warningsElement = document.getElementById('active-warnings');

    if (centerElement) {
        centerElement.textContent = `Center: ${center.lat.toFixed(2)}°, ${center.lng.toFixed(2)}°`;
    }

    if (zoomElement) {
        zoomElement.textContent = `Zoom: ${zoom}`;
    }

    if (warningsElement) {
        warningsElement.textContent = `Active Warnings: ${weatherWarnings.length} | Rendered: ${lastRenderedWarningsCount}`;
    }
}

function ensureMapStartupProgressBar() {
    let bar = document.getElementById('map-startup-progress');
    if (bar) return bar;
    const host = document.querySelector('#map-section .weather-map-content')
        || document.querySelector('.weather-map-content');
    if (!host) return null;
    bar = document.createElement('div');
    bar.id = 'map-startup-progress';
    bar.className = 'map-startup-progress';
    bar.setAttribute('hidden', '');
    bar.innerHTML = `
        <div class="map-startup-progress-track">
            <span class="map-startup-progress-fill" id="map-startup-progress-fill"></span>
        </div>
        <div class="map-startup-progress-text" id="map-startup-progress-text">Loading map data...</div>
    `;
    host.appendChild(bar);
    return bar;
}

function updateMapStartupProgressUi() {
    const bar = ensureMapStartupProgressBar();
    if (!bar) return;
    const fill = document.getElementById('map-startup-progress-fill');
    const text = document.getElementById('map-startup-progress-text');
    const total = Math.max(0, Number(mapStartupProgressState.total) || 0);
    const completed = Math.max(0, Number(mapStartupProgressState.completed) || 0);
    const failed = Math.max(0, Number(mapStartupProgressState.failed) || 0);
    const pct = total > 0 ? Math.max(0, Math.min(100, (completed / total) * 100)) : 0;
    if (fill) fill.style.width = `${pct.toFixed(1)}%`;

    if (mapStartupProgressState.active) {
        if (text) text.textContent = `LOADING MAP DATA ${Math.min(completed, total)}/${total}`;
        bar.dataset.state = 'loading';
        bar.removeAttribute('hidden');
        return;
    }

    if (completed >= total && total > 0) {
        if (text) text.textContent = failed > 0
            ? `MAP READY (${failed} SOURCE${failed === 1 ? '' : 'S'} FAILED)`
            : 'MAP READY';
        bar.dataset.state = failed > 0 ? 'warn' : 'done';
        bar.removeAttribute('hidden');
        if (mapStartupProgressHideTimer) clearTimeout(mapStartupProgressHideTimer);
        mapStartupProgressHideTimer = setTimeout(() => {
            try { bar.setAttribute('hidden', ''); } catch {}
        }, 1800);
    }
}

function startMapStartupProgress(taskKeys = []) {
    if (mapStartupProgressHideTimer) {
        clearTimeout(mapStartupProgressHideTimer);
        mapStartupProgressHideTimer = null;
    }
    mapStartupProgressState = {
        active: true,
        total: Math.max(0, Array.isArray(taskKeys) ? taskKeys.length : 0),
        completed: 0,
        failed: 0,
        tasks: new Set()
    };
    updateMapStartupProgressUi();
}

function markMapStartupTaskComplete(taskKey, { failed = false } = {}) {
    const key = String(taskKey || '').trim() || `task-${Date.now()}`;
    if (mapStartupProgressState.tasks.has(key)) return;
    mapStartupProgressState.tasks.add(key);
    mapStartupProgressState.completed += 1;
    if (failed) mapStartupProgressState.failed += 1;
    if (mapStartupProgressState.completed >= mapStartupProgressState.total) {
        mapStartupProgressState.active = false;
    }
    updateMapStartupProgressUi();
}

async function runMapStartupTask(taskKey, taskFn) {
    try {
        await taskFn();
        markMapStartupTaskComplete(taskKey, { failed: false });
    } catch (error) {
        console.warn(`[startup] ${taskKey} preload failed`, error);
        markMapStartupTaskComplete(taskKey, { failed: true });
    }
}

function getPreloadedStormReportsData(maxAgeMs = 180000) {
    if (!preloadedStormReportsData || !preloadedStormReportsAt) return null;
    if ((Date.now() - preloadedStormReportsAt) > Math.max(1000, Number(maxAgeMs) || 180000)) return null;
    return preloadedStormReportsData;
}

// Hide loading overlay
function hideLoadingOverlay() {
    const overlay = document.getElementById('loading-overlay');
    if (overlay) {
        overlay.style.display = 'none';
    }
}

// Show error message
function showError(message) {
    const overlay = document.getElementById('loading-overlay');
    if (overlay) {
        overlay.innerHTML = `
            <div style="color: #ef4444; text-align: center;">
                <div style="font-size: 2rem; margin-bottom: 1rem;">⚠️</div>
                <div style="font-size: 1.125rem; font-weight: 500;">${message}</div>
                <button onclick="location.reload()" style="
                    margin-top: 1rem;
                    padding: 0.5rem 1rem;
                    background: #60a5fa;
                    color: white;
                    border: none;
                    border-radius: 6px;
                    cursor: pointer;
                    font-weight: 600;
                ">Retry</button>
            </div>
        `;
    }
}

// Compute bounding box for a GeoJSON geometry (Polygon/MultiPolygon/Point)
function geometryToBbox(geometry) {
    if (!geometry) return null;
    try {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        const expand = (x, y) => {
            if (x < minX) minX = x;
            if (y < minY) minY = y;
            if (x > maxX) maxX = x;
            if (y > maxY) maxY = y;
        };
        if (geometry.type === 'Point') {
            const [x, y] = geometry.coordinates || [];
            if (typeof x === 'number' && typeof y === 'number') {
                expand(x, y);
            }
        } else if (geometry.type === 'Polygon') {
            const rings = geometry.coordinates || [];
            rings.forEach(r => r.forEach(([x, y]) => expand(x, y)));
        } else if (geometry.type === 'MultiPolygon') {
            const polys = geometry.coordinates || [];
            polys.forEach(p => p.forEach(r => r.forEach(([x, y]) => expand(x, y))));
        }
        if (!isFinite(minX) || !isFinite(minY) || !isFinite(maxX) || !isFinite(maxY)) return null;
        return [[minX, minY], [maxX, maxY]];
    } catch {
        return null;
    }
}

// Compute a rough centroid from a geometry for fallback placement
function geometryCentroid(geometry) {
    try {
        if (!geometry) return null;
        let xSum = 0, ySum = 0, n = 0;
        if (geometry.type === 'Point') {
            const [x, y] = geometry.coordinates || [];
            return (typeof x === 'number' && typeof y === 'number') ? { lng: x, lat: y } : null;
        } else if (geometry.type === 'Polygon') {
            const ring = (geometry.coordinates && geometry.coordinates[0]) || [];
            ring.forEach(([x, y]) => { xSum += x; ySum += y; n++; });
        } else if (geometry.type === 'MultiPolygon') {
            const ring = (geometry.coordinates && geometry.coordinates[0] && geometry.coordinates[0][0]) || [];
            ring.forEach(([x, y]) => { xSum += x; ySum += y; n++; });
        }
        if (!n) return null;
        return { lng: xSum / n, lat: ySum / n };
    } catch {
        return null;
    }
}

// Zoom/fit to a warning geometry and briefly highlight it
function zoomToWarningGeometry(geometry, options = {}) {
    if (!map || !geometry) return;
    const padding = options.padding ?? 80;
    const maxZoom = options.maxZoom ?? 12;

    const bbox = geometryToBbox(geometry);
    if (bbox) {
        map.fitBounds(bbox, { padding, maxZoom, duration: 800 });
    } else {
        const c = geometryCentroid(geometry);
        if (c) map.flyTo({ center: [c.lng, c.lat], zoom: 10, duration: 800 });
    }

    // Temporary highlight layer
    try {
        const srcId = 'focused-warning-src';
        const fillId = 'focused-warning-fill';
        const lineId = 'focused-warning-line';

        if (map.getLayer(fillId)) map.removeLayer(fillId);
        if (map.getLayer(lineId)) map.removeLayer(lineId);
        if (map.getSource(srcId)) map.removeSource(srcId);

        map.addSource(srcId, { type: 'geojson', data: { type: 'Feature', geometry } });
        // Put fill below outlines but above radar for visibility
        map.addLayer({
            id: fillId,
            type: 'fill',
            source: srcId,
            paint: { 'fill-color': '#ffffff', 'fill-opacity': 0.15 }
        }, 'radar-layer');
        map.addLayer({
            id: lineId,
            type: 'line',
            source: srcId,
            paint: { 'line-color': '#ffffff', 'line-width': 3, 'line-opacity': 0.9 }
        });

        // Auto-remove highlight after a short delay
        setTimeout(() => {
            try { if (map.getLayer(fillId)) map.removeLayer(fillId); } catch {}
            try { if (map.getLayer(lineId)) map.removeLayer(lineId); } catch {}
            try { if (map.getSource(srcId)) map.removeSource(srcId); } catch {}
        }, options.highlightMs ?? 4500);
    } catch {}
}

// Auto-refresh weather data every 60 seconds to keep frames current
setInterval(async () => {
    if (map) {
        const mapSection = document.getElementById('map-section');
        const mapViewActive = !!(
            document.body &&
            document.body.classList.contains('map-view') &&
            mapSection &&
            mapSection.style.display !== 'none'
        );
        if (!mapViewActive) return;
        console.log('Auto-refreshing weather data...');
        await loadWeatherData();
        updateMapInfo();
        try { renderStickyLatestWarning(); } catch {}
        // Refresh storm reports periodically
        try { if (map.getSource('lsr')) await refreshStormReportsSource(); } catch {}
        try { if (powerOutageState.visible) await refreshPowerOutageData({ force: true, allowHidden: false }); } catch {}
        try { if (infrastructureState.visible) await refreshInfrastructureData({ force: true }); } catch {}
        try {
            if (map.getSource(camerasSourceId) && (camerasState.visible || cameraAutoCycleState.active)) {
                await updateCamerasSource({ force: false });
            }
        } catch {}
        try {
            if (cameraAutoCycleState.active) {
                cameraAutoCycleState.lastQueueBuiltAt = 0;
            }
        } catch {}
    }
}, 60 * 1000);

// Expose initializer so the main page can control when to create the map
window.initWeatherMap = initWeatherMap;
// Expose zoom helper for external callers (e.g., from script.js cards)
window.zoomToWarningGeometry = zoomToWarningGeometry;
window.setupMapControls = setupMapControls;
window.initDrawingUI = initDrawingUI;
window.toggleSpcOutlookHeader = toggleSpcOutlookHeader;
window.toggleStormReportsHeader = toggleStormReportsHeader;
window.togglePowerOutagesHeader = togglePowerOutagesHeader;
window.toggleInfrastructureHeader = toggleInfrastructureHeader;
window.toggleCameraAutoCycleHeader = toggleCameraAutoCycleHeader;
window.toggleDrawHeader = toggleDrawHeader;

// Retrieve the latest known geometry for a given warning id
function getWarningGeometryById(id) {
    try {
        if (!id) return null;
        const f = (weatherWarnings || []).find(w => w && w.id === id);
        return f && f.geometry ? f.geometry : null;
    } catch { return null; }
}

window.getWarningGeometryById = getWarningGeometryById;

// ---------------- Simple Drawing Tools (Polygon) ----------------
let drawingActive = false;
let drawCoords = []; // [[lng,lat], ...]
let drawPolys = []; // Array of finished rings: [ [[lng,lat], ...], ... ]
const drawSrcId = 'draw-poly-src';
const drawLineBgId = 'draw-poly-line-bg';
const drawLineId = 'draw-poly-line';
const drawFillId = 'draw-poly-fill';
const drawPtsId = 'draw-poly-pts';
let removeModeActive = false;
let draggingVertexIndex = -1;
let dragging = false;
// Metadata per finished polygon, aligned by index in drawPolys
let drawPolysMeta = [];
// Input state for the in-progress polygon
let drawHazard = 'SEVERE'; // 'SEVERE' | 'TORNADO'
let drawConfidence = 'MEDIUM'; // 'LOW' | 'MEDIUM' | 'HIGH'

function initDrawingUI() {
    try {
        // Keep drawing tools available internally, but do not expose a map button.
        const mapWrap = document.querySelector('.embedded-weather-map') || document.getElementById('weather-map') || document.body;
        const topBtn = getDrawToggleTopButton();
        let btn = document.getElementById('draw-toggle-btn');
        // Remove any previously-created floating draw button.
        if (btn && btn.parentElement) { try { btn.parentElement.removeChild(btn); } catch {} }
        btn = null;

        // Toolbar overlay (hidden until active), anchored inside the map container
        let bar = document.getElementById('draw-toolbar');
        if (!bar) {
            bar = document.createElement('div');
            bar.id = 'draw-toolbar';
            bar.setAttribute('hidden','');
            // Place overlay at the top-right corner of the map
            bar.style.cssText = `position:absolute;top:12px;right:12px;z-index:10010;background:rgba(0,0,0,0.9);color:#fff;border:1px solid rgba(255,255,255,.18);border-radius:10px;padding:.6rem;display:flex;gap:.5rem;align-items:center;flex-wrap:wrap;max-width:360px;box-shadow:0 8px 20px rgba(0,0,0,.35);`;
            bar.innerHTML = `
                <span style="font-weight:800;opacity:.9;margin-right:.25rem">Drawing</span>
                <label style="display:flex;align-items:center;gap:.35rem">
                    <span style="opacity:.9;font-weight:700">Hazard</span>
                    <select id="draw-hazard" style="background:#111827;color:#fff;border:1px solid rgba(255,255,255,.25);border-radius:6px;padding:.25rem .4rem;font-weight:700">
                        <option value="SEVERE">SEVERE</option>
                        <option value="TORNADO">TORNADO</option>
                    </select>
                </label>
                <label style="display:flex;align-items:center;gap:.35rem">
                    <span style="opacity:.9;font-weight:700">Confidence</span>
                    <select id="draw-confidence" style="background:#111827;color:#fff;border:1px solid rgba(255,255,255,.25);border-radius:6px;padding:.25rem .4rem;font-weight:700">
                        <option value="LOW">LOW</option>
                        <option value="MEDIUM" selected>MEDIUM</option>
                        <option value="HIGH">HIGH</option>
                    </select>
                </label>
                <span style="opacity:.9;font-weight:700;white-space:nowrap">Expires: 30 minutes</span>
                <button id="draw-finish" style="background:#16a34a;color:#fff;border:1px solid rgba(255,255,255,.2);padding:.35rem .55rem;border-radius:6px;font-weight:800;cursor:pointer">Finish</button>
                <button id="draw-remove" style="background:#374151;color:#fff;border:1px solid rgba(255,255,255,.2);padding:.35rem .55rem;border-radius:6px;font-weight:800;cursor:pointer">Remove</button>
            `;
            mapWrap.appendChild(bar);
            // Explicitly hide at startup regardless of [hidden]
            try { bar.style.display = 'none'; } catch {}
        }

        // Wire dropdowns if present
        try {
            const hz = document.getElementById('draw-hazard');
            const cf = document.getElementById('draw-confidence');
            if (hz && !hz.__wired) { hz.__wired = true; hz.value = drawHazard; hz.addEventListener('change', ()=> { drawHazard = String(hz.value || 'SEVERE').toUpperCase(); }); }
            if (cf && !cf.__wired) { cf.__wired = true; cf.value = drawConfidence; cf.addEventListener('change', ()=> { drawConfidence = String(cf.value || 'MEDIUM').toUpperCase(); }); }
        } catch {}

        // Wire header button (preferred)
        if (topBtn) {
            bindMapHeaderControlButton(topBtn, toggleDrawHeader);
        }
        const finishBtn = document.getElementById('draw-finish');
        if (finishBtn) finishBtn.onclick = () => finishPolygon();
        const btnRemove = document.getElementById('draw-remove');
        if (btnRemove) {
            btnRemove.onclick = () => {
                removeModeActive = !removeModeActive;
                btnRemove.style.background = removeModeActive ? '#DC2626' : '#374151';
                btnRemove.style.borderColor = removeModeActive ? 'rgba(255,255,255,.35)' : 'rgba(255,255,255,.2)';
            };
        }

        // Map click to add vertices when active (bind only if map exists)
        if (typeof map !== 'undefined' && map) {
            if (!map.__drawClickBound) {
                map.__drawClickBound = true;
                map.on('click', (e) => {
                    if (!drawingActive) return;
                    if (removeModeActive) return; // don't add points while removing
                    const { lng, lat } = e.lngLat || {};
                    if (!isFinite(lng) || !isFinite(lat)) return;
                    drawCoords.push([lng, lat]);
                    updateDrawLayers();
                });
            }
            // Removal on click of existing polygon (fill or outline)
            if (!map.__drawRemoveBound) {
                map.__drawRemoveBound = true;
                const tryRemove = (e) => {
                    if (!removeModeActive) return;
                    if (!e.features || !e.features.length) return;
                    const f = e.features[0];
                    const idx = (f.properties && typeof f.properties.polyIndex === 'number') ? f.properties.polyIndex : -1;
                    if (idx >= 0 && idx < drawPolys.length) {
                        drawPolys.splice(idx, 1);
                        try { drawPolysMeta.splice(idx, 1); } catch {}
                        updateDrawLayers();
                    }
                };
                map.on('click', drawFillId, tryRemove);
                map.on('click', drawLineId, tryRemove);
            }
            // Info popup on click when not in remove mode
            if (!map.__drawInfoBound) {
                map.__drawInfoBound = true;
                const showInfo = (e) => {
                    if (removeModeActive) return; // removal handled above
                    if (!e.features || !e.features.length) return;
                    const f = e.features[0];
                    const idx = (f.properties && typeof f.properties.polyIndex === 'number') ? f.properties.polyIndex : -1;
                    if (idx < 0 || idx >= drawPolys.length) return;
                    const meta = drawPolysMeta[idx] || {};
                    const hz = String(meta.hazard || 'SEVERE').toUpperCase();
                    const cf = String(meta.confidence || 'MEDIUM').toUpperCase();
                    const exp = meta.expiresAt ? new Date(meta.expiresAt) : null;
                    const expStr = exp ? exp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—';
                    const html = `
                        <div class="popup-card popup-unified" style="--accent:#38bdf8;min-width:240px">
                            <div class="popup-header">
                                <span class="popup-title">Custom Polygon</span>
                            </div>
                            <div class="popup-section">
                                <div class="popup-label">Hazard</div>
                                <div class="popup-value">${hz}</div>
                            </div>
                            <div class="popup-section">
                                <div class="popup-label">Confidence</div>
                                <div class="popup-value">${cf}</div>
                            </div>
                            <div class="popup-section">
                                <div class="popup-label">Expires</div>
                                <div class="popup-value">30 minutes (at ${expStr})</div>
                            </div>
                        </div>`;
                    new maplibregl.Popup({ closeButton: true, closeOnClick: true, maxWidth: '320px', className: 'storm-popup popup-theme' })
                        .setLngLat(e.lngLat)
                        .setHTML(html)
                        .addTo(map);
                };
                map.on('click', drawFillId, showInfo);
                map.on('click', drawLineId, showInfo);
                map.on('mouseenter', drawFillId, () => { try { map.getCanvas().style.cursor = removeModeActive ? 'not-allowed' : 'pointer'; } catch {} });
                map.on('mouseleave', drawFillId, () => { try { map.getCanvas().style.cursor = drawingActive ? 'crosshair' : ''; } catch {} });
                map.on('mouseenter', drawLineId, () => { try { map.getCanvas().style.cursor = removeModeActive ? 'not-allowed' : 'pointer'; } catch {} });
                map.on('mouseleave', drawLineId, () => { try { map.getCanvas().style.cursor = drawingActive ? 'crosshair' : ''; } catch {} });
            }
            // Vertex drag handlers (bind once)
            if (!map.__drawVertexDragBound) {
                map.__drawVertexDragBound = true;
                // Start drag when mousedown on a vertex point
                map.on('mousedown', drawPtsId, (e) => {
                    if (!drawingActive) return;
                    if (!e.features || !e.features.length) return;
                    // Identify which vertex was clicked (closest to event point)
                    const click = e.lngLat;
                    let idx = -1, best = 1e9;
                    for (let i = 0; i < drawCoords.length; i++) {
                        const dx = drawCoords[i][0] - click.lng;
                        const dy = drawCoords[i][1] - click.lat;
                        const d = Math.hypot(dx, dy);
                        if (d < best) { best = d; idx = i; }
                    }
                    if (idx >= 0) {
                        dragging = true;
                        draggingVertexIndex = idx;
                        try { map.dragPan.disable(); } catch {}
                        map.getCanvas().style.cursor = 'grabbing';
                    }
                });
                // While dragging, update the vertex position
                map.on('mousemove', (e) => {
                    if (!dragging || draggingVertexIndex < 0 || !drawingActive) return;
                    const { lng, lat } = e.lngLat || {};
                    if (!isFinite(lng) || !isFinite(lat)) return;
                    drawCoords[draggingVertexIndex] = [lng, lat];
                    updateDrawLayers();
                });
                // End drag on mouseup or when pointer leaves the map
                const stopDrag = () => {
                    if (!dragging) return;
                    dragging = false;
                    draggingVertexIndex = -1;
                    try { map.dragPan.enable(); } catch {}
                    map.getCanvas().style.cursor = drawingActive ? 'crosshair' : '';
                };
                map.on('mouseup', stopDrag);
                map.on('mouseout', stopDrag);
            }
            ensureDrawSourcesLayers();
        }

        // Always start hidden; only show when Draw is toggled on
        try { setDrawingActive(false); } catch {}
    } catch (e) { console.warn('initDrawingUI error', e); }
}

function setDrawingActive(on) {
    drawingActive = !!on;
    const bar = document.getElementById('draw-toolbar');
    const btn = document.getElementById('draw-toggle-btn');
    const topBtn = getDrawToggleTopButton();
    if (btn) btn.classList.toggle('active', drawingActive);
    if (btn) btn.style && (btn.style.background = drawingActive ? '#0b5' : '#111');
    if (topBtn) topBtn.classList.toggle('active', drawingActive);
    if (bar) {
        if (drawingActive) {
            try { bar.style.display = 'flex'; } catch {}
            bar.removeAttribute('hidden');
        } else {
            try { bar.style.display = 'none'; } catch {}
            bar.setAttribute('hidden','');
        }
    }
    // When turning off, exit remove mode and normalize UI
    if (!drawingActive) {
        removeModeActive = false;
        const btnRemove = document.getElementById('draw-remove');
        if (btnRemove) {
            btnRemove.style.background = '#374151';
            btnRemove.style.borderColor = 'rgba(255,255,255,.2)';
        }
        // Reset cursor
        try { if (typeof map !== 'undefined' && map) map.getCanvas().style.cursor = ''; } catch {}
    }
    try {
        if (typeof map !== 'undefined' && map) {
            // Reset in-progress path on activation to avoid stale path
            if (drawingActive) drawCoords = [];
            updateDrawLayers();
            // Ensure click binding exists
            if (!map.__drawClickBound) {
                map.__drawClickBound = true;
                map.on('click', (e) => {
                    if (!drawingActive) return;
                    const { lng, lat } = e.lngLat || {};
                    if (!isFinite(lng) || !isFinite(lat)) return;
                    drawCoords.push([lng, lat]);
                    updateDrawLayers();
                });
            }
            // Cursor feedback
            map.getCanvas().style.cursor = drawingActive ? 'crosshair' : '';
        }
    } catch {}
}

function ensureDrawSourcesLayers() {
    if (!map) return;
    if (!map.getSource(drawSrcId)) {
        map.addSource(drawSrcId, { type: 'geojson', data: { type: 'FeatureCollection', features: [] }});
    }
    // Ensure our custom layers exist (fill + outlines + points)
    // Fill layer for finished polygons (white fill)
    if (!map.getLayer(drawFillId)) {
        map.addLayer({
            id: drawFillId,
            type: 'fill',
            source: drawSrcId,
            filter: ['==', ['geometry-type'], 'Polygon'],
            paint: {
                'fill-color': '#ffffff',
                'fill-opacity': 0.35
            },
            layout: { 'visibility': 'visible' }
        });
    }
    // Add dashed outline layers (black background then white foreground)
    if (!map.getLayer(drawLineBgId)) {
        map.addLayer({
            id: drawLineBgId,
            type: 'line',
            source: drawSrcId,
            filter: ['==', ['geometry-type'], 'LineString'],
            paint: {
                'line-color': '#000000',
                'line-width': ['interpolate', ['linear'], ['zoom'], 3, 6, 6, 9, 9, 12],
                'line-opacity': 1.0,
                'line-dasharray': [8, 4],
                'line-cap': 'round',
                'line-join': 'round'
            },
            layout: { 'visibility': 'visible' }
        });
    }
    if (!map.getLayer(drawLineId)) {
        map.addLayer({
            id: drawLineId,
            type: 'line',
            source: drawSrcId,
            filter: ['==', ['geometry-type'], 'LineString'],
            paint: {
                'line-color': '#ffffff',
                'line-width': ['interpolate', ['linear'], ['zoom'], 3, 4, 6, 6, 9, 8],
                'line-opacity': 1.0,
                'line-dasharray': [8, 4],
                'line-cap': 'round',
                'line-join': 'round'
            },
            layout: { 'visibility': 'visible' }
        });
    }
    if (!map.getLayer(drawPtsId)) {
        map.addLayer({
            id: drawPtsId,
            type: 'circle',
            source: drawSrcId,
            paint: {
                'circle-radius': ['interpolate', ['linear'], ['zoom'], 3, 3.5, 6, 5, 9, 6.5],
                'circle-color': '#ffffff',
                'circle-stroke-color': '#000000',
                'circle-stroke-width': 1.5,
                'circle-opacity': 1.0
            }
        });
    }
    // Make sure our layers are on top
    try { map.setLayoutProperty(drawFillId, 'visibility', 'visible'); } catch {}
    try { map.setLayoutProperty(drawLineBgId, 'visibility', 'visible'); } catch {}
    try { map.setLayoutProperty(drawLineId, 'visibility', 'visible'); } catch {}
    try { map.setLayoutProperty(drawPtsId, 'visibility', 'visible'); } catch {}
    // Move in the order: fill -> bg -> fg -> pts, so points sit on top
    try { map.moveLayer(drawFillId); } catch {}
    try { map.moveLayer(drawLineBgId); } catch {}
    try { map.moveLayer(drawLineId); } catch {}
    try { map.moveLayer(drawPtsId); } catch {}
    try { map.triggerRepaint && map.triggerRepaint(); } catch {}
}

function updateDrawLayers() {
    if (!map) return;
    ensureDrawSourcesLayers();
    const src = map.getSource(drawSrcId);
    if (!src) return;
    const features = [];
    // Finished polygons: output both Polygon (for white fill) and LineString (for dashed outline)
    for (let i = 0; i < drawPolys.length; i++) {
        const ring = drawPolys[i];
        const meta = drawPolysMeta[i] || {};
        if (Array.isArray(ring) && ring.length >= 2) {
            const closed = [...ring, ring[0]];
            // Fill polygon (tag with polyIndex)
            features.push({ type: 'Feature', properties: { kind: 'poly', polyIndex: i, hazard: meta.hazard || null, confidence: meta.confidence || null, expiresAt: meta.expiresAt || null }, geometry: { type: 'Polygon', coordinates: [closed] } });
            // Outline (tag with polyIndex)
            features.push({ type: 'Feature', properties: { kind: 'poly-outline', polyIndex: i, hazard: meta.hazard || null, confidence: meta.confidence || null, expiresAt: meta.expiresAt || null }, geometry: { type: 'LineString', coordinates: closed } });
        }
    }
    // While drawing, show vertices and a provisional line between them
    if (drawingActive) {
        if (drawCoords.length >= 2) {
            const openLine = drawCoords.slice();
            features.push({ type: 'Feature', properties: { kind: 'line' }, geometry: { type: 'LineString', coordinates: openLine } });
        }
        for (const c of drawCoords) {
            features.push({ type: 'Feature', properties: { kind: 'pt' }, geometry: { type: 'Point', coordinates: c } });
        }
    }
    src.setData({ type: 'FeatureCollection', features });
}

function finishPolygon() {
    if (drawCoords.length < 3) return;
    // Save the finished ring and clear current path
    drawPolys.push(drawCoords.slice());
    try {
        const now = Date.now();
        const expiresAt = new Date(now + 30 * 60 * 1000).toISOString(); // always 30 minutes
        drawPolysMeta.push({ hazard: drawHazard, confidence: drawConfidence, expiresAt });
    } catch { drawPolysMeta.push({ hazard: drawHazard, confidence: drawConfidence, expiresAt: null }); }
    drawCoords = [];
    dragging = false;
    draggingVertexIndex = -1;
    updateDrawLayers();
    // Hide toolbar after completion
    setDrawingActive(false);
    try { updateDrawLayers(); } catch {}
}

function clearPolygon() {
    // Clear only the in-progress path; keep finished polygons
    drawCoords = [];
    updateDrawLayers();
}

async function copyPolygonGeoJSON() {
    try {
        if (drawCoords.length < 3) return;
        const ring = [...drawCoords, drawCoords[0]];
        const gj = { type: 'Feature', properties: { name: 'Drawn Polygon' }, geometry: { type: 'Polygon', coordinates: [ring] } };
        const txt = JSON.stringify(gj);
        if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(txt);
            console.log('Polygon GeoJSON copied to clipboard');
        } else {
            // Fallback
            const ta = document.createElement('textarea'); ta.value = txt; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
        }
    } catch (e) { console.warn('copyPolygonGeoJSON failed', e); }
}

// ---------------- Missouri Mesonet Weather Stations ----------------
const MESONET_SOURCE_ID = 'mesonet-stations';
const MESONET_LAYER_ID = 'mesonet-stations-layer';
const MESONET_LABEL_LAYER_ID = 'mesonet-stations-labels';

// Fetch Missouri Mesonet station data
async function fetchMissouriMesonetStations() {
    try {
        // Using Missouri Mesonet GeoJSON endpoint
        const response = await fetch('https://mesonet.climate.umt.edu/api/v1/stations/geojson');
        if (!response.ok) throw new Error('Failed to fetch Missouri Mesonet data');
        const data = await response.json();
        return data;
    } catch (error) {
        console.error('Error fetching Missouri Mesonet data:', error);
        return { type: 'FeatureCollection', features: [] };
    }
}

// Ensure Mesonet stations layers exist
async function ensureMesonetLayers() {
    if (!map) return false;
    
    try {
        // Add source if it doesn't exist
        if (!map.getSource(MESONET_SOURCE_ID)) {
            const stationsData = await fetchMissouriMesonetStations();
            map.addSource(MESONET_SOURCE_ID, {
                type: 'geojson',
                data: stationsData
            });
        }

        // Add circle layer for stations
        if (!map.getLayer(MESONET_LAYER_ID)) {
            map.addLayer({
                id: MESONET_LAYER_ID,
                type: 'circle',
                source: MESONET_SOURCE_ID,
                layout: { 'visibility': 'none' },
                paint: {
                    'circle-radius': [
                        'interpolate', ['linear'], ['zoom'],
                        6, 3,
                        10, 5,
                        12, 6
                    ],
                    'circle-color': '#4f46e5',
                    'circle-stroke-width': 1,
                    'circle-stroke-color': '#ffffff',
                    'circle-opacity': 0.9
                }
            });
        }

        // Add labels for stations
        if (!map.getLayer(MESONET_LABEL_LAYER_ID)) {
            map.addLayer({
                id: MESONET_LABEL_LAYER_ID,
                type: 'symbol',
                source: MESONET_SOURCE_ID,
                layout: {
                    'visibility': 'none',
                    'text-field': ['get', 'name'],
                    'text-font': ['Open Sans Semibold', 'Arial Unicode MS Bold'],
                    'text-size': 10,
                    'text-offset': [0, 1.5],
                    'text-anchor': 'top',
                    'text-allow-overlap': false,
                    'text-ignore-placement': false
                },
                paint: {
                    'text-color': '#ffffff',
                    'text-halo-color': 'rgba(0, 0, 0, 0.7)',
                    'text-halo-width': 1.5,
                    'text-halo-blur': 1
                }
            });
        }
        
        return true;
    } catch (error) {
        console.error('Error setting up Mesonet layers:', error);
        return false;
    }
}

// Toggle Mesonet stations layer
function toggleMesonetLayer() {
    if (!map) return false;
    
    try {
        const isVisible = map.getLayoutProperty(MESONET_LAYER_ID, 'visibility') === 'visible';
        const newVisibility = isVisible ? 'none' : 'visible';
        
        map.setLayoutProperty(MESONET_LAYER_ID, 'visibility', newVisibility);
        map.setLayoutProperty(MESONET_LABEL_LAYER_ID, 'visibility', newVisibility);
        
        // Update button state
        setButtonActive('mesonet', !isVisible);
        
        // If turning on, ensure layers are created
        if (newVisibility === 'visible') {
            ensureMesonetLayers();
        }
        
        return !isVisible;
    } catch (error) {
        console.error('Error toggling Mesonet layer:', error);
        return false;
    }
}

// ---------------- Storm Reports Overlay ----------------
let mpingMissingTokenNoticeShown = false;
let stormReportPulseFrame = null;
const STORM_REPORT_PULSE_DURATION_MS = 680;
const STORM_REPORT_PULSE_SOURCE_ID = 'lsr-click-pulse-src';
const STORM_REPORT_PULSE_RING_LAYER_ID = 'lsr-click-pulse-ring';
const STORM_REPORT_PULSE_CORE_LAYER_ID = 'lsr-click-pulse-core';
const STORM_REPORT_ICON_LAYER_ID = 'lsr-icons';

function emptyFeatureCollection() {
    return { type: 'FeatureCollection', features: [] };
}

function formatUtcMinuteStamp(dateObj) {
    const d = dateObj instanceof Date ? dateObj : new Date(dateObj);
    if (Number.isNaN(d.getTime())) return '';
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}Z`;
}

function formatMpingTimeParam(dateObj) {
    const d = dateObj instanceof Date ? dateObj : new Date(dateObj);
    if (Number.isNaN(d.getTime())) return '';
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

function toIsoOrNull(value) {
    if (value == null || value === '') return null;
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return null;
    return d.toISOString();
}

function inferStormTypeCode(text, fallbackCode = '') {
    const code = String(fallbackCode || '').toUpperCase().trim();
    if (['T', 'H', 'W', 'S', 'G', 'D', 'F', 'R'].includes(code)) return code;
    const lower = String(text || '').toLowerCase();
    if (!lower) return 'R';
    if (lower.includes('tornado') || lower.includes('funnel')) return 'T';
    if (lower.includes('hail')) return 'H';
    if (lower.includes('damage') || lower.includes('dmg')) return 'D';
    if (lower.includes('wind') || lower.includes('wnd') || lower.includes('tstm') || lower.includes('gust')) return 'W';
    if (lower.includes('snow') || lower.includes('blizzard') || lower.includes('sleet') || lower.includes('winter')) return 'S';
    if (lower.includes('flood') || lower.includes('flash flood') || lower.includes('high water')) return 'F';
    if (lower.includes('rain') || lower.includes('freez') || lower.includes('ice') || lower.includes('drizzle')) return 'R';
    return 'R';
}

function normalizeStormReportFeature(feature, sourceName = 'Storm Report') {
    try {
        if (!feature || !feature.geometry || feature.geometry.type !== 'Point') return null;
        const coords = Array.isArray(feature.geometry.coordinates) ? feature.geometry.coordinates : [];
        const lon = Number(coords[0]);
        const lat = Number(coords[1]);
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;

        const p = feature.properties || {};
        const typetext = String(p.typetext || p.typeText || p.event || p.description || p.category || p.reportType || '').trim();
        const city = String(p.city || p.location || p.name || p.place || '').trim();
        const state = String(p.state || p.st || '').trim();
        const county = String(p.county || '').trim();
        const description = String(p.description || p.desc || '').trim();
        const remarks = String(p.remark || p.remarks || p.comment || p.comments || p.remarktext || description || '').trim();
        const category = String(p.category || '').trim();
        const source = String(p.source || sourceName || 'Storm Report').trim();
        const validRaw = p.valid || p.time || p.obtime || p.timestamp || p.datetime || '';
        const validIso = toIsoOrNull(validRaw) || toIsoOrNull(p.observed) || toIsoOrNull(p.updated) || null;
        const mergedText = `${typetext} ${category} ${remarks}`.trim();
        const inferredType = inferStormTypeCode(mergedText, p.type);

        let magnitude = p.magnitude;
        if (magnitude == null || magnitude === '') magnitude = p.mag;
        if (magnitude == null || magnitude === '') magnitude = p.size;
        if (magnitude == null || magnitude === '') magnitude = p.speed;
        if (magnitude == null || magnitude === '') magnitude = p.value;
        const magnitudeNumber = Number.parseFloat(String(magnitude || '').replace(/[^\d.+-]/g, ''));
        if (Number.isFinite(magnitudeNumber)) magnitude = magnitudeNumber;

        const featureId = feature.id || p.id || `${source.replace(/\s+/g, '-')}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        return {
            type: 'Feature',
            id: featureId,
            geometry: {
                type: 'Point',
                coordinates: [lon, lat]
            },
            properties: {
                ...p,
                type: inferredType,
                typetext: typetext || category || 'Storm Report',
                city,
                state,
                county,
                source,
                category,
                description: description || remarks || typetext,
                remark: remarks || description || typetext || '',
                magnitude,
                valid: validIso || validRaw || p.valid || '',
                feed: sourceName
            }
        };
    } catch {
        return null;
    }
}

function dedupeStormReportFeatures(features) {
    const byKey = new Map();
    (features || []).forEach((f) => {
        try {
            if (!f || !f.geometry || f.geometry.type !== 'Point') return;
            const coords = f.geometry.coordinates || [];
            const lon = Number(coords[0]);
            const lat = Number(coords[1]);
            if (!Number.isFinite(lon) || !Number.isFinite(lat)) return;
            const p = f.properties || {};
            const t = String(p.type || inferStormTypeCode(p.typetext || '', '')).toUpperCase();
            const ts = Date.parse(p.valid || p.time || p.obtime || '');
            const bucket = Number.isFinite(ts) ? Math.floor(ts / (15 * 60 * 1000)) : 'na';
            const key = `${t}|${Math.round(lat * 20) / 20}|${Math.round(lon * 20) / 20}|${bucket}`;
            const existing = byKey.get(key);
            if (!existing) {
                byKey.set(key, f);
                return;
            }
            const existingScore = String(existing.properties?.remark || existing.properties?.description || '').length;
            const incomingScore = String(p.remark || p.description || '').length;
            if (incomingScore > existingScore) {
                byKey.set(key, f);
            }
        } catch {}
    });
    return Array.from(byKey.values());
}

async function fetchNwsLsrReportsGeoJSON() {
    try {
        const now = new Date();
        const stsLocal = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
        const ets = now;
        const toUtcDisplay = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000);
        const dSTS = toUtcDisplay(stsLocal);
        const dETS = toUtcDisplay(ets);
        const url = `https://mesonet.agron.iastate.edu/geojson/lsr.php?sts=${formatUtcMinuteStamp(dSTS)}&ets=${formatUtcMinuteStamp(dETS)}`;
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`LSR fetch failed ${resp.status}`);
        const gj = await resp.json();
        if (!gj || gj.type !== 'FeatureCollection' || !Array.isArray(gj.features)) return emptyFeatureCollection();
        const normalized = gj.features.map((f) => normalizeStormReportFeature(f, 'NWS LSR')).filter(Boolean);
        return { type: 'FeatureCollection', features: normalized };
    } catch (e) {
        console.warn('fetchNwsLsrReportsGeoJSON error', e);
        return emptyFeatureCollection();
    }
}

function parseSpcReportTimeToIso(baseDateUtc, hhmmText) {
    const text = String(hhmmText || '').trim();
    if (!/^\d{4}$/.test(text)) return null;
    let hh = Number.parseInt(text.slice(0, 2), 10);
    const mm = Number.parseInt(text.slice(2), 10);
    if (!Number.isFinite(hh) || !Number.isFinite(mm) || hh < 0 || hh > 24 || mm < 0 || mm > 59) return null;

    const d = new Date(Date.UTC(
        baseDateUtc.getUTCFullYear(),
        baseDateUtc.getUTCMonth(),
        baseDateUtc.getUTCDate(),
        hh === 24 ? 0 : hh,
        mm,
        0
    ));
    if (hh === 24) d.setUTCDate(d.getUTCDate() + 1);
    if (d.getTime() > Date.now() + (3 * 60 * 60 * 1000)) d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString();
}

function parseSpcCsvReports(csvText, kind, baseDateUtc) {
    const rows = String(csvText || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
    const features = [];
    rows.forEach((line, idx) => {
        if (!line || line.toLowerCase().startsWith('time,')) return;
        const parts = line.split(',');
        if (parts.length < 7) return;
        const time = parts[0].trim();
        const magRaw = parts[1].trim();
        const location = parts[2].trim();
        const county = parts[3].trim();
        const state = parts[4].trim();
        const lat = Number.parseFloat(parts[5]);
        const lon = Number.parseFloat(parts[6]);
        const comments = parts.slice(7).join(',').trim();
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;

        let type = 'R';
        let typetext = 'Storm Report';
        let magnitude = magRaw;
        if (kind === 'tornado') {
            type = 'T';
            typetext = 'Tornado';
        } else if (kind === 'wind') {
            type = 'W';
            typetext = 'Thunderstorm Wind';
            const mph = Number.parseFloat(magRaw);
            if (Number.isFinite(mph)) magnitude = mph;
        } else if (kind === 'hail') {
            type = 'H';
            typetext = 'Hail';
            const hailHundredths = Number.parseFloat(magRaw);
            if (Number.isFinite(hailHundredths)) {
                magnitude = hailHundredths > 10 ? (hailHundredths / 100) : hailHundredths;
            }
        }

        const valid = parseSpcReportTimeToIso(baseDateUtc, time);
        features.push({
            type: 'Feature',
            id: `spc-${kind}-${idx}-${time}-${lat.toFixed(3)}-${lon.toFixed(3)}`,
            geometry: { type: 'Point', coordinates: [lon, lat] },
            properties: {
                type,
                typetext,
                city: location,
                county,
                state,
                magnitude,
                source: 'SPC Storm Reports',
                valid: valid || '',
                time: valid || '',
                remark: comments || '',
                description: comments || typetext,
                category: kind.toUpperCase(),
                feed: 'SPC'
            }
        });
    });
    return features;
}

async function fetchSpcStormReportsGeoJSON() {
    try {
        const now = new Date();
        const feeds = [
            { kind: 'tornado', url: 'https://www.spc.noaa.gov/climo/reports/today_torn.csv' },
            { kind: 'wind', url: 'https://www.spc.noaa.gov/climo/reports/today_wind.csv' },
            { kind: 'hail', url: 'https://www.spc.noaa.gov/climo/reports/today_hail.csv' }
        ];
        const settled = await Promise.allSettled(feeds.map(async (feed) => {
            const resp = await fetch(feed.url);
            if (!resp.ok) throw new Error(`SPC ${feed.kind} fetch failed ${resp.status}`);
            const text = await resp.text();
            return parseSpcCsvReports(text, feed.kind, now);
        }));
        const merged = [];
        settled.forEach((s) => {
            if (s.status === 'fulfilled' && Array.isArray(s.value)) merged.push(...s.value);
        });
        const normalized = merged.map((f) => normalizeStormReportFeature(f, 'SPC')).filter(Boolean);
        return { type: 'FeatureCollection', features: normalized };
    } catch (e) {
        console.warn('fetchSpcStormReportsGeoJSON error', e);
        return emptyFeatureCollection();
    }
}

function normalizeMpingResultToFeature(item, idx) {
    try {
        if (!item) return null;
        const geometry = item.geometry || item.geom || item.location || null;
        let lon = null;
        let lat = null;
        if (geometry && geometry.type === 'Point' && Array.isArray(geometry.coordinates)) {
            lon = Number(geometry.coordinates[0]);
            lat = Number(geometry.coordinates[1]);
        } else if (Number.isFinite(Number(item.lon)) && Number.isFinite(Number(item.lat))) {
            lon = Number(item.lon);
            lat = Number(item.lat);
        }
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;

        const props = item.properties && typeof item.properties === 'object' ? item.properties : item;
        const category = String(props.category || '').trim();
        const description = String(props.description || '').trim();
        const obtime = props.obtime || props.time || props.valid || '';
        const combinedText = `${category} ${description}`.trim();
        return {
            type: 'Feature',
            id: item.id || props.id || `mping-${idx}-${Date.now()}`,
            geometry: { type: 'Point', coordinates: [lon, lat] },
            properties: {
                ...props,
                type: inferStormTypeCode(combinedText, props.type),
                typetext: combinedText || 'mPING',
                source: 'mPING',
                category: category || props.category || '',
                description: description || combinedText || 'mPING report',
                remark: description || combinedText || '',
                valid: toIsoOrNull(obtime) || obtime || '',
                feed: 'mPING'
            }
        };
    } catch {
        return null;
    }
}

function isRelevantMpingReport(feature) {
    try {
        const p = feature?.properties || {};
        const t = String(p.typetext || '').toLowerCase();
        if (!t) return false;
        return (
            t.includes('tornado') ||
            t.includes('hail') ||
            t.includes('wind') ||
            t.includes('gust') ||
            t.includes('damage') ||
            t.includes('snow') ||
            t.includes('sleet') ||
            t.includes('blizzard') ||
            t.includes('freez') ||
            t.includes('ice') ||
            t.includes('rain') ||
            t.includes('flood') ||
            t.includes('drizzle')
        );
    } catch {
        return false;
    }
}

async function fetchMpingStormReportsGeoJSON() {
    try {
        let token = '';
        try { token = String(localStorage.getItem('mpingApiToken') || '').trim(); } catch {}
        try {
            if (!token && typeof window !== 'undefined' && window.MPING_API_TOKEN) {
                token = String(window.MPING_API_TOKEN).trim();
            }
        } catch {}

        if (!token) {
            if (!mpingMissingTokenNoticeShown) {
                mpingMissingTokenNoticeShown = true;
                console.info('mPING token not set. Set localStorage.mpingApiToken or window.MPING_API_TOKEN to enable mPING storm reports.');
            }
            return emptyFeatureCollection();
        }

        const end = new Date();
        const start = new Date(end.getTime() - (6 * 60 * 60 * 1000));
        const params = new URLSearchParams({
            obtime_gte: formatMpingTimeParam(start),
            obtime_lte: formatMpingTimeParam(end)
        });
        const url = `https://mping.ou.edu/mping/api/v2/reports?${params.toString()}`;
        const resp = await fetch(url, {
            headers: {
                'Accept': 'application/geo+json, application/json',
                'Authorization': `Token ${token}`
            }
        });
        if (!resp.ok) throw new Error(`mPING fetch failed ${resp.status}`);
        const payload = await resp.json();

        let incoming = [];
        if (payload && payload.type === 'FeatureCollection' && Array.isArray(payload.features)) {
            incoming = payload.features;
        } else if (Array.isArray(payload?.results)) {
            incoming = payload.results.map((item, idx) => normalizeMpingResultToFeature(item, idx)).filter(Boolean);
        } else if (Array.isArray(payload)) {
            incoming = payload.map((item, idx) => normalizeMpingResultToFeature(item, idx)).filter(Boolean);
        }
        const normalized = incoming
            .map((f, idx) => (f && f.type === 'Feature' ? f : normalizeMpingResultToFeature(f, idx)))
            .filter(Boolean)
            .map((f) => normalizeStormReportFeature(f, 'mPING'))
            .filter(Boolean)
            .filter((f) => isRelevantMpingReport(f));
        normalized.sort((a, b) => {
            const ta = Date.parse(a?.properties?.valid || '') || 0;
            const tb = Date.parse(b?.properties?.valid || '') || 0;
            return tb - ta;
        });
        if (normalized.length > 1500) normalized.length = 1500;
        return { type: 'FeatureCollection', features: normalized };
    } catch (e) {
        console.warn('fetchMpingStormReportsGeoJSON error', e);
        return emptyFeatureCollection();
    }
}

if (typeof window !== 'undefined') {
    window.setMpingApiToken = (token) => {
        try {
            const t = String(token || '').trim();
            if (!t) return false;
            localStorage.setItem('mpingApiToken', t);
            mpingMissingTokenNoticeShown = false;
            return true;
        } catch {
            return false;
        }
    };
    window.clearMpingApiToken = () => {
        try {
            localStorage.removeItem('mpingApiToken');
            return true;
        } catch {
            return false;
        }
    };
}

async function fetchStormReportsGeoJSON() {
    try {
        // Use only the Local Storm Reports (LSR) feed.
        const lsr = await fetchNwsLsrReportsGeoJSON();
        const deduped = dedupeStormReportFeatures(lsr?.features || []);
        return { type: 'FeatureCollection', features: deduped };
    } catch (e) {
        console.warn('fetchStormReportsGeoJSON error', e);
        return emptyFeatureCollection();
    }
}

function ensureStormReportPulseLayers() {
    if (!map) return;
    if (!map.getSource(STORM_REPORT_PULSE_SOURCE_ID)) {
        map.addSource(STORM_REPORT_PULSE_SOURCE_ID, {
            type: 'geojson',
            data: emptyFeatureCollection()
        });
    }
    if (!map.getLayer(STORM_REPORT_PULSE_RING_LAYER_ID)) {
        map.addLayer({
            id: STORM_REPORT_PULSE_RING_LAYER_ID,
            type: 'circle',
            source: STORM_REPORT_PULSE_SOURCE_ID,
            paint: {
                'circle-radius': 0,
                'circle-color': 'rgba(0,0,0,0)',
                'circle-stroke-color': ['coalesce', ['get', 'color'], '#93c5fd'],
                'circle-stroke-width': 2.6,
                'circle-stroke-opacity': 0
            }
        });
    }
    if (!map.getLayer(STORM_REPORT_PULSE_CORE_LAYER_ID)) {
        map.addLayer({
            id: STORM_REPORT_PULSE_CORE_LAYER_ID,
            type: 'circle',
            source: STORM_REPORT_PULSE_SOURCE_ID,
            paint: {
                'circle-radius': 8,
                'circle-color': ['coalesce', ['get', 'color'], '#93c5fd'],
                'circle-opacity': 0,
                'circle-blur': 0.25
            }
        });
    }
}

function triggerStormReportPulse(lngLat, color = '#93c5fd') {
    if (!map || !lngLat || !Number.isFinite(lngLat.lng) || !Number.isFinite(lngLat.lat)) return;
    ensureStormReportPulseLayers();
    const src = map.getSource(STORM_REPORT_PULSE_SOURCE_ID);
    if (!src || typeof src.setData !== 'function') return;
    src.setData({
        type: 'FeatureCollection',
        features: [{
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [lngLat.lng, lngLat.lat] },
            properties: { color }
        }]
    });

    if (stormReportPulseFrame) {
        try { cancelAnimationFrame(stormReportPulseFrame); } catch {}
        stormReportPulseFrame = null;
    }

    const start = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    const animate = (ts) => {
        const now = Number(ts || ((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()));
        const p = Math.max(0, Math.min(1, (now - start) / STORM_REPORT_PULSE_DURATION_MS));
        const eased = 1 - Math.pow(1 - p, 3);
        const ringRadius = 12 + (eased * 58);
        const ringOpacity = 0.85 * (1 - eased);
        const coreRadius = 10 + (eased * 15);
        const coreOpacity = 0.24 * (1 - eased);
        try {
            if (map.getLayer(STORM_REPORT_PULSE_RING_LAYER_ID)) {
                map.setPaintProperty(STORM_REPORT_PULSE_RING_LAYER_ID, 'circle-radius', ringRadius);
                map.setPaintProperty(STORM_REPORT_PULSE_RING_LAYER_ID, 'circle-stroke-opacity', ringOpacity);
                map.setPaintProperty(STORM_REPORT_PULSE_RING_LAYER_ID, 'circle-stroke-width', 2.8 - (eased * 1.8));
            }
            if (map.getLayer(STORM_REPORT_PULSE_CORE_LAYER_ID)) {
                map.setPaintProperty(STORM_REPORT_PULSE_CORE_LAYER_ID, 'circle-radius', coreRadius);
                map.setPaintProperty(STORM_REPORT_PULSE_CORE_LAYER_ID, 'circle-opacity', coreOpacity);
            }
        } catch {}
        if (p < 1) {
            stormReportPulseFrame = requestAnimationFrame(animate);
            return;
        }
        stormReportPulseFrame = null;
        try {
            if (map.getLayer(STORM_REPORT_PULSE_RING_LAYER_ID)) {
                map.setPaintProperty(STORM_REPORT_PULSE_RING_LAYER_ID, 'circle-stroke-opacity', 0);
            }
            if (map.getLayer(STORM_REPORT_PULSE_CORE_LAYER_ID)) {
                map.setPaintProperty(STORM_REPORT_PULSE_CORE_LAYER_ID, 'circle-opacity', 0);
            }
            const clearSrc = map.getSource(STORM_REPORT_PULSE_SOURCE_ID);
            if (clearSrc && typeof clearSrc.setData === 'function') clearSrc.setData(emptyFeatureCollection());
        } catch {}
    };
    stormReportPulseFrame = requestAnimationFrame(animate);
}

function stormReportIconDefs() {
    return [
        { id: 'sr-icon-wind', kind: 'wind', label: 'WIND', top: '#5ec8ff', bottom: '#0f8bff', glow: 'rgba(56,189,248,0.56)' },
        { id: 'sr-icon-tornado', kind: 'tornado', label: 'TORNADO', top: '#ff6a78', bottom: '#e11d48', glow: 'rgba(244,63,94,0.58)' },
        { id: 'sr-icon-damage', kind: 'damage', label: 'DAMAGE', top: '#ffbd5a', bottom: '#fb923c', glow: 'rgba(251,146,60,0.56)' },
        { id: 'sr-icon-hail', kind: 'hail', label: 'HAIL', top: '#7ef27c', bottom: '#22c55e', glow: 'rgba(34,197,94,0.56)' },
        { id: 'sr-icon-snow', kind: 'snow', label: 'SNOW', top: '#dbeafe', bottom: '#93c5fd', glow: 'rgba(191,219,254,0.62)' },
        { id: 'sr-icon-flood', kind: 'flood', label: 'FLOOD', top: '#2fa768', bottom: '#0f5f36', glow: 'rgba(34,197,94,0.64)' },
        { id: 'sr-icon-rain', kind: 'rain', label: 'RAIN', top: '#7dd3fc', bottom: '#06b6d4', glow: 'rgba(34,211,238,0.52)' }
    ];
}

function drawStormBadgeSymbol(ctx, kind, cx, cy, radius) {
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.96)';
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.lineWidth = 6;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (kind === 'wind') {
        [-16, -4, 8].forEach((dy, i) => {
            ctx.beginPath();
            ctx.moveTo(cx - radius + 14, cy + dy);
            ctx.bezierCurveTo(cx - 8, cy + dy - 8 - i, cx + 10, cy + dy + 8 + i, cx + radius - 14, cy + dy - 1);
            ctx.stroke();
        });
    } else if (kind === 'tornado') {
        [30, 24, 18, 12].forEach((w, i) => {
            const y = cy - 20 + (i * 10);
            ctx.beginPath();
            ctx.moveTo(cx - w, y);
            ctx.bezierCurveTo(cx - 7, y - 7, cx + 7, y - 7, cx + w, y);
            ctx.stroke();
        });
        ctx.beginPath();
        ctx.moveTo(cx + 6, cy + 18);
        ctx.quadraticCurveTo(cx + 1, cy + 26, cx - 3, cy + 33);
        ctx.stroke();
    } else if (kind === 'damage') {
        ctx.beginPath();
        ctx.moveTo(cx - 24, cy + 10);
        ctx.lineTo(cx - 24, cy - 9);
        ctx.lineTo(cx, cy - 28);
        ctx.lineTo(cx + 24, cy - 9);
        ctx.lineTo(cx + 24, cy + 10);
        ctx.closePath();
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(cx - 3, cy - 10);
        ctx.lineTo(cx + 4, cy - 1);
        ctx.lineTo(cx - 2, cy + 6);
        ctx.stroke();
    } else if (kind === 'hail') {
        [[-14, 4, 9], [0, -4, 11], [14, 6, 8], [3, 14, 7]].forEach(([dx, dy, r]) => {
            ctx.beginPath();
            ctx.arc(cx + dx, cy + dy, r, 0, Math.PI * 2);
            ctx.fill();
        });
    } else if (kind === 'snow') {
        const drawLine = (ax, ay, bx, by) => { ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke(); };
        drawLine(cx - 21, cy, cx + 21, cy);
        drawLine(cx, cy - 21, cx, cy + 21);
        drawLine(cx - 15, cy - 15, cx + 15, cy + 15);
        drawLine(cx - 15, cy + 15, cx + 15, cy - 15);
    } else if (kind === 'flood') {
        ctx.beginPath();
        ctx.moveTo(cx - 22, cy - 3);
        ctx.lineTo(cx - 22, cy - 17);
        ctx.lineTo(cx, cy - 33);
        ctx.lineTo(cx + 22, cy - 17);
        ctx.lineTo(cx + 22, cy - 3);
        ctx.stroke();
        [-2, 10, 22].forEach((y) => {
            ctx.beginPath();
            ctx.moveTo(cx - 28, cy + y);
            ctx.bezierCurveTo(cx - 18, cy + y - 5, cx - 6, cy + y + 5, cx + 4, cy + y);
            ctx.bezierCurveTo(cx + 14, cy + y - 5, cx + 22, cy + y + 4, cx + 30, cy + y);
            ctx.stroke();
        });
    } else {
        [-6, 8, 22].forEach((y) => {
            ctx.beginPath();
            ctx.moveTo(cx - 26, cy + y);
            ctx.bezierCurveTo(cx - 12, cy + y - 4, cx - 2, cy + y + 4, cx + 10, cy + y);
            ctx.bezierCurveTo(cx + 20, cy + y - 4, cx + 27, cy + y + 4, cx + 30, cy + y);
            ctx.stroke();
        });
    }
    ctx.restore();
}

function buildStormReportBadge(def) {
    const size = 128;
    const c = document.createElement('canvas');
    c.width = size;
    c.height = size;
    const ctx = c.getContext('2d');
    if (!ctx) return null;

    const center = size / 2;
    const radius = 54;

    const glow = ctx.createRadialGradient(center, center, 8, center, center, radius + 24);
    glow.addColorStop(0, def.glow);
    glow.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, size, size);

    ctx.beginPath();
    ctx.arc(center, center, radius, 0, Math.PI * 2);
    const fill = ctx.createLinearGradient(center, center - radius, center, center + radius);
    fill.addColorStop(0, def.top);
    fill.addColorStop(0.5, def.top);
    fill.addColorStop(1, def.bottom);
    ctx.fillStyle = fill;
    ctx.fill();

    // No white outer ring stroke per request.

    const topGlass = ctx.createLinearGradient(center, center - radius, center, center + 8);
    topGlass.addColorStop(0, 'rgba(255,255,255,0.42)');
    topGlass.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.beginPath();
    ctx.arc(center, center - 8, radius - 14, Math.PI * 1.08, Math.PI * 1.92);
    ctx.lineWidth = 9;
    ctx.strokeStyle = topGlass;
    ctx.stroke();

    const dividerY = center + 18;
    ctx.beginPath();
    ctx.moveTo(center - radius + 8, dividerY);
    ctx.lineTo(center + radius - 8, dividerY);
    ctx.lineWidth = 2.6;
    ctx.strokeStyle = 'rgba(255,255,255,0.82)';
    ctx.stroke();

    drawStormBadgeSymbol(ctx, def.kind, center, center - 8, 30);

    ctx.fillStyle = 'rgba(255,255,255,0.96)';
    ctx.font = '700 17px "Rajdhani", "Arial", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(def.label, center, center + 38);

    return ctx.getImageData(0, 0, size, size);
}

function ensureStormReportMarkerImages() {
    if (!map) return;
    stormReportIconDefs().forEach((def) => {
        try {
            if (map.hasImage && map.hasImage(def.id)) return;
            const image = buildStormReportBadge(def);
            if (!image) return;
            map.addImage(def.id, image, { pixelRatio: 2 });
        } catch (e) {
            console.warn('storm report icon add failed', def.id, e);
        }
    });
}

function stormReportIconImageExpression() {
    return [
        'match',
        ['coalesce', ['get', 'type'], 'R'],
        'T', 'sr-icon-tornado',
        'H', 'sr-icon-hail',
        'W', 'sr-icon-wind',
        'G', 'sr-icon-wind',
        'S', 'sr-icon-snow',
        'D', 'sr-icon-damage',
        'F', 'sr-icon-flood',
        'R', 'sr-icon-rain',
        'sr-icon-wind'
    ];
}

function escapeStormReportHtml(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function hexToRgbaSafe(hex, alpha = 1) {
    const h = String(hex || '').trim().replace('#', '');
    if (!/^[0-9a-fA-F]{6}$/.test(h)) return `rgba(56,189,248,${alpha})`;
    const r = Number.parseInt(h.slice(0, 2), 16);
    const g = Number.parseInt(h.slice(2, 4), 16);
    const b = Number.parseInt(h.slice(4, 6), 16);
    return `rgba(${r},${g},${b},${alpha})`;
}

function deriveStormReportMetric(badge, magnitude, remarks = '', typeText = '') {
    const numericFromMag = Number.parseFloat(String(magnitude || '').replace(/[^\d.+-]/g, ''));
    let value = Number.isFinite(numericFromMag) ? numericFromMag : null;
    if (value == null) {
        const m = String(remarks || typeText || '').match(/(\d+(?:\.\d+)?)/);
        if (m) value = Number.parseFloat(m[1]);
    }
    const unitByBadge = { S: 'IN', H: 'IN', W: 'MPH', R: 'IN', F: 'FT' };
    const unit = unitByBadge[badge] || '';
    if (value == null) return { valueText: '--', unitText: unit };
    const valueText = Number.isInteger(value) ? String(value) : value.toFixed(1);
    return { valueText, unitText: unit };
}

function renderStormReportTopLeftPanel({
    header = 'STORM REPORT',
    locationLine = '',
    accent = '#38bdf8',
    valueText = '--',
    unitText = '',
    localTime = '',
    minutesAgo = '',
    remarks = ''
} = {}) {
    const panel = document.getElementById('snow-report-panel');
    if (!panel) return;
    panel.innerHTML = `
        <div class="storm-top-card" style="--report-accent:${accent};--report-accent-soft:${hexToRgbaSafe(accent, 0.42)};">
            <button class="storm-top-close storm-close" type="button" aria-label="Close report panel">&times;</button>
            <div class="storm-top-title">${escapeStormReportHtml(header || 'STORM REPORT')}</div>
            <div class="storm-top-location">${escapeStormReportHtml((locationLine || '--').toUpperCase())}</div>
            <div class="storm-top-line"><span></span></div>
            <div class="storm-top-metric">
                <span class="storm-top-value">${escapeStormReportHtml(valueText || '--')}</span>
                <span class="storm-top-unit">${escapeStormReportHtml(unitText || '')}</span>
            </div>
            <div class="storm-top-divider"></div>
            <div class="storm-top-reported">
                <div class="storm-top-reported-label">
                    <div class="storm-top-kicker">REPORTED</div>
                    <div class="storm-top-ago">${escapeStormReportHtml(minutesAgo || '--')}</div>
                </div>
                <div class="storm-top-time">${escapeStormReportHtml(localTime || '--')}</div>
            </div>
            <div class="storm-top-remarks">
                <div class="storm-top-kicker">REMARKS</div>
                <div class="storm-top-remarks-text">${escapeStormReportHtml(remarks || '--')}</div>
            </div>
        </div>
    `;
    panel.classList.add('visible');
    panel.querySelector('.storm-close')?.addEventListener('click', () => {
        panel.classList.remove('visible');
        panel.innerHTML = '';
    });
}

function showStormReportDetailsFromFeature(feature, coordinates) {
    if (!feature) return;
    const p = feature.properties || {};
    const city = (p.city || p.name || p.location || '').toString();
    const state = (p.state || '').toString();
    const type = (p.typetext || p.type || '').toString();
    const time = (p.valid || p.time || p.updated || '').toString();
    const mag = (p.magnitude != null ? p.magnitude : '').toString();
    const src = (p.source || '').toString();
    const remarks = (p.remark || p.remarks || p.remarktext || '').toString();
    const header = (type || '').toString().toUpperCase();
    const locationLine = [city, state].filter(Boolean).join(', ');
    const badge = getStormReportBadgeCode(p);
    const badgeColor = getStormReportBadgeColor(p);

    let localTime = '';
    let minutesAgo = '';
    try {
        if (time) {
            const d = new Date(time);
            const opts = { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true };
            localTime = d.toLocaleString('en-US', opts);
            const mins = Math.floor((Date.now() - d.getTime()) / 60000);
            if (mins < 1) minutesAgo = 'Just now';
            else if (mins === 1) minutesAgo = '1 minute ago';
            else minutesAgo = mins + ' minutes ago';
        }
    } catch {}

    let pulsePos = coordinates;
    try {
        if ((!pulsePos || !Number.isFinite(pulsePos.lng) || !Number.isFinite(pulsePos.lat))
            && feature.geometry && feature.geometry.type === 'Point' && Array.isArray(feature.geometry.coordinates)) {
            pulsePos = { lng: Number(feature.geometry.coordinates[0]), lat: Number(feature.geometry.coordinates[1]) };
        }
    } catch {}
    try { if (pulsePos && Number.isFinite(pulsePos.lng) && Number.isFinite(pulsePos.lat)) triggerStormReportPulse(pulsePos, badgeColor); } catch {}

    const metric = deriveStormReportMetric(badge, mag, remarks, type);
    renderStormReportTopLeftPanel({
        header: header || 'STORM REPORT',
        locationLine,
        accent: badgeColor,
        valueText: metric.valueText,
        unitText: metric.unitText,
        localTime: localTime || '--',
        minutesAgo: minutesAgo || '--',
        remarks: remarks || src || 'No additional remarks'
    });
}

async function ensureStormReportsLayers() {
    if (!map) return;
    try {
        if (!document.getElementById('storm-popup-style')) {
            const st = document.createElement('style');
            st.id = 'storm-popup-style';
            st.textContent = `
                .storm-popup .maplibregl-popup-content{background:transparent!important;box-shadow:none!important;padding:0!important;border:none!important}
                .storm-popup .maplibregl-popup-tip{display:none!important}
                .snow-report-box{position:relative;min-width:280px;max-width:360px;padding:0;background:rgba(26,31,46,0.96);border:1px solid rgba(200,220,240,0.2);clip-path:polygon(6px 0,calc(100% - 6px) 0,100% 6px,100% calc(100% - 6px),calc(100% - 6px) 100%,6px 100%,0 calc(100% - 6px),0 6px);backdrop-filter:blur(12px);color:#fff;font-family:'Inter',sans-serif;box-shadow:0 0 0 1px rgba(200,220,240,0.08),0 0 16px rgba(200,220,240,0.12),0 0 32px rgba(180,210,240,0.06),0 8px 32px rgba(0,0,0,0.5);overflow:hidden}
                .snow-report-box .snow-report-header{border-bottom:2px solid #38bdf8;padding:12px 14px 10px;background:rgba(0,0,0,0.2)}
                .snow-report-box .snow-report-body{padding:16px 18px}
                .snow-report-close{position:absolute;top:10px;right:10px;width:26px;height:26px;padding:0;border:1px solid rgba(255,255,255,0.2);border-radius:4px;background:rgba(255,255,255,0.1);color:#fff;font-size:18px;line-height:1;cursor:pointer;display:flex;align-items:center;justify-content:center}
                .snow-report-close:hover{background:rgba(255,255,255,0.18);color:#fff}
                .snow-report-type{font-size:1.2rem;font-weight:800;letter-spacing:.06em;text-transform:uppercase;margin-bottom:4px}
                .snow-report-location{font-size:.8rem;opacity:.85;text-transform:uppercase;letter-spacing:.04em;color:rgba(255,255,255,0.9)}
                .snow-report-gauge{height:6px;background:rgba(0,0,0,0.35);border-radius:3px;overflow:hidden;margin:12px 0 14px;position:relative}
                .snow-report-gauge-fill{height:100%;background:linear-gradient(90deg,#7dd3fc,#38bdf8);border-radius:3px;transition:width .3s ease}
                .snow-report-gauge-shimmer{position:absolute;top:0;left:0;height:100%;width:35%;background:linear-gradient(90deg,transparent,rgba(255,255,255,0.9),rgba(125,211,252,0.95),transparent);border-radius:3px;box-shadow:0 0 12px rgba(125,211,252,0.6);animation:snowGaugeShimmer 2s ease-in-out infinite}
                @keyframes snowGaugeShimmer{0%,100%{transform:translateX(0)}50%{transform:translateX(185%)}}
                .snow-report-value{display:flex;align-items:baseline;gap:8px;margin-bottom:14px}
                .snow-report-number{font-size:3rem;font-weight:800;line-height:1}
                .snow-report-unit{font-size:1rem;font-weight:700;opacity:.95;text-transform:uppercase;letter-spacing:.03em}
                .snow-report-section{background:rgba(0,0,0,0.25);border-radius:4px;padding:10px 12px;margin-bottom:8px;border:1px solid rgba(255,255,255,0.06)}
                .snow-report-section:last-of-type{margin-bottom:0}
                .snow-report-section-label{font-size:.65rem;opacity:.7;text-transform:uppercase;letter-spacing:.08em;margin-bottom:4px;color:rgba(255,255,255,0.9)}
                .snow-report-section-content{font-size:.85rem;opacity:.95;line-height:1.4}
                .snow-report-footer{display:flex;justify-content:space-between;align-items:flex-start;gap:16px}
                .snow-report-reported .snow-report-ago{font-size:.8rem;opacity:.9}
                .snow-report-datetime{font-size:.85rem;font-weight:600;white-space:nowrap}
                .storm-top-card{position:relative;min-width:312px;max-width:352px;padding:18px 18px 16px;background:
                    radial-gradient(130% 110% at 24% 4%,rgba(255,255,255,0.08),rgba(255,255,255,0) 46%),
                    linear-gradient(148deg,rgba(8,16,42,0.98) 0%,rgba(4,13,35,0.985) 48%,rgba(3,12,33,0.99) 100%);
                    border:1px solid rgba(190,214,255,0.2);
                    border-left:2px solid var(--report-accent);
                    clip-path:polygon(0 0,calc(100% - 8px) 0,100% 8px,100% calc(100% - 12px),calc(100% - 12px) 100%,0 100%);
                    box-shadow:0 0 0 1px rgba(255,255,255,0.06),0 0 28px var(--report-accent-soft),0 14px 34px rgba(0,0,0,0.52);
                    color:#f8fbff;font-family:'Rajdhani','Inter',sans-serif;overflow:hidden}
                .storm-top-close{position:absolute;top:10px;right:11px;width:24px;height:24px;border:0;background:transparent;color:rgba(241,246,255,0.84);font-size:20px;line-height:1;cursor:pointer;padding:0}
                .storm-top-close:hover{color:#fff}
                .storm-top-title{font-size:2.05rem;line-height:1;font-weight:800;letter-spacing:.06em;text-transform:uppercase}
                .storm-top-location{margin-top:8px;font-size:1.05rem;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:rgba(231,240,255,0.84)}
                .storm-top-line{margin-top:13px;position:relative;height:8px}
                .storm-top-line span{display:block;height:2px;background:linear-gradient(90deg,rgba(255,255,255,0.08) 0%,var(--report-accent-soft) 28%,rgba(255,255,255,0.88) 72%,rgba(255,255,255,0.16) 100%);box-shadow:0 0 12px var(--report-accent-soft)}
                .storm-top-metric{margin-top:13px;display:flex;align-items:baseline;justify-content:center;gap:10px}
                .storm-top-value{font-size:4.15rem;line-height:1;font-weight:800;letter-spacing:.01em;color:#f8fbff;text-shadow:0 0 16px rgba(255,255,255,0.2)}
                .storm-top-unit{font-size:1.45rem;font-weight:700;letter-spacing:.07em;color:rgba(224,234,247,0.88)}
                .storm-top-divider{margin-top:13px;height:1px;background:linear-gradient(90deg,rgba(255,255,255,0.1),rgba(255,255,255,0.26),rgba(255,255,255,0.1))}
                .storm-top-reported{margin-top:14px;padding:12px;background:linear-gradient(180deg,rgba(6,19,52,0.62),rgba(4,16,44,0.68));border:1px solid rgba(168,192,236,0.2);display:flex;justify-content:space-between;align-items:flex-start;gap:12px}
                .storm-top-kicker{font-size:1rem;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:rgba(197,216,248,0.78)}
                .storm-top-ago{margin-top:4px;font-size:1rem;font-weight:600;color:rgba(196,211,236,0.78)}
                .storm-top-time{font-size:1.95rem;font-weight:800;line-height:1;color:#f8fbff;white-space:nowrap}
                .storm-top-remarks{margin-top:12px;padding:12px 12px 13px;background:linear-gradient(180deg,rgba(5,18,49,0.62),rgba(4,14,40,0.72));border:1px solid rgba(160,186,232,0.18);border-radius:3px}
                .storm-top-remarks-text{margin-top:7px;font-size:1.35rem;font-weight:700;line-height:1.2;color:rgba(237,244,255,0.95)}
            `;
            document.head.appendChild(st);
        }
    } catch {}
    if (!map.getSource('lsr')) {
        const data = getPreloadedStormReportsData(240000) || await fetchStormReportsGeoJSON();
        map.addSource('lsr', {
            type: 'geojson',
            data
        });
    }
    ensureStormReportMarkerImages();
    // Glow underlay for reports (soft colored halo)
    if (!map.getLayer('lsr-glow')) {
        map.addLayer({
            id: 'lsr-glow',
            type: 'circle',
            source: 'lsr',
            // Match main filters
            filter: ['all',
                ['any',
                    ['in', ['get','type'], ['literal', ['T','H','W','S','G','D','F','R']]],
                    ['>=', ['index-of', 'tornado', ['downcase', ['get','typetext']]], 0],
                    ['>=', ['index-of', 'hail', ['downcase', ['get','typetext']]], 0],
                    ['any',
                        ['>=', ['index-of', 'damage', ['downcase', ['get','typetext']]], 0],
                        ['>=', ['index-of', 'dmg',    ['downcase', ['get','typetext']]], 0]
                    ],
                    ['any',
                        ['>=', ['index-of', 'wind', ['downcase', ['get','typetext']]], 0],
                        ['>=', ['index-of', 'wnd',  ['downcase', ['get','typetext']]], 0],
                        ['>=', ['index-of', 'tstm', ['downcase', ['get','typetext']]], 0]
                    ],
                    ['>=', ['index-of', 'snow', ['downcase', ['get','typetext']]], 0],
                    ['any',
                        ['>=', ['index-of', 'rain', ['downcase', ['get','typetext']]], 0],
                        ['>=', ['index-of', 'flood', ['downcase', ['get','typetext']]], 0],
                        ['>=', ['index-of', 'freez', ['downcase', ['get','typetext']]], 0],
                        ['>=', ['index-of', 'ice', ['downcase', ['get','typetext']]], 0]
                    ]
                ],
                ['!', ['>=', ['index-of', 'non-tstm', ['downcase', ['get','typetext']]], 0]],
                ['!', ['>=', ['index-of', 'non tstm', ['downcase', ['get','typetext']]], 0]]
            ],
            paint: {
                'circle-radius': [
                    'interpolate', ['linear'], ['zoom'],
                    4, 8,
                    8, 9.5,
                    12, 11
                ],
                'circle-color': [
                    'case',
                        ['>=', ['index-of', 'tornado', ['downcase', ['get','typetext']]], 0], '#ef3340',
                        ['>=', ['index-of', 'hail', ['downcase', ['get','typetext']]], 0], '#00b84f',
                        ['any', ['>=', ['index-of', 'damage', ['downcase', ['get','typetext']]], 0], ['>=', ['index-of', 'dmg', ['downcase', ['get','typetext']]], 0]], '#1f4eb6',
                        ['any', ['>=', ['index-of', 'wind', ['downcase', ['get','typetext']]], 0], ['>=', ['index-of', 'wnd', ['downcase', ['get','typetext']]], 0], ['>=', ['index-of', 'tstm', ['downcase', ['get','typetext']]], 0]], '#2b8eff',
                        ['>=', ['index-of', 'snow', ['downcase', ['get','typetext']]], 0], '#dbeafe',
                        ['>=', ['index-of', 'flood', ['downcase', ['get','typetext']]], 0], '#1d8dff',
                        ['any', ['>=', ['index-of', 'rain', ['downcase', ['get','typetext']]], 0], ['>=', ['index-of', 'freez', ['downcase', ['get','typetext']]], 0], ['>=', ['index-of', 'ice', ['downcase', ['get','typetext']]], 0]], '#06b6d4',
                        /* default */ '#2b8eff'
                ],
                'circle-opacity': 0.2,
                'circle-blur': 0.95
            }
        });
    }
    // Bright outer white ring to mimic glossy report badges
    if (!map.getLayer('lsr-ring')) {
        map.addLayer({
            id: 'lsr-ring',
            type: 'circle',
            source: 'lsr',
            filter: ['all',
                ['any',
                    ['in', ['get','type'], ['literal', ['T','H','W','S','G','D','F','R']]],
                    ['>=', ['index-of', 'tornado', ['downcase', ['get','typetext']]], 0],
                    ['>=', ['index-of', 'hail', ['downcase', ['get','typetext']]], 0],
                    ['any',
                        ['>=', ['index-of', 'damage', ['downcase', ['get','typetext']]], 0],
                        ['>=', ['index-of', 'dmg',    ['downcase', ['get','typetext']]], 0]
                    ],
                    ['any',
                        ['>=', ['index-of', 'wind', ['downcase', ['get','typetext']]], 0],
                        ['>=', ['index-of', 'wnd',  ['downcase', ['get','typetext']]], 0],
                        ['>=', ['index-of', 'tstm', ['downcase', ['get','typetext']]], 0]
                    ],
                    ['>=', ['index-of', 'snow', ['downcase', ['get','typetext']]], 0],
                    ['any',
                        ['>=', ['index-of', 'rain', ['downcase', ['get','typetext']]], 0],
                        ['>=', ['index-of', 'flood', ['downcase', ['get','typetext']]], 0],
                        ['>=', ['index-of', 'freez', ['downcase', ['get','typetext']]], 0],
                        ['>=', ['index-of', 'ice', ['downcase', ['get','typetext']]], 0]
                    ]
                ],
                ['!', ['>=', ['index-of', 'non-tstm', ['downcase', ['get','typetext']]], 0]],
                ['!', ['>=', ['index-of', 'non tstm', ['downcase', ['get','typetext']]], 0]]
            ],
            paint: {
                'circle-radius': [
                    'interpolate', ['linear'], ['zoom'],
                    4, 7.4,
                    8, 8.4,
                    12, 9.7
                ],
                'circle-color': 'rgba(0,0,0,0)',
                'circle-stroke-color': 'rgba(8,12,22,0.84)',
                'circle-stroke-width': 1.15,
                'circle-stroke-opacity': 0.95
            }
        });
    }
    // Unclustered reports (main bubbles)
    if (!map.getLayer('lsr-points')) {
        map.addLayer({
            id: 'lsr-points',
            type: 'circle',
            source: 'lsr',
            // Only wind/hail/tornado/snow/damage and exclude NON-TSTM wind gust
            filter: ['all',
                ['any',
                    ['in', ['get','type'], ['literal', ['T','H','W','S','G','D','F','R']]],
                    ['>=', ['index-of', 'tornado', ['downcase', ['get','typetext']]], 0],
                    ['>=', ['index-of', 'hail', ['downcase', ['get','typetext']]], 0],
                    ['any',
                        ['>=', ['index-of', 'damage', ['downcase', ['get','typetext']]], 0],
                        ['>=', ['index-of', 'dmg',    ['downcase', ['get','typetext']]], 0]
                    ],
                    ['any',
                        ['>=', ['index-of', 'wind', ['downcase', ['get','typetext']]], 0],
                        ['>=', ['index-of', 'wnd',  ['downcase', ['get','typetext']]], 0],
                        ['>=', ['index-of', 'tstm', ['downcase', ['get','typetext']]], 0]
                    ],
                    ['>=', ['index-of', 'snow', ['downcase', ['get','typetext']]], 0],
                    ['any',
                        ['>=', ['index-of', 'rain', ['downcase', ['get','typetext']]], 0],
                        ['>=', ['index-of', 'flood', ['downcase', ['get','typetext']]], 0],
                        ['>=', ['index-of', 'freez', ['downcase', ['get','typetext']]], 0],
                        ['>=', ['index-of', 'ice', ['downcase', ['get','typetext']]], 0]
                    ]
                ],
                ['!', ['>=', ['index-of', 'non-tstm', ['downcase', ['get','typetext']]], 0]],
                ['!', ['>=', ['index-of', 'non tstm', ['downcase', ['get','typetext']]], 0]]
            ],
            paint: {
                'circle-radius': [
                    'interpolate', ['linear'], ['zoom'],
                    4, 12.5,
                    8, 14.5,
                    12, 17.5
                ],
                // Invisible interaction target; visuals are rendered by symbol icons.
                'circle-color': 'rgba(0,0,0,0)',
                'circle-stroke-color': 'rgba(0,0,0,0)',
                'circle-stroke-width': 0,
                'circle-opacity': 0,
                'circle-blur': 0
            }
        });
    }
    if (!map.getLayer(STORM_REPORT_ICON_LAYER_ID)) {
        map.addLayer({
            id: STORM_REPORT_ICON_LAYER_ID,
            type: 'symbol',
            source: 'lsr',
            filter: ['all',
                ['any',
                    ['in', ['get','type'], ['literal', ['T','H','W','S','G','D','F','R']]],
                    ['>=', ['index-of', 'tornado', ['downcase', ['get','typetext']]], 0],
                    ['>=', ['index-of', 'hail', ['downcase', ['get','typetext']]], 0],
                    ['any',
                        ['>=', ['index-of', 'damage', ['downcase', ['get','typetext']]], 0],
                        ['>=', ['index-of', 'dmg',    ['downcase', ['get','typetext']]], 0]
                    ],
                    ['any',
                        ['>=', ['index-of', 'wind', ['downcase', ['get','typetext']]], 0],
                        ['>=', ['index-of', 'wnd',  ['downcase', ['get','typetext']]], 0],
                        ['>=', ['index-of', 'tstm', ['downcase', ['get','typetext']]], 0]
                    ],
                    ['>=', ['index-of', 'snow', ['downcase', ['get','typetext']]], 0],
                    ['any',
                        ['>=', ['index-of', 'rain', ['downcase', ['get','typetext']]], 0],
                        ['>=', ['index-of', 'flood', ['downcase', ['get','typetext']]], 0],
                        ['>=', ['index-of', 'freez', ['downcase', ['get','typetext']]], 0],
                        ['>=', ['index-of', 'ice', ['downcase', ['get','typetext']]], 0]
                    ]
                ],
                ['!', ['>=', ['index-of', 'non-tstm', ['downcase', ['get','typetext']]], 0]],
                ['!', ['>=', ['index-of', 'non tstm', ['downcase', ['get','typetext']]], 0]]
            ],
            layout: {
                'icon-image': stormReportIconImageExpression(),
                'icon-size': [
                    'interpolate', ['linear'], ['zoom'],
                    4, 0.56,
                    8, 0.68,
                    12, 0.84
                ],
                'icon-allow-overlap': true,
                'icon-ignore-placement': true
            },
            paint: {
                'icon-opacity': 0.96
            }
        });
    }
    // Glossy highlight on top-left of each badge
    if (!map.getLayer('lsr-highlight')) {
        map.addLayer({
            id: 'lsr-highlight',
            type: 'circle',
            source: 'lsr',
            filter: ['all',
                ['any',
                    ['in', ['get','type'], ['literal', ['T','H','W','S','G','D','F','R']]],
                    ['>=', ['index-of', 'tornado', ['downcase', ['get','typetext']]], 0],
                    ['>=', ['index-of', 'hail', ['downcase', ['get','typetext']]], 0],
                    ['any',
                        ['>=', ['index-of', 'damage', ['downcase', ['get','typetext']]], 0],
                        ['>=', ['index-of', 'dmg',    ['downcase', ['get','typetext']]], 0]
                    ],
                    ['any',
                        ['>=', ['index-of', 'wind', ['downcase', ['get','typetext']]], 0],
                        ['>=', ['index-of', 'wnd',  ['downcase', ['get','typetext']]], 0],
                        ['>=', ['index-of', 'tstm', ['downcase', ['get','typetext']]], 0]
                    ],
                    ['>=', ['index-of', 'snow', ['downcase', ['get','typetext']]], 0],
                    ['any',
                        ['>=', ['index-of', 'rain', ['downcase', ['get','typetext']]], 0],
                        ['>=', ['index-of', 'flood', ['downcase', ['get','typetext']]], 0],
                        ['>=', ['index-of', 'freez', ['downcase', ['get','typetext']]], 0],
                        ['>=', ['index-of', 'ice', ['downcase', ['get','typetext']]], 0]
                    ]
                ],
                ['!', ['>=', ['index-of', 'non-tstm', ['downcase', ['get','typetext']]], 0]],
                ['!', ['>=', ['index-of', 'non tstm', ['downcase', ['get','typetext']]], 0]]
            ],
            paint: {
                'circle-radius': [
                    'interpolate', ['linear'], ['zoom'],
                    4, 1.7,
                    8, 2.1,
                    12, 2.4
                ],
                'circle-color': 'rgba(255,255,255,0.92)',
                'circle-opacity': 0.17,
                'circle-blur': 0.35,
                'circle-translate': [-1, -1]
            }
        });
    }
    // Letters inside circles (T/H/W/S/D/F/R)
    if (!map.getLayer('lsr-text')) {
        map.addLayer({
            id: 'lsr-text',
            type: 'symbol',
            source: 'lsr',
            // Match the same filter as lsr-points to prevent orphaned letters
            filter: ['all',
                ['any',
                    ['in', ['get','type'], ['literal', ['T','H','W','S','G','D','F','R']]],
                    ['>=', ['index-of', 'tornado', ['downcase', ['get','typetext']]], 0],
                    ['>=', ['index-of', 'hail', ['downcase', ['get','typetext']]], 0],
                    ['any',
                        ['>=', ['index-of', 'damage', ['downcase', ['get','typetext']]], 0],
                        ['>=', ['index-of', 'dmg',    ['downcase', ['get','typetext']]], 0]
                    ],
                    ['any',
                        ['>=', ['index-of', 'wind', ['downcase', ['get','typetext']]], 0],
                        ['>=', ['index-of', 'wnd',  ['downcase', ['get','typetext']]], 0],
                        ['>=', ['index-of', 'tstm', ['downcase', ['get','typetext']]], 0]
                    ],
                    ['>=', ['index-of', 'snow', ['downcase', ['get','typetext']]], 0],
                    ['any',
                        ['>=', ['index-of', 'rain', ['downcase', ['get','typetext']]], 0],
                        ['>=', ['index-of', 'flood', ['downcase', ['get','typetext']]], 0],
                        ['>=', ['index-of', 'freez', ['downcase', ['get','typetext']]], 0],
                        ['>=', ['index-of', 'ice', ['downcase', ['get','typetext']]], 0]
                    ]
                ],
                ['!', ['>=', ['index-of', 'non-tstm', ['downcase', ['get','typetext']]], 0]],
                ['!', ['>=', ['index-of', 'non tstm', ['downcase', ['get','typetext']]], 0]]
            ],
            layout: {
                'text-field': [
                    'case',
                        ['>=', ['index-of', 'tornado', ['downcase', ['get','typetext']]], 0], 'T',
                        ['>=', ['index-of', 'hail', ['downcase', ['get','typetext']]], 0], 'H',
                        ['any',
                            ['>=', ['index-of', 'damage', ['downcase', ['get','typetext']]], 0],
                            ['>=', ['index-of', 'dmg',    ['downcase', ['get','typetext']]], 0]
                        ], 'D',
                        ['any',
                            ['>=', ['index-of', 'wind', ['downcase', ['get','typetext']]], 0],
                            ['>=', ['index-of', 'wnd',  ['downcase', ['get','typetext']]], 0],
                            ['>=', ['index-of', 'tstm', ['downcase', ['get','typetext']]], 0]
                        ], 'W',
                        ['>=', ['index-of', 'snow', ['downcase', ['get','typetext']]], 0], 'S',
                        ['>=', ['index-of', 'flood', ['downcase', ['get','typetext']]], 0], 'F',
                        ['any',
                            ['>=', ['index-of', 'rain', ['downcase', ['get','typetext']]], 0],
                            ['>=', ['index-of', 'freez', ['downcase', ['get','typetext']]], 0],
                            ['>=', ['index-of', 'ice', ['downcase', ['get','typetext']]], 0]
                        ], 'R',
                        ['==', ['get','type'], 'T'], 'T',
                        ['==', ['get','type'], 'H'], 'H',
                        ['==', ['get','type'], 'D'], 'D',
                        ['any', ['==', ['get','type'], 'W'], ['==', ['get','type'], 'G']], 'W',
                        ['==', ['get','type'], 'S'], 'S',
                        ['==', ['get','type'], 'F'], 'F',
                        ['==', ['get','type'], 'R'], 'R',
                        ''
                ],
                'text-font': ['Noto Sans Bold'],
                'text-size': 10.5,
                'text-offset': [0, 0.05],
                'text-allow-overlap': true
            },
            paint: {
                'text-color': '#ffffff',
                'text-halo-color': 'rgba(0,0,0,0.85)',
                'text-halo-width': 0.9
            }
        });
    }
    // Legacy circle/letter layers are hidden; custom badge symbols render the report icons.
    ['lsr-glow', 'lsr-ring', 'lsr-highlight', 'lsr-text'].forEach((id) => {
        try { if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', 'none'); } catch {}
    });
    try { ensureStormReportPulseLayers(); } catch {}
    // Popups on click
    if (!map.__lsrClickBound) {
        map.__lsrClickBound = true;
        map.on('mouseenter', 'lsr-points', () => { map.getCanvas().style.cursor = 'pointer'; });
        map.on('mouseleave', 'lsr-points', () => { map.getCanvas().style.cursor = ''; });
        map.on('mouseenter', STORM_REPORT_ICON_LAYER_ID, () => { map.getCanvas().style.cursor = 'pointer'; });
        map.on('mouseleave', STORM_REPORT_ICON_LAYER_ID, () => { map.getCanvas().style.cursor = ''; });

        // Popup for single reports
        const handleStormReportClick = (e) => {
            const stamp = e?.originalEvent?.timeStamp;
            if (stamp && map.__lastCompositeClickStamp === stamp) return;
            if (stamp) map.__lastCompositeClickStamp = stamp;

            const items = buildCombinedClickItemsFromPoint(e.point);
            if (!items.length) return;
            if (items.length > 1) {
                showOverlappingMenu(items, e.lngLat);
                return;
            }
            openCombinedClickItem(items[0], e.lngLat);
        };
        map.on('click', 'lsr-points', handleStormReportClick);
        map.on('click', STORM_REPORT_ICON_LAYER_ID, handleStormReportClick);
    }
}

async function refreshStormReportsSource() {
    try {
        const data = getPreloadedStormReportsData(180000) || await fetchStormReportsGeoJSON();
        preloadedStormReportsData = data;
        preloadedStormReportsAt = Date.now();
        const src = map.getSource('lsr');
        if (src && src.setData) src.setData(data);
    } catch {}
}

function toggleStormReportsLayer() {
    if (!map) return false;
    const visible = map.getLayer('lsr-points');
    if (!visible) {
        // create
        ensureStormReportsLayers();
        return true;
    }
    const current = (map.getLayoutProperty('lsr-points','visibility') || 'visible') !== 'none';
    const next = current ? 'none' : 'visible';
    [
        'lsr-points',
        STORM_REPORT_ICON_LAYER_ID,
        STORM_REPORT_PULSE_RING_LAYER_ID,
        STORM_REPORT_PULSE_CORE_LAYER_ID
    ].forEach(id => { try { if (map.getLayer(id)) map.setLayoutProperty(id,'visibility',next); } catch {} });
    return next === 'visible';
}

// ---------------- HRRR Raster Overlay ----------------
async function ensureHRRRLayer(tileUrl) {
    if (!map) return;
    if (!map.getSource('hrrr')) {
        map.addSource('hrrr', { type: 'raster', tiles: [tileUrl], tileSize: 256, attribution: 'HRRR' });
    }
    if (!map.getLayer('hrrr-layer')) {
        // place above basemap but below warnings/everything
        map.addLayer({ id: 'hrrr-layer', type: 'raster', source: 'hrrr', paint: { 'raster-opacity': 0.6 } }, 'warnings');
    }
}

async function toggleHRRRLayer() {
    if (!map) return false;
    let url = localStorage.getItem('hrrrTileUrl');
    if (!map.getLayer('hrrr-layer')) {
        if (!url) {
            url = prompt('Enter HRRR raster tile URL template (e.g., https://example.com/hrrr/{z}/{x}/{y}.png). You can paste a WMTS REST tile URL as well. This will be stored locally.');
            if (!url) return false;
            localStorage.setItem('hrrrTileUrl', url);
        }
        await ensureHRRRLayer(url);
        return true;
    }
    const current = (map.getLayoutProperty('hrrr-layer','visibility') || 'visible') !== 'none';
    const next = current ? 'none' : 'visible';
    try { map.setLayoutProperty('hrrr-layer','visibility', next); } catch {}
    return next === 'visible';
}

// --- Test utilities: inject synthetic TEST alerts to preview UI ---
function injectTestAlert(preset = 'severe') {
    try {
        const center = (map && map.getCenter) ? map.getCenter() : { lng: -97, lat: 38 };
        const now = new Date();
        const inMinutes = (m)=> new Date(now.getTime() + m*60000).toISOString();

        const base = {
            type: 'Feature',
            id: 'TEST-' + preset.toUpperCase() + '-' + Date.now(),
            geometry: { type: 'Point', coordinates: [center.lng, center.lat] },
            properties: {
                messageType: 'Test',
                status: 'Actual',
                sent: now.toISOString(),
                effective: now.toISOString(),
                expires: inMinutes(45),
                areaDesc: 'ESSEX, MA; MIDDLESEX, MA; SUFFOLK, MA; NORFOLK, MA; PLYMOUTH, MA',
                senderName: 'NWS Test Office',
                parameters: {},
                url: 'https://api.weather.gov/alerts',
            }
        };

        if (preset === 'severe') {
            base.properties.event = 'Severe Thunderstorm Warning (TEST)';
            base.properties.headline = 'SEVERE T-STORM WARNING [TEST]';
            base.properties.description = 'HAZARD: 60 MPH WIND GUSTS AND QUARTER SIZE HAIL.\nSOURCE: RADAR INDICATED.\nIMPACTS: EXPECT DAMAGE TO ROOFS, SIDING, AND TREES.\nTORNADO POSSIBLE.';
            base.properties.parameters = { maxWindGust: '60 MPH', maxHailSize: '1.00' };
        } else if (preset === 'tornado') {
            base.properties.event = 'Tornado Warning (TEST)';
            base.properties.headline = 'TORNADO WARNING [TEST]';
            base.properties.description = 'HAZARD: TORNADO.\nSOURCE: RADAR INDICATED ROTATION.\nIMPACTS: FLYING DEBRIS WILL BE DANGEROUS TO THOSE CAUGHT WITHOUT SHELTER.';
            base.properties.parameters = { maxHailSize: '1.00' };
        } else if (preset === 'flashflood') {
            base.properties.event = 'Flash Flood Warning (TEST)';
            base.properties.headline = 'FLASH FLOOD WARNING [TEST]';
            base.properties.description = 'HAZARD: LIFE THREATENING FLASH FLOODING. THUNDERSTORMS PRODUCING FLASH FLOODING.\nSOURCE: RADAR INDICATED.\nIMPACTS: RAPID RISES IN SMALL STREAMS AND CREEKS. DAMAGE THREAT: CONSIDERABLE.';
        } else if (preset === 'sws') {
            base.properties.event = 'Special Weather Statement (TEST)';
            base.properties.headline = 'SPECIAL WEATHER STATEMENT [TEST]';
            base.properties.description = 'A STRONG THUNDERSTORM WILL IMPACT SOUTHWESTERN SEMINOLE AND WESTERN ORANGE COUNTIES THROUGH 600 PM EDT.';
            base.properties.expires = inMinutes(25);
        } else {
            base.properties.event = 'Severe Thunderstorm Warning (TEST)';
            base.properties.description = 'HAZARD: 60 MPH WIND GUSTS AND QUARTER SIZE HAIL.\nSOURCE: RADAR INDICATED.';
            base.properties.parameters = { maxWindGust: '60 MPH', maxHailSize: '1.00' };
        }

        // Push to in-memory alerts and update map (no auto popup on map page)
        weatherWarnings.unshift(base);
        updateWarningsSource();
    } catch (e) {
        console.error('injectTestAlert failed', e);
    }
}

window.injectTestAlert = injectTestAlert;

