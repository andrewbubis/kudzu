/* ─────────────────────────────────────────────────────────────────────
   Kudzu — artist account area.

   Talks to the API under /api/*. While the backend is still being built
   those calls 404, so the page falls back to a local demo state and
   keeps working — you can click through the whole flow and judge the
   layout. Nothing here trusts the browser: the six-work limit, file
   size, and ownership are all re-checked on the server.
   ───────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  var MAX_PUBLISHED = 6;
  var MAX_FILE_MB = 12;

  var state = { me: null, works: [], books: [], live: false };

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
      works: [], books: []
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
          '<div class="pub-row">' +
            '<span class="pub-state' + (w.status === 'published' ? ' is-live' : '') + '">' +
              (w.status === 'published' ? 'Live' : 'Draft') +
            '</span>' +
            '<button class="acct-btn ghost pub-toggle" type="button">' +
              (w.status === 'published' ? 'Unpublish' : 'Publish') +
            '</button>' +
          '</div>'
        : '') +
      '</div>';

    var kill = el.querySelector('.kill');
    if (kill) kill.addEventListener('click', function () { removeWork(w); });

    var pub = el.querySelector('.pub-toggle');
    if (pub) pub.addEventListener('click', function () { toggleWorkStatus(w, pub); });

    return el;
  }

  // A piece uploads as a draft. This is the only way it goes live —
  // the server re-checks the same two rules either way: Stripe has to
  // be connected, and at most six published works per artist.
  async function toggleWorkStatus(w, btn) {
    var next = w.status === 'published' ? 'draft' : 'published';
    var original = btn.textContent;
    btn.disabled = true;
    btn.textContent = next === 'published' ? 'Publishing…' : 'Unpublishing…';
    try {
      if (state.live) {
        var updated = await api('/works/' + w.id, {
          method: 'PATCH', body: JSON.stringify({ status: next })
        });
        w.status = updated.status;
      } else {
        w.status = next;
      }
      renderWorks();
    } catch (e) {
      var code = e && e.body && e.body.error;
      var msgs = {
        stripe_not_connected: 'Connect Stripe before publishing work.',
        publish_limit_reached: 'You already have six published — unpublish one first.'
      };
      alert((code && msgs[code]) || 'Could not update that piece. Try again.');
      btn.disabled = false;
      btn.textContent = original;
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
    add.textContent = published.length >= MAX_PUBLISHED ? 'six published — publish slots full' : '+ upload a work';
    add.disabled = published.length >= MAX_PUBLISHED && drafts.length > 0;
    add.addEventListener('click', function () { $('fileInput').click(); });
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

  // Admin-only: whether this artist's page shows on the public site.
  // Kudzu reviews a profile before it goes live, separate from any
  // individual piece being published.
  function renderAdminPublish() {
    var panel = $('adminPublish');
    if (!panel) return;
    if (!state.me.isAdmin) { panel.hidden = true; return; }
    panel.hidden = false;
    $('adminPublishState').textContent = state.me.published ? 'on' : 'off';
    $('adminPublishBtn').textContent = state.me.published ? 'Take offline' : 'Make public';
  }

  if ($('adminPublishBtn')) {
    $('adminPublishBtn').addEventListener('click', async function () {
      var btn = this;
      var next = !state.me.published;
      btn.disabled = true;
      try {
        if (state.live) {
          var r = await api('/me', { method: 'PATCH', body: JSON.stringify({ published: next }) });
          state.me.published = r.artist.published;
        } else {
          state.me.published = next;
        }
        renderAdminPublish();
      } catch (e) {
        alert('Could not change that. Try again.');
      }
      btn.disabled = false;
    });
  }

  function render() { renderIdentity(); renderTodo(); renderAdminPublish(); renderWorks(); renderBooks(); }

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

    var work = {
      id: 'tmp-' + Date.now(), title: title, year: year, medium: medium,
      dimensions: dimensions,
      priceCents: priceCents, currency: 'usd', status: 'draft',
      image: URL.createObjectURL(f)
    };

    if (state.live) {
      var fd = new FormData();
      fd.append('image', f);
      fd.append('title', title);
      if (year) fd.append('year', year);
      if (medium) fd.append('medium', medium);
      if (dimensions) fd.append('dimensions', dimensions);
      if (priceCents != null) fd.append('priceCents', priceCents);
      try {
        var saved = await fetch('/api/works', { method: 'POST', body: fd, credentials: 'same-origin' })
          .then(function (r) { if (!r.ok) throw new Error(); return r.json(); });
        work = saved;
      } catch (e) { alert('Upload failed. Try again.'); return; }
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
  $('uploadBtn').addEventListener('click', function () { $('fileInput').click(); });
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

  // ── Tabs ──────────────────────────────────────────────────────────
  var panels = {
    work: ['workGrid', 'workEmpty', 'workBar'],
    sold: ['soldGrid', 'soldEmpty'],
    books: ['booksGrid', 'booksEmpty', 'booksBar'],
    bio:  ['bioPanel'],
    cv:   ['cvPanel']
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
      state.me = data.artist; state.works = data.works || []; state.books = data.books || []; state.live = true;
    } catch (e) {
      if (e.status === 401) { location.href = 'login.html'; return; }
      var d = demo(); state.me = d.me; state.works = d.works; state.books = d.books; state.live = false;
      console.info('Kudzu: backend not reachable — running in demo mode.');
    }
    render();
    refreshConnect();

    // Coming back from Stripe's onboarding — re-check and tidy the URL.
    if (/[?&]connected=1/.test(location.search)) {
      history.replaceState({}, '', location.pathname);
    }
  })();
})();
