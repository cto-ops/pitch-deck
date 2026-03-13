#!/usr/bin/env node
/**
 * Standalone Express server for the pitch deck.
 * Replaces Vercel serverless functions — runs everything from a single process.
 *
 * All existing handlers in api/ are Vercel-style (req, res) => {} functions.
 * They're Express-compatible as-is — we just mount them on the right paths.
 *
 * Usage:
 *   node sqlite-init.js          # first time only
 *   node server.js               # starts on PORT (default 3334)
 *
 * Environment variables (all optional):
 *   PORT              — listen port (default 3334)
 *   SITE_URL          — public URL (default http://localhost:3334)
 *   ADMIN_PASSWORD    — admin dashboard password
 *   RESEND_API_KEY    — Resend email API key (magic links)
 *   RESEND_FROM       — email sender address
 *   SQLITE_PATH       — database file (default data/pitch-deck.db)
 *   SKIP_AUTH         — set to "1" to bypass auth (dev mode)
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const { closeDb } = require('./api/_lib/db');

const app = express();
const PORT = parseInt(process.env.PORT, 10) || 3334;

// ---------------------------------------------------------------------------
// SSE live-reload (ported from dev-server.js)
// ---------------------------------------------------------------------------
const sseClients = new Set();

function broadcastReload() {
  for (const res of sseClients) {
    res.write('event: reload\ndata: ok\n\n');
  }
}

app.get('/__reload', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write(':ok\n\n');
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

// ---------------------------------------------------------------------------
// File watcher → rebuild → reload (same as dev-server.js)
// ---------------------------------------------------------------------------
const { execSync } = require('child_process');
let buildTimer = null;

function rebuild() {
  try {
    execSync('node build.js', { cwd: __dirname, stdio: 'pipe' });
    console.log(`[${ts()}] Rebuilt all decks`);
    broadcastReload();
  } catch (e) {
    console.error(`[${ts()}] Build error:`, e.stderr?.toString().trim());
  }
}

function ts() { return new Date().toLocaleTimeString(); }

function onSourceChange(dir) {
  return (_event, filename) => {
    if (!filename) return;
    clearTimeout(buildTimer);
    buildTimer = setTimeout(() => {
      console.log(`[${ts()}] Changed: ${path.join(dir, filename)}`);
      rebuild();
    }, 150);
  };
}

const contentDir = path.join(__dirname, 'content');
try {
  fs.watch(path.join(contentDir, 'slides'), onSourceChange('slides'));
  fs.watch(path.join(contentDir, 'decks'), onSourceChange('decks'));
  fs.watch(contentDir, (_event, filename) => {
    if (filename && /^(head|tail).*\.html$/.test(filename)) {
      clearTimeout(buildTimer);
      buildTimer = setTimeout(() => {
        console.log(`[${ts()}] Changed: ${filename}`);
        rebuild();
      }, 150);
    }
  });
} catch (e) {
  // Non-fatal: watcher might fail if dirs don't exist yet
  console.warn('File watcher warning:', e.message);
}

// ---------------------------------------------------------------------------
// Security headers (from vercel.json)
// ---------------------------------------------------------------------------
app.use((req, res, next) => {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
  res.setHeader('X-Frame-Options', 'DENY');
  if (req.path.startsWith('/api/')) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  }
  next();
});

// ---------------------------------------------------------------------------
// Static files from public/
// ---------------------------------------------------------------------------
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// Helper: wrap a Vercel handler so Express catches async errors
// ---------------------------------------------------------------------------
function mount(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res)).catch(err => {
      console.error('Handler error:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Internal server error' });
      }
    });
  };
}

// ---------------------------------------------------------------------------
// API routes — each file exports (req, res) => {}
// ---------------------------------------------------------------------------

// Auth / session
app.all('/api/login',   mount(require('./api/login')));
app.all('/api/verify',  mount(require('./api/verify')));
app.all('/api/logout',  mount(require('./api/logout')));
app.all('/api/join',    mount(require('./api/join')));
app.all('/api/track',   mount(require('./api/track')));

// Admin dashboard (serves HTML on GET, handles auth on POST)
app.all('/api/admin',   mount(require('./api/admin')));

// Admin management endpoints
app.all('/api/admin/admins',                mount(require('./api/admin/admins')));
app.all('/api/admin/rules',                 mount(require('./api/admin/rules')));
app.all('/api/admin/settings',              mount(require('./api/admin/settings')));
app.all('/api/admin/sessions',              mount(require('./api/admin/sessions')));
app.all('/api/admin/session',               mount(require('./api/admin/session')));
app.all('/api/admin/stats',                 mount(require('./api/admin/stats')));
app.all('/api/admin/views',                 mount(require('./api/admin/views')));
app.all('/api/admin/data-room-access',      mount(require('./api/admin/data-room-access')));
app.all('/api/admin/data-room-files',       mount(require('./api/admin/data-room-files')));
app.all('/api/admin/data-room-upload',      mount(require('./api/admin/data-room-upload')));
app.all('/api/admin/data-room-downloads',   mount(require('./api/admin/data-room-downloads')));
app.all('/api/admin/data-room-page-views',  mount(require('./api/admin/data-room-page-views')));
app.all('/api/admin/invite-links',          mount(require('./api/admin/invite-links')));

// Data room viewer endpoints
app.all('/api/data',            mount(require('./api/data')));
app.all('/api/data/download',   mount(require('./api/data/download')));
app.all('/api/data/files',      mount(require('./api/data/files')));
app.all('/api/data/track-page', mount(require('./api/data/track-page')));
app.all('/api/data/pages',      mount(require('./api/data/pages')));

// ---------------------------------------------------------------------------
// Page-level rewrites (from vercel.json)
// ---------------------------------------------------------------------------

// Data room pages: /data/pages/foo → api/data/pages.js?path=foo
app.all('/data/pages/*', (req, res, next) => {
  const pagePath = req.params[0] || '';
  req.url = `/api/data/pages?path=${encodeURIComponent(pagePath)}`;
  mount(require('./api/data/pages'))(req, res, next);
});

// /admin → admin dashboard
app.all('/admin', mount(require('./api/admin')));

// /data → data room
app.all('/data', mount(require('./api/data')));

// Serve the deck (with live-reload snippet injection)
const RELOAD_SNIPPET = `<script>new EventSource("/__reload").addEventListener("reload",()=>location.reload())</script>`;

app.get('/', (req, res) => {
  // Dev mode: skip auth (must be explicitly enabled)
  const skipAuth = process.env.SKIP_AUTH === '1';

  if (skipAuth) {
    const htmlPath = path.join(contentDir, 'page.html');
    if (!fs.existsSync(htmlPath)) {
      res.status(404).send('Deck not built yet. Run: node build.js');
      return;
    }
    let html = fs.readFileSync(htmlPath, 'utf8');
    html = html.replace('</body>', RELOAD_SNIPPET + '</body>');
    res.type('html').send(html);
    return;
  }

  // Auth mode: delegate to page.js handler
  mount(require('./api/page'))(req, res, () => {});
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`\nPitch deck server running at http://localhost:${PORT}`);
  console.log(`Auth: ${process.env.SKIP_AUTH === '1' ? 'DISABLED (dev mode)' : 'enabled'}`);
  console.log(`Database: ${process.env.SQLITE_PATH || 'data/pitch-deck.db'}`);
  console.log(`Watching: content/slides/, content/decks/, content/head.html, content/tail*.html\n`);
});

// Graceful shutdown
function shutdown() {
  console.log('\nShutting down...');
  server.close(() => {
    closeDb();
    process.exit(0);
  });
  // Force exit after 5s
  setTimeout(() => process.exit(1), 5000);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
