// The account API. Everything under /api.
//
// Rule followed throughout: the browser is never trusted. Ownership,
// the ten-work limit, file type and size are all re-checked here even
// though the page checks them too.

const express = require('express');
const db = require('./db');
const auth = require('./auth');
const storage = require('./storage');
const mail = require('./mail');

const router = express.Router();

// ── Shape helpers ────────────────────────────────────────────────────
const publicArtist = (a) => ({
  id: a.id,
  name: a.name,
  slug: a.slug,
  email: a.email,
  photo: a.photo_path,
  bio: a.bio || '',
  cv: a.cv || '',
  bornYear: a.born_year,
  bornCountry: a.born_country,
  worksCity: a.works_city,
  worksCountry: a.works_country,
  link: a.link_url,
  isAdmin: a.is_admin,
  // Visibility is computed, not switched. A page is public once the
  // profile is complete — unless an admin has explicitly pulled it down.
  pagePublic: !!(a.stripe_account && a.photo_path &&
                 String(a.bio || '').trim() && String(a.cv || '').trim() &&
                 !a.admin_hidden),
  adminHidden: !!a.admin_hidden,
  stripeConnected: !!a.stripe_account,
  // Internal only — how Kudzu reaches them about a sale or a message.
  // Deliberately absent from the public artist endpoint below.
  notifyChannel: a.notify_channel || 'email',
  notifyPhone: a.notify_phone || ''
});

const publicWork = (w) => ({
  id: w.id,
  title: w.title,
  year: w.year,
  medium: w.medium,
  dimensions: w.dimensions,
  priceCents: w.price_cents,
  currency: w.currency,
  forSale: w.for_sale,
  image: w.image_path,
  width: w.image_w,
  height: w.image_h,
  status: w.status,
  position: w.position,
  // Whether the artist will hand this one over in person.
  pickupOk: !!w.pickup_ok,
  // Packed-for-shipping figures, used to quote freight at checkout.
  shipWeightOz: w.ship_weight_oz,
  shipLengthIn: w.ship_length_in == null ? null : Number(w.ship_length_in),
  shipWidthIn:  w.ship_width_in  == null ? null : Number(w.ship_width_in),
  shipDepthIn:  w.ship_depth_in  == null ? null : Number(w.ship_depth_in)
});

const publicBook = (b) => ({
  id: b.id,
  title: b.title,
  year: b.year,
  medium: b.format,
  publisher: b.publisher,
  edition: b.edition,
  priceCents: b.price_cents,
  currency: b.currency,
  forSale: b.for_sale,
  image: b.image_path,
  status: b.status,
  position: b.position
});

// Refuse everything if there is no database yet, so the page can fall
// back to demo mode rather than showing broken half-states.
router.use((_req, res, next) => {
  if (!db.isReady()) return res.status(503).json({ error: 'backend_unavailable' });
  next();
});

// ── Auth ─────────────────────────────────────────────────────────────
router.post('/auth/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'missing_fields' });
  try {
    const artist = await auth.login(email, password);
    if (!artist) return res.status(401).json({ error: 'bad_credentials' });
    await auth.createSession(res, artist.id);
    res.json({ artist: publicArtist(artist) });
  } catch (err) {
    console.error('login failed:', err.message);
    res.status(500).json({ error: 'server_error' });
  }
});

router.post('/auth/logout', async (req, res) => {
  await auth.destroySession(req, res);
  res.status(204).end();
});

// Check an invite before showing the signup form.
router.get('/invites/:token', async (req, res) => {
  try {
    const result = await auth.readInvite(req.params.token);
    res.json({
      status: result.status,
      email: result.invite ? result.invite.email : null,
      note: result.invite ? result.invite.note : null
    });
  } catch (err) {
    res.status(500).json({ error: 'server_error' });
  }
});

// Redeem an invite → create the account → sign them straight in.
router.post('/auth/signup', async (req, res) => {
  const { token, name, email, password } = req.body || {};
  if (!token || !name || !password) return res.status(400).json({ error: 'missing_fields' });
  if (String(password).length < 10) return res.status(400).json({ error: 'password_too_short' });
  try {
    const artist = await auth.redeemInvite({ token, name, email, password });
    await auth.createSession(res, artist.id);
    res.status(201).json({ artist: publicArtist(artist) });
  } catch (err) {
    const map = {
      INVITE_INVALID: [410, 'invite_invalid'],
      INVITE_USED: [410, 'invite_used'],
      INVITE_EXPIRED: [410, 'invite_expired'],
      INVITE_EMAIL_MISMATCH: [403, 'invite_email_mismatch'],
      EMAIL_TAKEN: [409, 'email_taken'],
      EMAIL_REQUIRED: [400, 'email_required']
    };
    const [status, code] = map[err.code] || [500, 'server_error'];
    if (status === 500) console.error('signup failed:', err.message);
    res.status(status).json({ error: code });
  }
});

// ── Me ───────────────────────────────────────────────────────────────
router.get('/me', auth.requireArtist, async (req, res) => {
  try {
    const [works, books, photos] = await Promise.all([
      db.query('SELECT * FROM artworks WHERE artist_id = $1 ORDER BY position, created_at', [req.artist.id]),
      db.query('SELECT * FROM books    WHERE artist_id = $1 ORDER BY position, created_at', [req.artist.id]),
      db.query('SELECT * FROM artist_photos WHERE artist_id = $1 ORDER BY position, created_at', [req.artist.id])
    ]);
    res.json({
      artist: publicArtist(req.artist),
      works: works.rows.map(publicWork),
      books: books.rows.map(publicBook),
      photos: photos.rows.map(publicPhoto)
    });
  } catch (err) {
    console.error('me failed:', err.message);
    res.status(500).json({ error: 'server_error' });
  }
});

const PROFILE_FIELDS = {
  name: 'name', bio: 'bio', cv: 'cv',
  bornYear: 'born_year', bornCountry: 'born_country',
  worksCity: 'works_city', worksCountry: 'works_country', link: 'link_url'
};

// Shared by /me and the admin editor below — same whitelist, same
// validation, whether you're editing your own page or fixing a typo
// on someone else's.
function buildProfileSets(body) {
  const sets = [], vals = [];
  for (const [key, col] of Object.entries(PROFILE_FIELDS)) {
    if (body && Object.prototype.hasOwnProperty.call(body, key)) {
      let v = body[key];
      if (key === 'bornYear') {
        v = v === '' || v == null ? null : parseInt(v, 10);
        if (v != null && (!Number.isFinite(v) || v < 1850 || v > 2100)) {
          throw Object.assign(new Error('bad_year'), { code: 'bad_year' });
        }
      } else if (typeof v === 'string') {
        v = v.trim().slice(0, key === 'bio' || key === 'cv' ? 8000 : 200) || null;
      }
      if (key === 'link' && v && !/^https?:\/\//i.test(v)) v = 'https://' + v;
      sets.push(`${col} = $${sets.length + 1}`);
      vals.push(v);
    }
  }
  return { sets, vals };
}

router.patch('/me', auth.requireArtist, async (req, res) => {
  let sets, vals;
  try {
    ({ sets, vals } = buildProfileSets(req.body));
  } catch (err) {
    return res.status(400).json({ error: err.code || 'bad_request' });
  }
  // There is no approval gate any more: a page is public as soon as the
  // profile is complete. `adminHidden` is the emergency brake — abuse, a
  // departure, a legal problem — and only an admin can pull it.
  // Their email is their login as well as where notifications go, so it
  // is handled here rather than in the shared profile whitelist — an
  // admin fixing a typo on someone's page has no business changing the
  // address they sign in with.
  const body = req.body || {};
  if (Object.prototype.hasOwnProperty.call(body, 'email')) {
    const next = String(body.email || '').trim().toLowerCase().slice(0, 200);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(next)) {
      return res.status(400).json({ error: 'bad_email' });
    }
    sets.push(`email = $${sets.length + 1}`);
    vals.push(next);
  }

  // How they want to hear about sales and messages. Never shown publicly.
  if (Object.prototype.hasOwnProperty.call(body, 'notifyChannel')) {
    const ch = String(body.notifyChannel);
    if (ch !== 'email' && ch !== 'sms') {
      return res.status(400).json({ error: 'bad_notify_channel' });
    }
    sets.push(`notify_channel = $${sets.length + 1}`);
    vals.push(ch);
  }
  if (Object.prototype.hasOwnProperty.call(body, 'notifyPhone')) {
    // Digits, spaces, and the usual punctuation. Not a validator — just a
    // guard against someone pasting an essay into the field.
    const raw = String(body.notifyPhone || '').trim().slice(0, 32);
    if (raw && !/^[0-9+()\-.\s]{7,32}$/.test(raw)) {
      return res.status(400).json({ error: 'bad_phone' });
    }
    sets.push(`notify_phone = $${sets.length + 1}`);
    vals.push(raw || null);
  }
  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'adminHidden')) {
    if (!req.artist.is_admin) return res.status(403).json({ error: 'admin_only' });
    sets.push(`admin_hidden = $${sets.length + 1}`);
    vals.push(!!req.body.adminHidden);
  }

  if (!sets.length) return res.status(400).json({ error: 'nothing_to_update' });
  vals.push(req.artist.id);
  try {
    const { rows } = await db.query(
      `UPDATE artists SET ${sets.join(', ')}, updated_at = now()
        WHERE id = $${vals.length} RETURNING *`, vals);
    res.json({ artist: publicArtist(rows[0]) });
  } catch (err) {
    // Email is UNIQUE — say so plainly instead of a 500 the artist can't
    // act on. 23505 is Postgres for a unique-constraint violation.
    if (err.code === '23505') {
      return res.status(409).json({ error: 'email_taken' });
    }
    console.error('profile update failed:', err.message);
    res.status(500).json({ error: 'server_error' });
  }
});

router.post('/me/photo', auth.requireArtist, storage.upload.single('photo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no_file' });
  try {
    const saved = await storage.store(req.file.buffer, req.artist.id, 'photo');
    const { rows } = await db.query(
      'UPDATE artists SET photo_path = $1, updated_at = now() WHERE id = $2 RETURNING *',
      [saved.path, req.artist.id]);
    if (req.artist.photo_path) storage.remove(req.artist.photo_path);
    res.json({ artist: publicArtist(rows[0]) });
  } catch (err) {
    console.error('photo upload failed:', err.message);
    res.status(400).json({ error: 'bad_image' });
  }
});

// ── Gallery photos ───────────────────────────────────────────────────
// Studio shots and detail crops. Capped so a profile stays a profile.
const MAX_GALLERY_PHOTOS = 12;

const publicPhoto = (p) => ({
  id: p.id, image: p.image_path, caption: p.caption || '', position: p.position
});

router.post('/me/photos', auth.requireArtist, storage.upload.single('photo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no_file' });
  let saved;
  try {
    const { rows: count } = await db.query(
      'SELECT count(*)::int AS n FROM artist_photos WHERE artist_id = $1', [req.artist.id]);
    if (count[0].n >= MAX_GALLERY_PHOTOS) {
      return res.status(409).json({ error: 'photo_limit_reached', max: MAX_GALLERY_PHOTOS });
    }
    saved = await storage.store(req.file.buffer, req.artist.id, 'photo');
  } catch (err) {
    return res.status(400).json({ error: 'bad_image' });
  }
  try {
    const caption = req.body && req.body.caption
      ? String(req.body.caption).trim().slice(0, 200) : null;
    const { rows } = await db.query(
      `INSERT INTO artist_photos (artist_id, image_path, caption, position)
       VALUES ($1,$2,$3,
               COALESCE((SELECT max(position)+1 FROM artist_photos WHERE artist_id = $1), 0))
       RETURNING *`, [req.artist.id, saved.path, caption]);
    res.status(201).json(publicPhoto(rows[0]));
  } catch (err) {
    storage.remove(saved.path);
    console.error('gallery photo insert failed:', err.message);
    res.status(500).json({ error: 'server_error' });
  }
});

router.delete('/me/photos/:id', auth.requireArtist, async (req, res) => {
  try {
    const { rows } = await db.query(
      'DELETE FROM artist_photos WHERE id = $1 AND artist_id = $2 RETURNING image_path',
      [req.params.id, req.artist.id]);
    if (!rows[0]) return res.status(404).json({ error: 'not_found' });
    storage.remove(rows[0].image_path);
    res.status(204).end();
  } catch (err) {
    res.status(500).json({ error: 'server_error' });
  }
});

// The site-wide pool. Only from artists whose pages are public, so a
// half-built profile never leaks a photo onto the home page. Shuffled in
// the database so every visit cycles differently.
router.get('/photos', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 24, 60);
  try {
    const { rows } = await db.query(
      `SELECT p.image_path, p.caption, a.name AS artist_name, a.slug AS artist_slug
         FROM artist_photos p
         JOIN artists a ON a.id = p.artist_id
        WHERE kudzu_artist_public(a.id)
     ORDER BY random()
        LIMIT $1`, [limit]);
    res.json({
      photos: rows.map((r) => ({
        image: r.image_path, caption: r.caption || '',
        artist: r.artist_name, slug: r.artist_slug
      }))
    });
  } catch (err) {
    res.status(500).json({ error: 'server_error' });
  }
});

// ── Works ────────────────────────────────────────────────────────────
// Package figures arrive as strings from a multipart form. Anything
// missing, non-numeric, or non-positive becomes null rather than 0 —
// a zero-ounce parcel would quote as free shipping.
function positiveNumber(v, max) {
  if (v === '' || v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0 || n > max) return null;
  return n;
}

function parseWorkFields(body) {
  const price = body.priceCents === '' || body.priceCents == null
    ? null : Math.round(Number(body.priceCents));
  return {
    title: String(body.title || '').trim().slice(0, 200),
    year: body.year ? parseInt(body.year, 10) || null : null,
    medium: body.medium ? String(body.medium).trim().slice(0, 120) : null,
    dimensions: body.dimensions ? String(body.dimensions).trim().slice(0, 120) : null,
    priceCents: Number.isFinite(price) && price >= 0 ? price : null,
    // 4000 oz (250 lb) and 200 in are sanity ceilings, not real limits —
    // past those someone has fat-fingered a field.
    shipWeightOz: (function () {
      const n = positiveNumber(body.shipWeightOz, 4000);
      return n == null ? null : Math.round(n);
    })(),
    shipLengthIn: positiveNumber(body.shipLengthIn, 200),
    shipWidthIn:  positiveNumber(body.shipWidthIn, 200),
    shipDepthIn:  positiveNumber(body.shipDepthIn, 200)
  };
}

// What an artist is still missing before they can add work at all.
// The database enforces this too — this is here so the UI can say which
// of the four is outstanding instead of just refusing.
function profileGaps(a) {
  const gaps = [];
  if (!a.stripe_account) gaps.push('stripe');
  if (!a.photo_path) gaps.push('photo');
  if (!String(a.bio || '').trim()) gaps.push('bio');
  if (!String(a.cv || '').trim()) gaps.push('cv');
  return gaps;
}

router.get('/me/readiness', auth.requireArtist, (req, res) => {
  const gaps = profileGaps(req.artist);
  res.json({ ready: gaps.length === 0, missing: gaps });
});

router.post('/works', auth.requireArtist, storage.upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no_file' });
  const f = parseWorkFields(req.body || {});
  if (!f.title) return res.status(400).json({ error: 'title_required' });

  // Refuse before touching disk, so a rejected upload doesn't leave an
  // orphaned image behind.
  const gaps = profileGaps(req.artist);
  if (gaps.length) {
    return res.status(409).json({ error: 'profile_incomplete', missing: gaps });
  }
  if (f.shipWeightOz == null || f.shipLengthIn == null ||
      f.shipWidthIn == null || f.shipDepthIn == null) {
    return res.status(400).json({ error: 'shipping_missing' });
  }

  // Uploading publishes, so the cap has to be checked here rather than at
  // a publish step that no longer exists. Refuse plainly instead of
  // accepting the piece and hiding it as a draft the artist has no way to
  // bring out.
  try {
    const { rows: n } = await db.query(
      `SELECT count(*)::int AS live FROM artworks
        WHERE artist_id = $1 AND status = 'published'`, [req.artist.id]);
    if (n[0].live >= 10) {
      return res.status(409).json({ error: 'publish_limit_reached', max: 10 });
    }
  } catch (err) {
    return res.status(500).json({ error: 'server_error' });
  }

  let saved;
  try {
    saved = await storage.store(req.file.buffer, req.artist.id, 'work');
  } catch (err) {
    return res.status(400).json({ error: 'bad_image' });
  }

  try {
    const { rows } = await db.query(
      `INSERT INTO artworks
         (artist_id, title, year, medium, dimensions, price_cents,
          image_path, image_w, image_h,
          ship_weight_oz, ship_length_in, ship_width_in, ship_depth_in,
          status, position)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,
               -- A finished work goes straight up. There is no publish
               -- step and no button for one: uploading a piece with all
               -- its details is the act of putting it out. Being over the
               -- cap is refused before we reach here, so this is always
               -- 'published' — spelled out rather than defaulted, so the
               -- intent survives the next person reading it.
               'published',
               COALESCE((SELECT max(position)+1 FROM artworks WHERE artist_id = $1), 0))
       RETURNING *`,
      [req.artist.id, f.title, f.year, f.medium, f.dimensions, f.priceCents,
       saved.path, saved.width, saved.height,
       f.shipWeightOz, f.shipLengthIn, f.shipWidthIn, f.shipDepthIn]);
    res.status(201).json(publicWork(rows[0]));
  } catch (err) {
    storage.remove(saved.path);
    // The triggers raise these by name; pass them through rather than
    // flattening a rule the artist can actually act on into a 500.
    const RULES = {
      profile_incomplete: 409,
      shipping_missing: 400,
      stripe_not_connected: 409,
      publish_limit_reached: 409
    };
    const rule = Object.keys(RULES).find((k) => err.message.includes(k));
    if (rule) return res.status(RULES[rule]).json({ error: rule });
    console.error('work insert failed:', err.message);
    res.status(500).json({ error: 'server_error' });
  }
});

router.patch('/works/:id', auth.requireArtist, async (req, res) => {
  const body = req.body || {};
  const sets = [], vals = [];
  const map = { title: 'title', year: 'year', medium: 'medium',
                dimensions: 'dimensions', priceCents: 'price_cents',
                forSale: 'for_sale', status: 'status', position: 'position',
                shipWeightOz: 'ship_weight_oz', shipLengthIn: 'ship_length_in',
                shipWidthIn: 'ship_width_in', shipDepthIn: 'ship_depth_in',
                pickupOk: 'pickup_ok' };
  const SHIP_KEYS = ['shipWeightOz', 'shipLengthIn', 'shipWidthIn', 'shipDepthIn'];
  for (const [key, col] of Object.entries(map)) {
    if (Object.prototype.hasOwnProperty.call(body, key)) {
      if (key === 'status' && !['draft', 'published'].includes(body[key])) {
        return res.status(400).json({ error: 'bad_status' }); // 'sold' is set by Stripe, not the artist
      }
      let v = body[key];
      // Same guard as on upload: never let a 0 or a stray string through,
      // or the piece quotes as free to ship.
      if (SHIP_KEYS.includes(key)) {
        v = positiveNumber(v, key === 'shipWeightOz' ? 4000 : 200);
        if (key === 'shipWeightOz' && v != null) v = Math.round(v);
      }
      if (key === 'pickupOk') {
        v = !!v;
        // A pickup option with no location is unanswerable for a buyer —
        // collect from where? Refuse it until the artist says where they
        // work, which is the same field their public page already uses.
        if (v && !String(req.artist.works_city || '').trim()) {
          return res.status(409).json({ error: 'location_required' });
        }
      }
      sets.push(`${col} = $${sets.length + 1}`);
      vals.push(v);
    }
  }
  if (!sets.length) return res.status(400).json({ error: 'nothing_to_update' });
  vals.push(req.params.id, req.artist.id);
  try {
    const { rows } = await db.query(
      `UPDATE artworks SET ${sets.join(', ')}
        WHERE id = $${vals.length - 1} AND artist_id = $${vals.length}
        RETURNING *`, vals);
    if (!rows[0]) return res.status(404).json({ error: 'not_found' });
    res.json(publicWork(rows[0]));
  } catch (err) {
    // `shipping_missing` is the one that fires when an artist tries to
    // publish a piece uploaded before the packed figures were required.
    for (const rule of ['publish_limit_reached', 'stripe_not_connected',
                        'shipping_missing', 'profile_incomplete']) {
      if (String(err.message).includes(rule)) {
        return res.status(409).json({ error: rule });
      }
    }
    console.error('work update failed:', err.message);
    res.status(500).json({ error: 'server_error' });
  }
});

router.delete('/works/:id', auth.requireArtist, async (req, res) => {
  try {
    const { rows } = await db.query(
      'DELETE FROM artworks WHERE id = $1 AND artist_id = $2 RETURNING image_path',
      [req.params.id, req.artist.id]);
    if (!rows[0]) return res.status(404).json({ error: 'not_found' });
    storage.remove(rows[0].image_path);
    res.status(204).end();
  } catch (err) {
    console.error('work delete failed:', err.message);
    res.status(500).json({ error: 'server_error' });
  }
});

router.post('/works/reorder', auth.requireArtist, async (req, res) => {
  const order = Array.isArray(req.body && req.body.order) ? req.body.order : null;
  if (!order) return res.status(400).json({ error: 'bad_order' });
  try {
    await db.tx(async (client) => {
      for (let i = 0; i < order.length; i++) {
        await client.query(
          'UPDATE artworks SET position = $1 WHERE id = $2 AND artist_id = $3',
          [i, order[i], req.artist.id]);
      }
    });
    res.status(204).end();
  } catch (err) {
    console.error('reorder failed:', err.message);
    res.status(500).json({ error: 'server_error' });
  }
});

// ── Books ────────────────────────────────────────────────────────────
router.post('/books', auth.requireArtist, storage.upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no_file' });
  const b = req.body || {};
  const title = String(b.title || '').trim().slice(0, 200);
  if (!title) return res.status(400).json({ error: 'title_required' });

  let saved;
  try {
    saved = await storage.store(req.file.buffer, req.artist.id, 'book');
  } catch (err) {
    return res.status(400).json({ error: 'bad_image' });
  }

  try {
    const price = b.priceCents ? Math.round(Number(b.priceCents)) : null;
    const { rows } = await db.query(
      `INSERT INTO books (artist_id, title, year, format, publisher, edition,
                          price_cents, image_path, status, position)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'draft',
               COALESCE((SELECT max(position)+1 FROM books WHERE artist_id = $1), 0))
       RETURNING *`,
      [req.artist.id, title, b.year ? parseInt(b.year, 10) || null : null,
       b.format || b.medium || null, b.publisher || null, b.edition || null,
       Number.isFinite(price) && price >= 0 ? price : null, saved.path]);
    res.status(201).json(publicBook(rows[0]));
  } catch (err) {
    storage.remove(saved.path);
    console.error('book insert failed:', err.message);
    res.status(500).json({ error: 'server_error' });
  }
});

router.delete('/books/:id', auth.requireArtist, async (req, res) => {
  try {
    const { rows } = await db.query(
      'DELETE FROM books WHERE id = $1 AND artist_id = $2 RETURNING image_path',
      [req.params.id, req.artist.id]);
    if (!rows[0]) return res.status(404).json({ error: 'not_found' });
    storage.remove(rows[0].image_path);
    res.status(204).end();
  } catch (err) {
    res.status(500).json({ error: 'server_error' });
  }
});

// ── Documents: the agreement ─────────────────────────────────────────
// An artist should never have to email Kudzu asking what they agreed to.
// Their contract and every delivery receipt live in their account.

// The version we currently ask people to sign, plus whether this artist
// has signed it. Public text — there is nothing secret in a contract you
// are about to be asked to accept.
router.get('/agreement', auth.requireArtist, async (req, res) => {
  try {
    const { rows: cur } = await db.query(
      'SELECT * FROM agreement_versions WHERE is_current LIMIT 1');
    const { rows: mine } = await db.query(
      `SELECT version, legal_name, address, signed_at
         FROM agreement_signatures WHERE artist_id = $1
     ORDER BY signed_at DESC`, [req.artist.id]);

    res.json({
      current: cur[0] ? {
        version: cur[0].version, title: cur[0].title,
        body: cur[0].body, effective: cur[0].effective
      } : null,
      signatures: mine.map((s) => ({
        version: s.version, legalName: s.legal_name,
        address: s.address, signedAt: s.signed_at
      })),
      // Have they signed the version currently in force?
      signedCurrent: !!(cur[0] && mine.some((s) => s.version === cur[0].version))
    });
  } catch (err) {
    console.error('agreement fetch failed:', err.message);
    res.status(500).json({ error: 'server_error' });
  }
});

router.post('/agreement/sign', auth.requireArtist, async (req, res) => {
  const b = req.body || {};
  const legalName = String(b.legalName || '').trim().slice(0, 200);
  const address = String(b.address || '').trim().slice(0, 500);

  if (legalName.length < 3) return res.status(400).json({ error: 'name_required' });
  if (address.length < 8) return res.status(400).json({ error: 'address_required' });

  try {
    const { rows: cur } = await db.query(
      'SELECT version FROM agreement_versions WHERE is_current LIMIT 1');
    if (!cur[0]) return res.status(503).json({ error: 'no_agreement' });

    await db.query(
      `INSERT INTO agreement_signatures
         (artist_id, version, legal_name, address, ip, user_agent)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (artist_id, version) DO NOTHING`,
      [req.artist.id, cur[0].version, legalName, address,
       req.headers['x-forwarded-for'] || req.ip || null,
       String(req.headers['user-agent'] || '').slice(0, 400)]);

    res.status(201).json({ ok: true, version: cur[0].version });
  } catch (err) {
    console.error('agreement sign failed:', err.message);
    res.status(500).json({ error: 'server_error' });
  }
});

// ── Documents: bills of lading ───────────────────────────────────────
const publicBol = (b) => ({
  id: b.id,
  workTitle: b.work_title,
  workDetails: b.work_details || '',
  priceCents: b.price_cents,
  currency: b.currency,
  condition: b.condition || '',
  buyerName: b.buyer_name,
  joinCode: b.join_code,
  artistSignedAt: b.artist_signed_at,
  buyerSignedAt: b.buyer_signed_at,
  completedAt: b.completed_at,
  createdAt: b.created_at
});

// ── The handoff ──────────────────────────────────────────────────────
// An artist and a buyer standing in a room together, signing the same
// document on two different phones.
//
// The join code is not a password. It identifies a signing session, and
// it's meant to be read off a screen or scanned from a QR by someone
// standing right there. What makes the record hold up is that the two
// signatures arrive from two devices with two addresses, not that the
// code was secret.

// Unambiguous alphabet: no O/0, no I/1, no S/5. This gets read aloud
// across a table when a camera won't focus.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRTUVWXYZ2346789';
function makeJoinCode() {
  const bytes = require('crypto').randomBytes(6);
  return Array.from(bytes).map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

// Start one. Called by the artist when they're with the buyer.
router.post('/handoffs', auth.requireArtist, async (req, res) => {
  const b = req.body || {};
  const buyerName = String(b.buyerName || '').trim().slice(0, 200);
  const buyerEmail = String(b.buyerEmail || '').trim().toLowerCase().slice(0, 200);
  const condition = String(b.condition || '').trim().slice(0, 500) || null;

  if (!buyerName) return res.status(400).json({ error: 'buyer_name_required' });
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(buyerEmail)) {
    return res.status(400).json({ error: 'bad_email' });
  }

  try {
    // The work must belong to them. Price and title are read from the
    // database, never from the browser — otherwise the document could be
    // written to say anything.
    const { rows: w } = await db.query(
      'SELECT * FROM artworks WHERE id = $1 AND artist_id = $2',
      [b.workId, req.artist.id]);
    if (!w[0]) return res.status(404).json({ error: 'work_not_found' });

    const work = w[0];
    const details = [work.medium, work.year, work.dimensions].filter(Boolean).join(' · ');

    const { rows } = await db.query(
      `INSERT INTO bills_of_lading
         (artwork_id, artist_id, work_title, work_details, price_cents, currency,
          condition, buyer_name, buyer_email, join_code, stripe_session_id, payout_cents)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING *`,
      [work.id, req.artist.id, work.title, details || null,
       work.price_cents || 0, work.currency || 'usd',
       condition, buyerName, buyerEmail, makeJoinCode(),
       b.stripeSessionId || null, b.payoutCents || null]);

    res.status(201).json(publicBol(rows[0]));
  } catch (err) {
    console.error('handoff create failed:', err.message);
    res.status(500).json({ error: 'server_error' });
  }
});

// A drawn signature arrives as a PNG data URL. Capped because it comes
// from a browser and nothing from a browser is trusted — a real one is a
// few kilobytes, so anything past 400KB is not a signature.
const MAX_SIG_BYTES = 400 * 1024;
function signatureImage(v) {
  const s = String(v || '');
  if (!s) return null;
  if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(s)) return null;
  if (s.length > MAX_SIG_BYTES) return null;
  return s;
}

// The artist signs their side.
router.post('/handoffs/:id/sign', auth.requireArtist, async (req, res) => {
  const signature = String((req.body || {}).signature || '').trim().slice(0, 200);
  const drawn = signatureImage((req.body || {}).signatureImage);
  if (signature.length < 3) return res.status(400).json({ error: 'signature_required' });
  if (!drawn) return res.status(400).json({ error: 'drawn_signature_required' });

  try {
    const { rows } = await db.query(
      `UPDATE bills_of_lading
          SET artist_signed_at = COALESCE(artist_signed_at, now()),
              artist_signature = COALESCE(artist_signature, $1),
              artist_signature_img = COALESCE(artist_signature_img, $5),
              artist_ip = COALESCE(artist_ip, $2)
        WHERE id = $3 AND artist_id = $4
    RETURNING *`,
      [signature, req.headers['x-forwarded-for'] || req.ip || null,
       req.params.id, req.artist.id, drawn]);
    if (!rows[0]) return res.status(404).json({ error: 'not_found' });

    await releaseIfComplete(rows[0]);
    res.json(publicBol(rows[0]));
  } catch (err) {
    console.error('artist sign failed:', err.message);
    res.status(500).json({ error: 'server_error' });
  }
});

// ── The buyer's side — no account, no login ──────────────────────────
// A buyer is a stranger with a phone. Everything they need is reachable
// with the code they were just shown.

// What they see before signing. Deliberately excludes anything that
// isn't on the document itself.
router.get('/handoff/:code', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT b.*, a.name AS artist_name
         FROM bills_of_lading b
         JOIN artists a ON a.id = b.artist_id
        WHERE b.join_code = $1`, [String(req.params.code || '').toUpperCase()]);
    if (!rows[0]) return res.status(404).json({ error: 'not_found' });

    const b = rows[0];
    res.json({
      id: b.id,
      workTitle: b.work_title,
      workDetails: b.work_details || '',
      priceCents: b.price_cents,
      currency: b.currency,
      condition: b.condition || '',
      artistName: b.artist_name,
      buyerName: b.buyer_name,
      artistSignedAt: b.artist_signed_at,
      artistSignature: b.artist_signature,
      buyerSignedAt: b.buyer_signed_at,
      buyerSignature: b.buyer_signature,
      completedAt: b.completed_at,
      createdAt: b.created_at
    });
  } catch (err) {
    res.status(500).json({ error: 'server_error' });
  }
});

router.post('/handoff/:code/sign', async (req, res) => {
  const signature = String((req.body || {}).signature || '').trim().slice(0, 200);
  const drawn = signatureImage((req.body || {}).signatureImage);
  if (signature.length < 3) return res.status(400).json({ error: 'signature_required' });
  if (!drawn) return res.status(400).json({ error: 'drawn_signature_required' });

  try {
    const { rows } = await db.query(
      `UPDATE bills_of_lading
          SET buyer_signed_at = COALESCE(buyer_signed_at, now()),
              buyer_signature = COALESCE(buyer_signature, $1),
              buyer_signature_img = COALESCE(buyer_signature_img, $4),
              buyer_ip = COALESCE(buyer_ip, $2)
        WHERE join_code = $3
    RETURNING *`,
      [signature, req.headers['x-forwarded-for'] || req.ip || null,
       String(req.params.code || '').toUpperCase(), drawn]);
    if (!rows[0]) return res.status(404).json({ error: 'not_found' });

    await releaseIfComplete(rows[0]);
    res.json({ ok: true, completedAt: rows[0].completed_at });
  } catch (err) {
    console.error('buyer sign failed:', err.message);
    res.status(500).json({ error: 'server_error' });
  }
});

// Both signed → the record is complete. Nothing to release: the artist
// was paid at checkout, on either delivery route. This exists to send the
// receipt exactly once.
async function releaseIfComplete(bol) {
  if (!bol.completed_at) return;

  try {
    const { rows } = await db.query(
      `SELECT b.*, a.name AS artist_name, a.email AS artist_email
         FROM bills_of_lading b JOIN artists a ON a.id = b.artist_id
        WHERE b.id = $1`, [bol.id]);
    if (!rows[0]) return;

    // Claimed by whichever request gets here first, so a double-tap or a
    // retry can't email two people twice.
    const { rowCount } = await db.query(
      `UPDATE bills_of_lading SET receipt_sent_at = now()
        WHERE id = $1 AND receipt_sent_at IS NULL`, [bol.id]);
    if (!rowCount) return;

    await mail.handoffSigned({ bol: rows[0], artistEmail: rows[0].artist_email });
  } catch (err) {
    console.error('handoff receipt failed for', bol.id, '—', err.message);
  }
}

// A single document. The artist who owns it can always read it; a buyer
// reaches their copy through the signing link instead, since they have no
// account here.
router.get('/bols/:id', auth.requireArtist, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT b.*, a.name AS artist_name
         FROM bills_of_lading b
         JOIN artists a ON a.id = b.artist_id
        WHERE b.id = $1 AND b.artist_id = $2`,
      [req.params.id, req.artist.id]);
    if (!rows[0]) return res.status(404).json({ error: 'not_found' });
    res.json(Object.assign(publicBol(rows[0]), {
      artistName: rows[0].artist_name,
      artistSignature: rows[0].artist_signature,
      buyerSignature: rows[0].buyer_signature,
      artistSignatureImg: rows[0].artist_signature_img,
      buyerSignatureImg: rows[0].buyer_signature_img,
      // Needed by the handoff screen: the buyer signs on the artist's
      // phone through the public endpoint, keyed by this code.
      buyerEmail: rows[0].buyer_email
    }));
  } catch (err) {
    res.status(500).json({ error: 'server_error' });
  }
});

router.get('/bols', auth.requireArtist, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT * FROM bills_of_lading WHERE artist_id = $1
    ORDER BY created_at DESC LIMIT 200`, [req.artist.id]);
    res.json({ bols: rows.map(publicBol) });
  } catch (err) {
    res.status(500).json({ error: 'server_error' });
  }
});

// ── Enquiries ────────────────────────────────────────────────────────
// Public: a collector asks an artist about a piece.
router.post('/inquiries', async (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim().slice(0, 120);
  const email = String(b.email || '').trim().toLowerCase().slice(0, 200);
  const message = String(b.message || '').trim().slice(0, 4000);

  if (!name || !message) return res.status(400).json({ error: 'missing_fields' });
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return res.status(400).json({ error: 'bad_email' });
  }

  try {
    // Resolve the artist from their slug so the browser can't post an
    // enquiry into someone else's inbox by guessing ids.
    const { rows: ar } = await db.query(
      `SELECT id, name, email, notify_channel, notify_phone
         FROM artists WHERE slug = $1 AND kudzu_artist_public(id)`,
      [String(b.artistSlug || '')]);
    if (!ar[0]) return res.status(404).json({ error: 'artist_not_found' });

    // Same for the artwork — it must belong to that artist.
    let artworkId = null, workTitle = null;
    if (b.workId) {
      const { rows: wr } = await db.query(
        'SELECT id, title FROM artworks WHERE id = $1 AND artist_id = $2',
        [b.workId, ar[0].id]);
      if (wr[0]) { artworkId = wr[0].id; workTitle = wr[0].title; }
    }

    await db.query(
      `INSERT INTO inquiries (artist_id, artwork_id, name, email, message)
       VALUES ($1,$2,$3,$4,$5)`,
      [ar[0].id, artworkId, name, email, message]);

    // Answer the collector immediately; the message is already saved.
    // Sending happens after, and a mail failure must never turn a stored
    // enquiry into an error the visitor sees.
    res.status(201).json({ ok: true });

    mail.inquiryReceived({
      artist: ar[0],
      from: { name, email },
      message,
      workTitle
    }).catch((err) => console.error('inquiry notification failed:', err.message));
    return;
  } catch (err) {
    console.error('inquiry failed:', err.message);
    res.status(500).json({ error: 'server_error' });
  }
});

// The artist's own inbox.
router.get('/inquiries', auth.requireArtist, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT i.*, w.title AS work_title, w.image_path AS work_image
         FROM inquiries i
    LEFT JOIN artworks w ON w.id = i.artwork_id
        WHERE i.artist_id = $1
     ORDER BY i.created_at DESC
        LIMIT 200`, [req.artist.id]);

    res.json({
      inquiries: rows.map((r) => ({
        id: r.id, name: r.name, email: r.email, message: r.message,
        workTitle: r.work_title, workImage: r.work_image,
        readAt: r.read_at, createdAt: r.created_at
      }))
    });
  } catch (err) {
    console.error('inquiry list failed:', err.message);
    res.status(500).json({ error: 'server_error' });
  }
});

router.post('/inquiries/:id/read', auth.requireArtist, async (req, res) => {
  try {
    await db.query(
      'UPDATE inquiries SET read_at = now() WHERE id = $1 AND artist_id = $2',
      [req.params.id, req.artist.id]);
    res.status(204).end();
  } catch (err) {
    res.status(500).json({ error: 'server_error' });
  }
});

// ── Invites (admin only) ─────────────────────────────────────────────
router.get('/invites', auth.requireArtist, auth.requireAdmin, async (_req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT id, email, note, expires_at, used_at, created_at
         FROM invites ORDER BY created_at DESC LIMIT 60`);
    res.json({
      invites: rows.map((r) => ({
        id: r.id, email: r.email, note: r.note,
        expiresAt: r.expires_at, usedAt: r.used_at, createdAt: r.created_at
      }))
    });
  } catch (err) {
    res.status(500).json({ error: 'server_error' });
  }
});

router.post('/invites', auth.requireArtist, auth.requireAdmin, async (req, res) => {
  const { note, email, days } = req.body || {};
  try {
    const inv = await auth.createInvite({
      note, email,
      createdBy: req.artist.id,
      days: Math.min(Math.max(parseInt(days, 10) || 14, 1), 90)
    });
    const base = process.env.PUBLIC_BASE_URL
      || `${req.protocol}://${req.get('host')}`;
    res.status(201).json({
      url: `${base}/workinprogress/signup.html?invite=${inv.token}`,
      expiresAt: inv.expiresAt
    });
  } catch (err) {
    console.error('invite create failed:', err.message);
    res.status(500).json({ error: 'server_error' });
  }
});

// ── Admin: fix another artist's profile (admin only) ─────────────────
// For typos and small corrections Kudzu needs to make on an artist's
// behalf — a misspelled name, a wrong city. Same fields and the same
// whitelist an artist can edit on themselves in Settings; nothing here
// touches login, uploads, or a way to remove anything of theirs.
router.get('/admin/artists', auth.requireArtist, auth.requireAdmin, async (_req, res) => {
  try {
    const { rows } = await db.query('SELECT * FROM artists ORDER BY name');
    res.json({ artists: rows.map(publicArtist) });
  } catch (err) {
    console.error('admin artist list failed:', err.message);
    res.status(500).json({ error: 'server_error' });
  }
});

// ── Admin: the roster ────────────────────────────────────────────────
// One row per artist, enough to see who is stuck without visiting each
// public page. The four ticks are the same four the database demands
// before an artist can upload anything, so a row with a gap in it is
// literally an artist who cannot add work yet.
//
// `lastActivity` is the newest of their signup or any upload — what the
// page sorts and highlights on.
router.get('/admin/roster', auth.requireArtist, auth.requireAdmin, async (_req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT a.id, a.name, a.slug, a.email, a.created_at, a.is_admin, a.admin_hidden,
             a.photo_path, a.bio, a.cv, a.stripe_account,
             count(w.id) FILTER (WHERE w.status = 'draft')     AS drafts,
             count(w.id) FILTER (WHERE w.status = 'published') AS published_works,
             count(w.id) FILTER (WHERE w.status = 'sold')      AS sold_works,
             count(w.id) FILTER (
               WHERE w.status <> 'sold' AND w.ship_weight_oz IS NULL)  AS missing_ship,
             max(w.created_at) AS last_upload
        FROM artists a
        LEFT JOIN artworks w ON w.artist_id = a.id
    GROUP BY a.id
    ORDER BY a.created_at DESC`);

    res.json({
      artists: rows.map((r) => {
        const has = {
          photo:  !!r.photo_path,
          bio:    !!String(r.bio || '').trim(),
          cv:     !!String(r.cv || '').trim(),
          stripe: !!r.stripe_account
        };
        const lastUpload = r.last_upload || null;
        return {
          id: r.id,
          name: r.name,
          slug: r.slug,
          email: r.email,
          isAdmin: r.is_admin,
          // Complete profile puts them live; only an admin pull hides them.
          pagePublic: has.photo && has.bio && has.cv && has.stripe && !r.admin_hidden,
          adminHidden: r.admin_hidden,
          joinedAt: r.created_at,
          has,
          // Can they add work at all? Same test the database applies.
          canUpload: has.photo && has.bio && has.cv && has.stripe,
          drafts: Number(r.drafts),
          published: Number(r.published_works),
          sold: Number(r.sold_works),
          missingShip: Number(r.missing_ship),
          lastUpload,
          lastActivity: lastUpload && lastUpload > r.created_at ? lastUpload : r.created_at
        };
      })
    });
  } catch (err) {
    console.error('roster failed:', err.message);
    res.status(500).json({ error: 'server_error' });
  }
});

router.patch('/admin/artists/:id', auth.requireArtist, auth.requireAdmin, async (req, res) => {
  let sets, vals;
  try {
    ({ sets, vals } = buildProfileSets(req.body));
  } catch (err) {
    return res.status(400).json({ error: err.code || 'bad_request' });
  }
  // Same notification fields as an artist can set on themselves — useful
  // when someone gives Kudzu a number over the phone and can't be
  // bothered to log in and type it.
  const body = req.body || {};
  if (Object.prototype.hasOwnProperty.call(body, 'notifyChannel')) {
    const ch = String(body.notifyChannel);
    if (ch !== 'email' && ch !== 'sms') {
      return res.status(400).json({ error: 'bad_notify_channel' });
    }
    sets.push(`notify_channel = $${sets.length + 1}`);
    vals.push(ch);
  }
  if (Object.prototype.hasOwnProperty.call(body, 'notifyPhone')) {
    // Digits, spaces, and the usual punctuation. Not a validator — just a
    // guard against someone pasting an essay into the field.
    const raw = String(body.notifyPhone || '').trim().slice(0, 32);
    if (raw && !/^[0-9+()\-.\s]{7,32}$/.test(raw)) {
      return res.status(400).json({ error: 'bad_phone' });
    }
    sets.push(`notify_phone = $${sets.length + 1}`);
    vals.push(raw || null);
  }
  // The override, applied to somebody else's page. Pulling it down does
  // not touch a thing they own — clear the flag and the page returns
  // exactly as it was.
  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'adminHidden')) {
    sets.push(`admin_hidden = $${sets.length + 1}`);
    vals.push(!!req.body.adminHidden);
  }
  if (!sets.length) return res.status(400).json({ error: 'nothing_to_update' });
  vals.push(req.params.id);
  try {
    const { rows } = await db.query(
      `UPDATE artists SET ${sets.join(', ')}, updated_at = now()
        WHERE id = $${vals.length} RETURNING *`, vals);
    if (!rows[0]) return res.status(404).json({ error: 'not_found' });
    res.json({ artist: publicArtist(rows[0]) });
  } catch (err) {
    console.error('admin profile update failed:', err.message);
    res.status(500).json({ error: 'server_error' });
  }
});

// ── Public artist data (for the site itself) ─────────────────────────
router.get('/artists', async (_req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT a.*,
              (SELECT image_path FROM artworks w
                WHERE w.artist_id = a.id AND w.status = 'published'
             ORDER BY w.position LIMIT 1) AS cover
         FROM artists a
        WHERE kudzu_artist_public(a.id)
     ORDER BY a.name`);
    res.json({
      artists: rows.map((a) => ({
        name: a.name, slug: a.slug, photo: a.photo_path, cover: a.cover,
        worksCity: a.works_city, worksCountry: a.works_country
      }))
    });
  } catch (err) {
    res.status(500).json({ error: 'server_error' });
  }
});

// Everything published, across every artist. Feeds the virtual gallery
// and the print shop. Sold work is included so the wall doesn't develop
// gaps as pieces go — it just shows as sold.
router.get('/works', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 60, 200);
    const { rows } = await db.query(
      `SELECT w.*, a.name AS artist_name, a.slug AS artist_slug,
              a.works_city, a.works_country
         FROM artworks w
         JOIN artists a ON a.id = w.artist_id
        WHERE w.status IN ('published','sold')
          AND kudzu_artist_public(a.id)
     ORDER BY (w.status = 'sold'), w.created_at DESC
        LIMIT $1`, [limit]);

    res.json({
      works: rows.map((w) => Object.assign(publicWork(w), {
        artist: w.artist_name,
        artistSlug: w.artist_slug,
        // Where a buyer would collect it. The city only — an artist's
        // address is never published, and the exact spot is arranged
        // between the two of them.
        pickupCity: [w.works_city, w.works_country].filter(Boolean).join(', ')
      }))
    });
  } catch (err) {
    console.error('works listing failed:', err.message);
    res.status(500).json({ error: 'server_error' });
  }
});

router.get('/artists/:slug', async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT * FROM artists WHERE slug = $1 AND kudzu_artist_public(id)', [req.params.slug]);
    if (!rows[0]) return res.status(404).json({ error: 'not_found' });
    const artist = rows[0];
    const [works, books, photos] = await Promise.all([
      db.query(`SELECT * FROM artworks WHERE artist_id = $1
                  AND status IN ('published','sold') ORDER BY position`, [artist.id]),
      db.query(`SELECT * FROM books WHERE artist_id = $1
                  AND status IN ('published','sold') ORDER BY position`, [artist.id]),
      db.query(`SELECT * FROM artist_photos WHERE artist_id = $1
                ORDER BY position, created_at`, [artist.id])
    ]);
    res.json({
      artist: {
        name: artist.name, slug: artist.slug, photo: artist.photo_path,
        bio: artist.bio, cv: artist.cv, bornYear: artist.born_year,
        bornCountry: artist.born_country, worksCity: artist.works_city,
        worksCountry: artist.works_country, link: artist.link_url
      },
      works: works.rows.map((w) => Object.assign(publicWork(w), {
        pickupCity: [artist.works_city, artist.works_country].filter(Boolean).join(', ')
      })),
      books: books.rows.map(publicBook),
      photos: photos.rows.map(publicPhoto)
    });
  } catch (err) {
    res.status(500).json({ error: 'server_error' });
  }
});

// ── Error shaping ────────────────────────────────────────────────────
router.use((err, _req, res, _next) => {
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'file_too_large',
      maxMb: Math.round(storage.MAX_BYTES / 1048576) });
  }
  if (err && err.code === 'BAD_TYPE') {
    return res.status(415).json({ error: 'unsupported_type' });
  }
  console.error('api error:', err && err.message);
  res.status(500).json({ error: 'server_error' });
});

module.exports = router;
