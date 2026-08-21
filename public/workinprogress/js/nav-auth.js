/* ─────────────────────────────────────────────────────────────────────
   Kudzu — signed-in state for public pages.

   The dashboard pages (profile, sales, settings, inquiries) already know
   whether you're logged in and show an account menu. Every public page
   — Artists, Virtual Gallery, Print Shop, the homepage, artist pages —
   just showed a static "Artist Login" button regardless of your actual
   session, so leaving the dashboard for any of them looked exactly like
   being logged out. This checks once and swaps the button for the same
   account menu when you're actually signed in.
   ───────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  var loginLink = document.querySelector('a.nav-cta[href="login.html"]');
  if (!loginLink) return;   // page has no login button — nothing to do

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c];
    });
  }

  var STYLE_ID = 'nav-auth-style';
  if (!document.getElementById(STYLE_ID)) {
    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent =
      '.nav-auth-menu { position: relative; }' +
      '.nav-auth-menu > button { font: inherit; font-size: 13px; padding: 8px 15px; ' +
        'border: 1px solid currentColor; background: none; color: inherit; cursor: pointer; }' +
      '.nav-auth-menu ul { position: absolute; top: calc(100% + 6px); right: 0; margin: 0; ' +
        'padding: 8px 0; list-style: none; min-width: 150px; background: #fff; ' +
        'border: 1px solid #e2e2e2; box-shadow: 0 8px 20px rgba(20,17,12,0.12); ' +
        'z-index: 40; display: none; }' +
      '.nav-auth-menu[data-open="true"] ul { display: block; }' +
      '.nav-auth-menu li { margin: 0; }' +
      '.nav-auth-menu a { display: block; padding: 7px 15px; font-size: 13px; ' +
        'color: #111; text-decoration: none; white-space: nowrap; }' +
      '.nav-auth-menu a:hover { background: #f4f4f4; }' +
      '.nav-auth-menu li.sep { border-top: 1px solid #e2e2e2; margin-top: 6px; padding-top: 6px; }';
    document.head.appendChild(style);
  }

  fetch('/api/me', { credentials: 'same-origin' })
    .then(function (r) { if (!r.ok) throw new Error('not_signed_in'); return r.json(); })
    .then(function (data) {
      var me = data.artist;
      var menu = document.createElement('div');
      menu.className = 'nav-cta nav-auth-menu';
      menu.dataset.open = 'false';
      menu.innerHTML =
        // Their own name, spelled the way they spell it. Lowercasing it
        // turned Ian into ian, which just looks like a typo in the nav.
        '<button type="button" aria-haspopup="true" aria-expanded="false">' +
          esc((me.name || 'Account').split(' ')[0]) +
        '</button>' +
        '<ul>' +
          '<li><a href="profile.html">me</a></li>' +
          (me.isAdmin ? '<li><a href="invites.html">send link</a></li>' : '') +
          '<li><a href="sales.html">sales</a></li>' +
          '<li><a href="inquiries.html">inquiries</a></li>' +
          '<li><a href="profile.html?tab=grants">grants</a></li>' +
          '<li><a href="documents.html">documents</a></li>' +
          '<li><a href="settings.html">settings</a></li>' +
          '<li class="sep"><a href="#" data-logout>log out</a></li>' +
        '</ul>';

      loginLink.replaceWith(menu);

      var btn = menu.querySelector('button');
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        var open = menu.dataset.open === 'true';
        menu.dataset.open = String(!open);
        btn.setAttribute('aria-expanded', String(!open));
      });
      document.addEventListener('click', function () {
        menu.dataset.open = 'false';
        btn.setAttribute('aria-expanded', 'false');
      });
      menu.querySelector('[data-logout]').addEventListener('click', function (e) {
        e.preventDefault();
        fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' })
          .catch(function () {})
          .then(function () { location.reload(); });
      });
    })
    .catch(function () { /* not signed in — leave the Login button as it was */ });
})();
