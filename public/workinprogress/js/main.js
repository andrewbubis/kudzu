// Kudzu Arts — front-end behavior
(function () {
  'use strict';

  function highlightNav() {
    var path = location.pathname.replace(/\/$/, '') || '/';
    document.querySelectorAll('.nav a').forEach(function (a) {
      var href = a.getAttribute('href').replace(/\/$/, '') || '/';
      if (path === href || (href !== '/' && path.indexOf(href) === 0)) {
        a.setAttribute('aria-current', 'page');
      }
    });
  }

  function navToggle() {
    var t = document.querySelector('.nav-toggle');
    var n = document.querySelector('.nav');
    if (!t || !n) return;
    t.addEventListener('click', function () {
      var open = n.classList.toggle('open');
      t.setAttribute('aria-expanded', String(open));
      t.textContent = open ? 'Close' : 'Menu';
    });
    n.addEventListener('click', function (e) {
      if (e.target.tagName === 'A') { n.classList.remove('open'); t.textContent = 'Menu'; }
    });
  }

  function reveal() {
    window.kudzuReveal = reveal;
    var els = document.querySelectorAll('.reveal');
    var revealAll = function () { els.forEach(function (e) { e.classList.add('in'); }); };
    if (!('IntersectionObserver' in window)) { revealAll(); return; }
    var io = new IntersectionObserver(function (ents) {
      ents.forEach(function (en) { if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target); } });
    }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });
    els.forEach(function (e) { io.observe(e); });
    // Safety net: reveal anything already in view immediately, and guarantee
    // nothing stays hidden even if IO callbacks never fire (some embedded /
    // iframed environments throttle or block them).
    var revealInView = function () {
      var h = window.innerHeight || document.documentElement.clientHeight;
      els.forEach(function (e) {
        var r = e.getBoundingClientRect();
        if (r.top < h && r.bottom > 0) e.classList.add('in');
      });
    };
    requestAnimationFrame(revealInView);
    setTimeout(function () { document.querySelectorAll('.reveal:not(.in)').forEach(function (e) { e.classList.add('in'); }); }, 600);
  }

  function form() {
    var f = document.querySelector('.form');
    if (!f) return;
    var msg = f.querySelector('.form-msg');
    f.addEventListener('submit', async function (e) {
      e.preventDefault();
      if (!f.checkValidity()) { f.reportValidity(); return; }
      var data = Object.fromEntries(new FormData(f).entries());
      var btn = f.querySelector('button[type="submit"]');
      var orig = btn.textContent; btn.disabled = true; btn.textContent = 'Sending…';
      try {
        var endpoint = f.getAttribute('data-endpoint');
        var mailto = f.getAttribute('data-mailto');
        if (endpoint) {
          // Hosted form service (Formspree / Web3Forms / your own API).
          var r = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }, body: JSON.stringify(data) });
          if (!r.ok) throw new Error('bad');
          f.reset();
          if (msg) { msg.textContent = 'Thank you — we’ll be in touch shortly.'; msg.classList.add('show'); }
        } else if (mailto) {
          // No-backend fallback: open the visitor's email client, pre-filled
          // to info@kudzuarts.com so the message reaches us immediately.
          var subject = 'Kudzu Arts — ' + (data.topic || 'Inquiry') + (data.name ? ' from ' + data.name : '');
          var lines = [
            'Name: ' + (data.name || ''),
            'Email: ' + (data.email || ''),
            'Regarding: ' + (data.topic || ''),
            '',
            (data.message || '')
          ];
          var href = 'mailto:' + mailto + '?subject=' + encodeURIComponent(subject) + '&body=' + encodeURIComponent(lines.join('\n'));
          window.location.href = href;
          if (msg) { msg.textContent = 'Opening your email app — just hit send and it’ll reach info@kudzuarts.com.'; msg.classList.add('show'); }
        } else {
          console.info('[kudzu] form (no endpoint):', data);
          await new Promise(function (res) { setTimeout(res, 700); });
          f.reset();
          if (msg) { msg.textContent = 'Thank you — we’ll be in touch shortly.'; msg.classList.add('show'); }
        }
      } catch (err) {
        if (msg) { msg.textContent = 'Something went wrong. Email us directly at info@kudzuarts.com.'; msg.classList.add('show'); }
      } finally { btn.disabled = false; btn.textContent = orig; }
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    highlightNav(); navToggle(); reveal(); form();
  });
})();
