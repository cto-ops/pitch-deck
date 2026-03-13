/**
 * SQLite-backed drop-in replacement for @vercel/postgres `sql` tagged template.
 *
 * Uses sql.js (pure JavaScript SQLite via Emscripten — no native compilation needed).
 * Provides the same interface: await sql`SELECT ... WHERE col = ${val}` → { rows: [...] }
 * Handles Postgres → SQLite syntax translation for the patterns used in this codebase.
 *
 * Original Vercel version preserved at db-vercel.js.
 */

const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const DB_PATH = process.env.SQLITE_PATH || path.join(process.cwd(), 'data', 'pitch-deck.db');

let _db = null;
let _initPromise = null;

function ensureDir() {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

async function initDb() {
  if (_db) return _db;
  if (_initPromise) return _initPromise;

  _initPromise = (async () => {
    const SQL = await initSqlJs();
    ensureDir();

    if (fs.existsSync(DB_PATH)) {
      const fileBuffer = fs.readFileSync(DB_PATH);
      _db = new SQL.Database(fileBuffer);
    } else {
      _db = new SQL.Database();
    }

    _db.run('PRAGMA foreign_keys = ON');

    // Register custom functions for Postgres compatibility
    _db.create_function('encode', (blob, format) => {
      if (blob === null || blob === undefined) return null;
      if (format === 'base64') {
        if (blob instanceof Uint8Array) return Buffer.from(blob).toString('base64');
        if (typeof blob === 'string') return Buffer.from(blob, 'binary').toString('base64');
        return String(blob);
      }
      return blob;
    });

    _db.create_function('decode', (text, format) => {
      if (text === null || text === undefined) return new Uint8Array(0);
      if (format === 'base64') {
        const buf = Buffer.from(text, 'base64');
        return new Uint8Array(buf.buffer, buf.byteOffset, buf.length);
      }
      const buf = Buffer.from(text);
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.length);
    });

    return _db;
  })();

  return _initPromise;
}

// Debounced save to disk after writes
let _saveTimer = null;
function scheduleSave() {
  if (_saveTimer) return;
  _saveTimer = setTimeout(() => {
    _saveTimer = null;
    if (_db) {
      try {
        const data = _db.export();
        ensureDir();
        fs.writeFileSync(DB_PATH, Buffer.from(data));
      } catch (e) {
        console.error('DB save error:', e.message);
      }
    }
  }, 500);
}

/**
 * Translate Postgres SQL patterns to SQLite equivalents.
 */
function translateSql(query) {
  let q = query;

  // NOW() → datetime('now')
  q = q.replace(/\bNOW\(\)/gi, "datetime('now')");

  // datetime('now') - INTERVAL 'N unit' → datetime('now', '-N unit')
  q = q.replace(
    /datetime\('now'\)\s*-\s*INTERVAL\s*'(\d+)\s+(second|seconds|minute|minutes|hour|hours|day|days|month|months|year|years)'/gi,
    (_, n, unit) => `datetime('now', '-${n} ${unit}')`
  );

  // ''::bytea → X'' (empty blob)
  q = q.replace(/''::bytea/g, "X''");

  // COUNT(...)::int → CAST(COUNT(...) AS INTEGER)
  q = q.replace(/COUNT\(([^)]*)\)::int/gi, 'CAST(COUNT($1) AS INTEGER)');

  // ILIKE → LIKE
  q = q.replace(/\bILIKE\b/gi, 'LIKE');

  return q;
}

/**
 * Convert sql.js result format to row objects.
 * sql.js returns: [{ columns: ['a', 'b'], values: [[1, 2], [3, 4]] }]
 * We need: [{ a: 1, b: 2 }, { a: 3, b: 4 }]
 */
function toRows(results) {
  if (!results || results.length === 0) return [];
  const { columns, values } = results[0];
  return values.map(row => {
    const obj = {};
    columns.forEach((col, i) => {
      // Convert Uint8Array (BLOB) to Buffer for Node.js compat
      if (row[i] instanceof Uint8Array) {
        obj[col] = Buffer.from(row[i]);
      } else {
        obj[col] = row[i];
      }
    });
    return obj;
  });
}

/**
 * Tagged template literal that mimics @vercel/postgres `sql`.
 * Usage: await sql`SELECT * FROM users WHERE email = ${email}`
 * Returns: { rows: [...], rowCount: N }
 *
 * NOTE: Unlike @vercel/postgres, this returns a Promise. All existing handlers
 * already `await` their sql calls, so this is transparent.
 */
async function sql(strings, ...values) {
  const db = await initDb();

  // Build query with ? placeholders
  let query = strings[0];
  for (let i = 0; i < values.length; i++) {
    query += '?' + (strings[i + 1] || '');
  }

  query = translateSql(query);

  // Convert values: undefined/null → null, Date → ISO string, Buffer → Uint8Array
  const params = values.map(v => {
    if (v === undefined || v === null) return null;
    if (v instanceof Date) return v.toISOString();
    if (Buffer.isBuffer(v)) return new Uint8Array(v.buffer, v.byteOffset, v.length);
    return v;
  });

  const trimmed = query.trimStart().toUpperCase();
  const isSelect = trimmed.startsWith('SELECT');
  const hasReturning = /\bRETURNING\b/i.test(query);

  try {
    if (isSelect || hasReturning) {
      const results = db.exec(query, params);
      const rows = toRows(results);
      if (!isSelect) scheduleSave();
      return { rows, rowCount: rows.length };
    }

    // Write query without RETURNING
    db.run(query, params);
    const changes = db.getRowsModified();
    scheduleSave();
    return { rows: [], rowCount: changes };
  } catch (err) {
    // Map SQLite constraint errors to Postgres-like error codes
    if (err.message && err.message.includes('UNIQUE constraint failed')) {
      err.code = '23505';
    }
    throw err;
  }
}

/**
 * Get the raw database instance (for schema init).
 */
async function getDb() {
  return initDb();
}

/**
 * Force save and close the database.
 */
function closeDb() {
  if (_saveTimer) {
    clearTimeout(_saveTimer);
    _saveTimer = null;
  }
  if (_db) {
    try {
      const data = _db.export();
      ensureDir();
      fs.writeFileSync(DB_PATH, Buffer.from(data));
    } catch (e) {
      console.error('DB close/save error:', e.message);
    }
    _db.close();
    _db = null;
    _initPromise = null;
  }
}

module.exports = { sql, getDb, closeDb };
