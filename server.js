const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const ACCESS_CODES = (process.env.ACCESS_CODES || 'WISERR2024')
  .split(',').map(c => c.trim().toUpperCase());

// ── Per-user candidate storage ──────────────────────────────────────────
// Structure: { [accessCode]: { candidates: [...], lastActive: timestamp } }
const userStore = new Map();

function getUserStore(code) {
  const key = code.toUpperCase();
  if (!userStore.has(key)) {
    userStore.set(key, { candidates: [], lastActive: Date.now() });
  }
  const store = userStore.get(key);
  store.lastActive = Date.now();
  return store;
}

const MIME = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json'
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function json(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(JSON.stringify(data));
}

function proxyAnthropic(bodyStr, res) {
  const parsed = JSON.parse(bodyStr);
  const options = {
    hostname: 'api.anthropic.com',
    path: '/v1/messages',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Length': Buffer.byteLength(bodyStr)
    }
  };
  const proxy = https.request(options, apiRes => {
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
  proxy.on('error', err => json(res, 500, { error: { message: err.message } }));
  proxy.write(bodyStr);
  proxy.end();
}

function getCode(req) {
  return (req.headers['x-access-code'] || '').trim().toUpperCase();
}

function isValid(code) {
  return ACCESS_CODES.includes(code);
}

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-access-code');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ── Verify code ──
  if (pathname === '/api/verify' && req.method === 'POST') {
    const body = await readBody(req);
    let code = '';
    try { code = JSON.parse(body).code || ''; } catch(e) {}
    const valid = isValid(code.trim().toUpperCase());
    if (valid) getUserStore(code); // init store
    json(res, 200, { valid });
    return;
  }

  // ── Proxy to Anthropic ──
  if (pathname === '/api/analyse' && req.method === 'POST') {
    const code = getCode(req);
    if (!isValid(code)) { json(res, 401, { error: { message: 'Invalid access code' } }); return; }
    const body = await readBody(req);
    proxyAnthropic(body, res);
    return;
  }

  // ── Get MY candidates ──
  if (pathname === '/api/candidates' && req.method === 'GET') {
    const code = getCode(req);
    if (!isValid(code)) { json(res, 401, { error: { message: 'Unauthorized' } }); return; }
    const store = getUserStore(code);
    json(res, 200, { candidates: store.candidates });
    return;
  }

  // ── Save candidate ──
  if (pathname === '/api/candidates' && req.method === 'POST') {
    const code = getCode(req);
    if (!isValid(code)) { json(res, 401, { error: { message: 'Unauthorized' } }); return; }
    const body = await readBody(req);
    let candidate;
    try { candidate = JSON.parse(body); } catch(e) { json(res, 400, { error: 'Invalid JSON' }); return; }
    const store = getUserStore(code);
    // Check if updating existing
    const idx = store.candidates.findIndex(c => c.id === candidate.id);
    if (idx >= 0) {
      store.candidates[idx] = candidate;
    } else {
      store.candidates.unshift(candidate);
    }
    json(res, 200, { ok: true, id: candidate.id });
    return;
  }

  // ── Delete candidate ──
  if (pathname.startsWith('/api/candidates/') && req.method === 'DELETE') {
    const code = getCode(req);
    if (!isValid(code)) { json(res, 401, { error: { message: 'Unauthorized' } }); return; }
    const id = pathname.replace('/api/candidates/', '');
    const store = getUserStore(code);
    store.candidates = store.candidates.filter(c => c.id !== id);
    json(res, 200, { ok: true });
    return;
  }

  // ── Admin: list all users summary (use admin code) ──
  if (pathname === '/api/admin/summary' && req.method === 'GET') {
    const code = getCode(req);
    const adminCode = (process.env.ADMIN_CODE || 'ADMIN2024').toUpperCase();
    if (code !== adminCode) { json(res, 401, { error: 'Unauthorized' }); return; }
    const summary = Array.from(userStore.entries()).map(([k, v]) => ({
      code: k.slice(0,4) + '****',
      candidates: v.candidates.length,
      lastActive: new Date(v.lastActive).toISOString()
    }));
    json(res, 200, { users: summary, totalCodes: ACCESS_CODES.length });
    return;
  }

  // ── Static files ──
  let filePath = path.join(__dirname, 'public',
    pathname === '/' ? 'index.html' : pathname);
  const ext = path.extname(filePath);
  if (!ext) filePath += '.html';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      fs.readFile(path.join(__dirname, 'public', 'index.html'), (err2, data2) => {
        if (err2) { res.writeHead(404); res.end('Not found'); return; }
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(data2);
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain' });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`Wiserr server on port ${PORT}`);
  console.log(`Codes: ${ACCESS_CODES.length} active`);
});
