// Accounts, sessions, and single-use invites.
//
// Design notes:
//  · Passwords are hashed with scrypt (built into Node — no native build
//    step, no dependency to keep patched). Each hash carries its own salt.
//  · Sessions live in Postgres. The cookie holds a random id and nothing
//    else, so it leaks no information and can be revoked instantly.
//  · Invite tokens are stored only as a SHA-256 hash. A database leak
//    cannot be turned back into working invite links.
//  · An invite is spent the moment it is redeemed — inside the same
//    transaction that creates the account, so two people racing the same
//    link cannot both get in.

const crypto = require('crypto');
const db = require('./db');

const SESSION_COOKIE = 'kudzu_sid';
const SESSION_DAYS = 30;
const INVITE_DAYS = 14;

// ── Passwords ────────────────────────────────────────────────────────
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${salt.toString('base64')}$${key.toString('base64')}`;
}

function verifyPassword(password, stored) {
  try {
    const [scheme, N, r, p, salt, key] = String(stored).split('$');
    if (scheme !== 'scrypt') return false;
    const expected = Buffer.from(key, 'base64');
    const actual = crypto.scryptSync(password, Buffer.from(salt, 'base64'),
      expected.length, { N: +N, r: +r, p: +p });
    return crypto.timingSafeEqual(expected, actual);
  } catch (err) {
    return false;
  }
}

// ── Sessions ─────────────────────────────────────────────────────────
async function createSession(res, artistId, { remember = true } = {}) {
  const id = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5);
  await db.query(
    'INSERT INTO sessions (id, artist_id, expires_at) VALUES ($1,$2,$3)',
    [id, artistId, expires]
  );
  const cookieOpts = {
    httpOnly: true,                                  // JavaScript cannot read it
    secure: process.env.NODE_ENV === 'production',   // HTTPS only in production
    sameSite: 'lax',                                 // blocks cross-site sends
    path: '/'
  };
  // "Remember me" → persistent cookie that survives browser restarts.
  // Without it → session cookie (expires when the browser closes).
  if (remember) cookieOpts.expires = expires;
  res.cookie(SESSION_COOKIE, id, cookieOpts);
  return id;
}

async function destroySession(req, res) {
  const sid = req.cookies && req.cookies[SESSION_COOKIE];
  if (sid) await db.query('DELETE FROM sessions WHERE id = $1', [sid]).catch(() => {});
  res.clearCookie(SESSION_COOKIE, { path: '/' });
}

// Attaches req.artist when a valid session cookie is present. Never throws.
async function attachArtist(req, _res, next) {
  req.artist = null;
  const sid = req.cookies && req.cookies[SESSION_COOKIE];
  if (!sid || !db.isReady()) return next();
  try {
    const { rows } = await db.query(
      `SELECT a.* FROM sessions s
         JOIN artists a ON a.id = s.artist_id
        WHERE s.id = $1 AND s.expires_at > now()`,
      [sid]
    );
    if (rows[0]) req.artist = rows[0];
  } catch (err) {
    console.error('session lookup failed:', err.message);
  }
  next();
}

function requireArtist(req, res, next) {
  if (!req.artist) return res.status(401).json({ error: 'not_signed_in' });
  next();
}

function requireAdmin(req, res, next) {
  if (!req.artist || !req.artist.is_admin) return res.status(403).json({ error: 'forbidden' });
  next();
}

// ── Invites ──────────────────────────────────────────────────────────
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

async function createInvite({ email, note, createdBy, days = INVITE_DAYS }) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + days * 864e5);
  const { rows } = await db.query(
    `INSERT INTO invites (token_hash, email, note, expires_at, created_by)
     VALUES ($1,$2,$3,$4,$5) RETURNING id, expires_at`,
    [sha256(token), email ? email.toLowerCase().trim() : null, note || null, expires, createdBy]
  );
  // The raw token is returned exactly once, here. It is never stored.
  return { token, id: rows[0].id, expiresAt: rows[0].expires_at };
}

async function readInvite(token) {
  if (!token) return { status: 'missing' };
  const { rows } = await db.query(
    'SELECT * FROM invites WHERE token_hash = $1', [sha256(token)]
  );
  const inv = rows[0];
  if (!inv) return { status: 'invalid' };
  if (inv.used_at) return { status: 'used' };
  if (new Date(inv.expires_at) < new Date()) return { status: 'expired' };
  return { status: 'ok', invite: inv };
}

function slugify(name) {
  return String(name).toLowerCase().trim()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'artist';
}

async function uniqueSlug(client, base) {
  let slug = base, n = 1;
  /* eslint-disable no-await-in-loop */
  while (true) {
    const { rows } = await client.query('SELECT 1 FROM artists WHERE slug = $1', [slug]);
    if (!rows[0]) return slug;
    slug = `${base}-${++n}`;
  }
}

// Redeem an invite and create the account. One transaction: if anything
// fails, the invite stays unspent.
async function redeemInvite({ token, name, email, password, identity }) {
  return db.tx(async (client) => {
    const { rows: ir } = await client.query(
      'SELECT * FROM invites WHERE token_hash = $1 FOR UPDATE', [sha256(token)]
    );
    const inv = ir[0];
    if (!inv) throw Object.assign(new Error('invalid'), { code: 'INVITE_INVALID' });
    if (inv.used_at) throw Object.assign(new Error('used'), { code: 'INVITE_USED' });
    if (new Date(inv.expires_at) < new Date()) {
      throw Object.assign(new Error('expired'), { code: 'INVITE_EXPIRED' });
    }

    const addr = (email || inv.email || '').toLowerCase().trim();
    if (!addr) throw Object.assign(new Error('email required'), { code: 'EMAIL_REQUIRED' });
    // If the invite was addressed to someone, only they can spend it.
    if (inv.email && inv.email !== addr) {
      throw Object.assign(new Error('wrong email'), { code: 'INVITE_EMAIL_MISMATCH' });
    }

    const { rows: dupe } = await client.query('SELECT 1 FROM artists WHERE email = $1', [addr]);
    if (dupe[0]) throw Object.assign(new Error('exists'), { code: 'EMAIL_TAKEN' });

    const slug = await uniqueSlug(client, slugify(name));

    // The very first account on an empty install becomes the admin —
    // otherwise nobody could ever issue invites.
    const { rows: countRows } = await client.query('SELECT count(*)::int AS n FROM artists');
    const isFirst = countRows[0].n === 0;

    const { rows: ar } = await client.query(
      `INSERT INTO artists (email, password_hash, name, slug, is_admin)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [addr, password ? hashPassword(password) : '', name, slug, isFirst]
    );
    const artist = ar[0];

    if (identity) {
      await client.query(
        `INSERT INTO identities (artist_id, provider, subject, email)
         VALUES ($1,$2,$3,$4) ON CONFLICT (provider, subject) DO NOTHING`,
        [artist.id, identity.provider, identity.subject, identity.email || addr]
      );
    }

    await client.query(
      'UPDATE invites SET used_at = now(), used_by = $1 WHERE id = $2',
      [artist.id, inv.id]
    );

    return artist;
  });
}

// ── Password login ───────────────────────────────────────────────────
async function login(email, password) {
  const { rows } = await db.query(
    'SELECT * FROM artists WHERE email = $1', [String(email || '').toLowerCase().trim()]
  );
  const artist = rows[0];
  // Hash regardless of whether the account exists, so response timing
  // does not reveal which emails are registered.
  const ok = artist && artist.password_hash
    ? verifyPassword(password, artist.password_hash)
    : verifyPassword(password, hashPassword('decoy'));
  return ok && artist ? artist : null;
}

module.exports = {
  SESSION_COOKIE,
  hashPassword, verifyPassword,
  createSession, destroySession, attachArtist, requireArtist, requireAdmin,
  createInvite, readInvite, redeemInvite,
  login, slugify
};
