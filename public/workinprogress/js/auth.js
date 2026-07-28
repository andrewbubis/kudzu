// Kudzu Arts — artist accounts & invites (front-end prototype).
// NOTE: real single-use enforcement + secret-signed tokens need a server;
// here tokens carry an expiry and are marked "used" in this browser.
(function () {
  'use strict';
  var SALT = 'kudzu-vine-2026';
  function hash(s) { s = SALT + s; var h = 5381; for (var i = 0; i < s.length; i++) { h = ((h << 5) + h + s.charCodeAt(i)) | 0; } return (h >>> 0).toString(36); }
  function b64e(o) { return btoa(unescape(encodeURIComponent(JSON.stringify(o)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
  function b64d(s) { try { return JSON.parse(decodeURIComponent(escape(atob(s.replace(/-/g, '+').replace(/_/g, '/'))))); } catch (e) { return null; } }
  function get(k, d) { try { return JSON.parse(localStorage.getItem(k)) || d; } catch (e) { return d; } }
  function set(k, v) { localStorage.setItem(k, JSON.stringify(v)); }

  // Roster artists can sign in with <slug>@kudzuarts.com / kudzu2026 (demo seeds).
  var SLUGS = ['alan-chin', 'ben-quinn', 'brandon-donahue-shipp', 'daniel-herr', 'ellie-caudill', 'evan-christof-seeling', 'hans-wendel', 'ian-patrick-cato', 'isis-cahuas', 'jennie-lawless', 'katya-labowe-stoll', 'marta-lee', 'michael-haight', 'mike-chattem', 'talia-ceravolo', 'wyatt-mills'];
  var ROSTER = {};
  SLUGS.forEach(function (s) {
    var name = s.split('-').map(function (w) { return w.charAt(0).toUpperCase() + w.slice(1); }).join(' ');
    ROSTER[s + '@kudzuarts.com'] = { name: name, page: 'artist-' + s + '.html' };
  });

  window.KudzuAuth = {
    accounts: function () { return get('kudzu_accounts', {}); },
    login: function (email, pass) {
      email = (email || '').trim().toLowerCase();
      var acc = this.accounts()[email];
      if (acc && acc.pw === hash(pass)) { set('kudzu_session', { email: email }); return acc; }
      if (ROSTER[email] && pass === 'kudzu2026') { set('kudzu_session', { email: email }); return { name: ROSTER[email].name, email: email, page: ROSTER[email].page, roster: true }; }
      return null;
    },
    session: function () {
      var s = get('kudzu_session', null); if (!s) return null;
      var acc = this.accounts()[s.email]; if (acc) return acc;
      if (ROSTER[s.email]) return { name: ROSTER[s.email].name, email: s.email, page: ROSTER[s.email].page, roster: true };
      return null;
    },
    logout: function () { localStorage.removeItem('kudzu_session'); },
    makeInvite: function (name, email, hours) {
      var inv = { n: name, e: (email || '').trim().toLowerCase(), x: Date.now() + hours * 3600e3, i: Math.random().toString(36).slice(2, 10) };
      var t = b64e(inv);
      return { token: t + '.' + hash(t), invite: inv };
    },
    readInvite: function (str) {
      if (!str) return { status: 'missing' };
      var p = str.split('.');
      if (p.length !== 2 || hash(p[0]) !== p[1]) return { status: 'invalid' };
      var inv = b64d(p[0]); if (!inv || !inv.e || !inv.x) return { status: 'invalid' };
      if (get('kudzu_used_invites', []).indexOf(inv.i) >= 0) return { status: 'used', invite: inv };
      if (Date.now() > inv.x) return { status: 'expired', invite: inv };
      return { status: 'ok', invite: inv };
    },
    redeem: function (inv, profile, pass) {
      var accs = this.accounts();
      profile.email = inv.e; profile.pw = hash(pass); profile.joined = Date.now();
      accs[inv.e] = profile; set('kudzu_accounts', accs);
      var used = get('kudzu_used_invites', []); used.push(inv.i); set('kudzu_used_invites', used);
      set('kudzu_session', { email: inv.e });
      return profile;
    },
    usedIds: function () { return get('kudzu_used_invites', []); },
    invitesLog: function () { return get('kudzu_invites', []); },
    logInvite: function (rec) { var l = this.invitesLog(); l.unshift(rec); set('kudzu_invites', l.slice(0, 50)); }
  };
})();
