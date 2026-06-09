// Lokaler Dev-Server: statische Dateien + Netlify Functions
// Starten: node server.js
// Öffnen:  http://localhost:3000

import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3001;

// Netlify Functions als ES-Module importieren
const { handler: pegelHandler } = await import('./netlify/functions/pegel.js');
const { handler: dwdHandler }   = await import('./netlify/functions/dwd.js');
const { handler: nizHandler }   = await import('./netlify/functions/niz.js');

const MIME = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
  '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml', '.woff2': 'font/woff2',
};

function netlifyEvent(req, url) {
  return {
    httpMethod: req.method,
    path: url.pathname,
    queryStringParameters: Object.fromEntries(url.searchParams),
    headers: req.headers,
    body: null,
  };
}

function sendResult(res, result) {
  res.writeHead(result.statusCode, result.headers || { 'Content-Type': 'application/json' });
  res.end(result.body);
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;

  // ── Proxy-Routen ──────────────────────────────────────────────────────────
  if (p === '/.netlify/functions/pegel' || p === '/api/pegel') {
    try { sendResult(res, await pegelHandler(netlifyEvent(req, url))); }
    catch(e) { res.writeHead(500); res.end(JSON.stringify({ ok: false, error: e.message })); }
    return;
  }
  if (p === '/.netlify/functions/dwd' || p === '/api/dwd') {
    try { sendResult(res, await dwdHandler(netlifyEvent(req, url))); }
    catch(e) { res.writeHead(500); res.end(JSON.stringify({ ok: false, error: e.message })); }
    return;
  }
  if (p === '/.netlify/functions/niz' || p === '/api/niz') {
    try { sendResult(res, await nizHandler(netlifyEvent(req, url))); }
    catch(e) { res.writeHead(500); res.end(JSON.stringify({ ok: false, error: e.message })); }
    return;
  }

  // ── Statische Dateien ─────────────────────────────────────────────────────
  let filePath = path.join(__dirname, p === '/' ? 'index.html' : p);
  if (!fs.existsSync(filePath)) filePath = path.join(__dirname, 'index.html'); // SPA-Fallback

  const ext = path.extname(filePath);
  const mime = MIME[ext] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': mime });
  fs.createReadStream(filePath).pipe(res);

}).listen(PORT, () => {
  console.log(`\n✅  http://localhost:${PORT}\n`);
}).on('error', e => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\n❌  Port ${PORT} belegt. Anderer Prozess beenden oder PORT setzen:\n    PORT=3002 node server.js\n`);
    process.exit(1);
  }
  throw e;
});
