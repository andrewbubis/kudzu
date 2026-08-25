// Sign in with Google (and Apple, when the developer account exists).
//
// The state parameter is a signed, self-validating HMAC token — no
// browser cookie needed for CSRF protection. This eliminates the
// first-attempt login failure that happened when the browser dropped
// the short-lived state cookie before the Google callback arrived.
//
// State format: nonce.timestamp.invite.HMAC
// The server verifies the HMAC on callback. No storage required.

const crypto = require('crypto');
const express = require('express');
const db      = require('./db');
const auth    = require('./auth');

const router = express.Router();
const REMEMBER_COOKIE = 'kudzu_remember';

const GOOGLE = {
  authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
  token:     'https://oauth2.googleapis.com/token',
  userinfo:  'https://openidconnect.googleapis.com/v1/userinfo',
  scope:     'openid email profile',
  id:     () => process.env.GOOGLE_CLIENT_ID,
  secret: () => process.env.GOOGLE_CLIENT_SECRET
};

function baseUrl(req) {
  return process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
}

function redirectUri(req, provider) {
  return `${baseUrl(req)}/api/auth/${provider}/callback`;
}

function isConfigured(provider) {
  if (provider === 'google') return !!(GOOGLE.id() && GOOGLE.secret());
  return false;
}

// ── Signed state ─────────────────────────────────────────────────────
// Uses GOOGLE_CLIENT_SECRET as the HMAC key — it's already a secret,
// already configured in Railway, and unique per deployment.
function hmacKey() {
  return process.env.GOOGLE_CLIENT_SECRET || 'kudzu-dev-state';
}

function makeState(invite) {
  const nonce   = crypto.randomBytes(16).toString('hex');
  const ts      = Math.floor(Date.now() / 1000).toString(36);
  // Sanitise invite: only alphanum + - _ so dots remain unambiguous delimiters
  const inv     = String(invite || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
  const payload = [nonce, ts, inv].join('.');
  const sig     = crypto.createHmac('sha256', hmacKey()).update(payload).digest('hex');
  return payload + '.' + sig;
}

function parseState(raw) {
  const s = String(raw || '');
  // Format: nonce.ts.inv.sig  (inv may be empty, so minimum 3 dots)
  const lastDot = s.lastIndexOf('.');
  if (lastDot < 1) return null;
  const payload  = s.slice(0, lastDot);
  const sig      = s.slice(lastDot + 1);
  const expected = crypto.createHmac('sha256', hmacKey()).update(payload).digest('hex');
  // Constant-time comparison
  if (sig.length !== expected.length) return null;
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'))) return null;
  } catch { return null; }
  const parts = payload.split('.');
  if (parts.length < 3) return null;
  const ts  = parseInt(parts[1], 36);
  const age = Math.floor(Date.now() / 1000) - ts;
  if (isNaN(age) || age < 0 || age > 600) return null; // must be within 10 minutes
  return { invite: parts[2] || '' };
}

// ── Start ────────────────────────────────────────────────────────────
router.get('/auth/:provider', (req, res) => {
  const provider = req.params.provider;
  if (provider === 'apple') {
    return res.redirect('/workinprogress/login.html?error=apple_unavailable');
  }
  if (provider !== 'google' || !isConfigured('google')) {
    return res.redirect('/workinprogress/login.html?error=oauth_unconfigured');
  }

  const invite = typeof req.query.invite === 'string' ? req.query.invite : '';
  const state  = makeState(invite);

  const url = new URL(GOOGLE.authorize);
  url.searchParams.set('client_id',      GOOGLE.id());
  url.searchParams.set('redirect_uri',   redirectUri(req, 'google'));
  url.searchParams.set('response_type',  'code');
  url.searchParams.set('scope',          GOOGLE.scope);
  url.searchParams.set('state',          state);
  url.searchParams.set('prompt',         'select_account');
  res.redirect(url.toString());
});

// ── Callback ─────────────────────────────────────────────────────────
router.get('/auth/:provider/callback', async (req, res) => {
  const provider = req.params.provider;
  const fail = (why) => res.redirect('/workinprogress/login.html?error=' + why);

  if (provider !== 'google' || !isConfigured('google')) return fail('oauth_unconfigured');
  if (!db.isReady()) return fail('backend_unavailable');

  // Always keep Google sign-ins persistent — artists use personal devices
  // and should stay signed in for the full session duration.
  const remember = true;
  res.clearCookie(REMEMBER_COOKIE, { path: '/' });

  const parsed = parseState(req.query.state);
  if (!parsed) return fail('bad_state');
  if (!req.query.code) return fail('no_code');

  try {
    const tokenRes = await fetch(GOOGLE.token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code:          String(req.query.code),
        client_id:     GOOGLE.id(),
        client_secret: GOOGLE.secret(),
        redirect_uri:  redirectUri(req, 'google'),
        grant_type:    'authorization_code'
      })
    });
    if (!tokenRes.ok) throw new Error('token_exchange_failed');
    const tokens = await tokenRes.json();

    const infoRes = await fetch(GOOGLE.userinfo, {
      headers: { Authorization: `Bearer ${tokens.access_token}` }
    });
    if (!infoRes.ok) throw new Error('userinfo_failed');
    const info = await infoRes.json();

    if (!info.sub) throw new Error('no_subject');
    if (!info.email_verified) return fail('email_unverified');

    const email = String(info.email || '').toLowerCase().trim();

    // 1. Known Google identity → sign in.
    const { rows: known } = await db.query(
      `SELECT a.* FROM identities i JOIN artists a ON a.id = i.artist_id
        WHERE i.provider = 'google' AND i.subject = $1`, [info.sub]);
    if (known[0]) {
      await auth.createSession(res, known[0].id, { remember });
      return res.redirect('/workinprogress/profile.html');
    }

    // 2. Existing account matched by email → link identity.
    const { rows: byEmail } = await db.query(
      'SELECT * FROM artists WHERE email = $1', [email]);
    if (byEmail[0]) {
      await db.query(
        `INSERT INTO identities (artist_id, provider, subject, email)
         VALUES ($1,'google',$2,$3) ON CONFLICT (provider, subject) DO NOTHING`,
        [byEmail[0].id, info.sub, email]);
      await auth.createSession(res, byEmail[0].id, { remember });
      return res.redirect('/workinprogress/profile.html');
    }

    // 3. Brand-new, carrying an invite → create account.
    if (parsed.invite) {
      const artist = await auth.redeemInvite({
        token:    parsed.invite,
        name:     info.name || email.split('@')[0],
        email,
        password: null,
        identity: { provider: 'google', subject: info.sub, email }
      });
      await auth.createSession(res, artist.id, { remember });
      return res.redirect('/workinprogress/profile.html');
    }

    // 4. No invite, no account. Kudzu is invite-only.
    return fail('no_invite');
  } catch (err) {
    console.error('oauth callback failed:', err.message);
    return fail('oauth_failed');
  }
});

module.exports = { router, isConfigured };
