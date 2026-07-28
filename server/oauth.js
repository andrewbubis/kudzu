// Sign in with Google (and Apple, when the developer account exists).
//
// Standard OAuth 2.0 authorization-code flow, done by hand — no library,
// so there is no dependency to keep patched for something this small.
//
// Two things worth noting:
//  · The `state` parameter is a random value stored in a short-lived
//    cookie and compared on return. Without it, an attacker can finish
//    a login in someone else's browser (CSRF).
//  · OAuth never creates accounts on its own. Kudzu is invite-only, so
//    an unrecognised Google account is turned away unless it arrives
//    carrying a valid invite.

const crypto = require('crypto');
const express = require('express');
const db = require('./db');
const auth = require('./auth');

const router = express.Router();
const STATE_COOKIE = 'kudzu_oauth';

const GOOGLE = {
  authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
  token: 'https://oauth2.googleapis.com/token',
  userinfo: 'https://openidconnect.googleapis.com/v1/userinfo',
  scope: 'openid email profile',
  id: () => process.env.GOOGLE_CLIENT_ID,
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
  return false; // Apple needs a paid developer account; not wired yet.
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

  const state = crypto.randomBytes(24).toString('base64url');
  // Carry the invite through the round trip so a brand-new artist can
  // sign up with Google straight from their invite link.
  const invite = typeof req.query.invite === 'string' ? req.query.invite : '';

  res.cookie(STATE_COOKIE, JSON.stringify({ state, invite }), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 10 * 60 * 1000,
    path: '/'
  });

  const url = new URL(GOOGLE.authorize);
  url.searchParams.set('client_id', GOOGLE.id());
  url.searchParams.set('redirect_uri', redirectUri(req, 'google'));
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', GOOGLE.scope);
  url.searchParams.set('state', state);
  url.searchParams.set('prompt', 'select_account');
  res.redirect(url.toString());
});

// ── Return ───────────────────────────────────────────────────────────
router.get('/auth/:provider/callback', async (req, res) => {
  const provider = req.params.provider;
  const fail = (why) => res.redirect('/workinprogress/login.html?error=' + why);

  if (provider !== 'google' || !isConfigured('google')) return fail('oauth_unconfigured');
  if (!db.isReady()) return fail('backend_unavailable');

  let saved;
  try { saved = JSON.parse(req.cookies[STATE_COOKIE] || '{}'); }
  catch (err) { saved = {}; }
  res.clearCookie(STATE_COOKIE, { path: '/' });

  // Constant-time compare, and reject anything that doesn't match.
  const given = String(req.query.state || '');
  const expected = String(saved.state || '');
  if (!expected || given.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected))) {
    return fail('bad_state');
  }
  if (!req.query.code) return fail('no_code');

  try {
    const tokenRes = await fetch(GOOGLE.token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: String(req.query.code),
        client_id: GOOGLE.id(),
        client_secret: GOOGLE.secret(),
        redirect_uri: redirectUri(req, 'google'),
        grant_type: 'authorization_code'
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

    // 1. Known identity → sign in.
    const { rows: known } = await db.query(
      `SELECT a.* FROM identities i JOIN artists a ON a.id = i.artist_id
        WHERE i.provider = 'google' AND i.subject = $1`, [info.sub]);
    if (known[0]) {
      await auth.createSession(res, known[0].id);
      return res.redirect('/workinprogress/profile.html');
    }

    // 2. Existing account with that email → link the two.
    const { rows: byEmail } = await db.query(
      'SELECT * FROM artists WHERE email = $1', [email]);
    if (byEmail[0]) {
      await db.query(
        `INSERT INTO identities (artist_id, provider, subject, email)
         VALUES ($1,'google',$2,$3) ON CONFLICT (provider, subject) DO NOTHING`,
        [byEmail[0].id, info.sub, email]);
      await auth.createSession(res, byEmail[0].id);
      return res.redirect('/workinprogress/profile.html');
    }

    // 3. Brand new, but carrying an invite → create the account.
    if (saved.invite) {
      const artist = await auth.redeemInvite({
        token: saved.invite,
        name: info.name || email.split('@')[0],
        email,
        password: null,
        identity: { provider: 'google', subject: info.sub, email }
      });
      await auth.createSession(res, artist.id);
      return res.redirect('/workinprogress/profile.html');
    }

    // 4. Otherwise: no invite, no account. Kudzu is invite-only.
    return fail('no_invite');
  } catch (err) {
    console.error('oauth callback failed:', err.message);
    return fail('oauth_failed');
  }
});

module.exports = { router, isConfigured };
