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
const commerce = require('./server/commerce');
const lumaprints = require('./server/lumaprints');

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

// The Stripe webhook must see the raw, unparsed body — Stripe signs the
// exact bytes, so this has to be registered before express.json().
app.post('/api/webhooks/stripe',
  express.raw({ type: 'application/json' }),
  commerce.webhookHandler);

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
app.use('/api', commerce.router);
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

// ── First-run bootstrap ──────────────────────────────────────────────
// When the artists table is empty there is no way in — no account exists
// to create an invite. So on an empty database the server mints one
// admin invite and prints it to the deploy logs. Whoever can read the
// logs already controls the deployment, so this grants nothing new.
//
// It runs only while the table is empty. Once the first account exists
// it never fires again, and the invite is single-use like any other.
async function bootstrapFirstAdmin() {
  if (!db.isReady()) return;
  try {
    const { rows } = await db.query('SELECT count(*)::int AS n FROM artists');
    if (rows[0].n > 0) return;

    const inv = await auth.createInvite({
      note: 'First admin', createdBy: null, days: 2
    });
    await db.query(
      `UPDATE invites SET note = 'First admin (grants admin rights)' WHERE id = $1`,
      [inv.id]
    );

    const base = process.env.PUBLIC_BASE_URL || 'http://localhost:' + PORT;
    console.log('');
    console.log('  ┌─────────────────────────────────────────────────────');
    console.log('  │  No accounts yet. Open this link to create the first');
    console.log('  │  admin. It works once and expires in 48 hours.');
    console.log('  │');
    console.log(`  │  ${base}/workinprogress/signup.html?invite=${inv.token}`);
    console.log('  └─────────────────────────────────────────────────────');
    console.log('');
  } catch (err) {
    console.error('bootstrap failed:', err.message);
  }
}


// ── Boot ─────────────────────────────────────────────────────────────
(async function start() {
  try {
    await db.migrate();
  } catch (err) {
    // A database problem should not take the public site down.
    console.error('database setup failed — accounts disabled:', err.message);
  }

  await bootstrapFirstAdmin();

  setInterval(() => db.sweep(), 60 * 60 * 1000).unref();

  app.listen(PORT, () => {
    console.log(`kudzu · listening on http://localhost:${PORT}`);
    if (!db.isConfigured()) console.log('kudzu · accounts off (no DATABASE_URL)');
    if (!oauth.isConfigured('google')) console.log('kudzu · Google sign-in off (no GOOGLE_CLIENT_ID)');
    if (!commerce.isConfigured()) console.log('kudzu · selling off (no STRIPE_SECRET_KEY)');
    if (!lumaprints.isConfigured()) console.log('kudzu · print fulfilment off (no Lumaprints keys)');
  });
})();
