/* ─────────────────────────────────────────────────────────────────────
   Shared behaviour for the smaller account pages — sales, inquiries,
   settings. The profile page has its own richer script; this covers the
   header menu plus whatever each page happens to contain.
   ───────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  async function api(path, opts) {
    var res = await fetch('/api' + path, Object.assign({
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin'
    }, opts || {}));
    if (!res.ok) throw Object.assign(new Error('request_failed'), { status: res.status });
    return res.status === 204 ? null : res.json();
  }

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

  // How the ship-by date reads. "Overdue" and "Due today" are stated
  // plainly rather than softened — a late piece is the thing most likely
  // to turn a happy buyer into a chargeback, and the artist should feel
  // that before the buyer does.
  function dueLabel(iso) {
    if (!iso) return { text: '', tone: '#888' };
    var due = new Date(iso + 'T12:00:00Z');
    var today = new Date();
    var days = Math.round((due - today) / 864e5);
    var when = due.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
    if (days < 0)  return { text: 'Overdue — was due ' + when, tone: '#b3261e' };
    if (days === 0) return { text: 'Due today', tone: '#b3261e' };
    if (days <= 2) return { text: 'Post by ' + when + ' — ' + days + ' day' +
                                  (days === 1 ? '' : 's') + ' left', tone: '#b3261e' };
    return { text: 'Post by ' + when, tone: '#5f5a2c' };
  }

  // One order, everything needed to put it in a box.
  function shipCard(o) {
    var el = document.createElement('div');
    el.style.cssText = 'border:1px solid #e2e2e2;background:#fff;padding:16px 18px;margin-bottom:10px;';
    var due = dueLabel(o.shipBy);

    el.innerHTML =
      '<div style="font-size:16px;"><b>' + esc(o.workTitle) + '</b>' +
        '<span style="color:#888;"> · ' + money(o.priceCents, o.currency) + '</span></div>' +
      (due.text
        ? '<div style="font-size:13px;margin-top:4px;color:' + due.tone + ';">' + esc(due.text) + '</div>'
        : '') +

      '<div style="margin-top:12px;font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:#8a8072;">Ship to</div>' +
      '<div style="font-size:14.5px;line-height:1.55;color:#211c2a;">' +
        (o.shipTo && o.shipTo.length
          ? o.shipTo.map(esc).join('<br>')
          : '<span style="color:#b3261e;">No address on this order — email info@kudzuarts.com</span>') +
      '</div>' +
      '<div style="font-size:13px;margin-top:5px;">' +
        '<a href="mailto:' + esc(o.buyerEmail) + '" style="color:#5f5a2c;">' + esc(o.buyerEmail) + '</a>' +
        (o.buyerPhone ? '<span style="color:#c9c2b0;"> · </span><a href="tel:' + esc(o.buyerPhone) +
          '" style="color:#5f5a2c;">' + esc(o.buyerPhone) + '</a>' : '') +
      '</div>' +

      '<div style="display:flex;gap:8px;margin-top:14px;flex-wrap:wrap;">' +
        '<input class="trk" type="text" placeholder="Tracking number" ' +
          'style="flex:1 1 190px;min-width:0;padding:11px 12px;border:1px solid #e2e2e2;' +
          'font-family:inherit;font-size:15px;">' +
        '<input class="car" type="text" placeholder="Carrier" ' +
          'style="flex:0 1 120px;min-width:0;padding:11px 12px;border:1px solid #e2e2e2;' +
          'font-family:inherit;font-size:15px;">' +
        '<button class="go" type="button" style="padding:11px 18px;border:0;background:#8a8f43;' +
          'color:#fff;font-family:inherit;font-size:15px;cursor:pointer;">Mark posted</button>' +
      '</div>' +
      '<div class="note" style="font-size:13px;color:#b3261e;margin-top:8px;min-height:18px;"></div>';

    var btn = el.querySelector('.go');
    var note = el.querySelector('.note');
    btn.addEventListener('click', async function () {
      var tracking = el.querySelector('.trk').value.trim();
      note.textContent = '';
      if (!tracking) {
        // Not pedantry: without a number the buyer has nothing to watch
        // and the artist has nothing to show if the charge is disputed.
        note.textContent = 'Add the tracking number — it’s what proves you sent it.';
        return;
      }
      btn.disabled = true; btn.textContent = 'Saving…';
      try {
        await api('/orders/' + encodeURIComponent(o.id) + '/ship', {
          method: 'POST',
          body: JSON.stringify({ tracking: tracking, carrier: el.querySelector('.car').value.trim() })
        });
        el.innerHTML = '<div style="font-size:15px;color:#1f7a45;">' +
          '<b>' + esc(o.workTitle) + '</b> — posted. ' +
          esc(o.buyerName) + ' has been emailed the tracking number.</div>';
      } catch (e) {
        note.textContent = 'Could not save that. Try again.';
        btn.disabled = false; btn.textContent = 'Mark posted';
      }
    });
    return el;
  }

  // ── Header menu ───────────────────────────────────────────────────
  var menu = $('acctMenu'), menuBtn = $('acctMenuBtn');
  if (menu && menuBtn) {
    menuBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      var open = menu.dataset.open === 'true';
      menu.dataset.open = String(!open);
      menuBtn.setAttribute('aria-expanded', String(!open));
    });
    document.addEventListener('click', function () {
      menu.dataset.open = 'false';
      menuBtn.setAttribute('aria-expanded', 'false');
    });
  }

  if ($('logoutLink')) {
    $('logoutLink').addEventListener('click', async function (e) {
      e.preventDefault();
      try { await api('/auth/logout', { method: 'POST' }); } catch (err) {}
      location.href = 'login.html';
    });
  }

  async function openStripeDashboard() {
    try {
      var r = await api('/connect/dashboard', { method: 'POST' });
      window.open(r.url, '_blank', 'noopener');
    } catch (e) { alert('Could not open your Stripe dashboard.'); }
  }

  if ($('stripeDashLink')) {
    $('stripeDashLink').addEventListener('click', function (e) {
      e.preventDefault(); openStripeDashboard();
    });
  }
  if ($('dashLink')) {
    $('dashLink').addEventListener('click', function (e) {
      e.preventDefault(); openStripeDashboard();
    });
  }

  // ── Page content ──────────────────────────────────────────────────
  (async function boot() {
    var me, works;
    try {
      var d = await api('/me');
      me = d.artist; works = d.works || [];
    } catch (e) {
      if (e.status === 401) { location.href = 'login.html'; return; }
      return;   // backend not up; leave the page as it is
    }

    if ($('acctMenuName')) {
      $('acctMenuName').textContent = (me.name || 'account').split(' ')[0].toLowerCase();
    }
    if ($('adminInvite')) $('adminInvite').hidden = !me.isAdmin;
    if ($('stripeDash')) $('stripeDash').hidden = !me.stripeConnected;

    // Sales
    if ($('soldGrid')) {
      var sold = works.filter(function (w) { return w.status === 'sold'; });
      sold.forEach(function (w) {
        var el = document.createElement('article');
        el.className = 'work';
        el.innerHTML =
          '<div class="shot">' + (w.image ? '<img src="' + esc(w.image) + '" alt="' + esc(w.title) + '">' : '') + '</div>' +
          '<div class="info"><div class="t">' + esc(w.title) + '</div>' +
          '<div class="r"><span>' + esc(w.year || '') + '</span><span>' + money(w.priceCents, w.currency) + '</span></div></div>';
        $('soldGrid').appendChild(el);
      });
      if ($('soldEmpty')) $('soldEmpty').hidden = sold.length > 0;
      if ($('soldNote')) $('soldNote').hidden = !me.stripeConnected;
    }

    // Pickups waiting to be signed for. The artist is standing in front
    // of the buyer when they look at this, so it's at the top of the page
    // and one tap from the QR code.
    if ($('handoffs')) {
      try {
        var bols = (await api('/bols')).bols || [];
        var open = bols.filter(function (b) { return !b.completedAt; });
        if (open.length) {
          $('handoffs').hidden = false;
          open.forEach(function (b) {
            var row = document.createElement('div');
            row.style.cssText =
              'display:flex;justify-content:space-between;align-items:center;gap:14px;' +
              'padding:14px 16px;border:1px solid #e2e2e2;background:#fff;margin-bottom:8px;';
            // The buyer's email and phone sit right here, tappable. An
            // introduction email went to both of them when the piece sold,
            // but an artist standing in their studio wondering when this
            // person is coming shouldn't have to go find it.
            var reach = [];
            if (b.buyerEmail) {
              reach.push('<a href="mailto:' + esc(b.buyerEmail) + '" style="color:#5f5a2c;">' +
                         esc(b.buyerEmail) + '</a>');
            }
            if (b.buyerPhone) {
              reach.push('<a href="tel:' + esc(b.buyerPhone) + '" style="color:#5f5a2c;">' +
                         esc(b.buyerPhone) + '</a>');
            }

            row.innerHTML =
              '<span><b>' + esc(b.workTitle) + '</b>' +
                '<span style="color:#888;"> · ' + esc(b.buyerName) + '</span>' +
                '<span style="display:block;color:#888;font-size:12px;margin-top:2px;">' +
                  (b.artistSignedAt ? 'Waiting on the buyer to sign' : 'Not signed yet') +
                '</span>' +
                (reach.length
                  ? '<span style="display:block;font-size:12.5px;margin-top:5px;">' +
                      reach.join('<span style="color:#c9c2b0;"> · </span>') + '</span>'
                  : '') +
              '</span>' +
              '<a class="acct-btn" href="handoff.html?id=' + encodeURIComponent(b.id) + '">Complete the sale</a>';
            $('handoffList').appendChild(row);
          });
        }
      } catch (e) { /* leave the section hidden */ }
    }

    // ── Orders waiting to be posted ─────────────────────────────────
    // The whole job on one card: the address to copy onto the box, the
    // date it's due, and the field for the tracking number. An artist
    // should never have to go looking for any of it.
    if ($('toShip')) {
      try {
        var orders = (await api('/orders')).orders || [];
        var pending = orders.filter(function (o) {
          return o.delivery === 'ship' && !o.shippedAt && !o.refundedAt;
        });
        var moving = orders.filter(function (o) {
          return o.delivery === 'ship' && o.shippedAt;
        });

        if (pending.length) { $('toShip').hidden = false; }
        pending.forEach(function (o) { $('shipList').appendChild(shipCard(o)); });

        if (moving.length) {
          $('onWay').hidden = false;
          moving.forEach(function (o) {
            var row = document.createElement('div');
            row.style.cssText = 'padding:12px 16px;border:1px solid #e2e2e2;background:#fff;' +
                                'margin-bottom:8px;font-size:14px;';
            row.innerHTML =
              '<b>' + esc(o.workTitle) + '</b>' +
              '<span style="color:#888;"> · ' + esc(o.buyerName) + '</span>' +
              '<span style="display:block;color:#888;font-size:12.5px;margin-top:3px;">' +
                'Posted ' + new Date(o.shippedAt).toLocaleDateString('en-US',
                  { month: 'short', day: 'numeric' }) +
                ' · ' + esc(o.carrier || 'tracking') + ' ' + esc(o.tracking) +
              '</span>';
            $('onWayList').appendChild(row);
          });
        }
      } catch (e) { /* leave both sections hidden */ }
    }

    // Enquiries
    if ($('inqList')) {
      try {
        var iq = await api('/inquiries');
        var rows = iq.inquiries || [];
        $('inqEmpty').hidden = rows.length > 0;

        rows.forEach(function (r) {
          var el = document.createElement('article');
          el.className = 'inq' + (r.readAt ? '' : ' unread');
          el.innerHTML =
            '<div class="inq-top">' +
              '<span class="who">' + esc(r.name) + '</span>' +
              '<span class="when">' + new Date(r.createdAt).toLocaleDateString('en-US',
                  { month: 'short', day: 'numeric' }) + '</span>' +
            '</div>' +
            (r.workTitle ? '<p class="about">about <em>' + esc(r.workTitle) + '</em></p>' : '') +
            '<p class="msg">' + esc(r.message) + '</p>' +
            '<a class="reply" href="mailto:' + esc(r.email) +
              '?subject=' + encodeURIComponent('Re: your enquiry — Kudzu Arts') + '">' +
              esc(r.email) + '</a>';

          // Opening a reply marks it read.
          el.querySelector('.reply').addEventListener('click', function () {
            el.classList.remove('unread');
            api('/inquiries/' + r.id + '/read', { method: 'POST' }).catch(function () {});
          });

          $('inqList').appendChild(el);
        });
      } catch (e) {
        $('inqEmpty').hidden = false;
        $('inqEmpty').textContent = 'Could not load your enquiries.';
      }
    }

    // Settings
    if ($('sName')) {
      // Swap the plain inputs for proper pickers before filling them in.
      if (window.yearSelect) {
        window.yearSelect($('sBornYear'), { placeholder: 'Year born' });
      }
      if (window.countrySelect) {
        window.countrySelect($('sBornCountry'), { placeholder: 'Country of birth' });
        window.countrySelect($('sWorksCountry'), { placeholder: 'Country' });
      }

      $('sName').value = me.name || '';
      $('sBornYear').value = me.bornYear || '';
      $('sBornCountry').value = me.bornCountry || '';
      $('sWorksCity').value = me.worksCity || '';
      $('sWorksCountry').value = me.worksCountry || '';
      $('sLink').value = me.link || '';
      if ($('sEmail')) $('sEmail').value = me.email || '';

      // ── Notifications ─────────────────────────────────────────────
      // Internal only. An artist who never logs in still needs to hear
      // that a piece sold, and this is the only place we learn how.
      if ($('nEmail')) {
        var channel = me.notifyChannel === 'sms' ? 'sms' : 'email';
        $('nEmailAddr').textContent = me.email || 'your account email';
        $('nEmail').checked = channel === 'email';
        $('nSms').checked = channel === 'sms';
        $('sPhone').value = me.notifyPhone || '';
        $('nPhoneRow').hidden = channel !== 'sms';

        [$('nEmail'), $('nSms')].forEach(function (radio) {
          radio.addEventListener('change', function () {
            $('nPhoneRow').hidden = !$('nSms').checked;
            if ($('nSms').checked) $('sPhone').focus();
          });
        });

        $('saveNotify').addEventListener('click', async function () {
          var btn = this, note = $('notifyNote');
          var wantsSms = $('nSms').checked;
          var phone = $('sPhone').value.trim();
          note.style.color = '#555'; note.textContent = '';

          if (wantsSms && !phone) {
            note.style.color = '#b3261e';
            note.textContent = 'Add a number so we can text you.';
            return;
          }
          btn.disabled = true;
          try {
            await api('/me', {
              method: 'PATCH',
              body: JSON.stringify({
                notifyChannel: wantsSms ? 'sms' : 'email',
                notifyPhone: phone
              })
            });
            note.textContent = 'Saved ✓';
          } catch (e) {
            note.style.color = '#b3261e';
            note.textContent = (e && e.body && e.body.error) === 'bad_phone'
              ? 'That number doesn’t look right.'
              : 'Could not save that. Try again.';
          }
          btn.disabled = false;
        });
      }

      $('saveSettings').addEventListener('click', async function () {
        var btn = this, note = $('saveNote');
        btn.disabled = true; note.textContent = '';
        try {
          await api('/me', {
            method: 'PATCH',
            body: JSON.stringify({
              name: $('sName').value.trim(),
              bornYear: $('sBornYear').value,
              bornCountry: $('sBornCountry').value.trim(),
              worksCity: $('sWorksCity').value.trim(),
              worksCountry: $('sWorksCountry').value.trim(),
              link: $('sLink').value.trim(),
              email: $('sEmail') ? $('sEmail').value.trim() : undefined
            })
          });
          // Straight back to the profile so they can see the change land,
          // rather than a small "Saved" that's easy to miss.
          btn.textContent = 'Saved ✓';
          location.href = 'profile.html';
          return;
        } catch (e) {
          // Email is the one field here that can fail for a reason worth
          // naming — it's their login, and it has to be unique.
          note.textContent =
            e.status === 409 ? 'That email is already on another account.'
          : e.status === 400 ? 'Check the email address — it doesn’t look right.'
          : 'Could not save — try again.';
          note.style.color = '#b3261e';
          btn.disabled = false;
          setTimeout(function () { note.textContent = ''; }, 4500);
        }
      });

      // Payout state
      try {
        var s = await api('/connect/status');
        var state = $('payoutState'), btn = $('payoutBtn');
        if (s.connected) {
          state.textContent = 'Connected. Payouts go straight to your bank.';
          btn.hidden = false;
          btn.textContent = 'Open Stripe dashboard';
          btn.addEventListener('click', openStripeDashboard);
        } else if (s.reason === 'incomplete') {
          state.textContent = 'Stripe still needs a few details before you can be paid.';
          btn.hidden = false;
          btn.textContent = 'Finish connecting Stripe';
          btn.addEventListener('click', startConnect);
        } else if (s.reason === 'payments_unavailable') {
          state.textContent = 'Payments aren’t switched on yet.';
        } else {
          state.textContent = 'Not connected. Your work can’t publish until it is.';
          btn.hidden = false;
          btn.addEventListener('click', startConnect);
        }
      } catch (e) {
        if ($('payoutState')) $('payoutState').textContent = 'Could not check payout status.';
      }
    }
  })();

  async function startConnect() {
    var btn = $('payoutBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Opening Stripe…'; }
    try {
      var r = await api('/connect/start', { method: 'POST' });
      location.href = r.url;
    } catch (e) {
      alert('Could not open Stripe. Try again in a moment.');
      if (btn) { btn.disabled = false; btn.textContent = 'Connect Stripe'; }
    }
  }
})();
