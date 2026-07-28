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
const lumaprints = require('./lumaprints');

const router = express.Router();

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const stripe = STRIPE_SECRET_KEY ? require('stripe')(STRIPE_SECRET_KEY) : null;

const BUTTONDOWN_API_KEY = process.env.BUTTONDOWN_API_KEY || '';
const BUTTONDOWN_API_BASE = 'https://api.buttondown.com/v1';

const isConfigured = () => !!stripe;

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

// ── Checkout ─────────────────────────────────────────────────────────
// Buying an original. Price and title come from the database, never from
// the browser — otherwise anyone could set their own price.
router.post('/checkout/work/:id', async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'payments_unavailable' });
  if (!db.isReady()) return res.status(503).json({ error: 'backend_unavailable' });

  try {
    const { rows } = await db.query(
      `SELECT w.*, a.name AS artist_name, a.stripe_account
         FROM artworks w JOIN artists a ON a.id = w.artist_id
        WHERE w.id = $1`, [req.params.id]);
    const work = rows[0];

    if (!work) return res.status(404).json({ error: 'not_found' });
    if (work.status === 'sold') return res.status(409).json({ error: 'already_sold' });
    if (work.status !== 'published') return res.status(404).json({ error: 'not_for_sale' });
    if (!work.for_sale || !work.price_cents) return res.status(409).json({ error: 'not_for_sale' });

    const site = baseUrl(req);

    // If the artist has connected Stripe, the money goes to them and
    // Kudzu takes a commission. If not, it lands in the Kudzu account
    // and gets paid on manually.
    const commissionPct = Number(process.env.KUDZU_COMMISSION_PCT || 30);
    const transfer = work.stripe_account
      ? {
          transfer_data: { destination: work.stripe_account },
          application_fee_amount: Math.round(work.price_cents * commissionPct / 100)
        }
      : {};

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
      shipping_address_collection: { allowed_countries: ['US', 'CA', 'GB', 'AU'] },
      phone_number_collection: { enabled: true },
      success_url: `${site}/workinprogress/gallery.html?bought=${work.id}`,
      cancel_url: `${site}/workinprogress/piece-${work.id}.html`,
      metadata: {
        kind: 'original',
        workId: String(work.id),
        artistId: String(work.artist_id)
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
}

async function fulfil(session) {
  const md = session.metadata || {};

  if (md.kind === 'original' && md.workId) {
    await db.query(
      `UPDATE artworks SET status = 'sold', sold_at = now(), updated_at = now()
        WHERE id = $1 AND status <> 'sold'`, [md.workId]);
    console.log('marked sold:', md.workId, 'session', session.id);
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

module.exports = { router, webhookHandler, isConfigured };
