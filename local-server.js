const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 5500);

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4'
};

const overpassCache = new Map();
const modotCache = new Map();
const OVERPASS_TTL_MS = 120000;
const MODOT_TTL_MS = 60000;
const BODY_LIMIT_BYTES = 1024 * 1024;

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
}

function sendText(res, status, body, contentType = 'text/plain; charset=utf-8') {
  setCors(res);
  res.writeHead(status, { 'Content-Type': contentType });
  res.end(body);
}

function sendJson(res, status, value) {
  sendText(res, status, JSON.stringify(value), 'application/json; charset=utf-8');
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      bytes += Buffer.byteLength(chunk, 'utf8');
      if (bytes > BODY_LIMIT_BYTES) {
        reject(new Error('Payload too large'));
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function getCache(cache, key, ttlMs) {
  const entry = cache.get(key);
  if (!entry) return null;
  if ((Date.now() - entry.ts) > ttlMs) return null;
  return entry;
}

function setCache(cache, key, payload) {
  cache.set(key, { ts: Date.now(), payload });
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 22000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function handleModotProxy(req, res, parsedUrl) {
  const q = parsedUrl.searchParams;
  const west = Number(q.get('west'));
  const south = Number(q.get('south'));
  const east = Number(q.get('east'));
  const north = Number(q.get('north'));
  const hasBounds = [west, south, east, north].every(Number.isFinite);
  const cacheKey = hasBounds
    ? `${west.toFixed(3)}|${south.toFixed(3)}|${east.toFixed(3)}|${north.toFixed(3)}`
    : 'all';

  const cached = getCache(modotCache, cacheKey, MODOT_TTL_MS);
  if (cached) {
    res.setHeader('X-Proxy-Cache', 'hit');
    return sendText(res, 200, cached.payload, 'application/geo+json; charset=utf-8');
  }

  const params = new URLSearchParams({
    where: '1=1',
    outFields: 'CAM_ID,DESCRIPTION,URL1,URL2,REFR_RATE_MS,STREAM_ERROR',
    returnGeometry: 'true',
    outSR: '4326',
    f: 'geojson'
  });

  if (hasBounds) {
    params.set('geometry', `${west},${south},${east},${north}`);
    params.set('geometryType', 'esriGeometryEnvelope');
    params.set('inSR', '4326');
    params.set('spatialRel', 'esriSpatialRelIntersects');
  }

  const url = `https://mapping.modot.mo.gov/arcgis/rest/services/TravelerInformation/NWSDATA/MapServer/0/query?${params.toString()}`;
  const response = await fetchWithTimeout(url, {
    headers: {
      Accept: 'application/geo+json, application/json',
      'User-Agent': 'WeatherOverlayLocalProxy/1.0'
    }
  }, 25000);

  if (!response.ok) {
    return sendJson(res, response.status, { error: `MoDOT query failed (${response.status})` });
  }

  const payload = await response.text();
  setCache(modotCache, cacheKey, payload);
  res.setHeader('X-Proxy-Cache', 'miss');
  return sendText(res, 200, payload, response.headers.get('content-type') || 'application/geo+json; charset=utf-8');
}

async function handleOverpassProxy(req, res) {
  const query = (await readBody(req)).trim();
  if (!query) return sendJson(res, 400, { error: 'Missing Overpass query body' });

  const cached = getCache(overpassCache, query, OVERPASS_TTL_MS);
  if (cached) {
    res.setHeader('X-Proxy-Cache', 'hit');
    return sendText(res, 200, cached.payload, 'application/json; charset=utf-8');
  }

  const response = await fetchWithTimeout('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'text/plain; charset=UTF-8',
      'User-Agent': 'WeatherOverlayLocalProxy/1.0'
    },
    body: query
  }, 26000);

  if (response.status === 429) {
    const stale = overpassCache.get(query);
    if (stale?.payload) {
      res.setHeader('X-Proxy-Cache', 'stale-429');
      return sendText(res, 200, stale.payload, 'application/json; charset=utf-8');
    }
  }

  if (!response.ok) {
    return sendJson(res, response.status, { error: `Overpass query failed (${response.status})` });
  }

  const payload = await response.text();
  setCache(overpassCache, query, payload);
  res.setHeader('X-Proxy-Cache', 'miss');
  return sendText(res, 200, payload, response.headers.get('content-type') || 'application/json; charset=utf-8');
}

function safePathFromUrlPath(urlPathname) {
  let reqPath = decodeURIComponent(urlPathname || '/');
  if (reqPath === '/') reqPath = '/index.html';
  const normalized = path.normalize(reqPath).replace(/^(\.\.[/\\])+/, '');
  const fsPath = path.join(ROOT, normalized);
  const rootResolved = path.resolve(ROOT);
  const fileResolved = path.resolve(fsPath);
  if (!fileResolved.startsWith(rootResolved)) return null;
  return fileResolved;
}

function serveStatic(req, res, parsedUrl) {
  const filePath = safePathFromUrlPath(parsedUrl.pathname);
  if (!filePath) return sendText(res, 403, 'Forbidden');

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      return sendText(res, 404, 'Not Found');
    }
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    setCors(res);
    res.writeHead(200, { 'Content-Type': contentType });
    fs.createReadStream(filePath).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') {
      setCors(res);
      res.writeHead(204);
      return res.end();
    }

    const parsedUrl = new URL(req.url, `http://${req.headers.host || `localhost:${PORT}`}`);
    const pathname = parsedUrl.pathname || '/';

    if (pathname === '/proxy/modot' && req.method === 'GET') {
      return await handleModotProxy(req, res, parsedUrl);
    }
    if (pathname === '/proxy/overpass' && req.method === 'POST') {
      return await handleOverpassProxy(req, res);
    }

    return serveStatic(req, res, parsedUrl);
  } catch (error) {
    console.error('[local-server] request error', error);
    return sendJson(res, 500, { error: 'Internal server error' });
  }
});

server.listen(PORT, () => {
  console.log(`[local-server] running at http://localhost:${PORT}/index.html`);
});
