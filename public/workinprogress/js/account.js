/* ─────────────────────────────────────────────────────────────────────
   Kudzu — artist account area.

   Talks to the API under /api/*. While the backend is still being built
   those calls 404, so the page falls back to a local demo state and
   keeps working — you can click through the whole flow and judge the
   layout. Nothing here trusts the browser: the ten-work limit, file
   size, and ownership are all re-checked on the server.
   ───────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  var MAX_PUBLISHED = 10;
  var MAX_FILE_MB = 25;

  var state = { me: null, works: [], books: [], photos: [], live: false };

  // ── API helper ────────────────────────────────────────────────────
  async function api(path, opts) {
    var res = await fetch('/api' + path, Object.assign({
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin'
    }, opts || {}));
    if (!res.ok) {
      var body = null;
      try { body = await res.json(); } catch (e) {}
      throw Object.assign(new Error('request_failed'), { status: res.status, body: body });
    }
    return res.status === 204 ? null : res.json();
  }

  // ── Demo fallback ─────────────────────────────────────────────────
  function demo() {
    return {
      me: { name: 'your name', bornYear: null, bornCountry: null,
            worksCity: null, worksCountry: null, link: null,
            photo: null, bio: '', cv: '', stripeConnected: false },
      works: [], books: [], photos: []
    };
  }

  // ── Rendering ─────────────────────────────────────────────────────
  var $ = function (id) { return document.getElementById(id); };

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

  function renderIdentity() {
    var me = state.me;
    $('artistName').textContent = me.name || 'your name';
    $('bornYear').textContent = me.bornYear || '—';
    $('bornCountry').textContent = me.bornCountry || 'add country';
    $('worksCity').textContent = me.worksCity || 'add city';
    $('worksCountry').textContent = me.worksCountry || 'add country';
    $('acctMenuName').textContent = (me.name || 'account').split(' ')[0].toLowerCase();

    // "send link" only exists for admins (you and Andrew). The server
    // enforces this too — the menu item is just the convenience.
    var adminItem = $('adminInvite');
    if (adminItem) adminItem.hidden = !me.isAdmin;

    var photo = $('photo');
    if (me.photo) {
      photo.style.backgroundImage = 'url("' + me.photo + '")';
      photo.classList.add('has-photo');
      photo.setAttribute('aria-label', 'Change your profile photo');
    } else {
      photo.style.backgroundImage = '';
      photo.classList.remove('has-photo');
      photo.setAttribute('aria-label', 'Upload a profile photo');
    }

    var link = $('linkLine');
    if (me.link) {
      link.classList.remove('nolink');
      link.innerHTML = '<a href="' + esc(me.link) + '" target="_blank" rel="noopener">' + esc(me.link) + '</a>';
    }

    $('bioText').value = me.bio || '';
    $('cvText').value = me.cv || '';
  }

  // Those placeholder links looked clickable but went nowhere. Send them
  // to settings, where the fields actually live.
  ['bornCountry', 'worksCity', 'worksCountry', 'addLink'].forEach(function (id) {
    var el = $(id);
    if (el) el.setAttribute('href', 'settings.html');
  });

  // Nothing publishes until the artist can actually be paid.
  function canSell() { return !!(state.me && state.me.stripeConnected); }

  // Four things stand between a new artist and their first upload. The
  // server and the database both enforce this — the list here exists so
  // the page can name what's outstanding rather than just refusing.
  function profileGaps() {
    var me = state.me || {};
    var gaps = [];
    if (!me.stripeConnected) gaps.push('connect your Stripe account');
    if (!me.photo) gaps.push('add a profile photo');
    if (!(me.bio && me.bio.trim())) gaps.push('write something in your bio');
    if (!(me.cv && me.cv.trim())) gaps.push('add your C.V.');
    return gaps;
  }

  function blockedByProfile() {
    var gaps = profileGaps();
    if (!gaps.length) return false;
    alert('Before you can add work, please:\n\n· ' + gaps.join('\n· ') +
          '\n\nThis is what collectors see first — a page with no face and ' +
          'no words behind it doesn’t sell anything.');
    return true;
  }

  // ── Stripe Connect ────────────────────────────────────────────────
  // Having an account id isn't the same as being ready to take money —
  // Stripe may still want ID or bank details. Ask, don't assume.
  async function refreshConnect() {
    var btn = $('connectBtn'), note = $('connectNote'), dash = $('stripeDash');
    if (!btn) return;

    if (!state.live) { btn.disabled = true; btn.textContent = 'Connect Stripe'; return; }

    try {
      var s = await api('/connect/status');
      state.me.stripeConnected = !!s.connected;

      if (s.connected) {
        btn.hidden = true;
        if (note) { note.hidden = false; note.textContent = 'Connected — payouts go straight to your bank.'; }
        if (dash) dash.hidden = false;
      } else if (s.reason === 'incomplete') {
        btn.hidden = false;
        btn.textContent = 'Finish connecting Stripe';
        if (note) {
          note.hidden = false;
          note.textContent = s.needs && s.needs.length
            ? 'Stripe still needs a few details from you.'
            : 'Stripe is still reviewing your details.';
        }
        if (dash) dash.hidden = false;
      } else if (s.reason === 'payments_unavailable') {
        btn.disabled = true;
        if (note) { note.hidden = false; note.textContent = 'Payments aren\u2019t switched on yet.'; }
      } else {
        btn.hidden = false;
        btn.textContent = 'Connect Stripe';
      }
      renderTodo();
      renderWorks();
    } catch (e) { /* leave the button as it is */ }
  }

  if ($('connectBtn')) {
    $('connectBtn').addEventListener('click', async function () {
      var btn = this;
      btn.disabled = true; btn.textContent = 'Opening Stripe\u2026';
      try {
        var r = await api('/connect/start', { method: 'POST' });
        location.href = r.url;   // Stripe's own hosted onboarding
      } catch (e) {
        alert('Could not open Stripe. Try again in a moment.');
        btn.disabled = false; btn.textContent = 'Connect Stripe';
      }
    });
  }

  if ($('stripeDashLink')) {
    $('stripeDashLink').addEventListener('click', async function (e) {
      e.preventDefault();
      try {
        var r = await api('/connect/dashboard', { method: 'POST' });
        window.open(r.url, '_blank', 'noopener');
      } catch (err) {
        alert('Could not open your Stripe dashboard.');
      }
    });
  }

  function renderTodo() {
    var me = state.me;
    var done = {
      stripe:  !!me.stripeConnected,
      profile: !!me.photo,
      bio:     !!(me.bio && me.bio.trim()) && !!(me.cv && me.cv.trim())
    };
    var all = true;
    document.querySelectorAll('.acct-todo li').forEach(function (li) {
      var ok = done[li.dataset.step];
      li.classList.toggle('done', !!ok);
      li.querySelector('.tick').textContent = ok ? '✓' : '';
      if (!ok) all = false;
    });
    if (all) $('todo').hidden = true;
  }

  function card(w, opts) {
    opts = opts || {};
    var el = document.createElement(w.status === 'sold' ? 'div' : 'article');
    el.className = 'work';
    el.innerHTML =
      (w.status === 'sold' ? '' :
        '<button class="kill" type="button" title="Remove this work" aria-label="Remove ' + esc(w.title) + '">×</button>') +
      '<div class="shot">' + (w.image ? '<img src="' + esc(w.image) + '" alt="' + esc(w.title) + '">' : '') + '</div>' +
      '<div class="info">' +
        '<div class="t">' + esc(w.title) + '</div>' +
        '<div class="r"><span>' + esc(w.year || '') + '</span><span>' + money(w.priceCents, w.currency) + '</span></div>' +
        '<div class="m">' + esc(w.medium || '') + '</div>' +
        (opts.toggle ?
          // A state, not a switch. Uploading a finished piece puts it up;
          // there is nothing left to approve, so there's no button here.
          '<div class="pub-row">' +
            '<span class="pub-state' + (w.status === 'published' ? ' is-live' : '') + '">' +
              (w.status === 'published' ? 'Live' : 'Draft') +
            '</span>' +
          '</div>' +
          // Without packed weight and box size we can't quote freight, so
          // the piece can't ship. Called out on the card rather than
          // buried, since it silently blocks a sale.
          '<div class="ship-row">' +
            (w.shipWeightOz
              ? '<span class="ship-state">Ships: ' + (w.shipWeightOz / 16).toFixed(1) + ' lb · ' +
                  esc(w.shipLengthIn + ' × ' + w.shipWidthIn + ' × ' + w.shipDepthIn + ' in') +
                '</span>'
              : '<span class="ship-state missing">No shipping size set</span>') +
            '<button class="acct-btn ghost ship-edit" type="button">' +
              (w.shipWeightOz ? 'Edit' : 'Add') +
            '</button>' +
          '</div>' +
          // Local pickup is per piece, not per artist — you might hand
          // over a small drawing but not a 7ft canvas.
          '<div class="ship-row">' +
            '<label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px;color:#555;">' +
              '<input type="checkbox" class="pickup-ok"' + (w.pickupOk ? ' checked' : '') +
                ' style="width:16px;height:16px;">' +
              'Available for local pickup' +
            '</label>' +
          '</div>'
        : '') +
      '</div>';

    var kill = el.querySelector('.kill');
    if (kill) kill.addEventListener('click', function () { removeWork(w); });

    var ship = el.querySelector('.ship-edit');
    if (ship) ship.addEventListener('click', function () { editShipping(w); });

    var pickup = el.querySelector('.pickup-ok');
    if (pickup) pickup.addEventListener('change', async function () {
      var on = this.checked;
      try {
        if (state.live) await api('/works/' + w.id, {
          method: 'PATCH', body: JSON.stringify({ pickupOk: on })
        });
        w.pickupOk = on;
      } catch (e) {
        this.checked = !on;
        alert((e && e.body && e.body.error) === 'location_required'
          ? 'Add the city you work in first — under Settings.\n\n' +
            'A buyer choosing local pickup needs to know where they’re collecting from, ' +
            'and that city is what they’ll see. Your address is never shown.'
          : 'Could not change that. Try again.');
      }
    });

    return el;
  }

  // Packed weight and box size for an existing piece. Same parsing as
  // the upload prompt, kept here so work added before this existed —
  // and anything the artist skipped — can be filled in.
  async function editShipping(w) {
    var current = w.shipWeightOz
      ? (w.shipWeightOz / 16) + ', ' + w.shipLengthIn + ' x ' + w.shipWidthIn + ' x ' + w.shipDepthIn
      : '';
    var raw = prompt(
      'Packed for shipping — weight in pounds, then box size.\n\n' +
      'Format:  weight, length x width x depth\n' +
      'e.g.     8, 30 x 40 x 4\n\n' +
      'Measure the BOX once it’s wrapped, not the artwork.',
      current);
    if (raw == null) return;

    var m = String(raw).trim().match(
      /^\s*([\d.]+)\s*,\s*([\d.]+)\s*[x×]\s*([\d.]+)\s*[x×]\s*([\d.]+)\s*$/i);
    if (!m) return alert('Please use:  weight, length x width x depth\n\ne.g.  8, 30 x 40 x 4');

    var lb = parseFloat(m[1]);
    if (!(lb > 0)) return alert('Weight needs to be more than zero.');

    var patch = {
      shipWeightOz: Math.round(lb * 16),
      shipLengthIn: parseFloat(m[2]),
      shipWidthIn:  parseFloat(m[3]),
      shipDepthIn:  parseFloat(m[4])
    };

    try {
      if (state.live) {
        var updated = await api('/works/' + w.id, {
          method: 'PATCH', body: JSON.stringify(patch)
        });
        Object.assign(w, updated);
      } else {
        Object.assign(w, patch);
      }
      renderWorks();
    } catch (e) {
      alert('Could not save that. Try again.');
    }
  }


  function renderWorks() {
    var live = state.works.filter(function (w) { return w.status !== 'sold'; });
    var sold = state.works.filter(function (w) { return w.status === 'sold'; });
    var published = live.filter(function (w) { return w.status === 'published'; });
    var drafts = live.filter(function (w) { return w.status === 'draft'; });

    $('pubCount').textContent = 'published (' + published.length + '/' + MAX_PUBLISHED + ')';
    $('draftCount').textContent = 'drafts (' + drafts.length + ')';

    var grid = $('workGrid');
    grid.innerHTML = '';
    live.forEach(function (w) { grid.appendChild(card(w, { toggle: true })); });

    var add = document.createElement('button');
    add.className = 'work add';
    add.type = 'button';
    var gaps = profileGaps();
    add.textContent = gaps.length
      ? 'finish your profile to add work'
      : (published.length >= MAX_PUBLISHED ? 'ten live — no free slots' : '+ upload a work');
    add.disabled = (published.length >= MAX_PUBLISHED && drafts.length > 0) || gaps.length > 0;
    add.title = gaps.length ? 'Still to do: ' + gaps.join(', ') : '';
    add.addEventListener('click', function () {
      if (blockedByProfile()) return;
      $('fileInput').click();
    });
    grid.appendChild(add);

    $('workEmpty').hidden = live.length > 0;

    var warn = $('sellWarn');
    if (warn) warn.hidden = canSell() || live.length === 0;

    var sg = $('soldGrid');
    sg.innerHTML = '';
    sold.forEach(function (w) { sg.appendChild(card(w)); });
    $('soldEmpty').hidden = sold.length > 0;
  }

  function renderBooks() {
    var grid = $('booksGrid');
    grid.innerHTML = '';
    state.books.forEach(function (b) { grid.appendChild(card(b)); });

    var add = document.createElement('button');
    add.className = 'work add';
    add.type = 'button';
    add.textContent = '+ add a book';
    add.addEventListener('click', function () { $('bookInput').click(); });
    grid.appendChild(add);

    $('bookCount').textContent = 'books (' + state.books.length + ')';
    $('booksEmpty').hidden = state.books.length > 0;
  }

  function render() { renderIdentity(); renderTodo(); renderWorks(); renderBooks(); }

  // ── Actions ───────────────────────────────────────────────────────
  async function removeWork(w) {
    if (!confirm('Remove “' + w.title + '”? This cannot be undone.')) return;
    if (state.live) {
      try { await api('/works/' + w.id, { method: 'DELETE' }); }
      catch (e) { alert('Could not remove that work. Try again.'); return; }
    }
    state.works = state.works.filter(function (x) { return x !== w; });
    renderWorks();
  }

  function pickFile(input, onFile) {
    input.addEventListener('change', function () {
      var f = input.files && input.files[0];
      input.value = '';
      if (!f) return;
      if (f.size > MAX_FILE_MB * 1024 * 1024) {
        alert('That file is ' + (f.size / 1048576).toFixed(1) + ' MB. Please keep it under ' + MAX_FILE_MB + ' MB.');
        return;
      }
      onFile(f);
    });
  }

  pickFile(document.getElementById('fileInput'), async function (f) {
    var title = prompt('Title of this work?');
    if (!title) return;
    var year = prompt('Year?') || null;
    var medium = prompt('Medium? (e.g. Painting, Sculpture, Mixed Media)') || null;

    // Dimensions drive how the piece hangs in the virtual gallery — a
    // small drawing should look small beside a big canvas — so this one
    // is required rather than optional.
    var dimensions = null;
    while (!dimensions) {
      dimensions = (prompt(
        'Dimensions? Height x width, with units.\n\n' +
        'e.g.  24 x 36 in     or     60 x 90 cm'
      ) || '').trim();
      if (!dimensions) {
        if (!confirm('Dimensions are needed to hang this in the gallery. Try again?')) return;
      } else if (!/\d+\s*(\.\d+)?\s*[x×]\s*\d+/i.test(dimensions)) {
        alert('Please use height x width, like  24 x 36 in');
        dimensions = null;
      }
    }

    var price = prompt('Price in dollars? Leave blank if not for sale.');
    var priceCents = price ? Math.round(parseFloat(price) * 100) : null;

    // Shipping is quoted from the PACKED parcel, not the artwork — a
    // carrier prices the crate, not the canvas. Required now, not later:
    // the artist ships the piece themselves, and a work that can't be
    // quoted is a work that can't be sold.
    var pack = null;
    while (!pack) {
      var raw = (prompt(
        'Packed dimensions — the outer size of the fully packed shipment.\n\n' +
        'Format:  weight, length x width x depth\n' +
        'e.g.     8, 30 x 40 x 4\n\n' +
        'Weight in pounds, box in inches. Measure the BOX once it’s\n' +
        'wrapped, not the artwork itself.'
      ) || '').trim();
      if (!raw) {
        if (confirm('Packed weight and box size are required — without them\n' +
                    'this piece can’t be shipped or sold.\n\nCancel this upload?')) return;
        continue;
      }
      var m = raw.match(
        /^\s*([\d.]+)\s*,\s*([\d.]+)\s*[x×]\s*([\d.]+)\s*[x×]\s*([\d.]+)\s*$/i);
      if (!m) {
        alert('Please use:  weight, length x width x depth\n\ne.g.  8, 30 x 40 x 4');
        continue;
      }
      var lb = parseFloat(m[1]);
      if (!(lb > 0)) { alert('Weight needs to be more than zero.'); continue; }
      pack = {
        shipWeightOz: Math.round(lb * 16),   // stored in ounces
        shipLengthIn: parseFloat(m[2]),
        shipWidthIn:  parseFloat(m[3]),
        shipDepthIn:  parseFloat(m[4])
      };
    }

    var work = {
      id: 'tmp-' + Date.now(), title: title, year: year, medium: medium,
      dimensions: dimensions,
      priceCents: priceCents, currency: 'usd', status: 'draft',
      image: URL.createObjectURL(f)
    };
    if (pack) {
      work.shipWeightOz = pack.shipWeightOz;
      work.shipLengthIn = pack.shipLengthIn;
      work.shipWidthIn  = pack.shipWidthIn;
      work.shipDepthIn  = pack.shipDepthIn;
    }

    if (state.live) {
      var fd = new FormData();
      fd.append('image', f);
      fd.append('title', title);
      if (year) fd.append('year', year);
      if (medium) fd.append('medium', medium);
      if (dimensions) fd.append('dimensions', dimensions);
      if (priceCents != null) fd.append('priceCents', priceCents);
      if (pack) {
        fd.append('shipWeightOz', pack.shipWeightOz);
        fd.append('shipLengthIn', pack.shipLengthIn);
        fd.append('shipWidthIn', pack.shipWidthIn);
        fd.append('shipDepthIn', pack.shipDepthIn);
      }
      try {
        var saved = await fetch('/api/works', { method: 'POST', body: fd, credentials: 'same-origin' })
          .then(async function (r) {
            if (!r.ok) {
              var b = null;
              try { b = await r.json(); } catch (err) {}
              throw Object.assign(new Error('failed'), { code: b && b.error });
            }
            return r.json();
          });
        work = saved;
      } catch (e) {
        // The cap is the one refusal an artist can actually act on, so
        // say what it is rather than "try again".
        var msgs = {
          publish_limit_reached:
            'You have ten works live, which is the limit.\n\n' +
            'Remove one to make room for this piece.',
          shipping_missing:
            'This piece needs its packed weight and box size before it can go up.',
          profile_incomplete:
            'Finish your profile first — photo, bio, C.V., and Stripe.'
        };
        alert((e && msgs[e.code]) || 'Upload failed. Try again.');
        return;
      }
    }

    state.works.push(work);
    renderWorks();
  });

  pickFile(document.getElementById('photoInput'), async function (f) {
    state.me.photo = URL.createObjectURL(f);
    if (state.live) {
      var fd = new FormData();
      fd.append('photo', f);
      try { await fetch('/api/me/photo', { method: 'POST', body: fd, credentials: 'same-origin' }); }
      catch (e) { /* keep the local preview */ }
    }
    renderIdentity(); renderTodo();
  });

  $('photo').addEventListener('click', function () { $('photoInput').click(); });
  $('photo').addEventListener('keydown', function (e) {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('photoInput').click(); }
  });
  $('uploadBtn').addEventListener('click', function () {
    if (blockedByProfile()) return;
    $('fileInput').click();
  });
  $('bookUploadBtn').addEventListener('click', function () { $('bookInput').click(); });

  pickFile(document.getElementById('bookInput'), function (f) {
    var title = prompt('Title of this book?');
    if (!title) return;
    state.books.push({
      id: 'tmpb-' + Date.now(), title: title,
      year: prompt('Year?') || null,
      medium: prompt('Format? (e.g. Zine, Monograph, Catalogue)') || null,
      priceCents: (function () { var p = prompt('Price in dollars? Leave blank if not for sale.'); return p ? Math.round(parseFloat(p) * 100) : null; })(),
      currency: 'usd', status: 'draft', image: URL.createObjectURL(f)
    });
    renderBooks();
  });
  $('reorderBtn').addEventListener('click', function () {
    alert('Drag-to-reorder is coming with the next piece of the backend.');
  });
  $('todoClose').addEventListener('click', function () { $('todo').hidden = true; });

  document.querySelectorAll('[data-save]').forEach(function (btn) {
    btn.addEventListener('click', async function () {
      var field = btn.dataset.save;
      var value = $(field === 'bio' ? 'bioText' : 'cvText').value;
      state.me[field] = value;
      if (state.live) {
        var body = {}; body[field] = value;
        try { await api('/me', { method: 'PATCH', body: JSON.stringify(body) }); }
        catch (e) { alert('Could not save. Try again.'); return; }
      }
      btn.textContent = 'Saved ✓';
      setTimeout(function () { btn.textContent = field === 'bio' ? 'Save bio' : 'Save c.v.'; }, 1600);
      renderTodo();
    });
  });

  // ── First-run welcome ─────────────────────────────────────────────
  // Once per browser, and only for someone who hasn't finished setting up.
  // Somebody with a complete profile has clearly worked it out already.
  var HELLO_KEY = 'kudzu.hello.seen';

  function openHello() {
    var veil = $('helloVeil');
    if (!veil) return;
    veil.hidden = false;
    document.body.style.overflow = 'hidden';
  }

  function closeHello() {
    var veil = $('helloVeil');
    if (!veil) return;
    veil.hidden = true;
    document.body.style.overflow = '';
    try { localStorage.setItem(HELLO_KEY, '1'); } catch (e) {}
  }

  function maybeHello() {
    if (!$('helloVeil')) return;
    var seen;
    try { seen = localStorage.getItem(HELLO_KEY); } catch (e) { seen = '1'; }
    if (!seen && profileGaps().length) openHello();
  }

  if ($('helloClose')) $('helloClose').addEventListener('click', closeHello);
  if ($('helloGo')) $('helloGo').addEventListener('click', closeHello);
  if ($('helloVeil')) {
    $('helloVeil').addEventListener('click', function (e) {
      if (e.target === this) closeHello();
    });
  }
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && $('helloVeil') && !$('helloVeil').hidden) closeHello();
  });
  // A way back to it, since it's easy to close before reading.
  if ($('helloAgain')) {
    $('helloAgain').addEventListener('click', function (e) { e.preventDefault(); openHello(); });
  }

  // ── Gallery photos ────────────────────────────────────────────────
  // Studio shots and detail crops, not artworks — no price, no shipping,
  // none of the publishing rules. They feed the artist's own page and the
  // pool the rest of the site cycles through.
  var MAX_PHOTOS = 12;

  function renderPhotos() {
    var grid = $('photoGrid');
    if (!grid) return;
    grid.innerHTML = '';
    state.photos.forEach(function (p) {
      var el = document.createElement('figure');
      el.className = 'work';
      el.innerHTML =
        '<button class="kill" type="button" aria-label="Remove this photo">×</button>' +
        '<div class="shot"><img src="' + esc(p.image) + '" alt=""></div>';
      el.querySelector('.kill').addEventListener('click', async function () {
        if (!confirm('Remove this photo?')) return;
        try {
          if (state.live) await api('/me/photos/' + p.id, { method: 'DELETE' });
          state.photos = state.photos.filter(function (x) { return x.id !== p.id; });
          renderPhotos();
        } catch (e) { alert('Could not remove that photo.'); }
      });
      grid.appendChild(el);
    });

    $('photoCount').textContent = 'photos (' + state.photos.length + '/' + MAX_PHOTOS + ')';
    $('photoHint').hidden = state.photos.length > 0;
    $('photoAddBtn').disabled = state.photos.length >= MAX_PHOTOS;
    $('photoAddBtn').textContent = state.photos.length >= MAX_PHOTOS ? 'twelve is the limit' : 'add photos';
  }

  if ($('photoAddBtn')) {
    $('photoAddBtn').addEventListener('click', function () { $('photoGalleryInput').click(); });
  }

  if ($('photoGalleryInput')) {
    $('photoGalleryInput').addEventListener('change', async function () {
      var files = Array.prototype.slice.call(this.files || []);
      this.value = '';
      for (var i = 0; i < files.length; i++) {
        if (state.photos.length >= MAX_PHOTOS) {
          alert('Twelve photos is the limit. Remove one to add another.');
          break;
        }
        var f = files[i];
        if (f.size > MAX_FILE_MB * 1048576) {
          alert('“' + f.name + '” is over ' + MAX_FILE_MB + 'MB. Try a smaller version.');
          continue;
        }
        if (state.live) {
          var fd = new FormData();
          fd.append('photo', f);
          try {
            var saved = await fetch('/api/me/photos', {
              method: 'POST', body: fd, credentials: 'same-origin'
            }).then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); });
            state.photos.push(saved);
          } catch (e) { alert('Could not upload “' + f.name + '”.'); }
        } else {
          state.photos.push({ id: 'tmp-' + Date.now() + '-' + i, image: URL.createObjectURL(f) });
        }
        renderPhotos();
      }
    });
  }


  // ── Grant tracker panel ───────────────────────────────────────────
  var grantsLoaded = false;
  async function loadGrantsPanel(slug) {
    if (grantsLoaded) return;
    grantsLoaded = true;
    var grid = $('grantGrid');
    try {
      var resp = await fetch('grants.html');
      var text = await resp.text();
      var parser = new DOMParser();
      var doc = parser.parseFromString(text, 'text/html');
      var allCards = Array.from(doc.querySelectorAll('.grant-card'));
      var matched = slug ? allCards.filter(function(c) {
        return (c.getAttribute('data-artists') || '').split(',').some(function(a) {
          return a.trim() === slug;
        });
      }) : allCards;
      // Admin fallback: if no slug, or isAdmin, or nothing matched → show all
      var cards = (!slug || (state.me && state.me.isAdmin) || matched.length === 0) ? allCards : matched;
      grid.innerHTML = '';
      if (cards.length === 0) {
        grid.innerHTML = '<p class="acct-empty">No matched grants found for your profile yet.</p>';
        return;
      }
      cards.forEach(function(card) { grid.appendChild(document.adoptNode(card)); });
      // Filters
      var activeState = 'all', activeStatus = 'all';
      function applyFilters() {
        cards.forEach(function(card) {
          var stateMatch = activeState === 'all' || card.getAttribute('data-state') === activeState;
          var statusMatch = activeStatus === 'all' || card.getAttribute('data-status') === activeStatus;
          card.classList.toggle('g-hidden', !(stateMatch && statusMatch));
        });
      }
      document.querySelectorAll('[data-gf-state]').forEach(function(btn) {
        btn.addEventListener('click', function() {
          document.querySelectorAll('[data-gf-state]').forEach(function(b) { b.classList.remove('active'); });
          btn.classList.add('active');
          activeState = btn.getAttribute('data-gf-state');
          applyFilters();
        });
      });
      document.querySelectorAll('[data-gf-status]').forEach(function(btn) {
        btn.addEventListener('click', function() {
          document.querySelectorAll('[data-gf-status]').forEach(function(b) { b.classList.remove('active'); });
          btn.classList.add('active');
          activeStatus = btn.getAttribute('data-gf-status');
          applyFilters();
        });
      });
    } catch(e) {
      grid.innerHTML = '<p class="acct-empty">Could not load grants.</p>';
    }
  }

  // ── Tabs ──────────────────────────────────────────────────────────
  var panels = {
    work: ['workGrid', 'workEmpty', 'workBar'],
    sold: ['soldGrid', 'soldEmpty'],
    books: ['booksGrid', 'booksEmpty', 'booksBar'],
    photos: ['photosPanel'],
    bio:  ['bioPanel'],
    cv:   ['cvPanel'],
    grants: ['grantsPanel']
  };
  document.querySelectorAll('.acct-tab').forEach(function (tab) {
    tab.addEventListener('click', function () {
      document.querySelectorAll('.acct-tab').forEach(function (t) {
        t.setAttribute('aria-selected', String(t === tab));
      });
      Object.keys(panels).forEach(function (k) {
        panels[k].forEach(function (id) { $(id).hidden = (k !== tab.dataset.tab); });
      });
      if (tab.dataset.tab === 'work') renderWorks();
      if (tab.dataset.tab === 'books') renderBooks();
      if (tab.dataset.tab === 'photos') renderPhotos();
      if (tab.dataset.tab === 'grants') {
        var gSlug = (state.me && state.me.isAdmin) ? '' : ((state.me && state.me.slug) || '');
        loadGrantsPanel(gSlug);
      }
      if (tab.dataset.tab === 'sold') $('soldEmpty').hidden = state.works.some(function (w) { return w.status === 'sold'; });
    });
  });

  // ── Account menu ──────────────────────────────────────────────────
  var menu = $('acctMenu'), menuBtn = $('acctMenuBtn');
  menuBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    var open = menu.dataset.open === 'true';
    menu.dataset.open = String(!open);
    menuBtn.setAttribute('aria-expanded', String(!open));
  });
  document.addEventListener('click', function () {
    menu.dataset.open = 'false'; menuBtn.setAttribute('aria-expanded', 'false');
  });
  $('logoutLink').addEventListener('click', async function (e) {
    e.preventDefault();
    if (state.live) { try { await api('/auth/logout', { method: 'POST' }); } catch (err) {} }
    location.href = 'login.html';
  });

  // ── Boot ──────────────────────────────────────────────────────────
  (async function boot() {
    try {
      var data = await api('/me');
      state.me = data.artist; state.works = data.works || []; state.books = data.books || [];
      state.photos = data.photos || []; state.live = true;
    } catch (e) {
      if (e.status === 401) { location.href = 'login.html'; return; }
      var d = demo(); state.me = d.me; state.works = d.works; state.books = d.books;
      state.photos = d.photos || []; state.live = false;
      console.info('Kudzu: backend not reachable — running in demo mode.');
    }
    render();
    refreshConnect();
    maybeHello();

    // Coming back from Stripe's onboarding — re-check and tidy the URL.
    if (/[?&]connected=1/.test(location.search)) {
      history.replaceState({}, '', location.pathname);
    }
  })();
})();
