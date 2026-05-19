(function () {
  'use strict';

  function highlightCurrentNav() {
    const path = window.location.pathname.replace(/\/$/, '') || '/';
    document.querySelectorAll('.nav a').forEach(a => {
      const href = a.getAttribute('href').replace(/\/$/, '') || '/';
      const isSection = href !== '/' && path.startsWith(href);
      if (path === href || isSection) a.setAttribute('aria-current', 'page');
    });
  }

  function setupNavToggle() {
    const toggle = document.querySelector('.nav-toggle');
    const nav = document.querySelector('.nav');
    if (!toggle || !nav) return;
    toggle.addEventListener('click', () => {
      const open = nav.classList.toggle('is-open');
      toggle.setAttribute('aria-expanded', String(open));
      toggle.textContent = open ? 'Close' : 'Menu';
    });
    nav.addEventListener('click', e => {
      if (e.target.tagName === 'A') {
        nav.classList.remove('is-open');
        toggle.setAttribute('aria-expanded', 'false');
        toggle.textContent = 'Menu';
      }
    });
  }

  function setupReveal() {
    if (!('IntersectionObserver' in window)) {
      document.querySelectorAll('.reveal').forEach(el => el.classList.add('is-visible'));
      return;
    }
    const io = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) { entry.target.classList.add('is-visible'); io.unobserve(entry.target); }
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });
    document.querySelectorAll('.reveal').forEach(el => io.observe(el));
  }

  function setupMarquee() {
    document.querySelectorAll('.marquee').forEach(m => {
      const track = m.querySelector('.marquee-track');
      if (!track) return;
      const clone = track.cloneNode(true);
      clone.setAttribute('aria-hidden', 'true');
      m.appendChild(clone);
    });
  }

  function setupForm() {
    const form = document.querySelector('.form');
    if (!form) return;
    const msg = form.querySelector('.form-msg');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!form.checkValidity()) { form.reportValidity(); return; }
      const data = Object.fromEntries(new FormData(form).entries());
      const submitBtn = form.querySelector('button[type="submit"]');
      const original = submitBtn.textContent;
      submitBtn.disabled = true;
      submitBtn.textContent = 'Sending…';
      try {
        const endpoint = form.getAttribute('data-endpoint');
        if (endpoint) {
          const r = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }, body: JSON.stringify(data) });
          if (!r.ok) throw new Error('bad status');
        } else {
          console.info('[kudzo] form submitted (no endpoint configured):', data);
          await new Promise(r => setTimeout(r, 800));
        }
        form.reset();
        if (msg) { msg.textContent = 'Thank you — we’ll be in touch within three working days.'; msg.classList.add('is-visible'); }
      } catch (err) {
        if (msg) { msg.textContent = 'Something went wrong. Email hello@kudzo.studio directly?'; msg.classList.add('is-visible'); }
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = original;
      }
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    highlightCurrentNav();
    setupNavToggle();
    setupReveal();
    setupMarquee();
    setupForm();
  });
})();
