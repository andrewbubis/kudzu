// Kudzu — front-end behavior
// - Mobile nav toggle
// - Scroll-reveal via IntersectionObserver
// - Marquee duplicate (so the looping animation has no seam)
// - Form: client-side validation + faux submit (swap with real endpoint)
// - Mark the active nav link based on the current page

(function () {
  'use strict';

  // ── Active nav link ─────────────────────────────────────────────
  function highlightCurrentNav() {
    const path = window.location.pathname.replace(/\/$/, '') || '/';
    document.querySelectorAll('.nav a').forEach(a => {
      const href = a.getAttribute('href').replace(/\/$/, '') || '/';
      // Exact match OR a /work/* page should highlight the Work link
      const isSection = href !== '/' && path.startsWith(href);
      if (path === href || isSection) {
        a.setAttribute('aria-current', 'page');
      }
    });
  }

  // ── Mobile nav ──────────────────────────────────────────────────
  function setupNavToggle() {
    const toggle = document.querySelector('.nav-toggle');
    const nav = document.querySelector('.nav');
    if (!toggle || !nav) return;
    toggle.addEventListener('click', () => {
      const open = nav.classList.toggle('is-open');
      toggle.setAttribute('aria-expanded', String(open));
      toggle.textContent = open ? 'Close' : 'Menu';
    });
    // Close on link click (mobile)
    nav.addEventListener('click', e => {
      if (e.target.tagName === 'A') {
        nav.classList.remove('is-open');
        toggle.setAttribute('aria-expanded', 'false');
        toggle.textContent = 'Menu';
      }
    });
  }

  // ── Scroll reveal ───────────────────────────────────────────────
  function setupReveal() {
    if (!('IntersectionObserver' in window)) {
      document.querySelectorAll('.reveal').forEach(el => el.classList.add('is-visible'));
      return;
    }
    const io = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          io.unobserve(entry.target);
        }
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });
    document.querySelectorAll('.reveal').forEach(el => io.observe(el));
  }

  // ── Marquee seam-free loop ─────────────────────────────────────
  function setupMarquee() {
    document.querySelectorAll('.marquee').forEach(m => {
      const track = m.querySelector('.marquee-track');
      if (!track) return;
      // Duplicate inner content once so translateX(-100%) loops cleanly
      const clone = track.cloneNode(true);
      clone.setAttribute('aria-hidden', 'true');
      m.appendChild(clone);
    });
  }

  // ── Contact form ───────────────────────────────────────────────
  // Client-side validation only — wire `submitTo` to your backend.
  // For Railway, you can either:
  //   • use a third-party form service (Formspree, Basin, Web3Forms),
  //   • or add a POST /api/contact handler in server.js.
  function setupForm() {
    const form = document.querySelector('.form');
    if (!form) return;
    const msg = form.querySelector('.form-msg');

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      // Native validation
      if (!form.checkValidity()) {
        form.reportValidity();
        return;
      }
      const data = Object.fromEntries(new FormData(form).entries());
      const submitBtn = form.querySelector('button[type="submit"]');
      const original = submitBtn.textContent;
      submitBtn.disabled = true;
      submitBtn.textContent = 'Sending…';

      try {
        const endpoint = form.getAttribute('data-endpoint');
        if (endpoint) {
          const r = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify(data),
          });
          if (!r.ok) throw new Error('bad status');
        } else {
          // No endpoint configured — simulate, log, and tell the dev.
          console.info('[kudzu] form submitted (no endpoint configured):', data);
          await new Promise(r => setTimeout(r, 800));
        }
        form.reset();
        if (msg) {
          msg.textContent = 'Thank you — we’ll be in touch within three working days.';
          msg.classList.add('is-visible');
        }
      } catch (err) {
        if (msg) {
          msg.textContent = 'Something went wrong. Email hello@kudzu.studio directly?';
          msg.classList.add('is-visible');
        }
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = original;
      }
    });
  }

  // ── Init ────────────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', () => {
    highlightCurrentNav();
    setupNavToggle();
    setupReveal();
    setupMarquee();
    setupForm();
  });
})();
