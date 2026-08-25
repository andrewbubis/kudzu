// Kudzu Arts — first-party page-view tracker.
// No cookies. No fingerprinting. Just path + referrer, once per load.
(function () {
  try {
    if (navigator.webdriver) return; // headless / automated
    var data = JSON.stringify({
      path: location.pathname,
      referrer: document.referrer || ''
    });
    if (navigator.sendBeacon) {
      navigator.sendBeacon('/api/track', new Blob([data], { type: 'application/json' }));
    } else {
      var x = new XMLHttpRequest();
      x.open('POST', '/api/track', true);
      x.setRequestHeader('Content-Type', 'application/json');
      x.send(data);
    }
  } catch (_e) {}
})();
