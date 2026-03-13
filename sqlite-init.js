#!/usr/bin/env node
/**
 * Initialize the SQLite database with the full schema.
 * Equivalent to running all Postgres migrations, translated to SQLite.
 *
 * Usage: node sqlite-init.js [--admin you@example.com]
 */

const { getDb, closeDb } = require('./api/_lib/db');

const SCHEMA = `
-- Magic link tokens
CREATE TABLE IF NOT EXISTS magic_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_magic_tokens_token ON magic_tokens (token);
CREATE INDEX IF NOT EXISTS idx_magic_tokens_email ON magic_tokens (email);

-- Viewer sessions
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  ip TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sessions_email ON sessions (email);
CREATE INDEX IF NOT EXISTS idx_sessions_created_at ON sessions (created_at DESC);

-- Slide view + heartbeat events
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  slide_index INTEGER NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('view', 'heartbeat')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_events_session_id ON events (session_id);
CREATE INDEX IF NOT EXISTS idx_events_created_at ON events (created_at DESC);

-- Email allowlist/blocklist
CREATE TABLE IF NOT EXISTS email_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pattern TEXT NOT NULL,
  rule_type TEXT NOT NULL CHECK (rule_type IN ('allow', 'block')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- KV settings
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT OR IGNORE INTO settings (key, value) VALUES ('access_mode', 'whitelist_only');

-- Admin users
CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_admins_email ON admins (email);

-- Admin sessions
CREATE TABLE IF NOT EXISTS admin_sessions (
  id TEXT PRIMARY KEY,
  email TEXT,
  ip TEXT,
  user_agent TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_admin_sessions_expires ON admin_sessions (expires_at);

-- Admin login rate limiting
CREATE TABLE IF NOT EXISTS admin_login_attempts (
  ip TEXT NOT NULL,
  attempted_at TEXT DEFAULT (datetime('now')),
  success INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_admin_attempts_ip_time ON admin_login_attempts (ip, attempted_at);

-- Data room: per-user access control
CREATE TABLE IF NOT EXISTS data_room_access (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  granted_by TEXT,
  view_id INTEGER,
  full_access INTEGER DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_data_room_access_email ON data_room_access (LOWER(email));

-- Data room: files (binary content stored as BLOB)
CREATE TABLE IF NOT EXISTS data_room_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  folder TEXT NOT NULL DEFAULT '/',
  content BLOB NOT NULL DEFAULT (X''),
  size_bytes INTEGER NOT NULL DEFAULT 0,
  mime_type TEXT,
  uploaded_by TEXT,
  type TEXT NOT NULL DEFAULT 'file',
  slug TEXT,
  page_id INTEGER REFERENCES data_room_files(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_data_room_files_folder ON data_room_files (folder);
CREATE UNIQUE INDEX IF NOT EXISTS idx_data_room_files_slug ON data_room_files (slug) WHERE slug IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_data_room_files_page_id ON data_room_files (page_id) WHERE page_id IS NOT NULL;

-- Data room: download tracking
CREATE TABLE IF NOT EXISTS data_room_downloads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id INTEGER REFERENCES data_room_files(id) ON DELETE SET NULL,
  file_name TEXT NOT NULL,
  session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  email TEXT NOT NULL,
  ip TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_data_room_downloads_email ON data_room_downloads (email);
CREATE INDEX IF NOT EXISTS idx_data_room_downloads_file ON data_room_downloads (file_id);
CREATE INDEX IF NOT EXISTS idx_data_room_downloads_created ON data_room_downloads (created_at DESC);

-- Data room: page view tracking
CREATE TABLE IF NOT EXISTS data_room_page_views (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT REFERENCES sessions(id),
  email TEXT,
  page_slug TEXT NOT NULL,
  event_type TEXT NOT NULL DEFAULT 'view',
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_dr_page_views_slug ON data_room_page_views (page_slug);
CREATE INDEX IF NOT EXISTS idx_dr_page_views_email ON data_room_page_views (email);
CREATE INDEX IF NOT EXISTS idx_dr_page_views_session ON data_room_page_views (session_id);

-- Views (scoped file collections for data room)
CREATE TABLE IF NOT EXISTS views (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- View to file mapping
CREATE TABLE IF NOT EXISTS view_files (
  view_id INTEGER NOT NULL REFERENCES views(id) ON DELETE CASCADE,
  file_id INTEGER NOT NULL REFERENCES data_room_files(id) ON DELETE CASCADE,
  PRIMARY KEY (view_id, file_id)
);

-- Invite links
CREATE TABLE IF NOT EXISTS invite_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  view_id INTEGER REFERENCES views(id) ON DELETE SET NULL,
  label TEXT,
  created_by TEXT,
  expires_at TEXT,
  max_uses INTEGER,
  use_count INTEGER NOT NULL DEFAULT 0,
  grant_dr INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_invite_links_code ON invite_links (code);
`;

async function init() {
  const db = await getDb();

  console.log('Initializing SQLite database...');

  // sql.js exec() runs multiple statements
  db.exec(SCHEMA);
  console.log('Schema created successfully.');

  // Handle --admin flag
  const adminIdx = process.argv.indexOf('--admin');
  if (adminIdx !== -1 && process.argv[adminIdx + 1]) {
    const email = process.argv[adminIdx + 1].toLowerCase().trim();
    db.run('INSERT OR IGNORE INTO admins (email) VALUES (?)', [email]);
    console.log(`Admin added: ${email}`);
  }

  // Show table counts
  const results = db.exec(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  );
  if (results.length > 0) {
    const tables = results[0].values.map(r => r[0]);
    console.log(`\nTables created: ${tables.length}`);
    for (const name of tables) {
      const countResult = db.exec(`SELECT COUNT(*) FROM "${name}"`);
      const cnt = countResult.length > 0 ? countResult[0].values[0][0] : 0;
      console.log(`  ${name}: ${cnt} rows`);
    }
  }

  closeDb();
  console.log('\nDone. Database at:', process.env.SQLITE_PATH || 'data/pitch-deck.db');
}

init().catch(err => {
  console.error('Init failed:', err);
  process.exit(1);
});
