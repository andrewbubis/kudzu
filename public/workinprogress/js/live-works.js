/* ─────────────────────────────────────────────────────────────────────
   Feeds the virtual gallery and the print shop from the database.

   Both pages ship with hard-coded work so they look right before anyone
   has uploaded. As soon as real work exists it takes over; if the API is
   unreachable the page is left exactly as it was.
   ───────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

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

  async function buy(work, btn) {
    var original = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = 'Opening checkout…'; }
    try {
      var res = await fetch('/api/checkout/work/' + work.id, { method: 'POST' });
      if (!res.ok) {
        var b = await res.json().catch(function () { return {}; });
        throw new Error(b.error || 'failed');
      }
      var data = await res.json();
      location.href = data.url;
    } catch (e) {
      var msgs = {
        already_sold: 'This piece has just sold.',
        not_for_sale: 'This piece isn’t for sale.',
        artist_payout_not_set_up: 'This artist hasn’t finished setting up payouts yet.',
        payments_unavailable: 'Purchasing isn’t switched on yet.'
      };
      alert(msgs[e.message] || 'Could not start checkout. Try again.');
      if (btn) { btn.disabled = false; btn.textContent = original; }
    }
  }

  // ── Virtual gallery ───────────────────────────────────────────────
  function renderGallery(works) {
    var wall = document.getElementById('galRoom');
    var grid = document.querySelector('.pieces');
    if (!wall && !grid) return;

    // The hanging wall — widths vary a little so it reads as a real hang
    // rather than a spreadsheet.
    if (wall) {
      wall.innerHTML = '';
      var frames = ['frame-black', 'frame-walnut', 'frame-oak', 'frame-gold', 'frame-none'];
      works.slice(0, 9).forEach(function (w, i) {
        var a = document.createElement('a');
        a.href = 'artist.html?a=' + encodeURIComponent(w.artistSlug);
        a.className = 'wframe ' + frames[i % frames.length];
        a.style.width = (8 + (i % 4) * 1.8).toFixed(1) + '%';
        a.innerHTML = '<img src="' + esc(w.image) + '" alt="' +
                      esc(w.title + ' by ' + w.artist) + '" loading="lazy">';
        wall.appendChild(a);
      });
    }

    if (grid) {
      grid.innerHTML = '';
      works.forEach(function (w) {
        var el = document.createElement('div');
        el.className = 'piece reveal';
        el.innerHTML =
          '<div class="pwrap"><img class="pimg" src="' + esc(w.image) + '" alt="' +
            esc(w.title + ' by ' + w.artist) + '" loading="lazy">' +
            '<span class="ptag' + (w.status === 'sold' ? ' sold' : '') + '">' +
            (w.status === 'sold' ? 'Sold' : 'For sale') + '</span></div>' +
          '<div class="pinfo">' +
            '<div class="ptitle"><h3>' + esc(w.title) + '</h3>' +
              '<span class="price">' + (w.status === 'sold' ? '' : money(w.priceCents, w.currency)) + '</span></div>' +
            '<p class="by">' + esc(w.artist) + '</p>' +
            '<p class="spec">' + esc([w.year, w.medium, w.dimensions].filter(Boolean).join(' · ')) + '</p>' +
            '<div class="pacts"></div>' +
          '</div>';

        var acts = el.querySelector('.pacts');
        var view = document.createElement('a');
        view.className = 'btn btn-line';
        view.href = 'artist.html?a=' + encodeURIComponent(w.artistSlug);
        view.textContent = 'See the artist';
        acts.appendChild(view);

        if (w.status !== 'sold' && w.forSale && w.priceCents) {
          var b = document.createElement('button');
          b.className = 'btn btn-clay';
          b.type = 'button';
          b.textContent = 'Acquire';
          b.addEventListener('click', function () { buy(w, b); });
          acts.appendChild(b);
        }
        grid.appendChild(el);
      });
    }
  }

  // ── Print shop ────────────────────────────────────────────────────
  function renderPrints(works) {
    var grid = document.querySelector('.prints-grid');
    if (!grid) return;

    var sellable = works.filter(function (w) { return w.status !== 'sold'; });
    if (!sellable.length) return;

    grid.innerHTML = '';
    sellable.forEach(function (w) {
      var a = document.createElement('a');
      a.className = 'print reveal';
      a.href = 'artist.html?a=' + encodeURIComponent(w.artistSlug);
      a.innerHTML =
        '<div class="pframe"><img src="' + esc(w.image) + '" alt="' +
          esc(w.title + ' print — ' + w.artist) + '" loading="lazy">' +
          '<span class="from">From $40</span></div>' +
        '<div class="pl"><h3>' + esc(w.artist) + '</h3>' +
          '<span class="ed">Open &amp; signed</span></div>' +
        '<p class="meta">' + esc(w.title) + '</p>';
      grid.appendChild(a);
    });
  }

  // ── Boot ──────────────────────────────────────────────────────────
  fetch('/api/works')
    .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then(function (d) {
      var works = d.works || [];
      if (!works.length) return;   // nothing uploaded yet — keep the placeholders
      renderGallery(works);
      renderPrints(works);
      // Re-run the reveal-on-scroll animation over the new cards.
      if (window.kudzuReveal) window.kudzuReveal();
    })
    .catch(function () { /* keep whatever is already on the page */ });
})();
