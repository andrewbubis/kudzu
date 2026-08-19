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

// ── Checkout ─────────────────────────────────────────────────────────
// Buying an original. Price and title come from the database, never from
// the browser — otherwise anyone could set their own price.
router.post('/checkout/work/:id', async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'payments_unavailable' });
  if (!db.isReady()) return res.status(503).json({ error: 'backend_unavailable' });

  try {
    const { rows } = await db.query(
      `SELECT w.*, a.name AS artist_name, a.stripe_account,
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
    if (!work.stripe_account) {
      return res.status(409).json({ error: 'artist_payout_not_set_up' });
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

    // Shipped: the buyer's money goes straight to the artist's own Stripe
    // account and Kudzu's commission is taken as an application fee on
    // the way past. It never sits in a Kudzu balance.
    //
    // Pickup: no transfer here. A hand-to-hand sale leaves no carrier
    // record, so the payment stays on the platform until both parties
    // have signed a bill of lading, then it is transferred. Without that
    // hold nobody would file the document, and the first chargeback would
    // arrive with no proof of delivery to answer it.
    const transfer = isPickup ? {} : {
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
      success_url: `${site}/workinprogress/gallery.html?bought=${work.id}`,
      cancel_url: `${site}/workinprogress/piece-${work.id}.html`,
      metadata: {
        kind: 'original',
        workId: String(work.id),
        artistId: String(work.artist_id),
        delivery: isPickup ? 'pickup' : 'ship',
        // Recorded now so the payout can't be recalculated later against
        // a price that has since been edited.
        payoutCents: String(work.price_cents - Math.round(work.price_cents * commissionPct / 100))
      }
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('checkout failed:', err.message);
    res.status(500).json({ error: 'checkout_failed' });
  }
});

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

  // Answer immediately — Stripe retries anything slow. Fulfilment
  // continues after the response.
  res.status(200).send('ok');

  if (event.type === 'checkout.session.completed') {
    fulfil(event.data.object).catch((err) => {
      console.error('fulfilment failed for session', event.data.object.id, err.message);
    });
  }

  // An artist finished — or lost — their Stripe onboarding.
  if (event.type === 'account.updated') {
    syncConnectState(event.data.object).catch((err) => {
      console.error('connect sync failed:', err.message);
    });
  }
}

// Stripe considers an account usable only when it can both take charges
// and pay out. Anything less and we clear it, which the database trigger
// then uses to pull that artist's work back to draft.
async function syncConnectState(account) {
  if (!db.isReady()) return;
  const ready = !!(account.charges_enabled && account.payouts_enabled);
  if (ready) return;

  const { rowCount } = await db.query(
    `UPDATE artists SET stripe_account = NULL, updated_at = now()
      WHERE stripe_account = $1`, [account.id]);
  if (rowCount) {
    console.log('connect account no longer usable, unpublished work for', account.id);
  }
}

async function fulfil(session) {
  const md = session.metadata || {};

  if (md.kind === 'original' && md.workId) {
    const { rows } = await db.query(
      `UPDATE artworks SET status = 'sold', sold_at = now(), updated_at = now()
        WHERE id = $1 AND status <> 'sold'
    RETURNING title, artist_id`, [md.workId]);
    console.log('marked sold:', md.workId, 'session', session.id);

    // Only on the transition — Stripe retries webhooks, and an artist
    // should not be told twice that the same piece sold.
    if (rows[0]) {
      const { rows: ar } = await db.query(
        'SELECT id, name, email, notify_channel, notify_phone FROM artists WHERE id = $1',
        [rows[0].artist_id]);

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

          await db.query(
            `INSERT INTO bills_of_lading
               (artwork_id, artist_id, work_title, work_details, price_cents, currency,
                buyer_name, buyer_email, join_code, stripe_session_id, payout_cents)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
             ON CONFLICT DO NOTHING`,
            [md.workId, rows[0].artist_id, rows[0].title,
             [d.medium, d.year, d.dimensions].filter(Boolean).join(' · ') || null,
             session.amount_total, session.currency || 'usd',
             cd.name || 'Buyer', cd.email || '',
             makeJoinCode(), session.id,
             parseInt(md.payoutCents, 10) || null]);
        } catch (err) {
          console.error('could not open handoff for', md.workId, '—', err.message);
        }
      }

      if (ar[0]) {
        mail.workSold({
          artist: ar[0],
          workTitle: rows[0].title,
          amountCents: session.amount_total,
          currency: session.currency,
          isPickup: md.delivery === 'pickup'
        }).catch((err) => console.error('sale notification failed:', err.message));
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

// ── Releasing a held pickup payout ───────────────────────────────────
// Shipped sales never come through here: those are destination charges
// and the artist is paid at checkout. This is only the local-pickup path,
// where the money sat in Kudzu's balance waiting for two signatures on a
// bill of lading.
//
// Called once, when the second signature lands. The caller records the
// returned transfer id and won't call again for the same document.
async function releasePickupPayout(bol) {
  if (!stripe) throw new Error('payments_unavailable');

  const { rows } = await db.query(
    'SELECT stripe_account FROM artists WHERE id = $1', [bol.artist_id]);
  const acct = rows[0] && rows[0].stripe_account;
  if (!acct) throw new Error('artist_not_connected');

  return stripe.transfers.create({
    amount: bol.payout_cents,
    currency: bol.currency || 'usd',
    destination: acct,
    // Stripe rejects a duplicate idempotency key, so a retry that races
    // the database update still can't pay twice.
    transfer_group: `bol_${bol.id}`,
    metadata: {
      kudzu_bol_id: String(bol.id),
      kudzu_work: bol.work_title,
      delivery: 'local_pickup'
    }
  }, { idempotencyKey: `bol_payout_${bol.id}` });
}

module.exports = { router, webhookHandler, isConfigured, releasePickupPayout };
