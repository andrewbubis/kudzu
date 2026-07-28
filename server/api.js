// The account API. Everything under /api.
//
// Rule followed throughout: the browser is never trusted. Ownership,
// the six-work limit, file type and size are all re-checked here even
// though the page checks them too.

const express = require('express');
const db = require('./db');
const auth = require('./auth');
const storage = require('./storage');

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
  published: a.published,
  stripeConnected: !!a.stripe_account
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
  position: w.position
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
    const [works, books] = await Promise.all([
      db.query('SELECT * FROM artworks WHERE artist_id = $1 ORDER BY position, created_at', [req.artist.id]),
      db.query('SELECT * FROM books    WHERE artist_id = $1 ORDER BY position, created_at', [req.artist.id])
    ]);
    res.json({
      artist: publicArtist(req.artist),
      works: works.rows.map(publicWork),
      books: books.rows.map(publicBook)
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

router.patch('/me', auth.requireArtist, async (req, res) => {
  const sets = [], vals = [];
  for (const [key, col] of Object.entries(PROFILE_FIELDS)) {
    if (req.body && Object.prototype.hasOwnProperty.call(req.body, key)) {
      let v = req.body[key];
      if (key === 'bornYear') {
        v = v === '' || v == null ? null : parseInt(v, 10);
        if (v != null && (!Number.isFinite(v) || v < 1850 || v > 2100)) {
          return res.status(400).json({ error: 'bad_year' });
        }
      } else if (typeof v === 'string') {
        v = v.trim().slice(0, key === 'bio' || key === 'cv' ? 8000 : 200) || null;
      }
      if (key === 'link' && v && !/^https?:\/\//i.test(v)) v = 'https://' + v;
      sets.push(`${col} = $${sets.length + 1}`);
      vals.push(v);
    }
  }
  if (!sets.length) return res.status(400).json({ error: 'nothing_to_update' });
  vals.push(req.artist.id);
  try {
    const { rows } = await db.query(
      `UPDATE artists SET ${sets.join(', ')}, updated_at = now()
        WHERE id = $${vals.length} RETURNING *`, vals);
    res.json({ artist: publicArtist(rows[0]) });
  } catch (err) {
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

// ── Works ────────────────────────────────────────────────────────────
function parseWorkFields(body) {
  const price = body.priceCents === '' || body.priceCents == null
    ? null : Math.round(Number(body.priceCents));
  return {
    title: String(body.title || '').trim().slice(0, 200),
    year: body.year ? parseInt(body.year, 10) || null : null,
    medium: body.medium ? String(body.medium).trim().slice(0, 120) : null,
    dimensions: body.dimensions ? String(body.dimensions).trim().slice(0, 120) : null,
    priceCents: Number.isFinite(price) && price >= 0 ? price : null
  };
}

router.post('/works', auth.requireArtist, storage.upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no_file' });
  const f = parseWorkFields(req.body || {});
  if (!f.title) return res.status(400).json({ error: 'title_required' });

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
          image_path, image_w, image_h, status, position)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'draft',
               COALESCE((SELECT max(position)+1 FROM artworks WHERE artist_id = $1), 0))
       RETURNING *`,
      [req.artist.id, f.title, f.year, f.medium, f.dimensions, f.priceCents,
       saved.path, saved.width, saved.height]);
    res.status(201).json(publicWork(rows[0]));
  } catch (err) {
    storage.remove(saved.path);
    console.error('work insert failed:', err.message);
    res.status(500).json({ error: 'server_error' });
  }
});

router.patch('/works/:id', auth.requireArtist, async (req, res) => {
  const body = req.body || {};
  const sets = [], vals = [];
  const map = { title: 'title', year: 'year', medium: 'medium',
                dimensions: 'dimensions', priceCents: 'price_cents',
                forSale: 'for_sale', status: 'status', position: 'position' };
  for (const [key, col] of Object.entries(map)) {
    if (Object.prototype.hasOwnProperty.call(body, key)) {
      if (key === 'status' && !['draft', 'published'].includes(body[key])) {
        return res.status(400).json({ error: 'bad_status' }); // 'sold' is set by Stripe, not the artist
      }
      sets.push(`${col} = $${sets.length + 1}`);
      vals.push(body[key]);
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
    if (String(err.message).includes('publish_limit_reached')) {
      return res.status(409).json({ error: 'publish_limit_reached' });
    }
    if (String(err.message).includes('stripe_not_connected')) {
      return res.status(409).json({ error: 'stripe_not_connected' });
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
      'SELECT id FROM artists WHERE slug = $1 AND published = true',
      [String(b.artistSlug || '')]);
    if (!ar[0]) return res.status(404).json({ error: 'artist_not_found' });

    // Same for the artwork — it must belong to that artist.
    let artworkId = null;
    if (b.workId) {
      const { rows: wr } = await db.query(
        'SELECT id FROM artworks WHERE id = $1 AND artist_id = $2',
        [b.workId, ar[0].id]);
      if (wr[0]) artworkId = wr[0].id;
    }

    await db.query(
      `INSERT INTO inquiries (artist_id, artwork_id, name, email, message)
       VALUES ($1,$2,$3,$4,$5)`,
      [ar[0].id, artworkId, name, email, message]);

    res.status(201).json({ ok: true });
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

// ── Public artist data (for the site itself) ─────────────────────────
router.get('/artists', async (_req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT a.*,
              (SELECT image_path FROM artworks w
                WHERE w.artist_id = a.id AND w.status = 'published'
             ORDER BY w.position LIMIT 1) AS cover
         FROM artists a
        WHERE a.published = true
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
      `SELECT w.*, a.name AS artist_name, a.slug AS artist_slug
         FROM artworks w
         JOIN artists a ON a.id = w.artist_id
        WHERE w.status IN ('published','sold')
          AND a.published = true
     ORDER BY (w.status = 'sold'), w.created_at DESC
        LIMIT $1`, [limit]);

    res.json({
      works: rows.map((w) => Object.assign(publicWork(w), {
        artist: w.artist_name,
        artistSlug: w.artist_slug
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
      'SELECT * FROM artists WHERE slug = $1 AND published = true', [req.params.slug]);
    if (!rows[0]) return res.status(404).json({ error: 'not_found' });
    const artist = rows[0];
    const [works, books] = await Promise.all([
      db.query(`SELECT * FROM artworks WHERE artist_id = $1
                  AND status IN ('published','sold') ORDER BY position`, [artist.id]),
      db.query(`SELECT * FROM books WHERE artist_id = $1
                  AND status IN ('published','sold') ORDER BY position`, [artist.id])
    ]);
    res.json({
      artist: {
        name: artist.name, slug: artist.slug, photo: artist.photo_path,
        bio: artist.bio, cv: artist.cv, bornYear: artist.born_year,
        bornCountry: artist.born_country, worksCity: artist.works_city,
        worksCountry: artist.works_country, link: artist.link_url
      },
      works: works.rows.map(publicWork),
      books: books.rows.map(publicBook)
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
