const { randomBytes } = require('crypto');
const { sql } = require('./_lib/db');
const { isAdmin } = require('./_lib/admin-auth');

// Escape HTML to prevent XSS in hidden form fields
function esc(s) { return (s || '').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

// Landing page shown on GET — scanner-safe (token is NOT consumed until POST)
function renderLanding(token, next, invite) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex, nofollow">
<title>HealthyBuddy.AI — Verify</title>
<style>
  @font-face { font-family: 'Inter'; src: url('/fonts/Inter-Regular.woff2') format('woff2'); font-weight: 400; }
  @font-face { font-family: 'JetBrains Mono'; src: url('/fonts/JetBrainsMono-Latin.woff2') format('woff2'); font-weight: 300; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: #082A3C;
    color: #ECEEE2;
    font-family: 'Inter', sans-serif;
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 100vh;
  }
  .box { width: 100%; max-width: 360px; padding: 0 24px; text-align: center; }
  .wordmark {
    display: block;
    margin: 0 auto 48px;
    font-family: 'Inter', sans-serif;
    font-weight: 700;
    font-size: 36px;
    letter-spacing: 0.1em;
    color: #3BB573;
    opacity: 0.6;
  }
  h2 { font-size: 18px; font-weight: 400; margin-bottom: 12px; }
  p { font-size: 14px; color: rgba(236,238,226,0.5); line-height: 1.6; margin-bottom: 24px; }
  button {
    width: 100%;
    padding: 14px;
    background: rgba(59,181,115,0.12);
    border: 1px solid rgba(59,181,115,0.3);
    border-radius: 6px;
    color: #3BB573;
    font-family: 'JetBrains Mono', monospace;
    font-size: 12px;
    letter-spacing: 1.5px;
    text-transform: uppercase;
    cursor: pointer;
    transition: background 0.2s, border-color 0.2s;
  }
  button:hover { background: rgba(59,181,115,0.2); border-color: rgba(59,181,115,0.5); }
</style>
</head>
<body>
<div class="box">
  <div class="wordmark">HealthyBuddy.AI</div>
  <h2>Open your deck</h2>
  <p>Click below to continue to the pitch deck.</p>
  <form method="POST" action="/api/verify">
    <input type="hidden" name="token" value="${esc(token)}">
    <input type="hidden" name="next" value="${esc(next)}">
    <input type="hidden" name="invite" value="${esc(invite)}">
    <button type="submit">Continue to deck</button>
  </form>
</div>
</body>
</html>`;
}

module.exports = async (req, res) => {
  // --- GET: show landing page (scanner-safe, does NOT consume token) ---
  if (req.method === 'GET') {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const token = url.searchParams.get('token');
    const next = url.searchParams.get('next') || '';
    const invite = url.searchParams.get('invite') || '';

    if (!token) {
      res.writeHead(302, { Location: '/login.html' });
      res.end();
      return;
    }

    try {
      // Check token is valid (but do NOT consume it)
      const { rows } = await sql`
        SELECT id FROM magic_tokens
        WHERE token = ${token} AND used_at IS NULL AND expires_at > NOW()
      `;

      if (rows.length === 0) {
        res.writeHead(302, { Location: '/login.html?expired=1' });
        res.end();
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderLanding(token, next, invite));
    } catch (e) {
      console.error('Verify GET error:', e);
      res.writeHead(302, { Location: '/login.html' });
      res.end();
    }
    return;
  }

  // --- POST: consume token and create session ---
  if (req.method !== 'POST') {
    res.writeHead(405);
    res.end('Method not allowed');
    return;
  }

  try {
    // Parse URL-encoded form body
    let body;
    if (req.body) {
      body = typeof req.body === 'string' ? req.body : String(req.body);
    } else {
      body = await new Promise((resolve, reject) => {
        let buf = '';
        req.on('data', chunk => {
          buf += chunk;
          if (buf.length > 4096) reject(new Error('Body too large'));
        });
        req.on('end', () => resolve(buf));
      });
    }

    const params = new URLSearchParams(body);
    const token = params.get('token');
    const next = params.get('next') || '';
    const inviteCode = params.get('invite') || '';

    if (!token) {
      res.writeHead(302, { Location: '/login.html' });
      res.end();
      return;
    }

    // Atomically find and consume valid, unused, non-expired token (prevents TOCTOU race)
    const { rows } = await sql`
      UPDATE magic_tokens
      SET used_at = NOW()
      WHERE token = ${token} AND used_at IS NULL AND expires_at > NOW()
      RETURNING id, email
    `;

    if (rows.length === 0) {
      res.writeHead(302, { Location: '/login.html?expired=1' });
      res.end();
      return;
    }

    const { email } = rows[0];

    // Create session
    const sessionId = randomBytes(32).toString('hex');
    const rawIp = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim();
    const ip = rawIp.substring(0, 45); // Max IPv6 length
    const userAgent = (req.headers['user-agent'] || '').substring(0, 512);

    await sql`
      INSERT INTO sessions (id, email, ip, user_agent)
      VALUES (${sessionId}, ${email}, ${ip}, ${userAgent})
    `;

    // If this verification came from an invite link, auto-grant data room access + allow rule
    if (inviteCode) {
      const { rows: links } = await sql`
        SELECT id, view_id, grant_dr FROM invite_links
        WHERE code = ${inviteCode}
          AND (expires_at IS NULL OR expires_at > NOW())
          AND (max_uses IS NULL OR use_count <= max_uses)
      `;
      if (links.length > 0) {
        const link = links[0];
        if (link.grant_dr !== false) {
          await sql`
            INSERT INTO data_room_access (email, granted_by, view_id)
            VALUES (${email}, ${'invite'}, ${link.view_id})
            ON CONFLICT (email) DO NOTHING
          `;
        }
        const { rows: existing } = await sql`
          SELECT id FROM email_rules
          WHERE LOWER(pattern) = ${email} AND rule_type = 'allow'
        `;
        if (existing.length === 0) {
          await sql`
            INSERT INTO email_rules (pattern, rule_type)
            VALUES (${email}, ${'allow'})
          `;
        }
      }
    }

    // Set session cookie (7 day expiry)
    const cookies = [
      `site-auth=${sessionId}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800`
    ];

    // Redirect to original page, or /admin for admin logins, or / by default
    let redirect = '/';
    if (next === 'admin' && await isAdmin(email)) {
      redirect = '/admin';
    } else if (next) {
      // Only allow relative paths — reject anything that could redirect externally
      try {
        const parsed = new URL(next, 'http://localhost');
        if (parsed.hostname === 'localhost' && next.startsWith('/')) {
          redirect = next;
        }
      } catch {
        // Invalid URL — ignore
      }
    }

    res.setHeader('Set-Cookie', cookies);
    res.writeHead(302, { Location: redirect });
    res.end();
  } catch (e) {
    if (e.message === 'Body too large') {
      res.writeHead(413);
      res.end('Request too large');
      return;
    }
    console.error('Verify POST error:', e);
    res.writeHead(302, { Location: '/login.html' });
    res.end();
  }
};
