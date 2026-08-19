/* ─────────────────────────────────────────────────────────────────────
   Signing, the way a card reader does it.

   Tap Sign → the screen goes full-bleed white, you turn the phone
   sideways, you scrawl your name across it, you tap Done. That's the
   whole thing.

     KudzuSignature.capture({ name: 'Ian Cato' })
       .then(function (png) { ... });   // null if they backed out

   Landscape because a signature is wide and a phone is tall. The overlay
   asks for it, and if the phone is held upright it rotates the writing
   area rather than making someone sign in a letterbox.
   ───────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  var STYLE_ID = 'kudzu-sig-style';
  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = [
      '.ksig{position:fixed;inset:0;z-index:9999;background:#fff;',
        'display:flex;flex-direction:column;touch-action:none;',
        'font-family:"EB Garamond",Georgia,serif;}',
      '.ksig-bar{display:flex;justify-content:space-between;align-items:center;',
        'padding:12px 16px;border-bottom:1px solid #eee;flex:0 0 auto;}',
      '.ksig-bar button{background:none;border:0;font:inherit;font-size:17px;',
        'cursor:pointer;padding:8px 4px;color:#8a8072;}',
      '.ksig-bar .ksig-done{color:#8a8f43;font-weight:600;}',
      '.ksig-bar .ksig-done:disabled{color:#ccc;}',
      '.ksig-who{font-size:15px;color:#211c2a;}',
      '.ksig-stage{flex:1 1 auto;position:relative;}',
      '.ksig-canvas{position:absolute;inset:0;width:100%;height:100%;display:block;}',
      // The line you sign on, and the X that marks where to start.
      '.ksig-rule{position:absolute;left:8%;right:8%;bottom:22%;border-bottom:2px solid #e2e2e2;',
        'pointer-events:none;}',
      '.ksig-x{position:absolute;left:8%;bottom:22%;transform:translate(-4px,-2px);',
        'color:#c9c2b0;font-size:26px;line-height:1;pointer-events:none;}',
      '.ksig-hint{position:absolute;left:0;right:0;bottom:9%;text-align:center;',
        'color:#c9c2b0;font-size:15px;pointer-events:none;}',
      // Shown when the phone is upright — a nudge, not a wall.
      '.ksig-turn{position:absolute;inset:0;display:flex;flex-direction:column;',
        'align-items:center;justify-content:center;gap:10px;background:#fff;',
        'color:#8a8072;text-align:center;padding:30px;}',
      '.ksig-turn svg{opacity:.5;}',
      '.ksig-turn b{font-size:19px;font-weight:400;color:#211c2a;}',
      '.ksig-turn small{font-size:14px;}',
      '.ksig-turn button{margin-top:8px;background:none;border:0;font:inherit;',
        'font-size:14px;color:#8a8f43;text-decoration:underline;cursor:pointer;}'
    ].join('');
    document.head.appendChild(st);
  }

  function capture(opts) {
    opts = opts || {};
    ensureStyle();

    return new Promise(function (resolve) {
      var wrap = document.createElement('div');
      wrap.className = 'ksig';
      wrap.innerHTML =
        '<div class="ksig-bar">' +
          '<button type="button" class="ksig-cancel">Cancel</button>' +
          '<span class="ksig-who"></span>' +
          '<button type="button" class="ksig-done" disabled>Done</button>' +
        '</div>' +
        '<div class="ksig-stage">' +
          '<canvas class="ksig-canvas"></canvas>' +
          '<div class="ksig-rule"></div>' +
          '<div class="ksig-x">✕</div>' +
          '<div class="ksig-hint">Sign above the line</div>' +
          '<div class="ksig-turn" hidden>' +
            '<svg width="54" height="54" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4">' +
              '<rect x="7" y="2" width="10" height="20" rx="2"/><path d="M2 12h3M19 12h3"/>' +
            '</svg>' +
            '<b>Turn your phone sideways</b>' +
            '<small>More room to sign.</small>' +
            '<button type="button" class="ksig-anyway">Sign like this instead</button>' +
          '</div>' +
        '</div>';

      document.body.appendChild(wrap);
      var priorOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';

      wrap.querySelector('.ksig-who').textContent = opts.name || '';

      var canvas = wrap.querySelector('.ksig-canvas');
      var stage = wrap.querySelector('.ksig-stage');
      var turn = wrap.querySelector('.ksig-turn');
      var doneBtn = wrap.querySelector('.ksig-done');
      var hint = wrap.querySelector('.ksig-hint');
      var ctx = canvas.getContext('2d');

      var drawing = false, dirty = false, last = null, forced = false;

      function isNarrow() {
        return window.innerWidth < 560 && window.innerHeight > window.innerWidth;
      }
      function checkOrientation() {
        turn.hidden = forced || !isNarrow();
      }

      function size() {
        var ratio = Math.max(window.devicePixelRatio || 1, 1);
        var rect = stage.getBoundingClientRect();
        var prior = dirty ? canvas.toDataURL() : null;

        canvas.width = Math.round(rect.width * ratio);
        canvas.height = Math.round(rect.height * ratio);
        ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
        ctx.lineWidth = 3;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.strokeStyle = '#211c2a';
        ctx.fillStyle = '#211c2a';

        if (prior) {
          var img = new Image();
          img.onload = function () { ctx.drawImage(img, 0, 0, rect.width, rect.height); };
          img.src = prior;
        }
        checkOrientation();
      }

      function at(e) {
        var r = canvas.getBoundingClientRect();
        return { x: e.clientX - r.left, y: e.clientY - r.top };
      }

      canvas.addEventListener('pointerdown', function (e) {
        e.preventDefault();
        drawing = true;
        last = at(e);
        try { canvas.setPointerCapture(e.pointerId); } catch (err) {}
        ctx.beginPath();
        ctx.arc(last.x, last.y, 1.5, 0, Math.PI * 2);
        ctx.fill();
        if (!dirty) { dirty = true; doneBtn.disabled = false; hint.style.display = 'none'; }
      });
      canvas.addEventListener('pointermove', function (e) {
        if (!drawing) return;
        e.preventDefault();
        var p = at(e);
        ctx.beginPath();
        ctx.moveTo(last.x, last.y);
        ctx.lineTo(p.x, p.y);
        ctx.stroke();
        last = p;
      });
      ['pointerup', 'pointercancel', 'pointerleave'].forEach(function (ev) {
        canvas.addEventListener(ev, function () { drawing = false; last = null; });
      });

      window.addEventListener('resize', size);
      window.addEventListener('orientationchange', size);

      // Crop to the ink so the exported signature isn't mostly empty page.
      function trimmed() {
        var w = canvas.width, h = canvas.height;
        var d = ctx.getImageData(0, 0, w, h).data;
        var top = h, left = w, right = 0, bottom = 0, found = false;
        for (var y = 0; y < h; y++) {
          for (var x = 0; x < w; x++) {
            if (d[(y * w + x) * 4 + 3] > 8) {
              found = true;
              if (y < top) top = y;
              if (y > bottom) bottom = y;
              if (x < left) left = x;
              if (x > right) right = x;
            }
          }
        }
        if (!found) return null;
        var pad = 12;
        left = Math.max(0, left - pad); top = Math.max(0, top - pad);
        right = Math.min(w - 1, right + pad); bottom = Math.min(h - 1, bottom + pad);

        var out = document.createElement('canvas');
        out.width = right - left + 1;
        out.height = bottom - top + 1;
        out.getContext('2d').drawImage(
          canvas, left, top, out.width, out.height, 0, 0, out.width, out.height);
        return out.toDataURL('image/png');
      }

      function close(result) {
        window.removeEventListener('resize', size);
        window.removeEventListener('orientationchange', size);
        wrap.remove();
        document.body.style.overflow = priorOverflow;
        resolve(result);
      }

      wrap.querySelector('.ksig-cancel').addEventListener('click', function () { close(null); });
      wrap.querySelector('.ksig-anyway').addEventListener('click', function () {
        forced = true; checkOrientation();
      });
      doneBtn.addEventListener('click', function () {
        close(dirty ? trimmed() : null);
      });

      size();
    });
  }

  window.KudzuSignature = { capture: capture };
})();
