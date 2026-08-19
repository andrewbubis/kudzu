/* ─────────────────────────────────────────────────────────────────────
   Signing with a finger.

   A canvas you draw on, used wherever a real signature is needed. Built
   here rather than pulled from a library because the whole thing is a
   hundred lines and this runs on a phone held sideways in a studio —
   fewer moving parts is the point.

   Notes worth keeping:

   · Pointer events, not touch or mouse. One code path covers finger,
     stylus and trackpad, and `setPointerCapture` means a stroke that
     wanders off the edge of the canvas still finishes cleanly.

   · The canvas is scaled to devicePixelRatio. Without it, a signature on
     a retina phone comes out soft and looks photocopied.

   · Output is trimmed to the ink before export. A signature scrawled in
     the corner shouldn't carry half a canvas of white space onto a
     document that gets printed.

   Usage:
     var pad = KudzuSignature(canvasElement);
     pad.isEmpty();   // nothing drawn yet
     pad.clear();
     pad.toDataURL(); // trimmed PNG, or null if empty
   ───────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  function KudzuSignature(canvas, opts) {
    opts = opts || {};
    var ctx = canvas.getContext('2d');
    var drawing = false;
    var dirty = false;
    var last = null;

    var INK = opts.ink || '#211c2a';
    var WIDTH = opts.width || 2.4;

    function size() {
      var ratio = Math.max(window.devicePixelRatio || 1, 1);
      var rect = canvas.getBoundingClientRect();
      // Preserve whatever has been drawn across a resize (rotating the
      // phone mid-signature shouldn't wipe it).
      var prior = dirty ? canvas.toDataURL() : null;

      canvas.width = Math.round(rect.width * ratio);
      canvas.height = Math.round(rect.height * ratio);
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.lineWidth = WIDTH;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = INK;

      if (prior) {
        var img = new Image();
        img.onload = function () { ctx.drawImage(img, 0, 0, rect.width, rect.height); };
        img.src = prior;
      }
    }

    function point(e) {
      var rect = canvas.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    }

    function start(e) {
      e.preventDefault();
      drawing = true;
      last = point(e);
      if (canvas.setPointerCapture && e.pointerId != null) {
        try { canvas.setPointerCapture(e.pointerId); } catch (err) {}
      }
      // A tap with no drag is still a mark — a dot, like pen on paper.
      ctx.beginPath();
      ctx.arc(last.x, last.y, WIDTH / 2, 0, Math.PI * 2);
      ctx.fillStyle = INK;
      ctx.fill();
      dirty = true;
      if (opts.onChange) opts.onChange();
    }

    function move(e) {
      if (!drawing) return;
      e.preventDefault();
      var p = point(e);
      ctx.beginPath();
      ctx.moveTo(last.x, last.y);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
      last = p;
    }

    function end(e) {
      if (!drawing) return;
      drawing = false;
      last = null;
      if (canvas.releasePointerCapture && e && e.pointerId != null) {
        try { canvas.releasePointerCapture(e.pointerId); } catch (err) {}
      }
    }

    canvas.addEventListener('pointerdown', start);
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    canvas.addEventListener('pointerleave', end);
    // Stops the page scrolling under a finger that's mid-signature.
    canvas.style.touchAction = 'none';

    window.addEventListener('resize', size);
    size();

    // Crop to the drawn area so the exported image is the signature and
    // not a rectangle of mostly nothing.
    function trimmed() {
      var w = canvas.width, h = canvas.height;
      var data = ctx.getImageData(0, 0, w, h).data;
      var top = h, left = w, right = 0, bottom = 0, found = false;

      for (var y = 0; y < h; y++) {
        for (var x = 0; x < w; x++) {
          if (data[(y * w + x) * 4 + 3] > 8) {
            found = true;
            if (y < top) top = y;
            if (y > bottom) bottom = y;
            if (x < left) left = x;
            if (x > right) right = x;
          }
        }
      }
      if (!found) return null;

      var pad = 8;
      left = Math.max(0, left - pad); top = Math.max(0, top - pad);
      right = Math.min(w - 1, right + pad); bottom = Math.min(h - 1, bottom + pad);

      var out = document.createElement('canvas');
      out.width = right - left + 1;
      out.height = bottom - top + 1;
      out.getContext('2d').drawImage(
        canvas, left, top, out.width, out.height, 0, 0, out.width, out.height);
      return out.toDataURL('image/png');
    }

    return {
      isEmpty: function () { return !dirty; },
      clear: function () {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        dirty = false;
        if (opts.onChange) opts.onChange();
      },
      toDataURL: function () { return dirty ? trimmed() : null; }
    };
  }

  window.KudzuSignature = KudzuSignature;
})();
