// Freight, priced for real.
//
// A one-of-a-kind painting to Toronto does not cost the same as one to
// the next county, and until now the site charged nothing for either —
// the artist paid the postage out of their own 75%, with no say in where
// the piece was going. This prices the actual box to the actual address
// before the buyer pays, and adds it on top.
//
// EasyPost fronts every carrier at once, so this is not a bet on USPS
// over FedEx: it rates them all and takes the cheapest that will carry a
// signature. Free to rate; free to buy labels up to 3,000 a month.
//
// Required env var (Railway → Variables):
//   EASYPOST_API_KEY  — from easypost.com, Account → API Keys
//
// Until that is set, isConfigured() is false and callers refuse the sale
// rather than guessing at a price.

const API = 'https://api.easypost.com/v2';

function isConfigured() {
  return !!process.env.EASYPOST_API_KEY;
}

function authHeader() {
  // EasyPost takes the API key as the Basic-auth username, no password.
  return 'Basic ' + Buffer.from(process.env.EASYPOST_API_KEY + ':').toString('base64');
}

async function call(path, body, method) {
  const res = await fetch(API + path, {
    method: method || (body ? 'POST' : 'GET'),
    headers: { Authorization: authHeader(), 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = (data.error && (data.error.message || data.error.code)) || res.statusText;
    const err = new Error(detail);
    err.status = res.status;
    err.data = data;
    // Labels are bought from a prepaid EasyPost wallet. An empty one is
    // the most likely reason a purchase fails, and it reads like a
    // generic payment error unless it is named.
    if (/insufficient|balance|fund/i.test(String(detail))) err.code = 'NO_FUNDS';
    throw err;
  }
  return data;
}

// EasyPost wants a flat address; this is the shape both ends use.
const address = (a) => ({
  name:    a.name || undefined,
  street1: a.line1,
  street2: a.line2 || undefined,
  city:    a.city,
  state:   a.state || undefined,
  zip:     a.postal,
  country: a.country || 'US',
  phone:   a.phone || undefined
});

// An origin is only usable if it has enough to price from. A country
// alone cannot be rated; most carriers want a postcode, and the ones that
// don't still want a city.
function originUsable(artist) {
  return !!(artist
    && String(artist.ship_from_line1 || '').trim()
    && String(artist.ship_from_city  || '').trim()
    && (String(artist.ship_from_postal || '').trim()
        || String(artist.ship_from_country || '').trim()));
}

const originOf = (artist) => ({
  name:    artist.name,
  line1:   artist.ship_from_line1,
  line2:   artist.ship_from_line2,
  city:    artist.ship_from_city,
  state:   artist.ship_from_state,
  postal:  artist.ship_from_postal,
  country: artist.ship_from_country || 'US'
});

/**
 * Price a work to a destination.
 *
 * The artwork already carries packed weight in ounces and box size in
 * inches — collected at upload, and until now never read by anything.
 * Those are exactly EasyPost's units, so they go straight through.
 *
 * Returns { shipment, rate, cents, carrier, service, days } for the
 * cheapest rate, or throws. Rating costs nothing and books nothing; the
 * label is only bought once the sale completes.
 */
async function quote({ artist, work, to }) {
  if (!isConfigured()) throw Object.assign(new Error('shipping_unavailable'), { code: 'CONFIG' });
  if (!originUsable(artist)) throw Object.assign(new Error('origin_missing'), { code: 'ORIGIN' });

  const shipment = await call('/shipments', {
    shipment: {
      to_address:   address(to),
      from_address: address(originOf(artist)),
      parcel: {
        length: Number(work.ship_length_in),
        width:  Number(work.ship_width_in),
        height: Number(work.ship_depth_in),
        weight: Number(work.ship_weight_oz)      // ounces, as EasyPost expects
      },
      options: {
        // A one-of-a-kind work is never left on a doorstep. This is the
        // clause in the artist agreement made real — it was prose in an
        // email before, with nothing setting it on the actual label.
        delivery_confirmation: 'SIGNATURE'
      }
    }
  });

  const rates = (shipment.rates || []).filter((r) => Number(r.rate) > 0);
  if (!rates.length) {
    const err = new Error('no_rates');
    err.code = 'NO_RATES';
    // EasyPost explains a dead destination in messages, not in the error.
    err.detail = (shipment.messages || []).map((m) => m.message).join('; ');
    throw err;
  }

  rates.sort((a, b) => Number(a.rate) - Number(b.rate));
  const rate = rates[0];

  return {
    shipmentId: shipment.id,
    rateId:     rate.id,
    cents:      Math.round(Number(rate.rate) * 100),
    carrier:    rate.carrier,
    service:    rate.service,
    days:       rate.delivery_days || null
  };
}

/**
 * Buy the label once the sale is paid for.
 *
 * Insured for the retail price, which is the other half of what the
 * agreement promises. Insurance is declared here rather than at rating
 * because that is where EasyPost takes it.
 */
async function buyLabel({ shipmentId, rateId, insureCents }) {
  if (!isConfigured()) throw Object.assign(new Error('shipping_unavailable'), { code: 'CONFIG' });

  const bought = await call('/shipments/' + shipmentId + '/buy', {
    rate: { id: rateId },
    ...(insureCents ? { insurance: (insureCents / 100).toFixed(2) } : {})
  });

  // And a QR code, so the artist doesn't need a printer.
  //
  // This is the whole point of Kudzu buying the postage rather than the
  // artist paying at the counter: they pack the piece, walk in, show a
  // code on their phone, and hand the box over. USPS prints the label
  // there. Nothing to print at home, nothing to pay, nothing to claim
  // back — and the insurance and signature are already on it.
  //
  // Best-effort. Not every carrier or service supports it, and a label
  // that exists on paper is far better than no label at all, so a failure
  // here is logged and the printable URL stands on its own.
  let qrUrl = null;
  try {
    const form = await call('/shipments/' + shipmentId + '/forms',
      { form: { type: 'label_qr_code' } });
    const forms = form.forms || [];
    const qr = forms.filter((f) => f.form_type === 'label_qr_code').pop() || forms.pop();
    qrUrl = (qr && qr.form_url) || null;
  } catch (err) {
    console.error('QR label unavailable for', shipmentId, '—', err.message);
  }

  return {
    labelUrl: bought.postage_label && bought.postage_label.label_url,
    qrUrl:    qrUrl,
    tracking: bought.tracking_code || null,
    carrier:  bought.selected_rate && bought.selected_rate.carrier
  };
}

module.exports = { isConfigured, originUsable, quote, buyLabel };
