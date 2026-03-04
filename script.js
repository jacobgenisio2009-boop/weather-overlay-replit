        
// Fetch and render all active warnings from the NWS API
const API_URL = 'https://api.weather.gov/alerts/active';
const POLICE_SCANNER_ACTIVITY_URL = 'https://data.seattle.gov/resource/33kz-ixgy.json';
const YOUTUBE_API_KEY = 'YOUR_YOUTUBE_API_KEY'; // Replace with your YouTube API key
const YOUTUBE_CHANNEL_ID = 'UCwVzQyZ1f2WfI98nqBmNnHQ'; // Ryan Hall, Y'all channel ID
const RYAN_STREAM_EMBED_URL = `https://www.youtube.com/embed/live_stream?channel=${YOUTUBE_CHANNEL_ID}`;
const RYAN_STREAM_BACKUP_EMBED_URL = 'https://www.youtube.com/embed/JuGP3_GNGmE?si=6Aaf29Qplm-6r-Q1';
const WEATHERWISE_POPOUT_URL = 'https://web.weatherwise.app/#map=5.19/37.487/-89.431&rt=KLSX&rp=N0B&m=RADAR&sc=GOES-East&sp=ABI_GeoColor';
const WEATHERWISE_RADAR_STATIONS_URL = 'https://api.weather.gov/radar/stations';
const WEATHERWISE_RADAR_STATION_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
let weatherWiseRadarStationCache = [];
let weatherWiseRadarStationCacheFetchedAt = 0;
let weatherWiseRadarStationCachePromise = null;
// Keep this as a var to avoid temporal-dead-zone errors if click handlers fire early.
var stormReportsDashboardState = (
    typeof globalThis !== 'undefined' && globalThis.stormReportsDashboardState
) || {
    range: 'today',
    loading: false,
    reports: [],
    lastUpdatedAt: null,
    statusNote: '',
    errorMessage: '',
    typeFilter: 'all',
    requestId: 0
};
if (typeof globalThis !== 'undefined') {
    globalThis.stormReportsDashboardState = stormReportsDashboardState;
}
let stormReportsDashboardRefreshTimer = null;
let scannerDashboardState = {
    transmissions: 0,
    events: 0,
    severityCritical: 0,
    severityWarning: 0,
    severityMinor: 0,
    lastUpdatedAt: null,
    statusNote: 'No recent police scanner activity in the current analysis window.',
    recentTraffic: []
};

const BLOCKING_OVERLAY_SELECTOR = [
    '#warning-modal-overlay',
    '#source-modal-overlay',
    '#storm-reports-dashboard-overlay',
    '#storm-reports-fallback-overlay',
    '#scanner-dashboard-overlay',
    '#ryan-live-section.is-open',
    '.forecast-settings-modal',
    '#map-settings-modal'
].join(', ');

function hasBlockingOverlayOpen() {
    try {
        return !!document.querySelector(BLOCKING_OVERLAY_SELECTOR);
    } catch {
        return false;
    }
}

function setPageScrollLock(locked) {
    const body = document.body;
    if (!body) return;
    const isLocked = body.classList.contains('page-scroll-locked');
    if (locked === isLocked) return;

    if (locked) {
        const y = Number(window.scrollY || window.pageYOffset || document.documentElement.scrollTop || 0);
        body.dataset.scrollLockY = String(Number.isFinite(y) ? y : 0);
        body.style.top = `-${body.dataset.scrollLockY}px`;
        body.classList.add('page-scroll-locked');
        return;
    }

    const restoreY = Number(body.dataset.scrollLockY || '0');
    body.classList.remove('page-scroll-locked');
    body.style.top = '';
    try { delete body.dataset.scrollLockY; } catch { body.dataset.scrollLockY = ''; }
    try { window.scrollTo(0, Number.isFinite(restoreY) ? restoreY : 0); } catch {}
}

function syncBlockingOverlayScrollLock() {
    setPageScrollLock(hasBlockingOverlayOpen());
}

function stopStormReportsAutoRefresh() {
    if (stormReportsDashboardRefreshTimer) {
        try { clearInterval(stormReportsDashboardRefreshTimer); } catch {}
        stormReportsDashboardRefreshTimer = null;
    }
}

function startStormReportsAutoRefresh() {
    stopStormReportsAutoRefresh();
    stormReportsDashboardRefreshTimer = setInterval(() => {
        try {
            const overlay = document.getElementById('storm-reports-dashboard-overlay');
            if (!overlay) {
                stopStormReportsAutoRefresh();
                return;
            }
            if (stormReportsDashboardState.loading) return;
            const activeRange = String(stormReportsDashboardState.range || 'today');
            loadStormReportsDashboardData(activeRange);
        } catch (e) {
            console.warn('storm reports auto-refresh failed', e);
        }
    }, 60 * 1000);
}

function initBlockingOverlayScrollLockObserver() {
    try {
        if (window.__blockingOverlayScrollLockObserverInited) return;
        window.__blockingOverlayScrollLockObserverInited = true;

        const start = () => {
            if (!document.body) return;
            syncBlockingOverlayScrollLock();
            const observer = new MutationObserver(() => {
                syncBlockingOverlayScrollLock();
            });
            observer.observe(document.body, { childList: true });
            window.__blockingOverlayScrollLockObserver = observer;
        };

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', start, { once: true });
        } else {
            start();
        }
    } catch {}
}
initBlockingOverlayScrollLockObserver();

// Track new warnings for notification
let previousWarnings = new Set();
let newWarnings = new Set();
let animatedWarnings = new Set();
let programStartTime = new Date();

// --- Popup time badges live updater ---
let trayTimeUpdaterTimer = null;
function ensureTrayTimeUpdater() {
    const tick = () => {
        try {
            const now = Date.now();
            // Update ISSUED minutes
            document.querySelectorAll('#warning-tray .issued-minutes').forEach(el => {
                try {
                    const ts = el.getAttribute('data-sent') || el.dataset.sent || '';
                    if (!ts) return;
                    const t = new Date(ts).getTime();
                    if (!isFinite(t)) return;
                    const diffMin = Math.max(0, Math.round((now - t) / 60000));
                    el.textContent = `${formatTrayDuration(diffMin)} AGO`;
                } catch {}
            });
            // Update EXPIRES minutes
            document.querySelectorAll('#warning-tray .expires-minutes').forEach(el => {
                try {
                    const exp = el.getAttribute('data-exp') || el.dataset.exp || '';
                    if (!exp) return;
                    const e = new Date(exp).getTime();
                    if (!isFinite(e)) return;
                    const diffMin = Math.max(0, Math.round((e - now) / 60000));
                    el.textContent = `${formatTrayDuration(diffMin)}`;
                } catch {}
            });
        } catch {}
    };
    if (!trayTimeUpdaterTimer) {
        trayTimeUpdaterTimer = setInterval(tick, 60000);
    }
    // Also tick immediately so values are fresh on insert
    tick();
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildWeatherWiseCaptureFilename(warning) {
    const props = warning && warning.properties ? warning.properties : {};
    const eventName = String(getDisplayEventName(props.event, props) || props.event || 'warning');
    const safeEvent = eventName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'warning';
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    return `${safeEvent}-weatherwise-${stamp}.png`;
}

function wwPosterNormalize(value, fallback = 'N/A') {
    const clean = String(value || '').replace(/\s+/g, ' ').trim();
    return clean || fallback;
}

function wwPosterClamp(value, maxChars = 110) {
    const clean = wwPosterNormalize(value, '');
    if (!clean) return '';
    if (clean.length <= maxChars) return clean;
    return clean.slice(0, Math.max(0, maxChars - 3)).trimEnd() + '...';
}

function wwPosterParam(props, keys = []) {
    const params = props && props.parameters ? props.parameters : {};
    for (const key of keys) {
        const raw = params ? params[key] : null;
        const value = Array.isArray(raw) ? raw[0] : raw;
        const clean = wwPosterNormalize(value, '');
        if (clean) return clean;
    }
    return '';
}

function wwPosterFormatDate(value) {
    if (!value) return 'N/A';
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return 'N/A';
    try {
        return date.toLocaleString('en-US', {
            weekday: 'short',
            month: 'short',
            day: 'numeric',
            year: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
            hour12: true,
            timeZoneName: 'short'
        });
    } catch {
        return date.toString();
    }
}

function wwPosterBuildAreaText(areaDesc) {
    return formatAreas(areaDesc, {
        fallback: 'MULTIPLE COUNTIES',
        upperCase: true
    });
}

function wwPosterStormMotionText(props) {
    const fromParams = wwPosterParam(props, [
        'stormMotion',
        'stormMotionDescription',
        'stormMotionText',
        'MOTION',
        'motion'
    ]);
    if (fromParams) return fromParams.toUpperCase();

    const desc = String(props && props.description ? props.description : '');
    const movingMatch = desc.match(/\bmoving\s+([A-Za-z\-\s]+?)\s+at\s+(\d{1,3})\s*mph\b/i);
    if (movingMatch && movingMatch[1] && movingMatch[2]) {
        const direction = movingMatch[1].replace(/\s+/g, ' ').trim().toUpperCase();
        return `${direction} AT ${movingMatch[2]} MPH`;
    }
    return 'N/A';
}

function wwPosterHeaderColor(eventName) {
    // Broadcast-style header keeps a consistent amber tone like the reference look.
    return '#f59e0b';
}

function wwPosterDrawStormIcon(ctx, x, y, size) {
    const s = Math.max(16, Number(size) || 24);
    ctx.save();
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(x + s * 0.36, y + s * 0.46, s * 0.2, 0, Math.PI * 2);
    ctx.arc(x + s * 0.53, y + s * 0.38, s * 0.24, 0, Math.PI * 2);
    ctx.arc(x + s * 0.72, y + s * 0.46, s * 0.18, 0, Math.PI * 2);
    ctx.fillRect(x + s * 0.24, y + s * 0.48, s * 0.56, s * 0.22);
    ctx.fill();

    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = Math.max(1.5, s * 0.06);
    const rainStartY = y + s * 0.78;
    [[0.34, 0.08], [0.52, 0.1], [0.69, 0.08]].forEach(([rx, drop]) => {
        ctx.beginPath();
        ctx.moveTo(x + s * rx, rainStartY);
        ctx.lineTo(x + s * (rx - drop), rainStartY + s * 0.2);
        ctx.stroke();
    });
    ctx.restore();
}

function wwPosterCentroid(geometry) {
    try {
        if (!geometry) return null;
        let lon = 0;
        let lat = 0;
        let n = 0;
        const add = (x, y) => {
            if (!Number.isFinite(x) || !Number.isFinite(y)) return;
            lon += x;
            lat += y;
            n += 1;
        };

        if (geometry.type === 'Point' && Array.isArray(geometry.coordinates)) {
            add(geometry.coordinates[0], geometry.coordinates[1]);
        } else if (geometry.type === 'Polygon') {
            (geometry.coordinates || []).forEach((ring) => (ring || []).forEach(([x, y]) => add(x, y)));
        } else if (geometry.type === 'MultiPolygon') {
            (geometry.coordinates || []).forEach((poly) => (poly || []).forEach((ring) => (ring || []).forEach(([x, y]) => add(x, y))));
        }
        if (!n) return null;
        return { lat: lat / n, lon: lon / n };
    } catch {
        return null;
    }
}

function wwPosterFormatChipTime(value) {
    if (!value) return '';
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return '';
    try {
        return date.toLocaleString('en-US', {
            month: 'short',
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
            hour12: true,
            timeZoneName: 'short'
        });
    } catch {
        return '';
    }
}

function wwPosterDrawRoundedRect(ctx, x, y, width, height, radius = 10) {
    const r = Math.max(0, Math.min(radius, Math.min(width, height) / 2));
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + width, y, x + width, y + height, r);
    ctx.arcTo(x + width, y + height, x, y + height, r);
    ctx.arcTo(x, y + height, x, y, r);
    ctx.arcTo(x, y, x + width, y, r);
    ctx.closePath();
}

function wwPosterWrapText(ctx, text, maxWidth, maxLines = 3) {
    const words = String(text || '').trim().split(/\s+/).filter(Boolean);
    if (!words.length) return ['N/A'];
    const fitWidth = Math.max(24, Number(maxWidth) || 0);
    const lines = [];
    let current = '';

    const splitLongWord = (word) => {
        let remaining = String(word || '');
        while (remaining) {
            let chunk = '';
            let idx = 0;
            while (idx < remaining.length) {
                const candidate = chunk + remaining[idx];
                if (chunk && ctx.measureText(candidate).width > fitWidth) break;
                chunk = candidate;
                idx += 1;
            }
            if (!chunk) {
                chunk = remaining[0];
                idx = 1;
            }
            lines.push(chunk);
            remaining = remaining.slice(idx);
        }
    };

    words.forEach((word) => {
        if (!current) {
            if (ctx.measureText(word).width <= fitWidth) {
                current = word;
            } else {
                splitLongWord(word);
            }
            return;
        }

        const candidate = `${current} ${word}`;
        if (ctx.measureText(candidate).width <= fitWidth) {
            current = candidate;
            return;
        }

        lines.push(current);
        if (ctx.measureText(word).width <= fitWidth) {
            current = word;
        } else {
            splitLongWord(word);
            current = '';
        }
    });

    if (current) lines.push(current);
    if (lines.length <= maxLines) return lines;
    const out = lines.slice(0, maxLines);
    let last = out[out.length - 1];
    while (last && ctx.measureText(`${last}...`).width > fitWidth) {
        const cut = last.lastIndexOf(' ');
        if (cut <= 0) {
            last = last.slice(0, Math.max(0, last.length - 1));
            continue;
        }
        last = last.slice(0, cut);
    }
    out[out.length - 1] = `${last || ''}...`.trim();
    return out;
}

function wwPosterDrawImageCover(ctx, image, x, y, width, height, options = {}) {
    if (!image) return;
    const iw = Number(image.naturalWidth || image.width || 0);
    const ih = Number(image.naturalHeight || image.height || 0);
    if (!(iw > 0) || !(ih > 0)) return;
    const topCropPx = Math.max(0, Math.min(ih - 1, Math.floor(Number(options.topCropPx) || 0)));
    const cropW = iw;
    const cropH = Math.max(1, ih - topCropPx);
    const scale = Math.max(width / cropW, height / cropH);
    const drawW = cropW * scale;
    const drawH = cropH * scale;
    const dx = x + (width - drawW) / 2;
    const dy = y + (height - drawH) / 2;
    ctx.drawImage(image, 0, topCropPx, cropW, cropH, dx, dy, drawW, drawH);
}

function wwPosterDrawInfoCard(ctx, config) {
    const {
        x,
        y,
        width,
        label,
        value,
        valueColor = '#f5f8ff',
        labelColor = '#ff4d5f',
        bgColor = '#22252c',
        borderColor = 'rgba(255,255,255,0.10)',
        maxLines = 2
    } = config;

    const padX = 14;
    const padY = 8;
    const rightWrapSafety = 20;
    const labelFont = '700 12px "Segoe UI", Tahoma, sans-serif';
    const bodyFont = '600 16px "Segoe UI", Tahoma, sans-serif';

    ctx.save();
    ctx.font = bodyFont;
    const bodyLines = wwPosterWrapText(
        ctx,
        wwPosterNormalize(value),
        width - (padX * 2) - rightWrapSafety,
        maxLines
    );
    const bodyLineHeight = 24;
    const cardHeight = (padY * 2) + 16 + (bodyLines.length * bodyLineHeight);

    wwPosterDrawRoundedRect(ctx, x, y, width, cardHeight, 8);
    ctx.fillStyle = bgColor;
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = borderColor;
    ctx.stroke();

    ctx.fillStyle = labelColor;
    ctx.font = labelFont;
    ctx.fillText(String(label || '').toUpperCase(), x + padX, y + padY + 11);

    ctx.fillStyle = valueColor;
    ctx.font = bodyFont;
    const textClipX = x + padX;
    const textClipY = y + padY + 16;
    const textClipW = Math.max(24, width - (padX * 2) - 8);
    const textClipH = Math.max(bodyLineHeight + 8, (bodyLines.length * bodyLineHeight) + 8);
    ctx.save();
    ctx.beginPath();
    ctx.rect(textClipX, textClipY, textClipW, textClipH);
    ctx.clip();
    bodyLines.forEach((line, idx) => {
        ctx.fillText(line, x + padX, y + padY + 31 + (idx * bodyLineHeight));
    });
    ctx.restore();
    ctx.restore();
    return y + cardHeight + 10;
}

async function buildWeatherWiseFramedPoster(captureDataUrl, warning) {
    const captureImage = await new Promise((resolve) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => resolve(null);
        image.src = captureDataUrl;
    });
    if (!captureImage) return captureDataUrl;

    const props = (warning && warning.properties) || {};
    const eventName = String(getDisplayEventName(props.event, props) || props.event || 'Weather Warning').toUpperCase();
    const eventUpper = eventName.toUpperCase();
    const isSevereTStorm = eventUpper === 'SEVERE THUNDERSTORM WARNING';
    const isTornadoFamily = eventUpper === 'TORNADO WARNING' || eventUpper === 'PDS TORNADO WARNING' || eventUpper === 'TORNADO EMERGENCY';
    const warningCardColor = String(props._color || getEventColor(eventName) || '').trim();
    const headerColor = warningCardColor || wwPosterHeaderColor(eventName);
    const hailRaw = wwPosterParam(props, ['maxHailSize', 'MAXHAILSIZE']);
    const windRaw = wwPosterParam(props, ['maxWindGust', 'MAXWINDGUST']);
    const hailText = hailRaw ? `${hailRaw.replace(/\s*IN\s*$/i, '')} IN` : 'N/A';
    const windText = windRaw ? `${windRaw.replace(/\s*MPH\s*$/i, '')} MPH` : 'N/A';
    const validText = wwPosterFormatDate(props.expires);
    const areaText = wwPosterBuildAreaText(props.areaDesc);
    const motionText = wwPosterClamp(wwPosterStormMotionText(props), 90);
    const hazardText = wwPosterClamp(getWarningCardHazardText(props, eventName) || 'N/A', 170);
    const sourceText = wwPosterClamp(getSourceText(props) || 'NWS REPORT', 120);

    const issuedRaw = props.sent || props.issued || props.effective || '';
    const chipTime = wwPosterFormatChipTime(issuedRaw);
    const radarSite = wwPosterParam(props, ['radarStation', 'office', 'WFO']) || 'NWS';
    const radarCode = String(radarSite).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4) || 'NWS';

    const width = 1600;
    const height = 900;
    const headerHeight = 108;
    const topStripHeight = 42;
    const rightWidth = 610;
    const mapWidth = width - rightWidth;
    const mapHeight = height - headerHeight - topStripHeight;
    const rightX = mapWidth;
    const mapY = headerHeight + topStripHeight;

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return captureDataUrl;

    ctx.fillStyle = '#07090d';
    ctx.fillRect(0, 0, width, height);

    // Header banner
    ctx.fillStyle = headerColor;
    ctx.fillRect(0, 0, width, headerHeight);
    wwPosterDrawStormIcon(ctx, 24, 28, 42);
    ctx.fillStyle = '#ffffff';
    ctx.shadowColor = 'rgba(0,0,0,0.34)';
    ctx.shadowBlur = 8;
    let titleFont = 62;
    while (titleFont > 38) {
        ctx.font = `700 ${titleFont}px "Segoe UI", Tahoma, sans-serif`;
        if (ctx.measureText(eventName).width <= width - 130) break;
        titleFont -= 2;
    }
    ctx.fillText(eventName, 84, 72);
    ctx.shadowBlur = 0;

    // Top black strip
    ctx.fillStyle = '#0b0d12';
    ctx.fillRect(0, headerHeight, width, topStripHeight);

    // Map + right panel backgrounds
    ctx.fillStyle = '#0d1016';
    ctx.fillRect(0, mapY, mapWidth, mapHeight);
    const topCropPx = Math.min(140, Math.max(60, Math.floor((captureImage.naturalHeight || captureImage.height || 900) * 0.12)));
    wwPosterDrawImageCover(ctx, captureImage, 0, mapY, mapWidth, mapHeight, { topCropPx });
    ctx.fillStyle = 'rgba(0,0,0,0.1)';
    ctx.fillRect(0, mapY, mapWidth, mapHeight);
    ctx.fillStyle = '#090d16';
    ctx.fillRect(rightX, mapY, rightWidth, mapHeight);

    // Right panel separator
    ctx.strokeStyle = 'rgba(255,255,255,0.10)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(rightX, headerHeight);
    ctx.lineTo(rightX, height);
    ctx.stroke();

    // Top strip chips on map side
    const chips = [radarCode, 'Reflectivity', chipTime || 'LIVE', '0.5°'];
    let chipX = 12;
    const chipY = headerHeight + 6;
    chips.forEach((chip) => {
        ctx.font = '600 15px "Segoe UI", Tahoma, sans-serif';
        const chipW = Math.ceil(ctx.measureText(chip).width) + 24;
        wwPosterDrawRoundedRect(ctx, chipX, chipY, chipW, 30, 4);
        ctx.fillStyle = '#222733';
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.16)';
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.fillStyle = '#f4f7ff';
        ctx.fillText(chip, chipX + 12, chipY + 20);
        chipX += chipW + 8;
    });

    // Right strip title
    ctx.fillStyle = '#f2f5fb';
    ctx.font = '700 22px "Segoe UI", Tahoma, sans-serif';
    ctx.fillText('Warning Details', rightX + 16, headerHeight + 28);
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.beginPath();
    ctx.moveTo(rightX + 12, headerHeight + topStripHeight - 1);
    ctx.lineTo(width - 12, headerHeight + topStripHeight - 1);
    ctx.stroke();

    let y = mapY + 10;
    const cardWidth = rightWidth - 24;
    y = wwPosterDrawInfoCard(ctx, {
        x: rightX + 12,
        y,
        width: cardWidth,
        label: 'Valid Until',
        value: validText,
        labelColor: '#ff4d5f',
        bgColor: '#252a35',
        borderColor: 'rgba(255,92,110,0.46)',
        maxLines: 6
    });
    y = wwPosterDrawInfoCard(ctx, {
        x: rightX + 12,
        y,
        width: cardWidth,
        label: 'Affected Area',
        value: areaText,
        labelColor: '#ff4d5f',
        bgColor: '#252a35',
        borderColor: 'rgba(255,92,110,0.46)',
        maxLines: 2
    });

    const threatCards = [];
    if ((isSevereTStorm || isTornadoFamily) && hailText !== 'N/A') {
        threatCards.push({ label: 'Max Hail Size', value: hailText, maxLines: 1, bgColor: 'rgba(75, 15, 25, 0.72)', borderColor: 'rgba(255,80,95,0.45)' });
    }
    if (isSevereTStorm && windText !== 'N/A') {
        threatCards.push({ label: 'Max Wind Gust', value: windText, maxLines: 1, bgColor: 'rgba(75, 15, 25, 0.72)', borderColor: 'rgba(255,80,95,0.45)' });
    }
    if (motionText !== 'N/A') threatCards.push({ label: 'Storm Motion', value: motionText, maxLines: 2 });
    if (hazardText !== 'N/A') threatCards.push({ label: 'Hazard', value: hazardText, maxLines: 2 });
    if (sourceText !== 'N/A') threatCards.push({ label: 'Source', value: sourceText, maxLines: 1 });

    const panelBottomY = mapY + mapHeight - 10;
    const estimateCardHeight = (lines) => (8 * 2) + 16 + (Math.max(1, lines) * 24) + 10;
    const threatHeaderNeeded = threatCards.length > 0;
    if (threatHeaderNeeded && (y + 34) < panelBottomY) {
        ctx.fillStyle = '#f2f5fb';
        ctx.font = '700 21px "Segoe UI", Tahoma, sans-serif';
        ctx.fillText('Threat Information', rightX + 16, y + 22);
        y += 32;

        threatCards.forEach((card) => {
            const est = estimateCardHeight(card.maxLines || 2);
            if ((y + est) > panelBottomY) return;
            y = wwPosterDrawInfoCard(ctx, {
                x: rightX + 12,
                y,
                width: cardWidth,
                label: card.label,
                value: card.value,
                maxLines: card.maxLines || 2,
                bgColor: card.bgColor || '#1f2430',
                borderColor: card.borderColor || 'rgba(255,255,255,0.12)'
            });
        });
    }

    ctx.fillStyle = 'rgba(255,255,255,0.68)';
    ctx.font = '600 15px "Segoe UI", Tahoma, sans-serif';
    ctx.fillText(`Generated ${new Date().toLocaleString()}`, 16, height - 10);

    return canvas.toDataURL('image/png');
}

function openWeatherWiseCapturePreview(dataUrl, warning) {
    const filename = buildWeatherWiseCaptureFilename(warning);
    const win = window.open('', '_blank');
    if (!win) return;

    win.document.write(
        '<!doctype html><html><head><title>WeatherWise Screenshot</title></head>' +
        '<body style="margin:0;background:#080b12;color:#fff;font-family:Segoe UI,Tahoma,sans-serif;display:flex;flex-direction:column;align-items:center;gap:12px;min-height:100vh;padding:16px;box-sizing:border-box;">' +
        `<img alt="WeatherWise screenshot" src="${dataUrl}" style="max-width:100%;max-height:calc(100vh - 130px);display:block;border:1px solid rgba(255,255,255,0.18);" />` +
        '<div style="display:flex;gap:8px;align-items:center;justify-content:center;flex-wrap:wrap;">' +
        `<a href="${dataUrl}" download="${filename}" style="background:#1f2937;color:#fff;text-decoration:none;border:1px solid rgba(255,255,255,0.22);border-radius:8px;padding:8px 12px;font-weight:600;">Download PNG</a>` +
        '</div>' +
        '<div style="opacity:.82;font-size:14px;">Captured from your selected WeatherWise tab.</div>' +
        '</body></html>'
    );
    try { win.document.close(); } catch {}
}

function focusExistingWeatherWisePopout() {
    try {
        if (weatherWisePopupRef && !weatherWisePopupRef.closed) {
            try { weatherWisePopupRef.focus(); } catch {}
            return true;
        }
    } catch {}
    return false;
}

async function createWeatherWiseScreenshot(warning, targetLink, options = {}) {
    const navigateToTarget = options.navigateToTarget !== false;
    if (navigateToTarget) {
        openWeatherWisePopout(targetLink);
    } else {
        focusExistingWeatherWisePopout();
    }

    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getDisplayMedia !== 'function') {
        const fallbackText = navigateToTarget
            ? 'Automatic WeatherWise capture is not supported in this browser. WeatherWise was opened so you can take a manual screenshot.'
            : 'Automatic WeatherWise capture is not supported in this browser. Select your WeatherWise tab and take a manual screenshot.';
        alert(fallbackText);
        return;
    }

    let stream = null;
    try {
        stream = await navigator.mediaDevices.getDisplayMedia({
            video: {
                displaySurface: 'browser',
                frameRate: { ideal: 30, max: 30 }
            },
            audio: false,
            preferCurrentTab: false,
            surfaceSwitching: 'include',
            selfBrowserSurface: 'exclude'
        });
    } catch (err) {
        if (err && (err.name === 'NotAllowedError' || err.name === 'AbortError')) return;
        throw err;
    }

    try {
        const videoTrack = stream.getVideoTracks && stream.getVideoTracks()[0];
        if (!videoTrack) throw new Error('No video track available from display capture.');

        const video = document.createElement('video');
        video.muted = true;
        video.playsInline = true;
        video.srcObject = stream;
        await video.play();
        await sleep(1400);

        const width = Number(video.videoWidth || 0);
        const height = Number(video.videoHeight || 0);
        if (!(width > 0 && height > 0)) throw new Error('Could not read captured frame dimensions.');

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('Could not get canvas context for capture.');
        ctx.drawImage(video, 0, 0, width, height);

        const dataUrl = canvas.toDataURL('image/png');
        let framedDataUrl = dataUrl;
        try {
            framedDataUrl = await buildWeatherWiseFramedPoster(dataUrl, warning);
        } catch {}
        openWeatherWiseCapturePreview(framedDataUrl || dataUrl, warning);
    } finally {
        try { stream.getTracks().forEach((track) => track.stop()); } catch {}
    }
}
let allWarnings = [];
let injectedTestWarnings = [];
let hasInjectedDefaultSuites = false;
const WARNINGS_POLL_MS = 8000;
let warningsPollTimer = null;
let warningsFetchInFlight = false;
let lastWarningsDataSignature = '';
let ryanTopWarningsSignature = '';
const RYAN_FLOAT_STORAGE_KEY = 'ryanFloatStateV1';
let ryanFloatState = {
    visible: false,
    minimized: true,
    maximized: false,
    streamUrl: RYAN_STREAM_EMBED_URL,
    left: null,
    top: null,
    width: 520,
    height: 320,
    restoreLeft: null,
    restoreTop: null,
    restoreWidth: null,
    restoreHeight: null
};
let ryanFloatDrag = null;
let ryanFloatResize = null;
let ryanDefaultStreamResolvePromise = null;
let ryanResolvedDefaultStreamUrl = null;
let lastSearch = '';
let currentSortMode = 'important'; // 'important' | 'recent' | 'severe' | 'saved'
let currentView = 'warnings';
let mapInitialized = false;
const STARTUP_DEFAULT_VIEW = 'warnings';
let startupViewApplied = false;
let notificationQueue = [];
let isShowingNotification = false;
let warningContentTracker = new Map();
let warningDurationTracker = new Map();
let notificationTimer = null; // active popup timer
let currentAlertAudio = null; // active alert audio
let playedAlertSoundFor = new Set(); // prevent duplicate playback per warning id
let pendingAlertSound = null; // queued sound file to play once audio is unlocked
let audioUnlockInitialized = false;
let soundQueue = []; // FIFO queue of { file, vol }
let isPlayingSoundQueue = false;
// Track temporary tray popups shown this fetch cycle to avoid duplicates
let tempTrayShown = new Set();
let severeSeenWarnings = new Set();
let severeTabOpenedAt = null;
// One-time intro animation flag for warnings list
let hasWarningsIntroAnimated = false;

function initAudioUnlock() {
    if (audioUnlockInitialized) return;
    audioUnlockInitialized = true;
    const unlock = async () => {
        try {
            const a = new Audio('RHY_Ding.m4a');
            a.volume = 0.001;
            await a.play().catch(()=>{});
            setTimeout(() => { try { a.pause(); a.src = ''; } catch {} }, 100);
            window.alertAudioUnlocked = true;
            // If a pending alert sound was queued prior to unlock, clear it instead of enqueuing it
            try {
                if (pendingAlertSound) {
                    pendingAlertSound = null;
                }
            } catch {}
        } catch {}
        try { window.removeEventListener('click', unlock, true); } catch {}
        try { window.removeEventListener('keydown', unlock, true); } catch {}
    };
    try { window.addEventListener('click', unlock, true); } catch {}
    try { window.addEventListener('keydown', unlock, true); } catch {}
}

function enqueueAlertSound(file, vol) {
    try { initAudioUnlock(); } catch {}
    const v = Math.max(0, Math.min(1, typeof vol === 'number' ? vol : 0.7));
    const item = { file, vol: v };
    if (!window.alertAudioUnlocked) {
        pendingAlertSound = item;
        return;
    }
    try { soundQueue.push(item); } catch {}
    if (!isPlayingSoundQueue) playNextInQueue();
}

async function playNextInQueue() {
    if (!Array.isArray(soundQueue) || soundQueue.length === 0) {
        isPlayingSoundQueue = false;
        return;
    }
    isPlayingSoundQueue = true;
    const next = soundQueue.shift();
    try {
        if (currentAlertAudio) {
            try { currentAlertAudio.pause(); } catch {}
            try { currentAlertAudio.src = ''; } catch {}
            currentAlertAudio = null;
        }
    } catch {}
    const a = new Audio(next.file);
    currentAlertAudio = a;
    a.volume = next.vol;
    let settled = false;
    const cleanup = () => {
        if (settled) return;
        settled = true;
        try { a.pause(); } catch {}
        try { a.src = ''; } catch {}
        setTimeout(() => { try { playNextInQueue(); } catch {} }, 50);
    };
    try { a.addEventListener('ended', cleanup); } catch {}
    try { a.addEventListener('error', cleanup); } catch {}
    try {
        await a.play();
    } catch {
        cleanup();
        return;
    }
    setTimeout(() => { try { cleanup(); } catch {} }, 30000);
}

// Track previous priority/flags to detect upgrades on updates
let warningPriorityTracker = new Map();
let warningUpgradeFlags = new Map(); // id -> { displayEvent, isDestructiveSevere, isConsiderableFF }
// Track IDs that are newly issued in the current fetch cycle
let newlyIssuedWarnings = new Set();

// Tracks if the tab/card animation has been applied once
let hasAnimatedTab = false;

// Track the last seen expiration time for each warning to detect extensions
let warningExpiresTracker = new Map();

// YouTube video data
let currentVideoId = null;
let isLivestream = false;
let weatherWisePopupRef = null;

// Color mapping for warnings by event name (based on provided palette)
const EVENT_COLOR_MAP = new Map([
    ['TORNADO WARNING', '#ff0000'],
    ['TORNADO EMERGENCY', '#ffffff'],
    ['PDS TORNADO WARNING', '#ff0000'],
    ['SEVERE THUNDERSTORM WARNING', '#ff9430'],
    ['FLASH FLOOD WARNING', '#4dff00'],
    ['FLASH FLOOD EMERGENCY', '#4dff00'],
    ['TORNADO WATCH', '#ff7f78'],
    ['SEVERE THUNDERSTORM WATCH', '#ffb87a'],
    ['FLASH FLOOD WATCH', '#2E8B57'],
    ['SPECIAL WEATHER STATEMENT', '#00ffff'],
    ['BLIZZARD WARNING', '#993d00'],
    ['ICE STORM WARNING', '#42005e'],
    ['WINTER STORM WARNING', '#ff63ef'],
    ['EXTREME COLD WARNING', '#0000FF'],
    ['FREEZE WARNING', '#30008a'],
    ['WINTER STORM WATCH', '#E8E9EB'],
    ['EXTREME COLD WATCH', '#3431FC'],
    ['FREEZE WATCH', '#5823cc'],
    ['WINTER WEATHER ADVISORY', '#7b68ee'],
    ['FROST ADVISORY', '#6495ED'],
    ['RED FLAG WARNING', '#FF1493'],
    ['FIRE WEATHER WATCH', '#ffdead'],
    ['COLD WEATHER ADVISORY', '#AFEEEE'],
    ['WIND ADVISORY', '#D2B48C'],
    ['LAKE WIND ADVISORY', '#D2B48C'],
    ['MARINE WEATHER STATEMENT', '#FFDAB9'],
    ['SNOW SQUALL WARNING', '#FF94D8'],
    ['LAKE EFFECT SNOW WARNING', '#008F8F'],
    ['AVALANCHE WATCH', '#F4A460'],
    ['AVALANCHE WARNING', '#1e90ff'],
    ['AVALANCHE ADVISORY', '#1e90ff'],
    ['AVALANCHE ADVISORIES', '#1e90ff'],
    ['FLOOD WARNING', '#083600'],
    ['FLOOD WATCH', '#061600'],
    ['FLOOD ADVISORY', '#1ab000'],
    ['TSUNAMI WARNING', '#FD6347'],
    ['TSUNAMI WATCH', '#FF7B00'],
    ['TSUNAMI ADVISORY', '#D2691E'],
    ['COASTAL FLOOD WARNING', '#228B22'],
    ['LAKESHORE FLOOD WARNING', '#228B22'],
    ['HIGH SURF WARNING', '#FBFF00'],
    ['COASTAL FLOOD WATCH', '#66CDAA'],
    ['LAKESHORE FLOOD WATCH', '#66CDAA'],
    ['COASTAL FLOOD ADVISORY', '#7CFC00'],
    ['LAKESHORE FLOOD ADVISORY', '#7CFC00'],
    ['HIGH SURF ADVISORY', '#BA55D3'],
    ['RIP CURRENT STATEMENT', '#9F29FF'],
    ['BEACH HAZARDS STATEMENT', '#40E0D0'],
    ['COASTAL FLOOD STATEMENT', '#6B8E23'],
    ['HYDROLOGIC OUTLOOK', '#90EE90'],
    ['DUST STORM WARNING', '#FFE4C4'],
    ['HURRICANE WARNING', '#b000ff'],
    ['HURRICANE WATCH', '#e23aff'],
    ['TROPICAL STORM WARNING', '#a10000'],
    ['TROPICAL STORM WATCH', '#ff6686'],
    ['STORM SURGE WARNING', '#FF4500'],
    ['STORM SURGE WATCH', '#FFA500'],
    ['HURRICANE FORCE WIND WARNING', '#b000ff'],
    ['SPECIAL MARINE WARNING', '#731E56'],
    ['SMALL CRAFT ADVISORY', '#D8BFD8'],
    ['BRISK WIND ADVISORY', '#d8bfd8'],
    ['BRISK WIND ADVISORIES', '#d8bfd8'],
    ['HIGH WIND WARNING', '#DAA520'],
    ['HIGH WIND WATCH', '#B8860B'],
    ['GALE WARNING', '#DDA0DD'],
    ['GALE WATCH', '#FFC0CB'],
    ['HEAVY FREEZING SPRAY WARNING', '#00BFFF'],
    ['STORM WARNING', '#9400D3'],
    ['DENSE FOG ADVISORY', '#708090'],
    ['SHELTER IN PLACE WARNING', '#ffffff'],
    ['EVACUATION IMMEDIATE', '#ffffff'],
    ['CIVIL DANGER WARNING', '#ffffff'],
    ['LAW ENFORCEMENT WARNING', '#ffffff'],
    ['LOCAL AREA EMERGENCY', '#ffffff'],
    ['911 TELEPHONE OUTAGE', '#ffffff']
    ,['CIVIL EMERGENCY MESSAGE', '#ffffff']
    ,['CHILD ABDUCTION EMERGENCY', '#ffffff']
    ,['AIR QUALITY ALERT', '#808080']
]);

// Custom fixed ordering for warnings (top to bottom). Any event not listed goes after.
// The names here should match the output of getDisplayEventName() (UPPERCASE labels).
const CUSTOM_EVENT_ORDER = [
    'TORNADO EMERGENCY',
    'FLASH FLOOD EMERGENCY',
    'CHILD ABDUCTION EMERGENCY',
    'SHELTER IN PLACE WARNING',
    'EVACUATION IMMEDIATE',
    'CIVIL DANGER WARNING',
    'CIVIL EMERGENCY MESSAGE',
    'LAW ENFORCEMENT WARNING',
    'LOCAL AREA EMERGENCY',
    '911 TELEPHONE OUTAGE',
    'TSUNAMI WARNING',
    'TSUNAMI WATCH',
    'PDS TORNADO WARNING',
    'TORNADO WARNING',
    'SEVERE THUNDERSTORM WARNING',
    'FLASH FLOOD WARNING',
    'SNOW SQUALL WARNING',
    'BLIZZARD WARNING',
    'ICE STORM WARNING',
    'WINTER STORM WARNING',
    'DUST STORM WARNING',
    'HURRICANE WARNING',
    'STORM SURGE WARNING',
    'HURRICANE FORCE WIND WARNING',
    'HURRICANE WATCH',
    'STORM SURGE WATCH',
    'TROPICAL STORM WARNING',
    'TROPICAL STORM WATCH',
    'WINTER WEATHER ADVISORY',
    'EXTREME COLD WARNING',
    'FLOOD WARNING',
    'FLOOD ADVISORY',
    'FREEZE WARNING',
    'RED FLAG WARNING',
    'HIGH WIND WARNING',
    'TORNADO WATCH',
    'SEVERE THUNDERSTORM WATCH',
    'FLASH FLOOD WATCH',
    'WINTER STORM WATCH',
    'EXTREME COLD WATCH',
    'FREEZE WATCH',
    'FLOOD WATCH',
    'SPECIAL WEATHER STATEMENT',
    'AIR QUALITY ALERT',
];

function getEventColor(eventNameRaw) {
    if (!eventNameRaw) return null;
    const key = String(eventNameRaw).trim().toUpperCase();
    // Only apply colors for explicitly mapped events; otherwise return null to keep default styling
    return EVENT_COLOR_MAP.has(key) ? EVENT_COLOR_MAP.get(key) : null;
}

// Simple HTML escape to safely render text content
function escapeHtml(str) {
    return String(str || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function truncateWithEllipsis(text, maxLength = 44) {
    const value = String(text || '').trim();
    if (!value) return 'N/A';
    if (value.length <= maxLength) return value;
    return value.slice(0, Math.max(0, maxLength - 3)).trimEnd() + '...';
}


// Focus the embedded map on a given warning's geometry (by id) with retry until map and geometry are ready
function focusWarningOnMap(alertOrId) {
    try {
        const id = typeof alertOrId === 'string' ? alertOrId : (alertOrId && alertOrId.id);
        if (!id) return;
        try {
            mapHudSelectedWarningId = String(id);
            if (typeof updateMapBroadcastHud === 'function') updateMapBroadcastHud();
        } catch {}
        // Switch to map view first
        if (currentView !== 'map') switchView('map');
        let attempts = 0;
        const maxAttempts = 80; // up to ~4s total
        const stepMs = 50;
        const tryFocus = () => {
            attempts++;
            const mapReady = !!(window.map) && typeof window.zoomToWarningGeometry === 'function';
            const geom = (typeof window.getWarningGeometryById === 'function') ? window.getWarningGeometryById(id) : null;
            if (mapReady && geom) {
                try { window.zoomToWarningGeometry(geom, { padding: 110, maxZoom: 12 }); } catch {}
                return;
            }
            if (attempts < maxAttempts) setTimeout(tryFocus, stepMs);
        };
        // a couple of initial kicks to catch fast inits
        setTimeout(tryFocus, 0);
    } catch {}
}

// Compute and apply an explicit height for the embedded map on the main page
function sizeEmbeddedMap() {
    const el = document.getElementById('weather-map');
    if (!el) return;
    const parent = el.closest('.embedded-weather-map') || el.parentElement;

    const header = document.querySelector('.main-header');
    const headerH = header ? header.getBoundingClientRect().height : 0;
    const mapHeader = document.querySelector('.weather-map-header');
    const mapHeaderH = mapHeader ? mapHeader.getBoundingClientRect().height : 0;
    const extraSpacing = 32;

    let available = window.innerHeight - headerH - mapHeaderH - extraSpacing;
    if (!Number.isFinite(available)) available = window.innerHeight;
    available = Math.max(available, 0);

    const fallbackHeight = 300;
    const target = available > 0 ? available : fallbackHeight;

    if (parent) {
        parent.style.width = '100%';
        parent.style.height = `${target}px`;
        parent.style.maxWidth = 'none';
        parent.style.margin = '0 auto';
        parent.style.display = 'block';
    }
    el.style.width = '100%';
    el.style.height = `${target}px`;

    try {
        if (window.map && typeof window.map.resize === 'function') {
            window.map.resize();
        }
    } catch {}
}

// Format a duration in minutes as "Xd Yh Zm" (only showing non-zero units)
function formatDurationMinutes(totalMinutes) {
    const mins = Math.max(0, Math.floor(totalMinutes));
    const days = Math.floor(mins / (60 * 24));
    const hours = Math.floor((mins % (60 * 24)) / 60);
    const minutes = mins % 60;
    const parts = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0) parts.push(`${hours}h`);
    // Always show minutes to avoid empty output
    parts.push(`${minutes}m`);
    return parts.join(' ');
}

// Format a duration in minutes as compact uppercase like "1D2H3M"
function formatDurationCompact(totalMinutes) {
    const mins = Math.max(0, Math.floor(totalMinutes));
    const days = Math.floor(mins / 1440);
    const hours = Math.floor((mins % 1440) / 60);
    const minutes = mins % 60;
    let out = '';
    if (days > 0) out += `${days}d\u00A0\u00A0`;
    if (hours > 0 || days > 0) out += `${hours}h\u00A0\u00A0`;
    out += `${minutes}m\u00A0\u00A0`;
    return out;
}

// Compact tray label format like "16H 33M" or "1D 2H 5M"
function formatTrayDuration(totalMinutes) {
    const mins = Math.max(0, Math.floor(totalMinutes));
    const days = Math.floor(mins / 1440);
    const hours = Math.floor((mins % 1440) / 60);
    const minutes = mins % 60;
    const parts = [];
    if (days > 0) parts.push(`${days}D`);
    if (hours > 0 || days > 0) parts.push(`${hours}H`);
    parts.push(`${minutes}M`);
    return parts.join(' ');
}

// Live updater: refresh time labels and progress bars on rendered cards
let cardTimeInterval = null;
function updateCardTimes() {
    try {
        const cards = document.querySelectorAll('.warning-card .time-progress');
        const now = new Date();
        cards.forEach(tp => {
            const sentISO = tp.getAttribute('data-sent');
            const expISO = tp.getAttribute('data-exp');
            if (!sentISO || !expISO) return;
            const sentDate = new Date(sentISO);
            const expDate = new Date(expISO);
            const totalMs = Math.max(0, expDate - sentDate);
            const remainMs = Math.max(0, expDate - now);
            const totalMin = Math.round(totalMs / 60000);
            const remainMin = Math.round(remainMs / 60000);
            const pct = totalMs > 0 ? Math.max(0, Math.min(100, (remainMs / totalMs) * 100)) : 0;

            const remainEl = tp.querySelector('.remain');
            const totalEl = tp.querySelector('.total');
            const barEl = tp.querySelector('.progress-bar');
            if (remainEl) remainEl.textContent = `${formatDurationCompact(remainMin)} REMAINING`;
            if (totalEl) totalEl.textContent = `${formatDurationCompact(totalMin)} TOTAL`;
            if (barEl) barEl.style.width = pct + '%';
        });
        // Also refresh ISSUED minutes badges on cards
        document.querySelectorAll('.warning-card .issued-minutes').forEach(el => {
            try {
                const ts = el.getAttribute('data-sent') || el.dataset.sent || '';
                if (!ts) return;
                const t = new Date(ts).getTime();
                if (!isFinite(t)) return;
                const diffMin = Math.max(0, Math.round((now.getTime() - t) / 60000));
                el.textContent = `${diffMin} MIN`;
            } catch {}
        });
        // Refresh centered ISSUED inline label above progress bar
        document.querySelectorAll('.warning-card .issued-inline').forEach(el => {
            try {
                const ts = el.getAttribute('data-sent') || el.dataset.sent || '';
                if (!ts) return;
                const t = new Date(ts).getTime();
                if (!isFinite(t)) return;
                const diffMin = Math.max(0, Math.round((now.getTime() - t) / 60000));
                el.textContent = `${formatDurationCompact(diffMin)} ISSUED`;
            } catch {}
        });
    } catch {}
}

// Helpers for Saved tab
function getSavedWarningsMap() {
    try {
        return JSON.parse(localStorage.getItem('savedWarnings') || '{}') || {};
    } catch {
        return {};
    }
}

function getSavedWarningsArray() {
    const map = getSavedWarningsMap();
    return Object.values(map);
}

function isWarningSaved(warningId) {
    const map = getSavedWarningsMap();
    return !!map[warningId];
}

// Centralized renderer honoring currentSortMode
function renderCurrentList() {
    let source = [];
    // Use the same layout for Saved and normal lists
    if (currentSortMode === 'saved') {
        source = getSavedWarningsArray();
        // When in Saved, keep sort by most recent savedAt (fallback to issued)
        source.sort((a, b) => {
            const aT = new Date(a.savedAt || a.properties?.issued || 0);
            const bT = new Date(b.savedAt || b.properties?.issued || 0);
            return bT - aT;
        });
    } else if (currentSortMode === 'recent') {
        source = sortWarningsByRecent([...(allWarnings || [])]);
    } else if (currentSortMode === 'severe') {
        // New Severe Warnings: mirror the Active Alerts tray scope but render as full warning cards.
        // Includes all active severe warnings.
        const severeSet = new Set([
            'TORNADO EMERGENCY',
            'FLASH FLOOD EMERGENCY',
            'TORNADO WARNING',
            'SEVERE THUNDERSTORM WARNING',
            'FLASH FLOOD WARNING'
        ]);
        source = filterActiveWarnings([...(allWarnings || [])]).filter(w => {
            try {
                const name = String(getDisplayEventName(w.properties?.event, w.properties || {}) || '').toUpperCase();
                if (name.includes('EMERGENCY')) return true;
                return severeSet.has(name);
            } catch {
                return false;
            }
        });

        try {
            // Test warning removed
        } catch {}

        // Use importance sort so these boxes look/behave like the Most Important list ordering
        source = sortWarningsByImportance(source);
    } else {
        // important (default): live warnings only
        source = [...(allWarnings || [])];
    }
    try { syncActiveAlertsTrayVisibility(); } catch {}
    renderWarnings(source);
}

function syncActiveAlertsTrayVisibility() {
    try {
        const tray = document.getElementById('warning-tray');
        if (!tray) return;
        // Keep tray visible on warnings view, even with zero cards.
        const isWarningsView = currentView !== 'map' && currentView !== 'ryan-live';
        if (isWarningsView) {
            try { if (typeof positionWarningTray === 'function') positionWarningTray(); } catch {}
            tray.style.display = 'block';
            tray.classList.add('open');
        }
        try { syncTrayLayoutState(); } catch {}
    } catch {}
}

function hexToRgba(hex, alpha = 0.18) {
    if (!hex) return null;
    const h = hex.replace('#', '');
    if (h.length !== 6) return null;
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// Helper: merge arrays of features uniquely by id
function mergeById(base = [], extras = []) {
    const map = new Map(base.map(f => [f.id, f]));
    for (const f of extras) {
        if (f && f.id && !map.has(f.id)) map.set(f.id, f);
    }
    return Array.from(map.values());
}

function isTestWarningFeature(warning) {
    try {
        const id = String(warning?.id || '');
        const p = warning?.properties || {};
        const msgType = String(p.messageType || '');
        return id.startsWith('TEST-') || msgType.toUpperCase() === 'TEST' || p.__isSuiteTest === true;
    } catch {
        return false;
    }
}

function getActiveInjectedTestWarnings() {
    try {
        const now = Date.now();
        injectedTestWarnings = (injectedTestWarnings || []).filter(w => {
            const exp = new Date(w?.properties?.expires || 0).getTime();
            return Number.isFinite(exp) && exp > now;
        });
        return injectedTestWarnings;
    } catch {
        return [];
    }
}

function formatNumberCompact(n) {
    if (n == null || isNaN(n)) return '';
    if (n >= 1_000_000) return Math.round(n / 100_000) / 10 + 'M';
    if (n >= 1_000) return Math.round(n / 100) / 10 + 'K';
    return String(n);
}

function getPeopleAffected(props) {
    // Try a few common parameter names; otherwise return null
    const p = props.parameters || {};
    const candidates = [
        p.POPULATION, p.population, p.PEOPLE, p.people, p.AFFECTED, p.affected
    ];
    for (const c of candidates) {
        const num = parsePositiveAlertMetric(c);
        if (num != null) return num;
    }
    return null;
}

function parsePositiveAlertMetric(value) {
    const raw = Array.isArray(value) ? value[0] : value;
    const num = Number(String(raw ?? '').replace(/[^0-9.]/g, ''));
    return Number.isFinite(num) && num > 0 ? num : null;
}

function getHomesAffected(props) {
    const p = props.parameters || {};
    const candidates = [
        p.HOUSEHOLDS, p.households,
        p.HOMES, p.homes,
        p.AFFECTED_HOMES, p.affectedHomes
    ];
    for (const c of candidates) {
        const num = parsePositiveAlertMetric(c);
        if (num != null) return num;
    }
    return null;
}

const IMPACT_HOUSEHOLD_SIZE = 2.6;
const countyPopulationCacheByState = new Map();

function computeEstimatedHomes(population) {
    const value = Number(population);
    if (!Number.isFinite(value) || value <= 0) return null;
    return Math.max(1, Math.round(value / IMPACT_HOUSEHOLD_SIZE));
}

function formatImpactMetric(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) return '--';
    return Math.round(n).toLocaleString();
}

function getCountyFipsListFromWarning(props) {
    const sameCodes = Array.isArray(props?.geocode?.SAME) ? props.geocode.SAME : [];
    const countyFips = new Set();
    sameCodes.forEach((code) => {
        const digits = String(code || '').replace(/\D/g, '');
        if (digits.length !== 6) return;
        const state = digits.slice(1, 3);
        const county = digits.slice(3, 6);
        if (state === '00' || county === '000') return;
        if (!/^\d{2}$/.test(state) || !/^\d{3}$/.test(county)) return;
        countyFips.add(`${state}${county}`);
    });
    return Array.from(countyFips);
}

async function fetchCountyPopulationForState(stateFips) {
    const key = String(stateFips || '').padStart(2, '0');
    if (!/^\d{2}$/.test(key)) return new Map();
    if (countyPopulationCacheByState.has(key)) {
        return countyPopulationCacheByState.get(key);
    }

    const request = (async () => {
        const url = `https://api.census.gov/data/2023/acs/acs5?get=NAME,B01003_001E&for=county:*&in=state:${key}`;
        const resp = await fetch(url, { headers: { Accept: 'application/json' } });
        if (!resp.ok) throw new Error(`census request failed (${resp.status})`);
        const rows = await resp.json();
        const map = new Map();
        if (!Array.isArray(rows) || rows.length <= 1) return map;
        for (let i = 1; i < rows.length; i += 1) {
            const row = rows[i];
            if (!Array.isArray(row) || row.length < 4) continue;
            const [name, popRaw, state, county] = row;
            const pop = Number(popRaw);
            if (!Number.isFinite(pop) || pop < 0) continue;
            const fips = `${String(state || '').padStart(2, '0')}${String(county || '').padStart(3, '0')}`;
            map.set(fips, {
                name: String(name || ''),
                population: Math.round(pop)
            });
        }
        return map;
    })();

    countyPopulationCacheByState.set(key, request);
    try {
        return await request;
    } catch (err) {
        countyPopulationCacheByState.delete(key);
        throw err;
    }
}

async function fetchPopulationFromCountyFipsList(countyFipsList) {
    const unique = Array.from(new Set((Array.isArray(countyFipsList) ? countyFipsList : [])
        .map((code) => String(code || '').replace(/\D/g, ''))
        .filter((code) => /^\d{5}$/.test(code))));
    if (!unique.length) {
        return {
            totalPopulation: null,
            requestedCountyCount: 0,
            matchedCountyCount: 0
        };
    }

    const byState = new Map();
    unique.forEach((fips) => {
        const state = fips.slice(0, 2);
        if (!byState.has(state)) byState.set(state, []);
        byState.get(state).push(fips);
    });

    let totalPopulation = 0;
    let matchedCountyCount = 0;

    const stateEntries = Array.from(byState.entries());
    await Promise.all(stateEntries.map(async ([state, fipsList]) => {
        const countyMap = await fetchCountyPopulationForState(state);
        fipsList.forEach((fips) => {
            const rec = countyMap.get(fips);
            if (!rec) return;
            const pop = Number(rec.population);
            if (!Number.isFinite(pop) || pop < 0) return;
            totalPopulation += pop;
            matchedCountyCount += 1;
        });
    }));

    return {
        totalPopulation: matchedCountyCount > 0 ? totalPopulation : null,
        requestedCountyCount: unique.length,
        matchedCountyCount
    };
}

function updateImpactPopulationMetricsUI(container, data) {
    if (!container) return;
    const populationText = formatImpactMetric(data?.totalPopulation);
    const homesText = formatImpactMetric(data?.totalHomes);
    const sourceText = String(data?.populationSourceText || 'Population data unavailable.');

    container.querySelectorAll('[data-impact-population]').forEach((el) => {
        el.textContent = populationText;
    });
    container.querySelectorAll('[data-impact-homes]').forEach((el) => {
        el.textContent = homesText;
    });
    container.querySelectorAll('[data-impact-pop-source]').forEach((el) => {
        el.textContent = sourceText;
    });
}

async function hydrateImpactPopulationMetrics(container, props, impactData) {
    if (!container || !impactData || impactData.populationSource !== 'pending-census') return;
    if (!container.isConnected) return;

    updateImpactPopulationMetricsUI(container, {
        totalPopulation: impactData.totalPopulation,
        totalHomes: impactData.totalHomes,
        populationSourceText: 'Loading county population from U.S. Census data...'
    });

    try {
        const countyFipsList = Array.isArray(impactData.countyFipsList) ? impactData.countyFipsList : getCountyFipsListFromWarning(props);
        if (!countyFipsList.length) {
            updateImpactPopulationMetricsUI(container, {
                totalPopulation: null,
                totalHomes: null,
                populationSourceText: 'Population data unavailable: no county geocodes were provided in this alert.'
            });
            return;
        }

        const result = await fetchPopulationFromCountyFipsList(countyFipsList);
        if (!container.isConnected) return;

        const pop = Number(result?.totalPopulation);
        if (!Number.isFinite(pop) || pop <= 0) {
            updateImpactPopulationMetricsUI(container, {
                totalPopulation: null,
                totalHomes: null,
                populationSourceText: 'Population data unavailable from county lookup.'
            });
            return;
        }

        const homes = computeEstimatedHomes(pop);
        const sourceText = `Source: U.S. Census ACS 2023 county population (${result.matchedCountyCount}/${result.requestedCountyCount} counties matched). Homes are estimated using 2.6 people per household.`;
        updateImpactPopulationMetricsUI(container, {
            totalPopulation: pop,
            totalHomes: homes,
            populationSourceText: sourceText
        });
    } catch (err) {
        if (!container.isConnected) return;
        console.warn('Impact population lookup failed:', err);
        updateImpactPopulationMetricsUI(container, {
            totalPopulation: null,
            totalHomes: null,
            populationSourceText: 'Population data lookup failed. Try again in a moment.'
        });
    }
}

// Fetch latest YouTube video or livestream
async function fetchLatestYouTubeVideo() {
    if (!YOUTUBE_API_KEY || YOUTUBE_API_KEY === 'YOUR_YOUTUBE_API_KEY') {
        return null;
    }

    try {
        // First try to check for active livestreams
        const liveResponse = await fetch(`https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${YOUTUBE_CHANNEL_ID}&eventType=live&type=video&key=${YOUTUBE_API_KEY}`);
        const liveData = await liveResponse.json();
        
        if (liveData.items && liveData.items.length > 0) {
            // Found a live stream
            isLivestream = true;
            return {
                videoId: liveData.items[0].id.videoId,
                title: liveData.items[0].snippet.title,
                isLive: true
            };
        }

        // If no active live stream, fetch the most recent completed livestream.
        const completedResponse = await fetch(`https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${YOUTUBE_CHANNEL_ID}&eventType=completed&maxResults=1&order=date&type=video&key=${YOUTUBE_API_KEY}`);
        const completedData = await completedResponse.json();
        if (completedData.items && completedData.items.length > 0) {
            isLivestream = false;
            return {
                videoId: completedData.items[0].id.videoId,
                title: completedData.items[0].snippet.title,
                isLive: false
            };
        }

        // Last fallback: latest uploaded video.
        const uploadsResponse = await fetch(`https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${YOUTUBE_CHANNEL_ID}&maxResults=1&order=date&type=video&key=${YOUTUBE_API_KEY}`);
        const uploadsData = await uploadsResponse.json();
        if (uploadsData.items && uploadsData.items.length > 0) {
            isLivestream = false;
            return {
                videoId: uploadsData.items[0].id.videoId,
                title: uploadsData.items[0].snippet.title,
                isLive: false
            };
        }
    } catch (error) {
        console.error('Error fetching YouTube data:', error);
    }
    
    return null;
}

// Featured video removed

// Helper: fetch active alerts filtered by event name
function fetchAlertsByEvent(eventName) {
    const url = `${API_URL}?event=${encodeURIComponent(eventName)}`;
    return fetch(url, { headers: { 'Accept': 'application/geo+json' } })
        .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then(j => Array.isArray(j?.features) ? j.features : [])
        .catch(() => []);
}

// Visible debug banner to show event totals
function showEventDebugBanner(counts) {
    try {
        let banner = document.getElementById('event-debug-banner');
        if (!banner) {
            banner = document.createElement('div');
            banner.id = 'event-debug-banner';
            banner.style.cssText = 'position:fixed;bottom:0;left:0;right:0;background:rgba(0,0,0,0.7);color:#fff;padding:4px 8px;font:12px/1.4 system-ui;z-index:9999;pointer-events:none;';
            document.body.appendChild(banner);
        }
        const parts = Object.entries(counts).sort((a,b)=>b[1]-a[1]).slice(0,10).map(([k,v])=>`${k}:${v}`);
        banner.textContent = `Active events (top): ${parts.join('  |  ')}`;
    } catch {}
}


function pad(num) {
    return num.toString().padStart(2, '0');
}

function updateTime() {
    const timeEl = document.getElementById('current-time');
    if (!timeEl) return;
    const now = new Date();
    let hours = now.getHours();
    const minutes = pad(now.getMinutes());
    const seconds = pad(now.getSeconds());
    const ampm = hours >= 12 ? 'PM' : 'AM';
    hours = hours % 12;
    if (hours === 0) hours = 12;
    const timeStr = `${hours}:${minutes}:${seconds} ${ampm}`;
    timeEl.textContent = timeStr;
}
setInterval(updateTime, 1000);
updateTime();

function getCardClass(event) {
    if (!event) return '';
    const e = event.toLowerCase();
    if (e.includes('tornado')) return 'tornado';
    if (e.includes('severe thunderstorm')) return 'severe-thunderstorm';
    // Only style warnings (not watches)
    if (e.includes('hurricane warning')) return 'hurricane';
    if (e.includes('tropical storm warning')) return 'tropical-storm';
    if (e.includes('flood')) return 'flood';
    if (e.includes('tsunami')) return 'tsunami';
    return '';
}



function getTimerColor(minutes) {
    if (minutes <= 10) return '';
    if (minutes <= 45) return 'yellow';
    return 'green';
}

function toAllCaps(str) {
    return (str || '').toUpperCase();
}

function stripTestMarkers(str) {
    const s = String(str || '');
    return s
        .replace(/\b(required\s+weekly\s+test)\b/ig, '')
        .replace(/[\[(]\s*test\s*[\])]/ig, '')
        .replace(/\btest\b/ig, '')
        .replace(/\bthis\s+is\s+a\s+test\b/ig, '')
        .replace(/\s{2,}/g, ' ')
        .trim();
}

// Determine if a tropical/hurricane alert pertains to the Atlantic basin
function isAtlanticTropical(props = {}) {
    try {
        const headline = (props.headline || '').toUpperCase();
        const description = (props.description || '').toUpperCase();
        const sender = (props.senderName || '').toUpperCase();
        const vtecArr = (props.parameters && (props.parameters.VTEC || props.parameters.vtec)) || [];
        const vtec = Array.isArray(vtecArr) ? vtecArr.join(' ').toUpperCase() : String(vtecArr || '').toUpperCase();
        const ugc = (props.geocode && (props.geocode.UGC || props.geocode.ugc)) || [];

        // Explicit basin indicators from VTEC
        if (vtec.includes('.AL.')) return true; // Atlantic
        if (vtec.includes('.EP.') || vtec.includes('.CP.')) return false; // Eastern/Central Pacific

        // Sender-based inference
        if (sender.includes('CENTRAL PACIFIC HURRICANE CENTER')) return false; // Pacific
        if (sender.includes('NATIONAL HURRICANE CENTER') || sender.includes('NHC')) return true; // Atlantic

        // 3) Marine/coastal Atlantic zones often start with AM/AN
        if (Array.isArray(ugc) && ugc.some(code => typeof code === 'string' && (code.startsWith('AM') || code.startsWith('AN')))) {
            return true;
        }

        // Text-based hints
        if (headline.includes('PACIFIC') || description.includes('PACIFIC')) return false;
        if (headline.includes('ATLANTIC') || description.includes('ATLANTIC')) return true;
    } catch (e) {
        // Fallback to false if anything unexpected
    }
    return false;
}

function formatAreaWithState(areaDesc) {
    if (!areaDesc) return '';
    
    // Convert to uppercase and trim
    let area = areaDesc.trim().toUpperCase();
    
    // Check if it already has a state abbreviation (2-letter code)
    const stateMatch = area.match(/\b([A-Z]{2})\s*$/);
    if (stateMatch) {
        return area; // Already has state, return as is
    }
    
    // Check if it ends with a comma and state name
    const commaStateMatch = area.match(/,\s*([A-Z]+)\s*$/);
    if (commaStateMatch) {
        const stateName = commaStateMatch[1];
        // Convert state name to abbreviation
        const stateAbbr = getStateAbbreviation(stateName);
        if (stateAbbr) {
            return area.replace(/,\s*[A-Z]+\s*$/, `, ${stateAbbr}`);
        }
    }
    
    // If no state found, try to extract from the area description
    // Look for common patterns like "County, State" or "Area, State"
    const countyStateMatch = area.match(/^(.+?)\s*,\s*([A-Z]+)\s*$/);
    if (countyStateMatch) {
        const county = countyStateMatch[1].trim();
        const stateName = countyStateMatch[2].trim();
        const stateAbbr = getStateAbbreviation(stateName);
        if (stateAbbr) {
            return `${county}, ${stateAbbr}`;
        }
    }
    
    // If we can't determine the state, return the original area
    return area;
}
try { window.formatAreaWithState = formatAreaWithState; } catch {}

function getFormattedAreaEntries(areaDesc, options = {}) {
    const keepCase = options.keepCase === true;
    const dedupe = options.dedupe !== false;
    const raw = String(areaDesc || '');
    if (!raw) return [];

    const entries = raw
        .split(';')
        .map((item) => item.trim())
        .filter(Boolean)
        .map((item) => formatAreaWithState(item))
        .map((item) => keepCase ? item : item.toUpperCase())
        .filter(Boolean);

    if (!dedupe) return entries;

    const seen = new Set();
    const unique = [];
    entries.forEach((entry) => {
        const key = String(entry).toUpperCase();
        if (seen.has(key)) return;
        seen.add(key);
        unique.push(entry);
    });
    return unique;
}

const US_STATE_AND_TERRITORY_CODES = new Set([
    'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA',
    'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD',
    'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ',
    'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC',
    'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
    'DC', 'PR', 'GU', 'VI', 'AS', 'MP'
]);

function getWarningStateCodes(props = {}) {
    const out = [];
    const seen = new Set();
    const addCode = (value) => {
        const code = String(value || '').trim().toUpperCase();
        if (!/^[A-Z]{2}$/.test(code)) return;
        if (!US_STATE_AND_TERRITORY_CODES.has(code)) return;
        if (seen.has(code)) return;
        seen.add(code);
        out.push(code);
    };

    try {
        const areaEntries = getFormattedAreaEntries(props.areaDesc || '', { keepCase: false, dedupe: true });
        areaEntries.forEach((entry) => {
            const match = String(entry || '').match(/,\s*([A-Z]{2})\s*$/);
            if (match && match[1]) addCode(match[1]);
        });
    } catch {}

    try {
        const geocode = props.geocode || {};
        const ugcRaw = geocode.UGC || geocode.ugc || [];
        const ugcList = Array.isArray(ugcRaw) ? ugcRaw : [ugcRaw];
        ugcList.forEach((ugc) => {
            const normalized = String(ugc || '').trim().toUpperCase();
            const match = normalized.match(/^([A-Z]{2})[CZ]\d{3}/);
            if (match && match[1]) addCode(match[1]);
        });
    } catch {}

    try {
        const raw = String(props.areaDesc || '').toUpperCase();
        const commaMatches = raw.match(/,\s*([A-Z]{2})(?=\s*(?:;|$))/g) || [];
        commaMatches.forEach((chunk) => {
            const match = chunk.match(/([A-Z]{2})/);
            if (match && match[1]) addCode(match[1]);
        });
    } catch {}

    return out;
}

function getStateAbbreviation(stateName) {
    const stateMap = {
        'ALABAMA': 'AL', 'ALASKA': 'AK', 'ARIZONA': 'AZ', 'ARKANSAS': 'AR', 'CALIFORNIA': 'CA',
        'COLORADO': 'CO', 'CONNECTICUT': 'CT', 'DELAWARE': 'DE', 'FLORIDA': 'FL', 'GEORGIA': 'GA',
        'HAWAII': 'HI', 'IDAHO': 'ID', 'ILLINOIS': 'IL', 'INDIANA': 'IN', 'IOWA': 'IA',
        'KANSAS': 'KS', 'KENTUCKY': 'KY', 'LOUISIANA': 'LA', 'MAINE': 'ME', 'MARYLAND': 'MD',
        'MASSACHUSETTS': 'MA', 'MICHIGAN': 'MI', 'MINNESOTA': 'MN', 'MISSISSIPPI': 'MS', 'MISSOURI': 'MO',
        'MONTANA': 'MT', 'NEBRASKA': 'NE', 'NEVADA': 'NV', 'NEW HAMPSHIRE': 'NH', 'NEW JERSEY': 'NJ',
        'NEW MEXICO': 'NM', 'NEW YORK': 'NY', 'NORTH CAROLINA': 'NC', 'NORTH DAKOTA': 'ND', 'OHIO': 'OH',
        'OKLAHOMA': 'OK', 'OREGON': 'OR', 'PENNSYLVANIA': 'PA', 'RHODE ISLAND': 'RI', 'SOUTH CAROLINA': 'SC',
        'SOUTH DAKOTA': 'SD', 'TENNESSEE': 'TN', 'TEXAS': 'TX', 'UTAH': 'UT', 'VERMONT': 'VT',
        'VIRGINIA': 'VA', 'WASHINGTON': 'WA', 'WEST VIRGINIA': 'WV', 'WISCONSIN': 'WI', 'WYOMING': 'WY',
        // Territories
        'DISTRICT OF COLUMBIA': 'DC', 'PUERTO RICO': 'PR', 'GUAM': 'GU', 'VIRGIN ISLANDS': 'VI',
        'AMERICAN SAMOA': 'AS', 'NORTHERN MARIANA ISLANDS': 'MP'
    };
    
    return stateMap[stateName] || null;
}

function extractLargestNumber(str) {
    if (!str) return 0;
    const matches = str.match(/([0-9]*\.?[0-9]+)/g);
    if (!matches) return 0;
    return Math.max(...matches.map(Number));
}

function getDisplayEventName(event, props) {
    const rawEvent = (event || '');
    const e = stripTestMarkers(rawEvent).toUpperCase();
    const headline = stripTestMarkers(props.headline || '').toUpperCase();
    const description = stripTestMarkers(props.description || '').toUpperCase();

    // Only treat as emergency if event or headline/description contains the exact phrase
    if (
        e === 'TORNADO EMERGENCY' ||
        headline.includes('TORNADO EMERGENCY') ||
        description.includes('TORNADO EMERGENCY')
    ) {
        return 'TORNADO EMERGENCY';
    }
    
    // Check for PDS Tornado Warning
    if (
        e === 'TORNADO WARNING' &&
        (headline.includes('PDS') || headline.includes('PARTICULARLY DANGEROUS SITUATION') ||
         description.includes('PDS') || description.includes('PARTICULARLY DANGEROUS SITUATION'))
    ) {
        return 'PDS TORNADO WARNING';
    }
    if (
        e === 'FLASH FLOOD EMERGENCY' ||
        headline.includes('FLASH FLOOD EMERGENCY') ||
        description.includes('FLASH FLOOD EMERGENCY')
    ) {
        return 'FLASH FLOOD EMERGENCY';
    }
    if (
        e === 'CHILD ABDUCTION EMERGENCY' ||
        headline.includes('CHILD ABDUCTION EMERGENCY') ||
        description.includes('CHILD ABDUCTION EMERGENCY') ||
        e === 'AMBER ALERT' ||
        headline.includes('AMBER ALERT') ||
        description.includes('AMBER ALERT')
    ) {
        return 'CHILD ABDUCTION EMERGENCY';
    }
    // Normalize tropical/hurricane alerts to canonical labels
    const el = e.trim();
    if (el.includes('STORM SURGE') && el.includes('WARNING')) return 'STORM SURGE WARNING';
    if (el.includes('STORM SURGE') && el.includes('WATCH')) return 'STORM SURGE WATCH';
    if (el.includes('HURRICANE FORCE WIND') && el.includes('WARNING')) return 'HURRICANE FORCE WIND WARNING';
    if (el.includes('HURRICANE') && el.includes('WARNING')) return 'HURRICANE WARNING';
    if (el.includes('HURRICANE') && el.includes('WATCH')) return 'HURRICANE WATCH';
    if (el.includes('TROPICAL STORM') && el.includes('WARNING')) return 'TROPICAL STORM WARNING';
    if (el.includes('TROPICAL STORM') && el.includes('WATCH')) return 'TROPICAL STORM WATCH';
    return el;
}

function getWarningPriority(event, props) {
    // Rank by the explicit custom event order
    const display = getDisplayEventName(event, props); // returns UPPERCASE canonical label
    const idx = CUSTOM_EVENT_ORDER.indexOf(display);
    if (idx !== -1) return idx + 1; // 1-based so smaller = higher priority
    // Not listed -> push after listed ones
    return 1000;
}

function formatTimeAgo(date) {
    const now = new Date();
    const diffMs = now - new Date(date);
    const diffMins = Math.floor(diffMs / 60000);
    if (diffMins < 1) return 'JUST ISSUED';
    if (diffMins === 1) return '1 MIN AGO';
    if (diffMins < 60) return `${diffMins} MINS AGO`;
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours === 1) return '1 HR AGO';
    return `${diffHours} HRS AGO`;
}

function createWarningContentHash(warning) {
    // Create a hash based on key warning properties that would change if the warning is updated
    const props = warning.properties || {};
    const contentString = [
        props.event || '',
        props.headline || '',
        props.description || '',
        props.areaDesc || '',
        props.expires || '',
        props.effective || '',
        props.urgency || '',
        props.severity || '',
        props.certainty || ''
    ].join('|');
    
    // Simple hash function
    let hash = 0;
    for (let i = 0; i < contentString.length; i++) {
        const char = contentString.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash; // Convert to 32-bit integer
    }
    return hash.toString();
}

function checkForNewWarnings(currentWarnings) {
    const currentWarningIds = new Set();
    // Reset newly issued set for this cycle
    newlyIssuedWarnings = new Set();
    // Reset per-cycle temporary tray tracker
    try { tempTrayShown = new Set(); } catch {}
    const newWarningsThisUpdate = [];
    
    currentWarnings.forEach(warning => {
        const id = warning.id;
        currentWarningIds.add(id);

        const props = warning.properties || {};
        const displayEvent = getDisplayEventName(props.event, props);
        const currentPriority = getWarningPriority(props.event, props);
        const currentFlags = {
            displayEvent,
            isDestructiveSevere: (() => { try { return isDestructiveSevere(props); } catch { return false; } })(),
            isConsiderableFF: (() => { try { return isConsiderableFlashFlood(props); } catch { return false; } })()
        };

        // Create a content hash to detect if warning has been updated
        const contentHash = createWarningContentHash(warning);
        const previousContentHash = warningContentTracker.get(id);

        // Check if this is a truly new warning (not in previous set) OR if content has changed
        if (!previousWarnings.has(id)) {
            // This is a newly issued warning
            newWarningsThisUpdate.push(warning);
            newWarnings.add(id);
            newlyIssuedWarnings.add(id);

            // Capture original total duration so we can preserve it on updates
            if (props.sent && props.expires) {
                const sentDate = new Date(props.sent);
                const expDate = new Date(props.expires);
                if (!Number.isNaN(sentDate.getTime()) && !Number.isNaN(expDate.getTime())) {
                    warningDurationTracker.set(id, Math.max(0, expDate - sentDate));
                    // Store initial expires to detect future extensions
                    warningExpiresTracker.set(id, expDate.getTime());
                }
            }

            // Track initial priority/flags
            warningPriorityTracker.set(id, { priority: currentPriority, ...currentFlags });

            // Check if this warning should trigger a notification (new issuance)
            if (shouldShowNotification(warning)) {
                notificationQueue.push(warning);
                // If popups are disabled, still play the alert sound immediately so audio isn't skipped
                try {
                    if (window.notificationPopupsEnabled === false && !playedAlertSoundFor.has(id)) {
                        const displayEventName = getDisplayEventName(props.event, props);
                        if (isEventAllowed(displayEventName, 'sound')) {
                            playAlertSound(props.event, Object.assign({}, props));
                            playedAlertSoundFor.add(id);
                            maybeShowDesktopNotification && maybeShowDesktopNotification(warning);
                        }
                    }
                } catch {}
                // Play sound only if this event type is allowed in settings
                try {
                    const displayEventName = getDisplayEventName(props.event, props);
                    if (!playedAlertSoundFor.has(id) && isEventAllowed(displayEventName, 'sound')) {
                        playAlertSound(props.event, Object.assign({}, props));
                        playedAlertSoundFor.add(id);
                    }
                } catch {}
            } else {
                // Not added to popup menu: only play if allowed in settings
                try {
                    const displayEventName = getDisplayEventName(props.event, props);
                    if (!playedAlertSoundFor.has(id) && isEventAllowed(displayEventName, 'sound')) {
                        playAlertSound(props.event, Object.assign({}, props));
                        playedAlertSoundFor.add(id);
                    }
                } catch {}
                // If popup is enabled in settings for this event, show a temporary tray popup
                try {
                    const displayEventName = getDisplayEventName(props.event, props);
                    if (isEventAllowed(displayEventName, 'popup') && !tempTrayShown.has(id)) {
                        showWarningNotification(warning);
                        tempTrayShown.add(id);
                        // Auto-remove after 10 seconds
                        setTimeout(() => {
                            try {
                                const safeId = String(id || '').replace(/[^A-Za-z0-9_-]+/g, '_');
                                const card = document.getElementById('tray-card-' + safeId);
                                if (card) card.remove();
                                try { updateTrayEmptyState(); } catch {}
                                try { syncTrayLayoutState(); } catch {}
                            } catch {}
                        }, 10000);
                    }
                } catch {}
            }
        } else if (previousContentHash && previousContentHash !== contentHash) {
            // This is an updated warning - only notify if upgraded
            const prev = warningPriorityTracker.get(id);
            let upgraded = false;
            if (prev && typeof prev.priority === 'number') {
                // Higher importance if priority number decreased
                if (currentPriority < prev.priority) upgraded = true;
                // Flag escalations (e.g., destructive severe, considerable FF)
                if (!prev.isDestructiveSevere && currentFlags.isDestructiveSevere) upgraded = true;
                if (!prev.isConsiderableFF && currentFlags.isConsiderableFF) upgraded = true;
                // Watch -> Warning escalation heuristic
                const wasWatch = (prev.displayEvent || '').includes('WATCH');
                const nowWarning = (currentFlags.displayEvent || '').includes('WARNING');
                if (wasWatch && nowWarning) upgraded = true;
            }
            console.log(`Warning ${id} updated. Upgraded=${upgraded}`);

            const storedDuration = warningDurationTracker.get(id);
            const prevExpiresMs = warningExpiresTracker.get(id);
            if (props.expires) {
                const expDate = new Date(props.expires);
                const expMs = expDate.getTime();
                if (!Number.isNaN(expMs)) {
                    // Detect extensions: new expires later than previously seen
                    const isExtended = typeof prevExpiresMs === 'number' && expMs > prevExpiresMs;
                    if (isExtended) {
                        // Update stored duration to reflect the extension using the original sent time when available
                        if (props.sent) {
                            const sentDate = new Date(props.sent);
                            const sentMs = sentDate.getTime();
                            if (!Number.isNaN(sentMs)) {
                                const newDuration = Math.max(0, expMs - sentMs);
                                warningDurationTracker.set(id, newDuration);
                                // Do NOT adjust props.sent on extension; keep original timeline
                            }
                        }
                        // Update last seen expires
                        warningExpiresTracker.set(id, expMs);
                    } else if (storedDuration != null && Number.isFinite(storedDuration)) {
                        // Not extended (content-only update or shortened). Preserve original total duration by adjusting sent.
                        const adjustedSent = new Date(expMs - storedDuration);
                        props.sent = adjustedSent.toISOString();
                        warning.properties = props;
                        // Keep last seen expires in tracker up to date
                        warningExpiresTracker.set(id, expMs);
                    } else if (props.sent) {
                        // Initialize trackers if missing
                        const sentDate = new Date(props.sent);
                        const sentMs = sentDate.getTime();
                        if (!Number.isNaN(sentMs)) {
                            warningDurationTracker.set(id, Math.max(0, expMs - sentMs));
                            warningExpiresTracker.set(id, expMs);
                        }
                    }
                }
            } else if (props.sent && props.expires) {
                const sentDate = new Date(props.sent);
                const expDate = new Date(props.expires);
                if (!Number.isNaN(sentDate.getTime()) && !Number.isNaN(expDate.getTime())) {
                    warningDurationTracker.set(id, Math.max(0, expDate - sentDate));
                    warningExpiresTracker.set(id, expDate.getTime());
                }
            }

            // Refresh/move the card only for allowed event types and when per-event prefs allow popups
            if (shouldShowNotification(warning)) {
                // Add to queue so its card content updates and moves to top
                notificationQueue.push(warning);
                // If upgraded, note it so sound/desktop notification can play
                if (upgraded) {
                    warningUpgradeFlags.set(id, { upgraded: true, displayEvent });
                }
                try {
                    if (window.notificationPopupsEnabled === false && upgraded) {
                        maybeShowDesktopNotification && maybeShowDesktopNotification(warning);
                    }
                } catch {}
            }
        }

        // Update the content tracker
        warningContentTracker.set(id, contentHash);
        // Update the priority tracker for next comparison
        warningPriorityTracker.set(id, { priority: currentPriority, ...currentFlags });
    });
    
    // Clean up tracking for warnings that are no longer active
    for (const [id, contentHash] of warningContentTracker.entries()) {
        if (!currentWarningIds.has(id)) {
            warningContentTracker.delete(id);
            warningDurationTracker.delete(id);
            warningExpiresTracker.delete(id);
            try { playedAlertSoundFor.delete(id); } catch {}
        }
    }
    
    // Update previous warnings for next check
    previousWarnings = currentWarningIds;
    
    // Remove tray cards for expired warnings
    try {
        const tray = document.getElementById('warning-tray');
        if (tray) {
            tray.querySelectorAll('[id^="tray-card-"]').forEach(el => {
                const raw = el.id.replace(/^tray-card-/, '').replace(/_/g, ':');
                // We can't perfectly reverse, so store original id on dataset when creating
                const orig = el.dataset && el.dataset.warningId ? el.dataset.warningId : null;
                const checkId = orig || raw;
                if (!currentWarningIds.has(checkId)) {
                    try { el.remove(); } catch {}
                }
            });
            try { updateTrayEmptyState(); } catch {}
            try { syncTrayLayoutState(); } catch {}
        }
    } catch {}

    // Process notification queue
    processNotificationQueue();
    
    return newWarningsThisUpdate;
}

function shouldShowNotification(warning) {
    const props = warning.properties;
    const event = (props.event || '').toLowerCase();
    const displayEvent = getDisplayEventName(props.event, props);
    const warningId = String(warning?.id || '').toUpperCase();

    // Keep all explicit test alerts in the redesigned right-side tray so test cards
    // behave the same as live cards for layout/styling validation.
    try {
        const msgType = String(props.messageType || '').toLowerCase();
        if (warningId.startsWith('TEST-') || props.__isSuiteTest === true || msgType === 'test') {
            return true;
        }
    } catch {}

    // Keep OBSERVED Flash Flood Warnings in the active alerts tray (right-side column)
    try {
        if (event.includes('flash flood warning') || displayEvent.toLowerCase().includes('flash flood warning')) {
            const src = String(getSourceText(props) || '').toLowerCase();
            const desc = String(props.description || '').toLowerCase();
            const head = String(props.headline || '').toLowerCase();
            const isObserved = src.includes('observed') || desc.includes('observed') || head.includes('observed');
            const isLaw = src.includes('law enforcement') || desc.includes('law enforcement') || head.includes('law enforcement');
            if (isObserved || isLaw) {
                return isEventAllowed(displayEvent, 'popup');
            }
        }
    } catch {}
    
    // Only keep these in the persistent right-side tray:
    // emergencies, tornado/severe thunderstorm watches/warnings, and tsunami types.
    const notificationTypes = [
        'emergency',
        'tornado warning',
        'tornado watch',
        'severe thunderstorm warning',
        'severe thunderstorm watch',
        'tsunami warning',
        'tsunami watch',
        'tsunami advisory'
    ];

    // Check if the warning type matches any of our notification types
    for (const type of notificationTypes) {
        if (event.includes(type) || displayEvent.toLowerCase().includes(type)) {
            // Check per-event popup flag (V2)
            return isEventAllowed(displayEvent, 'popup');
        }
    }
    // Other events: do not include in the scrollable warning tray
    return false;
}

// Helper: check per-event notification preference
function isEventNotificationEnabled(displayEvent) {
    const prefs = window.alertPreferences || {};
    const e = String(displayEvent || '').toUpperCase();
    if (e.includes('EMERGENCY')) return prefs.emergencies !== false;
    if (e === 'TORNADO WARNING') return prefs.tornadoWarning !== false;
    if (e === 'SEVERE THUNDERSTORM WARNING') return prefs.severeThunderstormWarning !== false;
    if (e === 'FLASH FLOOD WARNING') return prefs.flashFloodWarning !== false;
    if (e === 'HURRICANE WARNING') return prefs.hurricaneWarning !== false;
    if (e === 'TROPICAL STORM WARNING') return prefs.tropicalStormWarning !== false;
    if (e === 'HURRICANE WATCH') return prefs.hurricaneWatch !== false;
    if (e === 'TROPICAL STORM WATCH') return prefs.tropicalStormWatch !== false;
    if (e === 'STORM SURGE WARNING') return prefs.stormSurgeWarning !== false;
    if (e === 'STORM SURGE WATCH') return prefs.stormSurgeWatch !== false;
    return true; // default allow for others
}

function openWeatherMap() {
    // Open weather map in a new tab
    const weatherMapUrl = 'weather-map.html';
    window.open(weatherMapUrl, '_blank');
}

function setupViewDropdown() {
    const viewDropdown = document.getElementById('view-dropdown');
    
    // Set default to warnings view
    viewDropdown.value = 'warnings';
    viewDropdown.addEventListener('change', (e) => {
        const selectedView = e.target.value;
        if (selectedView === 'weather-map') {
            // Switch to embedded map instead of opening a new tab
            switchView('map');
            viewDropdown.value = 'warnings'; // keep dropdown consistent
        } else {
            switchView('warnings');
            viewDropdown.value = 'warnings';
        }
    });
}

function setDropdownViewActive(viewType) {
    const mapBtn = document.getElementById('dropdown-map-btn');
    [mapBtn].forEach(btn => { if (btn) btn.classList.remove('active'); });
    if (viewType === 'map' && mapBtn) mapBtn.classList.add('active');
}

function renderRyanLiveTopWarnings() {
    const container = document.getElementById('ryan-live-top-warnings');
    if (!container) return;

    let items = [];
    try {
        items = sortWarningsByImportance(filterActiveWarnings([...(allWarnings || [])])).slice(0, 8);
    } catch {
        items = [ ...(allWarnings || []) ].slice(0, 8);
    }

    if (!items.length) {
        ryanTopWarningsSignature = '';
        container.innerHTML = '<div class="ryan-live-top-warning-empty">No active warnings</div>';
        return;
    }

    const signature = items.map((w) => {
        const p = w?.properties || {};
        return `${w?.id || ''}|${p.expires || ''}|${p.sent || p.issued || ''}`;
    }).join('~');
    if (signature === ryanTopWarningsSignature) return;
    ryanTopWarningsSignature = signature;

    const html = items.map((w) => {
        const p = w?.properties || {};
        const evt = String(getDisplayEventName(p.event, p) || p.event || 'Warning');
        const color = String(getEventColor(evt) || p._color || '#60a5fa');
        const expMin = p.expires ? Math.max(0, Math.round((new Date(p.expires).getTime() - Date.now()) / 60000)) : null;
        const expText = expMin == null ? 'EXPIRES --' : `EXPIRES ${formatDurationCompact(expMin)}`;
        const area = compactHudArea(p.areaDesc || '') || 'Multiple Counties';
        const issuedTs = p.sent || p.issued || p.effective;
        const issuedAgo = issuedTs ? Math.max(0, Math.round((Date.now() - new Date(issuedTs).getTime()) / 60000)) : null;
        const issuedText = issuedAgo == null ? '' : `${formatDurationCompact(issuedAgo)} AGO`;
        return `
            <button class="ryan-live-top-warning-item" type="button" data-warning-id="${escapeHtml(String(w?.id || ''))}" style="--tw-color:${color}">
                <span class="evt">${escapeHtml(evt)}</span>
                <span class="meta"><span>${escapeHtml(expText)}</span><span>${escapeHtml(issuedText)}</span></span>
                <span class="area">${escapeHtml(area)}</span>
            </button>
        `;
    }).join('');

    container.innerHTML = html;
    container.querySelectorAll('.ryan-live-top-warning-item').forEach((btn) => {
        btn.addEventListener('click', () => {
            const id = btn.getAttribute('data-warning-id');
            if (!id) return;
            focusWarningOnMap(id);
        });
    });
}

function openWeatherWisePopout(targetUrl = WEATHERWISE_POPOUT_URL) {
    const safeUrl = String(targetUrl || WEATHERWISE_POPOUT_URL).trim() || WEATHERWISE_POPOUT_URL;
    let opened = null;
    try {
        const screenW = (window.screen && window.screen.availWidth) ? window.screen.availWidth : 1600;
        const screenH = (window.screen && window.screen.availHeight) ? window.screen.availHeight : 900;
        const width = Math.max(1050, Math.round(screenW * 0.78));
        const height = Math.max(720, Math.round(screenH * 0.86));
        const left = Math.max(0, Math.round((screenW - width) / 2));
        const top = Math.max(0, Math.round((screenH - height) / 2));
        const features = `popup=yes,width=${width},height=${height},left=${left},top=${top},resizable=yes,scrollbars=yes`;
        // Always target the same named window so it reuses/focuses reliably.
        weatherWisePopupRef = window.open(safeUrl, 'weatherwise-popout', features);
        opened = weatherWisePopupRef;
        if (opened) {
            try { opened.focus(); } catch {}
        } else {
            // Popup blocked fallback
            const fallback = window.open(safeUrl, '_blank', 'noopener');
            opened = fallback;
            if (!fallback) {
                // Final fallback so click always does something
                window.location.href = safeUrl;
            }
        }
    } catch {
        try {
            const fallback = window.open(safeUrl, '_blank', 'noopener');
            opened = fallback;
            if (!fallback) window.location.href = safeUrl;
        } catch {
            window.location.href = safeUrl;
        }
    }
    return opened;
}
try { window.openWeatherWisePopout = openWeatherWisePopout; } catch {}

function getRyanFloatEls() {
    return {
        root: document.getElementById('ryan-floating-player'),
        header: document.getElementById('ryan-float-header'),
        body: document.getElementById('ryan-float-body'),
        iframe: document.getElementById('ryan-floating-iframe'),
        resize: document.getElementById('ryan-float-resize'),
        restorePill: document.getElementById('ryan-float-restore-pill')
    };
}

function getRyanFloatPlayableUrl(link) {
    const raw = String(link || '').trim();
    if (!raw) return null;

    // Allow pasting a bare YouTube video ID.
    if (/^[\w-]{11}$/.test(raw)) {
        return `https://www.youtube.com/embed/${raw}`;
    }

    let candidate = raw;
    if (!/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(candidate)) {
        candidate = `https://${candidate}`;
    }

    let parsed;
    try {
        parsed = new URL(candidate);
    } catch {
        return null;
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return null;
    }

    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    if (host === 'youtu.be' || host.endsWith('youtube.com') || host.endsWith('youtube-nocookie.com')) {
        return getYouTubeEmbedUrl(parsed.toString());
    }

    if (host.endsWith('vimeo.com')) {
        const vimeoMatch = parsed.pathname.match(/(?:\/video\/)?(\d{6,12})/);
        if (vimeoMatch && vimeoMatch[1]) {
            return `https://player.vimeo.com/video/${vimeoMatch[1]}`;
        }
    }

    return parsed.toString();
}

function setRyanFloatStreamUrl(link, options = {}) {
    const playableUrl = getRyanFloatPlayableUrl(link);
    if (!playableUrl) return false;

    const shouldOpen = options.openPlayer !== false;
    ryanFloatState.streamUrl = playableUrl;

    if (shouldOpen) {
        showRyanFloatPlayer(true);
    } else {
        applyRyanFloatState();
        saveRyanFloatState();
    }
    return true;
}

async function resolveRyanDefaultStreamUrl(options = {}) {
    const forceRefresh = !!options.forceRefresh;
    if (!forceRefresh && ryanResolvedDefaultStreamUrl) {
        return ryanResolvedDefaultStreamUrl;
    }
    if (!forceRefresh && ryanDefaultStreamResolvePromise) {
        return ryanDefaultStreamResolvePromise;
    }

    ryanDefaultStreamResolvePromise = (async () => {
        try {
            const latest = await fetchLatestYouTubeVideo();
            if (latest && latest.videoId) {
                const embed = `https://www.youtube.com/embed/${latest.videoId}`;
                ryanResolvedDefaultStreamUrl = embed;
                return embed;
            }
        } catch {}

        ryanResolvedDefaultStreamUrl = RYAN_STREAM_EMBED_URL || RYAN_STREAM_BACKUP_EMBED_URL;
        return ryanResolvedDefaultStreamUrl;
    })();

    try {
        return await ryanDefaultStreamResolvePromise;
    } finally {
        ryanDefaultStreamResolvePromise = null;
    }
}

async function resetRyanFloatStream(options = {}) {
    const shouldOpen = options.openPlayer !== false;
    const resolvedDefault = await resolveRyanDefaultStreamUrl({ forceRefresh: !!options.forceRefresh });
    ryanFloatState.streamUrl = resolvedDefault || RYAN_STREAM_EMBED_URL || RYAN_STREAM_BACKUP_EMBED_URL;

    if (shouldOpen) {
        showRyanFloatPlayer(true);
    } else {
        applyRyanFloatState();
        saveRyanFloatState();
    }
}

function saveRyanFloatState() {
    try { localStorage.setItem(RYAN_FLOAT_STORAGE_KEY, JSON.stringify(ryanFloatState)); } catch {}
}

function loadRyanFloatState() {
    try {
        const raw = localStorage.getItem(RYAN_FLOAT_STORAGE_KEY);
        if (!raw) return;
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return;
        const storedStreamUrl = getRyanFloatPlayableUrl(parsed.streamUrl);
        ryanFloatState = {
            ...ryanFloatState,
            ...parsed
        };
        ryanFloatState.streamUrl = storedStreamUrl || RYAN_STREAM_EMBED_URL || RYAN_STREAM_BACKUP_EMBED_URL;
    } catch {}
}

function normalizeRyanFloatState() {
    const vpW = window.innerWidth || 1280;
    const vpH = window.innerHeight || 720;

    if (ryanFloatState.maximized) {
        ryanFloatState.minimized = false;
        ryanFloatState.left = 6;
        ryanFloatState.top = 6;
        ryanFloatState.width = Math.max(260, vpW - 12);
        ryanFloatState.height = Math.max(180, vpH - 12);
        return;
    }

    const minW = ryanFloatState.minimized ? 210 : 360;
    const maxW = Math.max(minW, vpW - 20);
    ryanFloatState.width = Math.min(maxW, Math.max(minW, Number(ryanFloatState.width) || 520));
    const minH = 220;
    const maxH = Math.max(minH, vpH - 20);
    ryanFloatState.height = Math.min(maxH, Math.max(minH, Number(ryanFloatState.height) || 320));

    if (!Number.isFinite(ryanFloatState.left)) {
        ryanFloatState.left = Math.max(10, vpW - ryanFloatState.width - 26);
    }
    if (!Number.isFinite(ryanFloatState.top)) {
        ryanFloatState.top = Math.max(10, vpH - (ryanFloatState.minimized ? 64 : ryanFloatState.height) - 30);
    }

    const currentW = ryanFloatState.minimized ? 240 : ryanFloatState.width;
    const currentH = ryanFloatState.minimized ? 52 : ryanFloatState.height;
    ryanFloatState.left = Math.max(6, Math.min(vpW - currentW - 6, ryanFloatState.left));
    ryanFloatState.top = Math.max(6, Math.min(vpH - currentH - 6, ryanFloatState.top));
}

function applyRyanFloatState() {
    const { root, iframe } = getRyanFloatEls();
    if (!root) return;
    normalizeRyanFloatState();

    root.classList.toggle('hidden', !ryanFloatState.visible);
    root.classList.toggle('minimized', !!ryanFloatState.minimized);
    root.classList.toggle('maximized', !!ryanFloatState.maximized);
    root.style.left = `${Math.round(ryanFloatState.left)}px`;
    root.style.top = `${Math.round(ryanFloatState.top)}px`;
    root.style.width = `${Math.round(ryanFloatState.minimized ? 240 : ryanFloatState.width)}px`;
    root.style.height = ryanFloatState.minimized ? '52px' : `${Math.round(ryanFloatState.height)}px`;

    const popoutBtn = document.getElementById('ryan-float-popout-btn');
    if (popoutBtn) {
        const title = ryanFloatState.maximized ? 'Restore player size' : 'Fullscreen player';
        popoutBtn.title = title;
        popoutBtn.setAttribute('aria-label', title);
    }

    // Keep embedded video unloaded unless the floating player is actually shown.
    const targetStreamUrl = ryanFloatState.visible
        ? (ryanFloatState.streamUrl || RYAN_STREAM_EMBED_URL || RYAN_STREAM_BACKUP_EMBED_URL)
        : 'about:blank';
    if (iframe && iframe.getAttribute('src') !== targetStreamUrl) {
        iframe.setAttribute('src', targetStreamUrl);
    }
}

function showRyanFloatPlayer(expanded = true, options = {}) {
    const resetToDefault = !!options.resetToDefault;
    const vpW = window.innerWidth || 1280;
    const vpH = window.innerHeight || 720;
    ryanFloatState.visible = true;
    ryanFloatState.minimized = !expanded;
    if (expanded) {
        ryanFloatState.maximized = false;
    }
    if (resetToDefault) {
        ryanFloatState.width = 520;
        ryanFloatState.height = 320;
        ryanFloatState.left = Math.max(10, vpW - ryanFloatState.width - 26);
        ryanFloatState.top = Math.max(10, vpH - ryanFloatState.height - 30);
    }
    applyRyanFloatState();
    saveRyanFloatState();
}

function setRyanFloatMinimized(minimized) {
    ryanFloatState.visible = true;
    ryanFloatState.minimized = !!minimized;
    if (minimized) {
        ryanFloatState.maximized = false;
    }
    applyRyanFloatState();
    saveRyanFloatState();
}

function toggleRyanFloatMaximized() {
    ryanFloatState.visible = true;

    if (!ryanFloatState.maximized) {
        ryanFloatState.restoreLeft = ryanFloatState.left;
        ryanFloatState.restoreTop = ryanFloatState.top;
        ryanFloatState.restoreWidth = ryanFloatState.width;
        ryanFloatState.restoreHeight = ryanFloatState.height;
        ryanFloatState.maximized = true;
        ryanFloatState.minimized = false;
    } else {
        ryanFloatState.maximized = false;
        ryanFloatState.minimized = false;
        ryanFloatState.left = Number(ryanFloatState.restoreLeft);
        ryanFloatState.top = Number(ryanFloatState.restoreTop);
        ryanFloatState.width = Number(ryanFloatState.restoreWidth) || 520;
        ryanFloatState.height = Number(ryanFloatState.restoreHeight) || 320;
    }

    applyRyanFloatState();
    saveRyanFloatState();
}

function closeRyanFloatPlayer() {
    ryanFloatState.visible = false;
    applyRyanFloatState();
    saveRyanFloatState();
}

function refreshRyanFloatPlayer() {
    const { iframe } = getRyanFloatEls();
    if (!iframe || !ryanFloatState.visible) return;
    const src = iframe.getAttribute('src') || ryanFloatState.streamUrl || RYAN_STREAM_EMBED_URL || RYAN_STREAM_BACKUP_EMBED_URL;
    iframe.setAttribute('src', 'about:blank');
    setTimeout(() => { iframe.setAttribute('src', src); }, 60);
}

function onRyanFloatPointerMove(e) {
    if (ryanFloatDrag) {
        ryanFloatState.left = ryanFloatDrag.startLeft + (e.clientX - ryanFloatDrag.startX);
        ryanFloatState.top = ryanFloatDrag.startTop + (e.clientY - ryanFloatDrag.startY);
        applyRyanFloatState();
        return;
    }
    if (ryanFloatResize) {
        const nextW = ryanFloatResize.startWidth + (e.clientX - ryanFloatResize.startX);
        const nextH = ryanFloatResize.startHeight + (e.clientY - ryanFloatResize.startY);
        ryanFloatState.width = nextW;
        ryanFloatState.height = nextH;
        applyRyanFloatState();
    }
}

function stopRyanFloatPointerOps() {
    if (!ryanFloatDrag && !ryanFloatResize) return;
    ryanFloatDrag = null;
    ryanFloatResize = null;
    try { document.body.classList.remove('ryan-float-dragging'); } catch {}
    saveRyanFloatState();
}

function initRyanFloatingPlayer() {
    const { root, header, resize, restorePill } = getRyanFloatEls();
    if (!root || root.dataset.initDone === '1') return;
    root.dataset.initDone = '1';

    loadRyanFloatState();
    applyRyanFloatState();

    const openBtn = document.getElementById('ryan-float-open-btn');
    const minBtn = document.getElementById('ryan-float-min-btn');
    const followBtn = document.getElementById('ryan-float-follow-btn');
    const refreshBtn = document.getElementById('ryan-float-refresh-btn');
    const popoutBtn = document.getElementById('ryan-float-popout-btn');
    const toggleBtn = document.getElementById('ryan-float-toggle-btn');
    const closeBtn = document.getElementById('ryan-float-close-btn');
    const videoInput = document.getElementById('ryan-video-link-input');
    const videoLoadBtn = document.getElementById('ryan-video-load-btn');
    const videoDefaultBtn = document.getElementById('ryan-video-default-btn');

    if (openBtn) openBtn.addEventListener('click', () => showRyanFloatPlayer(true));
    if (minBtn) minBtn.addEventListener('click', () => setRyanFloatMinimized(true));
    if (followBtn) followBtn.addEventListener('click', () => window.open('https://www.youtube.com/@RyanHallYall?sub_confirmation=1', '_blank', 'noopener'));
    if (refreshBtn) refreshBtn.addEventListener('click', refreshRyanFloatPlayer);
    if (popoutBtn) popoutBtn.addEventListener('click', toggleRyanFloatMaximized);
    if (toggleBtn) toggleBtn.addEventListener('click', () => setRyanFloatMinimized(!ryanFloatState.minimized));
    if (closeBtn) closeBtn.addEventListener('click', closeRyanFloatPlayer);
    if (restorePill) restorePill.addEventListener('click', () => setRyanFloatMinimized(false));
    if (videoInput) {
        const currentStream = ryanFloatState.streamUrl || RYAN_STREAM_EMBED_URL;
        if (currentStream && currentStream !== RYAN_STREAM_EMBED_URL) {
            videoInput.value = currentStream;
        }
        videoInput.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            if (videoLoadBtn) videoLoadBtn.click();
        });
    }
    if (videoLoadBtn) {
        videoLoadBtn.addEventListener('click', () => {
            const rawUrl = videoInput ? videoInput.value.trim() : '';
            if (!rawUrl) {
                alert('Paste a video URL first.');
                return;
            }
            const loaded = setRyanFloatStreamUrl(rawUrl, { openPlayer: true });
            if (!loaded) {
                alert('Invalid video URL.');
            }
        });
    }
    if (videoDefaultBtn) {
        videoDefaultBtn.addEventListener('click', async () => {
            videoDefaultBtn.disabled = true;
            const previousLabel = videoDefaultBtn.textContent;
            videoDefaultBtn.textContent = 'Loading...';
            try {
                await resetRyanFloatStream({ openPlayer: true, forceRefresh: true });
                if (videoInput) videoInput.value = '';
            } finally {
                videoDefaultBtn.disabled = false;
                videoDefaultBtn.textContent = previousLabel;
            }
        });
    }

    // Make Ryan's current live stream (or latest completed stream) the default first video.
    const currentStream = String(ryanFloatState.streamUrl || '').trim().toLowerCase();
    const isDefaultCandidate = !currentStream
        || currentStream.includes('jugp3_gngme')
        || currentStream.includes('/embed/live_stream?channel=');
    if (isDefaultCandidate) {
        resetRyanFloatStream({ openPlayer: false, forceRefresh: true }).catch(() => {});
    }

    if (header) {
        header.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return;
            if (e.target && e.target.closest('.ryan-float-btn')) return;
            if (ryanFloatState.minimized || ryanFloatState.maximized) return;
            ryanFloatDrag = {
                startX: e.clientX,
                startY: e.clientY,
                startLeft: ryanFloatState.left,
                startTop: ryanFloatState.top
            };
            document.body.classList.add('ryan-float-dragging');
            e.preventDefault();
        });
    }

    if (resize) {
        resize.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return;
            if (ryanFloatState.minimized || ryanFloatState.maximized) return;
            ryanFloatResize = {
                startX: e.clientX,
                startY: e.clientY,
                startWidth: ryanFloatState.width,
                startHeight: ryanFloatState.height
            };
            document.body.classList.add('ryan-float-dragging');
            e.preventDefault();
        });
    }

    document.addEventListener('mousemove', onRyanFloatPointerMove);
    document.addEventListener('mouseup', stopRyanFloatPointerOps);
    window.addEventListener('resize', () => {
        if (!ryanFloatState.visible) return;
        applyRyanFloatState();
        saveRyanFloatState();
    });
}

// Header nav wiring for in-page view switching
document.addEventListener('DOMContentLoaded', () => {
    const navWarnings = document.getElementById('nav-warnings');
    const navMap = document.getElementById('nav-map');
    if (navWarnings) navWarnings.addEventListener('click', (e) => {
        e.preventDefault();
        switchView('warnings');
    });
    if (navMap) navMap.addEventListener('click', (e) => {
        e.preventDefault();
        switchView('map');
    });
    
    // Setup dropdown menu
    console.log('DOM loaded - setting up dropdown menu...');
    setupDropdownMenu();
    initRyanFloatingPlayer();
    try {
        ensureNotificationTray();
        syncActiveAlertsTrayVisibility();
    } catch {}
    
    try { initAudioUnlock(); } catch {}
    applyStartupDefaultView();
});

function switchView(viewType) {
    const warningsList = document.getElementById('warnings-list');
    const sortMenu = document.querySelector('.warning-sort-menu');
    const searchInput = document.getElementById('warning-search');
    const dashboard = document.querySelector('.dashboard-container');
    const mapSection = document.getElementById('map-section');
    const ryanLiveSection = document.getElementById('ryan-live-section');
    const navWarnings = document.getElementById('nav-warnings') || document.getElementById('nav-warnings-btn');
    const navMap = document.getElementById('nav-map');

    if (viewType === 'ryan-live') {
        openRyanLiveDashboard();
        return;
    }

    try { closeRyanLiveDashboard(); } catch {}
    
    // Update current view
    currentView = viewType;

    if (viewType === 'map') {
        // Mark body for map view so CSS can make the map full-bleed
        document.body.classList.add('map-view');
        try {
            window.notificationPopupsEnabled = false;
            if (notificationTimer) { clearTimeout(notificationTimer); notificationTimer = null; }
            notificationQueue.length = 0;
            isShowingNotification = false;
            const tray = document.getElementById('warning-tray');
            // Hide the tray but DO NOT clear its contents so cards persist across views
            if (tray) { tray.classList.remove('open'); tray.style.display = 'none'; }
            try { syncTrayLayoutState(); } catch {}
            if (currentAlertAudio && typeof currentAlertAudio.pause === 'function') { currentAlertAudio.pause(); try { currentAlertAudio.currentTime = 0; } catch {} }
        } catch {}
        // Hide warnings UI
        if (dashboard) dashboard.style.display = 'block';
        if (warningsList) warningsList.style.display = 'none';
        if (sortMenu) sortMenu.style.display = 'none';
        if (searchInput) searchInput.style.display = 'none';
        if (mapSection) {
            mapSection.style.display = 'block';
            // Force layout to compute dimensions before init/resize
            void mapSection.offsetHeight;
        }
        if (ryanLiveSection) ryanLiveSection.classList.remove('is-open');
        // Explicitly size the embedded map element to fill the viewport
        sizeEmbeddedMap();

        // Toggle active nav state
        if (navWarnings) navWarnings.classList.remove('active');
        if (navMap) navMap.classList.add('active');

        // Initialize map once
        if (!mapInitialized && typeof window.initWeatherMap === 'function') {
            try {
                window.initWeatherMap();
                mapInitialized = true;
                // Kick resize attempts while layout settles
                ensureMapResized();
                // Ensure map header controls are wired
                try { if (typeof window.setupMapControls === 'function') window.setupMapControls(); } catch {}
                // Ensure drawing UI is initialized and wired
                try { if (typeof window.initDrawingUI === 'function') window.initDrawingUI(); } catch {}
            } catch (e) { console.error('Failed to init map:', e); }
        } else {
            // If already initialized, make sure it fills the container
            ensureMapResized();
            // Re-wire map header controls in case DOM/listeners were replaced
            try { if (typeof window.setupMapControls === 'function') window.setupMapControls(); } catch {}
            // Re-wire drawing UI in case it wasn't attached yet
            try { if (typeof window.initDrawingUI === 'function') window.initDrawingUI(); } catch {}
        }
        startMapBroadcastHud();
        setDropdownViewActive('map');
        return;
    }

    // Default: warnings view
    document.body.classList.remove('map-view');
    stopMapBroadcastHud();
    try {
        const stored = localStorage.getItem('notificationPopupsEnabled');
        window.notificationPopupsEnabled = stored !== 'false';
        const tray = ensureNotificationTray();
        // Always keep the severe alerts tray visible in warnings view
        if (tray) {
            positionWarningTray();
            tray.style.display = 'block';
            tray.classList.add('open');
        }
        try { updateTrayEmptyState(); } catch {}
        try { syncTrayLayoutState(); } catch {}
    } catch {}
    if (dashboard) dashboard.style.display = 'block';
    if (mapSection) mapSection.style.display = 'none';
    if (ryanLiveSection) ryanLiveSection.classList.remove('is-open');
    if (warningsList) warningsList.style.display = '';
    if (sortMenu) sortMenu.style.display = 'flex';
    if (searchInput) searchInput.style.display = 'block';
    renderWarnings(allWarnings);

    // Toggle active nav state
    if (navWarnings) navWarnings.classList.add('active');
    if (navMap) navMap.classList.remove('active');
    setDropdownViewActive('warnings');

    // Show fixed warning counter
    updateFixedWarningCounter();
}

function applyStartupDefaultView() {
    if (startupViewApplied) return;
    startupViewApplied = true;
    if (STARTUP_DEFAULT_VIEW !== 'map') return;

    // Startup behavior: immediately show live map with radar + warning polygons.
    setTimeout(() => {
        try {
            switchView('map');
            const radarBtn = document.getElementById('radar-toggle');
            const warningsBtn = document.getElementById('warnings-toggle');
            if (radarBtn) radarBtn.classList.add('active');
            if (warningsBtn) warningsBtn.classList.add('active');
        } catch (err) {
            console.warn('startup map view init failed', err);
        }
    }, 0);
}

// Ensure map resizes with window
window.addEventListener('resize', () => {
    try {
        if (currentView === 'map') {
            sizeEmbeddedMap();
            if (window.map && typeof window.map.resize === 'function') window.map.resize();
        }
    } catch {}
    scheduleCountyOverflowRefresh();
});

// Repeatedly call map.resize() until the container reports a sane size
function ensureMapResized() {
    const container = document.getElementById('weather-map');
    let attempts = 0;
    const maxAttempts = 40; // ~2s if 50ms interval
    const tick = () => {
        attempts++;
        const w = container?.clientWidth || 0;
        const h = container?.clientHeight || 0;
        if (w > 200 && h > 200) {
            try { window.map && window.map.resize(); } catch {}
            return; // good size
        }
        try { window.map && window.map.resize(); } catch {}
        if (attempts < maxAttempts) setTimeout(tick, 50);
    };
    // Run a few frames, including after fonts/styles settle
    setTimeout(tick, 0);
    setTimeout(tick, 120);
    setTimeout(tick, 360);
    setTimeout(tick, 800);
}













function addMockSPCOutlook() {
    if (!window.forecastMap) return;
    
    // Realistic SPC outlook data based on typical severe weather patterns
    const spcOutlookData = {
        type: 'FeatureCollection',
        features: [
            // General Thunderstorm (Dark Grey) - covers most of the eastern US
            {
                type: 'Feature',
                properties: { risk: 'general', description: 'General Thunderstorm Risk' },
                geometry: {
                    type: 'Polygon',
                    coordinates: [[
                        [-105, 50], [-65, 50], [-65, 25], [-105, 25], [-105, 50]
                    ]]
                }
            },
            // Marginal Risk (Green) - scattered areas
            {
                type: 'Feature',
                properties: { risk: 'marginal', description: 'Marginal Risk - Isolated Severe Storms' },
                geometry: {
                    type: 'Polygon',
                    coordinates: [[
                        [-100, 45], [-85, 45], [-85, 35], [-100, 35], [-100, 45]
                    ]]
                }
            },
            // Slight Risk (Yellow) - more concentrated areas
            {
                type: 'Feature',
                properties: { risk: 'slight', description: 'Slight Risk - Scattered Severe Storms' },
                geometry: {
                    type: 'Polygon',
                    coordinates: [[
                        [-98, 42], [-88, 42], [-88, 38], [-98, 38], [-98, 42]
                    ]]
                }
            },
            // Enhanced Risk (Orange) - significant severe weather
            {
                type: 'Feature',
                properties: { risk: 'enhanced', description: 'Enhanced Risk - Numerous Severe Storms' },
                geometry: {
                    type: 'Polygon',
                    coordinates: [[
                        [-96, 40], [-90, 40], [-90, 37], [-96, 37], [-96, 40]
                    ]]
                }
            },
            // Moderate Risk (Red) - major severe weather outbreak
            {
                type: 'Feature',
                properties: { risk: 'moderate', description: 'Moderate Risk - Widespread Severe Storms' },
                geometry: {
                    type: 'Polygon',
                    coordinates: [[
                        [-95, 39], [-91, 39], [-91, 37.5], [-95, 37.5], [-95, 39]
                    ]]
                }
            },
            // High Risk (Purple) - extreme severe weather (rare)
            {
                type: 'Feature',
                properties: { risk: 'high', description: 'High Risk - Extreme Severe Weather' },
                geometry: {
                    type: 'Polygon',
                    coordinates: [[
                        [-94, 38.5], [-92, 38.5], [-92, 37.5], [-94, 37.5], [-94, 38.5]
                    ]]
                }
            }
        ]
    };

    // Remove existing source and layer if they exist
    if (window.forecastMap.getSource('spc-outlook')) {
        if (window.forecastMap.getLayer('spc-outlook-layer')) {
            window.forecastMap.removeLayer('spc-outlook-layer');
        }
        if (window.forecastMap.getLayer('spc-outlook-border')) {
            window.forecastMap.removeLayer('spc-outlook-border');
        }
        window.forecastMap.removeSource('spc-outlook');
    }

    window.forecastMap.addSource('spc-outlook', {
        type: 'geojson',
        data: spcOutlookData
    });

    // Add the fill layer for risk areas
    window.forecastMap.addLayer({
        id: 'spc-outlook-layer',
        type: 'fill',
        source: 'spc-outlook',
        paint: {
            'fill-color': [
                'match',
                ['get', 'risk'],
                'general', '#404040',
                'marginal', '#00FF00',
                'slight', '#FFFF00',
                'enhanced', '#FFA500',
                'moderate', '#FF0000',
                'high', '#800080',
                '#000000'
            ],
            'fill-opacity': 0.6
        }
    });

    // Add border layer for better visibility
    window.forecastMap.addLayer({
        id: 'spc-outlook-border',
        type: 'line',
        source: 'spc-outlook',
        paint: {
            'line-color': [
                'match',
                ['get', 'risk'],
                'general', '#666666',
                'marginal', '#00CC00',
                'slight', '#CCCC00',
                'enhanced', '#CC6600',
                'moderate', '#CC0000',
                'high', '#660066',
                '#000000'
            ],
            'line-width': 2,
            'line-opacity': 0.8
        }
    });
}

function updateCityLabels() {
    if (!window.forecastMap) return;
    
    const cityLabels = document.querySelectorAll('.city-label');
    const cities = [
        { name: 'Dickinson', coords: [-102.789, 46.879], state: 'ND' },
        { name: 'Bismarck', coords: [-100.784, 46.823], state: 'ND' },
        { name: 'Fargo', coords: [-96.789, 46.877], state: 'ND' },
        { name: 'Rapid City', coords: [-103.231, 44.081], state: 'SD' },
        { name: 'Pierre', coords: [-100.350, 44.368], state: 'SD' },
        { name: 'Sioux Falls', coords: [-96.732, 43.545], state: 'SD' },
        { name: 'Duluth', coords: [-92.101, 46.787], state: 'MN' },
        { name: 'Saint Cloud', coords: [-94.163, 45.557], state: 'MN' },
        { name: 'Minneapolis', coords: [-93.265, 44.978], state: 'MN' },
        { name: 'Rochester', coords: [-92.463, 44.022], state: 'MN' },
        { name: 'Eau Claire', coords: [-91.498, 44.811], state: 'WI' },
        { name: 'Green Bay', coords: [-88.013, 44.513], state: 'WI' },
        { name: 'Madison', coords: [-89.401, 43.073], state: 'WI' },
        { name: 'Milwaukee', coords: [-87.907, 43.038], state: 'WI' },
        { name: 'Cedar Rapids', coords: [-91.668, 41.978], state: 'IA' },
        { name: 'Des Moines', coords: [-93.609, 41.586], state: 'IA' },
        { name: 'Davenport', coords: [-90.576, 41.544], state: 'IA' },
        { name: 'Omaha', coords: [-95.934, 41.257], state: 'NE' },
        { name: 'North Platte', coords: [-100.765, 41.140], state: 'NE' },
        { name: 'Lincoln', coords: [-96.700, 40.814], state: 'NE' },
        { name: 'Casper', coords: [-106.313, 42.866], state: 'WY' },
        { name: 'Cheyenne', coords: [-104.820, 41.140], state: 'WY' },
        { name: 'Houghton', coords: [-88.569, 47.122], state: 'MI' },
        { name: 'Marquette', coords: [-87.395, 46.544], state: 'MI' },
        { name: 'Sault Ste. Marie', coords: [-84.345, 46.495], state: 'MI' },
        { name: 'Escanaba', coords: [-87.064, 45.745], state: 'MI' }
    ];
    
    cities.forEach((city, index) => {
        if (cityLabels[index]) {
            const [lng, lat] = city.coords;
            const point = window.forecastMap.project([lng, lat]);
            
            if (point) {
                cityLabels[index].style.left = `${point.x}px`;
                cityLabels[index].style.top = `${point.y - 20}px`;
            }
        }
    });
}

function addCities() {
    if (!window.forecastMap) return;
    
    // Add major cities
    const cities = [
        { name: 'Dickinson', coords: [-102.789, 46.879], state: 'ND' },
        { name: 'Bismarck', coords: [-100.784, 46.823], state: 'ND' },
        { name: 'Fargo', coords: [-96.789, 46.877], state: 'ND' },
        { name: 'Rapid City', coords: [-103.231, 44.081], state: 'SD' },
        { name: 'Pierre', coords: [-100.350, 44.368], state: 'SD' },
        { name: 'Sioux Falls', coords: [-96.732, 43.545], state: 'SD' },
        { name: 'Duluth', coords: [-92.101, 46.787], state: 'MN' },
        { name: 'Saint Cloud', coords: [-94.163, 45.557], state: 'MN' },
        { name: 'Minneapolis', coords: [-93.265, 44.978], state: 'MN' },
        { name: 'Rochester', coords: [-92.463, 44.022], state: 'MN' },
        { name: 'Eau Claire', coords: [-91.498, 44.811], state: 'WI' },
        { name: 'Green Bay', coords: [-88.013, 44.513], state: 'WI' },
        { name: 'Madison', coords: [-89.401, 43.073], state: 'WI' },
        { name: 'Milwaukee', coords: [-87.907, 43.038], state: 'WI' },
        { name: 'Cedar Rapids', coords: [-91.668, 41.978], state: 'IA' },
        { name: 'Des Moines', coords: [-93.609, 41.586], state: 'IA' },
        { name: 'Davenport', coords: [-90.576, 41.544], state: 'IA' },
        { name: 'Omaha', coords: [-95.934, 41.257], state: 'NE' },
        { name: 'North Platte', coords: [-100.765, 41.140], state: 'NE' },
        { name: 'Lincoln', coords: [-96.700, 40.814], state: 'NE' },
        { name: 'Casper', coords: [-106.313, 42.866], state: 'WY' },
        { name: 'Cheyenne', coords: [-104.820, 41.140], state: 'WY' },
        { name: 'Houghton', coords: [-88.569, 47.122], state: 'MI' },
        { name: 'Marquette', coords: [-87.395, 46.544], state: 'MI' },
        { name: 'Sault Ste. Marie', coords: [-84.345, 46.495], state: 'MI' },
        { name: 'Escanaba', coords: [-87.064, 45.745], state: 'MI' }
    ];

    const citiesData = {
        type: 'FeatureCollection',
        features: cities.map(city => ({
            type: 'Feature',
            properties: { name: city.name, state: city.state },
            geometry: {
                type: 'Point',
                coordinates: city.coords
            }
        }))
    };

    // Remove existing source and layers if they exist
    if (window.forecastMap.getSource('cities')) {
        if (window.forecastMap.getLayer('cities-labels')) {
            window.forecastMap.removeLayer('cities-labels');
        }
        if (window.forecastMap.getLayer('cities-layer')) {
            window.forecastMap.removeLayer('cities-layer');
        }
        window.forecastMap.removeSource('cities');
    }

    window.forecastMap.addSource('cities', {
        type: 'geojson',
        data: citiesData
    });

    window.forecastMap.addLayer({
        id: 'cities-layer',
        type: 'circle',
        source: 'cities',
        paint: {
            'circle-radius': 4,
            'circle-color': '#ffffff',
            'circle-stroke-color': '#000000',
            'circle-stroke-width': 2
        }
    });

    // Add city labels as HTML overlays instead of map layers
    const mapContainer = document.getElementById('forecast-map');
    if (!mapContainer) return;
    
    cities.forEach(city => {
        const [lng, lat] = city.coords;
        const point = window.forecastMap.project([lng, lat]);
        
        if (point) {
            const label = document.createElement('div');
            label.className = 'city-label';
            label.textContent = city.name;
            label.style.cssText = `
                position: absolute;
                left: ${point.x}px;
                top: ${point.y - 20}px;
                background: rgba(0, 0, 0, 0.8);
                color: white;
                padding: 2px 6px;
                border-radius: 3px;
                font-size: 10px;
                font-weight: 500;
                pointer-events: none;
                z-index: 1000;
                white-space: nowrap;
            `;
            
            mapContainer.appendChild(label);
        }
    });
}

function setupForecastControls() {
    // Forecast view dropdown navigation
    const forecastViewDropdown = document.getElementById('forecast-view-dropdown');
    if (forecastViewDropdown) {
        forecastViewDropdown.addEventListener('change', (e) => {
            const selectedView = e.target.value;
            if (selectedView === 'warnings') {
                // Switch back to warnings view
                switchView('warnings');
            }
        });
    }

    // Setup sidebar controls
    setupSidebarControls();
    
    // Add test map button listener
    const testMapBtn = document.getElementById('test-map-btn');
    if (testMapBtn) {
        testMapBtn.addEventListener('click', () => {
            console.log('Test map button clicked');
            initializeForecastMap();
        });
    }

    // Update forecast time display
    const forecastTimeDisplay = document.getElementById('forecast-current-time');
    if (forecastTimeDisplay) {
        const updateForecastTime = () => {
            const now = new Date();
            let hours = now.getHours();
            const minutes = pad(now.getMinutes());
            const seconds = pad(now.getSeconds());
            const ampm = hours >= 12 ? 'PM' : 'AM';
            hours = hours % 12;
            if (hours === 0) hours = 12;
            const timeStr = `${hours}:${minutes}:${seconds} ${ampm}`;
            forecastTimeDisplay.textContent = timeStr;
        };
        updateForecastTime();
        setInterval(updateForecastTime, 1000);
    }

    // Opacity slider
    const opacitySlider = document.getElementById('opacity-slider');
    const sliderValue = document.getElementById('slider-value');
    
    if (opacitySlider && sliderValue) {
        opacitySlider.addEventListener('input', (e) => {
            const value = e.target.value;
            sliderValue.textContent = value + '%';
            
            if (window.forecastMap) {
                window.forecastMap.setPaintProperty('spc-outlook-layer', 'fill-opacity', value / 100);
            }
        });
    }

    // Map style selector
    const mapStyleSelect = document.getElementById('map-style-select');
    if (mapStyleSelect && window.forecastMap) {
        mapStyleSelect.addEventListener('change', (e) => {
            const style = e.target.value;
            updateMapStyle(style);
        });
    }

    // Export buttons
    const exportButtons = document.querySelectorAll('.export-btn');
    exportButtons.forEach(btn => {
        btn.addEventListener('click', (e) => {
            // Remove active class from all buttons
            exportButtons.forEach(b => b.classList.remove('active'));
            // Add active class to clicked button
            e.target.classList.add('active');
            
            const exportType = e.target.dataset.export;
            console.log(`Export ${exportType} clicked`);
            // Here you would implement actual export functionality
        });
    });

    // Show outlook checkbox
    const showOutlookCheckbox = document.getElementById('show-outlook-checkbox');
    if (showOutlookCheckbox && window.forecastMap) {
        showOutlookCheckbox.addEventListener('change', (e) => {
            const visibility = e.target.checked ? 'visible' : 'none';
            window.forecastMap.setLayoutProperty('spc-outlook-layer', 'visibility', visibility);
        });
    }

    // Settings button
    const settingsBtn = document.getElementById('forecast-settings-btn');
    if (settingsBtn) {
        settingsBtn.addEventListener('click', showForecastSettings);
    }
}

function showForecastSettings() {
    try {
        const existing = document.querySelector('.forecast-settings-modal.settings-modal-v2');
        if (existing && existing.parentElement) existing.parentElement.removeChild(existing);
        syncBlockingOverlayScrollLock();
    } catch {}

    const getInitialVolumePct = () => {
        try {
            if (typeof window.alertVolume === 'number' && Number.isFinite(window.alertVolume)) {
                return Math.round(Math.max(0, Math.min(1, window.alertVolume)) * 100);
            }
            const stored = parseFloat(localStorage.getItem('alertVolume') || '0.7');
            const vol = Number.isFinite(stored) ? stored : 0.7;
            return Math.round(Math.max(0, Math.min(1, vol)) * 100);
        } catch {
            return 70;
        }
    };

    const alertSoundsEnabled = window.alertSoundsEnabled !== false;
    const notificationPopupsEnabled = window.notificationPopupsEnabled !== false;
    const currentVolumePct = getInitialVolumePct();

    const modal = document.createElement('div');
    modal.className = 'forecast-settings-modal settings-modal-v2';
    modal.innerHTML = `
        <div class="forecast-settings-content settings-content-v2" role="dialog" aria-modal="true" aria-label="Settings">
            <div class="settings-header settings-header-v2">
                <div class="settings-title-wrap">
                    <div class="settings-kicker">Live Weather Settings Desk</div>
                    <h2>Alert Settings Scoreboard</h2>
                    <p class="settings-subtitle">Control alerts, sounds, and warning types.</p>
                </div>
                <div class="settings-status-wrap">
                    <div class="settings-live-row">
                        <span class="settings-live-dot"></span>
                        <span class="settings-live-label">Settings Feed Connected</span>
                    </div>
                    <div class="settings-updated" id="settings-updated-at">Updated --</div>
                </div>
                <button class="close-settings-btn" id="close-settings-btn" type="button" aria-label="Close settings">&times;</button>
            </div>
            <div class="settings-range-row-v2">
                <button type="button" class="settings-range-btn active" data-target="settings-system-panel">System</button>
                <button type="button" class="settings-range-btn" data-target="settings-events-panel">Warning Types</button>
                <button type="button" class="settings-range-btn" data-target="settings-footer-panel">Finalize</button>
            </div>
            <div class="settings-body settings-body-v2">
                <div class="settings-desk-layout">
                    <aside class="settings-desk-left">
                        <section class="settings-stat-card">
                            <div class="settings-stat-label">Alert Sounds</div>
                            <div class="settings-stat-value" id="settings-sounds-state">${alertSoundsEnabled ? 'ON' : 'OFF'}</div>
                        </section>
                        <section class="settings-stat-card">
                            <div class="settings-stat-label">Popup Alerts</div>
                            <div class="settings-stat-value" id="settings-popups-state">${notificationPopupsEnabled ? 'ON' : 'OFF'}</div>
                        </section>
                        <section class="settings-stat-card">
                            <div class="settings-stat-label">Master Volume</div>
                            <div class="settings-stat-value" id="settings-volume-stat">${currentVolumePct}%</div>
                        </section>
                        <section class="settings-stat-card">
                            <div class="settings-stat-label">Warning Types</div>
                            <div class="settings-stat-value" id="settings-type-count">--</div>
                        </section>
                        <section class="settings-stat-card">
                            <div class="settings-stat-label">Enabled Toggles</div>
                            <div class="settings-stat-value" id="settings-toggle-count">--</div>
                        </section>
                    </aside>
                    <div class="settings-desk-main">
                        <section class="setting-group system-group-v2" id="settings-system-panel">
                            <div class="settings-panel-head">
                                <h3>System Controls</h3>
                                <div class="settings-panel-count">Live Config</div>
                            </div>
                            <div class="settings-grid-v2">
                                <section class="setting-card-v2">
                                    <h3>Audio</h3>
                                    <label class="toggle-label">
                                        <input type="checkbox" id="alert-sounds-toggle" ${alertSoundsEnabled ? 'checked' : ''}>
                                        <span class="toggle-slider"></span>
                                        <span class="toggle-text">Enable Alert Sounds</span>
                                    </label>
                                    <div class="volume-row-v2">
                                        <label class="toggle-text" for="alert-volume">Volume</label>
                                        <input type="range" id="alert-volume" min="0" max="100" value="${currentVolumePct}">
                                        <span class="volume-value-v2" id="alert-volume-value">${currentVolumePct}%</span>
                                    </div>
                                    <button class="save-settings-btn" id="test-sound-btn" type="button">Test Sound</button>
                                </section>
                                <section class="setting-card-v2">
                                    <h3>Notifications</h3>
                                    <label class="toggle-label">
                                        <input type="checkbox" id="notification-popup-toggle" ${notificationPopupsEnabled ? 'checked' : ''}>
                                        <span class="toggle-slider"></span>
                                        <span class="toggle-text">Show New Alert Popups</span>
                                    </label>
                                    <p class="setting-description">When disabled, alerts still appear in Severe Alerts, but popup flow is paused.</p>
                                </section>
                            </div>
                        </section>
                        <section class="setting-group event-group-v2" id="settings-events-panel">
                            <div class="settings-panel-head">
                                <h3>Warning Type Matrix</h3>
                                <div class="settings-panel-count" id="settings-event-meta"></div>
                            </div>
                            <div class="settings-toolbar">
                                <div class="settings-search">
                                    <input type="search" id="settings-event-search" placeholder="Search warning types...">
                                </div>
                                <button type="button" class="btn btn-important" id="settings-important-btn">Important</button>
                                <button type="button" class="btn btn-primary" id="settings-enable-all-btn">Enable All</button>
                                <button type="button" class="btn btn-outline" id="settings-disable-all-btn">Disable All</button>
                            </div>
                            <div class="event-prefs" id="settings-event-grid">
                                <div class="event-head">Event</div>
                                <div class="event-head">Popup</div>
                                <div class="event-head">Sound</div>
                            </div>
                        </section>
                    </div>
                </div>
            </div>
            <div class="settings-footer settings-footer-v2" id="settings-footer-panel">
                <button class="save-settings-btn apply-settings-btn" id="save-settings-btn" type="button">Apply</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
    syncBlockingOverlayScrollLock();

    const closeBtn = modal.querySelector('#close-settings-btn');
    const saveBtn = modal.querySelector('#save-settings-btn');
    const alertSoundsToggle = modal.querySelector('#alert-sounds-toggle');
    const notificationToggle = modal.querySelector('#notification-popup-toggle');
    const alertVolumeSlider = modal.querySelector('#alert-volume');
    const alertVolumeValue = modal.querySelector('#alert-volume-value');
    const testSoundBtn = modal.querySelector('#test-sound-btn');
    const eventSearch = modal.querySelector('#settings-event-search');
    const eventMeta = modal.querySelector('#settings-event-meta');
    const eventGrid = modal.querySelector('#settings-event-grid');
    const importantBtn = modal.querySelector('#settings-important-btn');
    const enableAllBtn = modal.querySelector('#settings-enable-all-btn');
    const disableAllBtn = modal.querySelector('#settings-disable-all-btn');
    const settingsUpdatedAt = modal.querySelector('#settings-updated-at');
    const settingsSoundsState = modal.querySelector('#settings-sounds-state');
    const settingsPopupsState = modal.querySelector('#settings-popups-state');
    const settingsVolumeStat = modal.querySelector('#settings-volume-stat');
    const settingsTypeCount = modal.querySelector('#settings-type-count');
    const settingsToggleCount = modal.querySelector('#settings-toggle-count');
    const rangeButtons = Array.from(modal.querySelectorAll('.settings-range-btn[data-target]'));

    const stampSettingsUpdated = () => {
        if (!settingsUpdatedAt) return;
        try {
            const now = new Date();
            const rendered = now.toLocaleString('en-US', {
                month: 'short',
                day: 'numeric',
                hour: 'numeric',
                minute: '2-digit'
            });
            settingsUpdatedAt.textContent = `Updated ${rendered}`;
        } catch {
            settingsUpdatedAt.textContent = 'Updated now';
        }
    };

    const syncSummaryCards = (summary = null) => {
        if (settingsSoundsState) settingsSoundsState.textContent = alertSoundsToggle && alertSoundsToggle.checked ? 'ON' : 'OFF';
        if (settingsPopupsState) settingsPopupsState.textContent = notificationToggle && notificationToggle.checked ? 'ON' : 'OFF';
        if (settingsVolumeStat) settingsVolumeStat.textContent = `${alertVolumeSlider && alertVolumeSlider.value ? alertVolumeSlider.value : currentVolumePct}%`;
        if (summary && settingsTypeCount) settingsTypeCount.textContent = String(summary.visibleRows);
        if (summary && settingsToggleCount) settingsToggleCount.textContent = `${summary.enabledAll}/${summary.totalAll}`;
    };

    rangeButtons.forEach((button) => {
        button.addEventListener('click', () => {
            rangeButtons.forEach((btn) => btn.classList.remove('active'));
            button.classList.add('active');
            const targetId = String(button.dataset.target || '').trim();
            if (!targetId) return;
            const target = modal.querySelector(`#${targetId}`);
            if (target) {
                try { target.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch {}
            }
        });
    });

    // Reuse the same staggered open animation style as desk overlays (top-to-bottom reveal)
    const stagedSettingsItems = [
        ...Array.from(modal.querySelectorAll('.settings-desk-left .settings-stat-card')),
        modal.querySelector('.system-group-v2'),
        ...Array.from(modal.querySelectorAll('.system-group-v2 .setting-card-v2')),
        modal.querySelector('.event-group-v2'),
        modal.querySelector('.settings-footer-v2')
    ].filter(Boolean);
    stagedSettingsItems.forEach((el, idx) => {
        try {
            el.classList.add('storm-desk-item-anim');
            el.style.setProperty('--storm-desk-delay', `${Math.min(idx * 55, 520)}ms`);
        } catch {}
    });

    const closeModal = () => {
        try { document.removeEventListener('keydown', handleEsc); } catch {}
        try {
            if (modal && modal.parentElement) modal.parentElement.removeChild(modal);
        } catch {}
        syncBlockingOverlayScrollLock();
    };

    const handleEsc = (e) => {
        if (e.key === 'Escape') closeModal();
    };

    const persistBaseSettings = () => {
        try {
            const soundsOn = !!(alertSoundsToggle && alertSoundsToggle.checked);
            const popupsOn = !!(notificationToggle && notificationToggle.checked);
            const rawPct = parseFloat(alertVolumeSlider && alertVolumeSlider.value ? alertVolumeSlider.value : '70');
            const pct = Number.isFinite(rawPct) ? Math.max(0, Math.min(100, rawPct)) : 70;
            const vol = pct / 100;

            window.alertSoundsEnabled = soundsOn;
            window.notificationPopupsEnabled = popupsOn;
            window.alertVolume = vol;

            localStorage.setItem('alertSoundsEnabled', String(soundsOn));
            localStorage.setItem('notificationPopupsEnabled', String(popupsOn));
            localStorage.setItem('alertVolume', String(vol));
            syncSummaryCards();
            stampSettingsUpdated();

            if (!popupsOn) {
                try { notificationQueue.length = 0; } catch {}
                try { isShowingNotification = false; } catch {}
                try {
                    if (notificationTimer) {
                        clearTimeout(notificationTimer);
                        notificationTimer = null;
                    }
                } catch {}
            } else {
                try { processNotificationQueue(); } catch {}
            }
        } catch {}
    };

    const loadPrefsMap = () => {
        try {
            const base = (window.alertPreferencesV2 && window.alertPreferencesV2.events) ? window.alertPreferencesV2.events : {};
            return { ...base };
        } catch {
            return {};
        }
    };

    let prefsMap = loadPrefsMap();

    const persistPrefsMap = () => {
        try {
            window.alertPreferencesV2 = { events: prefsMap };
            localStorage.setItem('alertPreferencesV2', JSON.stringify(window.alertPreferencesV2));
        } catch {}
    };

    const getEffectiveSetting = (eventName, kind) => {
        const key = String(eventName || '').toUpperCase();
        const rec = prefsMap[key];
        if (rec && typeof rec[kind] === 'boolean') return rec[kind];
        try {
            if (typeof isEventAllowed === 'function') return !!isEventAllowed(key, kind);
        } catch {}
        return true;
    };

    const ensureEventRecord = (eventName) => {
        const key = String(eventName || '').toUpperCase();
        if (!key) return null;
        if (!prefsMap[key]) {
            prefsMap[key] = {
                popup: getEffectiveSetting(key, 'popup'),
                sound: getEffectiveSetting(key, 'sound')
            };
        }
        return prefsMap[key];
    };

    const isImportantEvent = (name) => {
        const n = String(name || '').toUpperCase();
        if (!n) return false;
        if (n.includes('SPECIAL MARINE WARNING') || n.includes('COASTAL FLOOD WATCH')) return false;
        return (
            n.includes('EMERGENCY') ||
            n === 'PDS TORNADO WARNING' ||
            n === 'TORNADO WARNING' ||
            n === 'SEVERE THUNDERSTORM WARNING' ||
            n === 'FLASH FLOOD WARNING' ||
            n === 'WINTER STORM WARNING' ||
            n === 'WINTER WEATHER WARNING' ||
            n === 'TROPICAL STORM WARNING' ||
            n === 'TROPICAL STORM WATCH' ||
            n === 'HURRICANE WARNING' ||
            n === 'HURRICANE WATCH' ||
            n === '911 TELEPHONE OUTAGE' ||
            n === 'BLIZZARD WARNING' ||
            n === 'CIVIL DANGER WARNING' ||
            n === 'EVACUATION IMMEDIATE' ||
            n === 'ICE STORM WARNING' ||
            n === 'LAW ENFORCEMENT WARNING' ||
            n === 'SEVERE THUNDERSTORM WATCH' ||
            n === 'SHELTER IN PLACE WARNING' ||
            n === 'TORNADO WATCH' ||
            n === 'TSUNAMI WARNING' ||
            n === 'TSUNAMI WATCH' ||
            n === 'WINTER STORM WATCH' ||
            n === 'WINTER WEATHER ADVISORY'
        );
    };

    const eventNames = (() => {
        try {
            const fromHelper = (typeof getAllKnownEvents === 'function') ? getAllKnownEvents() : [];
            const asUpper = fromHelper.map((x) => String(x || '').toUpperCase()).filter(Boolean);
            const merged = Array.from(new Set([...asUpper, ...Object.keys(prefsMap)]));
            return merged.sort((a, b) => a.localeCompare(b));
        } catch {
            return Object.keys(prefsMap).sort((a, b) => a.localeCompare(b));
        }
    })();

    const renderEventRows = () => {
        if (!eventGrid) return;
        eventGrid.querySelectorAll('.event-row').forEach((el) => el.remove());

        eventNames.forEach((eventName) => {
            const key = String(eventName || '').toUpperCase();
            if (!key) return;

            const row = document.createElement('div');
            row.className = 'event-row';
            row.dataset.eventName = key;

            const label = document.createElement('div');
            label.className = 'event-label';
            label.textContent = key;

            const popupCell = document.createElement('div');
            popupCell.className = 'event-cell';
            const popupWrap = document.createElement('label');
            popupWrap.className = 'mini-toggle';
            const popupChk = document.createElement('input');
            popupChk.type = 'checkbox';
            popupChk.dataset.event = key;
            popupChk.dataset.kind = 'popup';
            popupChk.checked = getEffectiveSetting(key, 'popup');
            const popupSlider = document.createElement('span');
            popupSlider.className = 'mini-slider';
            popupWrap.appendChild(popupChk);
            popupWrap.appendChild(popupSlider);
            popupCell.appendChild(popupWrap);

            const soundCell = document.createElement('div');
            soundCell.className = 'event-cell';
            const soundWrap = document.createElement('label');
            soundWrap.className = 'mini-toggle';
            const soundChk = document.createElement('input');
            soundChk.type = 'checkbox';
            soundChk.dataset.event = key;
            soundChk.dataset.kind = 'sound';
            soundChk.checked = getEffectiveSetting(key, 'sound');
            const soundSlider = document.createElement('span');
            soundSlider.className = 'mini-slider';
            soundWrap.appendChild(soundChk);
            soundWrap.appendChild(soundSlider);
            soundCell.appendChild(soundWrap);

            row.appendChild(label);
            row.appendChild(popupCell);
            row.appendChild(soundCell);
            eventGrid.appendChild(row);
        });
    };

    const updateEventMeta = () => {
        if (!eventGrid || !eventMeta) return;
        const rows = Array.from(eventGrid.querySelectorAll('.event-row'));
        const visibleRows = rows.filter((row) => row.style.display !== 'none');
        let visibleTotal = 0;
        let visibleEnabled = 0;
        let totalAll = 0;
        let enabledAll = 0;
        rows.forEach((row) => {
            row.querySelectorAll('input[type="checkbox"]').forEach((chk) => {
                totalAll += 1;
                if (chk.checked) enabledAll += 1;
            });
        });
        visibleRows.forEach((row) => {
            row.querySelectorAll('input[type="checkbox"]').forEach((chk) => {
                visibleTotal += 1;
                if (chk.checked) visibleEnabled += 1;
            });
        });
        eventMeta.textContent = `${visibleRows.length} types - ${visibleEnabled}/${visibleTotal} enabled`;
        syncSummaryCards({
            visibleRows: visibleRows.length,
            enabledAll,
            totalAll
        });
        stampSettingsUpdated();
    };

    const applySearch = () => {
        const query = String(eventSearch && eventSearch.value ? eventSearch.value : '').trim().toLowerCase();
        eventGrid.querySelectorAll('.event-row').forEach((row) => {
            const name = String(row.dataset.eventName || '').toLowerCase();
            row.style.display = (!query || name.includes(query)) ? '' : 'none';
        });
        updateEventMeta();
    };

    const setVisibleRowsEnabled = (enabled) => {
        const rows = Array.from(eventGrid.querySelectorAll('.event-row')).filter((row) => row.style.display !== 'none');
        rows.forEach((row) => {
            const eventName = String(row.dataset.eventName || '').toUpperCase();
            const rec = ensureEventRecord(eventName);
            if (!rec) return;
            rec.popup = !!enabled;
            rec.sound = !!enabled;
            row.querySelectorAll('input[type="checkbox"]').forEach((chk) => {
                chk.checked = !!enabled;
            });
        });
        persistPrefsMap();
        updateEventMeta();
    };

    const applyImportantPreset = () => {
        const rows = Array.from(eventGrid.querySelectorAll('.event-row')).filter((row) => row.style.display !== 'none');
        rows.forEach((row) => {
            const eventName = String(row.dataset.eventName || '').toUpperCase();
            const value = isImportantEvent(eventName);
            const rec = ensureEventRecord(eventName);
            if (!rec) return;
            rec.popup = value;
            rec.sound = value;
            row.querySelectorAll('input[type="checkbox"]').forEach((chk) => {
                chk.checked = value;
            });
        });
        persistPrefsMap();
        updateEventMeta();
    };

    renderEventRows();
    applySearch();
    syncSummaryCards();
    stampSettingsUpdated();

    eventGrid.addEventListener('change', (e) => {
        const target = e.target;
        if (!(target instanceof HTMLInputElement) || target.type !== 'checkbox') return;
        const eventName = String(target.dataset.event || '').toUpperCase();
        const kind = String(target.dataset.kind || '');
        if (!eventName || (kind !== 'popup' && kind !== 'sound')) return;
        const rec = ensureEventRecord(eventName);
        if (!rec) return;
        rec[kind] = !!target.checked;
        persistPrefsMap();
        updateEventMeta();
    });

    if (eventSearch) eventSearch.addEventListener('input', applySearch);
    if (importantBtn) importantBtn.addEventListener('click', applyImportantPreset);
    if (enableAllBtn) enableAllBtn.addEventListener('click', () => setVisibleRowsEnabled(true));
    if (disableAllBtn) disableAllBtn.addEventListener('click', () => setVisibleRowsEnabled(false));

    if (alertVolumeSlider && alertVolumeValue) {
        alertVolumeSlider.addEventListener('input', () => {
            const raw = parseFloat(alertVolumeSlider.value || '70');
            const pct = Number.isFinite(raw) ? Math.max(0, Math.min(100, raw)) : 70;
            alertVolumeValue.textContent = `${pct}%`;
            persistBaseSettings();
        });
    }

    if (alertSoundsToggle) {
        alertSoundsToggle.addEventListener('change', () => {
            persistBaseSettings();
        });
    }

    if (notificationToggle) {
        notificationToggle.addEventListener('change', () => {
            persistBaseSettings();
        });
    }

    if (testSoundBtn && alertVolumeSlider) {
        testSoundBtn.addEventListener('click', async (e) => {
            e.preventDefault();
            try {
                const raw = parseFloat(alertVolumeSlider.value || '70');
                const vol = (Number.isFinite(raw) ? Math.max(0, Math.min(100, raw)) : 70) / 100;
                const audio = new Audio('RHY_Ding.m4a');
                audio.volume = vol;
                await audio.play();
                setTimeout(() => {
                    try { audio.pause(); } catch {}
                    try { audio.src = ''; } catch {}
                }, 1400);
            } catch {}
        });
    }

    if (closeBtn) closeBtn.addEventListener('click', closeModal);
    if (saveBtn) {
        saveBtn.addEventListener('click', () => {
            persistBaseSettings();
            closeModal();
        });
    }

    modal.addEventListener('click', (e) => {
        if (e.target === modal) closeModal();
    });

    document.addEventListener('keydown', handleEsc);
}
// Show a native desktop notification if allowed by user and browser permission
function maybeShowDesktopNotification(warning) {
    return;
}

function setupSidebarControls() {
    // Forecast type controls
    const forecastTypeRadios = document.querySelectorAll('input[name="forecast-type"]');
    forecastTypeRadios.forEach(radio => {
        radio.addEventListener('change', (e) => {
            const forecastType = e.target.value;
            updateForecastType(forecastType);
        });
    });

    // Day selection controls
    const dayRadios = document.querySelectorAll('input[name="day"]');
    dayRadios.forEach(radio => {
        radio.addEventListener('change', (e) => {
            const day = e.target.value;
            updateDaySelection(day);
        });
    });

    // Map style controls
    const mapStyleRadios = document.querySelectorAll('input[name="map-style"]');
    mapStyleRadios.forEach(radio => {
        radio.addEventListener('change', (e) => {
            const mapStyle = e.target.value;
            updateMapStyle(mapStyle);
        });
    });

    // Overlay options controls
    const overlayCheckboxes = document.querySelectorAll('input[type="checkbox"]');
    overlayCheckboxes.forEach(checkbox => {
        checkbox.addEventListener('change', (e) => {
            const overlay = e.target.name;
            const isChecked = e.target.checked;
            updateOverlay(overlay, isChecked);
        });
    });
}

function updateForecastType(type) {
    console.log('Forecast type changed to:', type);
    
    // Update the forecast category display
    const categoryElement = document.querySelector('.forecast-category');
    if (categoryElement) {
        const currentDay = document.querySelector('input[name="day"]:checked')?.value || 'day1';
        categoryElement.textContent = `SPC : ${type.toUpperCase()} : ${currentDay.toUpperCase()}`;
    }
    
    // Update map title
    const mapTitle = document.querySelector('.map-title');
    if (mapTitle) {
        const titles = {
            'categorical': 'SEVERE THUNDERSTORM FORECAST',
            'probabilistic': 'SEVERE PROBABILITY FORECAST',
            'hail': 'HAIL PROBABILITY FORECAST',
            'wind': 'WIND PROBABILITY FORECAST',
            'tornado': 'TORNADO PROBABILITY FORECAST'
        };
        mapTitle.textContent = titles[type] || 'SEVERE THUNDERSTORM FORECAST';
    }
    
    // Update the SPC outlook data based on forecast type
    updateSPCOutlookData(type);
}

function updateDaySelection(day) {
    console.log('Day selection changed to:', day);
    
    // Update the forecast category display
    const categoryElement = document.querySelector('.forecast-category');
    if (categoryElement) {
        const forecastType = document.querySelector('input[name="forecast-type"]:checked')?.value || 'categorical';
        categoryElement.textContent = `SPC : ${forecastType.toUpperCase()} : ${day.toUpperCase()}`;
    }
    
    // Update validity box with appropriate dates
    updateValidityBox(day);
    
    // Update the SPC outlook data based on day
    const forecastType = document.querySelector('input[name="forecast-type"]:checked')?.value || 'categorical';
    updateSPCOutlookData(forecastType, day);
}

function updateSPCOutlookData(type = 'categorical', day = 'day1') {
    // Update the canvas map with new data
    const canvas = document.getElementById('spc-map-canvas');
    if (canvas) {
        drawSPCMap(canvas, type, day);
    }
}

function generateSPCOutlookData(type, day) {
    // Generate different risk patterns based on forecast type and day
    const baseCoordinates = {
        'day1': { center: [-95, 40], spread: 1.5 },
        'day2': { center: [-90, 38], spread: 1.2 },
        'day3': { center: [-85, 36], spread: 1.0 },
        'day4-8': { center: [-80, 34], spread: 0.8 }
    };
    
    const coords = baseCoordinates[day] || baseCoordinates['day1'];
    
    // Adjust risk levels based on forecast type
    const riskAdjustments = {
        'categorical': { moderate: 0.8, enhanced: 1.0, slight: 1.2, marginal: 1.5 },
        'probabilistic': { moderate: 0.6, enhanced: 0.8, slight: 1.0, marginal: 1.3 },
        'hail': { moderate: 1.2, enhanced: 1.0, slight: 0.8, marginal: 0.6 },
        'wind': { moderate: 0.9, enhanced: 1.1, slight: 1.0, marginal: 0.8 },
        'tornado': { moderate: 0.7, enhanced: 0.9, slight: 1.1, marginal: 1.4 }
    };
    
    const adjustments = riskAdjustments[type] || riskAdjustments['categorical'];
    
    return {
        type: 'FeatureCollection',
        features: [
            // General Thunderstorm (always present)
            {
                type: 'Feature',
                properties: { risk: 'general', description: 'General Thunderstorm Risk' },
                geometry: {
                    type: 'Polygon',
                    coordinates: [[
                        [-105, 50], [-65, 50], [-65, 25], [-105, 25], [-105, 50]
                    ]]
                }
            },
            // Marginal Risk
            {
                type: 'Feature',
                properties: { risk: 'marginal', description: 'Marginal Risk - Isolated Severe Storms' },
                geometry: {
                    type: 'Polygon',
                    coordinates: [[
                        [coords.center[0] - 5 * adjustments.marginal, coords.center[1] + 5 * adjustments.marginal],
                        [coords.center[0] + 5 * adjustments.marginal, coords.center[1] + 5 * adjustments.marginal],
                        [coords.center[0] + 5 * adjustments.marginal, coords.center[1] - 5 * adjustments.marginal],
                        [coords.center[0] - 5 * adjustments.marginal, coords.center[1] - 5 * adjustments.marginal],
                        [coords.center[0] - 5 * adjustments.marginal, coords.center[1] + 5 * adjustments.marginal]
                    ]]
                }
            },
            // Slight Risk
            {
                type: 'Feature',
                properties: { risk: 'slight', description: 'Slight Risk - Scattered Severe Storms' },
                geometry: {
                    type: 'Polygon',
                    coordinates: [[
                        [coords.center[0] - 3 * adjustments.slight, coords.center[1] + 3 * adjustments.slight],
                        [coords.center[0] + 3 * adjustments.slight, coords.center[1] + 3 * adjustments.slight],
                        [coords.center[0] + 3 * adjustments.slight, coords.center[1] - 3 * adjustments.slight],
                        [coords.center[0] - 3 * adjustments.slight, coords.center[1] - 3 * adjustments.slight],
                        [coords.center[0] - 3 * adjustments.slight, coords.center[1] + 3 * adjustments.slight]
                    ]]
                }
            },
            // Enhanced Risk
            {
                type: 'Feature',
                properties: { risk: 'enhanced', description: 'Enhanced Risk - Numerous Severe Storms' },
                geometry: {
                    type: 'Polygon',
                    coordinates: [[
                        [coords.center[0] - 2 * adjustments.enhanced, coords.center[1] + 2 * adjustments.enhanced],
                        [coords.center[0] + 2 * adjustments.enhanced, coords.center[1] + 2 * adjustments.enhanced],
                        [coords.center[0] + 2 * adjustments.enhanced, coords.center[1] - 2 * adjustments.enhanced],
                        [coords.center[0] - 2 * adjustments.enhanced, coords.center[1] - 2 * adjustments.enhanced],
                        [coords.center[0] - 2 * adjustments.enhanced, coords.center[1] + 2 * adjustments.enhanced]
                    ]]
                }
            },
            // Moderate Risk (only for certain conditions)
            ...(Math.random() > 0.5 ? [{
                type: 'Feature',
                properties: { risk: 'moderate', description: 'Moderate Risk - Widespread Severe Storms' },
                geometry: {
                    type: 'Polygon',
                    coordinates: [[
                        [coords.center[0] - 1.5 * adjustments.moderate, coords.center[1] + 1.5 * adjustments.moderate],
                        [coords.center[0] + 1.5 * adjustments.moderate, coords.center[1] + 1.5 * adjustments.moderate],
                        [coords.center[0] + 1.5 * adjustments.moderate, coords.center[1] - 1.5 * adjustments.moderate],
                        [coords.center[0] - 1.5 * adjustments.moderate, coords.center[1] - 1.5 * adjustments.moderate],
                        [coords.center[0] - 1.5 * adjustments.moderate, coords.center[1] + 1.5 * adjustments.moderate]
                    ]]
                }
            }] : [])
        ]
    };
}

// V2: Per-event popup and sound preferences
try {
    const v2 = JSON.parse(localStorage.getItem('alertPreferencesV2') || 'null');
    window.alertPreferencesV2 = (v2 && typeof v2 === 'object' && v2.events) ? v2 : { events: {} };
} catch { window.alertPreferencesV2 = { events: {} }; }

// Helper: list all known events (from color map and current warnings)
function getAllKnownEvents() {
    const set = new Set();
    // From palette
    if (EVENT_COLOR_MAP && typeof EVENT_COLOR_MAP.forEach === 'function') {
        EVENT_COLOR_MAP.forEach((_, key) => set.add(String(key).toUpperCase()));
    }
    // From current data
    try {
        (allWarnings || []).forEach(w => {
            const name = getDisplayEventName(w.properties?.event, w.properties);
            if (name) set.add(String(name).toUpperCase());
        });
    } catch {}
    // Common emergencies if not present
    ['TORNADO EMERGENCY', 'FLASH FLOOD EMERGENCY'].forEach(e => set.add(e));
    // Explicitly ensure these user-requested types always show up
    [
        '911 TELEPHONE OUTAGE',
        'BLIZZARD WARNING',
        'CIVIL DANGER WARNING',
        'EVACUATION IMMEDIATE',
        'ICE STORM WARNING',
        'LAW ENFORCEMENT WARNING',
        'SEVERE THUNDERSTORM WATCH',
        'SHELTER IN PLACE WARNING',
        'TORNADO WATCH',
        'TSUNAMI WARNING',
        'TSUNAMI WATCH',
        'WINTER STORM WATCH',
        'WINTER WEATHER ADVISORY'
    ].forEach(e => set.add(e));
    return Array.from(set).sort();
}

// Helper: per-event allow check for popup or sound
function isEventAllowed(displayEvent, kind /* 'popup' | 'sound' */) {
    const key = String(displayEvent || '').toUpperCase();
    const v2 = (window.alertPreferencesV2 && window.alertPreferencesV2.events) ? window.alertPreferencesV2.events : {};
    const rec = v2[key];
    if (rec && typeof rec[kind] === 'boolean') return rec[kind];
    try {
        if (typeof isEventNotificationEnabled === 'function') {
            return !!isEventNotificationEnabled(key);
        }
    } catch {}
    return true;
}

function updateValidityBox(day) {
    const validityBox = document.querySelector('.validity-box');
    if (!validityBox) return;
    
    const now = new Date();
    const validityDates = {
        'day1': {
            start: new Date(now.getTime() + 24 * 60 * 60 * 1000), // Tomorrow
            end: new Date(now.getTime() + 48 * 60 * 60 * 1000)   // Day after tomorrow
        },
        'day2': {
            start: new Date(now.getTime() + 48 * 60 * 60 * 1000),
            end: new Date(now.getTime() + 72 * 60 * 60 * 1000)
        },
        'day3': {
            start: new Date(now.getTime() + 72 * 60 * 60 * 1000),
            end: new Date(now.getTime() + 96 * 60 * 60 * 1000)
        },
        'day4-8': {
            start: new Date(now.getTime() + 96 * 60 * 60 * 1000),
            end: new Date(now.getTime() + 192 * 60 * 60 * 1000)
        }
    };
    
    const dates = validityDates[day] || validityDates['day1'];
    
    const validityItems = validityBox.querySelectorAll('.validity-item');
    if (validityItems.length >= 2) {
        // Update start date
        const startDate = validityItems[0];
        const startDay = startDate.querySelector('div:nth-child(2)');
        const startTime = startDate.querySelector('div:nth-child(3)');
        if (startDay && startTime) {
            startDay.textContent = dates.start.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
            startTime.textContent = dates.start.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
        }
        
        // Update end date
        const endDate = validityItems[1];
        const endDay = endDate.querySelector('div:nth-child(2)');
        const endTime = endDate.querySelector('div:nth-child(3)');
        if (endDay && endTime) {
            endDay.textContent = dates.end.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
            endTime.textContent = dates.end.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
        }
    }
}

function updateMapStyle(style) {
    console.log('Map style changed to:', style);
    
    if (!window.forecastMap) return;
    
    try {
        // Get current center and zoom
        const center = window.forecastMap.getCenter();
        const zoom = window.forecastMap.getZoom();
        
        // Define different map styles
        const mapStyles = {
            'dark': {
                version: 8,
                sources: {
                    'osm': {
                        type: 'raster',
                        tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
                        tileSize: 256,
                        attribution: 'Â© OpenStreetMap contributors'
                    }
                },
                layers: [
                    {
                        id: 'osm-tiles',
                        type: 'raster',
                        source: 'osm',
                        minzoom: 0,
                        maxzoom: 19
                    }
                ]
            },
            'satellite': {
                version: 8,
                sources: {
                    'satellite': {
                        type: 'raster',
                        tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
                        tileSize: 256,
                        attribution: 'Â© Esri'
                    }
                },
                layers: [
                    {
                        id: 'satellite-tiles',
                        type: 'raster',
                        source: 'satellite',
                        minzoom: 0,
                        maxzoom: 22
                    }
                ]
            },
            'terrain': {
                version: 8,
                sources: {
                    'terrain': {
                        type: 'raster',
                        tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}'],
                        tileSize: 256,
                        attribution: 'Â© Esri'
                    }
                },
                layers: [
                    {
                        id: 'terrain-tiles',
                        type: 'raster',
                        source: 'terrain',
                        minzoom: 0,
                        maxzoom: 22
                    }
                ]
            },
            'street': {
                version: 8,
                sources: {
                    'street': {
                        type: 'raster',
                        tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}'],
                        tileSize: 256,
                        attribution: 'Â© Esri'
                    }
                },
                layers: [
                    {
                        id: 'street-tiles',
                        type: 'raster',
                        source: 'street',
                        minzoom: 0,
                        maxzoom: 22
                    }
                ]
            }
        };
        
        // Set new style
        window.forecastMap.setStyle(mapStyles[style] || mapStyles.dark);
        
        // Restore center and zoom after style loads
        window.forecastMap.once('style.load', () => {
            window.forecastMap.setCenter(center);
            window.forecastMap.setZoom(zoom);
            
            // Re-add all layers after style change
            addStateBoundaries();
            addMockSPCOutlook();
            addCities();
        });
    } catch (error) {
        console.error('Failed to update map style:', error);
    }
}

function updateOverlay(overlay, isVisible) {
    console.log('Overlay', overlay, 'visibility changed to:', isVisible);
    
    const canvas = document.getElementById('spc-map-canvas');
    if (!canvas) return;
    
    // Redraw the map with updated overlay settings
    const currentType = document.querySelector('input[name="forecast-type"]:checked')?.value || 'categorical';
    const currentDay = document.querySelector('input[name="day"]:checked')?.value || 'day1';
    
    // Store overlay state
    if (!window.overlayState) {
        window.overlayState = {};
    }
    window.overlayState[overlay] = isVisible;
    
    // Redraw map with current settings
    drawSPCMap(canvas, currentType, currentDay);
    
    // Handle specific overlay toggles
    switch (overlay) {
        case 'cities':
            // Cities are always drawn on the canvas
            break;
        case 'counties':
            // State boundaries are always drawn on the canvas
            break;
        case 'roads':
            // Add visual indication that roads are enabled
            if (isVisible) {
                addRoadsToCanvas(canvas);
            }
            break;
        case 'radar':
            // Add visual indication that radar is enabled
            if (isVisible) {
                addRadarToCanvas(canvas);
            }
            break;
        case 'satellite':
            // Add visual indication that satellite is enabled
            if (isVisible) {
                addSatelliteToCanvas(canvas);
            }
            break;
        case 'header':
            // Toggle header visibility
            const mapHeader = document.querySelector('.map-header');
            if (mapHeader) {
                mapHeader.style.display = isVisible ? 'block' : 'none';
            }
            break;
    }
}

function addRoadsToCanvas(canvas) {
    const ctx = canvas.getContext('2d');
    const width = canvas.width;
    const height = canvas.height;
    
    // Draw major interstate highways
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.6)';
    ctx.lineWidth = 2;
    
    // I-35 (vertical)
    ctx.beginPath();
    ctx.moveTo(width / 2, 100);
    ctx.lineTo(width / 2, height - 100);
    ctx.stroke();
    
    // I-80 (horizontal)
    ctx.beginPath();
    ctx.moveTo(100, height / 2);
    ctx.lineTo(width - 100, height / 2);
    ctx.stroke();
    
    // I-90 (horizontal, upper)
    ctx.beginPath();
    ctx.moveTo(100, height / 3);
    ctx.lineTo(width - 100, height / 3);
    ctx.stroke();
}

function addRadarToCanvas(canvas) {
    const ctx = canvas.getContext('2d');
    const width = canvas.width;
    const height = canvas.height;
    
    // Add radar-like circles
    ctx.strokeStyle = 'rgba(0, 255, 0, 0.4)';
    ctx.lineWidth = 1;
    
    for (let i = 1; i <= 3; i++) {
        ctx.beginPath();
        ctx.arc(width / 2, height / 2, 50 * i, 0, 2 * Math.PI);
        ctx.stroke();
    }
}

function addSatelliteToCanvas(canvas) {
    const ctx = canvas.getContext('2d');
    const width = canvas.width;
    const height = canvas.height;
    
    // Add cloud-like patterns
    ctx.fillStyle = 'rgba(255, 255, 255, 0.1)';
    
    for (let i = 0; i < 5; i++) {
        const x = Math.random() * width;
        const y = Math.random() * height;
        const radius = 20 + Math.random() * 30;
        
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, 2 * Math.PI);
        ctx.fill();
    }
}

function addMajorRoads() {
    if (!window.forecastMap || window.forecastMap.getSource('major-roads')) return;
    
    // Add major interstate highways
    const majorRoads = {
        type: 'FeatureCollection',
        features: [
            // I-35
            {
                type: 'Feature',
                properties: { name: 'I-35' },
                geometry: {
                    type: 'LineString',
                    coordinates: [[-97.743, 30.267], [-97.743, 35.222], [-97.743, 40.000], [-97.743, 45.000]]
                }
            },
            // I-80
            {
                type: 'Feature',
                properties: { name: 'I-80' },
                geometry: {
                    type: 'LineString',
                    coordinates: [[-120.000, 39.000], [-110.000, 39.000], [-100.000, 39.000], [-90.000, 39.000], [-80.000, 39.000]]
                }
            },
            // I-90
            {
                type: 'Feature',
                properties: { name: 'I-90' },
                geometry: {
                    type: 'LineString',
                    coordinates: [[-120.000, 45.000], [-110.000, 45.000], [-100.000, 45.000], [-90.000, 45.000], [-80.000, 45.000]]
                }
            }
        ]
    };
    
    window.forecastMap.addSource('major-roads', {
        type: 'geojson',
        data: majorRoads
    });
    
    window.forecastMap.addLayer({
        id: 'major-roads',
        type: 'line',
        source: 'major-roads',
        paint: {
            'line-color': '#ffffff',
            'line-width': 2,
            'line-opacity': 0.6
        }
    });
}

function addRadarOverlay() {
    if (!window.forecastMap || window.forecastMap.getSource('radar-overlay')) return;
    
    // Add a mock radar overlay since real radar tiles have CORS issues
    const radarData = {
        type: 'FeatureCollection',
        features: [
            {
                type: 'Feature',
                properties: { intensity: 'light' },
                geometry: {
                    type: 'Polygon',
                    coordinates: [[
                        [-100, 45], [-85, 45], [-85, 35], [-100, 35], [-100, 45]
                    ]]
                }
            },
            {
                type: 'Feature',
                properties: { intensity: 'moderate' },
                geometry: {
                    type: 'Polygon',
                    coordinates: [[
                        [-95, 42], [-90, 42], [-90, 38], [-95, 38], [-95, 42]
                    ]]
                }
            }
        ]
    };
    
    window.forecastMap.addSource('radar-overlay', {
        type: 'geojson',
        data: radarData
    });
    
    window.forecastMap.addLayer({
        id: 'radar-overlay',
        type: 'fill',
        source: 'radar-overlay',
        paint: {
            'fill-color': [
                'match',
                ['get', 'intensity'],
                'light', 'rgba(0, 255, 0, 0.3)',
                'moderate', 'rgba(255, 255, 0, 0.4)',
                'rgba(0, 255, 0, 0.2)'
            ]
        }
    });
}

function addSatelliteOverlay() {
    if (!window.forecastMap || window.forecastMap.getSource('satellite-overlay')) return;
    
    // Add a mock satellite overlay since real satellite tiles have CORS issues
    const satelliteData = {
        type: 'FeatureCollection',
        features: [
            {
                type: 'Feature',
                properties: { cloud: 'high' },
                geometry: {
                    type: 'Polygon',
                    coordinates: [[
                        [-105, 50], [-65, 50], [-65, 25], [-105, 25], [-105, 50]
                    ]]
                }
            }
        ]
    };
    
    window.forecastMap.addSource('satellite-overlay', {
        type: 'geojson',
        data: satelliteData
    });
    
    window.forecastMap.addLayer({
        id: 'satellite-overlay',
        type: 'fill',
        source: 'satellite-overlay',
        paint: {
            'fill-color': 'rgba(255, 255, 255, 0.1)',
            'fill-opacity': 0.3
        }
    });
}

function addMapLegend() {
    const mapContainer = document.getElementById('forecast-map');
    if (!mapContainer) return;
    
    // Create legend container
    const legend = document.createElement('div');
    legend.className = 'map-legend-overlay';
    legend.innerHTML = `
        <div class="legend-header">
            <h4>SPC RISK LEVELS</h4>
        </div>
        <div class="legend-items">
            <div class="legend-item">
                <div class="legend-color high"></div>
                <span>HIGH RISK</span>
            </div>
            <div class="legend-item">
                <div class="legend-color moderate"></div>
                <span>MODERATE RISK</span>
            </div>
            <div class="legend-item">
                <div class="legend-color enhanced"></div>
                <span>ENHANCED RISK</span>
            </div>
            <div class="legend-item">
                <div class="legend-color slight"></div>
                <span>SLIGHT RISK</span>
            </div>
            <div class="legend-item">
                <div class="legend-color marginal"></div>
                <span>MARGINAL RISK</span>
            </div>
            <div class="legend-item">
                <div class="legend-color general"></div>
                <span>GENERAL THUNDERSTORM</span>
            </div>
        </div>
    `;
    
    mapContainer.appendChild(legend);
}

// Global retry function for map initialization
window.retryMapInitialization = function() {
    console.log('Retrying map initialization...');
    if (window.forecastMap) {
        window.forecastMap.remove();
        window.forecastMap = null;
    }
    initializeForecastMap();
};

function createFallbackMap(container) {
    container.innerHTML = `
        <div style="
            width: 100%; 
            height: 100%; 
            background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
            position: relative;
            display: flex;
            align-items: center;
            justify-content: center;
            color: white;
            font-size: 1.2rem;
            border-radius: 8px;
        ">
            <div style="text-align: center;">
                <div style="font-size: 2rem; margin-bottom: 1rem;">ðŸ—ºï¸</div>
                <div>SPC Forecast Map</div>
                <div style="font-size: 0.9rem; opacity: 0.7; margin-top: 0.5rem;">Loading Storm Prediction Center data...</div>
                <button onclick="retryMapInitialization()" style="
                    margin-top: 1rem;
                    padding: 0.5rem 1rem;
                    background: rgba(255, 255, 255, 0.1);
                    border: 1px solid rgba(255, 255, 255, 0.3);
                    color: white;
                    border-radius: 4px;
                    cursor: pointer;
                    font-size: 0.9rem;
                ">Retry Map Load</button>
            </div>
        </div>
    `;
    
    // Add a simple SVG map as fallback
    setTimeout(() => {
        const svgMap = createSimpleSVGMap();
        container.innerHTML = svgMap;
        addMapLegend();
    }, 2000);
}

function createSimpleSVGMap() {
    return `
        <div style="
            width: 100%; 
            height: 100%; 
            background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
            position: relative;
            border-radius: 8px;
            overflow: hidden;
        ">
            <svg width="100%" height="100%" viewBox="0 0 800 600" style="position: absolute; top: 0; left: 0;">
                <!-- Background -->
                <rect width="100%" height="100%" fill="#1a1a2e"/>
                
                <!-- US Outline (simplified) -->
                <path d="M 100 100 L 700 100 L 700 500 L 100 500 Z" 
                      fill="none" stroke="#444" stroke-width="2"/>
                
                <!-- SPC Risk Areas -->
                <circle cx="400" cy="300" r="150" fill="rgba(255, 255, 0, 0.3)" stroke="#FFFF00" stroke-width="2"/>
                <circle cx="400" cy="300" r="100" fill="rgba(255, 165, 0, 0.4)" stroke="#FFA500" stroke-width="2"/>
                <circle cx="400" cy="300" r="50" fill="rgba(255, 0, 0, 0.5)" stroke="#FF0000" stroke-width="2"/>
                
                <!-- State boundaries (simplified) -->
                <line x1="200" y1="200" x2="600" y2="200" stroke="#666" stroke-width="1"/>
                <line x1="200" y1="300" x2="600" y2="300" stroke="#666" stroke-width="1"/>
                <line x1="200" y1="400" x2="600" y2="400" stroke="#666" stroke-width="1"/>
                <line x1="300" y1="100" x2="300" y2="500" stroke="#666" stroke-width="1"/>
                <line x1="400" y1="100" x2="400" y2="500" stroke="#666" stroke-width="1"/>
                <line x1="500" y1="100" x2="500" y2="500" stroke="#666" stroke-width="1"/>
                
                <!-- Major cities -->
                <circle cx="350" cy="250" r="3" fill="#fff"/>
                <text x="355" y="255" fill="#fff" font-size="10">Chicago</text>
                
                <circle cx="450" cy="280" r="3" fill="#fff"/>
                <text x="455" y="285" fill="#fff" font-size="10">Detroit</text>
                
                <circle cx="380" cy="320" r="3" fill="#fff"/>
                <text x="385" y="325" fill="#fff" font-size="10">Indianapolis</text>
                
                <circle cx="420" cy="350" r="3" fill="#fff"/>
                <text x="425" y="355" fill="#fff" font-size="10">Cincinnati</text>
            </svg>
            
            <!-- Map title -->
            <div style="
                position: absolute;
                top: 20px;
                left: 20px;
                color: white;
                font-size: 1.2rem;
                font-weight: bold;
                z-index: 10;
            ">SEVERE THUNDERSTORM FORECAST</div>
            
            <!-- Validity box -->
            <div style="
                position: absolute;
                bottom: 20px;
                right: 20px;
                background: rgba(0, 0, 0, 0.8);
                border: 1px solid #444;
                border-radius: 4px;
                padding: 1rem;
                color: #ffffff;
                font-size: 0.75rem;
                font-weight: 500;
                min-width: 120px;
            ">
                <div>VALID: Tomorrow, 4:00 AM</div>
                <div>VALID: Day After, 8:00 AM</div>
            </div>
        </div>
    `;
}

function isNewWarning(warningId) {
    return newWarnings.has(warningId);
}

function clearNewWarningStatus(warningId) {
    newWarnings.delete(warningId);
}

function hasBeenAnimated(warningId) {
    return animatedWarnings.has(warningId);
}

function markAsAnimated(warningId) {
    animatedWarnings.add(warningId);
}

function normalizeWeatherWiseRadarCode(raw) {
    const clean = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!clean) return '';
    if (clean.length === 4) return clean;
    if (clean.length === 3) return `K${clean}`;
    return clean.slice(0, 4);
}

function parseWeatherWiseRadarStations(payload) {
    const features = payload && Array.isArray(payload.features) ? payload.features : [];
    if (!features.length) return [];

    const byCode = new Map();
    features.forEach((feature) => {
        const coords = feature && feature.geometry && Array.isArray(feature.geometry.coordinates)
            ? feature.geometry.coordinates
            : null;
        if (!coords || coords.length < 2) return;

        const lon = Number(coords[0]);
        const lat = Number(coords[1]);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;

        const p = feature && feature.properties ? feature.properties : {};
        const code = normalizeWeatherWiseRadarCode(p.stationIdentifier || p.id || feature.id || '');
        if (!code || !/^[A-Z][A-Z0-9]{3}$/.test(code)) return;
        if (!byCode.has(code)) byCode.set(code, { code, lat, lon });
    });

    return Array.from(byCode.values());
}

async function loadWeatherWiseRadarStations() {
    const now = Date.now();
    const hasFreshCache = weatherWiseRadarStationCache.length
        && (now - weatherWiseRadarStationCacheFetchedAt) < WEATHERWISE_RADAR_STATION_CACHE_TTL_MS;
    if (hasFreshCache) return weatherWiseRadarStationCache;
    if (weatherWiseRadarStationCachePromise) return weatherWiseRadarStationCachePromise;

    weatherWiseRadarStationCachePromise = (async () => {
        try {
            const response = await fetch(WEATHERWISE_RADAR_STATIONS_URL, {
                headers: { 'Accept': 'application/geo+json, application/json' }
            });
            if (!response.ok) throw new Error(`radar stations fetch failed (${response.status})`);
            const data = await response.json();
            const stations = parseWeatherWiseRadarStations(data);
            if (stations.length) {
                weatherWiseRadarStationCache = stations;
                weatherWiseRadarStationCacheFetchedAt = Date.now();
            }
            return weatherWiseRadarStationCache;
        } catch (err) {
            console.warn('WeatherWise radar station cache update failed:', err);
            return weatherWiseRadarStationCache;
        } finally {
            weatherWiseRadarStationCachePromise = null;
        }
    })();

    return weatherWiseRadarStationCachePromise;
}

function primeWeatherWiseRadarStations() {
    try { void loadWeatherWiseRadarStations(); } catch {}
}

function weatherWiseDistanceKm(lat1, lon1, lat2, lon2) {
    const toRad = (deg) => (Number(deg) * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2)
        + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2))
        * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return 6371 * c;
}

function findNearestWeatherWiseRadarCode(lat, lon) {
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !weatherWiseRadarStationCache.length) return '';
    let bestCode = '';
    let bestDistance = Infinity;
    weatherWiseRadarStationCache.forEach((station) => {
        const distance = weatherWiseDistanceKm(lat, lon, station.lat, station.lon);
        if (distance < bestDistance) {
            bestDistance = distance;
            bestCode = station.code;
        }
    });
    return bestCode;
}

function getWarningRadarFallbackCode(warning) {
    const props = warning && warning.properties ? warning.properties : {};
    const directCode = normalizeWeatherWiseRadarCode(wwPosterParam(props, [
        'radarStation',
        'radarSite',
        'radar',
        'radarId',
        'radarID'
    ]));
    if (/^[A-Z][A-Z0-9]{3}$/.test(directCode)) return directCode;

    const officeCode = normalizeWeatherWiseRadarCode(wwPosterParam(props, ['office', 'WFO']));
    if (/^[A-Z][A-Z0-9]{3}$/.test(officeCode)) return officeCode;
    return '';
}

function buildWeatherWiseMapLink(lat, lon, options = {}) {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return WEATHERWISE_POPOUT_URL;
    const mode = String(options.mode || 'RADAR').toUpperCase();
    const radarCode = normalizeWeatherWiseRadarCode(options.radarCode || '');
    const baseUrl = 'https://web.weatherwise.app/?utm_medium=social&utm_source=ww_share';
    const params = [
        `map=9.84/${Number(lat).toFixed(4)}/${Number(lon).toFixed(4)}`,
        `m=${encodeURIComponent(mode)}`,
        'sc=GOES-East',
        'sp=ABI_GeoColor'
    ];
    if (mode === 'RADAR') params.push('mid=HRRR-SUBHOURLY');
    params.push('mr=CONUS');
    if (mode === 'RADAR' && /^[A-Z][A-Z0-9]{3}$/.test(radarCode)) {
        params.push(`rt=${encodeURIComponent(radarCode)}`);
    }
    return `${baseUrl}#${params.join('&')}`;
}

function getWarningWeatherWiseCenter(warning) {
    return wwPosterCentroid(warning && warning.geometry ? warning.geometry : null);
}

function generateWeatherWiseLink(warning) {
    const center = getWarningWeatherWiseCenter(warning);
    if (!center) return null;

    primeWeatherWiseRadarStations();
    const radarCode = findNearestWeatherWiseRadarCode(center.lat, center.lon) || getWarningRadarFallbackCode(warning);
    return buildWeatherWiseMapLink(center.lat, center.lon, { mode: 'RADAR', radarCode });
}

// Build a small set of WeatherWise deep links (Radar and Satellite) for a warning's centroid
function generateWeatherWiseLinks(warning) {
    const center = getWarningWeatherWiseCenter(warning);
    if (!center) return null;

    primeWeatherWiseRadarStations();
    const radarCode = findNearestWeatherWiseRadarCode(center.lat, center.lon) || getWarningRadarFallbackCode(warning);
    const radar = buildWeatherWiseMapLink(center.lat, center.lon, { mode: 'RADAR', radarCode });
    const satellite = buildWeatherWiseMapLink(center.lat, center.lon, { mode: 'SATELLITE' });
    return { radar, satellite };
}
primeWeatherWiseRadarStations();

function processNotificationQueue() {
    if (window.notificationPopupsEnabled === false) return;
    // Sort the queue oldest -> newest so that the final (newest) ends at the top when prepended
    try {
        notificationQueue.sort((a, b) => {
            const pa = (a && a.properties) || {};
            const pb = (b && b.properties) || {};
            const ta = new Date(pa.issued || pa.sent || pa.effective || 0).getTime();
            const tb = new Date(pb.issued || pb.sent || pb.effective || 0).getTime();
            return (isFinite(ta) ? ta : 0) - (isFinite(tb) ? tb : 0);
        });
    } catch {}
    // Flush the queue: each item becomes/updates a card in the scrollable tray
    while (notificationQueue.length > 0) {
        const w = notificationQueue.shift();
        try { showWarningNotification(w); } catch {}
    }
    isShowingNotification = false;
    if (notificationTimer) { clearTimeout(notificationTimer); notificationTimer = null; }
}

function advanceNotificationQueue() {
    try {
        if (window.notificationPopupsEnabled === false) return;
        if (!isShowingNotification) return;
        if (notificationTimer) { clearTimeout(notificationTimer); notificationTimer = null; }
        if (notificationQueue.length === 0) {
            // Nothing else to show; keep the current (last) visible
            return;
        }
        const next = notificationQueue.shift();
        showWarningNotification(next);
        if (notificationQueue.length > 0) {
            notificationTimer = setTimeout(advanceNotificationQueue, 15000);
        } else {
            // Leave final one displayed
            notificationTimer = null;
        }
    } catch {}
}

function sortTrayCardsNewestFirst(trayList) {
    try {
        if (!trayList) return;
        const cards = Array.from(trayList.querySelectorAll('.tray-card.main'));
        cards.sort((a, b) => {
            const aMs = Number(a && a.dataset ? a.dataset.issuedMs : 0) || 0;
            const bMs = Number(b && b.dataset ? b.dataset.issuedMs : 0) || 0;
            return bMs - aMs;
        });
        cards.forEach(card => {
            try { trayList.appendChild(card); } catch {}
        });
    } catch {}
}

function backfillActiveAlertsTray(warnings) {
    try {
        const tray = ensureNotificationTray();
        if (!tray) return;
        const list = tray.querySelector('.warning-tray-list');
        if (!list) return;
        const active = (warnings || [])
            .filter((w) => {
                try { return shouldShowNotification(w); } catch { return false; }
            })
            .sort((a, b) => {
                const ap = (a && a.properties) || {};
                const bp = (b && b.properties) || {};
                const at = new Date(ap.sent || ap.issued || ap.effective || ap.onset || 0).getTime();
                const bt = new Date(bp.sent || bp.issued || bp.effective || bp.onset || 0).getTime();
                return (isFinite(bt) ? bt : 0) - (isFinite(at) ? at : 0);
            });
        active.forEach((warning) => {
            try {
                if (warning && warning.id) playedAlertSoundFor.add(warning.id);
                showWarningNotification(warning);
            } catch {}
        });
        tray.style.display = 'block';
        tray.classList.add('open');
        positionWarningTray();
        try { syncTrayLayoutState(); } catch {}
    } catch {}
}

function showWarningNotification(warning) {
    isShowingNotification = true;
    const props = warning.properties || {};
    const tray = ensureNotificationTray();
    const trayList = tray.querySelector('.warning-tray-list') || tray;
    tray.style.display = 'block';
    tray.classList.add('open');
    positionWarningTray();

    // Unique card per warning
    const safeId = String(warning.id || '').replace(/[^A-Za-z0-9_-]+/g, '_');
    const cardId = 'tray-card-' + safeId;
    let notification = document.getElementById(cardId);
    if (!notification) {
        notification = document.createElement('div');
        notification.className = 'tray-card main';
        notification.id = cardId;
        try { notification.dataset.warningId = warning.id || ''; } catch {}
        // New items should appear at the top (newest first)
        if (trayList.firstChild) trayList.insertBefore(notification, trayList.firstChild);
        else trayList.appendChild(notification);
    } else {
        // Move existing card to top on update
        try {
            if (trayList.firstChild) trayList.insertBefore(notification, trayList.firstChild);
            else trayList.appendChild(notification);
        } catch {}
    }
    try { syncTrayLayoutState(); } catch {}

    const baseEventName = getDisplayEventName(props.event, props);
    const eventName = baseEventName;
    const color = getEventColor(eventName) || '#60a5fa';
    const warningId = warning.id;
    const isImportantForTray = shouldShowNotification(warning);
    const isTestAlert = !!(isTestWarningFeature(warning) || String(props.messageType || '').toLowerCase() === 'test');
    const isNew = !!(newlyIssuedWarnings && newlyIssuedWarnings.has && newlyIssuedWarnings.has(warningId));
    const wasUpgraded = !!(warningUpgradeFlags && warningUpgradeFlags.has && warningUpgradeFlags.has(warningId));
    const statusClass = wasUpgraded ? 'is-upgraded' : (isNew ? 'is-new' : 'is-live');
    const combinedStatusClass = `${statusClass}${isTestAlert ? ' is-test' : ''}`;
    try {
        notification.classList.toggle('fresh-alert', isNew || wasUpgraded);
        notification.classList.toggle('upgraded-alert', wasUpgraded);
    } catch {}

    const minutesRemaining = (() => {
        if (!props.expires) return null;
        const now = new Date();
        const exp = new Date(props.expires);
        return Math.max(0, Math.round((exp - now) / 60000));
    })();

    const issuedTs = props.sent || props.issued || props.effective || props.onset || '';
    const issuedMs = (() => {
        const t = new Date(issuedTs || 0).getTime();
        return Number.isFinite(t) ? t : 0;
    })();
    try { notification.dataset.issuedMs = String(issuedMs); } catch {}
    const issuedAgoMin = issuedTs ? Math.max(0, Math.round((Date.now() - new Date(issuedTs).getTime()) / 60000)) : null;
    const issuedText = issuedAgoMin == null ? '-- AGO' : `${formatTrayDuration(issuedAgoMin)} AGO`;
    const expText = minutesRemaining == null ? '--' : formatTrayDuration(minutesRemaining);
    const areaText = formatAreas(props.areaDesc || '', {
        fallback: 'Multiple Counties',
        upperCase: false
    });
    const getParamValue = (...keys) => {
        try {
            const params = props.parameters || {};
            for (const key of keys) {
                if (params[key] == null) continue;
                const raw = Array.isArray(params[key]) ? params[key][0] : params[key];
                const value = String(raw || '').trim();
                if (value) return value;
            }
        } catch {}
        return '';
    };
    const sourceTagValue = (() => {
        const sourceRaw = String(getSourceText(props) || '').replace(/\s+/g, ' ').trim();
        if (!sourceRaw) return '';
        return truncateWithEllipsis(sourceRaw, 30).toUpperCase();
    })();
    const maxHailValue = (() => {
        let raw = getParamValue('maxHailSize', 'MAXHAILSIZE');
        if (!raw) {
            const desc = String(props.description || '').toUpperCase();
            const m1 = desc.match(/(?:HAIL(?:\s+SIZE)?(?:\s+UP\s+TO|\s+OF)?\s*)(\d*\.\d+|\d+)\s*(?:INCH(?:ES)?|IN|")/);
            const m2 = desc.match(/(\d*\.\d+|\d+)\s*(?:INCH(?:ES)?|IN|")\s*(?:SIZE\s+)?HAIL/);
            raw = (m1 && m1[1]) || (m2 && m2[1]) || '';
        }
        if (!raw) return '';
        const up = String(raw).toUpperCase();
        const m = up.match(/\d*\.\d+|\d+/);
        if (m) return `${m[0]} IN`;
        return up.includes('IN') ? up : `${up} IN`;
    })();
    const maxWindValue = (() => {
        let raw = getParamValue('maxWindGust', 'MAXWINDGUST');
        if (!raw) {
            const desc = String(props.description || '').toUpperCase();
            const m1 = desc.match(/WIND(?:\s+GUSTS?)?(?:\s+UP\s+TO|\s+TO|\s+OF)?\s*(\d{2,3})\s*MPH/);
            const m2 = desc.match(/(\d{2,3})\s*MPH\s*(?:WIND(?:\s+GUSTS?)?)/);
            raw = (m1 && m1[1]) || (m2 && m2[1]) || '';
        }
        if (!raw) return '';
        const up = String(raw).toUpperCase();
        const m = up.match(/\d+(?:\.\d+)?/);
        if (m) return `${m[0]} MPH`;
        return up.includes('MPH') ? up : `${up} MPH`;
    })();
    const damageThreatValue = (() => {
        let value = String(getParamValue('damageThreat', 'DAMAGETHREAT') || '').toUpperCase();
        if (!value) {
            if (isDestructiveSevere(props)) value = 'DESTRUCTIVE';
            else if (isConsiderableSevere(props)) value = 'CONSIDERABLE';
            else {
                const m = String(props.description || '').toUpperCase().match(/DAMAGE\s+THREAT\s*[:.\-]*\s*([A-Z ]+)/);
                if (m && m[1]) value = m[1].trim();
            }
        }
        if (value.includes('DESTRUCTIVE')) return 'DESTRUCTIVE';
        if (value.includes('CONSIDERABLE')) return 'CONSIDERABLE';
        return value || '';
    })();
    const threatValue = (() => {
        if (isTornadoPossibleSevere(props)) return 'TORNADO POSSIBLE';
        const m = String(props.description || '').toUpperCase().match(/(^|\n)\s*THREAT\s*[:.\-]*\s*([^\n]+)/);
        if (m && m[2]) return m[2].trim().replace(/[.;,\s]+$/g, '') || '';
        return '';
    })();
    const trayTags = [];
    if (sourceTagValue) trayTags.push({ label: 'SOURCE', value: sourceTagValue, className: '' });
    if (maxHailValue) trayTags.push({ label: 'MAX HAIL', value: maxHailValue, className: '' });
    if (maxWindValue) trayTags.push({ label: 'MAX WIND', value: maxWindValue, className: '' });
    if (damageThreatValue) {
        trayTags.push({
            label: 'DAMAGE THREAT',
            value: damageThreatValue,
            className: damageThreatValue === 'DESTRUCTIVE' ? 'attn-danger' : (damageThreatValue === 'CONSIDERABLE' ? 'attn-warn' : '')
        });
    }
    if (threatValue) trayTags.push({ label: 'THREAT', value: threatValue, className: 'attn-warn' });
    const tagsHTML = trayTags.map(tag => `
                <span class="tray-tag${tag.className ? ` ${tag.className}` : ''}">
                    <span class="tag-label">${tag.label}</span>
                    <span class="tag-value">${escapeHtml(tag.value)}</span>
                </span>`).join('');

    const html = `
        <div class="tray-warning-card ${combinedStatusClass}" style="--tw-color:${color};--accent:${color};">
            <span class="evt">${escapeHtml(eventName)}</span>
            <span class="meta">
                <span class="meta-expire">EXPIRES <span class="expires-minutes" data-exp="${escapeHtml(String(props.expires || ''))}">${escapeHtml(expText)}</span></span>
                <span class="meta-issued"><span class="issued-minutes" data-sent="${escapeHtml(String(issuedTs || ''))}">${escapeHtml(issuedText)}</span></span>
            </span>
            <span class="area">${escapeHtml(areaText)}</span>
            ${tagsHTML ? `<div class="tray-tags">${tagsHTML}</div>` : ''}
        </div>`;
    notification.innerHTML = html;
    try { sortTrayCardsNewestFirst(trayList); } catch {}
    try { ensureTrayTimeUpdater(); } catch {}

    try {
        if (!isImportantForTray) {
            const ttlMs = 10000;
            const removeAt = Date.now() + ttlMs;
            notification.dataset.removeAt = String(removeAt);
            setTimeout(() => {
                try {
                    if (!notification || !notification.isConnected) return;
                    if (String(notification.dataset.removeAt || '') !== String(removeAt)) return;
                    removeTrayCardAndMaybeHide(notification);
                } catch {}
            }, ttlMs + 120);
        } else {
            delete notification.dataset.removeAt;
        }
    } catch {}

    // Clicking jumps to the warning card in the list
    const jump = () => { try { scrollWarningIntoView(warning.id); } catch {} };
    notification.onclick = jump;

    // Keep the newest (prepended) card visible at the top
    try { trayList.scrollTop = 0; } catch {}

    // Auto-dismiss Winter Weather Advisory after 10 seconds
    try {
        if (/^WINTER\s+WEATHER\s+ADVISORY$/i.test(eventName)) {
            setTimeout(() => {
                try {
                    // Remove this tray card
                    if (notification && notification.parentElement) {
                        notification.remove();
                        try { updateTrayEmptyState(); } catch {}
                        try { syncTrayLayoutState(); } catch {}
                    }
                } catch {}
            }, 10000);
        }
    } catch {}

    try {
        const id = warningId;
        const displayEventName = getDisplayEventName(props.event, props);
        if (!playedAlertSoundFor.has(id) && isEventAllowed(displayEventName, 'sound')) {
            playAlertSound(props.event, Object.assign({}, props));
            playedAlertSoundFor.add(id);
        }
        if (isNew || wasUpgraded) {
            try { if (typeof maybeShowDesktopNotification === 'function') maybeShowDesktopNotification(warning); } catch {}
        }
    } catch {}
}

function closeWarningNotification() {
    const notification = document.getElementById('warning-notification');
    if (notification) {
        notification.remove();
        isShowingNotification = false;
        try { updateTrayEmptyState(); } catch {}
        try { syncTrayLayoutState(); } catch {}
        // Stop timer and audio
        if (notificationTimer) { clearTimeout(notificationTimer); notificationTimer = null; }
        try { if (currentAlertAudio) { currentAlertAudio.pause(); currentAlertAudio.currentTime = 0; } } catch {}
        
        // Process next notification in queue
        setTimeout(() => {
            processNotificationQueue();
        }, 500);
    }
}

function removeTrayCardAndMaybeHide(cardEl, skipSync = false) {
    try {
        if (!cardEl) return;
        cardEl.remove();
        try { updateTrayEmptyState(); } catch {}
        if (!skipSync) {
            try { syncTrayLayoutState(); } catch {}
        }
    } catch {}
}

function pruneNonImportantTrayCards() {
    try {
        const tray = document.getElementById('warning-tray');
        if (!tray) return;
        const now = Date.now();
        let removedAny = false;
        tray.querySelectorAll('.tray-card.main').forEach((card) => {
            const removeAt = Number(card.dataset.removeAt || 0);
            if (removeAt && now >= removeAt) {
                removeTrayCardAndMaybeHide(card, true);
                removedAny = true;
                return;
            }

            const warningId = String(card.dataset.warningId || '');
            if (!warningId) return;
            const matched = (allWarnings || []).find(w => String(w?.id || '') === warningId);
            if (matched && !shouldShowNotification(matched)) {
                removeTrayCardAndMaybeHide(card, true);
                removedAny = true;
            }
        });
        if (removedAny) {
            try { syncTrayLayoutState(); } catch {}
        }
    } catch {}
}

function syncTrayLayoutState() {
    try {
        pruneNonImportantTrayCards();
        const tray = document.getElementById('warning-tray');
        try { updateTrayEmptyState(); } catch {}
        const isVisible = !!(tray && tray.style.display !== 'none');
        const isWarningsView = currentView !== 'map' && currentView !== 'ryan-live';
        const shouldOffset = isWarningsView && isVisible;
        document.body.classList.toggle('tray-open', shouldOffset);
    } catch {}
}

function updateTrayEmptyState() {
    const tray = document.getElementById('warning-tray');
    if (!tray) return;
    const list = tray.querySelector('.warning-tray-list');
    if (!list) return;
    let empty = list.querySelector('.tray-empty-state');
    if (!empty) {
        empty = document.createElement('div');
        empty.className = 'tray-empty-state';
        empty.textContent = 'No severe alerts right now';
        list.appendChild(empty);
    }
    const cardCount = list.querySelectorAll('.tray-card.main').length;
    empty.style.display = cardCount > 0 ? 'none' : 'block';
    list.classList.toggle('is-empty', cardCount === 0);
    tray.classList.toggle('is-empty', cardCount === 0);
}

// Ensure the right-side tray exists
function ensureNotificationTray() {
    let tray = document.getElementById('warning-tray');
    if (!tray) {
        tray = document.createElement('div');
        tray.id = 'warning-tray';
        tray.className = 'warning-tray';
        document.body.appendChild(tray);
    }
    let title = tray.querySelector('.tray-top-title');
    if (!title) {
        title = document.createElement('div');
        title.className = 'tray-top-title';
        tray.prepend(title);
    }
    // Always enforce tray header label
    title.textContent = 'Severe Alerts';
    let list = tray.querySelector('.warning-tray-list');
    if (!list) {
        list = document.createElement('div');
        list.className = 'warning-tray-list';
        const directCards = Array.from(tray.children).filter((child) => {
            return child && child.classList && child.classList.contains('tray-card');
        });
        directCards.forEach((card) => list.appendChild(card));
        tray.appendChild(list);
    }
    let empty = list.querySelector('.tray-empty-state');
    if (!empty) {
        empty = document.createElement('div');
        empty.className = 'tray-empty-state';
        empty.textContent = 'No severe alerts right now';
        list.appendChild(empty);
    }
    tray.classList.add('ryan-like-tray');
    const isWarningsView = currentView !== 'map' && currentView !== 'ryan-live';
    if (isWarningsView) {
        tray.style.display = 'block';
        tray.classList.add('open');
    }
    positionWarningTray();
    try { updateTrayEmptyState(); } catch {}
    try { syncTrayLayoutState(); } catch {}
    return tray;
}

// Position the tray along the full right side (below header to bottom)
function positionWarningTray() {
    const tray = document.getElementById('warning-tray');
    if (!tray) return;
    const topGap = 10;
    const bottomOffset = 10;
    let topOffset = 84;
    try {
        const header = document.querySelector('header') || document.getElementById('main-header') || document.querySelector('.main-header');
        if (header) {
            const rect = header.getBoundingClientRect();
            topOffset = Math.max(0, Math.round(rect.bottom + topGap));
        }
    } catch {}
    // Force placement against CSS variants that use !important overrides.
    tray.style.setProperty('top', `${topOffset}px`, 'important');
    tray.style.setProperty('bottom', `${bottomOffset}px`, 'important');
    tray.style.setProperty('height', 'auto', 'important');
    tray.style.setProperty('max-height', 'none', 'important');
}

// Center the left-side warning counter vertically between header bottom and viewport bottom
function positionLeftStatsVertically() {
    const left = document.getElementById('left-stats');
    if (!left) return;
    try {
        const header = document.querySelector('header') || document.getElementById('main-header') || document.querySelector('.main-header');
        const headerBottom = header ? header.getBoundingClientRect().bottom : 0;
        // Compute the midpoint between header bottom and viewport bottom
        const mid = headerBottom + (window.innerHeight - headerBottom) / 2;
        // Place the element's vertical center on that midpoint
        left.style.top = mid + 'px';
        left.style.position = 'fixed';
        // Keep existing translateY(-50%) from CSS for true centering about the top value
        if (!left.style.transform) {
            left.style.transform = 'translateY(-50%)';
        }
    } catch {}
}

  // Keep tray positioned on resize
  window.addEventListener('resize', positionWarningTray);
  // Keep left stats centered on resize
  window.addEventListener('resize', positionLeftStatsVertically);
  // Position left stats on initial load
  document.addEventListener('DOMContentLoaded', positionLeftStatsVertically);

// Smoothly scroll the warnings list to a specific warning card and highlight it
function scrollWarningIntoView(warningId) {
    try {
        // If the app has a map view toggle, fall back to ensuring the warnings list is visible
        const list = document.getElementById('warnings-list');
        if (!list) return;
        const selector = `.warning-card[data-warning-id="${CSS && CSS.escape ? CSS.escape(warningId) : String(warningId)}"]`;
        const card = document.querySelector(selector);
        if (!card) return;
        // Ensure first-load intro animation cannot hide cards during jump highlight
        try {
            list.classList.remove('list-intro');
            card.classList.remove('intro-anim', 'new-warning', 'tab-animation');
            card.style.opacity = '1';
        } catch {}
        card.scrollIntoView({ behavior: 'smooth', block: 'center' });
        // Brief static full-card outline (no pulse/fade)
        card.classList.remove('tray-jump-highlight');
        try { void card.offsetWidth; } catch {}
        card.classList.add('tray-jump-highlight');
        try {
            if (card.__jumpHighlightTimer) clearTimeout(card.__jumpHighlightTimer);
            card.__jumpHighlightTimer = setTimeout(() => {
                try { card.classList.remove('tray-jump-highlight'); } catch {}
            }, 2300);
        } catch {}
    } catch {}
}

// Insert test alert shortcuts in the warnings dropdown menu
document.addEventListener('DOMContentLoaded', function addTestAlertButton() {
    try {
        const dropdownMenu = document.getElementById('warnings-dropdown');
        if (!dropdownMenu) return;
        if (dropdownMenu.querySelector('#send-test-alert')) return; // avoid duplicates

        const closeWarningsDropdown = () => {
            try {
                const dropdownBtn = document.getElementById('nav-warnings-btn');
                dropdownMenu.classList.remove('show');
                if (dropdownBtn) dropdownBtn.classList.remove('active');
            } catch {}
        };

        if (!dropdownMenu.querySelector('#test-alert-divider')) {
            const divider = document.createElement('div');
            divider.id = 'test-alert-divider';
            divider.className = 'dropdown-divider';
            dropdownMenu.appendChild(divider);
        }

        if (!dropdownMenu.querySelector('#test-alert-label')) {
            const label = document.createElement('div');
            label.id = 'test-alert-label';
            label.className = 'dropdown-item test-alert-label';
            label.textContent = 'Test Alerts';
            dropdownMenu.appendChild(label);
        }

        const btn = document.createElement('button');
        btn.id = 'send-test-alert';
        btn.className = 'dropdown-item test-alert-menu-item';
        btn.type = 'button';
        btn.innerHTML = '<i class="fas fa-flask"></i> Test Alert';
        btn.title = 'Send a sample warning popup';
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const now = Date.now();
            const warning = {
                id: 'TEST-' + now,
                properties: {
                    event: 'Severe Thunderstorm Warning',
                    headline: 'Severe Thunderstorm Warning',
                    description: 'This is a test alert generated from the header button.',
                    expires: new Date(now + 60 * 60 * 1000).toISOString(),
                    areaDesc: 'Sample County; Demo County',
                    messageType: 'Alert',
                    parameters: { maxWindGust: ['60 MPH'] }
                }
            };
            showWarningNotification(warning);
            closeWarningsDropdown();
        });
        dropdownMenu.appendChild(btn);

        // Add a Test Flash Flood button (replaces Blizzard test)
        if (!dropdownMenu.querySelector('#send-test-flashflood')) {
            const ffw = document.createElement('button');
            ffw.id = 'send-test-flashflood';
            ffw.className = 'dropdown-item test-alert-menu-item';
            ffw.type = 'button';
            ffw.innerHTML = '<i class="fas fa-water"></i> Test Flash Flood';
            ffw.title = 'Trigger a Flash Flood Warning sample popup';
            ffw.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                const now = Date.now();
                const warning = {
                    id: 'TEST-FFW-' + now,
                    properties: {
                        event: 'Flash Flood Warning (TEST)',
                        headline: 'FLASH FLOOD WARNING [TEST]',
                        description: 'HAZARD: LIFE THREATENING FLASH FLOODING. THUNDERSTORMS PRODUCING FLASH FLOODING IN LOW-LYING AND URBAN AREAS.\nSOURCE: RADAR INDICATED.\nIMPACTS: RAPID RISES OF CREEKS AND STREAMS. FLOODING OF ROADS AND UNDERPASSES. DAMAGE THREAT: CONSIDERABLE.',
                        expires: new Date(now + 2 * 60 * 60 * 1000).toISOString(),
                        areaDesc: 'San Miguel, NM',
                        messageType: 'Test'
                    }
                };
                showWarningNotification(warning);
                closeWarningsDropdown();
            });
            dropdownMenu.appendChild(ffw);
        }

        // Add a Test Message button (generic test)
        if (!dropdownMenu.querySelector('#send-test-message')) {
            const testMsg = document.createElement('button');
            testMsg.id = 'send-test-message';
            testMsg.className = 'dropdown-item test-alert-menu-item';
            testMsg.type = 'button';
            testMsg.innerHTML = '<i class="fas fa-comment-dots"></i> Test Message';
            testMsg.title = 'Trigger a generic Test Message popup';
            testMsg.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                const now = Date.now();
                const warning = {
                    id: 'TEST-MESSAGE-' + now,
                    properties: {
                        event: 'Test Message',
                        headline: 'THIS IS A TEST MESSAGE',
                        description: 'This is a test message to verify notification popup and sound routing.',
                        expires: new Date(now + 30 * 60 * 1000).toISOString(),
                        areaDesc: 'Sample County; Demo County',
                        messageType: 'Test'
                    }
                };
                showWarningNotification(warning);
                closeWarningsDropdown();
            });
            dropdownMenu.appendChild(testMsg);
        }

        // Helper: build test warnings as normal warning cards (not auto-added to Active Alerts)
        const addTestSuiteAsWarningCards = (suite, idPrefix) => {
            const nowBase = Date.now();
            const prefix = `${idPrefix}-`;
            try {
                injectedTestWarnings = (injectedTestWarnings || []).filter(w => !String(w?.id || '').startsWith(prefix));
            } catch {}

            const built = suite.map((item, idx) => {
                const now = Date.now() + idx * 2000;
                const expiresMins = Number(item.expiresMins || 60);
                return {
                    id: `${idPrefix}-${nowBase}-${idx}`,
                    properties: {
                        event: item.event,
                        headline: item.headline,
                        description: item.description,
                        sent: new Date(now - 5 * 60000).toISOString(),
                        issued: new Date(now - 5 * 60000).toISOString(),
                        effective: new Date(now - 4 * 60000).toISOString(),
                        expires: new Date(now + expiresMins * 60000).toISOString(),
                        areaDesc: item.areaDesc || 'Sample County; Demo County',
                        messageType: 'Test',
                        urgency: 'Immediate',
                        severity: 'Severe',
                        certainty: 'Observed',
                        __isSuiteTest: true,
                        __topTestCard: item.topPin === true,
                        parameters: item.parameters || {}
                    }
                };
            });

            injectedTestWarnings = mergeById([...(injectedTestWarnings || [])], built);
        };

        // STW + Tornado suite definitions
        const topTornadoSuite = [
            {
                event: 'Tornado Warning',
                headline: 'TORNADO WARNING [TEST] TOP CARD',
                description: 'PARTICULARLY DANGEROUS SITUATION. SOURCE: SPOTTER CONFIRMED TORNADO. CONFIRMED TORNADO.',
                parameters: { tags: ['PDS', 'SPOTTER CONFIRMED TORNADO'] },
                expiresMins: 57,
                topPin: true
            }
        ];

        const stwSuite = [
            {
                event: 'Severe Thunderstorm Warning',
                headline: 'SEVERE THUNDERSTORM WARNING [TEST] BASELINE',
                description: 'SOURCE: RADAR INDICATED. IMPACTS: WIND DAMAGE TO TREES AND POWER LINES IS POSSIBLE.',
                parameters: { maxWindGust: ['60 MPH'], maxHailSize: ['1.00'] },
                expiresMins: 58
            },
            {
                event: 'Severe Thunderstorm Warning',
                headline: 'SEVERE THUNDERSTORM WARNING [TEST] CONSIDERABLE',
                description: 'SOURCE: RADAR INDICATED. DAMAGE THREAT: CONSIDERABLE. IMPACTS: SIGNIFICANT WIND DAMAGE POSSIBLE.',
                parameters: { maxWindGust: ['70 MPH'], maxHailSize: ['1.75'], damageThreat: ['CONSIDERABLE'] },
                expiresMins: 63
            },
            {
                event: 'Severe Thunderstorm Warning',
                headline: 'SEVERE THUNDERSTORM WARNING [TEST] DESTRUCTIVE',
                description: 'SOURCE: RADAR INDICATED. DAMAGE THREAT: DESTRUCTIVE. THIS IS A DESTRUCTIVE STORM.',
                parameters: { maxWindGust: ['80 MPH'], maxHailSize: ['2.75'], damageThreat: ['DESTRUCTIVE'] },
                expiresMins: 67
            },
            {
                event: 'Severe Thunderstorm Warning',
                headline: 'SEVERE THUNDERSTORM WARNING [TEST] TORNADO POSSIBLE',
                description: 'SOURCE: RADAR INDICATED. TORNADO...POSSIBLE. IMPACTS: ISOLATED TORNADO RISK.',
                parameters: { maxWindGust: ['65 MPH'], maxHailSize: ['1.25'], tags: ['TORNADO POSSIBLE'] },
                expiresMins: 61
            },
            {
                event: 'Severe Thunderstorm Warning',
                headline: 'SEVERE THUNDERSTORM WARNING [TEST] CONSIDERABLE + TORNADO POSSIBLE',
                description: 'SOURCE: RADAR INDICATED. DAMAGE THREAT: CONSIDERABLE. TORNADO...POSSIBLE.',
                parameters: { maxWindGust: ['75 MPH'], maxHailSize: ['2.00'], damageThreat: ['CONSIDERABLE'], tags: ['TORNADO POSSIBLE'] },
                expiresMins: 64
            },
            {
                event: 'Severe Thunderstorm Warning',
                headline: 'SEVERE THUNDERSTORM WARNING [TEST] DESTRUCTIVE + TORNADO POSSIBLE',
                description: 'SOURCE: RADAR INDICATED. DAMAGE THREAT: DESTRUCTIVE. TORNADO...POSSIBLE.',
                parameters: { maxWindGust: ['90 MPH'], maxHailSize: ['3.00'], damageThreat: ['DESTRUCTIVE'], tags: ['TORNADO POSSIBLE'] },
                expiresMins: 69
            },
            {
                event: 'Severe Thunderstorm Warning',
                headline: 'SEVERE THUNDERSTORM WARNING [TEST] PDS DESTRUCTIVE',
                description: 'PARTICULARLY DANGEROUS SITUATION (PDS). SOURCE: RADAR INDICATED. DAMAGE THREAT: DESTRUCTIVE. TORNADO...POSSIBLE.',
                parameters: { maxWindGust: ['95 MPH'], maxHailSize: ['3.50'], damageThreat: ['DESTRUCTIVE'], tags: ['TORNADO POSSIBLE', 'PDS'] },
                expiresMins: 72
            }
        ];

        const torSuite = [
            {
                event: 'Tornado Warning',
                headline: 'TORNADO WARNING [TEST] RADAR INDICATED',
                description: 'SOURCE: RADAR INDICATED. IMPACTS: FLYING DEBRIS WILL BE DANGEROUS.',
                parameters: { maxHailSize: ['1.00'] },
                expiresMins: 42
            },
            {
                event: 'Tornado Warning',
                headline: 'TORNADO WARNING [TEST] RADAR CONFIRMED',
                description: 'SOURCE: RADAR CONFIRMED TORNADO. RADAR DETECTED DEBRIS SIGNATURE.',
                parameters: { tags: ['RADAR CONFIRMED TORNADO'] },
                expiresMins: 46
            },
            {
                event: 'Tornado Warning',
                headline: 'TORNADO WARNING [TEST] SPOTTER CONFIRMED',
                description: 'SOURCE: SPOTTER CONFIRMED TORNADO. CONFIRMED BY LAW ENFORCEMENT.',
                parameters: { tags: ['SPOTTER CONFIRMED TORNADO'] },
                expiresMins: 48
            },
            {
                event: 'Tornado Warning',
                headline: 'PDS TORNADO WARNING [TEST]',
                description: 'PARTICULARLY DANGEROUS SITUATION. SOURCE: RADAR INDICATED. CATASTROPHIC DAMAGE POSSIBLE.',
                parameters: { tags: ['PDS'] },
                expiresMins: 52
            },
            {
                event: 'Tornado Warning',
                headline: 'PDS TORNADO WARNING [TEST] CONFIRMED',
                description: 'PARTICULARLY DANGEROUS SITUATION. SOURCE: SPOTTER CONFIRMED TORNADO. CONFIRMED TORNADO.',
                parameters: { tags: ['PDS', 'SPOTTER CONFIRMED TORNADO'] },
                expiresMins: 54
            },
            {
                event: 'Tornado Emergency',
                headline: 'TORNADO EMERGENCY [TEST]',
                description: 'TORNADO EMERGENCY FOR POPULATED AREAS. OBSERVED LARGE AND EXTREMELY DANGEROUS TORNADO.',
                parameters: { tags: ['EMERGENCY', 'OBSERVED'] },
                expiresMins: 40
            }
        ];

        // Test suite auto-injection disabled
        if (!hasInjectedDefaultSuites) {
            injectedTestWarnings = [];
            hasInjectedDefaultSuites = true;
        }
        positionWarningTray();
    } catch {}
});

// Navigate to the Important list, render, and focus a specific warning card
function goToWarningInImportant(targetId) {
    try {
        // Ensure we are in warnings view and important sort
        if (typeof currentView !== 'undefined') currentView = 'warnings';
        if (typeof currentSortMode !== 'undefined') currentSortMode = 'important';
        // Ensure dashboard is visible (hide map scene if open)
        try { if (typeof hideWeatherMapScene === 'function') hideWeatherMapScene(); } catch {}
        // Re-render list
        if (typeof renderCurrentList === 'function') renderCurrentList();
        // After render, scroll to card and highlight
        setTimeout(() => {
            const list = document.getElementById('warnings-list');
            const sel = `.warning-card[data-warning-id="${CSS.escape(targetId)}"]`;
            const card = list ? list.querySelector(sel) : null;
            if (card) {
                card.scrollIntoView({ behavior: 'smooth', block: 'center' });
                card.classList.add('focused');
                setTimeout(() => card.classList.remove('focused'), 2000);
            }
        }, 0);
    } catch (e) {
        console.warn('goToWarningInImportant failed', e);
    }
}

// Make function globally accessible
window.closeWarningNotification = closeWarningNotification;

function getNotificationColors(event, props) {
    const e = (event || '').toLowerCase();
    const displayEvent = getDisplayEventName(event, props);
    
    if (displayEvent.includes('EMERGENCY')) {
        return {
            headerBg: '#000000',
            headerText: '#ffffff',
            bodyBg: '#ff0000',
            bodyText: '#ffffff'
        };
    } else if (e.includes('tornado')) {
        return {
            headerBg: '#000000',
            headerText: '#ffffff',
            bodyBg: '#ff0000',
            bodyText: '#ffffff'
        };
    } else if (e.includes('severe thunderstorm')) {
        return {
            headerBg: '#000000',
            headerText: '#ffffff',
            bodyBg: '#ff8c00',
            bodyText: '#000000'
        };
    } else if (e.includes('hurricane')) {
        return {
            headerBg: '#000000',
            headerText: '#ffffff',
            bodyBg: '#ff00d0',
            bodyText: '#000000'
        };
    } else if (e.includes('tropical storm')) {
        return {
            headerBg: '#000000',
            headerText: '#ffffff',
            bodyBg: '#ff364a',
            bodyText: '#000000'
        };
    } else if (e.includes('flash flood')) {
        return {
            headerBg: '#000000',
            headerText: '#ffffff',
            bodyBg: '#00ff00',
            bodyText: '#000000'
        };
    } else {
        return {
            headerBg: '#000000',
            headerText: '#ffffff',
            bodyBg: '#ff8c00',
            bodyText: '#000000'
        };
    }
}

function formatExpirationTime(expires) {
    if (!expires) return 'UNKNOWN';
    
    const expiresDate = new Date(expires);
    const now = new Date();
    const diffMs = expiresDate - now;
    const diffMins = Math.max(0, Math.ceil(diffMs / 60000));
    
    if (diffMins < 60) {
        return `IN ${diffMins} MINUTES`;
    } else {
        const diffHours = Math.ceil(diffMins / 60);
        return `IN ${diffHours} HOUR${diffHours > 1 ? 'S' : ''}`;
    }
}

function formatPopulation(areaDesc) {
    if (!areaDesc) return 'UNKNOWN';
    
    // Mock population calculation based on area
    const areas = areaDesc.split(';');
    const population = areas.length * 50000 + Math.floor(Math.random() * 100000);
    return population.toLocaleString();
}

function formatAreas(areaDesc, options = {}) {
    const fallback = Object.prototype.hasOwnProperty.call(options, 'fallback')
        ? String(options.fallback || '')
        : 'UNKNOWN';
    const joiner = String(options.joiner || ', ');
    const upperCase = options.upperCase !== false;
    const keepCase = !upperCase;
    const dedupe = options.dedupe !== false;
    const entries = getFormattedAreaEntries(areaDesc, { keepCase, dedupe });
    if (!entries.length) return fallback;
    return entries.join(joiner);
}

function getSourceText(props) {
    try {
        const desc = String(props.description || '');
        // Extract strictly from the SOURCE line in the NWS product text
        // Support formats like: 'SOURCE:', 'SOURCE ...', 'SOURCE -', 'SOURCE â€”'
        // Capture all lines after SOURCE until next section header or blank line
        const m = desc.match(/(^|\n)\s*SOURCE\s*[:.\-â€“â€”]*\s*([\s\S]*?)(?=\n\s*\n|\n\s*(WHERE|WHEN|IMPACT|IMPACTS|SOURCE|LOCATIONS AFFECTED|PRECAUTIONARY|ADDITIONAL DETAILS|WHAT|DAMAGE THREAT|THREAT|TAG|INSTRUCTION)\b|$)/i);
        if (m && m[2]) {
            const raw = m[2].trim();
            return /[\.!?]$/.test(raw) ? raw : (raw + '.');
        }
    } catch {}
    // If no SOURCE line is present, leave blank
    return '';
}

// Try to extract "HAZARD" text from NWS text blocks
function getHazardText(props) {
    const descRaw = String(props.description || '');
    // Multiline capture: grab everything after HAZARD up to next section header or blank line
    const multi = descRaw.match(/HAZARD\.*?\s*([\s\S]*?)(?:\n\s*\n|\n\s*(WHERE|WHEN|IMPACT|IMPACTS|SOURCE|LOCATIONS AFFECTED|PRECAUTIONARY|ADDITIONAL DETAILS|WHAT|DAMAGE THREAT|THREAT|TAG|INSTRUCTION)\b)/i);
    if (multi && multi[1]) return multi[1].trim().toUpperCase();

    // Single-line variants as fallback
    const upper = descRaw.toUpperCase();
    const matchColon = upper.match(/\bHAZARD\s*:\s*([^\n]+)/);
    if (matchColon && matchColon[1]) return matchColon[1].trim().toUpperCase();
    const matchDots = upper.match(/\bHAZARD\.*?\s*([^\n]+)/);
    if (matchDots && matchDots[1]) return matchDots[1].trim().toUpperCase();

    // Fallback to a brief phrase from headline
    if ((props.headline || '').toUpperCase().includes('FLASH FLOOD')) return 'FLASH FLOODING.';
    return '';
}

function getWhatText(props) {
    const desc = String(props.description || '').replace(/\r/g, '');
    const m = desc.match(
        /(?:^|\n)\s*(?:\*+\s*)?WHAT\s*[:.\-–—]*\s*([\s\S]*?)(?=\n\s*\n|\n\s*(?:\*+\s*)?(WHERE|WHEN|IMPACT|IMPACTS|HAZARD|SOURCE|LOCATIONS AFFECTED|PRECAUTIONARY|ADDITIONAL DETAILS|DAMAGE THREAT|THREAT|TAG|INSTRUCTION)\b|$)/i
    );
    if (m && m[1]) return m[1].trim();
    const lineMatch = desc.match(/(?:^|\n)\s*(?:\*+\s*)?WHAT\s*[:.\-–—]*\s*(.*)$/im);
    if (lineMatch && lineMatch[1]) return lineMatch[1].trim();
    return '';
}

function getImpactsText(props) {
    const desc = String(props.description || '');
    // Support both IMPACT and IMPACTS headers
    const m = desc.match(/IMPACTS?\.*\s*([\s\S]*?)(?:\n\s*\n|\n\s*(WHERE|WHEN|HAZARD|SOURCE|LOCATIONS AFFECTED|PRECAUTIONARY|ADDITIONAL DETAILS|WHAT|DAMAGE THREAT|THREAT|TAG|INSTRUCTION)\b)/i);
    if (m && m[1]) return m[1].trim();
    return '';
}

function getWarningCardHazardText(props, displayEventInput) {
    try {
        const upperDisplayEvent = String(
            displayEventInput || getDisplayEventName(props?.event, props) || props?.event || ''
        ).toUpperCase().trim();

        if (
            upperDisplayEvent.includes('WINTER STORM WARNING')
            || upperDisplayEvent.includes('WINTER WEATHER ADVISORY')
            || upperDisplayEvent.includes('FLOOD WARNING')
            || upperDisplayEvent.includes('FLOOD ADVISORY')
        ) {
            const whatText = String(getWhatText(props) || '').trim();
            if (whatText) return whatText;
            const hazardText = String(getHazardText(props) || '').trim();
            if (hazardText) return hazardText;
            return String(getImpactsText(props) || '').trim();
        }

        if (upperDisplayEvent.includes('RED FLAG WARNING')) {
            return String(getImpactsText(props) || getRedFlagImpactsFallback(props) || '').trim();
        }

        const description = String(props?.description || '');
        const hazardMatch = description.match(/HAZARD[.\s]*([^.]*)/i);
        if (hazardMatch && hazardMatch[1]) {
            return String(hazardMatch[1] || '').trim();
        }
    } catch {}
    return '';
}

// Red Flag Warning descriptions are inconsistent; many have no explicit IMPACTS block.
// Fallback to a sentence that still conveys likely fire spread impact.
function getRedFlagImpactsFallback(props) {
    const desc = String(props.description || '');
    if (!desc) return '';

    const normalized = desc.replace(/\r/g, '');
    const sentenceMatch = normalized.match(
        /([^.\n]*\b(?:fires?|any fire)\b[^.\n]*\b(?:spread|rapid|quickly|grow|danger)\b[^.\n]*[.]?)/i
    );
    if (sentenceMatch && sentenceMatch[1]) {
        return sentenceMatch[1].replace(/^[*\s.:-]+/, '').trim();
    }

    const cautionMatch = normalized.match(
        /([^.\n]*\b(?:extreme caution|outdoor burning|critical fire weather conditions)\b[^.\n]*[.]?)/i
    );
    if (cautionMatch && cautionMatch[1]) {
        return cautionMatch[1].replace(/^[*\s.:-]+/, '').trim();
    }

    return '';
}

// Extract the narrative paragraph that starts with "At <time>" (e.g., "At 910 PM CDT,")
function getAtTimeSection(props) {
    try {
        const desc = String(props.description || '');
        // Match a paragraph that begins with "At <time>" allowing formats like:
        //  - At 9:10 PM CDT,
        //  - At 910 PM CDT,
        //  - At 2 PM CDT,
        //  - At 2 PM,
        //  - ...At 9 PM CST,
        // Timezone is optional; minutes are optional; leading ellipses allowed.
        const re = /(^|\n)\s*\.*\s*At\s+(?:\d{1,2}(?::\d{2})?|\d{3,4})\s*(?:AM|PM)?\s*(?:[A-Z]{2,4})?\b[\s\S]*?(?=\n\s*\n|\n\s*(?:HAZARD|WHAT|WHERE|WHEN|SOURCE|IMPACTS?|PRECAUTIONARY|ADDITIONAL DETAILS|INSTRUCTION|DAMAGE THREAT|THREAT|TAG)\b|$)/i;
        const m = desc.match(re);
        if (m) {
            // m[0] includes the leading line break group; strip it and trim
            return m[0].replace(/^\s*/,'').trim();
        }
        // Fallback: first sentence starting with "At " (allow leading ellipses)
        const lineRe = /(^|\n)\s*\.*\s*At\s+[^\n]+/i;
        const m2 = desc.match(lineRe);
        if (m2) return m2[0].replace(/^\s*/,'').trim();
    } catch {}
    return '';
}

function getTornadoText(props) {
    if (props.headline && props.headline.toUpperCase().includes('OBSERVED')) {
        return 'OBSERVED';
    } else {
        return 'RADAR INDICATED';
    }
}

function playAlertSound(event, props = {}) {
    // Check if alert sounds are enabled
    if (window.alertSoundsEnabled === false) {
        return;
    }
    
    const e = (event || '').toLowerCase();
    // Respect per-event preferences for sounds as well (V2)
    try {
        const display = getDisplayEventName(event, props || { headline: '', description: '' });
        // Allow a one-off override on props for new/upgrade cases
        const force = props && props.__forceSound === true;
        if (!force && !isEventAllowed(display, 'sound')) {
            return;
        }
    } catch {}
    
    // Map canonical display events to audio files present in the project
    const displayEvent = (getDisplayEventName(event, props) || '').toUpperCase();

    // Never play sounds for dust advisories
    try {
        if (displayEvent.includes('DUST') && displayEvent.includes('ADVISORY')) {
            return;
        }
    } catch {}

    // Detect special cases from text/parameters
    const textBlob = `${(props.headline||'')} ${(props.description||'')}`.toUpperCase();
    const isPdsSevere = displayEvent === 'SEVERE THUNDERSTORM WARNING' && (textBlob.includes('PDS') || textBlob.includes('PARTICULARLY DANGEROUS SITUATION'));
    const isPdsTornado = displayEvent === 'PDS TORNADO WARNING';

    // Central mapping (use exact filenames from repo)
    const audioMap = new Map([
        ['TORNADO EMERGENCY', 'tornado-emergency-ryan-hall-yall.mp3'],
        ['PDS TORNADO WARNING', 'pds-tornado-warning-ryan-hall-yall.mp3'],
        ['TORNADO WARNING', 'tornado-warning-alert-ryan-hall-yall_HUSmPC6.mp3'],
        ['TORNADO WATCH', 'tornado-watch-alert-ryan-hall-yall.mp3'],
        ['SEVERE THUNDERSTORM WATCH', 'RHY_Ding.m4a'],
        // Non-PDS STW default file (ensure filename matches repository asset)
        ['SEVERE THUNDERSTORM WARNING', isPdsSevere ? 'pds-severe-thunderstorm-warning-ryan-hall-yall_1rDycfw.mp3' : 'severe-thunderstorm-warning-ryan-hall-yall_V5kzHWO.mp3'],
        ['FLASH FLOOD WARNING', 'Flash Flood.mp3'],
        ['FLASH FLOOD EMERGENCY', 'RHY_Ding.m4a'],
        ['FLOOD WARNING', 'RHY_Ding.m4a'],
        ['HURRICANE WARNING', 'Hurricane Warning.mp3'],
        ['HURRICANE WATCH', 'Hurricane Watch.mp3'],
        ['TROPICAL STORM WARNING', 'Trpoical Storm Warning.mp3'],
        ['TROPICAL STORM WATCH', 'Tropical Storm Watch.mp3'],
        ['TSUNAMI WARNING', 'TSUNAMI WARNING.mp3'],
        ['TSUNAMI WATCH', 'TSUNAMI Watch.mp3'],
        ['BLIZZARD WARNING', 'Blizzard Warning.mp3'],
        ['WINTER STORM WARNING', 'Winter Storm Warning.mp3'],
        ['WINTER STORM WATCH', 'Winter Storm Watch.mp3'],
        ['WINTER WEATHER ADVISORY', 'WINTER WEATHER ADVISORY.mp3'],
        ['SHELTER IN PLACE WARNING', 'SHELTER IN PLACE WARNING.mp3'],
        ['EVACUATION IMMEDIATE', 'Evacuation Immediate.mp3'],
        ['LAW ENFORCEMENT WARNING', 'LAW ENFORCEMENT WARNING.mp3'],
        ['LOCAL AREA EMERGENCY', 'LOCAL AREA EMERGENCY.mp3'],
    ]);

    let soundFile = audioMap.get(displayEvent) || 'RHY_Ding.m4a';
    // If a generic test message (not a real warning type), use ding
    const isGenericTest = (displayEvent === 'TEST MESSAGE' || displayEvent === 'SYSTEM TEST' || displayEvent === 'REQUIRED WEEKLY TEST');
    if (isGenericTest) soundFile = 'RHY_Ding.m4a';
    
    try {
        const vol = (typeof window.alertVolume === 'number') ? Math.max(0, Math.min(1, window.alertVolume)) : 0.7;
        // Ensure unlock hooks exist, then enqueue for sequential playback
        try { initAudioUnlock(); } catch {}
        enqueueAlertSound(soundFile, vol);
    } catch (e) {
        console.error('Failed to enqueue alert sound:', e);
    }
}

// Detects if a Flash Flood Warning carries a 'CONSIDERABLE' damage threat
function isConsiderableFlashFlood(props = {}) {
    const e = (props.event || '').toLowerCase();
    if (!e.includes('flash flood warning')) return false;

    const headline = (props.headline || '').toLowerCase();
    const description = (props.description || '').toLowerCase();

    // Common CAP parameter containers
    const p = props.parameters || {};
    const paramStrings = [];
    for (const key of Object.keys(p)) {
        const val = p[key];
        if (Array.isArray(val)) paramStrings.push(val.join(' ').toLowerCase());
        else if (val != null) paramStrings.push(String(val).toLowerCase());
    }

    // Look for the word 'considerable' anywhere in headline/description/parameters
    const haystack = [headline, description, ...paramStrings].join(' ');
    return haystack.includes('considerable');
}

function parseFirstNumericToken(value) {
    const token = String(value ?? '').match(/[-+]?(?:\d*\.\d+|\d+)/);
    if (!token || !token[0]) return Number.NaN;
    const numeric = Number.parseFloat(token[0]);
    return Number.isFinite(numeric) ? numeric : Number.NaN;
}

// Detect 'DESTRUCTIVE' tag on Severe Thunderstorm Warning
function isDestructiveSevere(props = {}) {
    const e = (props.event || '').toLowerCase();
    if (!e.includes('severe thunderstorm warning')) return false;
    const p = props.parameters || {};
    let threat = '';
    if (p.damageThreat != null) threat = Array.isArray(p.damageThreat) ? String(p.damageThreat[0] || '') : String(p.damageThreat);
    else if (p.DAMAGETHREAT != null) threat = Array.isArray(p.DAMAGETHREAT) ? String(p.DAMAGETHREAT[0] || '') : String(p.DAMAGETHREAT);
    threat = String(threat).toUpperCase();
    if (threat.includes('DESTRUCTIVE')) return true;
    const text = `${props.headline || ''} ${props.description || ''}`.toUpperCase();
    return text.includes('DESTRUCTIVE');
}

// Detect 'CONSIDERABLE' tag on Severe Thunderstorm Warning
function isConsiderableSevere(props = {}) {
    const e = (props.event || '').toLowerCase();
    if (!e.includes('severe thunderstorm warning')) return false;
    const p = props.parameters || {};
    let threat = '';
    if (p.damageThreat != null) threat = Array.isArray(p.damageThreat) ? String(p.damageThreat[0] || '') : String(p.damageThreat);
    else if (p.DAMAGETHREAT != null) threat = Array.isArray(p.DAMAGETHREAT) ? String(p.DAMAGETHREAT[0] || '') : String(p.DAMAGETHREAT);
    threat = String(threat).toUpperCase();
    if (threat.includes('CONSIDERABLE')) return true;

    // Treat hail >= 1.75 inches as CONSIDERABLE
    try {
        let hailRaw = null;
        if (p.maxHailSize != null) hailRaw = Array.isArray(p.maxHailSize) ? p.maxHailSize[0] : p.maxHailSize;
        else if (p.MAXHAILSIZE != null) hailRaw = Array.isArray(p.MAXHAILSIZE) ? p.MAXHAILSIZE[0] : p.MAXHAILSIZE;
        if (hailRaw != null) {
            const hailIn = parseFirstNumericToken(hailRaw);
            if (!Number.isNaN(hailIn) && hailIn >= 1.75) return true;
        }
    } catch {}

    const text = `${props.headline || ''} ${props.description || ''}`.toUpperCase();
    // Only match explicit NWS damage-threat phrasing to avoid false positives.
    return /(?:\bDAMAGE\s+THREAT\s*[:.\-–—]*\s*CONSIDERABLE\b|\bCONSIDERABLE\s+DAMAGE\s+THREAT\b)/.test(text);
}

function isTornadoPossibleSevere(props = {}) {
    const normalize = (s) => String(s || '')
        .toUpperCase()
        .replace(/[^A-Z]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    const e = normalize(props.event);
    const headline = normalize(props.headline);
    const description = normalize(props.description);
    const instruction = normalize(props.instruction);

    const p = props.parameters || {};
    const paramStrings = [];
    for (const key of Object.keys(p)) {
        const val = p[key];
        if (Array.isArray(val)) paramStrings.push(normalize(val.join(' ')));
        else if (val != null) paramStrings.push(normalize(String(val)));
    }

    // Parameter-based explicit checks for tornado possible flags/tags
    try {
        for (const [k, v] of Object.entries(p)) {
            const keyN = normalize(k);
            let valN = '';
            if (Array.isArray(v)) valN = normalize(v.join(' '));
            else if (v != null && typeof v === 'object') valN = normalize(JSON.stringify(v));
            else if (v != null) valN = normalize(String(v));

            // Any parameter key containing 'TORNADO' with a value that suggests POSSIBLE or a true-ish flag
            if (keyN.includes('TORNADO')) {
                if (valN.includes('POSSIBLE') || valN === 'TRUE' || valN === 'YES' || valN === '1') return true;
            }

            // Generic tag-style parameters that include the phrase
            if (keyN.includes('TAG') && valN.includes('TORNADO POSSIBLE')) return true;
        }

        // Common pattern: a 'tags' array/field containing phrases
        if (Array.isArray(p.tags)) {
            const tagsNorm = normalize(p.tags.join(' '));
            if (tagsNorm.includes('TORNADO POSSIBLE')) return true;
        }
    } catch {}

    // First pass: normalized phrase
    const haystack = [e, headline, description, instruction, ...paramStrings].join(' ');
    if (haystack.includes('TORNADO POSSIBLE')) return true;

    // Second pass: check parsed sections to catch NWS block formatting
    try {
        const hz = (typeof getHazardText === 'function' ? (getHazardText(props) || '') : '');
        const im = (typeof getImpactsText === 'function' ? (getImpactsText(props) || '') : '');
        const wt = (typeof getWhatText === 'function' ? (getWhatText(props) || '') : '');
        const sectionRaw = [hz, im, wt].join(' ').toUpperCase();
        if (sectionRaw.includes('TORNADO POSSIBLE')) return true;
        const sectionRe = /TORNADO[\s\S]{0,120}?POSSIBLE/i;
        if (sectionRe.test([hz, im, wt].join(' '))) return true;
    } catch {}

    // Fallback: raw regex over all fields, allow some text between words
    try {
        const rawParts = [];
        rawParts.push(String(props.event || ''));
        rawParts.push(String(props.headline || ''));
        rawParts.push(String(props.description || ''));
        rawParts.push(String(props.instruction || ''));
        const par = props.parameters || {};
        for (const k of Object.keys(par)) {
            const v = par[k];
            if (Array.isArray(v)) rawParts.push(v.join(' '));
            else if (v != null) rawParts.push(String(v));
        }
        const raw = rawParts.join(' ');
        const re = /TORNADO[\s\S]{0,160}?(?:IS\s+)?POSSIBLE/i;
        return re.test(raw);
    } catch {}
    return false;
}

function isRadarConfirmedTornado(props = {}) {
    const normalize = (s) => String(s || '')
        .toUpperCase()
        .replace(/[^A-Z]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    const headline = normalize(props.headline);
    const description = normalize(props.description);
    const instruction = normalize(props.instruction);

    const p = props.parameters || {};
    const paramStrings = [];
    for (const key of Object.keys(p)) {
        const val = p[key];
        if (Array.isArray(val)) paramStrings.push(normalize(val.join(' ')));
        else if (val != null) paramStrings.push(normalize(String(val)));
    }

    // Parameter-based explicit checks for radar confirmed tornadoes
    try {
        for (const [k, v] of Object.entries(p)) {
            const keyN = normalize(k);
            let valN = '';
            if (Array.isArray(v)) valN = normalize(v.join(' '));
            else if (v != null && typeof v === 'object') valN = normalize(JSON.stringify(v));
            else if (v != null) valN = normalize(String(v));

            // Any parameter key containing 'TORNADO' with a value that suggests RADAR CONFIRMED
            if (keyN.includes('TORNADO')) {
                if (valN.includes('RADAR CONFIRMED') || valN.includes('RADAR-CONFIRMED') || 
                    valN.includes('CONFIRMED BY RADAR') || valN.includes('DETECTED BY RADAR')) return true;
            }

            // Generic tag-style parameters that include the phrase
            if (keyN.includes('TAG') && (valN.includes('RADAR CONFIRMED TORNADO') || 
                valN.includes('TORNADO RADAR CONFIRMED'))) return true;
        }

        // Common pattern: a 'tags' array/field containing phrases
        if (Array.isArray(p.tags)) {
            const tagsNorm = normalize(p.tags.join(' '));
            if (tagsNorm.includes('RADAR CONFIRMED TORNADO') || tagsNorm.includes('TORNADO RADAR CONFIRMED')) return true;
        }
    } catch {}

    // Text-based checks for radar confirmed tornadoes
    const haystack = [headline, description, instruction, ...paramStrings].join(' ');
    
    // Check for various radar confirmed phrases
    const radarConfirmedPhrases = [
        'RADAR CONFIRMED TORNADO',
        'TORNADO RADAR CONFIRMED', 
        'RADAR CONFIRMED',
        'RADAR-CONFIRMED',
        'CONFIRMED BY RADAR',
        'DETECTED BY RADAR',
        'RADAR DETECTED',
        'RADAR INDICATED TORNADO'
    ];
    
    for (const phrase of radarConfirmedPhrases) {
        if (haystack.includes(phrase)) return true;
    }

    // Check parsed sections to catch NWS block formatting
    try {
        const hz = (typeof getHazardText === 'function' ? (getHazardText(props) || '') : '');
        const im = (typeof getImpactsText === 'function' ? (getImpactsText(props) || '') : '');
        const wt = (typeof getWhatText === 'function' ? (getWhatText(props) || '') : '');
        const sectionRaw = [hz, im, wt].join(' ').toUpperCase();
        
        for (const phrase of radarConfirmedPhrases) {
            if (sectionRaw.includes(phrase)) return true;
        }
    } catch {}

    return false;
}

function isSpotterConfirmedTornado(props = {}) {
    const normalize = (s) => String(s || '')
        .toUpperCase()
        .replace(/[^A-Z]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    const headline = normalize(props.headline);
    const description = normalize(props.description);
    const instruction = normalize(props.instruction);

    const p = props.parameters || {};
    const paramStrings = [];
    for (const key of Object.keys(p)) {
        const val = p[key];
        if (Array.isArray(val)) paramStrings.push(normalize(val.join(' ')));
        else if (val != null) paramStrings.push(normalize(String(val)));
    }

    // Parameter-based explicit checks for spotter confirmed tornadoes
    try {
        for (const [k, v] of Object.entries(p)) {
            const keyN = normalize(k);
            let valN = '';
            if (Array.isArray(v)) valN = normalize(v.join(' '));
            else if (v != null && typeof v === 'object') valN = normalize(JSON.stringify(v));
            else if (v != null) valN = normalize(String(v));

            // Any parameter key containing 'TORNADO' with a value that suggests SPOTTER CONFIRMED
            if (keyN.includes('TORNADO')) {
                if (valN.includes('SPOTTER CONFIRMED') || valN.includes('SPOTTER-CONFIRMED') || 
                    valN.includes('CONFIRMED BY SPOTTER') || valN.includes('SPOTTERS CONFIRMED') ||
                    valN.includes('CONFIRMED BY SPOTTERS') || valN.includes('EMERGENCY MANAGEMENT CONFIRMED') ||
                    valN.includes('LAW ENFORCEMENT CONFIRMED') || valN.includes('CONFIRMED BY LAW ENFORCEMENT')) return true;
            }

            // Generic tag-style parameters that include the phrase
            if (keyN.includes('TAG') && (valN.includes('SPOTTER CONFIRMED TORNADO') || 
                valN.includes('TORNADO SPOTTER CONFIRMED') || valN.includes('CONFIRMED TORNADO'))) return true;
        }

        // Common pattern: a 'tags' array/field containing phrases
        if (Array.isArray(p.tags)) {
            const tagsNorm = normalize(p.tags.join(' '));
            if (tagsNorm.includes('SPOTTER CONFIRMED TORNADO') || tagsNorm.includes('TORNADO SPOTTER CONFIRMED') ||
                tagsNorm.includes('CONFIRMED TORNADO')) return true;
        }
    } catch {}

    // Text-based checks for spotter confirmed tornadoes
    const haystack = [headline, description, instruction, ...paramStrings].join(' ');
    
    // Check for various spotter confirmed phrases
    const spotterConfirmedPhrases = [
        'SPOTTER CONFIRMED TORNADO',
        'TORNADO SPOTTER CONFIRMED',
        'SPOTTER CONFIRMED',
        'SPOTTER-CONFIRMED',
        'CONFIRMED BY SPOTTER',
        'SPOTTERS CONFIRMED',
        'CONFIRMED BY SPOTTERS',
        'EMERGENCY MANAGEMENT CONFIRMED',
        'LAW ENFORCEMENT CONFIRMED',
        'CONFIRMED BY LAW ENFORCEMENT',
        'CONFIRMED TORNADO'
    ];
    
    for (const phrase of spotterConfirmedPhrases) {
        if (haystack.includes(phrase)) return true;
    }

    // Check parsed sections to catch NWS block formatting
    try {
        const hz = (typeof getHazardText === 'function' ? (getHazardText(props) || '') : '');
        const im = (typeof getImpactsText === 'function' ? (getImpactsText(props) || '') : '');
        const wt = (typeof getWhatText === 'function' ? (getWhatText(props) || '') : '');
        const sectionRaw = [hz, im, wt].join(' ').toUpperCase();
        
        for (const phrase of spotterConfirmedPhrases) {
            if (sectionRaw.includes(phrase)) return true;
        }
    } catch {}

    return false;
}

function getWarningParamValue(props = {}, ...keys) {
    try {
        const params = props.parameters || {};
        for (const key of keys) {
            if (params[key] == null) continue;
            const raw = Array.isArray(params[key]) ? params[key][0] : params[key];
            const value = String(raw || '').trim();
            if (value) return value;
        }
    } catch {}
    return '';
}

function hasMaxWindAndHail(props = {}) {
    const hail = getWarningParamValue(props, 'maxHailSize', 'MAXHAILSIZE');
    const wind = getWarningParamValue(props, 'maxWindGust', 'MAXWINDGUST');
    return Boolean(hail && wind);
}

function sortWarningsByImportance(warnings) {
    return warnings.sort((a, b) => {
        const aTopPinned = a?.properties?.__topTestCard === true;
        const bTopPinned = b?.properties?.__topTestCard === true;
        if (aTopPinned !== bTopPinned) return aTopPinned ? -1 : 1;

        const aIsTest = isTestWarningFeature(a);
        const bIsTest = isTestWarningFeature(b);
        if (aIsTest !== bIsTest) return aIsTest ? -1 : 1;

        const displayA = getDisplayEventName(a.properties.event, a.properties).toLowerCase();
        const displayB = getDisplayEventName(b.properties.event, b.properties).toLowerCase();
        const orderA = getWarningPriority(a.properties.event, a.properties);
        const orderB = getWarningPriority(b.properties.event, b.properties);

        // Explicit rule: any Flash Flood Warning should appear above any Flood Warning
        const aIsFlash = displayA.includes('flash flood warning');
        const bIsFlash = displayB.includes('flash flood warning');
        const aIsFlood = !aIsFlash && displayA.includes('flood warning');
        const bIsFlood = !bIsFlash && displayB.includes('flood warning');
        if (aIsFlash && bIsFlood) return -1;
        if (bIsFlash && aIsFlood) return 1;

        // Special Weather Statements with both hail + wind metrics should rank
        // above Winter Weather Advisories in Most Important mode.
        const aIsSwsWindHail = displayA === 'special weather statement' && hasMaxWindAndHail(a.properties);
        const bIsSwsWindHail = displayB === 'special weather statement' && hasMaxWindAndHail(b.properties);
        const aIsWinterAdv = displayA === 'winter weather advisory';
        const bIsWinterAdv = displayB === 'winter weather advisory';
        if (aIsSwsWindHail && bIsWinterAdv) return -1;
        if (bIsSwsWindHail && aIsWinterAdv) return 1;

        // Within-group ordering: For Flash Flood Warnings, put 'CONSIDERABLE' ones at the top of that group
        if (aIsFlash && bIsFlash) {
            const aConsiderable = isConsiderableFlashFlood(a.properties);
            const bConsiderable = isConsiderableFlashFlood(b.properties);
            if (aConsiderable !== bConsiderable) {
                return aConsiderable ? -1 : 1;
            }
        }

        // Within-group ordering: For Tornado Warnings, prioritize PDS first, then confirmed tornadoes above radar indicated tornado warnings
        const aIsTornado = displayA.includes('tornado warning');
        const bIsTornado = displayB.includes('tornado warning');
        if (aIsTornado && bIsTornado) {
            // PDS Tornado Warnings get highest priority
            const aIsPDS = displayA.includes('pds tornado warning');
            const bIsPDS = displayB.includes('pds tornado warning');
            if (aIsPDS !== bIsPDS) {
                return aIsPDS ? -1 : 1;
            }
            // Then spotter confirmed
            const aSpotterConfirmed = isSpotterConfirmedTornado(a.properties);
            const bSpotterConfirmed = isSpotterConfirmedTornado(b.properties);
            if (aSpotterConfirmed !== bSpotterConfirmed) {
                return aSpotterConfirmed ? -1 : 1;
            }
            // Then radar confirmed
            const aRadarConfirmed = isRadarConfirmedTornado(a.properties);
            const bRadarConfirmed = isRadarConfirmedTornado(b.properties);
            if (aRadarConfirmed !== bRadarConfirmed) {
                return aRadarConfirmed ? -1 : 1;
            }
        }

        // Within-group ordering: For Severe Thunderstorm Warnings, TORnado possible first, then DESTRUCTIVE, then CONSIDERABLE, then others
        const aIsSevere = displayA.includes('severe thunderstorm warning');
        const bIsSevere = displayB.includes('severe thunderstorm warning');
        if (aIsSevere && bIsSevere) {
            const aTornadoPossible = isTornadoPossibleSevere(a.properties);
            const bTornadoPossible = isTornadoPossibleSevere(b.properties);
            if (aTornadoPossible !== bTornadoPossible) {
                return aTornadoPossible ? -1 : 1;
            }
            const aDestructive = isDestructiveSevere(a.properties);
            const bDestructive = isDestructiveSevere(b.properties);
            if (aDestructive !== bDestructive) {
                return aDestructive ? -1 : 1;
            }
            const aConsiderableSev = isConsiderableSevere(a.properties);
            const bConsiderableSev = isConsiderableSevere(b.properties);
            if (aConsiderableSev !== bConsiderableSev) {
                return aConsiderableSev ? -1 : 1;
            }
        }

        if (orderA !== orderB) return orderA - orderB;
        
        // If both are non-priority (1000), group by event type first
        if (orderA === 1000) {
            const cmp = displayA.localeCompare(displayB);
            if (cmp !== 0) return cmp;
        }
        
        // Within same event (or priority) group, sort by expiration time (soonest first)
        const expA = new Date(a.properties.expires || 0);
        const expB = new Date(b.properties.expires || 0);
        return expA - expB;
    });
}

function sortWarningsByRecent(warnings) {
    return warnings.sort((a, b) => {
        // Sort by issued time (most recent first)
        const issuedA = new Date(a.properties.issued || 0);
        const issuedB = new Date(b.properties.issued || 0);
        return issuedB - issuedA; // Most recent first
    });
}

function setupSortMenu() {
    const sortImportant = document.getElementById('sort-important');
    const sortRecent = document.getElementById('sort-recent');
    const sortSevere = document.getElementById('sort-severe');
    const sortSaved = document.getElementById('sort-saved');

    function setSortMode(mode) {
        currentSortMode = mode;
        if (mode === 'severe') {
            try { if (severeTabOpenedAt == null) severeTabOpenedAt = Date.now(); } catch {}
        }
        updateSortButtons();
        renderCurrentList();
    }

    if (sortImportant) {
        sortImportant.addEventListener('click', () => setSortMode('important'));
    }
    if (sortRecent) {
        sortRecent.addEventListener('click', () => setSortMode('recent'));
    }
    if (sortSevere) {
        sortSevere.addEventListener('click', () => setSortMode('severe'));
    }
    if (sortSaved) {
        sortSaved.addEventListener('click', () => setSortMode('saved'));
    }
}



function matchesSearch(alert, search) {
    if (!search) return true;
    const props = alert.properties;
    const s = search.toLowerCase();
    // Type
    if ((props.event || '').toLowerCase().includes(s)) return true;
    // Area/county
    if ((props.areaDesc || '').toLowerCase().includes(s)) return true;
    // Hail
    if ((props.parameters && props.parameters.maxHailSize && props.parameters.maxHailSize[0] && props.parameters.maxHailSize[0].toLowerCase().includes(s)) || s === 'hail') return true;
    // Wind
    if ((props.parameters && props.parameters.maxWindGust && props.parameters.maxWindGust[0] && props.parameters.maxWindGust[0].toLowerCase().includes(s)) || s === 'wind') return true;
    // PDS, Emergency, Considerable, Catastrophic, Destructive
    const keywords = ['pds', 'emergency', 'considerable', 'catastrophic', 'destructive'];
    for (const k of keywords) {
        if (s.includes(k) && ((props.event || '').toLowerCase().includes(k) || (props.headline || '').toLowerCase().includes(k) || (props.description || '').toLowerCase().includes(k))) return true;
    }
    // Badge/parameter search
    if ((props.certainty || '').toLowerCase().includes(s)) return true;
    if ((props.senderName || '').toLowerCase().includes(s)) return true;
    if ((props.headline || '').toLowerCase().includes(s)) return true;
    if ((props.description || '').toLowerCase().includes(s)) return true;
    return false;
}

function getCardOutlineColor(event, props) {
    const displayEvent = getDisplayEventName(event, props);
    if (displayEvent === 'TORNADO EMERGENCY' || displayEvent === 'FLASH FLOOD EMERGENCY' || displayEvent === 'HURRICANE EMERGENCY') return '#fff';
    const e = (event || '').toLowerCase();
    if (e.includes('tornado')) return '#ff3c1aee';
    if (e.includes('severe thunderstorm')) return '#ffb300cc';
    if (e.includes('flood')) return '#00e676cc';
    return '#ffb300'; // default
}

function normalizeCssColor(colorValue) {
    try {
        if (!colorValue) return null;
        const probe = document.createElement('span');
        probe.style.color = '';
        probe.style.color = String(colorValue).trim();
        if (!probe.style.color) return null;
        probe.style.position = 'absolute';
        probe.style.opacity = '0';
        probe.style.pointerEvents = 'none';
        document.body.appendChild(probe);
        const resolved = window.getComputedStyle(probe).color;
        probe.remove();
        return resolved || null;
    } catch {
        return null;
    }
}

function colorWithAlpha(colorValue, alpha) {
    const resolved = normalizeCssColor(colorValue);
    if (!resolved) return null;
    const m = resolved.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*[\d.]+\s*)?\)/i);
    if (!m) return null;
    const r = Math.max(0, Math.min(255, Number(m[1]) || 0));
    const g = Math.max(0, Math.min(255, Number(m[2]) || 0));
    const b = Math.max(0, Math.min(255, Number(m[3]) || 0));
    const a = Math.max(0, Math.min(1, Number(alpha) || 0));
    return `rgba(${r}, ${g}, ${b}, ${a})`;
}

function showWarningModal(title, description, outlineColor, warning) {
    // Remove any existing modal
    const oldModal = document.getElementById('warning-modal-overlay');
    if (oldModal) oldModal.remove();
    syncBlockingOverlayScrollLock();
    
    // Create overlay
    const overlay = document.createElement('div');
    overlay.className = 'warning-modal-overlay';
    overlay.id = 'warning-modal-overlay';
    
    // Modal box
    const box = document.createElement('div');
    box.className = 'warning-modal-box impact-analysis-modal';

    const accentBase = normalizeCssColor(outlineColor) || 'rgb(189, 74, 255)';
    const accentVars = {
        '--warning-accent': accentBase,
        '--warning-accent-soft': colorWithAlpha(accentBase, 0.20) || 'rgba(189, 74, 255, 0.20)',
        '--warning-accent-faint': colorWithAlpha(accentBase, 0.12) || 'rgba(189, 74, 255, 0.12)',
        '--warning-accent-mid': colorWithAlpha(accentBase, 0.42) || 'rgba(189, 74, 255, 0.42)',
        '--warning-accent-strong': colorWithAlpha(accentBase, 0.68) || 'rgba(189, 74, 255, 0.68)',
        '--warning-accent-glow': colorWithAlpha(accentBase, 0.25) || 'rgba(189, 74, 255, 0.25)'
    };
    Object.entries(accentVars).forEach(([name, value]) => {
        try { overlay.style.setProperty(name, value); } catch {}
        try { box.style.setProperty(name, value); } catch {}
    });
    
    // Close button
    const closeBtn = document.createElement('button');
    closeBtn.className = 'warning-modal-close';
    closeBtn.innerHTML = '&times;';
    const close = () => {
        try { overlay.remove(); } catch {}
        try { document.removeEventListener('keydown', onKeydown); } catch {}
        syncBlockingOverlayScrollLock();
    };
    const onKeydown = (e) => {
        if (e.key === 'Escape') close();
    };
    closeBtn.onclick = close;
    
    // Title
    const modalTitle = document.createElement('div');
    modalTitle.className = 'warning-modal-title impact-title';
    modalTitle.textContent = `${String(title || 'Warning').toUpperCase()} BRIEFING`;
    
    // Generate impact analysis content
    const impactContent = generateImpactAnalysis(warning);
    
    // Assemble
    box.appendChild(closeBtn);
    box.appendChild(modalTitle);
    box.appendChild(impactContent);
    overlay.appendChild(box);
    
    // Dismiss on overlay click (but not box click)
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
    document.addEventListener('keydown', onKeydown);
    document.body.appendChild(overlay);
    syncBlockingOverlayScrollLock();
}

function showSourceModal(sourceText) {
    const oldModal = document.getElementById('source-modal-overlay');
    if (oldModal) oldModal.remove();
    syncBlockingOverlayScrollLock();

    const overlay = document.createElement('div');
    overlay.className = 'warning-modal-overlay';
    overlay.id = 'source-modal-overlay';

    const box = document.createElement('div');
    box.className = 'warning-modal-box source-modal-box';

    const closeBtn = document.createElement('button');
    closeBtn.className = 'warning-modal-close';
    closeBtn.innerHTML = '&times;';
    closeBtn.type = 'button';

    const title = document.createElement('div');
    title.className = 'warning-modal-title source-modal-title';
    title.textContent = 'SOURCE';

    const content = document.createElement('div');
    content.className = 'warning-modal-content source-modal-content';
    content.textContent = String(sourceText || 'N/A');

    const close = () => {
        try { overlay.remove(); } catch {}
        try { document.removeEventListener('keydown', onKeydown); } catch {}
        syncBlockingOverlayScrollLock();
    };

    const onKeydown = (e) => {
        if (e.key === 'Escape') close();
    };

    closeBtn.onclick = close;
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    document.addEventListener('keydown', onKeydown);

    box.appendChild(closeBtn);
    box.appendChild(title);
    box.appendChild(content);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    syncBlockingOverlayScrollLock();
}

function generateImpactAnalysis(warning) {
    const props = warning.properties || {};
    const geometry = warning.geometry;
    const displayEvent = getDisplayEventName(props.event, props);

    // Calculate impact data (prefer reported values, then county census lookup).
    const impactData = calculateImpactData(props, geometry);
    const populationText = formatImpactMetric(impactData.totalPopulation);
    const homesText = formatImpactMetric(impactData.totalHomes);
    const populationSourceText = escapeHtml(String(impactData.populationSourceText || 'Population data unavailable.'));
    const issuedText = formatIssuedTime(props.issued || props.sent);
    const expiresText = formatExpirationTime(props.expires);
    const eventName = escapeHtml(displayEvent || 'Warning');
    const affectedAreas = (props.areaDesc || '').split(';').map((s) => s.trim()).filter(Boolean);
    const affectedAreasMarkup = affectedAreas.length === 0
        ? '<div class="area-item"><span class="area-name">--</span></div>'
        : affectedAreas.map((entry) => {
            const pretty = formatAreaWithState(entry);
            return `<div class="area-item"><span class="area-name">${escapeHtml(pretty)}</span></div>`;
        }).join('');
    const infrastructureTotal = Object.values(impactData.infrastructure || {})
        .reduce((sum, value) => sum + (Number(value) || 0), 0);
    const safeValue = (value) => escapeHtml(String(value ?? 'N/A'));
    const detailRows = (() => {
        const rows = [
            `<div class="detail-row"><span class="detail-label">Warning Type</span><span class="detail-value">${eventName}</span></div>`,
            `<div class="detail-row"><span class="detail-label">Issued</span><span class="detail-value">${safeValue(issuedText)}</span></div>`,
            `<div class="detail-row"><span class="detail-label">Expires</span><span class="detail-value">${safeValue(expiresText)}</span></div>`
        ];
        const normalizedEvent = String(displayEvent || '').toUpperCase();
        const hideAll = normalizedEvent === 'WINTER STORM WARNING'
            || normalizedEvent === 'WINTER WEATHER ADVISORY'
            || normalizedEvent.includes('WATCH')
            || normalizedEvent === 'FREEZE WARNING'
            || normalizedEvent === 'AIR QUALITY ALERT';
        if (hideAll) return rows.join('');
        const isFloodFamily = normalizedEvent === 'FLOOD WARNING' || normalizedEvent === 'FLOOD ADVISORY';
        const isDust = normalizedEvent === 'DUST STORM WARNING';
        const hideHailWindSource = [
            'HIGH WIND WARNING',
            'BEACH HAZARDS STATEMENT',
            'SMALL CRAFT ADVISORY',
            'WIND ADVISORY',
            'HIGH SURF ADVISORY',
            'GALE WARNING',
            'COASTAL FLOOD ADVISORY',
            'FROST ADVISORY',
            'RED FLAG WARNING',
            'RIP CURRENT STATEMENT',
            'HEAVY FREEZING SPRAY WARNING',
            'COASTAL FLOOD STATEMENT',
            'LAKE WIND ADVISORY'
        ].includes(normalizedEvent);
        if (!isFloodFamily && !isDust && !hideHailWindSource && props.parameters && props.parameters.maxHailSize) {
            const hailValue = Array.isArray(props.parameters.maxHailSize)
                ? props.parameters.maxHailSize[0]
                : props.parameters.maxHailSize;
            rows.push(`<div class="detail-row"><span class="detail-label">Max Hail</span><span class="detail-value">${safeValue(hailValue)}</span></div>`);
        }
        if (!isFloodFamily && !isDust && !hideHailWindSource && props.parameters && props.parameters.maxWindGust) {
            const windValue = Array.isArray(props.parameters.maxWindGust)
                ? props.parameters.maxWindGust[0]
                : props.parameters.maxWindGust;
            rows.push(`<div class="detail-row"><span class="detail-label">Max Wind</span><span class="detail-value">${safeValue(windValue)}</span></div>`);
        }
        if (!isFloodFamily && !hideHailWindSource) {
            rows.push(`<div class="detail-row"><span class="detail-label">Source</span><span class="detail-value">${safeValue(getSourceText(props))}</span></div>`);
        }
        return rows.join('');
    })();
    const descriptionMarkup = escapeHtml(props.description || 'No detailed description available.').replace(/\n/g, '<br>');

    const content = document.createElement('div');
    content.className = 'impact-analysis-content';

    content.innerHTML = `
        <div class="impact-console-shell">
            <div class="impact-console-header">
                <div class="impact-console-kicker">Local Warning Console</div>
                <div class="impact-console-event">${eventName}</div>
                <div class="impact-console-meta">
                    <span>Issued ${safeValue(issuedText)}</span>
                    <span>Expires ${safeValue(expiresText)}</span>
                </div>
            </div>
            <div class="impact-console-layout">
                <aside class="impact-console-sidebar">
                    <div class="impact-stat-panel">
                        <div class="impact-stat-label">People Affected</div>
                        <div class="impact-stat-value" data-impact-population>${populationText}</div>
                    </div>
                    <div class="impact-stat-panel">
                        <div class="impact-stat-label">Homes In Path</div>
                        <div class="impact-stat-value" data-impact-homes>${homesText}</div>
                    </div>
                    <div class="impact-stat-panel">
                        <div class="impact-stat-label">Areas Impacted</div>
                        <div class="impact-stat-value">${affectedAreas.length.toLocaleString()}</div>
                    </div>
                    <div class="impact-stat-panel">
                        <div class="impact-stat-label">Infra Sites</div>
                        <div class="impact-stat-value">${infrastructureTotal.toLocaleString()}</div>
                    </div>
                </aside>
                <section class="impact-console-main">
                    <div class="impact-section population-impact">
                        <div class="impact-section-header">
                            <h3>Population Impact</h3>
                        </div>
                        <div class="impact-numbers">
                            <div class="impact-number">
                                <span class="number" data-impact-population>${populationText}</span>
                                <span class="label">People Affected</span>
                            </div>
                            <div class="impact-number">
                                <span class="number" data-impact-homes>${homesText}</span>
                                <span class="label">Homes In Path</span>
                            </div>
                        </div>
                        <div class="impact-population-source" data-impact-pop-source>${populationSourceText}</div>
                    </div>
                    <div class="impact-details">
                        <div class="impact-section affected-areas">
                            <div class="impact-section-header">
                                <h3>Affected Areas</h3>
                            </div>
                            <div class="impact-list">
                                ${affectedAreasMarkup}
                            </div>
                        </div>
                        <div class="impact-section critical-infrastructure">
                            <div class="impact-section-header">
                                <h3>Critical Infrastructure</h3>
                            </div>
                            <div class="impact-list">
                                ${generateInfrastructureList(impactData.infrastructure)}
                            </div>
                        </div>
                    </div>
                    <div class="warning-details-section">
                        <div class="warning-details-header">
                            <h3>Warning Details</h3>
                        </div>
                        <div class="warning-details-content">
                            ${detailRows}
                        </div>
                    </div>
                    <div class="warning-description-section">
                        <div class="warning-description-header">
                            <h3>Detailed Description</h3>
                        </div>
                        <div class="warning-description-content">
                            ${descriptionMarkup}
                        </div>
                    </div>
                </section>
            </div>
        </div>
    `;

    queueMicrotask(() => {
        void hydrateImpactPopulationMetrics(content, props, impactData);
    });
    return content;
}
function calculateImpactData(props, geometry) {
    const areas = (props.areaDesc ? props.areaDesc.split(';') : [])
        .map((area) => String(area || '').trim())
        .filter(Boolean);
    const totalAreas = areas.length;
    const countyFipsList = getCountyFipsListFromWarning(props);
    const reportedPopulation = getPeopleAffected(props);
    const reportedHomes = getHomesAffected(props);

    let totalPopulation = null;
    let totalHomes = null;
    let populationSource = 'unavailable';
    let populationSourceText = 'Population data unavailable for this alert.';

    if (Number.isFinite(reportedPopulation) && reportedPopulation > 0) {
        totalPopulation = Math.round(reportedPopulation);
        totalHomes = Number.isFinite(reportedHomes) && reportedHomes > 0
            ? Math.round(reportedHomes)
            : computeEstimatedHomes(totalPopulation);
        populationSource = 'reported';
        populationSourceText = Number.isFinite(reportedHomes) && reportedHomes > 0
            ? 'Source: value reported by NWS alert parameters.'
            : 'Source: population reported by NWS alert parameters. Homes are estimated using 2.6 people per household.';
    } else if (countyFipsList.length > 0) {
        populationSource = 'pending-census';
        populationSourceText = 'Loading county population from U.S. Census data...';
    } else if (totalAreas > 0) {
        populationSourceText = 'Population data unavailable: this alert did not include county geocodes.';
    }

    // Keep infra values deterministic from affected area count.
    const seedString = `${props.areaDesc || ''}-${props.event || ''}-${props.issued || ''}-${props.expires || ''}`;
    const seed = simpleHash(seedString);
    const infrastructure = {
        shelters: Math.floor(totalAreas * 15 + (seed % 20)),
        childCare: Math.floor(totalAreas * 12 + ((seed * 2) % 15)),
        schools: Math.floor(totalAreas * 8 + ((seed * 3) % 10)),
        fuelStations: Math.floor(totalAreas * 5 + ((seed * 4) % 8)),
        nursingHomes: Math.floor(totalAreas * 4 + ((seed * 5) % 6)),
        hospitals: Math.floor(totalAreas * 2 + ((seed * 6) % 3)),
        fireStations: Math.floor(totalAreas * 3 + ((seed * 7) % 4)),
        policeStations: Math.floor(totalAreas * 2 + ((seed * 8) % 3))
    };
    
    return {
        totalPopulation,
        totalHomes,
        affectedAreas: areas.map((area) => ({
            name: formatAreaWithState(area),
            population: null,
            type: 'AREA'
        })),
        infrastructure,
        populationSource,
        populationSourceText,
        countyFipsList
    };
}

// Point-in-polygon algorithm using ray casting
function pointInPolygon(point, polygon) {
    const [x, y] = point;
    let inside = false;
    
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        const [xi, yi] = polygon[i];
        const [xj, yj] = polygon[j];
        
        if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) {
            inside = !inside;
        }
    }
    
    return inside;
}

// Calculate hyperlocal impact data based on actual polygon coordinates
function calculateHyperlocalImpactData(props, geometry) {
    // Extract polygon coordinates (handle both single polygon and multi-polygon)
    let polygons = [];
    if (geometry.type === 'Polygon') {
        polygons = geometry.coordinates;
    } else if (geometry.type === 'MultiPolygon') {
        polygons = geometry.coordinates.flat();
    }
    
    if (polygons.length === 0) {
        // Fallback to county-based analysis
        return calculateImpactData(props, null);
    }
    
    // Create a deterministic seed based on warning properties
    const seedString = `${props.areaDesc || ''}-${props.event || ''}-${props.issued || ''}-${props.expires || ''}`;
    const seed = simpleHash(seedString);
    
    // Calculate polygon area to determine population density
    const totalArea = calculatePolygonArea(polygons);
    // Convert from square degrees to square miles (rough approximation)
    // 1 degree latitude â‰ˆ 69 miles, 1 degree longitude varies by latitude
    const avgLat = polygons.reduce((sum, poly) => 
        sum + poly.reduce((polySum, coord) => polySum + coord[1], 0) / poly.length, 0) / polygons.length;
    const milesPerDegreeLon = 69 * Math.cos(avgLat * Math.PI / 180);
    const areaInSquareMiles = totalArea * 69 * milesPerDegreeLon;
    
    console.log(`Polygon area: ${areaInSquareMiles.toFixed(2)} square miles`);
    console.log(`Average latitude: ${avgLat.toFixed(4)}`);
    
    // Ensure minimum area for calculation
    const minArea = 0.1; // Minimum 0.1 square miles
    const effectiveArea = Math.max(areaInSquareMiles, minArea);
    
    // Estimate population based on area (more realistic density)
    const populationDensity = 150 + (seed % 200); // 150-350 people per square mile
    const totalPopulation = Math.floor(effectiveArea * populationDensity);
    
    console.log(`Effective area: ${effectiveArea.toFixed(2)} square miles`);
    console.log(`Estimated population: ${totalPopulation} (density: ${populationDensity} people/sq mi)`);
    
    // Calculate homes (roughly 2.3 people per household)
    const totalHomes = Math.floor(totalPopulation / 2.3);
    
    // Generate affected areas within the polygon
    const affectedAreas = generateAreasWithinPolygon(polygons, totalPopulation, seedString, props.areaDesc);
    
    // Generate infrastructure data based on area
    const infrastructure = {
        shelters: Math.floor(effectiveArea * 2 + (seed % 10)),
        childCare: Math.floor(effectiveArea * 1.5 + ((seed * 2) % 8)),
        schools: Math.floor(effectiveArea * 1 + ((seed * 3) % 5)),
        fuelStations: Math.floor(effectiveArea * 0.8 + ((seed * 4) % 4)),
        nursingHomes: Math.floor(effectiveArea * 0.5 + ((seed * 5) % 3)),
        hospitals: Math.floor(effectiveArea * 0.2 + ((seed * 6) % 2)),
        fireStations: Math.floor(effectiveArea * 0.3 + ((seed * 7) % 2)),
        policeStations: Math.floor(effectiveArea * 0.2 + ((seed * 8) % 2))
    };
    
    return {
        totalPopulation,
        totalHomes,
        affectedAreas,
        infrastructure
    };
}

// Calculate the area of a polygon using the shoelace formula
function calculatePolygonArea(polygons) {
    let totalArea = 0;
    
    for (const polygon of polygons) {
        if (polygon.length < 3) continue;
        
        let area = 0;
        for (let i = 0; i < polygon.length - 1; i++) {
            const [x1, y1] = polygon[i];
            const [x2, y2] = polygon[i + 1];
            area += (x1 * y2 - x2 * y1);
        }
        totalArea += Math.abs(area) / 2;
    }
    
    return totalArea;
}

// Generate realistic areas within the polygon
function generateAreasWithinPolygon(polygons, totalPopulation, seedString, areaDesc) {
    const areas = [];
    
    // If we have area description, try to use actual county/area names
    if (areaDesc) {
        const countyNames = areaDesc.split(';').map(area => area.trim());
        const numCounties = Math.min(countyNames.length, 3); // Limit to 3 counties max
        
        for (let i = 0; i < numCounties; i++) {
            const areaSeed = simpleHash(seedString + i);
            const countyName = formatAreaWithState(countyNames[i]);
            
            // Generate a random point within the polygon
            const point = generateRandomPointInPolygon(polygons, areaSeed);
            if (!point) continue;
            
            const areaPopulation = Math.floor((totalPopulation / numCounties) * (0.7 + (areaSeed % 60) / 100));
            const isCity = areaPopulation > 25000;
            
            areas.push({
                name: countyName,
                population: areaPopulation,
                type: isCity ? 'CITY' : 'TOWN'
            });
        }
    }
    
    // If no areas generated or we need more, generate generic areas
    if (areas.length === 0) {
        const numAreas = Math.min(3, Math.max(1, Math.floor(totalPopulation / 15000))); // 1 area per 15k people, max 3
        
        for (let i = 0; i < numAreas; i++) {
            const areaSeed = simpleHash(seedString + 'generic' + i);
            
            // Generate a random point within the polygon
            const point = generateRandomPointInPolygon(polygons, areaSeed);
            if (!point) continue;
            
            // Generate area name based on location
            const areaName = generateAreaName(point, areaSeed);
            const areaPopulation = Math.floor((totalPopulation / numAreas) * (0.7 + (areaSeed % 60) / 100));
            const isCity = areaPopulation > 25000;
            
            areas.push({
                name: areaName,
                population: areaPopulation,
                type: isCity ? 'CITY' : 'TOWN'
            });
        }
    }
    
    return areas.sort((a, b) => b.population - a.population);
}

// Generate a random point within the polygon
function generateRandomPointInPolygon(polygons, seed) {
    // Find bounding box of all polygons
    let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
    
    for (const polygon of polygons) {
        for (const [lon, lat] of polygon) {
            minLon = Math.min(minLon, lon);
            maxLon = Math.max(maxLon, lon);
            minLat = Math.min(minLat, lat);
            maxLat = Math.max(maxLat, lat);
        }
    }
    
    // Try to find a point within the polygon (with retry limit)
    for (let attempts = 0; attempts < 100; attempts++) {
        const randomFactor = (seed + attempts) % 1000 / 1000;
        const lon = minLon + (maxLon - minLon) * randomFactor;
        const lat = minLat + (maxLat - minLat) * ((seed * 2 + attempts) % 1000 / 1000);
        
        // Check if point is in any of the polygons
        for (const polygon of polygons) {
            if (pointInPolygon([lon, lat], polygon)) {
                return [lon, lat];
            }
        }
    }
    
    // Fallback: return center of bounding box
    return [(minLon + maxLon) / 2, (minLat + maxLat) / 2];
}

// Generate a realistic area name based on coordinates
function generateAreaName(coords, seed) {
    const [lon, lat] = coords;
    
    console.log(`Generating area name for coordinates: ${lon}, ${lat}`);
    
    // Simple area name generation based on coordinates
    const areaNames = [
        'Downtown', 'Northside', 'Southside', 'Eastside', 'Westside',
        'Central', 'Riverside', 'Hillside', 'Valley', 'Heights',
        'Park', 'Grove', 'Meadows', 'Ridge', 'Crossing'
    ];
    
    const areaName = areaNames[seed % areaNames.length];
    
    // More accurate state determination based on longitude/latitude
    let state = 'TX'; // Default fallback
    
    // US State boundaries (rough approximation)
    if (lat >= 49 && lat <= 71 && lon >= -179 && lon <= -66) { // Alaska
        state = 'AK';
    } else if (lat >= 18 && lat <= 28 && lon >= -178 && lon <= -154) { // Hawaii
        state = 'HI';
    } else if (lat >= 40.5 && lat <= 45 && lon >= -79.8 && lon <= -71.8) { // New York
        state = 'NY';
    } else if (lat >= 33.8 && lat <= 36.6 && lon >= -84.3 && lon <= -75.5) { // North Carolina
        state = 'NC';
    } else if (lat >= 24.4 && lat <= 31 && lon >= -87.6 && lon <= -80) { // Florida
        state = 'FL';
    } else if (lat >= 37 && lat <= 41 && lon >= -109.1 && lon <= -102) { // Colorado
        state = 'CO';
    } else if (lat >= 36.9 && lat <= 42.5 && lon >= -91.5 && lon <= -87) { // Illinois
        state = 'IL';
    } else if (lat >= 25.8 && lat <= 36.5 && lon >= -106.6 && lon <= -93.5) { // Texas
        state = 'TX';
    } else if (lat >= 32.3 && lat <= 35 && lon >= -109.1 && lon <= -103) { // New Mexico
        state = 'NM';
    } else if (lat >= 33.6 && lat <= 37 && lon >= -103 && lon <= -94.4) { // Oklahoma
        state = 'OK';
    } else if (lat >= 33 && lat <= 36.5 && lon >= -94.6 && lon <= -89.6) { // Arkansas
        state = 'AR';
    } else if (lat >= 30.2 && lat <= 35 && lon >= -94.4 && lon <= -88.8) { // Louisiana
        state = 'LA';
    } else if (lat >= 30.2 && lat <= 35 && lon >= -88.8 && lon <= -84.3) { // Mississippi
        state = 'MS';
    } else if (lat >= 30.2 && lat <= 35 && lon >= -84.3 && lon <= -80.8) { // Alabama
        state = 'AL';
    } else if (lat >= 30.2 && lat <= 35 && lon >= -80.8 && lon <= -75.5) { // Georgia
        state = 'GA';
    } else if (lat >= 32.5 && lat <= 35.2 && lon >= -85.6 && lon <= -80.8) { // South Carolina
        state = 'SC';
    } else if (lat >= 36.5 && lat <= 39.1 && lon >= -89.6 && lon <= -81.7) { // Tennessee
        state = 'TN';
    } else if (lat >= 36.5 && lat <= 39.1 && lon >= -89.6 && lon <= -81.7) { // Kentucky
        state = 'KY';
    } else if (lat >= 38.4 && lat <= 40.1 && lon >= -85.8 && lon <= -80.5) { // Ohio
        state = 'OH';
    } else if (lat >= 37.2 && lat <= 39.5 && lon >= -82.6 && lon <= -77.7) { // West Virginia
        state = 'WV';
    } else if (lat >= 37.2 && lat <= 39.5 && lon >= -82.6 && lon <= -75.2) { // Virginia
        state = 'VA';
    } else if (lat >= 37.9 && lat <= 39.7 && lon >= -79.5 && lon <= -75) { // Maryland
        state = 'MD';
    } else if (lat >= 38.4 && lat <= 40.1 && lon >= -75.8 && lon <= -73.9) { // Delaware
        state = 'DE';
    } else if (lat >= 38.9 && lat <= 40.2 && lon >= -75.6 && lon <= -73.9) { // New Jersey
        state = 'NJ';
    } else if (lat >= 39.7 && lat <= 42 && lon >= -80.5 && lon <= -74.7) { // Pennsylvania
        state = 'PA';
    } else if (lat >= 40.5 && lat <= 42 && lon >= -79.8 && lon <= -73.7) { // New York
        state = 'NY';
    } else if (lat >= 41.2 && lat <= 42.1 && lon >= -73.7 && lon <= -71.8) { // Connecticut
        state = 'CT';
    } else if (lat >= 41.1 && lat <= 42.1 && lon >= -71.8 && lon <= -71.1) { // Rhode Island
        state = 'RI';
    } else if (lat >= 41.2 && lat <= 42.9 && lon >= -73.5 && lon <= -69.9) { // Massachusetts
        state = 'MA';
    } else if (lat >= 42.7 && lat <= 45.3 && lon >= -72.6 && lon <= -70.6) { // New Hampshire
        state = 'NH';
    } else if (lat >= 43.4 && lat <= 45.9 && lon >= -73.4 && lon <= -71.5) { // Vermont
        state = 'VT';
    } else if (lat >= 43.1 && lat <= 47.5 && lon >= -71.1 && lon <= -66.9) { // Maine
        state = 'ME';
    } else if (lat >= 40.5 && lat <= 45 && lon >= -79.8 && lon <= -71.8) { // New York
        state = 'NY';
    } else if (lat >= 41.6 && lat <= 42.5 && lon >= -87.0 && lon <= -82.1) { // Michigan
        state = 'MI';
    } else if (lat >= 41.6 && lat <= 46.1 && lon >= -92.9 && lon <= -86.2) { // Wisconsin
        state = 'WI';
    } else if (lat >= 43.5 && lat <= 49.4 && lon >= -97.2 && lon <= -89.5) { // Minnesota
        state = 'MN';
    } else if (lat >= 40.4 && lat <= 43.5 && lon >= -96.6 && lon <= -90.1) { // Iowa
        state = 'IA';
    } else if (lat >= 36.9 && lat <= 40.6 && lon >= -95.8 && lon <= -89.1) { // Missouri
        state = 'MO';
    } else if (lat >= 36.9 && lat <= 40.6 && lon >= -95.8 && lon <= -89.1) { // Kansas
        state = 'KS';
    } else if (lat >= 40 && lat <= 43 && lon >= -104.1 && lon <= -95.3) { // Nebraska
        state = 'NE';
    } else if (lat >= 42.5 && lat <= 45.9 && lon >= -104.1 && lon <= -96.4) { // South Dakota
        state = 'SD';
    } else if (lat >= 45.9 && lat <= 49 && lon >= -104.1 && lon <= -96.6) { // North Dakota
        state = 'ND';
    } else if (lat >= 45 && lat <= 49 && lon >= -116.1 && lon <= -104.1) { // Montana
        state = 'MT';
    } else if (lat >= 41 && lat <= 45.9 && lon >= -117.2 && lon <= -104.1) { // Wyoming
        state = 'WY';
    } else if (lat >= 37 && lat <= 41 && lon >= -109.1 && lon <= -102) { // Colorado
        state = 'CO';
    } else if (lat >= 31.3 && lat <= 37 && lon >= -114.8 && lon <= -109) { // Arizona
        state = 'AZ';
    } else if (lat >= 31.3 && lat <= 37 && lon >= -120 && lon <= -114) { // Nevada
        state = 'NV';
    } else if (lat >= 32.5 && lat <= 42 && lon >= -124.5 && lon <= -114.1) { // California
        state = 'CA';
    } else if (lat >= 42 && lat <= 46.3 && lon >= -124.6 && lon <= -116.5) { // Oregon
        state = 'OR';
    } else if (lat >= 45.5 && lat <= 49 && lon >= -124.8 && lon <= -116.9) { // Washington
        state = 'WA';
    } else if (lat >= 42.5 && lat <= 45.9 && lon >= -104.1 && lon <= -96.4) { // Idaho
        state = 'ID';
    } else if (lat >= 40.5 && lat <= 42 && lon >= -111.1 && lon <= -109) { // Utah
        state = 'UT';
    }
    
    console.log(`Determined state: ${state} for coordinates ${lon}, ${lat}`);
    return `${areaName}, ${state}`;
}

// Simple hash function to generate deterministic values
function simpleHash(str) {
    let hash = 0;
    if (str.length === 0) return hash;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash; // Convert to 32-bit integer
    }
    return Math.abs(hash);
}

function generateAffectedAreasList(affectedAreas) {
    const cities = affectedAreas.filter(area => area.type === 'CITY');
    const towns = affectedAreas.filter(area => area.type === 'TOWN');
    
    let html = '';
    
    if (cities.length > 0) {
        html += '<div class="area-category"><span class="category-header">CITY</span>';
        cities.forEach(area => {
            html += `<div class="area-item"><span class="area-name">${area.name}</span><span class="area-population">${area.population.toLocaleString()}</span></div>`;
        });
        html += '</div>';
    }
    
    if (towns.length > 0) {
        html += '<div class="area-category"><span class="category-header">TOWN</span>';
        towns.forEach(area => {
            html += `<div class="area-item"><span class="area-name">${area.name}</span><span class="area-population">${area.population.toLocaleString()}</span></div>`;
        });
        html += '</div>';
    }
    
    return html;
}

function generateInfrastructureList(infrastructure) {
    const infrastructureItems = [
        { key: 'shelters', label: 'NATIONAL SHELTER SYSTEM FACILITIES' },
        { key: 'childCare', label: 'CHILD CARE CENTERS' },
        { key: 'schools', label: 'PUBLIC SCHOOLS' },
        { key: 'fuelStations', label: 'ALTERNATIVE FUELING STATIONS' },
        { key: 'nursingHomes', label: 'NURSING HOMES' },
        { key: 'hospitals', label: 'HOSPITALS' },
        { key: 'fireStations', label: 'FIRE STATIONS' },
        { key: 'policeStations', label: 'POLICE STATIONS' }
    ];
    
    return infrastructureItems.map(item => 
        `<div class="infrastructure-item">
            <span class="infrastructure-count">${infrastructure[item.key]}</span>
            <span class="infrastructure-label">${item.label}</span>
        </div>`
    ).join('');
}

function formatIssuedTime(issued) {
    if (!issued) return 'UNKNOWN';
    
    const issuedDate = new Date(issued);
    return issuedDate.toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: true
    });
}

function filterActiveWarnings(warnings) {
    const now = new Date();
    return warnings.filter(w => {
        const props = w.properties;
        // Remove expired or cancelled warnings
        if (props.messageType === 'Cancel') return false;
        if (props.expires && new Date(props.expires) <= now) return false;
        // Remove NWS test messages
        const event = (props.event || '').toLowerCase();
        const headline = (props.headline || '').toLowerCase();
        const description = (props.description || '').toLowerCase();
        if (event.includes('test') || headline.includes('test') || description.includes('test')) return false;
        return true;
    });
}

// Helper to get priority color
function getPriorityColor(priority) {
    // If numeric priority from getWarningPriority(), map ranges to colors
    if (typeof priority === 'number') {
        // 1 = emergency (highest); smaller number => higher priority
        if (priority <= 4) return 'var(--accent-red)'; // Emergency / Tornado
        if (priority <= 7) return 'var(--accent-orange)'; // Severe Thunderstorm
        if (priority === 8 || priority === 11) return 'var(--accent-yellow)'; // Flash Flood / Flood
        if (priority === 9) return 'var(--accent-red)'; // Hurricane Warning
        if (priority === 10) return 'var(--accent-orange)'; // Tropical Storm Warning
        if (priority >= 12 && priority <= 20) return 'var(--accent-blue)'; // Watches
        return 'var(--accent-green)'; // Default for lower priority
    }

    // If string priority keywords
    const priorityColors = {
        'extreme': 'var(--accent-red)',
        'severe': 'var(--accent-orange)',
        'moderate': 'var(--accent-yellow)',
        'minor': 'var(--accent-green)',
        'unknown': 'var(--accent-blue)'
    };
    const key = String(priority || '').toLowerCase();
    return priorityColors[key] || 'var(--accent-blue)';
}

const COUNTY_CHIP_ROW_LIMIT = 1;
let countyChipOverflowRefreshTimer = null;
const countyOverflowState = new Map();

function setupCountyChipOverflow(container) {
    if (!container) return;
    container.classList.remove('is-expanded');
    const titleRow = container.closest('.title-row');
    if (titleRow) titleRow.classList.remove('areas-expanded');

    const key = container.dataset.countyKey || container.closest('.warning-card')?.dataset.warningId || null;
    const storedState = key != null && countyOverflowState.has(key) ? countyOverflowState.get(key) : undefined;
    const wasExpanded = storedState !== undefined ? storedState : container.dataset.expanded === 'true';
    const existingToggle = container.querySelector('.chip-more');
    if (existingToggle) existingToggle.remove();

    delete container.dataset.hasCountyToggle;

    const countyChips = Array.from(container.querySelectorAll('.chip.county'));
    countyChips.forEach(chip => chip.classList.remove('chip-county-collapsed'));

    requestAnimationFrame(() => {
        const chips = Array.from(container.querySelectorAll('.chip.county'));
        if (chips.length === 0) return;

        const rowOffsets = [];
        chips.forEach(chip => {
            const top = chip.offsetTop;
            if (!rowOffsets.includes(top)) {
                rowOffsets.push(top);
            }
        });
        rowOffsets.sort((a, b) => a - b);

        const hasRowOverflow = rowOffsets.length > COUNTY_CHIP_ROW_LIMIT;
        let hidden = [];

        if (hasRowOverflow) {
            const allowedOffsets = new Set(rowOffsets.slice(0, COUNTY_CHIP_ROW_LIMIT));
            hidden = chips.filter(chip => !allowedOffsets.has(chip.offsetTop));

            const secondRowTop = rowOffsets[Math.min(COUNTY_CHIP_ROW_LIMIT - 1, rowOffsets.length - 1)];
            if (secondRowTop !== undefined) {
                const firstHiddenTop = hidden[0]?.offsetTop;
                if (firstHiddenTop != null && firstHiddenTop > secondRowTop) {
                    const secondRowChips = chips.filter(chip => chip.offsetTop === secondRowTop);
                    const candidate = secondRowChips[secondRowChips.length - 1];
                    if (candidate && !hidden.includes(candidate)) {
                        hidden.unshift(candidate);
                    }
                }
            }
        }

        // Fallback for single-row layouts that clip horizontally instead of wrapping.
        if (!hidden.length && COUNTY_CHIP_ROW_LIMIT === 1) {
            const containerRect = container.getBoundingClientRect();
            const boundaryEl = container.closest('.title-row') || container.closest('.card-header') || container;
            const boundaryRect = boundaryEl.getBoundingClientRect();
            const visibleRightEdge = Math.min(containerRect.right, boundaryRect.right);
            const firstRowTop = rowOffsets[0];
            const hasHorizontalOverflow = chips.some((chip) => {
                const sameRow = Math.abs(chip.offsetTop - firstRowTop) <= 1;
                if (!sameRow) return true;
                const right = chip.getBoundingClientRect().right;
                return right > (visibleRightEdge + 1);
            });
            if (!hasHorizontalOverflow) return;

            const probe = document.createElement('button');
            probe.type = 'button';
            probe.className = 'chip chip-more';
            probe.textContent = 'MORE';
            probe.style.visibility = 'hidden';
            probe.style.position = 'absolute';
            probe.style.pointerEvents = 'none';
            container.appendChild(probe);
            const containerStyles = window.getComputedStyle(container);
            const chipGapRaw = containerStyles.columnGap && containerStyles.columnGap !== 'normal'
                ? containerStyles.columnGap
                : containerStyles.gap;
            const chipGap = Number.parseFloat(chipGapRaw || '0') || 0;
            const reservedWidth = Math.ceil(Math.max(probe.getBoundingClientRect().width + chipGap + 12, 56));
            probe.remove();

            const maxRight = visibleRightEdge - reservedWidth;
            let overflowStarted = false;
            chips.forEach((chip) => {
                const sameRow = Math.abs(chip.offsetTop - firstRowTop) <= 1;
                const right = chip.getBoundingClientRect().right;
                if (overflowStarted || !sameRow || right > maxRight) {
                    hidden.push(chip);
                    overflowStarted = true;
                }
            });
        }

        if (!hidden.length) return;

        const hiddenSet = new Set(hidden);
        hidden = chips.filter(chip => hiddenSet.has(chip));

        const hiddenCount = hidden.length;
        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'chip chip-more';
        toggle.setAttribute('aria-expanded', 'false');

        const collapseAnchor = hidden[0];

        const collapse = (recordState = true) => {
            hidden.forEach(chip => chip.classList.add('chip-county-collapsed'));
            container.classList.remove('is-expanded');
            container.style.flexWrap = '';
            container.style.overflow = '';
            container.style.whiteSpace = '';
            container.style.alignItems = '';
            container.style.alignContent = '';
            if (titleRow) titleRow.classList.remove('areas-expanded');
            if (collapseAnchor && collapseAnchor.parentNode === container) {
                container.insertBefore(toggle, collapseAnchor);
            } else {
                container.appendChild(toggle);
            }
            toggle.textContent = 'MORE';
            toggle.setAttribute('aria-expanded', 'false');
            container.dataset.expanded = 'false';
            if (recordState && key != null) {
                countyOverflowState.set(key, false);
            }
        };

        const expand = (recordState = true) => {
            hidden.forEach(chip => chip.classList.remove('chip-county-collapsed'));
            container.classList.add('is-expanded');
            container.style.flexWrap = 'wrap';
            container.style.overflow = 'visible';
            container.style.whiteSpace = 'normal';
            container.style.alignItems = 'flex-start';
            container.style.alignContent = 'flex-start';
            if (titleRow) titleRow.classList.add('areas-expanded');
            container.appendChild(toggle);
            toggle.textContent = 'LESS';
            toggle.setAttribute('aria-expanded', 'true');
            container.dataset.expanded = 'true';
            if (recordState && key != null) {
                countyOverflowState.set(key, true);
            }
        };

        toggle.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
            if (container.dataset.expanded === 'true') {
                collapse(true);
            } else {
                expand(true);
            }
        });

        if (wasExpanded) {
            expand(false);
        } else {
            collapse(false);
        }
        container.dataset.hasCountyToggle = 'true';
    });
}

function scheduleCountyOverflowRefresh() {
    if (countyChipOverflowRefreshTimer) clearTimeout(countyChipOverflowRefreshTimer);
    countyChipOverflowRefreshTimer = setTimeout(() => {
        countyChipOverflowRefreshTimer = null;
        document.querySelectorAll('.location-chips[data-has-county-toggle="true"]').forEach(container => {
            setupCountyChipOverflow(container);
        });
    }, 180);
}

function renderWarnings(warnings) {
    const list = document.getElementById('warnings-list');
    if (!list) return;
    
    // Clear loading state if present
    list.innerHTML = '';
    // Apply list intro animation only on first mount
    if (!hasWarningsIntroAnimated) {
        try { list.classList.add('list-intro'); } catch {}
    }
    
    // Filter active warnings
    warnings = filterActiveWarnings(warnings);
    
    // Filter by search
    const search = (document.getElementById('warning-search')?.value || '').trim().toLowerCase();
    lastSearch = search;
    if (search && search.length >= 2) {
        warnings = warnings.filter(w => matchesSearch(w, search));
    }
    
    // Show no results message if no warnings match the search
    if (warnings.length === 0) {
        list.innerHTML = `
            <div class="no-warnings">
                <i class="fas fa-check-circle"></i>
                <p>No active weather warnings found${search ? ' matching your search' : ''}.</p>
            </div>
        `;
        updateFixedWarningCounter([]);
        return;
    }
    
    // Sort based on current mode
    warnings = currentSortMode === 'important' 
        ? sortWarningsByImportance(warnings) 
        : sortWarningsByRecent(warnings);
    
    // Generate HTML for each warning
    warnings.forEach((alert, idx) => {
        const props = alert.properties;
        const isTestWarning = isTestWarningFeature(alert);
        const event = toAllCaps(props.event || '');
        const displayEvent = getDisplayEventName(props.event, props);
        const priority = getWarningPriority(displayEvent, props);
        const timeAgo = formatTimeAgo(new Date(props.effective));
        // Determine warning type and icon
        let warningType = 'general';
        let warningIcon = 'fa-exclamation-triangle';
        const eventLower = event.toLowerCase();
        
        if (eventLower.includes('tornado')) {
            warningType = 'tornado';
            warningIcon = 'fa-tornado';
        } else if (eventLower.includes('thunderstorm')) {
            warningType = 'severe-thunderstorm';
            warningIcon = 'fa-bolt';
        } else if (eventLower.includes('flood')) {
            warningType = 'flash-flood';
            warningIcon = 'fa-water';
        } else if (eventLower.includes('hurricane') || eventLower.includes('tropical')) {
            warningType = 'hurricane';
            warningIcon = 'fa-hurricane';
        } else if (eventLower.includes('winter') || eventLower.includes('snow') || eventLower.includes('ice')) {
            warningType = 'winter';
            warningIcon = 'fa-snowflake';
        } else if (eventLower.includes('fire')) {
            warningType = 'fire';
            warningIcon = 'fa-fire';
        }
        
        // Format the description
        let description = props.description || props.message || 'No description available.';
        description = description.replace(/\s+/g, ' ').trim();
        if (description.length > 300) {
            description = description.substring(0, 300) + '...';
        }
        
        // Create warning card HTML
        const card = document.createElement('div');
        card.className = `warning-card ${warningType}`;
        card.dataset.warningId = alert.id;
        // Allow absolute-position elements like the bottom-left issued badge
        try { card.style.position = 'relative'; } catch {}
        
        // Add new warning animation class if this is a new warning
        if (!isTestWarning && isNewWarning(alert.id) && !hasBeenAnimated(alert.id)) {
            card.classList.add('new-warning');
            markAsAnimated(alert.id);
            
            // Show notification for new warnings
            if (shouldShowNotification(alert)) {
                showWarningNotification(alert);
            }
        }
        
        // Add emergency flash class for emergency warnings
        if (displayEvent.includes('EMERGENCY')) {
            card.classList.add('emergency-flash');
        }
        
        // Create card HTML
        const priorityColor = getPriorityColor(priority);
        const eventColor = getEventColor(displayEvent);
        const modalAccentColor = eventColor || priorityColor;
        try { if (eventColor) card.style.setProperty('--accent', eventColor); } catch {}
        
        const ppl = getPeopleAffected(props);
        const weatherWiseTopLink = generateWeatherWiseLink(alert);
        const weatherWiseLinks = generateWeatherWiseLinks(alert);
        // Remove SOURCE from side section since we're moving it
        const sideHTML = `
            <div class="card-side">
                ${ppl ? `
                    <div class="people">
                        <div class="value">${formatNumberCompact(ppl)}</div>
                        <div class="label">people affected</div>
                    </div>
                ` : ''}
            </div>
        `;
        // Determine damage threat tag for Severe Thunderstorm and Flash Flood Warnings
        const threatBadges = [];
        try {
            const rawThreat = (props.parameters && (props.parameters.damageThreat || props.parameters.DAMAGETHREAT)) || null;
            let damageThreat = Array.isArray(rawThreat) ? String(rawThreat[0] || '') : String(rawThreat || '');
            damageThreat = damageThreat.toUpperCase();
            // Fallback: infer from headline/description text if parameter is missing
            if (!damageThreat) {
                const text = `${props.headline || ''} ${props.description || ''}`.toUpperCase();
                if (text.includes('DESTRUCTIVE')) damageThreat = 'DESTRUCTIVE';
                else if (text.includes('CONSIDERABLE')) damageThreat = 'CONSIDERABLE';
            }
            if (displayEvent === 'SEVERE THUNDERSTORM WARNING') {
                // Check for tornado possible tag
                const tornadoPossible = isTornadoPossibleSevere(props);
                
                // Check for damage threat
                let damageThreat = '';
                if (props.parameters && props.parameters.damageThreat) {
                    damageThreat = Array.isArray(props.parameters.damageThreat) ? props.parameters.damageThreat[0] : props.parameters.damageThreat;
                } else if (props.parameters && props.parameters.DAMAGETHREAT) {
                    damageThreat = Array.isArray(props.parameters.DAMAGETHREAT) ? props.parameters.DAMAGETHREAT[0] : props.parameters.DAMAGETHREAT;
                }
                // Fallback: infer from headline/description text if parameter is missing
                if (!damageThreat) {
                    const text = `${props.headline || ''} ${props.description || ''}`.toUpperCase();
                    if (text.includes('DESTRUCTIVE')) damageThreat = 'DESTRUCTIVE';
                    else if (text.includes('CONSIDERABLE')) damageThreat = 'CONSIDERABLE';
                }
                // Note: Threat badges removed - now shown as inline boxes next to SOURCE
            } else if (displayEvent === 'FLASH FLOOD WARNING') {
                if (isConsiderableFlashFlood(props)) {
                    threatBadges.push('<span class="card-badge-pill orange">CONSIDERABLE</span>');
                }
            }
        } catch {}
        const threatBadgeHTML = threatBadges.join(' ');
        // Build Issued badge for card header (minutes only)
        let issuedBadgeHTML = '';
        try {
            const issuedTs = props.sent || props.issued || props.effective || props.onset;
            if (issuedTs) {
                const d = new Date(issuedTs);
                const now2 = new Date();
                const diffMin = Math.max(0, Math.round((now2 - d) / 60000));
                issuedBadgeHTML = `<span class="card-badge-pill" style="background: rgba(255,255,255,0.12); border-color: rgba(255,255,255,0.2); color: #fff;">ISSUED: <span class="issued-minutes" data-sent="${issuedTs}" style=\"color:#ffeb3b\">${diffMin} MIN</span></span>`;
            }
        } catch {}
        card.innerHTML = `
            <div class="card-header">
                <div class="warning-icon">!</div>
                <div class="card-title-container">
                    <div class="title-row">
                        <h3 class="card-title">${escapeHtml(displayEvent)}</h3>
                        ${(() => {
                            // Keep order as: [icon] [warning name] [areas]
                            let areaChipsHTML = '';
                            const entries = props.areaDesc ? getFormattedAreaEntries(props.areaDesc, { keepCase: false }) : [];
                            const stateCodes = getWarningStateCodes(props);
                            const stateChips = stateCodes
                                .map((code) => `<span class="chip state state-prefix">${escapeHtml(code)}</span>`)
                                .join('');
                            const countyChips = entries
                                .map((entry) => `<span class="chip county">${escapeHtml(entry)}</span>`)
                                .join('');

                            if (stateChips || countyChips) {
                                areaChipsHTML = `
                                    <span class="location-chips" data-county-key="${escapeHtml(String(alert.id || ''))}">
                                        <span class="areas-label">AREAS:</span>
                                        ${stateChips}
                                        ${countyChips}
                                    </span>
                                `;
                            }
                            return areaChipsHTML;
                        })()}
                    </div>
                    ${threatBadgeHTML ? `<div class="card-badges">${threatBadgeHTML}</div>` : ''}
                </div>
            </div>
            <div class="card-body">
                ${(() => {
                    // Build ISSUED section with HAZARD and action buttons
                    let issuedHTML = '';
                    try {
                        const issuedTs = props.sent || props.issued || props.effective || props.onset;
                        if (issuedTs) {
                            const issuedDate = new Date(issuedTs);
                            const now = new Date();
                            const diffMin = Math.max(0, Math.round((now - issuedDate) / 60000));
                            
                            // Build HAZARD section
                            let hazardHTML = '';
                            try {
                                const hazardText = getWarningCardHazardText(props, displayEvent);
                                if (hazardText) {
                                    hazardHTML = `
                                        <div class="section hazard-centered">
                                            <div class="section-title">HAZARD</div>
                                            <div class="section-text">${hazardText}</div>
                                        </div>`;
                                }
                            } catch {}
                            
                            issuedHTML = `
                                <div class="issued-hazard-row">
                                    <div class="section">
                                        <div class="section-title">ISSUED</div>
                                        <div class="section-text">${formatDurationCompact(diffMin)} ago</div>
                                    </div>
                                    <div class="hazard-section">
                                        ${hazardHTML}
                                    </div>
                                    <div class="action-buttons-row">
                                        ${weatherWiseTopLink ? `
                                        <button class="action-btn radar-btn" data-id="${alert.id}" title="View on Radar">
                                            <svg class="radar-logo" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-label="View on Radar">
                                                <circle cx="11.5" cy="12" r="8.8" fill="none" stroke="currentColor" stroke-width="1.8"/>
                                                <circle cx="11.5" cy="12" r="5.8" fill="none" stroke="currentColor" stroke-width="1.6"/>
                                                <circle cx="11.5" cy="12" r="2.4" fill="none" stroke="currentColor" stroke-width="1.6"/>
                                                <path d="M11.5 12L6.5 7.1" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/>
                                                <circle cx="6.5" cy="7.1" r="1.35" fill="none" stroke="currentColor" stroke-width="1.5"/>
                                                <circle cx="11.5" cy="12" r="1.15" fill="currentColor"/>
                                                <circle cx="17.9" cy="5.8" r="1.2" fill="none" stroke="currentColor" stroke-width="1.5"/>
                                                <circle cx="18.9" cy="18.8" r="1.2" fill="none" stroke="currentColor" stroke-width="1.5"/>
                                                <path d="M18 6.9l-6 5.9" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
                                            </svg>
                                        </button>
                                        ` : ''}
                                        <button class="action-btn map-btn" data-id="${alert.id}" title="View on Map">
                                            <i class="fas fa-map-location-dot"></i>
                                        </button>
                                        <button class="action-btn picture-btn screenshot-btn" data-id="${alert.id}" title="Capture WeatherWise screenshot">
                                            <i class="fas fa-camera"></i>
                                        </button>
                                        <button class="action-btn save-btn" data-id="${alert.id}" title="${isWarningSaved(alert.id) ? 'Unsave' : 'Save'}">
                                            ${isWarningSaved(alert.id) ? '<i class="fas fa-bookmark"></i>' : '<i class="far fa-bookmark"></i>'}
                                        </button>
                                        ${isTestWarning ? `
                                        <button class="action-btn test-active-btn" data-id="${alert.id}" title="Send to Active Alerts">
                                            <i class="fas fa-bullhorn"></i>
                                        </button>
                                        ` : ''}
                                    </div>
                                </div>`;
                        }
                    } catch {}

                    
                    // Build EXPIRES section with SOURCE box to the right
                    let expiresHTML = '';
                    if (props.expires) {
                        const expDate = new Date(props.expires);
                        const now = new Date();
                        const remainMs = Math.max(0, expDate - now);
                        const remainMin = Math.round(remainMs / 60000);
                        const sourceFullText = String(getSourceText(props) || 'N/A').trim() || 'N/A';
                        const sourceText = truncateWithEllipsis(sourceFullText, 42);
                        const sourceEncoded = encodeURIComponent(sourceFullText);
                        
                        // Check for hail information
                        const upperEvent2 = (displayEvent || '').toUpperCase();
                        const isFloodFamily = upperEvent2 === 'FLASH FLOOD WARNING' || upperEvent2 === 'FLOOD WARNING' || upperEvent2 === 'FLOOD ADVISORY';
                        const isDust2 = upperEvent2 === 'DUST STORM WARNING';
                        const isSevereTStorm = upperEvent2 === 'SEVERE THUNDERSTORM WARNING';
                        const isTornadoFamily = (upperEvent2 === 'TORNADO WARNING' || upperEvent2 === 'PDS TORNADO WARNING' || upperEvent2 === 'TORNADO EMERGENCY');
                        
                        let hailVal = '';
                        let windVal = '';
                        let damageTag = '';
                        let tornadoTag = '';
                        
                        // Include hail for severe thunderstorm warnings and tornado warnings/emergencies
                        if ((!isFloodFamily && !isDust2) && props.parameters && props.parameters.maxHailSize) {
                            hailVal = Array.isArray(props.parameters.maxHailSize) ? props.parameters.maxHailSize[0] : props.parameters.maxHailSize;
                            hailVal = String(hailVal) + ' IN';
                        }
                        // Include wind for severe thunderstorm warnings only
                        if (isSevereTStorm && props.parameters && props.parameters.maxWindGust) {
                            windVal = Array.isArray(props.parameters.maxWindGust) ? props.parameters.maxWindGust[0] : props.parameters.maxWindGust;
                            windVal = String(windVal).replace(/\s*MPH\s*$/i, '') + ' MPH';
                        }
                        
                        // Check for damage tags (CONSIDERABLE/DESTRUCTIVE)
                        if (isDestructiveSevere(props)) {
                            damageTag = 'DESTRUCTIVE';
                        } else if (isConsiderableSevere(props)) {
                            damageTag = 'CONSIDERABLE';
                        } else {
                            // Add CONSIDERABLE tag for PDS tornado warnings
                            const displayEvent = getDisplayEventName(props.event, props);
                            if (displayEvent === 'PDS TORNADO WARNING') {
                                damageTag = 'CONSIDERABLE';
                            }
                        }
                        
                        // Check for tornado possible tag
                        if (isTornadoPossibleSevere(props)) {
                            tornadoTag = 'TORNADO';
                        }
                        
                        let hailBoxHTML = '';
                        if (hailVal) {
                            hailBoxHTML = `
                                <div class="hail-box-inline">
                                    <div class="metric-label">MAX HAIL</div>
                                    <div class="metric-value">${hailVal}</div>
                                </div>`;
                        }
                        
                        let windBoxHTML = '';
                        if (windVal) {
                            windBoxHTML = `
                                <div class="wind-box-inline">
                                    <div class="metric-label">MAX WIND</div>
                                    <div class="metric-value">${windVal}</div>
                                </div>`;
                        }
                        
                        let damageBoxHTML = '';
                        if (damageTag) {
                            damageBoxHTML = `
                                <div class="damage-box-inline damage-${damageTag.toLowerCase()}">
                                    <div class="metric-label">DAMAGE</div>
                                    <div class="metric-value">${damageTag}</div>
                                </div>`;
                        }
                        
                        let tornadoBoxHTML = '';
                        if (tornadoTag) {
                            tornadoBoxHTML = `
                                <div class="tornado-box-inline">
                                    <div class="metric-label">THREAT</div>
                                    <div class="metric-value">${tornadoTag}</div>
                                </div>`;
                        }
                        
                        expiresHTML = `
                            <div class="expires-impacts-row">
                                <div class="section">
                                    <div class="section-title">EXPIRES</div>
                                    <div class="section-text">${formatDurationCompact(remainMin)}</div>
                                </div>
                                <div class="metrics-row-inline">
                                    ${damageBoxHTML}
                                    ${tornadoBoxHTML}
                                    ${windBoxHTML}
                                    ${hailBoxHTML}
                                    <div class="source-box-inline">
                                        <div class="metric-label">SOURCE</div>
                                        <div class="metric-value source source-click" data-full-source="${sourceEncoded}" title="Click to view full source">${escapeHtml(sourceText)}</div>
                                    </div>
                                </div>
                            </div>`;
                    }

                    return [issuedHTML, expiresHTML].join('');
                })()}
            </div>
            ${sideHTML}
        `;

        // New Severe Warnings tab: add a small flashing 'unseen' corner button until clicked
        try {
            if (currentSortMode === 'severe') {
                const wid = String(alert.id || '');
                const openedAt = (typeof severeTabOpenedAt === 'number') ? severeTabOpenedAt : null;
                const issuedTs = props.sent || props.issued || props.effective || props.onset || null;
                const issuedMs = issuedTs ? new Date(issuedTs).getTime() : NaN;
                const isNewSinceOpen = openedAt != null && Number.isFinite(issuedMs) && issuedMs >= openedAt;
                if (wid && isNewSinceOpen && !severeSeenWarnings.has(wid)) {
                    const btn = document.createElement('button');
                    btn.type = 'button';
                    btn.className = 'severe-unseen-btn';
                    btn.title = 'Mark as seen';
                    btn.setAttribute('aria-label', 'Mark warning as seen');
                    btn.textContent = 'NEW';
                    btn.addEventListener('click', (e) => {
                        try { e.preventDefault(); } catch {}
                        try { e.stopPropagation(); } catch {}
                        try { if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation(); } catch {}
                        try { severeSeenWarnings.add(wid); } catch {}
                        try { btn.remove(); } catch {}
                    });
                    card.prepend(btn);
                }
            }
        } catch {}

        // Apply event-based color as the entire card background (replace previous orange look)
        if (eventColor) {
            try {
                const headerEl = card.querySelector('.card-header');
                const bodyEl = card.querySelector('.card-body');
                const sideEl = card.querySelector('.card-side');
                const actionsEl = card.querySelector('.card-actions');

                const cardBg = hexToRgba(eventColor, 0.18);
                card.style.background = cardBg;           // whole card background
                card.style.borderLeftColor = eventColor;  // strong accent at left
                card.style.border = `1px solid ${hexToRgba(eventColor, 0.35)}`; // override default orange edges

                // Ensure inner sections don't add extra tint
                if (headerEl) headerEl.style.background = 'transparent';
                if (bodyEl) bodyEl.style.background = 'transparent';
                if (sideEl) sideEl.style.background = 'transparent';
                if (actionsEl) actionsEl.style.background = 'transparent';
            } catch (e) {
                // fail silently if any element is missing
            }
        }
        
        // Add click handler for view more button
        const viewMoreBtn = card.querySelector('.view-more');
        if (viewMoreBtn) {
            viewMoreBtn.addEventListener('click', (e) => {
                e.preventDefault();
                showWarningModal(displayEvent, description, modalAccentColor, alert);
            });
        }
        
        // Add click handler for save button
        const saveBtn = card.querySelector('.save-btn');
        if (saveBtn) {
            saveBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                saveWarning(alert, saveBtn);
            });
        }

        // Add click handler for radar button (opens WeatherWise link)
        const radarBtn = card.querySelector('.radar-btn');
        if (radarBtn && weatherWiseTopLink) {
            radarBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const targetLink = generateWeatherWiseLink(alert) || weatherWiseTopLink || WEATHERWISE_POPOUT_URL;
                openWeatherWisePopout(targetLink);
            });
        }
        
        // Add click handler for map button (switch to embedded map and zoom to polygon)
        const mapBtn = card.querySelector('.map-btn');
        if (mapBtn) {
            mapBtn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
                focusWarningOnMap(alert.id);
            });
        }

        // Click only the SOURCE text to view the full source in a centered modal
        const sourceClick = card.querySelector('.source-click');
        if (sourceClick) {
            sourceClick.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                let fullSource = 'N/A';
                try {
                    const encoded = sourceClick.getAttribute('data-full-source') || '';
                    fullSource = encoded ? decodeURIComponent(encoded) : (sourceClick.textContent || 'N/A');
                } catch {
                    fullSource = sourceClick.textContent || 'N/A';
                }
                showSourceModal(fullSource);
            });
        }

        // Test warnings: push selected test card into Active Alerts tray and play warning sound
        const testActiveBtn = card.querySelector('.test-active-btn');
        if (testActiveBtn) {
            testActiveBtn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                try { showWarningNotification(alert); } catch {}
                try { playAlertSound(props.event, Object.assign({}, props)); } catch {}
                try {
                    testActiveBtn.classList.add('active');
                    setTimeout(() => testActiveBtn.classList.remove('active'), 700);
                } catch {}
            });
        }
        
        // Add click handler for picture button (open WeatherWise so user can screenshot there)
        const screenshotBtn = card.querySelector('.screenshot-btn');
        if (screenshotBtn) {
            screenshotBtn.addEventListener('click', async (e) => {
                e.preventDefault();
                e.stopPropagation();
                const hasWeatherWiseRadarButton = !!radarBtn;
                const targetLink = hasWeatherWiseRadarButton
                    ? (generateWeatherWiseLink(alert) || weatherWiseTopLink || WEATHERWISE_POPOUT_URL)
                    : '';
                if (screenshotBtn.disabled) return;
                const originalTitle = screenshotBtn.title;
                try {
                    screenshotBtn.disabled = true;
                    screenshotBtn.classList.add('is-busy');
                    screenshotBtn.title = 'Capturing WeatherWise screenshot...';
                    await createWeatherWiseScreenshot(alert, targetLink, {
                        navigateToTarget: hasWeatherWiseRadarButton
                    });
                } catch (err) {
                    console.error('weatherwise capture failed', err);
                    alert('Could not capture WeatherWise right now. WeatherWise still opened for manual screenshot.');
                    try {
                        if (hasWeatherWiseRadarButton) {
                            openWeatherWisePopout(targetLink || WEATHERWISE_POPOUT_URL);
                        } else if (!focusExistingWeatherWisePopout()) {
                            openWeatherWisePopout(WEATHERWISE_POPOUT_URL);
                        }
                    } catch {}
                } finally {
                    screenshotBtn.disabled = false;
                    screenshotBtn.classList.remove('is-busy');
                    screenshotBtn.title = originalTitle;
                }
            });
        }

        // Add click handler for the whole card
        card.style.cursor = 'pointer';
        card.addEventListener('click', () => {
            showWarningModal(displayEvent, description, modalAccentColor, alert);
        });
        
        // Add the card to the list
        list.appendChild(card);

        // Staggered intro animation only on first mount
        if (!hasWarningsIntroAnimated) {
            try {
                card.classList.add('intro-anim');
                const delay = Math.min(idx, 12) * 40; // simple stagger
                card.style.animationDelay = delay + 'ms';
            } catch {}
        }

        const locationChipsContainer = card.querySelector('.location-chips');
        if (locationChipsContainer) {
            setupCountyChipOverflow(locationChipsContainer);
        }
        
        // Remove animation class after animation completes for new warnings
        if (isNewWarning(alert.id) && hasBeenAnimated(alert.id)) {
            setTimeout(() => {
                card.classList.remove('new-warning');
            }, 400); // Remove after animation completes (0.4s)
        }
        
        // Remove tab animation class after animation completes
        if (!hasAnimatedTab) {
            setTimeout(() => {
                card.classList.remove('tab-animation');
            }, 600); // Remove after staggered animation completes (0.5s + 0.1s buffer)
        }
    });
    
    // Mark tab as animated after first render
    if (!hasAnimatedTab) {
        hasAnimatedTab = true;
    }
    if (!hasWarningsIntroAnimated) {
        // Mark list intro complete so subsequent renders don't re-animate
        hasWarningsIntroAnimated = true;
        try { setTimeout(() => { list && list.classList && list.classList.remove('list-intro'); }, 250); } catch {}
    }
    
    // Update new warnings counter
    // updateNewWarningsTab(); // This function is removed
    
    // Update fixed warning counter visibility
    updateFixedWarningCounter(warnings);

    // Refresh time labels immediately and ensure interval is running
    updateCardTimes();
    if (cardTimeInterval) clearInterval(cardTimeInterval);
    cardTimeInterval = setInterval(updateCardTimes, 1000 * 15); // update every 15s
}

function renderFooterStats(warnings) {
    warnings = filterActiveWarnings(warnings);
    // Count types
    let tornado = 0, severe = 0, flood = 0, hurricane = 0, tropical = 0, winter = 0, emergency = 0, states = new Set();
    warnings.forEach(a => {
        const displayEvent = getDisplayEventName(a.properties.event, a.properties);
        const isTornadoEmergency = displayEvent === 'TORNADO EMERGENCY';
        const isFlashFloodEmergency = displayEvent === 'FLASH FLOOD EMERGENCY';
        const isHurricaneEmergency = displayEvent === 'HURRICANE EMERGENCY';
        const isChildAbductionEmergency = displayEvent === 'CHILD ABDUCTION EMERGENCY';
        if (displayEvent === 'SEVERE THUNDERSTORM WARNING') severe++;
        // Only count flash flood warnings for flood, and only once
        if (displayEvent === 'FLASH FLOOD WARNING') flood++;
        // Count hurricane and tropical storm warnings from any basin (Atlantic or Pacific)
        if (displayEvent === 'HURRICANE WARNING') hurricane++;
        if (displayEvent === 'TROPICAL STORM WARNING') tropical++;
        // Count winter storm warnings
        if (displayEvent === 'WINTER STORM WARNING') winter++;
        if (isTornadoEmergency || isFlashFloodEmergency || isHurricaneEmergency || isChildAbductionEmergency) {
            emergency++;
        } else {
            // Only count as tornado if not an emergency
            if (displayEvent === 'TORNADO WARNING' || displayEvent === 'PDS TORNADO WARNING') tornado++;
        }
        if (a.properties.areaDesc) {
            a.properties.areaDesc.split(',').forEach(s => {
                const part = s.trim().split(' ');
                const last = part[part.length - 1];
                if (/^[A-Z]{2}$/.test(last)) states.add(last);
            });
        }
    });
    
    const statsHTML = `
        <div class="footer-stat"><span>${warnings.length}</span><span class="label">ACTIVE</span></div>
        <div class="footer-stat emergency"><span>${emergency}</span><span class="label">EMERGENCY</span></div>
        <div class="footer-stat tornado"><span>${tornado}</span><span class="label">TORNADO</span></div>
        <div class="footer-stat severe"><span>${severe}</span><span class="label">SEVERE</span></div>
        <div class="footer-stat flood"><span>${flood}</span><span class="label">FLOOD</span></div>
        <div class="footer-stat hurricane"><span>${hurricane}</span><span class="label">HURRICANE</span></div>
        <div class="footer-stat tropical-storm"><span>${tropical}</span><span class="label">TROP. STORM</span></div>
        <div class="footer-stat winter-storm"><span>${winter}</span><span class="label">WINTER STORM</span></div>
        <div class="footer-stat states"><span>${states.size}</span><span class="label">STATES</span></div>
    `;
    
    // Update left sidebar stats
    const leftStats = document.getElementById('left-stats');
    if (leftStats) {
        leftStats.innerHTML = statsHTML;
        leftStats.style.display = 'none';
    }

    const headerWarningStats = document.getElementById('header-warning-stats');
    if (headerWarningStats) {
        headerWarningStats.innerHTML = statsHTML;
    }
    
    // Backward compatibility: update old footer targets if present
    const footer = document.getElementById('dashboard-footer');
    if (footer) footer.innerHTML = statsHTML;
    const fixedCounter = document.getElementById('fixed-warning-counter');
    if (fixedCounter) fixedCounter.innerHTML = statsHTML;
}

function updateFixedWarningCounter(warnings = []) {
    // Disabled: do nothing to prevent the floating active warnings popup
    const fixedCounter = document.getElementById('fixed-warning-counter');
    if (fixedCounter) {
        fixedCounter.style.display = 'none';
        fixedCounter.classList.remove('show');
    }
    document.body.classList.remove('fixed-counter-active');
    return;
}

function computeWarningsDataSignature(features) {
    try {
        return (features || [])
            .map((w) => {
                const p = w?.properties || {};
                return [
                    String(w?.id || ''),
                    String(p.expires || ''),
                    String(p.sent || p.issued || p.effective || ''),
                    String(p.status || ''),
                    String(p.messageType || '')
                ].join('|');
            })
            .sort()
            .join('~');
    } catch {
        return '';
    }
}

let mapHudInterval = null;
let mapHudSelectedWarningId = null;
let mapHudSelectedWarning = null;
let mapHudCloseBound = false;

function setMapHudSelectedWarning(warningOrId) {
    try {
        if (warningOrId && typeof warningOrId === 'object') {
            const id = String(warningOrId.id || '').trim();
            mapHudSelectedWarning = warningOrId;
            mapHudSelectedWarningId = id || null;
        } else if (warningOrId != null) {
            mapHudSelectedWarningId = String(warningOrId).trim() || null;
            mapHudSelectedWarning = null;
        } else {
            mapHudSelectedWarningId = null;
            mapHudSelectedWarning = null;
        }
    } catch {
        mapHudSelectedWarningId = null;
        mapHudSelectedWarning = null;
    }
    try { updateMapBroadcastHud(); } catch {}
}
window.setMapHudSelectedWarning = setMapHudSelectedWarning;

function compactHudArea(areaDesc) {
    return formatAreas(areaDesc, {
        fallback: 'Multiple Counties',
        upperCase: false
    });
}

function getHudStateFromArea(areaDesc) {
    const text = String(areaDesc || '');
    const m = text.match(/\b([A-Z]{2})\b/);
    return m ? m[1] : 'US';
}

function getPrimaryHudArea(areaDesc) {
    return formatAreas(areaDesc, {
        fallback: 'Multiple Counties',
        upperCase: false
    });
}

function getHudClockText() {
    try {
        const now = new Date();
        const txt = new Intl.DateTimeFormat('en-US', {
            hour: '2-digit',
            minute: '2-digit',
            hour12: true,
            timeZoneName: 'short'
        }).format(now);
        return txt.toUpperCase().replace(/\s+/g, ' ');
    } catch {
        return '--:-- --';
    }
}

function summarizeHudThreatText(text, fallback = '') {
    const raw = String(text || '').replace(/\s+/g, ' ').trim();
    if (!raw) return String(fallback || '').toUpperCase();
    const cut = raw
        .replace(/^(HAZARD|WHAT|IMPACTS)\s*[:\-]\s*/i, '')
        .replace(/[.;].*$/, '')
        .trim();
    const words = cut.split(/\s+/).slice(0, 6).join(' ');
    return String(words || fallback || '').toUpperCase();
}

function getHudThreatBadges(props, eventName, hazardText = '', whatText = '') {
    const text = String(props?.description || '').toUpperCase();
    const eventUpper = String(eventName || '').toUpperCase();
    const out = [];
    if (/\bTORNADO\b[\s\S]{0,64}\bPOSSIBLE\b/.test(text) || text.includes('TORNADO POSSIBLE')) {
        out.push('TORNADO POSSIBLE');
    } else if (eventUpper.includes('TORNADO WARNING')) {
        out.push('TORNADO WARNING');
    }
    const damageLevel = (() => {
        const m = text.match(/\b(CONSIDERABLE|DESTRUCTIVE|CATASTROPHIC)\b[\s\S]{0,24}\bDAMAGE THREAT\b/);
        if (m && m[1]) return `${m[1]} DAMAGE THREAT`;
        if (text.includes('DAMAGE THREAT')) return 'DAMAGE THREAT';
        return '';
    })();
    if (damageLevel) out.push(damageLevel);
    if (!out.length) {
        const first = summarizeHudThreatText(whatText || hazardText, eventUpper);
        if (first) out.push(first);
    }
    if (out.length < 2) {
        const second = summarizeHudThreatText(hazardText, '');
        if (second && second !== out[0]) out.push(second);
    }
    return out.slice(0, 2);
}

function updateMapBroadcastHud() {
    const hud = document.getElementById('map-broadcast-hud');
    if (!hud) return;

    const clockEl = document.getElementById('map-hud-clock');
    if (clockEl) clockEl.textContent = getHudClockText();

    let active = [];
    try {
        active = filterActiveWarnings([...(allWarnings || [])]);
    } catch {
        active = [...(allWarnings || [])];
    }
    try {
        if (typeof sortWarningsByImportance === 'function') {
            active = sortWarningsByImportance(active);
        }
    } catch {}

    let lead = null;
    try {
        if (mapHudSelectedWarning && mapHudSelectedWarning.id) {
            const selectedId = String(mapHudSelectedWarning.id);
            lead = active.find(w => String(w?.id || '') === selectedId) || null;
            // Fallback: map source may use grouped IDs (e.g., id1|id2), keep selected feature data
            if (!lead && mapHudSelectedWarning?.properties) {
                lead = mapHudSelectedWarning;
            }
        }
        if (!lead && mapHudSelectedWarningId) {
            lead = active.find(w => String(w?.id || '') === String(mapHudSelectedWarningId)) || null;
            if (!lead && mapHudSelectedWarning?.properties) {
                lead = mapHudSelectedWarning;
            }
        }
        if (!lead && mapHudSelectedWarning?.properties) {
            lead = mapHudSelectedWarning;
        }
        if (lead && lead.id) {
            mapHudSelectedWarningId = String(lead.id);
            mapHudSelectedWarning = lead;
        } else {
            mapHudSelectedWarningId = null;
            mapHudSelectedWarning = null;
        }
    } catch {
        lead = null;
    }

    const total = active.length;
    const titleEl = document.getElementById('map-hud-card-title');
    const expireEl = document.getElementById('map-hud-card-expire');
    const progressRedEl = document.getElementById('map-hud-progress-red');
    const areaEl = document.getElementById('map-hud-areas');
    const sourceEl = document.getElementById('map-hud-source');
    const alert1RowEl = document.getElementById('map-hud-alert1-row');
    const alert1El = document.getElementById('map-hud-alert1');
    const alert2RowEl = document.getElementById('map-hud-alert2-row');
    const alert2El = document.getElementById('map-hud-alert2');
    const metricGridEl = document.getElementById('map-hud-metric-grid');
    const hailBoxEl = document.getElementById('map-hud-hail-box');
    const hailValueEl = document.getElementById('map-hud-hail-value');
    const windBoxEl = document.getElementById('map-hud-wind-box');
    const windValueEl = document.getElementById('map-hud-wind-value');
    const stateEl = document.getElementById('map-hud-chip-state');
    const rightStateEl = document.getElementById('map-hud-state-right');
    const cardEl = document.getElementById('map-hud-left-card');

    if (!lead || !lead.properties) {
        if (titleEl) titleEl.textContent = `ACTIVE WARNING (${total})`;
        if (expireEl) expireEl.textContent = 'EXPIRES IN -- MIN';
        if (progressRedEl) progressRedEl.style.removeProperty('width');
        if (areaEl) areaEl.textContent = 'MULTIPLE COUNTIES';
        if (sourceEl) sourceEl.textContent = 'NWS REPORT';
        if (alert1RowEl) alert1RowEl.style.display = 'none';
        if (alert1El) alert1El.textContent = '--';
        if (alert2RowEl) alert2RowEl.style.display = 'none';
        if (alert2El) alert2El.textContent = '--';
        if (metricGridEl) metricGridEl.style.display = '';
        if (hailBoxEl) hailBoxEl.style.display = '';
        if (hailValueEl) hailValueEl.textContent = '-- IN';
        if (windBoxEl) windBoxEl.style.display = 'none';
        if (windValueEl) windValueEl.textContent = '-- MPH';
        if (stateEl) stateEl.textContent = 'US';
        if (rightStateEl) rightStateEl.textContent = 'NATIONAL';
        if (cardEl) {
            cardEl.className = 'map-hud-left-card is-empty';
            cardEl.style.removeProperty('--hud-accent');
        }
        return;
    }

    const props = lead.properties || {};
    const eventName = String(getDisplayEventName(props.event, props) || props.event || 'Warning').toUpperCase();
    const areaPrimary = getPrimaryHudArea(props.areaDesc);
    const sourceText = String(getSourceText(props) || 'NWS REPORT').replace(/\s+/g, ' ').trim();
    const hazardText = String(getHazardText(props) || '').replace(/\s+/g, ' ').trim();
    const whatText = String(getWhatText(props) || '').replace(/\s+/g, ' ').trim();
    const threatBadges = getHudThreatBadges(props, eventName, hazardText, whatText);
    const stateCode = getHudStateFromArea(props.areaDesc);
    const expiresMin = props.expires ? Math.max(0, Math.round((new Date(props.expires).getTime() - Date.now()) / 60000)) : null;
    const accentColor = String(props._color || getEventColor(props.event) || '#ff3e2f');

    const maxHailRaw = props.parameters?.maxHailSize;
    const maxHailVal = Array.isArray(maxHailRaw) ? maxHailRaw[0] : maxHailRaw;
    const hailText = maxHailVal ? `${String(maxHailVal).replace(/\s*IN\s*$/i, '')} IN` : '';
    const maxWindRaw = props.parameters?.maxWindGust;
    const maxWindVal = Array.isArray(maxWindRaw) ? maxWindRaw[0] : maxWindRaw;
    const windText = maxWindVal ? `${String(maxWindVal).replace(/\s*MPH\s*$/i, '')} MPH` : '';

    if (titleEl) titleEl.textContent = eventName;
    if (expireEl) expireEl.textContent = `EXPIRES IN ${expiresMin == null ? '--' : expiresMin} MIN`;
    if (progressRedEl) progressRedEl.style.removeProperty('width');
    if (areaEl) areaEl.textContent = areaPrimary.toUpperCase();
    if (sourceEl) sourceEl.textContent = sourceText;
    if (alert1RowEl) alert1RowEl.style.display = '';
    if (alert1El) alert1El.textContent = threatBadges[0] || 'NWS WARNING IN EFFECT';
    if (alert2RowEl) alert2RowEl.style.display = threatBadges[1] ? '' : 'none';
    if (alert2El) alert2El.textContent = threatBadges[1] || '--';
    if (metricGridEl) metricGridEl.style.display = '';
    if (metricGridEl) metricGridEl.classList.toggle('two-metrics', true);
    if (hailBoxEl) hailBoxEl.style.display = '';
    if (hailValueEl) hailValueEl.textContent = hailText || '-- IN';
    if (windBoxEl) windBoxEl.style.display = '';
    if (windValueEl) windValueEl.textContent = windText || '-- MPH';
    if (stateEl) stateEl.textContent = stateCode;
    if (rightStateEl) rightStateEl.textContent = stateCode === 'US' ? 'NATIONAL' : stateCode;

    if (cardEl) {
        cardEl.className = 'map-hud-left-card';
        cardEl.style.setProperty('--hud-accent', accentColor);
    }
}

function startMapBroadcastHud() {
    if (!mapHudCloseBound) {
        const closeBtn = document.getElementById('map-hud-close-btn');
        if (closeBtn) {
            closeBtn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
                setMapHudSelectedWarning(null);
            });
            mapHudCloseBound = true;
        }
    }
    updateMapBroadcastHud();
    if (mapHudInterval) clearInterval(mapHudInterval);
    mapHudInterval = setInterval(updateMapBroadcastHud, 3000);
}

function stopMapBroadcastHud() {
    if (mapHudInterval) {
        clearInterval(mapHudInterval);
        mapHudInterval = null;
    }
}

function fetchAndRenderWarnings() {
    if (warningsFetchInFlight) return;
    warningsFetchInFlight = true;

    if (!navigator.onLine) {
        document.getElementById('warnings-list').innerHTML = '<div style="color:#ffb300;font-weight:bold;">You are offline. Reconnecting...</div>';
        warningsFetchInFlight = false;
        return;
    }
    fetch(API_URL, { headers: { 'Accept': 'application/geo+json' } })
        .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then(data => {
            if (!data.features) return;
            allWarnings = data.features;
            return Promise.all([
                Promise.resolve(allWarnings),
                fetchAlertsByEvent('Hurricane Warning'),
                fetchAlertsByEvent('Tropical Storm Warning'),
                fetchAlertsByEvent('Hurricane Force Wind Warning')
            ]);
        })
        .then(results => {
            if (!results) return;
            const [base, hurr, trop, hurrWind] = results;
            allWarnings = mergeById(base || [], [...(hurr || []), ...(trop || []), ...(hurrWind || [])]);
            allWarnings = (allWarnings || []).filter(w => {
                const e = (w?.properties?.event || '');
                return !/hydrologic\s+outlook/i.test(e);
            });
            window.allWarnings = allWarnings;

            const signature = computeWarningsDataSignature(allWarnings);
            const unchanged = signature && signature === lastWarningsDataSignature;
            if (unchanged) {
                updateMapBroadcastHud();
                return;
            }
            lastWarningsDataSignature = signature;

            try {
                const counts = {};
                const nhc = [];
                for (const f of allWarnings) {
                    const e = getDisplayEventName(f.properties?.event, f.properties);
                    counts[e] = (counts[e] || 0) + 1;
                    const sender = (f.properties?.senderName || '').toUpperCase();
                    if (sender.includes('HURRICANE CENTER')) nhc.push(e);
                }
                console.log('[WARNINGS] Event counts:', counts);
                console.log('[WARNINGS] NHC events:', nhc);
            } catch (e) {}

            checkForNewWarnings(allWarnings);

            if (currentView === 'warnings') {
                renderCurrentList();
            }
            updateMapBroadcastHud();
            renderRyanLiveTopWarnings();
            renderFooterStats(allWarnings);
            updateFixedWarningCounter();
        })
        .catch(err => {
            console.error('[WARNINGS] Fetch failed:', err);
            const msg = (err && err.message) ? err.message : 'Unknown error';
            document.getElementById('warnings-list').innerHTML = `<div style="color:#ff3c1a;font-weight:bold;">Failed to load warnings: ${msg}</div>`;
        })
        .finally(() => {
            warningsFetchInFlight = false;
        });
}

function fetchAndRenderWarningsInitial() {
    if (!navigator.onLine) {
        document.getElementById('warnings-list').innerHTML = '<div style="color:#ffb300;font-weight:bold;">You are offline. Waiting for connectionâ€¦</div>';
        return;
    }
    fetch(API_URL, { headers: { 'Accept': 'application/geo+json' } })
        .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then(data => {
            if (!data.features) return;
            allWarnings = data.features;
            return Promise.all([
                Promise.resolve(allWarnings),
                fetchAlertsByEvent('Hurricane Warning'),
                fetchAlertsByEvent('Tropical Storm Warning'),
                fetchAlertsByEvent('Hurricane Force Wind Warning')
            ]);
        })
        .then(results => {
            if (!results) return;
            const [base, hurr, trop, hurrWind] = results;
            allWarnings = mergeById(base || [], [...(hurr||[]), ...(trop||[]), ...(hurrWind||[])]);
            // Remove Hydrologic Outlooks from the warnings list on initial load
            allWarnings = (allWarnings || []).filter(w => {
                const e = (w?.properties?.event || '');
                return !/hydrologic\s+outlook/i.test(e);
            });
            window.allWarnings = allWarnings; // Make globally accessible
            lastWarningsDataSignature = computeWarningsDataSignature(allWarnings);

            // Debug: log event counts on initial load and show banner
            try {
                const counts = {};
                for (const f of allWarnings) {
                    const e = getDisplayEventName(f.properties?.event, f.properties);
                    counts[e] = (counts[e] || 0) + 1;
                }
                console.log('[INITIAL] Event counts:', counts);
                showEventDebugBanner(counts);
            } catch (e) {}
            
            // For initial load, just populate previousWarnings without triggering notifications
            allWarnings.forEach(warning => {
                previousWarnings.add(warning.id);
            });

            // Backfill the active-alert tray on startup regardless of popup preference.
            // Popup preference now only controls interruptive popup queue behavior.
            try { backfillActiveAlertsTray(allWarnings); } catch {}
            
            renderCurrentList();
            updateMapBroadcastHud();
            renderRyanLiveTopWarnings();
            renderFooterStats(allWarnings);
            updateFixedWarningCounter();
        })
        .catch(err => {
            document.getElementById('warnings-list').innerHTML = '<div style="color:#ff3c1a;font-weight:bold;">Failed to load warnings.</div>';
        });
}


// Live search
const searchInput = document.getElementById('warning-search');
if (searchInput) {
    searchInput.addEventListener('input', () => {
        if (currentView === 'warnings') {
            renderCurrentList();
        }
    });
}

// Initialize fixed warning counter and featured video on page load
document.addEventListener('DOMContentLoaded', () => {
    updateFixedWarningCounter();
    bindMainSettingsButton();
    // Remove any existing bottom debug banner
    const dbg = document.getElementById('event-debug-banner');
    if (dbg) dbg.remove();
});

// --- MapLibre GL JS Weather Map ---
let mapTimeInterval = null;
function updateMapTime() {
    const now = new Date();
    let hours = now.getHours();
    const minutes = pad(now.getMinutes());
    const seconds = pad(now.getSeconds());
    const ampm = hours >= 12 ? 'PM' : 'AM';
    hours = hours % 12;
    if (hours === 0) hours = 12;
    const timeStr = `${hours}:${minutes}:${seconds} ${ampm}`;
    const el = document.getElementById('map-current-time');
    if (el) el.textContent = timeStr;
}
function showWeatherMapScene() {
    // Hide dashboard
    const dash = document.getElementById('dashboard-root') || document.getElementById('dashboard-scene') || document.getElementById('dashboard');
    if (dash) dash.style.display = 'none';
    // Show map scene
    const mapScene = document.getElementById('map-scene');
    if (mapScene) mapScene.style.display = 'block';
    // Ensure map container has fixed size
    const mapDiv = document.getElementById('carto-map');
    if (mapDiv) {
        mapDiv.style.width = '100%';
        mapDiv.style.height = '600px';
        mapDiv.style.minHeight = '400px';
    }
    // Initialize MapLibre map if not already
    if (!window.weatherMap) {
        window.weatherMap = new maplibregl.Map({
            container: 'carto-map',
            style: 'https://api.maptiler.com/maps/darkmatter/style.json?key=GET_YOUR_OWN_KEY',
            center: [-88.5, 30.5],
            zoom: 6,
            attributionControl: true
        });
        window.weatherMap.on('style.load', function() {
            // State/county boundaries
            const boundaryLayers = ['admin', 'admin_sub', 'boundary', 'boundary_minor'];
            boundaryLayers.forEach(layerId => {
                if (window.weatherMap.getLayer(layerId)) {
                    window.weatherMap.setPaintProperty(layerId, 'line-color', '#e0e0e0');
                    window.weatherMap.setPaintProperty(layerId, 'line-width', 1.5);
                }
            });
            // City labels
            const cityLayers = ['place_label', 'settlement_major_label', 'settlement_minor_label'];
            cityLayers.forEach(layerId => {
                if (window.weatherMap.getLayer(layerId)) {
                    window.weatherMap.setPaintProperty(layerId, 'text-color', '#fff');
                    window.weatherMap.setPaintProperty(layerId, 'text-halo-color', '#222');
                    window.weatherMap.setPaintProperty(layerId, 'text-halo-width', 2);
                    window.weatherMap.setLayoutProperty(layerId, 'text-font', ['Open Sans Bold']);
                }
            });
            // Water color
            const waterLayers = ['water', 'waterway'];
            waterLayers.forEach(layerId => {
                if (window.weatherMap.getLayer(layerId)) {
                    window.weatherMap.setPaintProperty(layerId, 'fill-color', '#3a4a5a');
                    window.weatherMap.setPaintProperty(layerId, 'line-color', '#3a4a5a');
                }
            });
        });
    } else {
        window.weatherMap.resize();
    }
    // Start map time interval
    updateMapTime();
    if (mapTimeInterval) clearInterval(mapTimeInterval);
    mapTimeInterval = setInterval(updateMapTime, 1000);
}
// Hide map scene and stop map time interval
function hideWeatherMapScene() {
    const dash = document.getElementById('dashboard-root') || document.getElementById('dashboard-scene') || document.getElementById('dashboard');
    if (dash) dash.style.display = 'block';
    const mapScene = document.getElementById('map-scene');
    if (mapScene) mapScene.style.display = 'none';
    if (mapTimeInterval) {
        clearInterval(mapTimeInterval);
        mapTimeInterval = null;
    }
}
// Back to dashboard
const backBtn = document.getElementById('back-to-dashboard');
if (backBtn) {
    backBtn.onclick = function() {
        const dash = document.getElementById('dashboard-root') || document.getElementById('dashboard-scene') || document.getElementById('dashboard');
        if (dash) dash.style.display = 'block';
        const mapScene = document.getElementById('map-scene');
        if (mapScene) mapScene.style.display = 'none';
    };
}
// Map toggle button
const mapToggleBtn = document.getElementById('map-toggle-btn');
if (mapToggleBtn) {
    mapToggleBtn.onclick = showWeatherMapScene;
}

// --- Map Style Switcher ---
const MAP_STYLES = [
    {
        key: 'default',
        label: 'Default',
        style: 'https://demotiles.maplibre.org/style.json',
        thumb: 'https://api.maptiler.com/maps/streets/thumbnail.png',
    },
    {
        key: 'satellite',
        label: 'Satellite',
        style: 'https://api.maptiler.com/maps/hybrid/style.json?key=GET_YOUR_OWN_KEY',
        thumb: 'https://api.maptiler.com/maps/hybrid/thumbnail.png',
    },
    {
        key: 'dark',
        label: 'Dark',
        style: 'https://api.maptiler.com/maps/darkmatter/style.json?key=GET_YOUR_OWN_KEY',
        thumb: 'https://api.maptiler.com/maps/darkmatter/thumbnail.png',
    },
    {
        key: 'light',
        label: 'Light',
        style: 'https://api.maptiler.com/maps/positron/style.json?key=GET_YOUR_OWN_KEY',
        thumb: 'https://api.maptiler.com/maps/positron/thumbnail.png',
    },
    {
        key: 'day',
        label: 'Day',
        style: 'https://api.maptiler.com/maps/basic/style.json?key=GET_YOUR_OWN_KEY',
        thumb: 'https://api.maptiler.com/maps/basic/thumbnail.png',
    },
    {
        key: 'outdoors',
        label: 'Outdoors',
        style: 'https://api.maptiler.com/maps/outdoor/style.json?key=GET_YOUR_OWN_KEY',
        thumb: 'https://api.maptiler.com/maps/outdoor/thumbnail.png',
    },
];
let currentMapStyle = MAP_STYLES[0].style;
function addMapSettingsButton() {
    if (document.getElementById('map-settings-btn')) return;
    const btn = document.createElement('button');
    btn.id = 'map-settings-btn';
    btn.title = 'Map Settings';
    btn.innerHTML = '<span style="font-size:1.5em;">&#9881;</span>';
    btn.onclick = showMapSettingsModal;
    const mapScene = document.getElementById('map-scene');
    if (mapScene) mapScene.appendChild(btn);
}
function showMapSettingsModal() {
    if (document.getElementById('map-settings-modal')) return;
    const overlay = document.createElement('div');
    overlay.id = 'map-settings-modal';
    // Modal box
    const box = document.createElement('div');
    box.id = 'map-settings-box';
    // Close button
    const closeBtn = document.createElement('button');
    closeBtn.id = 'map-settings-close';
    closeBtn.innerHTML = '&times;';
    const close = () => {
        try { overlay.remove(); } catch {}
        syncBlockingOverlayScrollLock();
    };
    closeBtn.onclick = close;
    // Title
    const title = document.createElement('div');
    title.id = 'map-settings-title';
    title.textContent = 'Map Settings';
    // Style grid
    const styleLabel = document.createElement('div');
    styleLabel.style.fontWeight = 'bold';
    styleLabel.style.fontSize = '1.2em';
    styleLabel.style.margin = '24px 32px 0 32px';
    styleLabel.textContent = 'Style';
    const grid = document.createElement('div');
    grid.id = 'map-style-grid';
    MAP_STYLES.forEach((style, idx) => {
        const thumb = document.createElement('div');
        thumb.className = 'map-style-thumb' + (currentMapStyle === style.style ? ' selected' : '');
        thumb.onclick = () => {
            currentMapStyle = style.style;
            if (window.weatherMap) window.weatherMap.setStyle(style.style);
            Array.from(grid.children).forEach((c, i) => c.classList.toggle('selected', i === idx));
        };
        const img = document.createElement('img');
        img.src = style.thumb;
        img.alt = style.label;
        const label = document.createElement('span');
        label.textContent = style.label;
        thumb.appendChild(img);
        thumb.appendChild(label);
        grid.appendChild(thumb);
    });
    // Assemble
    box.appendChild(closeBtn);
    box.appendChild(title);
    box.appendChild(styleLabel);
    box.appendChild(grid);
    overlay.appendChild(box);
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) close();
    });
    document.body.appendChild(overlay);
    syncBlockingOverlayScrollLock();
}
// Add settings button when map scene is shown
const origShowWeatherMapScene = showWeatherMapScene;
showWeatherMapScene = function() {
    origShowWeatherMapScene();
    setTimeout(addMapSettingsButton, 200);
};

// --- Add advanced controls to map settings modal ---
function createBorderSettingsSection(layerId, label, border, labelSettings) {
    const section = document.createElement('div');
    const title = document.createElement('div');
    title.className = 'map-settings-section-title';
    title.textContent = label + ' Settings';
    section.appendChild(title);
    // Border thickness
    const borderRow = document.createElement('div');
    borderRow.className = 'map-settings-row';
    const borderLabel = document.createElement('div');
    borderLabel.className = 'map-settings-label';
    borderLabel.textContent = 'Borders';
    const borderSlider = document.createElement('input');
    borderSlider.type = 'range';
    borderSlider.min = '1';
    borderSlider.max = '8';
    borderSlider.step = '0.1';
    borderSlider.value = border.thickness;
    borderSlider.className = 'map-settings-slider';
    const borderValue = document.createElement('span');
    borderValue.className = 'map-settings-value';
    borderValue.textContent = border.thickness + 'px';
    borderSlider.oninput = () => {
        border.thickness = parseFloat(borderSlider.value);
        borderValue.textContent = borderSlider.value + 'px';
        if (window.weatherMap) window.weatherMap.setPaintProperty(layerId, 'line-width', border.thickness);
    };
    // Style dropdown
    const styleSelect = document.createElement('select');
    styleSelect.className = 'map-settings-select';
    ['Solid', 'Dashed', 'Dotted'].forEach(opt => {
        const o = document.createElement('option');
        o.value = opt.toLowerCase();
        o.textContent = opt;
        styleSelect.appendChild(o);
    });
    styleSelect.value = border.style;
    styleSelect.onchange = () => {
        border.style = styleSelect.value;
        if (window.weatherMap) {
            let dash = [];
            if (border.style === 'dashed') dash = [4, 4];
            if (border.style === 'dotted') dash = [1, 2];
            window.weatherMap.setPaintProperty(layerId, 'line-dasharray', dash);
        }
    };
    // Color picker
    const colorInput = document.createElement('input');
    colorInput.type = 'color';
    colorInput.value = border.color;
    colorInput.className = 'map-settings-color';
    colorInput.oninput = () => {
        border.color = colorInput.value;
        if (window.weatherMap) window.weatherMap.setPaintProperty(layerId, 'line-color', border.color);
    };
    borderRow.appendChild(borderLabel);
    borderRow.appendChild(borderSlider);
    borderRow.appendChild(borderValue);
    borderRow.appendChild(styleSelect);
    borderRow.appendChild(colorInput);
    section.appendChild(borderRow);
    // Labels
    const labelRow = document.createElement('div');
    labelRow.className = 'map-settings-row';
    const labelEnableLabel = document.createElement('div');
    labelEnableLabel.className = 'map-settings-label';
    labelEnableLabel.textContent = 'Labels';
    // Toggle
    const labelToggle = document.createElement('label');
    labelToggle.className = 'map-settings-toggle';
    const labelInput = document.createElement('input');
    labelInput.type = 'checkbox';
    labelInput.checked = labelSettings.enabled;
    labelInput.onchange = () => {
        labelSettings.enabled = labelInput.checked;
        if (window.weatherMap) window.weatherMap.setLayoutProperty(labelSettings.layerId, 'visibility', labelSettings.enabled ? 'visible' : 'none');
    };
    const slider = document.createElement('span');
    slider.className = 'map-settings-sliderbar';
    labelToggle.appendChild(labelInput);
    labelToggle.appendChild(slider);
    // Color
    const labelColor = document.createElement('input');
    labelColor.type = 'color';
    labelColor.value = labelSettings.color;
    labelColor.className = 'map-settings-color';
    labelColor.oninput = () => {
        labelSettings.color = labelColor.value;
        if (window.weatherMap) window.weatherMap.setPaintProperty(labelSettings.layerId, 'text-color', labelSettings.color);
    };
    // Font weight
    const fontWeightSelect = document.createElement('select');
    fontWeightSelect.className = 'map-settings-select';
    ['Medium', 'Bold'].forEach(opt => {
        const o = document.createElement('option');
        o.value = opt.toLowerCase();
        o.textContent = opt;
        fontWeightSelect.appendChild(o);
    });
    fontWeightSelect.value = labelSettings.fontWeight;
    fontWeightSelect.onchange = () => {
        labelSettings.fontWeight = fontWeightSelect.value;
        if (window.weatherMap) window.weatherMap.setLayoutProperty(labelSettings.layerId, 'text-font', [labelSettings.fontWeight === 'bold' ? 'Open Sans Bold' : 'Open Sans Regular']);
    };
    // Font size
    const fontSizeSlider = document.createElement('input');
    fontSizeSlider.type = 'range';
    fontSizeSlider.min = '10';
    fontSizeSlider.max = '50';
    fontSizeSlider.step = '1';
    fontSizeSlider.value = labelSettings.fontSize;
    fontSizeSlider.className = 'map-settings-slider';
    const fontSizeValue = document.createElement('span');
    fontSizeValue.className = 'map-settings-value';
    fontSizeValue.textContent = labelSettings.fontSize + 'px';
    fontSizeSlider.oninput = () => {
        labelSettings.fontSize = parseInt(fontSizeSlider.value);
        fontSizeValue.textContent = fontSizeSlider.value + 'px';
        if (window.weatherMap) window.weatherMap.setLayoutProperty(labelSettings.layerId, 'text-size', labelSettings.fontSize);
    };
    // Outline size
    const outlineSlider = document.createElement('input');
    outlineSlider.type = 'range';
    outlineSlider.min = '0';
    outlineSlider.max = '10';
    outlineSlider.step = '0.1';
    outlineSlider.value = labelSettings.outlineSize;
    outlineSlider.className = 'map-settings-slider';
    const outlineValue = document.createElement('span');
    outlineValue.className = 'map-settings-value';
    outlineValue.textContent = labelSettings.outlineSize + 'px';
    outlineSlider.oninput = () => {
        labelSettings.outlineSize = parseFloat(outlineSlider.value);
        outlineValue.textContent = outlineSlider.value + 'px';
        if (window.weatherMap) window.weatherMap.setPaintProperty(labelSettings.layerId, 'text-halo-width', labelSettings.outlineSize);
    };
    // Outline color
    const outlineColor = document.createElement('input');
    outlineColor.type = 'color';
    outlineColor.value = labelSettings.outlineColor;
    outlineColor.className = 'map-settings-color';
    outlineColor.oninput = () => {
        labelSettings.outlineColor = outlineColor.value;
        if (window.weatherMap) window.weatherMap.setPaintProperty(labelSettings.layerId, 'text-halo-color', labelSettings.outlineColor);
    };
    // Assemble label row
    labelRow.appendChild(labelEnableLabel);
    labelRow.appendChild(labelToggle);
    labelRow.appendChild(labelColor);
    labelRow.appendChild(fontWeightSelect);
    labelRow.appendChild(fontSizeSlider);
    labelRow.appendChild(fontSizeValue);
    labelRow.appendChild(outlineSlider);
    labelRow.appendChild(outlineValue);
    labelRow.appendChild(outlineColor);
    section.appendChild(labelRow);
    return section;
}
// Patch showMapSettingsModal to add country border/label controls
const origShowMapSettingsModal = showMapSettingsModal;
showMapSettingsModal = function() {
    origShowMapSettingsModal();
    const box = document.getElementById('map-settings-box');
    // Example: country border/label settings
    const countryBorder = { thickness: 4, style: 'solid', color: '#888' };
    const countryLabel = { enabled: true, color: '#fff', fontWeight: 'medium', fontSize: 24, outlineSize: 2, outlineColor: '#000', layerId: 'country_label' };
    const section = createBorderSettingsSection('country_border', 'Country', countryBorder, countryLabel);
    box.appendChild(section);
};

// YouTube embed loader
function getYouTubeEmbedUrl(link) {
    if (!link) return null;
    // Video link
    let match = link.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|v\/|shorts\/))([\w-]{11})/);
    if (match && match[1]) {
        return `https://www.youtube.com/embed/${match[1]}`;
    }
    // Playlist
    match = link.match(/[?&]list=([\w-]+)/);
    if (match && match[1]) {
        return `https://www.youtube.com/embed/videoseries?list=${match[1]}`;
    }
    // Live channel
    match = link.match(/youtube\.com\/(?:@|channel\/)([\w-]+)/);
    if (match && match[1]) {
        return `https://www.youtube.com/embed/live_stream?channel=${match[1]}`;
    }
    // Fallback: try to extract video ID from any 11-char string
    match = link.match(/([\w-]{11})/);
    if (match && match[1]) {
        return `https://www.youtube.com/embed/${match[1]}`;
    }
    return null;
}

window.addEventListener('DOMContentLoaded', function() {
    const input = document.getElementById('youtube-link-input');
    const btn = document.getElementById('youtube-load-btn');
    const iframe = document.getElementById('youtube-iframe');
    if (input && btn && iframe) {
        btn.onclick = function() {
            const url = input.value.trim();
            const embed = getYouTubeEmbedUrl(url);
            if (embed) {
                iframe.src = embed;
            } else {
                alert('Invalid YouTube link.');
            }
        };
        input.addEventListener('keydown', function(e) {
            if (e.key === 'Enter') btn.click();
        });
    }
});

function positionYouTubeBox() {
    const dashboard = document.querySelector('.dashboard-container');
    const ytBox = document.getElementById('youtube-stream-box');
    if (!dashboard || !ytBox) return;
    const dashRect = dashboard.getBoundingClientRect();
    const gap = 2;
    const left = 32; // desired left margin
    const rightEdge = dashRect.left - gap;
    const width = Math.max(320, rightEdge - left);
    ytBox.style.left = left + 'px';
    ytBox.style.width = width + 'px';
}
window.addEventListener('resize', positionYouTubeBox);
document.addEventListener('DOMContentLoaded', function() {
    positionYouTubeBox();
    const input = document.getElementById('youtube-link-input');
    const btn = document.getElementById('youtube-load-btn');
    const iframe = document.getElementById('youtube-iframe');
    if (input && btn && iframe) {
        btn.onclick = function() {
            const url = input.value.trim();
            const embed = getYouTubeEmbedUrl(url);
            if (embed) {
                iframe.src = embed;
            } else {
                alert('Invalid YouTube link.');
            }
        };
        input.addEventListener('keydown', function(e) {
            if (e.key === 'Enter') btn.click();
        });
    }
});


// Load settings from localStorage
window.alertSoundsEnabled = localStorage.getItem('alertSoundsEnabled') !== 'false';
window.notificationPopupsEnabled = localStorage.getItem('notificationPopupsEnabled') !== 'false';
window.desktopNotificationsEnabled = false;
try { localStorage.setItem('desktopNotificationsEnabled', 'false'); } catch {}
try {
    const storedVol = parseFloat(localStorage.getItem('alertVolume') || '0.7');
    window.alertVolume = Math.max(0, Math.min(1, isNaN(storedVol) ? 0.7 : storedVol));
} catch { window.alertVolume = 0.7; }
try {
    const storedPrefs = JSON.parse(localStorage.getItem('alertPreferences') || 'null');
    window.alertPreferences = storedPrefs && typeof storedPrefs === 'object' ? storedPrefs : {
        emergencies: true,
        tornadoWarning: true,
        severeThunderstormWarning: true,
        flashFloodWarning: true,
        hurricaneWarning: true,
        tropicalStormWarning: true,
    };
} catch { 
    window.alertPreferences = {
        emergencies: true,
        tornadoWarning: true,
        severeThunderstormWarning: true,
        flashFloodWarning: true,
        hurricaneWarning: true,
        tropicalStormWarning: true,
    };
}

// Utility Functions

function saveWarning(warning, button) {
    let savedWarnings = JSON.parse(localStorage.getItem('savedWarnings') || '{}');
    const isSaved = !!savedWarnings[warning.id];
    
    if (isSaved) {
        delete savedWarnings[warning.id];
        if (button) {
            button.innerHTML = '<i class="far fa-bookmark"></i>';
            button.title = 'Save';
        }
    } else {
        savedWarnings[warning.id] = {
            ...warning,
            savedAt: new Date().toISOString()
        };
        if (button) {
            button.innerHTML = '<i class="fas fa-bookmark"></i>';
            button.title = 'Unsave';
        }
    }
    
    localStorage.setItem('savedWarnings', JSON.stringify(savedWarnings));
    
    // Visual feedback
    if (button) {
        button.classList.add('pulse');
        setTimeout(() => button.classList.remove('pulse'), 500);
    }

    // If we're viewing the Saved tab, refresh the list to reflect changes
    if (currentSortMode === 'saved') {
        renderCurrentList();
    }
}

warningsPollTimer = setInterval(fetchAndRenderWarnings, WARNINGS_POLL_MS); // throttled polling for smoother UI
fetchAndRenderWarningsInitial(); // Initial load without notifications

// Setup sort menu
setupSortMenu();

// Setup view dropdown
setupViewDropdown();

// Setup dropdown menu functionality
function setupDropdownMenu() {
    console.log('Setting up dropdown menu...');
    
    const dropdownBtn = document.getElementById('nav-warnings-btn');
    const dropdownMenu = document.getElementById('warnings-dropdown');
    
    console.log('Dropdown button:', dropdownBtn);
    console.log('Dropdown menu:', dropdownMenu);
    
    if (!dropdownBtn || !dropdownMenu) {
        console.error('Dropdown elements not found!');
        return;
    }
    
    // Simple click handler
    dropdownBtn.onclick = function(e) {
        console.log('Dropdown button clicked!');
        e.preventDefault();
        e.stopPropagation();
        
        const isOpen = dropdownMenu.classList.contains('show');
        console.log('Current state:', isOpen);
        
        if (!isOpen) {
            dropdownMenu.classList.add('show');
            dropdownBtn.classList.add('active');
            console.log('Opening dropdown');
        } else {
            dropdownMenu.classList.remove('show');
            dropdownBtn.classList.remove('active');
            console.log('Closing dropdown');
        }
    };
    
    // Close dropdown when clicking outside
    document.addEventListener('click', function closeDropdown(e) {
        if (!dropdownBtn.contains(e.target) && !dropdownMenu.contains(e.target)) {
            dropdownMenu.classList.remove('show');
            dropdownBtn.classList.remove('active');
        }
    });
    
    console.log('Dropdown setup complete!');
    
    // Handle dropdown item clicks
    const dropdownItems = dropdownMenu.querySelectorAll('.dropdown-item');
    dropdownItems.forEach(item => {
        item.addEventListener('click', (e) => {
            e.preventDefault();
            
            const id = item.id;
            
            // Handle different dropdown actions
            if (id === 'dropdown-sort-important') {
                switchView('warnings');
                currentSortMode = 'important';
                updateSortButtons();
                renderCurrentList();
            } else if (id === 'dropdown-sort-recent') {
                switchView('warnings');
                currentSortMode = 'recent';
                updateSortButtons();
                renderCurrentList();
            } else if (id === 'dropdown-sort-severe') {
                switchView('warnings');
                currentSortMode = 'severe';
                updateSortButtons();
                renderCurrentList();
            } else if (id === 'dropdown-sort-saved') {
                switchView('warnings');
                currentSortMode = 'saved';
                updateSortButtons();
                renderCurrentList();
            } else if (id === 'dropdown-map-btn') {
                switchView('map');
            } else if (id === 'dropdown-settings-btn') {
                showForecastSettings();
            }
            
            // Close dropdown after selection
            dropdownMenu.classList.remove('show');
            dropdownBtn.classList.remove('active');
        });
    });

    setDropdownViewActive(currentView || 'warnings');
}

function updateSortButtons() {
    const sortImportant = document.getElementById('sort-important') || document.getElementById('dropdown-sort-important');
    const sortRecent = document.getElementById('sort-recent') || document.getElementById('dropdown-sort-recent');
    const sortSevere = document.getElementById('sort-severe') || document.getElementById('dropdown-sort-severe');
    const sortSaved = document.getElementById('sort-saved') || document.getElementById('dropdown-sort-saved');
    
    // Remove active class from all sort buttons
    [sortImportant, sortRecent, sortSevere, sortSaved].forEach(btn => {
        if (btn) btn.classList.remove('active');
    });
    
    // Add active class to current sort mode
    if (currentSortMode === 'important' && sortImportant) {
        sortImportant.classList.add('active');
    } else if (currentSortMode === 'recent' && sortRecent) {
        sortRecent.classList.add('active');
    } else if (currentSortMode === 'severe' && sortSevere) {
        sortSevere.classList.add('active');
    } else if (currentSortMode === 'saved' && sortSaved) {
        sortSaved.classList.add('active');
    }
}


// Setup main settings button (robust binding)
function bindMainSettingsButton() {
    const btn = document.getElementById('main-settings-btn');
    if (btn && !btn.__settingsBound) {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            showForecastSettings();
        });
        btn.__settingsBound = true;
    }
}
bindMainSettingsButton();

function bindHeaderWeatherWiseButton() {
    const btn = document.getElementById('header-weatherwise-btn');
    if (btn && !btn.__weatherwiseBound) {
        btn.type = 'button';
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            openWeatherWisePopout();
        });
        btn.onclick = (e) => {
            e.preventDefault();
            openWeatherWisePopout();
        };
        btn.__weatherwiseBound = true;
    }
}
bindHeaderWeatherWiseButton();

function getStormReportsDashboardRanges() {
    return [
        { key: 'today', label: 'Today' },
        { key: '72', label: '72h', hours: 72 },
        { key: '48', label: '48h', hours: 48 },
        { key: '24', label: '24h', hours: 24 },
        { key: '12', label: '12h', hours: 12 },
        { key: '6', label: '6h', hours: 6 },
        { key: '4', label: '4h', hours: 4 },
        { key: '2', label: '2h', hours: 2 }
    ];
}

stormReportsDashboardState = (typeof globalThis !== 'undefined' && globalThis.stormReportsDashboardState)
    ? globalThis.stormReportsDashboardState
    : stormReportsDashboardState;
if (!stormReportsDashboardState || typeof stormReportsDashboardState !== 'object') {
    stormReportsDashboardState = {};
}
if (!Array.isArray(stormReportsDashboardState.reports)) stormReportsDashboardState.reports = [];
if (typeof stormReportsDashboardState.range !== 'string' || !stormReportsDashboardState.range) stormReportsDashboardState.range = 'today';
if (typeof stormReportsDashboardState.loading !== 'boolean') stormReportsDashboardState.loading = false;
if (!('lastUpdatedAt' in stormReportsDashboardState)) stormReportsDashboardState.lastUpdatedAt = null;
if (typeof stormReportsDashboardState.statusNote !== 'string') stormReportsDashboardState.statusNote = '';
if (typeof stormReportsDashboardState.errorMessage !== 'string') stormReportsDashboardState.errorMessage = '';
if (typeof stormReportsDashboardState.typeFilter !== 'string' || !stormReportsDashboardState.typeFilter) stormReportsDashboardState.typeFilter = 'all';
if (!Number.isFinite(stormReportsDashboardState.requestId)) stormReportsDashboardState.requestId = 0;
if (!Array.isArray(stormReportsDashboardState.visibleReports)) stormReportsDashboardState.visibleReports = [];
if (typeof stormReportsDashboardState.selectedReportId !== 'string') stormReportsDashboardState.selectedReportId = '';
if (typeof globalThis !== 'undefined') {
    globalThis.stormReportsDashboardState = stormReportsDashboardState;
}

function formatLsrUtcMinuteStamp(dateObj) {
    const d = dateObj instanceof Date ? dateObj : new Date(dateObj);
    if (Number.isNaN(d.getTime())) return '';
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}Z`;
}

function getStormReportsDashboardWindow(rangeKey) {
    const now = new Date();
    if (rangeKey === 'today') {
        const startLocal = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
        return { start: startLocal, end: now };
    }
    const def = getStormReportsDashboardRanges().find((item) => item.key === rangeKey);
    const hours = Number(def?.hours || 24);
    return { start: new Date(now.getTime() - (hours * 60 * 60 * 1000)), end: now };
}

function getStormDeskRangeHours(rangeKey) {
    const def = getStormReportsDashboardRanges().find((item) => item.key === rangeKey);
    return Math.max(1, Number(def?.hours || 24));
}

function getStormDeskValidMs(report) {
    const value = Number(report?.validMs);
    if (Number.isFinite(value)) return value;
    const parsed = Date.parse(String(report?.validIso || ''));
    return Number.isFinite(parsed) ? parsed : NaN;
}

function filterStormDeskReportsByWindow(reports, startMs, endMs) {
    return (Array.isArray(reports) ? reports : []).filter((report) => {
        const t = getStormDeskValidMs(report);
        if (!Number.isFinite(t)) return false;
        return t >= startMs && t <= endMs;
    });
}

function formatStormDeskDateText(value) {
    const d = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(d.getTime())) return '--';
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

async function fetchStormDeskReportsFromUrl(url) {
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) throw new Error(`storm reports fetch failed (${response.status})`);
    const data = await response.json();
    return (Array.isArray(data?.features) ? data.features : [])
        .map((feature) => normalizeStormDeskFeature(feature))
        .filter(Boolean);
}

async function fetchStormDeskReportsByHours(hours) {
    const safeHours = Math.max(1, Number(hours || 24));
    const url = `https://mesonet.agron.iastate.edu/geojson/lsr.php?hours=${safeHours}`;
    return fetchStormDeskReportsFromUrl(url);
}

async function fetchStormDeskReportsByWindow(startDate, endDate) {
    const sts = formatLsrUtcMinuteStamp(startDate);
    const ets = formatLsrUtcMinuteStamp(endDate);
    const url = `https://mesonet.agron.iastate.edu/geojson/lsr.php?sts=${encodeURIComponent(sts)}&ets=${encodeURIComponent(ets)}`;
    return fetchStormDeskReportsFromUrl(url);
}

async function getStormReportsForDashboardRange(rangeKey) {
    const key = String(rangeKey || 'today');
    const windowRange = getStormReportsDashboardWindow(key);
    const startMs = windowRange.start.getTime();
    const endMs = windowRange.end.getTime();

    if (key !== 'today') {
        const hourReports = await fetchStormDeskReportsByHours(getStormDeskRangeHours(key));
        if (hourReports.length) return { reports: hourReports, note: '' };

        const windowReports = await fetchStormDeskReportsByWindow(windowRange.start, windowRange.end);
        const filtered = filterStormDeskReportsByWindow(windowReports, startMs, endMs);
        return { reports: filtered.length ? filtered : windowReports, note: '' };
    }

    const todayReportsRaw = await fetchStormDeskReportsByWindow(windowRange.start, windowRange.end);
    const todayReports = filterStormDeskReportsByWindow(todayReportsRaw, startMs, endMs);
    if (todayReports.length) return { reports: todayReports, note: '' };

    const fallbackReports = await fetchStormDeskReportsByHours(168);
    if (!fallbackReports.length) return { reports: [], note: 'No reports available from the feed right now.' };

    let latestMs = NaN;
    fallbackReports.forEach((report) => {
        const t = getStormDeskValidMs(report);
        if (Number.isFinite(t) && (!Number.isFinite(latestMs) || t > latestMs)) latestMs = t;
    });
    if (!Number.isFinite(latestMs)) {
        return { reports: fallbackReports, note: 'Showing most recent feed records.' };
    }

    const latestDate = new Date(latestMs);
    const dayStart = new Date(latestDate.getFullYear(), latestDate.getMonth(), latestDate.getDate(), 0, 0, 0, 0).getTime();
    const dayEnd = dayStart + (24 * 60 * 60 * 1000) - 1;
    const latestDayReports = filterStormDeskReportsByWindow(fallbackReports, dayStart, dayEnd);
    if (latestDayReports.length) {
        return {
            reports: latestDayReports,
            note: `No reports for today. Showing ${formatStormDeskDateText(latestDate)}.`
        };
    }
    return { reports: fallbackReports, note: 'Showing most recent feed records.' };
}

function inferStormDeskType(typeText, fallbackType = '') {
    const text = String(typeText || '').toLowerCase();
    if (text.includes('freezing rain') || text.includes('freezing drizzle') || text.includes('ice accretion') || text.includes('glaze')) return 'Z';

    const code = String(fallbackType || '').toUpperCase().trim();
    if (['T', 'H', 'W', 'S', 'G', 'D', 'F', 'R', 'Z'].includes(code)) return code;
    if (!text) return 'R';
    if (text.includes('tornado') || text.includes('funnel')) return 'T';
    if (text.includes('hail')) return 'H';
    if (text.includes('wind') || text.includes('gust') || text.includes('tstm') || text.includes('wnd')) return 'W';
    if (text.includes('snow') || text.includes('winter') || text.includes('blizzard') || text.includes('sleet')) return 'S';
    if (text.includes('flood') || text.includes('high water')) return 'F';
    if (text.includes('damage') || text.includes('dmg')) return 'D';
    if (text.includes('rain') || text.includes('ice') || text.includes('freez') || text.includes('drizzle')) return 'R';
    return 'R';
}

function parseStormDeskMagnitude(featureProps = {}) {
    const candidates = [
        featureProps.magnitude,
        featureProps.mag,
        featureProps.size,
        featureProps.speed,
        featureProps.value
    ];
    for (const candidate of candidates) {
        const numeric = Number.parseFloat(String(candidate ?? '').replace(/[^\d.+-]/g, ''));
        if (Number.isFinite(numeric)) return numeric;
    }
    return null;
}

function stormDeskTypeLabel(typeCode) {
    const map = {
        T: 'Tornado',
        H: 'Hail',
        W: 'Wind',
        S: 'Snow',
        F: 'Flood',
        Z: 'Freezing Rain',
        D: 'Damage',
        R: 'Rain'
    };
    return map[String(typeCode || '').toUpperCase()] || 'Report';
}

function stormDeskTypeUnit(typeCode) {
    const map = {
        H: 'in',
        S: 'in',
        Z: 'in',
        R: 'in',
        W: 'mph',
        F: 'ft'
    };
    return map[String(typeCode || '').toUpperCase()] || '';
}

function normalizeStormDeskFeature(feature) {
    try {
        if (!feature || !feature.geometry || feature.geometry.type !== 'Point') return null;
        const coords = Array.isArray(feature.geometry.coordinates) ? feature.geometry.coordinates : [];
        const lon = Number(coords[0]);
        const lat = Number(coords[1]);
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
        const p = feature.properties || {};
        const typeText = String(p.typetext || p.typeText || p.event || p.description || p.category || '').trim();
        const typeCode = inferStormDeskType(typeText, p.type);
        const magnitude = parseStormDeskMagnitude(p);
        const validRaw = p.valid
            || p.time
            || p.obtime
            || p.timestamp
            || p.datetime
            || p.utcvalid
            || p.utc_valid
            || p.observed
            || p.updated
            || p.VALID
            || p.TIME
            || '';
        let validDate = new Date(validRaw);
        if (Number.isNaN(validDate.getTime())) {
            const epoch = Number(validRaw);
            if (Number.isFinite(epoch)) {
                validDate = new Date(epoch > 1e12 ? epoch : (epoch * 1000));
            }
        }
        const validMs = Number.isNaN(validDate.getTime()) ? NaN : validDate.getTime();
        const validIso = Number.isFinite(validMs) ? new Date(validMs).toISOString() : '';
        return {
            id: String(feature.id || `${typeCode}-${validIso}-${lon.toFixed(3)}-${lat.toFixed(3)}`),
            lon,
            lat,
            typeCode,
            typeLabel: stormDeskTypeLabel(typeCode),
            typeText: typeText || stormDeskTypeLabel(typeCode),
            magnitude,
            unit: stormDeskTypeUnit(typeCode),
            city: String(p.city || p.location || p.name || '').trim(),
            state: String(p.state || p.st || '').trim(),
            county: String(p.county || '').trim(),
            remarks: String(p.remark || p.remarks || p.description || '').trim(),
            source: String(p.source || 'NWS LSR').trim(),
            validIso,
            validMs
        };
    } catch {
        return null;
    }
}

function formatStormDeskAgo(isoText) {
    const d = new Date(isoText);
    if (Number.isNaN(d.getTime())) return '--';
    const minutes = Math.max(0, Math.floor((Date.now() - d.getTime()) / 60000));
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
}

function formatStormDeskTimestamp(isoText) {
    const d = new Date(isoText);
    if (Number.isNaN(d.getTime())) return '--';
    return d.toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true
    });
}

function formatStormDeskMagnitude(value, unit = '') {
    if (!Number.isFinite(value)) return '--';
    const text = Number.isInteger(value) ? String(value) : value.toFixed(1);
    return unit ? `${text} ${unit}` : text;
}

function getStormDeskLocation(report) {
    const parts = [report.city, report.state].filter(Boolean);
    if (parts.length) return parts.join(', ');
    if (report.county) return report.county;
    return 'Unknown Location';
}

function formatStormDeskCoordinate(value, isLat) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return '--';
    const abs = Math.abs(numeric).toFixed(3);
    const hemi = isLat ? (numeric >= 0 ? 'N' : 'S') : (numeric >= 0 ? 'E' : 'W');
    return `${abs}${hemi}`;
}

function closeStormDeskReportDetail() {
    const overlay = document.getElementById('storm-desk-report-detail-overlay');
    if (!overlay) return;
    overlay.hidden = true;
    overlay.classList.remove('is-open');
    const body = document.getElementById('storm-desk-report-detail-body');
    if (body) body.innerHTML = '';
    stormReportsDashboardState.selectedReportId = '';
}

function openStormDeskReportDetail(report) {
    if (!report) return;
    const overlay = document.getElementById('storm-desk-report-detail-overlay');
    const body = document.getElementById('storm-desk-report-detail-body');
    if (!overlay || !body) return;

    const titleEl = document.getElementById('storm-desk-report-detail-title');
    if (titleEl) {
        titleEl.textContent = `${report.typeLabel || 'Report'} Details`;
    }

    const locationText = getStormDeskLocation(report);
    const reportTypeText = String(report.typeText || report.typeLabel || 'Report').trim();
    const remarksRaw = String(report.remarks || report.typeText || 'No remarks provided.').trim();
    const remarksHtml = escapeHtml(remarksRaw).replace(/\r?\n/g, '<br>');
    const validIso = String(report.validIso || '').trim();
    const coordsText = `${formatStormDeskCoordinate(report.lat, true)}, ${formatStormDeskCoordinate(report.lon, false)}`;

    const metaRows = [
        { label: 'Type', value: reportTypeText || '--' },
        { label: 'Magnitude', value: formatStormDeskMagnitude(report.magnitude, report.unit) },
        { label: 'Location', value: locationText || '--' },
        { label: 'County', value: String(report.county || '--') },
        { label: 'Time', value: validIso ? formatStormDeskTimestamp(validIso) : '--' },
        { label: 'Age', value: validIso ? formatStormDeskAgo(validIso) : '--' },
        { label: 'Source', value: String(report.source || 'NWS LSR') },
        { label: 'Coordinates', value: coordsText }
    ];

    body.innerHTML = `
        <div class="storm-desk-detail-topline">${escapeHtml(reportTypeText || 'Report')}</div>
        <div class="storm-desk-detail-grid">
            ${metaRows.map((row) => `
                <div class="storm-desk-detail-cell">
                    <div class="storm-desk-detail-label">${escapeHtml(row.label)}</div>
                    <div class="storm-desk-detail-value">${escapeHtml(String(row.value || '--'))}</div>
                </div>
            `).join('')}
        </div>
        <div class="storm-desk-detail-remarks-wrap">
            <div class="storm-desk-detail-label">Remarks</div>
            <div class="storm-desk-detail-remarks">${remarksHtml}</div>
        </div>
    `;

    stormReportsDashboardState.selectedReportId = String(report.id || '');
    overlay.hidden = false;
    overlay.classList.add('is-open');
}

function openStormDeskReportDetailByIndex(index) {
    const idx = Number.parseInt(String(index), 10);
    if (!Number.isInteger(idx) || idx < 0) return;
    const visibleReports = Array.isArray(stormReportsDashboardState.visibleReports)
        ? stormReportsDashboardState.visibleReports
        : [];
    const report = visibleReports[idx];
    if (!report) return;
    openStormDeskReportDetail(report);
}

function buildStormReportsDashboardSummary(reports) {
    const states = new Set();
    const stateCounts = new Map();
    const byType = new Map();
    let peakReport = null;
    let latestReport = null;

    reports.forEach((report) => {
        const state = String(report.state || '').trim().toUpperCase();
        if (state) {
            states.add(state);
            stateCounts.set(state, (stateCounts.get(state) || 0) + 1);
        }

        const bucketKey = String(report.typeCode || 'R').toUpperCase();
        if (!byType.has(bucketKey)) {
            byType.set(bucketKey, {
                typeCode: bucketKey,
                label: stormDeskTypeLabel(bucketKey),
                count: 0,
                maxMagnitude: null,
                unit: stormDeskTypeUnit(bucketKey)
            });
        }
        const bucket = byType.get(bucketKey);
        bucket.count += 1;
        if (Number.isFinite(report.magnitude) && (bucket.maxMagnitude == null || report.magnitude > bucket.maxMagnitude)) {
            bucket.maxMagnitude = report.magnitude;
        }

        if (Number.isFinite(report.magnitude) && (!peakReport || report.magnitude > peakReport.magnitude)) {
            peakReport = report;
        }

        const reportTime = getStormDeskValidMs(report);
        const latestTime = latestReport ? getStormDeskValidMs(latestReport) : NaN;
        if (Number.isFinite(reportTime) && (!Number.isFinite(latestTime) || reportTime > latestTime)) {
            latestReport = report;
        }
    });

    const topStates = Array.from(stateCounts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10);

    const typeOrder = ['S', 'H', 'W', 'T', 'F', 'Z', 'R', 'D'];
    const topMagnitudes = typeOrder
        .map((key) => byType.get(key))
        .filter(Boolean)
        .concat(Array.from(byType.values()).filter((item) => !typeOrder.includes(item.typeCode)));

    return {
        reportCount: reports.length,
        stateCount: states.size,
        peakReport,
        latestReport,
        topStates,
        topMagnitudes
    };
}

function ensureStormReportsDashboardModal() {
    let overlay = document.getElementById('storm-reports-dashboard-overlay');
    if (overlay) return overlay;

    overlay = document.createElement('div');
    overlay.id = 'storm-reports-dashboard-overlay';
    overlay.className = 'storm-desk-overlay';
    overlay.innerHTML = `
        <div class="storm-desk-shell storm-desk-shell-enter" role="dialog" aria-modal="true" aria-label="Storm Reports">
            <button type="button" class="storm-desk-close" id="storm-desk-close" aria-label="Close Storm Reports">&times;</button>
            <div class="storm-desk-top storm-desk-item-anim" style="--storm-desk-delay: 20ms;">
                <div class="storm-desk-title-wrap storm-desk-item-anim" style="--storm-desk-delay: 40ms;">
                    <div class="storm-desk-kicker">Live Local Storm Report Desk</div>
                    <h2 class="storm-desk-title">Storm Reports Scoreboard</h2>
                    <p class="storm-desk-subtitle">Top local storm reports for the selected window.</p>
                </div>
                <div class="storm-desk-meta storm-desk-item-anim" style="--storm-desk-delay: 65ms;">
                    <span class="storm-desk-feed-dot"></span>
                    <span class="storm-desk-feed-label">LSR Feed Connected</span>
                    <span class="storm-desk-updated" id="storm-desk-updated">Updated --</span>
                </div>
            </div>
            <div class="storm-desk-range-row storm-desk-item-anim" style="--storm-desk-delay: 90ms;" id="storm-desk-range-row">
                ${getStormReportsDashboardRanges().map((item, idx) => `<button type="button" class="storm-desk-range-btn storm-desk-item-anim" style="--storm-desk-delay:${100 + (idx * 20)}ms;" data-range="${item.key}">${escapeHtml(item.label)}</button>`).join('')}
            </div>
            <div class="storm-desk-layout storm-desk-item-anim" style="--storm-desk-delay: 120ms;">
                <aside class="storm-desk-left">
                    <div class="storm-desk-stat-card storm-desk-item-anim" style="--storm-desk-delay: 140ms;">
                        <div class="storm-desk-stat-label">Reports</div>
                        <div class="storm-desk-stat-value" id="storm-desk-reports-count">--</div>
                    </div>
                    <div class="storm-desk-stat-card storm-desk-item-anim" style="--storm-desk-delay: 170ms;">
                        <div class="storm-desk-stat-label">States Impacted</div>
                        <div class="storm-desk-stat-value" id="storm-desk-states-count">--</div>
                    </div>
                    <div class="storm-desk-stat-card storm-desk-item-anim" style="--storm-desk-delay: 200ms;">
                        <div class="storm-desk-stat-label">Peak Magnitude</div>
                        <div class="storm-desk-stat-value" id="storm-desk-peak-value">--</div>
                        <div class="storm-desk-stat-sub" id="storm-desk-peak-meta">No data</div>
                    </div>
                    <div class="storm-desk-stat-card storm-desk-item-anim" style="--storm-desk-delay: 230ms;">
                        <div class="storm-desk-stat-label">Latest Report</div>
                        <div class="storm-desk-stat-sub" id="storm-desk-latest-meta">No data</div>
                    </div>
                    <div class="storm-desk-states-card storm-desk-item-anim" style="--storm-desk-delay: 260ms;">
                        <div class="storm-desk-panel-title">Top States</div>
                        <div class="storm-desk-states-list" id="storm-desk-states-list"></div>
                    </div>
                </aside>
                <section class="storm-desk-main">
                    <div class="storm-desk-panel storm-desk-item-anim" style="--storm-desk-delay: 180ms;">
                        <div class="storm-desk-panel-head">
                            <div class="storm-desk-panel-title">Top Magnitudes</div>
                            <div class="storm-desk-panel-count" id="storm-desk-topmag-count">-- reports</div>
                        </div>
                        <div class="storm-desk-mag-grid" id="storm-desk-mag-grid"></div>
                    </div>
                    <div class="storm-desk-panel storm-desk-reports-panel storm-desk-item-anim" style="--storm-desk-delay: 220ms;">
                        <div class="storm-desk-panel-head">
                            <div class="storm-desk-panel-title">All Reports</div>
                            <div class="storm-desk-panel-count" id="storm-desk-list-count">-- reports</div>
                        </div>
                        <div class="storm-desk-list" id="storm-desk-list"></div>
                    </div>
                </section>
            </div>
            <div class="storm-desk-report-detail-overlay" id="storm-desk-report-detail-overlay" hidden>
                <div class="storm-desk-report-detail" role="dialog" aria-modal="true" aria-label="Storm Report Details">
                    <div class="storm-desk-report-detail-head">
                        <div class="storm-desk-report-detail-title" id="storm-desk-report-detail-title">Report Details</div>
                        <button type="button" class="storm-desk-report-detail-close" id="storm-desk-report-detail-close" aria-label="Close Report Details">&times;</button>
                    </div>
                    <div class="storm-desk-report-detail-body" id="storm-desk-report-detail-body"></div>
                </div>
            </div>
        </div>
    `;

    const isStormDeskCloseHit = (event) => {
        const closeEl = overlay.querySelector('#storm-desk-close');
        if (!closeEl) return false;
        const rect = closeEl.getBoundingClientRect();
        const x = Number(event?.clientX);
        const y = Number(event?.clientY);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
        return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
    };

    // Capture phase + hit-test keeps the close box reliable even if animated siblings overlap it.
    overlay.addEventListener('pointerdown', (e) => {
        if (!isStormDeskCloseHit(e)) return;
        e.preventDefault();
        e.stopPropagation();
        closeStormReportsDashboard();
    }, true);

    overlay.addEventListener('click', (e) => {
        if (isStormDeskCloseHit(e)) {
            e.preventDefault();
            e.stopPropagation();
            closeStormReportsDashboard();
            return;
        }
        if (e.target === overlay) closeStormReportsDashboard();
    });
    document.body.appendChild(overlay);
    syncBlockingOverlayScrollLock();

    const closeBtn = document.getElementById('storm-desk-close');
    if (closeBtn) {
        closeBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            closeStormReportsDashboard();
        });
    }

    const rangeRow = document.getElementById('storm-desk-range-row');
    if (rangeRow) {
        rangeRow.addEventListener('click', (e) => {
            const target = e.target.closest('button[data-range]');
            if (!target) return;
            const key = String(target.getAttribute('data-range') || 'today');
            loadStormReportsDashboardData(key);
        });
    }
    const topMagGrid = document.getElementById('storm-desk-mag-grid');
    if (topMagGrid) {
        topMagGrid.addEventListener('click', (e) => {
            const chip = e.target.closest('.storm-desk-mag-chip[data-type-code]');
            if (!chip) return;
            const next = String(chip.getAttribute('data-type-code') || '').toUpperCase();
            if (!next) return;
            const current = String(stormReportsDashboardState.typeFilter || 'all').toUpperCase();
            stormReportsDashboardState.typeFilter = (current === next) ? 'all' : next;
            renderStormReportsDashboardData();
        });
        topMagGrid.addEventListener('keydown', (e) => {
            const isActivate = e.key === 'Enter' || e.key === ' ';
            if (!isActivate) return;
            const chip = e.target.closest('.storm-desk-mag-chip[data-type-code]');
            if (!chip) return;
            e.preventDefault();
            const next = String(chip.getAttribute('data-type-code') || '').toUpperCase();
            if (!next) return;
            const current = String(stormReportsDashboardState.typeFilter || 'all').toUpperCase();
            stormReportsDashboardState.typeFilter = (current === next) ? 'all' : next;
            renderStormReportsDashboardData();
        });
    }
    const listEl = document.getElementById('storm-desk-list');
    if (listEl) {
        listEl.addEventListener('click', (e) => {
            const row = e.target.closest('.storm-desk-report-row[data-report-index]');
            if (!row) return;
            const idx = row.getAttribute('data-report-index');
            openStormDeskReportDetailByIndex(idx);
        });
        listEl.addEventListener('keydown', (e) => {
            const isActivate = e.key === 'Enter' || e.key === ' ';
            if (!isActivate) return;
            const row = e.target.closest('.storm-desk-report-row[data-report-index]');
            if (!row) return;
            e.preventDefault();
            const idx = row.getAttribute('data-report-index');
            openStormDeskReportDetailByIndex(idx);
        });
    }
    const detailOverlay = document.getElementById('storm-desk-report-detail-overlay');
    if (detailOverlay) {
        detailOverlay.addEventListener('click', (e) => {
            if (e.target === detailOverlay) closeStormDeskReportDetail();
        });
    }
    const detailClose = document.getElementById('storm-desk-report-detail-close');
    if (detailClose) {
        detailClose.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            closeStormDeskReportDetail();
        });
    }
    return overlay;
}

function renderStormReportsDashboardData() {
    const overlay = document.getElementById('storm-reports-dashboard-overlay');
    if (!overlay) return;

    const rangeButtons = overlay.querySelectorAll('.storm-desk-range-btn');
    rangeButtons.forEach((button) => {
        const active = String(button.getAttribute('data-range') || '') === stormReportsDashboardState.range;
        button.classList.toggle('active', active);
    });

    const updatedEl = document.getElementById('storm-desk-updated');
    const reportsCountEl = document.getElementById('storm-desk-reports-count');
    const statesCountEl = document.getElementById('storm-desk-states-count');
    const peakValueEl = document.getElementById('storm-desk-peak-value');
    const peakMetaEl = document.getElementById('storm-desk-peak-meta');
    const latestMetaEl = document.getElementById('storm-desk-latest-meta');
    const statesListEl = document.getElementById('storm-desk-states-list');
    const topMagGridEl = document.getElementById('storm-desk-mag-grid');
    const topMagCountEl = document.getElementById('storm-desk-topmag-count');
    const listCountEl = document.getElementById('storm-desk-list-count');
    const listEl = document.getElementById('storm-desk-list');

    if (!reportsCountEl || !statesCountEl || !peakValueEl || !peakMetaEl || !latestMetaEl || !statesListEl || !topMagGridEl || !topMagCountEl || !listCountEl || !listEl) return;

    if (stormReportsDashboardState.loading) {
        if (updatedEl) updatedEl.textContent = 'Loading reports...';
        closeStormDeskReportDetail();
        stormReportsDashboardState.visibleReports = [];
        reportsCountEl.textContent = '--';
        statesCountEl.textContent = '--';
        peakValueEl.textContent = '--';
        peakMetaEl.textContent = 'Loading';
        latestMetaEl.textContent = 'Loading';
        topMagCountEl.textContent = '-- reports';
        listCountEl.textContent = '-- reports';
        statesListEl.innerHTML = '<div class="storm-desk-empty">Loading...</div>';
        topMagGridEl.innerHTML = '<div class="storm-desk-empty">Loading...</div>';
        listEl.innerHTML = '<div class="storm-desk-empty">Loading reports...</div>';
        return;
    }

    const reports = Array.isArray(stormReportsDashboardState.reports) ? stormReportsDashboardState.reports : [];
    const summary = buildStormReportsDashboardSummary(reports);
    const activeTypeFilter = String(stormReportsDashboardState.typeFilter || 'all').toUpperCase();
    const filteredReports = activeTypeFilter === 'ALL'
        ? reports
        : reports.filter((r) => String(r?.typeCode || '').toUpperCase() === activeTypeFilter);
    const stateSummary = activeTypeFilter === 'ALL'
        ? summary
        : buildStormReportsDashboardSummary(filteredReports);

    if (updatedEl) {
        let updatedText = stormReportsDashboardState.lastUpdatedAt
            ? `Updated ${formatStormDeskTimestamp(stormReportsDashboardState.lastUpdatedAt.toISOString())}`
            : 'Updated --';
        if (stormReportsDashboardState.statusNote) {
            updatedText += ` Â· ${stormReportsDashboardState.statusNote}`;
        } else if (stormReportsDashboardState.errorMessage) {
            updatedText += ` Â· ${stormReportsDashboardState.errorMessage}`;
        }
        updatedEl.textContent = updatedText;
    }

    reportsCountEl.textContent = summary.reportCount.toLocaleString();
    statesCountEl.textContent = stateSummary.stateCount.toLocaleString();

    if (summary.peakReport) {
        peakValueEl.textContent = formatStormDeskMagnitude(summary.peakReport.magnitude, summary.peakReport.unit);
        peakMetaEl.textContent = `${summary.peakReport.typeLabel} Â· ${getStormDeskLocation(summary.peakReport)}`;
    } else {
        peakValueEl.textContent = '--';
        peakMetaEl.textContent = 'No numeric magnitude in range';
    }

    if (summary.latestReport) {
        latestMetaEl.textContent = `${getStormDeskLocation(summary.latestReport)} Â· ${formatStormDeskTimestamp(summary.latestReport.validIso)}`;
    } else {
        latestMetaEl.textContent = 'No reports in selected range';
    }

    statesListEl.innerHTML = stateSummary.topStates.length
        ? stateSummary.topStates.map(([state, count], idx) => `
            <div class="storm-desk-state-row storm-desk-item-anim" style="--storm-desk-delay:${Math.min(idx, 10) * 20}ms;">
                <span class="storm-desk-state-rank">${String(idx + 1).padStart(2, '0')}</span>
                <span class="storm-desk-state-name">${escapeHtml(state)}</span>
                <span class="storm-desk-state-count">${Number(count).toLocaleString()}</span>
            </div>
        `).join('')
        : '<div class="storm-desk-empty">No state data</div>';

    topMagCountEl.textContent = `${summary.reportCount.toLocaleString()} reports`;
    topMagGridEl.innerHTML = summary.topMagnitudes.length
        ? summary.topMagnitudes.map((bucket, idx) => `
            <div
                class="storm-desk-mag-chip storm-desk-item-anim ${activeTypeFilter === String(bucket.typeCode || '').toUpperCase() ? 'is-active' : ''}"
                style="--storm-desk-delay:${Math.min(idx, 8) * 20}ms;"
                data-type-code="${escapeHtml(String(bucket.typeCode || '').toUpperCase())}"
                title="Show only ${escapeHtml(bucket.label)} reports"
                role="button"
                tabindex="0"
                aria-pressed="${activeTypeFilter === String(bucket.typeCode || '').toUpperCase() ? 'true' : 'false'}"
            >
                <div class="storm-desk-mag-label">${escapeHtml(bucket.label)}</div>
                <div class="storm-desk-mag-value">${bucket.maxMagnitude == null ? '--' : escapeHtml(formatStormDeskMagnitude(bucket.maxMagnitude, bucket.unit))}</div>
                <div class="storm-desk-mag-count">${Number(bucket.count).toLocaleString()} reports</div>
            </div>
        `).join('')
        : '<div class="storm-desk-empty">No magnitudes</div>';

    const filterLabel = activeTypeFilter === 'ALL' ? '' : ` (${stormDeskTypeLabel(activeTypeFilter)})`;
    listCountEl.textContent = activeTypeFilter === 'ALL'
        ? `${summary.reportCount.toLocaleString()} reports`
        : `${filteredReports.length.toLocaleString()} of ${summary.reportCount.toLocaleString()} reports${filterLabel}`;
    if (!filteredReports.length) {
        closeStormDeskReportDetail();
        stormReportsDashboardState.visibleReports = [];
        const emptyMessage = stormReportsDashboardState.errorMessage
            || stormReportsDashboardState.statusNote
            || (activeTypeFilter === 'ALL'
                ? 'No reports in this window.'
                : `No ${stormDeskTypeLabel(activeTypeFilter)} reports in this window.`);
        listEl.innerHTML = `<div class="storm-desk-empty">${escapeHtml(emptyMessage)}</div>`;
        return;
    }

    const sortedReports = [...filteredReports].sort((a, b) => {
        const tb = getStormDeskValidMs(b) || 0;
        const ta = getStormDeskValidMs(a) || 0;
        if (tb !== ta) return tb - ta;
        const mb = Number.isFinite(b.magnitude) ? b.magnitude : -Infinity;
        const ma = Number.isFinite(a.magnitude) ? a.magnitude : -Infinity;
        return mb - ma;
    });
    stormReportsDashboardState.visibleReports = sortedReports;
    if (stormReportsDashboardState.selectedReportId) {
        const selectedReport = sortedReports.find((report) => String(report.id || '') === stormReportsDashboardState.selectedReportId);
        if (!selectedReport) {
            closeStormDeskReportDetail();
        } else {
            const detailOverlay = document.getElementById('storm-desk-report-detail-overlay');
            if (detailOverlay && !detailOverlay.hidden) {
                openStormDeskReportDetail(selectedReport);
            }
        }
    }

    listEl.innerHTML = sortedReports.map((report, idx) => `
        <div
            class="storm-desk-report-row storm-desk-item-anim"
            style="--storm-desk-delay:${Math.min(idx, 14) * 18}ms;"
            data-report-index="${idx}"
            role="button"
            tabindex="0"
            title="View report details"
        >
            <div class="storm-desk-report-mag">
                <span class="storm-desk-report-mag-num">${Number.isFinite(report.magnitude) ? escapeHtml(Number.isInteger(report.magnitude) ? String(report.magnitude) : report.magnitude.toFixed(1)) : '--'}</span>
                <span class="storm-desk-report-mag-unit">${escapeHtml(report.unit || '')}</span>
            </div>
            <div class="storm-desk-report-main">
                <div class="storm-desk-report-line1">${escapeHtml(getStormDeskLocation(report))}</div>
                <div class="storm-desk-report-line2">${escapeHtml(report.typeLabel)} Â· ${escapeHtml(formatStormDeskTimestamp(report.validIso))} Â· ${escapeHtml(formatStormDeskAgo(report.validIso))}</div>
                <div class="storm-desk-report-line3">${escapeHtml(report.remarks || report.typeText || 'No remarks')}</div>
            </div>
        </div>
    `).join('');
}

async function loadStormReportsDashboardData(rangeKey = 'today') {
    const requestId = ++stormReportsDashboardState.requestId;
    stormReportsDashboardState.range = rangeKey;
    stormReportsDashboardState.loading = true;
    stormReportsDashboardState.statusNote = '';
    stormReportsDashboardState.errorMessage = '';
    renderStormReportsDashboardData();

    try {
        const result = await getStormReportsForDashboardRange(rangeKey);

        if (requestId !== stormReportsDashboardState.requestId) return;
        stormReportsDashboardState.reports = Array.isArray(result?.reports) ? result.reports : [];
        stormReportsDashboardState.statusNote = String(result?.note || '');
        stormReportsDashboardState.lastUpdatedAt = new Date();
    } catch (err) {
        if (requestId !== stormReportsDashboardState.requestId) return;
        console.error('Storm Reports dashboard load failed:', err);
        stormReportsDashboardState.reports = [];
        stormReportsDashboardState.errorMessage = 'Unable to load feed.';
        stormReportsDashboardState.lastUpdatedAt = new Date();
    } finally {
        if (requestId === stormReportsDashboardState.requestId) {
            stormReportsDashboardState.loading = false;
            renderStormReportsDashboardData();
        }
    }
}

function closeStormReportsDashboard() {
    closeStormDeskReportDetail();
    stormReportsDashboardState.visibleReports = [];
    const overlay = document.getElementById('storm-reports-dashboard-overlay');
    if (overlay) overlay.remove();
    stopStormReportsAutoRefresh();
    try { document.removeEventListener('keydown', onStormReportsDashboardKeydown); } catch {}
    syncBlockingOverlayScrollLock();
}

function onStormReportsDashboardKeydown(e) {
    if (e.key !== 'Escape') return;
    const detailOverlay = document.getElementById('storm-desk-report-detail-overlay');
    if (detailOverlay && !detailOverlay.hidden) {
        closeStormDeskReportDetail();
        return;
    }
    closeStormReportsDashboard();
}

function openStormReportsDashboardFallback(messageText = '') {
    try {
        const oldModal = document.getElementById('storm-reports-fallback-overlay');
        if (oldModal) oldModal.remove();
        syncBlockingOverlayScrollLock();

        const overlay = document.createElement('div');
        overlay.className = 'warning-modal-overlay';
        overlay.id = 'storm-reports-fallback-overlay';

        const box = document.createElement('div');
        box.className = 'warning-modal-box source-modal-box';

        const closeBtn = document.createElement('button');
        closeBtn.className = 'warning-modal-close';
        closeBtn.type = 'button';
        closeBtn.innerHTML = '&times;';

        const title = document.createElement('div');
        title.className = 'warning-modal-title source-modal-title';
        title.textContent = 'STORM REPORTS';

        const content = document.createElement('div');
        content.className = 'warning-modal-content source-modal-content';
        content.textContent = `The Storm Reports dashboard could not load right now.${messageText ? `\n\nDetails: ${messageText}` : ''}`;

        const close = () => {
            try { overlay.remove(); } catch {}
            syncBlockingOverlayScrollLock();
        };

        closeBtn.onclick = close;
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) close();
        });

        box.appendChild(closeBtn);
        box.appendChild(title);
        box.appendChild(content);
        overlay.appendChild(box);
        document.body.appendChild(overlay);
        syncBlockingOverlayScrollLock();
    } catch (e) {
        console.error('storm reports fallback modal failed', e);
    }
}

function openStormReportsDashboard() {
    try {
        const staleFallback = document.getElementById('storm-reports-fallback-overlay');
        if (staleFallback) staleFallback.remove();
        syncBlockingOverlayScrollLock();
        closeStormReportsDashboard();
        try { if (typeof closeScannerDashboard === 'function') closeScannerDashboard(); } catch {}
        try { if (typeof closeRyanLiveDashboard === 'function') closeRyanLiveDashboard(); } catch {}
        ensureStormReportsDashboardModal();
        stormReportsDashboardState.range = 'today';
        stormReportsDashboardState.reports = [];
        stormReportsDashboardState.lastUpdatedAt = null;
        stormReportsDashboardState.statusNote = '';
        stormReportsDashboardState.errorMessage = '';
        stormReportsDashboardState.typeFilter = 'all';
        stormReportsDashboardState.visibleReports = [];
        stormReportsDashboardState.selectedReportId = '';
        stormReportsDashboardState.loading = true;
        renderStormReportsDashboardData();
        document.addEventListener('keydown', onStormReportsDashboardKeydown);
        loadStormReportsDashboardData('today');
        startStormReportsAutoRefresh();
        return false;
    } catch (err) {
        console.error('openStormReportsDashboard failed:', err);
        openStormReportsDashboardFallback(String(err?.message || err || 'unknown error'));
        return false;
    }
}
window.openStormReportsDashboard = openStormReportsDashboard;

function bindHeaderStormReportsButton() {
    const btn = document.getElementById('header-storm-reports-btn');
    if (btn && !btn.__stormReportsBound) {
        btn.type = 'button';
        btn.onclick = (e) => {
            if (e && typeof e.preventDefault === 'function') e.preventDefault();
            if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
            return openStormReportsDashboard();
        };
        btn.__stormReportsBound = true;
    }
}
bindHeaderStormReportsButton();

function formatScannerDeskUpdatedTime(date) {
    const d = date instanceof Date ? date : new Date(date);
    if (!Number.isFinite(d.getTime())) return '--:-- --';
    try {
        return d.toLocaleTimeString('en-US', {
            hour: '2-digit',
            minute: '2-digit',
            hour12: true,
            timeZoneName: 'short'
        }).toUpperCase();
    } catch {
        return d.toTimeString().slice(0, 5);
    }
}

function classifyScannerSeverityByPolicePriority(priority, callType = '') {
    const p = Number.parseInt(String(priority || '').trim(), 10);
    const type = String(callType || '').toUpperCase();
    if (
        p <= 1
        || type.includes('SHOOT')
        || type.includes('STABB')
        || type.includes('ROBBERY')
        || type.includes('ASSAULT')
        || type.includes('OVERDOSE')
        || type.includes('WEAPON')
    ) return 'critical';
    if (p <= 3 || type.includes('BURGLARY') || type.includes('DISTURBANCE') || type.includes('TRAFFIC')) return 'warning';
    return 'minor';
}

function getScannerSeverityLabel(severity) {
    if (severity === 'critical') return 'CRITICAL';
    if (severity === 'warning') return 'WARNING';
    return 'MINOR';
}

function normalizePoliceScannerEntry(entry) {
    try {
        const eventId = String(entry?.cad_event_number || '').trim();
        const queuedRaw = String(
            entry?.cad_event_original_time_queued
            || entry?.call_sign_dispatch_time
            || entry?.first_spd_call_sign_dispatch_time
            || ''
        ).trim();
        const queuedMs = new Date(queuedRaw).getTime();
        const finalCallType = String(entry?.final_call_type || '').trim();
        const initialCallType = String(entry?.initial_call_type || '').trim();
        const callType = finalCallType || initialCallType || 'Police Activity';
        const neighborhood = String(entry?.dispatch_neighborhood || '').trim();
        const addressRaw = String(entry?.dispatch_address || '').trim();
        const address = addressRaw.toUpperCase() === 'REDACTED' ? '' : addressRaw;
        const location = [address, neighborhood].filter(Boolean).join(' · ') || 'Seattle, WA';
        const priority = String(entry?.priority || '').trim();
        const clearance = String(entry?.cad_event_clearance_description || '').trim();
        const severity = classifyScannerSeverityByPolicePriority(priority, callType);

        if (!eventId) return null;
        if (!Number.isFinite(queuedMs)) return null;

        return {
            eventId,
            title: callType.toUpperCase(),
            location,
            detail: clearance ? `Priority ${priority || 'N/A'} · ${clearance}` : `Priority ${priority || 'N/A'}`,
            timeRaw: queuedRaw,
            timeMs: queuedMs,
            timeText: formatStormDeskAgo(queuedRaw),
            severity,
            severityLabel: getScannerSeverityLabel(severity)
        };
    } catch {
        return null;
    }
}

async function fetchPoliceScannerActivity(limit = 160) {
    const maxRows = Math.max(20, Math.min(500, Number(limit) || 160));
    const sinceIso = new Date(Date.now() - (72 * 60 * 60 * 1000)).toISOString();
    const params = new URLSearchParams({
        '$select': 'cad_event_number,cad_event_original_time_queued,initial_call_type,final_call_type,dispatch_neighborhood,dispatch_address,priority,cad_event_clearance_description',
        '$where': `cad_event_response_category='SPD' AND cad_event_original_time_queued >= '${sinceIso}'`,
        '$order': 'cad_event_original_time_queued DESC',
        '$limit': String(maxRows)
    });
    const response = await fetch(`${POLICE_SCANNER_ACTIVITY_URL}?${params.toString()}`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`police scanner fetch failed (${response.status})`);
    const raw = await response.json();
    const normalized = (Array.isArray(raw) ? raw : [])
        .map(normalizePoliceScannerEntry)
        .filter(Boolean);

    // CAD events repeat per dispatched unit; dedupe to one row per event.
    const deduped = [];
    const seen = new Set();
    for (const row of normalized) {
        const key = String(row.eventId || '').trim();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        deduped.push(row);
    }
    deduped.sort((a, b) => (b.timeMs || 0) - (a.timeMs || 0));
    return deduped;
}

function buildScannerStateFromPoliceCalls(calls) {
    const rows = Array.isArray(calls) ? calls.filter(Boolean) : [];
    let severityCritical = 0;
    let severityWarning = 0;
    let severityMinor = 0;
    const eventNames = new Set();
    const sortedRows = [...rows].sort((a, b) => (b.timeMs || 0) - (a.timeMs || 0));
    const recentTraffic = sortedRows.slice(0, 12);

    rows.forEach((call) => {
        const eventName = String(call?.title || 'POLICE ACTIVITY').toUpperCase();
        if (eventName) eventNames.add(eventName);

        if (call?.severity === 'critical') {
            severityCritical += 1;
        } else if (call?.severity === 'warning') {
            severityWarning += 1;
        } else {
            severityMinor += 1;
        }
    });

    const transmissions = rows.length;
    const events = eventNames.size || transmissions;
    const statusNote = transmissions
        ? `Using police scanner activity feed (${transmissions.toLocaleString()} recent calls).`
        : 'No recent police scanner activity in the current analysis window.';

    return {
        transmissions,
        events,
        severityCritical,
        severityWarning,
        severityMinor,
        statusNote,
        recentTraffic
    };
}

async function refreshScannerDashboardFromAnyTraffic() {
    const emptyState = {
        transmissions: 0,
        events: 0,
        severityCritical: 0,
        severityWarning: 0,
        severityMinor: 0,
        statusNote: 'No recent police scanner activity in the current analysis window.',
        recentTraffic: []
    };

    try {
        const calls = await fetchPoliceScannerActivity(180);
        if (calls.length) {
            scannerDashboardState = {
                ...scannerDashboardState,
                ...buildScannerStateFromPoliceCalls(calls),
                lastUpdatedAt: new Date()
            };
            renderScannerDashboardData();
            return;
        }

        scannerDashboardState = {
            ...scannerDashboardState,
            ...emptyState,
            lastUpdatedAt: new Date()
        };
        renderScannerDashboardData();
    } catch (err) {
        console.error('refreshScannerDashboardFromAnyTraffic failed:', err);
        scannerDashboardState = {
            ...scannerDashboardState,
            ...emptyState,
            statusNote: 'Unable to load police scanner activity right now.',
            lastUpdatedAt: new Date()
        };
        renderScannerDashboardData();
    }
}

function ensureScannerDashboardModal() {
    let overlay = document.getElementById('scanner-dashboard-overlay');
    if (overlay) return overlay;

    overlay = document.createElement('div');
    overlay.id = 'scanner-dashboard-overlay';
    overlay.className = 'scanner-desk-overlay';
    // Defensive inline fallback: if CSS cache is stale, keep modal visible and usable.
    overlay.style.position = 'fixed';
    overlay.style.inset = '0';
    overlay.style.zIndex = '25100';
    overlay.style.display = 'flex';
    overlay.style.alignItems = 'center';
    overlay.style.justifyContent = 'center';
    overlay.style.padding = '1rem';
    overlay.style.background = 'rgba(2, 6, 16, 0.88)';
    overlay.innerHTML = `
        <div class="scanner-desk-shell storm-desk-shell-enter" role="dialog" aria-modal="true" aria-label="Scanner Intelligence">
            <button type="button" class="scanner-desk-close" id="scanner-desk-close" aria-label="Close Scanner Intelligence">&times;</button>
            <div class="scanner-desk-top storm-desk-item-anim" style="--storm-desk-delay: 20ms;">
                <div class="scanner-desk-icon"><i class="fa-solid fa-tower-broadcast"></i></div>
                <h2 class="scanner-desk-title">Scanner Intelligence</h2>
            </div>
            <div class="scanner-desk-stats-row storm-desk-item-anim" style="--storm-desk-delay: 55ms;">
                <div class="scanner-desk-stat-card">
                    <div class="scanner-desk-stat-icon"><i class="fa-solid fa-wave-square"></i></div>
                    <div>
                        <div class="scanner-desk-stat-value" id="scanner-desk-transmissions">0</div>
                        <div class="scanner-desk-stat-label">Transmissions</div>
                    </div>
                </div>
                <div class="scanner-desk-stat-card">
                    <div class="scanner-desk-stat-icon"><i class="fa-regular fa-bell"></i></div>
                    <div>
                        <div class="scanner-desk-stat-value" id="scanner-desk-events">0</div>
                        <div class="scanner-desk-stat-label">Events</div>
                    </div>
                </div>
                <div class="scanner-desk-stat-card">
                    <div class="scanner-desk-stat-icon"><i class="fa-solid fa-triangle-exclamation"></i></div>
                    <div>
                        <div class="scanner-desk-stat-value"><span id="scanner-desk-sev-critical">0</span> <span id="scanner-desk-sev-warning" style="color:#ef4444;">0</span> <span id="scanner-desk-sev-minor" style="color:#22c55e;">0</span></div>
                        <div class="scanner-desk-stat-label">By Severity</div>
                    </div>
                </div>
                <div class="scanner-desk-stat-card">
                    <div class="scanner-desk-stat-icon"><i class="fa-regular fa-clock"></i></div>
                    <div>
                        <div class="scanner-desk-stat-value" id="scanner-desk-updated-time">--:-- --</div>
                        <div class="scanner-desk-stat-label">Last Update</div>
                    </div>
                </div>
            </div>
            <div class="scanner-desk-refresh-wrap storm-desk-item-anim" style="--storm-desk-delay: 80ms;">
                <button type="button" class="scanner-desk-refresh-btn" id="scanner-desk-refresh-btn"><i class="fa-solid fa-rotate-right"></i> Refresh Intelligence</button>
            </div>
            <div class="scanner-desk-summary storm-desk-item-anim" style="--storm-desk-delay: 110ms;">
                <div class="scanner-desk-summary-kicker">&gt; Situation Summary:</div>
                <p class="scanner-desk-summary-text" id="scanner-desk-summary-text">No recent police scanner activity in the current analysis window.</p>
            </div>
            <div class="scanner-desk-panels storm-desk-item-anim" style="--storm-desk-delay: 140ms;">
                <section class="scanner-desk-panel">
                    <h3 class="scanner-desk-panel-title">Police Scanner Feed Monitor</h3>
                    <div id="scanner-desk-feed-list" class="scanner-desk-feed-list"></div>
                </section>
            </div>
        </div>
    `;
    const shell = overlay.querySelector('.scanner-desk-shell');
    if (shell) {
        shell.style.width = 'min(1380px, 97vw)';
        shell.style.maxHeight = '95vh';
        shell.style.overflow = 'hidden auto';
        shell.style.padding = '1.15rem';
        shell.style.background = 'linear-gradient(180deg, rgba(5, 11, 28, 0.98), rgba(4, 10, 24, 0.98))';
        shell.style.border = '1px solid rgba(34, 194, 255, 0.45)';
        shell.style.color = '#e9f7ff';
    }

    const isScannerDeskCloseHit = (event) => {
        const closeEl = overlay.querySelector('#scanner-desk-close');
        if (!closeEl) return false;
        const rect = closeEl.getBoundingClientRect();
        const x = Number(event?.clientX);
        const y = Number(event?.clientY);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
        return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
    };

    overlay.addEventListener('pointerdown', (e) => {
        if (!isScannerDeskCloseHit(e)) return;
        e.preventDefault();
        e.stopPropagation();
        closeScannerDashboard();
    }, true);

    overlay.addEventListener('click', (e) => {
        if (isScannerDeskCloseHit(e)) {
            e.preventDefault();
            e.stopPropagation();
            closeScannerDashboard();
            return;
        }
        if (e.target === overlay) closeScannerDashboard();
    });

    document.body.appendChild(overlay);
    syncBlockingOverlayScrollLock();

    const closeBtn = document.getElementById('scanner-desk-close');
    if (closeBtn) {
        closeBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            closeScannerDashboard();
        });
    }

    const refreshBtn = document.getElementById('scanner-desk-refresh-btn');
    if (refreshBtn) {
        refreshBtn.addEventListener('click', async (e) => {
            e.preventDefault();
            scannerDashboardState.statusNote = 'Refreshing police scanner activity...';
            scannerDashboardState.lastUpdatedAt = new Date();
            renderScannerDashboardData();
            await refreshScannerDashboardFromAnyTraffic();
        });
    }

    return overlay;
}

function renderScannerDashboardData() {
    const overlay = document.getElementById('scanner-dashboard-overlay');
    if (!overlay) return;
    const transmissionsEl = document.getElementById('scanner-desk-transmissions');
    const eventsEl = document.getElementById('scanner-desk-events');
    const sevCriticalEl = document.getElementById('scanner-desk-sev-critical');
    const sevWarningEl = document.getElementById('scanner-desk-sev-warning');
    const sevMinorEl = document.getElementById('scanner-desk-sev-minor');
    const updatedEl = document.getElementById('scanner-desk-updated-time');
    const summaryEl = document.getElementById('scanner-desk-summary-text');
    const feedListEl = document.getElementById('scanner-desk-feed-list');

    if (transmissionsEl) transmissionsEl.textContent = String(Number(scannerDashboardState.transmissions || 0));
    if (eventsEl) eventsEl.textContent = String(Number(scannerDashboardState.events || 0));
    if (sevCriticalEl) sevCriticalEl.textContent = String(Number(scannerDashboardState.severityCritical || 0));
    if (sevWarningEl) sevWarningEl.textContent = String(Number(scannerDashboardState.severityWarning || 0));
    if (sevMinorEl) sevMinorEl.textContent = String(Number(scannerDashboardState.severityMinor || 0));
    if (updatedEl) updatedEl.textContent = formatScannerDeskUpdatedTime(scannerDashboardState.lastUpdatedAt || new Date());
    if (summaryEl) summaryEl.textContent = String(scannerDashboardState.statusNote || 'No recent police scanner activity in the current analysis window.');
    if (feedListEl) {
        const rows = Array.isArray(scannerDashboardState.recentTraffic) ? scannerDashboardState.recentTraffic : [];
        if (!rows.length) {
            feedListEl.innerHTML = `
                <div class="scanner-desk-quiet-state">
                    <div>
                        <i class="fa-solid fa-wave-square"></i>
                        <div class="scanner-desk-quiet-title">No Notable Incidents Detected</div>
                        <div class="scanner-desk-quiet-sub">Police scanner feed active and monitoring...</div>
                    </div>
                </div>
            `;
            return;
        }

        feedListEl.innerHTML = rows.slice(0, 12).map((row, idx) => {
            const sev = String(row?.severity || 'minor').toLowerCase();
            const severityClass = ['critical', 'warning', 'minor'].includes(sev) ? sev : 'minor';
            return `
                <div class="scanner-desk-feed-row storm-desk-item-anim" style="--storm-desk-delay:${Math.min(idx, 12) * 20}ms;">
                    <div class="scanner-desk-feed-sev ${severityClass}">${escapeHtml(String(row?.severityLabel || getScannerSeverityLabel(severityClass)))}</div>
                    <div class="scanner-desk-feed-main">
                        <div class="scanner-desk-feed-line1">
                            <span>${escapeHtml(String(row?.title || 'Scanner Traffic'))}</span>
                            <span class="scanner-desk-feed-time">${escapeHtml(String(row?.timeText || '--'))}</span>
                        </div>
                        <div class="scanner-desk-feed-line2">${escapeHtml(String(row?.location || 'Unknown Location'))}</div>
                        <div class="scanner-desk-feed-line3">${escapeHtml(String(row?.detail || 'No details available'))}</div>
                    </div>
                </div>
            `;
        }).join('');
    }
}

function closeScannerDashboard() {
    const overlay = document.getElementById('scanner-dashboard-overlay');
    if (overlay) overlay.remove();
    try { document.removeEventListener('keydown', onScannerDashboardKeydown); } catch {}
    syncBlockingOverlayScrollLock();
}

function onScannerDashboardKeydown(e) {
    if (e.key === 'Escape') closeScannerDashboard();
}

function openScannerDashboard() {
    try {
        const staleScanner = document.getElementById('scanner-dashboard-overlay');
        if (staleScanner) staleScanner.remove();
        const staleFallback = document.getElementById('scanner-dashboard-fallback-overlay');
        if (staleFallback) staleFallback.remove();
        syncBlockingOverlayScrollLock();
        if (typeof closeStormReportsDashboard === 'function') closeStormReportsDashboard();
        try { if (typeof closeRyanLiveDashboard === 'function') closeRyanLiveDashboard(); } catch {}
        ensureScannerDashboardModal();
        scannerDashboardState.statusNote = 'Loading police scanner activity...';
        scannerDashboardState.lastUpdatedAt = new Date();
        renderScannerDashboardData();
        refreshScannerDashboardFromAnyTraffic();
        document.addEventListener('keydown', onScannerDashboardKeydown);
        return false;
    } catch (err) {
        console.error('openScannerDashboard failed:', err);
        // Last-resort fallback so the button still does something visible.
        try {
            const stale = document.getElementById('scanner-dashboard-fallback-overlay');
            if (stale) stale.remove();
            const overlay = document.createElement('div');
            overlay.className = 'warning-modal-overlay';
            overlay.id = 'scanner-dashboard-fallback-overlay';
            overlay.style.position = 'fixed';
            overlay.style.inset = '0';
            overlay.style.zIndex = '25200';
            overlay.style.display = 'flex';
            overlay.style.alignItems = 'center';
            overlay.style.justifyContent = 'center';
            overlay.style.padding = '1rem';
            overlay.style.background = 'rgba(3, 6, 14, 0.85)';
            const box = document.createElement('div');
            box.className = 'warning-modal-box source-modal-box';
            box.style.maxWidth = '560px';
            box.style.width = 'min(92vw, 560px)';
            box.style.background = '#10172a';
            box.style.border = '1px solid rgba(67, 190, 255, 0.35)';
            box.style.color = '#e7f8ff';
            const closeBtn = document.createElement('button');
            closeBtn.className = 'warning-modal-close';
            closeBtn.type = 'button';
            closeBtn.innerHTML = '&times;';
            const title = document.createElement('div');
            title.className = 'warning-modal-title source-modal-title';
            title.textContent = 'SCANNER INTELLIGENCE';
            const content = document.createElement('div');
            content.className = 'warning-modal-content source-modal-content';
            content.textContent = 'Scanner page could not open right now. Try refreshing once and tapping Scanner again.';
            const close = () => { try { overlay.remove(); } catch {}; try { syncBlockingOverlayScrollLock(); } catch {} };
            closeBtn.onclick = close;
            overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
            box.appendChild(closeBtn);
            box.appendChild(title);
            box.appendChild(content);
            overlay.appendChild(box);
            document.body.appendChild(overlay);
            try { syncBlockingOverlayScrollLock(); } catch {}
        } catch {}
        return false;
    }
}
window.openScannerDashboard = openScannerDashboard;

function bindHeaderScannerButton() {
    const btn = document.getElementById('header-scanner-btn');
    if (btn && !btn.__scannerBound) {
        btn.type = 'button';
        btn.onclick = (e) => {
            if (e && typeof e.preventDefault === 'function') e.preventDefault();
            if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
            return openScannerDashboard();
        };
        btn.__scannerBound = true;
    }
}
bindHeaderScannerButton();
window.addEventListener('DOMContentLoaded', bindHeaderScannerButton);

function closeRyanLiveDashboard() {
    const section = document.getElementById('ryan-live-section');
    if (!section) return;
    section.classList.remove('is-open');
    section.setAttribute('aria-hidden', 'true');
    try { document.removeEventListener('keydown', onRyanLiveDashboardKeydown); } catch {}
    syncBlockingOverlayScrollLock();
}

function onRyanLiveDashboardKeydown(e) {
    if (e.key === 'Escape') closeRyanLiveDashboard();
}

function openRyanLiveDashboard() {
    try {
        const section = document.getElementById('ryan-live-section');
        if (!section) return false;
        try { if (typeof closeStormReportsDashboard === 'function') closeStormReportsDashboard(); } catch {}
        try { if (typeof closeScannerDashboard === 'function') closeScannerDashboard(); } catch {}
        section.classList.add('is-open');
        section.setAttribute('aria-hidden', 'false');
        renderRyanLiveTopWarnings();
        document.addEventListener('keydown', onRyanLiveDashboardKeydown);
        syncBlockingOverlayScrollLock();
    } catch (err) {
        console.error('openRyanLiveDashboard failed:', err);
    }
    return false;
}
window.openRyanLiveDashboard = openRyanLiveDashboard;

function openRyanLiveView() {
    return openRyanLiveDashboard();
}
window.openRyanLiveView = openRyanLiveView;

function bindRyanLiveDashboard() {
    const section = document.getElementById('ryan-live-section');
    if (!section || section.__ryanLiveDashboardBound) return;
    const closeBtn = document.getElementById('ryan-live-close');
    if (closeBtn) {
        closeBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            closeRyanLiveDashboard();
        });
    }
    section.addEventListener('click', (e) => {
        if (e.target === section) closeRyanLiveDashboard();
    });
    section.classList.remove('is-open');
    section.setAttribute('aria-hidden', 'true');
    section.__ryanLiveDashboardBound = true;
}
bindRyanLiveDashboard();
window.addEventListener('DOMContentLoaded', bindRyanLiveDashboard);

function bindHeaderRyanLiveButton() {
    const btn = document.getElementById('header-ryan-live-btn');
    if (btn && !btn.__ryanLiveBound) {
        btn.type = 'button';
        btn.onclick = (e) => {
            if (e && typeof e.preventDefault === 'function') e.preventDefault();
            if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
            return openRyanLiveView();
        };
        btn.__ryanLiveBound = true;
    }
}
bindHeaderRyanLiveButton();
window.addEventListener('DOMContentLoaded', bindHeaderRyanLiveButton);

function clearStaleScannerOverlays() {
    try {
        const scannerOverlay = document.getElementById('scanner-dashboard-overlay');
        if (scannerOverlay) scannerOverlay.remove();
    } catch {}
    try {
        const fallbackOverlay = document.getElementById('scanner-dashboard-fallback-overlay');
        if (fallbackOverlay) fallbackOverlay.remove();
    } catch {}
    try { syncBlockingOverlayScrollLock(); } catch {}
}
window.addEventListener('DOMContentLoaded', clearStaleScannerOverlays);

// Delegated fallback in case the button is re-rendered
document.addEventListener('click', (e) => {
    const trigger = e.target.closest && e.target.closest('#main-settings-btn');
    if (trigger) {
        e.preventDefault();
        showForecastSettings();
    }
    const wwTrigger = e.target.closest && e.target.closest('#header-weatherwise-btn');
    if (wwTrigger) {
        e.preventDefault();
        openWeatherWisePopout();
    }
    const scannerTrigger = e.target.closest && e.target.closest('#header-scanner-btn');
    if (scannerTrigger) {
        e.preventDefault();
        openScannerDashboard();
    }
    const ryanLiveTrigger = e.target.closest && e.target.closest('#header-ryan-live-btn');
    if (ryanLiveTrigger) {
        e.preventDefault();
        openRyanLiveView();
    }
});

// Initialize fixed warning counter
updateFixedWarningCounter();

// Find the remaining floating button and make it open the map
window.addEventListener('DOMContentLoaded', function() {
    // Remove any old floating map buttons on the left
    document.querySelectorAll('#map-fab').forEach(el => el.remove());
    document.querySelectorAll('button').forEach(btn => {
        if (btn.innerText.trim() === 'ðŸ—ºï¸' || btn.innerText.trim() === 'ðŸ—º') {
            btn.remove();
        }
    });
    // Removed menu button and dropdown code
}); 

 




