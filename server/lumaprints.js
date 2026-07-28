// Thin client for the Lumaprints print-on-demand API.
// Docs: https://api-docs.lumaprints.com/
//
// Auth: HTTP Basic, base64("apiKey:apiSecret") — see doc-420489.
// Order endpoint: POST {LUMAPRINTS_API_BASE}/api/v1/orders — see api-5384560.
//
// Required env vars (set in Railway → Variables once you have a Lumaprints account):
//   LUMAPRINTS_API_KEY     — from https://dashboard.lumaprints.com/developer/apiKeys
//   LUMAPRINTS_API_SECRET  — same page
//   LUMAPRINTS_STORE_ID    — from the "Get all stores" endpoint or your dashboard
//   LUMAPRINTS_API_BASE    — sandbox: https://us.api-sandbox.lumaprints.com
//                            production: check your Lumaprints dashboard for the live
//                            base URL before going live — do not assume it here.

function getConfig() {
  const apiKey = process.env.LUMAPRINTS_API_KEY;
  const apiSecret = process.env.LUMAPRINTS_API_SECRET;
  const storeId = process.env.LUMAPRINTS_STORE_ID;
  const apiBase = process.env.LUMAPRINTS_API_BASE || 'https://us.api-sandbox.lumaprints.com';
  return { apiKey, apiSecret, storeId, apiBase };
}

function isConfigured() {
  const { apiKey, apiSecret, storeId } = getConfig();
  return !!(apiKey && apiSecret && storeId);
}

function authHeader() {
  const { apiKey, apiSecret } = getConfig();
  const token = Buffer.from(`${apiKey}:${apiSecret}`).toString('base64');
  return `Basic ${token}`;
}

/**
 * Submit a print order to Lumaprints for fulfillment/dropship.
 * @param {Object} opts
 * @param {string} opts.externalId - your own order reference (e.g. Stripe session id)
 * @param {number} opts.subcategoryId - Lumaprints product id (see data/print-products.json)
 * @param {number} opts.width - inches
 * @param {number} opts.height - inches
 * @param {string} opts.imageUrl - publicly reachable URL to the print-ready image
 * @param {Object} opts.recipient - { firstName, lastName, addressLine1, addressLine2, city, state, zipCode, country, phone }
 */
async function submitOrder({ externalId, subcategoryId, width, height, imageUrl, recipient }) {
  const { storeId, apiBase } = getConfig();
  if (!isConfigured()) {
    throw new Error('Lumaprints is not configured — set LUMAPRINTS_API_KEY, LUMAPRINTS_API_SECRET, and LUMAPRINTS_STORE_ID.');
  }
  const body = {
    externalId: String(externalId),
    storeId: Number(storeId),
    shippingMethod: 'default',
    productionTime: 'regular',
    recipient,
    orderItems: [
      {
        externalItemId: String(externalId) + '-1',
        subcategoryId,
        quantity: 1,
        width,
        height,
        file: { imageUrl },
      },
    ],
  };

  const res = await fetch(`${apiBase}/api/v1/orders`, {
    method: 'POST',
    headers: {
      'Authorization': authHeader(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error('Lumaprints order failed: ' + (data.message || res.statusText));
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data; // { message, orderNumber }
}

module.exports = { submitOrder, isConfigured, getConfig };
