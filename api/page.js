const { readFileSync } = require('fs');
const { join } = require('path');
const { getSession } = require('./_lib/auth');

module.exports = async (req, res) => {
  const skipAuth = process.env.SKIP_AUTH === '1' || !process.env.RESEND_API_KEY;
  const session = skipAuth ? { email: 'anonymous@localhost' } : await getSession(req);

  if (!session) {
    res.writeHead(302, { Location: '/' });
    res.end();
    return;
  }

  const html = readFileSync(join(process.cwd(), 'content', 'page.html'), 'utf8');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(html);
};
