const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const ADMIN_CODE = process.env.ADMIN_CODE || 'ADMIN2026';

// ── Access codes (hardcoded + env) ──────────────────────────────────────────
const HARDCODED_CODES = new Set([
  'Asaf2026','Yagil2026','Avi2026','Haggai2026','Izhar2026',
  'Eyal2026','Yaron2026','David2026','Ariel2026','Esti2026',
  'Sam2026','Lior2026','Cme2026','Ori2026','Illy2026',
  'Kira2026','Israely2026','Eran2026','Liat2026','Yilan2026',
  'Michal2026','Nitzan2026','Moshe2026','Revi2026','Keren2026',
  'Noa2026','Ezer2026','Sarit2026','Galit2026','Eshi2026',
  'Vered2026','Dana2026'
]);

// Also read from env if present (ACCESS_CODES=code1,code2,...)
const envCodes = (process.env.ACCESS_CODES || '').split(',').map(s => s.trim()).filter(Boolean);
envCodes.forEach(c => HARDCODED_CODES.add(c));

function isValidCode(code) {
  return HARDCODED_CODES.has(code);
}

// ── Per-user store ────────────────────────────────────────────────────────────
const userStore = new Map();
function getUserStore(code) {
  const key = code.trim();
  if (!userStore.has(key)) {
    userStore.set(key, { candidates: [], lastActive: Date.now() });
  }
  const store = userStore.get(key);
  store.lastActive = Date.now();
  return store;
}

// ── MIME types ────────────────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
};

// ── Helper: read body ─────────────────────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => data += chunk);
    req.on('end', () => {
      try { resolve(JSON.parse(data)); } catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

// ── Helper: send JSON ─────────────────────────────────────────────────────────
function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(body);
}

// ── Serve static files ────────────────────────────────────────────────────────
function serveStatic(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404); res.end('Not found');
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

// ── Anthropic proxy ───────────────────────────────────────────────────────────
function proxyAnthropic(req, res, body) {
  const payload = JSON.stringify(body);
  const options = {
    hostname: 'api.anthropic.com',
    path: '/v1/messages',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'web-search-2025-03-05',
    }
  };

  const apiReq = https.request(options, apiRes => {
    let data = '';
    apiRes.on('data', chunk => data += chunk);
    apiRes.on('end', () => {
      res.writeHead(apiRes.statusCode, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(data);
    });
  });
  apiReq.on('error', err => sendJSON(res, 500, { error: err.message }));
  apiReq.write(payload);
  apiReq.end();
}

// ── HTTP server ───────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,x-access-code',
    });
    res.end();
    return;
  }

  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  // ── API routes ──────────────────────────────────────────────────────────────

  // POST /api/verify
  if (pathname === '/api/verify' && req.method === 'POST') {
    const body = await readBody(req);
    const code = (body.code || '').trim();
    if (isValidCode(code)) {
      sendJSON(res, 200, { ok: true });
    } else {
      sendJSON(res, 401, { ok: false, error: 'Invalid access code' });
    }
    return;
  }

  // Auth check for all other /api/ routes
  const code = (req.headers['x-access-code'] || '').trim();
  if (pathname.startsWith('/api/') && pathname !== '/api/verify' && pathname !== '/api/admin/summary') {
    if (!isValidCode(code)) {
      sendJSON(res, 401, { error: 'Unauthorized' });
      return;
    }
  }

  // POST /api/analyse  — proxy to Anthropic
  if (pathname === '/api/analyse' && req.method === 'POST') {
    const body = await readBody(req);
    proxyAnthropic(req, res, body);
    return;
  }

  // GET /api/candidates
  if (pathname === '/api/candidates' && req.method === 'GET') {
    const store = getUserStore(code);
    sendJSON(res, 200, { candidates: store.candidates });
    return;
  }

  // POST /api/candidates
  if (pathname === '/api/candidates' && req.method === 'POST') {
    const body = await readBody(req);
    const store = getUserStore(code);
    const candidate = { ...body, id: Date.now().toString(), savedAt: new Date().toISOString() };
    store.candidates.unshift(candidate);
    sendJSON(res, 200, { ok: true, candidate });
    return;
  }

  // DELETE /api/candidates/:id
  if (pathname.startsWith('/api/candidates/') && req.method === 'DELETE') {
    const id = pathname.split('/').pop();
    const store = getUserStore(code);
    store.candidates = store.candidates.filter(c => c.id !== id);
    sendJSON(res, 200, { ok: true });
    return;
  }

  // GET /api/admin/summary
  if (pathname === '/api/admin/summary' && req.method === 'GET') {
    const adminCode = req.headers['x-access-code'] || '';
    if (adminCode !== ADMIN_CODE) {
      sendJSON(res, 401, { error: 'Unauthorized' });
      return;
    }
    const summary = [];
    userStore.forEach((store, key) => {
      summary.push({ code: key, candidates: store.candidates.length, lastActive: store.lastActive });
    });
    sendJSON(res, 200, { users: summary, totalUsers: userStore.size });
    return;
  }

  // ── Static files ────────────────────────────────────────────────────────────
  let filePath;
  if (pathname === '/' || pathname === '/index.html') {
    filePath = path.join(__dirname, 'public', 'index.html');
  } else {
    filePath = path.join(__dirname, 'public', pathname);
  }
  serveStatic(res, filePath);
});

server.listen(PORT, () => {
  console.log(`Wiserr server running on port ${PORT}`);
  console.log(`Loaded ${HARDCODED_CODES.size} access codes`);
});
