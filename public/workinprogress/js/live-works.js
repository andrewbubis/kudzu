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

  // Delivery choice lives in buy.js, shared with the artist page.
  function buy(work, btn) {
    if (window.kudzuBuy) return window.kudzuBuy(work, btn);
    alert('Checkout is still loading. Try again in a moment.');
  }

  // ── Virtual gallery ───────────────────────────────────────────────
  // The wall is a real photograph. Pieces are sized against each other
  // using the dimensions the artist entered, and hung at gallery eye
  // level — centres at 57in, the museum standard — so a small drawing
  // reads small next to a big canvas.

  var WALL_HEIGHT_IN = 108;   // assume a 9ft wall in the photograph
  var EYE_LEVEL_IN = 57;      // centre height galleries actually hang to

  // Accepts "24 x 36 in", "60 × 90 cm", "24x36", "24 by 36 inches".
  // Returns inches, or null if it can't tell.
  function parseDimensions(text) {
    if (!text) return null;
    var m = String(text).match(/(\d+(?:\.\d+)?)\s*(?:x|×|by)\s*(\d+(?:\.\d+)?)/i);
    if (!m) return null;

    var h = parseFloat(m[1]), w = parseFloat(m[2]);
    if (!isFinite(h) || !isFinite(w) || h <= 0 || w <= 0) return null;

    // Centimetres unless it says inches. Bare numbers over 200 are
    // almost certainly cm — nobody hangs a 17ft canvas.
    var isCm = /cm|centim/i.test(text) || (!/in|"|inch/i.test(text) && Math.max(h, w) > 200);
    if (isCm) { h /= 2.54; w /= 2.54; }

    return { h: h, w: w };
  }

  function renderGallery(works) {
    var wall = document.getElementById('galRoom');
    var grid = document.querySelector('.pieces');
    if (!wall && !grid) return;

    if (wall) {
      // Size each wframe proportional to its real-world width.
      // The widest piece gets 14% of the room width; others scale down.
      var hangable = works.map(function (w) {
        return { w: w, size: parseDimensions(w.dimensions) };
      }).filter(function (x) { return x.size; });

      if (hangable.length) {
        var maxW = Math.max.apply(null, hangable.map(function (x) { return x.size.w; }));
        wall.innerHTML = '';
        wall.classList.remove('photo-wall');

        hangable.slice(0, 8).forEach(function (x) {
          var a = document.createElement('a');
          a.href = 'piece.html?a=' + encodeURIComponent(x.w.artistSlug) + '&w=' + encodeURIComponent(x.w.id);
          a.className = 'wframe frame-black';
          a.style.width = ((x.size.w / maxW) * 14).toFixed(1) + '%';

          a.innerHTML =
            '<img src="' + esc(x.w.image) + '" alt="' +
            esc(x.w.title + ' by ' + x.w.artist) + '" loading="lazy">';
          wall.appendChild(a);
        });

        // Fill remaining spaces with ghost frames so the wall looks intentional
        var ghosts = Math.max(0, 4 - hangable.length);
        for (var g = 0; g < ghosts; g++) {
          var sp = document.createElement('span');
          sp.className = 'wframe wframe-ghost';
          sp.setAttribute('aria-hidden', 'true');
          wall.appendChild(sp);
        }
      }
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
        view.className = 'btn btn-fill';
        view.href = 'piece.html?a=' + encodeURIComponent(w.artistSlug) + '&w=' + encodeURIComponent(w.id);
        view.textContent = 'View work →';
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
  // Not currently called. Kept for when prints become self-serve.
  function renderPrints(works) {   // eslint-disable-line no-unused-vars
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
      // Prints are chosen deliberately, not everything an artist uploads —
      // so the print shop stays hand-curated for now.
      // Re-run the reveal-on-scroll animation over the new cards.
      if (window.kudzuReveal) window.kudzuReveal();
    })
    .catch(function () { /* keep whatever is already on the page */ });
})();
