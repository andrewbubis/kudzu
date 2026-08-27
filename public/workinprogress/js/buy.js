/* ─────────────────────────────────────────────────────────────────────
   How a buyer takes delivery.

   Two ways a work can reach someone: posted, or handed over. They are
   genuinely different transactions — one produces a carrier's signature,
   the other produces a bill of lading both parties sign in person — so
   the choice is made before checkout rather than buried inside it.

   Local pickup only appears when the artist has offered it on that
   particular piece AND has a location on their profile. The city comes
   from that artist — Nashville, Los Angeles, wherever they actually are —
   and it goes in the label rather than the fine print, because somebody
   three states away shouldn't be able to choose it without noticing.

   Shared by the gallery grid and the artist page, which each used to
   call checkout directly.
   ───────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  var ERRORS = {
    already_sold: 'This piece has just sold.',
    being_bought: 'Someone is buying this piece right now. If they don\u2019t '
                + 'finish, it will come back up shortly \u2014 try again in a few minutes.',
    not_for_sale: 'This piece isn’t for sale.',
    artist_payout_not_set_up: 'This artist hasn’t finished setting up payouts yet.',
    payments_unavailable: 'Purchasing isn’t switched on yet.',
    pickup_not_offered: 'This piece isn’t available for local pickup.',
    backend_unavailable: 'Checkout is briefly unavailable. Try again in a moment.',
    address_incomplete: 'Please fill in the whole address, including the postcode.',
    cannot_ship_there: 'We can\u2019t get a shipping price to that address. '
                     + 'Check it over, or contact us and we\u2019ll sort it out.',
    artist_ship_from_missing: 'This artist hasn\u2019t set their shipping address yet, '
                            + 'so we can\u2019t price postage. Contact us and we\u2019ll chase it.',
    quote_failed: 'Couldn\u2019t reach the carrier for a price. Try again in a moment.',
    shipping_unavailable: 'Shipping isn\u2019t switched on yet.'
  };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c];
    });
  }

  var STYLE_ID = 'kudzu-buy-style';
  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = [
      '.kb-veil{position:fixed;inset:0;z-index:300;background:rgba(20,17,12,.55);',
        'display:flex;align-items:center;justify-content:center;padding:22px;overflow-y:auto;}',
      '.kb-box{background:#fff;max-width:430px;width:100%;padding:28px;border:1px solid #e2e2e2;',
        'box-shadow:0 30px 70px rgba(20,17,12,.3);font-family:"EB Garamond",Georgia,serif;color:#211c2a;}',
      '.kb-box h2{font-weight:400;font-size:24px;margin:0 0 6px;line-height:1.2;}',
      '.kb-box .kb-sub{color:#8a8072;font-size:14px;margin:0 0 20px;}',
      '.kb-opt{display:block;border:1px solid #e2e2e2;padding:15px 16px;margin-bottom:11px;cursor:pointer;',
        'transition:border-color .15s,background .15s;}',
      '.kb-opt:hover{border-color:#8a8f43;}',
      '.kb-opt input{margin-right:10px;}',
      '.kb-opt .kb-t{font-size:16px;}',
      '.kb-opt .kb-d{display:block;color:#8a8072;font-size:13px;margin-top:4px;margin-left:24px;line-height:1.5;}',
      '.kb-opt.sel{border-color:#8a8f43;background:#fbfaf7;}',
      '.kb-go{width:100%;margin-top:8px;padding:15px;border:0;background:#8a8f43;color:#fff;',
        'font-family:inherit;font-size:16px;cursor:pointer;}',
      '.kb-go:disabled{opacity:.55;cursor:default;}',
      '.kb-f{display:block;margin-bottom:10px;}',
      '.kb-f input{width:100%;padding:11px 12px;border:1px solid #e2e2e2;font-family:inherit;',
        'font-size:15px;color:#211c2a;background:#fff;}',
      '.kb-f input:focus{outline:2px solid #8a8f43;outline-offset:-1px;}',
      '.kb-row{display:flex;gap:10px;}',
      '.kb-row .kb-f{flex:1;}',
      '.kb-quote{border:1px solid #8a8f43;background:#fbfaf7;padding:14px 16px;margin:4px 0 14px;',
        'font-size:15px;line-height:1.5;}',
      '.kb-quote b{font-weight:600;}',
      '.kb-quote .kb-tot{display:block;margin-top:7px;padding-top:7px;border-top:1px solid #e2e2e2;}',
      '.kb-cancel{display:block;width:100%;margin-top:10px;background:none;border:0;',
        'font-family:inherit;font-size:14px;color:#8a8072;cursor:pointer;padding:8px;}',
      '.kb-err{color:#b3261e;font-size:14px;margin:12px 0 0;min-height:19px;}'
    ].join('');
    document.head.appendChild(st);
  }

  async function startCheckout(work, delivery, shipTo) {
    var res = await fetch('/api/checkout/work/' + work.id, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ delivery: delivery, shipTo: shipTo || undefined })
    });
    if (!res.ok) {
      var b = await res.json().catch(function () { return {}; });
      throw new Error(b.error || 'failed');
    }
    var data = await res.json();
    location.href = data.url;
  }

  // Where is it going, and what does that cost?
  //
  // Stripe fixes a session's totals when it is created, so freight cannot
  // be worked out after the buyer types an address into Stripe's own
  // form — it has to be priced here first. Which is better anyway: the
  // number is on screen, itemised, before anyone commits to paying it.
  function askAddress(work, onDone) {
    var veil = document.createElement('div');
    veil.className = 'kb-veil';
    veil.innerHTML =
      '<div class="kb-box" role="dialog" aria-modal="true">' +
        '<h2>Where should it go?</h2>' +
        '<p class="kb-sub">' + esc(work.title || 'This work') +
          ' \u2014 shipping is priced to your address and added to the total.</p>' +
        '<label class="kb-f"><input id="kbName" placeholder="Full name" autocomplete="name"></label>' +
        '<label class="kb-f"><input id="kbL1" placeholder="Street address" autocomplete="address-line1"></label>' +
        '<label class="kb-f"><input id="kbL2" placeholder="Apartment, suite (optional)" autocomplete="address-line2"></label>' +
        '<div class="kb-row">' +
          '<label class="kb-f"><input id="kbCity" placeholder="City" autocomplete="address-level2"></label>' +
          '<label class="kb-f"><input id="kbState" placeholder="State / province" autocomplete="address-level1"></label>' +
        '</div>' +
        '<div class="kb-row">' +
          '<label class="kb-f"><input id="kbPost" placeholder="Postcode" autocomplete="postal-code"></label>' +
          '<label class="kb-f"><input id="kbCountry" placeholder="Country (US, CA\u2026)" value="US" ' +
            'maxlength="2" autocomplete="country"></label>' +
        '</div>' +
        '<div class="kb-quote" hidden></div>' +
        '<button class="kb-go" type="button">Get shipping price</button>' +
        '<button class="kb-cancel" type="button">Cancel</button>' +
        '<p class="kb-err"></p>' +
      '</div>';

    document.body.appendChild(veil);
    document.body.style.overflow = 'hidden';

    function close() { veil.remove(); document.body.style.overflow = ''; }
    veil.addEventListener('click', function (e) { if (e.target === veil) close(); });
    veil.querySelector('.kb-cancel').addEventListener('click', close);

    function readAddress() {
      var v = function (id) { return veil.querySelector('#' + id).value.trim(); };
      return {
        name: v('kbName'), line1: v('kbL1'), line2: v('kbL2'),
        city: v('kbCity'), state: v('kbState'),
        postal: v('kbPost'), country: (v('kbCountry') || 'US').toUpperCase()
      };
    }

    var go = veil.querySelector('.kb-go');
    var err = veil.querySelector('.kb-err');
    var quoteBox = veil.querySelector('.kb-quote');
    var quoted = null;

    // Editing the address invalidates the price. Better to re-quote than
    // to send someone to checkout with a number for a different place.
    veil.querySelectorAll('input').forEach(function (i) {
      i.addEventListener('input', function () {
        if (!quoted) return;
        quoted = null;
        quoteBox.hidden = true;
        go.textContent = 'Get shipping price';
      });
    });

    go.addEventListener('click', async function () {
      err.textContent = '';
      var to = readAddress();

      if (quoted) {                       // priced already — go and pay
        go.disabled = true; go.textContent = 'Opening checkout\u2026';
        try { await onDone(to); }
        catch (e) {
          err.textContent = ERRORS[e.message] || 'Could not start checkout. Try again.';
          go.disabled = false; go.textContent = 'Continue to payment';
        }
        return;
      }

      if (!to.line1 || !to.city || !to.postal || !to.country) {
        err.textContent = ERRORS.address_incomplete;
        return;
      }

      go.disabled = true; go.textContent = 'Pricing\u2026';
      try {
        var res = await fetch('/api/shipping/quote/' + encodeURIComponent(work.id), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ to: to })
        });
        var body = await res.json().catch(function () { return {}; });
        // Shipping isn't switched on yet — fall back to the old path so a
        // buyer is never stuck behind a feature that isn't live.
        if (res.status === 503 && body.error === 'shipping_unavailable') {
          close();
          return onDone(null);
        }
        if (!res.ok) throw new Error(body.error || 'quote_failed');

        quoted = body;
        var money = function (c) { return '$' + (c / 100).toFixed(2); };
        quoteBox.innerHTML =
          esc(body.carrier) + ' ' + esc(body.service) +
          (body.days ? ' \u00b7 about ' + body.days + ' days' : '') +
          ' \u00b7 insured, signature required<br>' +
          'Shipping <b>' + money(body.cents) + '</b>' +
          '<span class="kb-tot">' + esc(work.title || 'This work') + ' ' +
            money(work.priceCents || 0) + ' + shipping ' + money(body.cents) +
            ' = <b>' + money((work.priceCents || 0) + body.cents) + '</b></span>';
        quoteBox.hidden = false;
        go.disabled = false;
        go.textContent = 'Continue to payment';
      } catch (e) {
        err.textContent = ERRORS[e.message] || 'Couldn\u2019t get a shipping price. Try again.';
        go.disabled = false;
        go.textContent = 'Get shipping price';
      }
    });
  }

  // No pickup offered on this piece → nothing to choose, don't ask.
  function buy(work, btn) {
    ensureStyle();

    var city = work.pickupCity || '';
    if (!work.pickupOk || !city) {
      askAddress(work, function (to) { return startCheckout(work, 'ship', to); });
      return;
    }

    var veil = document.createElement('div');
    veil.className = 'kb-veil';
    veil.innerHTML =
      '<div class="kb-box" role="dialog" aria-modal="true">' +
        '<h2>Delivery method</h2>' +
        '<p class="kb-sub">' + esc(work.title || 'This work') + '</p>' +

        '<label class="kb-opt sel" data-v="ship">' +
          '<input type="radio" name="kbDelivery" value="ship" checked>' +
          '<span class="kb-t">Shipping</span>' +
          '<span class="kb-d">Packed and posted by the artist, insured and signature required ' +
            'on delivery. You’ll enter your address next and see the exact ' +
            'shipping cost before you pay.</span>' +
        '</label>' +

        // The artist's own city, from their profile — never a fixed one.
        // Pickup is not offered at all unless they've set a location, so
        // this label always names somewhere.
        '<label class="kb-opt" data-v="pickup">' +
          '<input type="radio" name="kbDelivery" value="pickup">' +
          '<span class="kb-t">Local pickup — ' + esc(city) + '</span>' +
          '<span class="kb-d">Collect from the artist in ' + esc(city) + '. ' +
            'You’ll arrange a time between you; no shipping cost. ' +
            'You both sign a receipt when you meet, and it’s emailed to you.</span>' +
        '</label>' +

        '<button class="kb-go" type="button">Continue to payment</button>' +
        '<button class="kb-cancel" type="button">Cancel</button>' +
        '<p class="kb-err"></p>' +
      '</div>';

    document.body.appendChild(veil);
    document.body.style.overflow = 'hidden';

    function close() {
      veil.remove();
      document.body.style.overflow = '';
    }

    veil.addEventListener('click', function (e) { if (e.target === veil) close(); });
    veil.querySelector('.kb-cancel').addEventListener('click', close);

    veil.querySelectorAll('.kb-opt').forEach(function (opt) {
      opt.addEventListener('click', function () {
        veil.querySelectorAll('.kb-opt').forEach(function (o) { o.classList.remove('sel'); });
        opt.classList.add('sel');
        opt.querySelector('input').checked = true;
      });
    });

    var go = veil.querySelector('.kb-go');
    go.addEventListener('click', async function () {
      var chosen = veil.querySelector('input[name="kbDelivery"]:checked').value;
      var err = veil.querySelector('.kb-err');
      err.textContent = '';
      // Pickup needs no address and no freight. Shipping goes through the
      // address step, so the price is known before payment.
      if (chosen === 'pickup') {
        go.disabled = true; go.textContent = 'Opening checkout…';
        try {
          await startCheckout(work, 'pickup');
        } catch (e) {
          err.textContent = ERRORS[e.message] || 'Could not start checkout. Try again.';
          go.disabled = false; go.textContent = 'Continue to payment';
        }
        return;
      }
      close();
      askAddress(work, function (to) { return startCheckout(work, 'ship', to); });
    });
  }

  window.kudzuBuy = buy;
})();
