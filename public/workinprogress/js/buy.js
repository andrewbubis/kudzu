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
    backend_unavailable: 'Checkout is briefly unavailable. Try again in a moment.'
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
      '.kb-cancel{display:block;width:100%;margin-top:10px;background:none;border:0;',
        'font-family:inherit;font-size:14px;color:#8a8072;cursor:pointer;padding:8px;}',
      '.kb-err{color:#b3261e;font-size:14px;margin:12px 0 0;min-height:19px;}'
    ].join('');
    document.head.appendChild(st);
  }

  async function startCheckout(work, delivery) {
    var res = await fetch('/api/checkout/work/' + work.id, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ delivery: delivery })
    });
    if (!res.ok) {
      var b = await res.json().catch(function () { return {}; });
      throw new Error(b.error || 'failed');
    }
    var data = await res.json();
    location.href = data.url;
  }

  // No pickup offered on this piece → nothing to choose, don't ask.
  function buy(work, btn) {
    ensureStyle();

    var city = work.pickupCity || '';
    if (!work.pickupOk || !city) {
      var original = btn ? btn.textContent : '';
      if (btn) { btn.disabled = true; btn.textContent = 'Opening checkout…'; }
      startCheckout(work, 'ship').catch(function (e) {
        alert(ERRORS[e.message] || 'Could not start checkout. Try again.');
        if (btn) { btn.disabled = false; btn.textContent = original; }
      });
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
            'on delivery. You’ll enter your address at checkout.</span>' +
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
      go.disabled = true; go.textContent = 'Opening checkout…';
      try {
        await startCheckout(work, chosen);
      } catch (e) {
        err.textContent = ERRORS[e.message] || 'Could not start checkout. Try again.';
        go.disabled = false; go.textContent = 'Continue to payment';
      }
    });
  }

  window.kudzuBuy = buy;
})();
