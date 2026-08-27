// Selling: Stripe checkout, the Stripe webhook, and Buttondown signups.
//
// Ported from Ian-Patrick-Cato-.COM, adapted for Kudzu's database-backed
// artworks rather than a JSON catalogue.
//
// The webhook is mounted separately in server.js, BEFORE the JSON body
// parser — Stripe signs the raw bytes, and parsing them first breaks
// verification.

const express = require('express');
const db = require('./db');
const auth = require('./auth');
const lumaprints = require('./lumaprints');
const mail = require('./mail');
const { SHIPPING_COUNTRIES } = require('./shipping-countries');

const router = express.Router();

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const stripe = STRIPE_SECRET_KEY ? require('stripe')(STRIPE_SECRET_KEY) : null;

const BUTTONDOWN_API_KEY = process.env.BUTTONDOWN_API_KEY || '';
const BUTTONDOWN_API_BASE = 'https://api.buttondown.com/v1';

const isConfigured = () => !!stripe;

// Same alphabet as the artist-initiated handoff: no O/0, I/1 or S/5,
// because this gets read aloud across a table.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRTUVWXYZ2346789';
function makeJoinCode() {
  const bytes = require('crypto').randomBytes(6);
  return Array.from(bytes).map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

function baseUrl(req) {
  return process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
}

// ── Newsletter ───────────────────────────────────────────────────────
router.post('/subscribe', async (req, res) => {
  const email = String((req.body && req.body.email) || '').trim();
  const name = String((req.body && req.body.name) || '').trim();

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return res.status(400).json({ error: 'Please provide a valid email address.' });
  }
  if (!BUTTONDOWN_API_KEY) {
    return res.status(503).json({ error: 'newsletter_unavailable' });
  }

  try {
    const bd = await fetch(`${BUTTONDOWN_API_BASE}/subscribers`, {
      method: 'POST',
      headers: {
        Authorization: `Token ${BUTTONDOWN_API_KEY}`,
        'Content-Type': 'application/json'
      },
      // type 'regular' skips Buttondown's double opt-in — they opted in
      // by submitting the form here.
      body: JSON.stringify({
        email_address: email,
        metadata: name ? { name } : undefined,
        type: 'regular'
      })
    });

    if (bd.status === 409) return res.json({ ok: true, alreadySubscribed: true });
    if (!bd.ok) {
      console.error('buttondown sync failed:', await bd.text());
      return res.status(502).json({ error: 'newsletter_failed' });
    }
    res.json({ ok: true, alreadySubscribed: false });
  } catch (err) {
    console.error('buttondown error:', err.message);
    res.status(502).json({ error: 'newsletter_failed' });
  }
});

// ── Stripe Connect: artist payouts ───────────────────────────────────
// Each artist gets their own Stripe account. Buyers pay them directly;
// Kudzu's commission is skimmed as an application fee in transit. Kudzu
// never holds artist funds, which keeps this out of money-transmitter
// territory and means a Kudzu outage can't strand anyone's money.
//
// Onboarding is Stripe's own hosted flow — bank details and ID never
// touch this server.

// Start (or resume) onboarding. Returns a URL to send the artist to.
router.post('/connect/start', auth.requireArtist, async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'payments_unavailable' });

  try {
    let acct = req.artist.stripe_account;

    if (!acct) {
      const created = await stripe.accounts.create({
        type: 'express',
        email: req.artist.email,
        business_profile: {
          name: req.artist.name,
          product_description: 'Original artwork and prints sold through Kudzu Arts'
        },
        capabilities: {
          transfers: { requested: true },
          card_payments: { requested: true },
          // Buy-now-pay-later at checkout. Express accounts have no
          // Stripe Dashboard of their own, so the capability has to be
          // requested by the platform or Klarna never appears.
          klarna_payments: { requested: true }
        },
        metadata: { kudzu_artist_id: String(req.artist.id) }
      });
      acct = created.id;

      // Saved immediately. If the artist abandons onboarding halfway,
      // returning later resumes the same account rather than orphaning
      // it and starting again.
      await db.query(
        'UPDATE artists SET stripe_account = $1, updated_at = now() WHERE id = $2',
        [acct, req.artist.id]);
    } else {
      // Accounts created before Klarna was switched on don't have the
      // capability. Ask for it once, on the way back through onboarding.
      try {
        const existing = await stripe.accounts.retrieve(acct);
        const klarna = existing.capabilities && existing.capabilities.klarna_payments;
        if (!klarna) {
          await stripe.accounts.update(acct, {
            capabilities: { klarna_payments: { requested: true } }
          });
        }
      } catch (err) {
        // Not worth blocking onboarding over — card payments still work.
        console.error('klarna capability request failed:', err.message);
      }
    }

    const site = baseUrl(req);
    const link = await stripe.accountLinks.create({
      account: acct,
      type: 'account_onboarding',
      refresh_url: `${site}/api/connect/start`,
      return_url: `${site}/workinprogress/profile.html?connected=1`
    });

    res.json({ url: link.url });
  } catch (err) {
    console.error('connect start failed:', err.message);
    res.status(500).json({ error: 'connect_failed' });
  }
});

// Is the account actually ready to receive money? Having an account id
// is not the same as having finished onboarding — Stripe may still be
// waiting on ID or bank details.
router.get('/connect/status', auth.requireArtist, async (req, res) => {
  if (!stripe) return res.json({ connected: false, reason: 'payments_unavailable' });
  if (!req.artist.stripe_account) return res.json({ connected: false, reason: 'not_started' });

  try {
    const acct = await stripe.accounts.retrieve(req.artist.stripe_account);
    const ready = !!(acct.charges_enabled && acct.payouts_enabled);

    // The webhook is the usual way this flag moves, but an artist landing
    // back here from Stripe's onboarding shouldn't have to wait on it —
    // and if the event was never delivered, this is what heals them.
    if (ready !== !!req.artist.stripe_ready) {
      await db.query(
        'UPDATE artists SET stripe_ready = $1, updated_at = now() WHERE id = $2',
        [ready, req.artist.id]).catch((err) =>
          console.error('connect status persist failed:', err.message));
    }

    res.json({
      connected: ready,
      reason: ready ? null : 'incomplete',
      needs: (acct.requirements && acct.requirements.currently_due) || [],
      chargesEnabled: !!acct.charges_enabled,
      payoutsEnabled: !!acct.payouts_enabled
    });
  } catch (err) {
    console.error('connect status failed:', err.message);
    res.status(500).json({ error: 'status_failed' });
  }
});

// A link into Stripe's own dashboard, so artists can see their sales,
// change bank details, and download tax documents themselves.
router.post('/connect/dashboard', auth.requireArtist, async (req, res) => {
  if (!stripe || !req.artist.stripe_account) {
    return res.status(409).json({ error: 'not_connected' });
  }
  try {
    const link = await stripe.accounts.createLoginLink(req.artist.stripe_account);
    res.json({ url: link.url });
  } catch (err) {
    console.error('dashboard link failed:', err.message);
    res.status(500).json({ error: 'dashboard_failed' });
  }
});

// How long a piece is held once someone opens checkout on it. Thirty
// minutes is the shortest expiry Stripe will put on a session, and the
// hold is matched to it deliberately — see the schema note.
const HOLD_SECONDS = 30 * 60;

// ── Checkout ─────────────────────────────────────────────────────────
// Buying an original. Price and title come from the database, never from
// the browser — otherwise anyone could set their own price.
router.post('/checkout/work/:id', async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'payments_unavailable' });
  if (!db.isReady()) return res.status(503).json({ error: 'backend_unavailable' });

  try {
    const { rows } = await db.query(
      `SELECT w.*, a.name AS artist_name, a.stripe_account, a.stripe_ready,
              a.works_city, a.works_country
         FROM artworks w JOIN artists a ON a.id = w.artist_id
        WHERE w.id = $1`, [req.params.id]);
    const work = rows[0];

    if (!work) return res.status(404).json({ error: 'not_found' });
    if (work.status === 'sold') return res.status(409).json({ error: 'already_sold' });
    if (work.status !== 'published') return res.status(404).json({ error: 'not_for_sale' });
    if (!work.for_sale || !work.price_cents) return res.status(409).json({ error: 'not_for_sale' });

    // Kudzu never holds an artist's money. Without a connected Stripe
    // account there is nowhere for the payout to land, so the sale is
    // refused rather than taken. Belt and braces: the database also
    // refuses to publish a priced work under these conditions.
    // Having an account id is not the same as being able to receive
    // money. Checking readiness here as well means a buyer gets an honest
    // refusal rather than a 500 from Stripe rejecting the destination.
    if (!work.stripe_account || !work.stripe_ready) {
      return res.status(409).json({ error: 'artist_payout_not_set_up' });
    }

    // Claim the piece. One UPDATE, so two simultaneous buyers cannot both
    // win it — Postgres serialises them and the loser matches no row.
    // An expired hold is claimable again, which is what makes an
    // abandoned checkout self-healing even if Stripe never tells us.
    const claim = await db.query(
      `UPDATE artworks
          SET reserved_until = now() + ($2 || ' seconds')::interval,
              reserved_session = 'pending'
        WHERE id = $1 AND status = 'published'
          AND (reserved_until IS NULL OR reserved_until < now())
    RETURNING id`, [work.id, String(HOLD_SECONDS)]);

    if (!claim.rows[0]) {
      return res.status(409).json({ error: 'being_bought' });
    }

    const site = baseUrl(req);
    const commissionPct = Number(process.env.KUDZU_COMMISSION_PCT || 25);

    // Local pickup, if the buyer asked for it and the artist offers it on
    // this piece. The two paths differ in one important way, and it is
    // the only place Kudzu ever touches an artist's money.
    // Pickup needs two things: the artist offered it on this piece, and
    // they have a location. Checked here as well as in the browser,
    // because the browser is never trusted.
    const wantsPickup = String((req.body || {}).delivery || '') === 'pickup';
    const hasLocation = !!String(work.works_city || '').trim();
    const isPickup = wantsPickup && work.pickup_ok && hasLocation;
    if (wantsPickup && !isPickup) {
      return res.status(409).json({ error: 'pickup_not_offered' });
    }

    // Both paths pay the artist the same way: the buyer's money goes
    // straight to the artist's own Stripe account, and Kudzu's commission
    // is taken as an application fee on the way past. Kudzu never holds
    // an artist's money, on either route.
    //
    // An earlier design held pickup payments until a bill of lading was
    // signed. Dropped deliberately: it made Kudzu a custodian of artist
    // funds, and it punished the artist when a buyer simply never turned
    // up — they'd be sitting on the work AND waiting on the money. A sale
    // is a sale. The bill of lading is still signed at the handoff, but
    // as a legal record of delivery rather than a condition of payment.
    const transfer = {
      transfer_data: { destination: work.stripe_account },
      application_fee_amount: Math.round(work.price_cents * commissionPct / 100)
    };

    // No payment_method_types here on purpose: that leaves Checkout on
    // automatic payment methods, so Klarna (pay in 4, or financing on
    // larger pieces) shows up on its own for buyers who qualify, and
    // quietly doesn't for those who don't — no per-price special-casing
    // here. Klarna has to be enabled once in the Stripe Dashboard, and
    // the artist's connected account needs the klarna_payments
    // capability, which /connect/start requests above.
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      // Matched to the hold above. Thirty minutes is Stripe's floor.
      expires_at: Math.floor(Date.now() / 1000) + HOLD_SECONDS,
      line_items: [{
        quantity: 1,
        price_data: {
          currency: work.currency || 'usd',
          unit_amount: work.price_cents,
          product_data: {
            name: work.title,
            description: `${work.artist_name}${work.year ? ', ' + work.year : ''}` +
                         `${work.medium ? ' · ' + work.medium : ''}`,
            images: [`${site}${work.image_path}`]
          }
        }
      }],
      payment_intent_data: transfer,
      // Nothing to ship, so nothing to ask for. The artist's city is
      // already on their page; exactly where to meet is arranged between
      // the two of them, not published here.
      ...(isPickup ? {} : {
        shipping_address_collection: { allowed_countries: SHIPPING_COUNTRIES }
      }),
      phone_number_collection: { enabled: true },
      // A real page. This used to point at the gallery with a ?bought=
      // parameter that nothing read, so someone who had just spent a few
      // thousand dollars was returned to a grid of paintings with no
      // acknowledgement that anything had happened.
      success_url: `${site}/workinprogress/order.html?session={CHECKOUT_SESSION_ID}`,
      cancel_url: `${site}/workinprogress/piece-${work.id}.html`,
      metadata: {
        kind: 'original',
        workId: String(work.id),
        artistId: String(work.artist_id),
        // Copied so a piece deleted mid-checkout can still be fulfilled.
        workTitle: String(work.title || '').slice(0, 200),
        delivery: isPickup ? 'pickup' : 'ship',
        // Recorded now so the payout can't be recalculated later against
        // a price that has since been edited.
        payoutCents: String(work.price_cents - Math.round(work.price_cents * commissionPct / 100))
      }
    });

    // Tie the hold to the session, so the expiry webhook can find it.
    await db.query(
      'UPDATE artworks SET reserved_session = $1 WHERE id = $2', [session.id, work.id])
      .catch((err) => console.error('reservation tag failed:', err.message));

    res.json({ url: session.url });
  } catch (err) {
    console.error('checkout failed:', err.message);
    // Never leave a piece held for a checkout that never opened.
    await db.query(
      `UPDATE artworks SET reserved_until = NULL, reserved_session = NULL
        WHERE id = $1 AND reserved_session = 'pending'`, [req.params.id])
      .catch(() => {});
    res.status(500).json({ error: 'checkout_failed' });
  }
});


// Stripe tells us when a session is abandoned. Releasing on that event
// rather than waiting out the clock is what keeps a piece from looking
// sold-out for half an hour because somebody closed a tab.
async function releaseHold(session) {
  if (!db.isReady()) return;
  const { rowCount } = await db.query(
    `UPDATE artworks SET reserved_until = NULL, reserved_session = NULL
      WHERE reserved_session = $1 AND status <> 'sold'`, [session.id]);
  if (rowCount) console.log('checkout abandoned, released hold for session', session.id);
}

// ── Webhook ──────────────────────────────────────────────────────────
// Mounted in server.js with express.raw() so the signature can be checked.
function webhookHandler(req, res) {
  if (!stripe || !STRIPE_WEBHOOK_SECRET) {
    return res.status(503).send('Stripe is not configured');
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body, req.headers['stripe-signature'], STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('stripe webhook signature failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // The work happens before the answer, on purpose. This used to send
  // 200 first and fulfil afterwards, which told Stripe the event was
  // delivered and permanently gave up any retry — so a deploy, a restart,
  // or a database blip mid-fulfilment lost the sale outright, silently.
  //
  // Everything awaited here is database work; the emails are fired and
  // not waited on, so this stays well inside Stripe's timeout. If it does
  // throw, answering 5xx is what earns the retry.
  const handlers = {
    'checkout.session.completed': fulfil,
    'checkout.session.expired':   releaseHold,
    // An artist finished — or lost — their Stripe onboarding.
    'account.updated':            syncConnectState,

    // Money going back the other way. Neither of these used to be handled
    // at all: a refunded piece stayed marked sold forever, and a
    // chargeback was completely invisible — the first anyone would know
    // is when the artist noticed money missing weeks later.
    'charge.refunded': (charge) => markReversed(charge, 'refunded'),
    'charge.dispute.created': (dispute) => markReversed(
      // The event carries the dispute; the charge id is on it.
      { payment_intent: dispute.payment_intent, id: dispute.charge }, 'disputed')
  };

  const handle = handlers[event.type];
  if (!handle) return res.status(200).send('ok');

  handle(event.data.object).then(
    () => res.status(200).send('ok'),
    (err) => {
      console.error(event.type, 'failed for', event.data.object.id, '—', err.message);
      res.status(500).send('handler failed');
    });
}

// Find the order behind a charge and record what happened to it.
//
// A refund puts the work back on sale — it didn't sell, so it shouldn't
// read as sold. A dispute deliberately does NOT: the money is only
// provisionally gone, the piece may well be in the buyer's hands, and
// quietly relisting something that might still be someone else's is worse
// than leaving it marked sold while it's argued about.
async function markReversed(charge, kind) {
  if (!db.isReady()) return;

  // Charges made through Checkout carry the session's payment_intent, so
  // that's the reliable way back to the order we wrote.
  const pi = charge.payment_intent;
  if (!pi) return;

  let sessionId = null;
  try {
    const list = await stripe.checkout.sessions.list({ payment_intent: pi, limit: 1 });
    sessionId = list.data[0] ? list.data[0].id : null;
  } catch (err) {
    console.error('could not resolve session for payment_intent', pi, '—', err.message);
  }
  if (!sessionId) return;

  const column = kind === 'refunded' ? 'refunded_at' : 'disputed_at';
  const { rows } = await db.query(
    `UPDATE orders SET ${column} = now()
      WHERE stripe_session_id = $1 AND ${column} IS NULL
  RETURNING *`, [sessionId]);
  if (!rows[0]) return;

  const order = rows[0];
  console.log(kind, 'recorded for order', order.id, '—', order.work_title);

  if (kind === 'refunded' && order.artwork_id) {
    // Back to the wall. `published` rather than `draft`, because the
    // artist did nothing wrong and shouldn't have to re-publish a piece
    // that a buyer changed their mind about. The schema's own rules still
    // apply — if their Stripe has since lapsed, the trigger drops it.
    await db.query(
      `UPDATE artworks SET status = 'published', sold_at = NULL, updated_at = now()
        WHERE id = $1 AND status = 'sold'`, [order.artwork_id]);
  }

  try {
    const { rows: ar } = await db.query(
      'SELECT id, name, email, notify_channel FROM artists WHERE id = $1', [order.artist_id]);
    if (ar[0]) {
      await mail.saleReversed({ artist: ar[0], order, kind });
    }
  } catch (err) {
    console.error('reversal notification failed:', err.message);
  }
}

// Stripe considers an account usable only when it can both take charges
// and pay out. This tracks that state on `stripe_ready`, which the
// database trigger uses to pull work back to draft and put it back up.
//
// It moves in both directions, which is the whole point. Stripe raises
// requirements routinely — an expiring ID, a periodic bank re-check — and
// clears them again a day later. An earlier version only ever set the
// unusable state, by wiping `stripe_account`, so an artist who tripped
// one of those was stuck: work down, field empty, and the next click
// opened a second Express account orphaning the first.
//
// The account id is never cleared here now. It is matched on directly, or
// on the artist id stamped into the account's metadata at creation — the
// latter covering accounts orphaned by that earlier behaviour, so those
// artists heal on the next event Stripe sends.
async function syncConnectState(account) {
  if (!db.isReady()) return;
  const ready = !!(account.charges_enabled && account.payouts_enabled);
  const artistId = (account.metadata && account.metadata.kudzu_artist_id) || null;

  try {
    const { rowCount } = await db.query(
      `UPDATE artists
          SET stripe_account = $1, stripe_ready = $2, updated_at = now()
        WHERE (stripe_account = $1 OR (id::text = $3 AND stripe_account IS NULL))
          AND stripe_ready IS DISTINCT FROM $2`,
      [account.id, ready, artistId]);

    if (rowCount) {
      console.log(ready
        ? 'connect account ready, work can go back up for ' + account.id
        : 'connect account not usable, unpublished work for ' + account.id);
    }
  } catch (err) {
    console.error('connect sync failed for', account.id, '—', err.message);
  }
}

// How long an artist has to get a piece into the post. Ten working days:
// long enough for someone who stretches their own canvas and has a day
// job, short enough that a buyer isn't left guessing. Weekends skipped
// because "two weeks" quietly means eighteen days to a person waiting.
//
// Public holidays are not modelled. Adding a calendar for them buys a day
// of accuracy and costs a dependency that has to be maintained forever.
const SHIP_DAYS = parseInt(process.env.KUDZU_SHIP_DAYS || '10', 10);

function shipByDate(from, days) {
  const d = new Date(from.getTime());
  let left = days;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const day = d.getUTCDay();
    if (day !== 0 && day !== 6) left--;
  }
  return d.toISOString().slice(0, 10);
}

// Write down the sale. Idempotent through the unique constraint on
// stripe_session_id rather than through a check-then-insert, because two
// webhook retries can overlap and only the database can settle that.
async function recordOrder(session, md, work) {
  const details = await db.query(
    'SELECT medium, year, dimensions FROM artworks WHERE id = $1', [md.workId]);
  const d = details.rows[0] || {};
  const cd = session.customer_details || {};
  const sd = session.shipping_details || {};
  const addr = sd.address || {};
  const isPickup = md.delivery === 'pickup';

  const { rows } = await db.query(
    `INSERT INTO orders
       (artwork_id, artist_id, work_title, work_details, price_cents, currency,
        payout_cents, delivery, buyer_name, buyer_email, buyer_phone,
        ship_name, ship_line1, ship_line2, ship_city, ship_state, ship_postal,
        ship_country, ship_by, stripe_session_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
     ON CONFLICT (stripe_session_id) DO NOTHING
     RETURNING *`,
    [md.workId, work.artist_id, work.title,
     [d.medium, d.year, d.dimensions].filter(Boolean).join(' · ') || null,
     session.amount_total, session.currency || 'usd',
     parseInt(md.payoutCents, 10) || null,
     isPickup ? 'pickup' : 'ship',
     cd.name || sd.name || 'Buyer', cd.email || '', cd.phone || null,
     isPickup ? null : (sd.name || cd.name || null),
     isPickup ? null : (addr.line1 || null),
     isPickup ? null : (addr.line2 || null),
     isPickup ? null : (addr.city || null),
     isPickup ? null : (addr.state || null),
     isPickup ? null : (addr.postal_code || null),
     isPickup ? null : (addr.country || null),
     // A pickup has no posting deadline — the two of them agree a time.
     isPickup ? null : shipByDate(new Date(), SHIP_DAYS),
     session.id]);

  if (!rows[0]) return null;                  // a retry; already recorded

  if (!isPickup && !rows[0].ship_line1) {
    console.error('order', rows[0].id, 'has no shipping address — session', session.id);
  }
  return rows[0];
}

async function fulfil(session) {
  const md = session.metadata || {};

  if (md.kind === 'original' && md.workId) {
    // Read the piece without changing it. If it has been deleted since
    // checkout opened, the metadata stamped on the session still carries
    // what fulfilment needs — the sale happened and has to land.
    const { rows: w } = await db.query(
      'SELECT title, artist_id FROM artworks WHERE id = $1', [md.workId]);
    const work = w[0] || { title: md.workTitle || 'Untitled', artist_id: md.artistId || null };
    if (!w[0]) {
      console.error('artwork', md.workId, 'no longer exists — fulfilling from session metadata');
    }

    // The order is written FIRST, and it is the guard for everything
    // below: `orders` has a unique constraint on the session id, so a
    // Stripe retry gets null back here and nothing happens twice.
    //
    // The artwork's status transition used to play that role, which meant
    // any case where it matched no rows — a second buyer on the same
    // piece, a deleted work, a momentary database error — threw away the
    // order, both emails, and the one copy of the shipping address Stripe
    // ever hands over, after the buyer had already been charged.
    //
    // A throw here is deliberately not caught. The webhook then answers
    // 5xx and Stripe retries, which is the only way a transient failure
    // gets a second chance at that address.
    const order = await recordOrder(session, md, work);
    if (!order) return;                       // already fulfilled

    await db.query(
      `UPDATE artworks
          SET status = 'sold', sold_at = now(), updated_at = now(),
              reserved_until = NULL, reserved_session = NULL
        WHERE id = $1 AND status <> 'sold'`, [md.workId]);
    console.log('marked sold:', md.workId, 'session', session.id);

    {
      const { rows: ar } = await db.query(
        `SELECT id, name, email, notify_channel, notify_phone, works_city
           FROM artists WHERE id = $1`,
        [work.artist_id]);

      // A pickup sale is not finished when the money arrives — it's
      // finished when the work is in the buyer's hands and both have
      // signed. Open the handoff now so the artist has a code ready
      // before the buyer turns up.
      if (md.delivery === 'pickup') {
        try {
          const details = await db.query(
            'SELECT medium, year, dimensions FROM artworks WHERE id = $1', [md.workId]);
          const d = details.rows[0] || {};
          const cd = session.customer_details || {};

          const opened = await db.query(
            `INSERT INTO bills_of_lading
               (artwork_id, artist_id, work_title, work_details, price_cents, currency,
                buyer_name, buyer_email, buyer_phone, pickup_city,
                join_code, stripe_session_id, payout_cents)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
             ON CONFLICT DO NOTHING
             RETURNING *`,
            [md.workId, work.artist_id, work.title,
             [d.medium, d.year, d.dimensions].filter(Boolean).join(' · ') || null,
             session.amount_total, session.currency || 'usd',
             cd.name || 'Buyer', cd.email || '',
             // Stripe already asks for a phone at checkout. Coordinating a
             // doorstep meeting over email alone is miserable.
             cd.phone || null, ar[0] ? ar[0].works_city || null : null,
             makeJoinCode(), session.id,
             // Recorded on the document for reference. Payment already
             // went to the artist at checkout; nothing here releases it.
             parseInt(md.payoutCents, 10) || null]);

          // The introduction. Nothing else in the system gives these two
          // people a way to reach each other, so this is the whole
          // mechanism — and it must fire exactly once, because Stripe
          // retries webhooks and being introduced twice reads as a bug.
          //
          // ON CONFLICT DO NOTHING means a retry returns no row, so the
          // insert itself is the guard. `intro_sent_at` catches the rest.
          if (opened.rows[0] && ar[0]) {
            const bol = opened.rows[0];
            const claimed = await db.query(
              `UPDATE bills_of_lading SET intro_sent_at = now()
                WHERE id = $1 AND intro_sent_at IS NULL`, [bol.id]);
            if (claimed.rowCount) {
              mail.pickupIntroduction({ bol, artist: ar[0] })
                .catch((err) => console.error('pickup introduction failed:', err.message));
            }
          }
        } catch (err) {
          console.error('could not open handoff for', md.workId, '—', err.message);
        }
      }

      if (ar[0]) {
        mail.workSold({
          artist: ar[0],
          workTitle: work.title,
          amountCents: session.amount_total,
          currency: session.currency,
          isPickup: md.delivery === 'pickup',
          // Carries the address and the deadline, so the artist can start
          // packing from the email without going to look anything up.
          order
        }).catch((err) => console.error('sale notification failed:', err.message));
      }

      // And the buyer hears from us. On a pickup the introduction already
      // covers it; on a shipped sale this is the only thing Kudzu sends
      // them, and without it their entire experience is a card charge and
      // then a month of nothing.
      if (order && order.delivery === 'ship') {
        const claimed = await db.query(
          `UPDATE orders SET confirmation_sent_at = now()
            WHERE id = $1 AND confirmation_sent_at IS NULL`, [order.id]);
        if (claimed.rowCount) {
          mail.orderConfirmation({ order, artistName: ar[0] ? ar[0].name : null })
            .catch((err) => console.error('order confirmation failed:', err.message));
        }
      }
    }
    return;
  }

  if (md.kind === 'print') {
    await fulfilPrint(session);
  }
}

// Hand a print order to Lumaprints for printing and shipping.
async function fulfilPrint(session) {
  if (!lumaprints.isConfigured()) {
    console.error('print sold but Lumaprints is not configured — session', session.id);
    return;
  }

  const md = session.metadata || {};
  const shipping = session.shipping_details;
  const addr = shipping && shipping.address;
  if (!addr) throw new Error('no shipping address on session ' + session.id);

  const fullName = (shipping.name ||
    (session.customer_details && session.customer_details.name) || 'Customer').trim();
  const cut = fullName.indexOf(' ');
  const firstName = cut === -1 ? fullName : fullName.slice(0, cut);
  const lastName = cut === -1 ? '-' : fullName.slice(cut + 1);

  const result = await lumaprints.submitOrder({
    externalId: session.id,
    subcategoryId: Number(md.subcategoryId),
    width: Number(md.width),
    height: Number(md.height),
    imageUrl: md.imageUrl,
    recipient: {
      firstName, lastName,
      addressLine1: addr.line1,
      addressLine2: addr.line2 || '',
      city: addr.city,
      state: addr.state,
      zipCode: addr.postal_code,
      country: addr.country,
      phone: (session.customer_details && session.customer_details.phone) || ''
    }
  });

  console.log('lumaprints order', result.orderNumber, 'for session', session.id);
}

module.exports = {
  router, webhookHandler, isConfigured,
  // Exposed so the fulfilment path can be exercised against a stubbed
  // database and Stripe. This is the code that runs when money moves and
  // it is the hardest thing here to test by hand — reaching it needs a
  // real card, a real webhook, and a piece you're willing to sell.
  _fulfil: fulfil,
  _shipByDate: shipByDate
};
