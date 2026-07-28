// Kudzu Arts — static site + artist account API.
//
// The site works with or without a database. Without DATABASE_URL it
// serves pages exactly as before and the account API reports itself
// unavailable, which the profile page handles by falling back to a
// local demo. Add Postgres and everything switches on.

const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('path');
const fs = require('fs');

const db = require('./server/db');
const auth = require('./server/auth');
const oauth = require('./server/oauth');
const api = require('./server/api');
const storage = require('./server/storage');

const app = express();
const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');

// Railway terminates TLS upstream; trust it so req.protocol is https
// and `secure` cookies actually get set in production.
app.set('trust proxy', 1);
app.disable('x-powered-by');

// ── Baseline security headers ────────────────────────────────────────
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

app.use(cookieParser());
app.use(express.json({ limit: '256kb' }));
app.use(express.urlencoded({ extended: false, limit: '256kb' }));

// Attaches req.artist when a valid session cookie is present.
app.use(auth.attachArtist);

// ── Uploaded images ──────────────────────────────────────────────────
// Served straight off the volume. Long cache: filenames are unique per
// upload, so a changed image is always a new URL.
app.use('/uploads', express.static(storage.UPLOAD_DIR, {
  maxAge: '30d',
  immutable: true,
  index: false,
  dotfiles: 'deny'
}));

// ── API ──────────────────────────────────────────────────────────────
app.use('/api', oauth.router);
app.use('/api', api);

// ── Pages ────────────────────────────────────────────────────────────
// Pretty URLs: /about → public/about.html
app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  if (req.path === '/' || path.extname(req.path)) return next();
  const candidate = path.join(PUBLIC, req.path + '.html');
  if (candidate.startsWith(PUBLIC) && fs.existsSync(candidate)) {
    return res.sendFile(candidate);
  }
  next();
});

app.use(express.static(PUBLIC, { extensions: ['html'], index: 'index.html' }));

app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'not_found' });
  const four04 = path.join(PUBLIC, '404.html');
  if (fs.existsSync(four04)) return res.status(404).sendFile(four04);
  res.status(404).send('Not found.');
});

// Last-resort handler: never leak a stack trace to the browser.
app.use((err, _req, res, _next) => {
  console.error('unhandled:', err && err.stack ? err.stack : err);
  res.status(500).json({ error: 'server_error' });
});

// ── Boot ─────────────────────────────────────────────────────────────
(async function start() {
  try {
    await db.migrate();
  } catch (err) {
    // A database problem should not take the public site down.
    console.error('database setup failed — accounts disabled:', err.message);
  }

  setInterval(() => db.sweep(), 60 * 60 * 1000).unref();

  app.listen(PORT, () => {
    console.log(`kudzu · listening on http://localhost:${PORT}`);
    if (!db.isConfigured()) console.log('kudzu · accounts off (no DATABASE_URL)');
    if (!oauth.isConfigured('google')) console.log('kudzu · Google sign-in off (no GOOGLE_CLIENT_ID)');
  });
})();
