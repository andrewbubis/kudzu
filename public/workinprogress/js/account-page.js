/* ─────────────────────────────────────────────────────────────────────
   Shared behaviour for the smaller account pages — sales, inquiries,
   settings. The profile page has its own richer script; this covers the
   header menu plus whatever each page happens to contain.
   ───────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  async function api(path, opts) {
    var res = await fetch('/api' + path, Object.assign({
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin'
    }, opts || {}));
    if (!res.ok) throw Object.assign(new Error('request_failed'), { status: res.status });
    return res.status === 204 ? null : res.json();
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c];
    });
  }

  function money(cents, currency) {
    if (cents == null) return '';
    try {
      return new Intl.NumberFormat('en-US', {
        style: 'currency', currency: (currency || 'usd').toUpperCase(),
        maximumFractionDigits: 0
      }).format(Math.round(cents) / 100);
    } catch (e) { return '$' + Math.round(cents / 100).toLocaleString(); }
  }

  // ── Header menu ───────────────────────────────────────────────────
  var menu = $('acctMenu'), menuBtn = $('acctMenuBtn');
  if (menu && menuBtn) {
    menuBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      var open = menu.dataset.open === 'true';
      menu.dataset.open = String(!open);
      menuBtn.setAttribute('aria-expanded', String(!open));
    });
    document.addEventListener('click', function () {
      menu.dataset.open = 'false';
      menuBtn.setAttribute('aria-expanded', 'false');
    });
  }

  if ($('logoutLink')) {
    $('logoutLink').addEventListener('click', async function (e) {
      e.preventDefault();
      try { await api('/auth/logout', { method: 'POST' }); } catch (err) {}
      location.href = 'login.html';
    });
  }

  async function openStripeDashboard() {
    try {
      var r = await api('/connect/dashboard', { method: 'POST' });
      window.open(r.url, '_blank', 'noopener');
    } catch (e) { alert('Could not open your Stripe dashboard.'); }
  }

  if ($('stripeDashLink')) {
    $('stripeDashLink').addEventListener('click', function (e) {
      e.preventDefault(); openStripeDashboard();
    });
  }
  if ($('dashLink')) {
    $('dashLink').addEventListener('click', function (e) {
      e.preventDefault(); openStripeDashboard();
    });
  }

  // ── Page content ──────────────────────────────────────────────────
  (async function boot() {
    var me, works;
    try {
      var d = await api('/me');
      me = d.artist; works = d.works || [];
    } catch (e) {
      if (e.status === 401) { location.href = 'login.html'; return; }
      return;   // backend not up; leave the page as it is
    }

    if ($('acctMenuName')) {
      $('acctMenuName').textContent = (me.name || 'account').split(' ')[0].toLowerCase();
    }
    if ($('adminInvite')) $('adminInvite').hidden = !me.isAdmin;
    if ($('stripeDash')) $('stripeDash').hidden = !me.stripeConnected;

    // Sales
    if ($('soldGrid')) {
      var sold = works.filter(function (w) { return w.status === 'sold'; });
      sold.forEach(function (w) {
        var el = document.createElement('article');
        el.className = 'work';
        el.innerHTML =
          '<div class="shot">' + (w.image ? '<img src="' + esc(w.image) + '" alt="' + esc(w.title) + '">' : '') + '</div>' +
          '<div class="info"><div class="t">' + esc(w.title) + '</div>' +
          '<div class="r"><span>' + esc(w.year || '') + '</span><span>' + money(w.priceCents, w.currency) + '</span></div></div>';
        $('soldGrid').appendChild(el);
      });
      if ($('soldEmpty')) $('soldEmpty').hidden = sold.length > 0;
      if ($('soldNote')) $('soldNote').hidden = !me.stripeConnected;
    }

    // Settings
    if ($('sName')) {
      // Swap the plain inputs for proper pickers before filling them in.
      if (window.yearSelect) {
        window.yearSelect($('sBornYear'), { placeholder: 'Year born' });
      }
      if (window.countrySelect) {
        window.countrySelect($('sBornCountry'), { placeholder: 'Country of birth' });
        window.countrySelect($('sWorksCountry'), { placeholder: 'Country' });
      }

      $('sName').value = me.name || '';
      $('sBornYear').value = me.bornYear || '';
      $('sBornCountry').value = me.bornCountry || '';
      $('sWorksCity').value = me.worksCity || '';
      $('sWorksCountry').value = me.worksCountry || '';
      $('sLink').value = me.link || '';

      $('saveSettings').addEventListener('click', async function () {
        var btn = this, note = $('saveNote');
        btn.disabled = true; note.textContent = '';
        try {
          await api('/me', {
            method: 'PATCH',
            body: JSON.stringify({
              name: $('sName').value.trim(),
              bornYear: $('sBornYear').value,
              bornCountry: $('sBornCountry').value.trim(),
              worksCity: $('sWorksCity').value.trim(),
              worksCountry: $('sWorksCountry').value.trim(),
              link: $('sLink').value.trim()
            })
          });
          note.textContent = 'Saved';
        } catch (e) {
          note.textContent = 'Could not save — try again.';
        } finally {
          btn.disabled = false;
          setTimeout(function () { note.textContent = ''; }, 2200);
        }
      });

      // Payout state
      try {
        var s = await api('/connect/status');
        var state = $('payoutState'), btn = $('payoutBtn');
        if (s.connected) {
          state.textContent = 'Connected. Payouts go straight to your bank.';
          btn.hidden = false;
          btn.textContent = 'Open Stripe dashboard';
          btn.addEventListener('click', openStripeDashboard);
        } else if (s.reason === 'incomplete') {
          state.textContent = 'Stripe still needs a few details before you can be paid.';
          btn.hidden = false;
          btn.textContent = 'Finish connecting Stripe';
          btn.addEventListener('click', startConnect);
        } else if (s.reason === 'payments_unavailable') {
          state.textContent = 'Payments aren’t switched on yet.';
        } else {
          state.textContent = 'Not connected. Your work can’t publish until it is.';
          btn.hidden = false;
          btn.addEventListener('click', startConnect);
        }
      } catch (e) {
        if ($('payoutState')) $('payoutState').textContent = 'Could not check payout status.';
      }
    }
  })();

  async function startConnect() {
    var btn = $('payoutBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Opening Stripe…'; }
    try {
      var r = await api('/connect/start', { method: 'POST' });
      location.href = r.url;
    } catch (e) {
      alert('Could not open Stripe. Try again in a moment.');
      if (btn) { btn.disabled = false; btn.textContent = 'Connect Stripe'; }
    }
  }
})();
