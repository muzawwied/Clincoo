/* Clincoo — localStorage quota guard: sekali warn + bersihkan cache proyek lain */
(function () {
  'use strict';
  if (window.__clincooLsQuotaGuard) return;
  window.__clincooLsQuotaGuard = true;

  var MSG = 'Cache lokal penuh (aman): perubahan tetap disimpan ke cloud.';

  /* Dedupe warn yang sama dari saveData() di workspace */
  try {
    var ow = console.warn.bind(console);
    console.warn = function () {
      var text = Array.prototype.join.call(arguments, ' ');
      if (text.indexOf('Cache lokal penuh') !== -1) {
        if (window.__clincooCacheFullWarned) return;
        window.__clincooCacheFullWarned = true;
      }
      return ow.apply(console, arguments);
    };
  } catch (_) {}

  var raw = window.localStorage;
  if (!raw || !raw.setItem) return;

  var orig = raw.setItem.bind(raw);

  function purgeOtherCaches(keepKey) {
    var doomed = [];
    try {
      for (var i = 0; i < raw.length; i++) {
        var k = raw.key(i);
        if (!k) continue;
        if (k === keepKey) continue;
        if (/^clincoo_(files|umum|ws)_/.test(k)) doomed.push(k);
        if (k === 'clincoo_bug_beetle_recent') doomed.push(k);
      }
      doomed.forEach(function (k) {
        try { raw.removeItem(k); } catch (_) {}
      });
    } catch (_) {}
    return doomed.length;
  }

  try {
    Object.defineProperty(raw, 'setItem', {
      configurable: true,
      writable: true,
      value: function (key, value) {
        try {
          return orig(key, value);
        } catch (e) {
          var name = (e && e.name) || '';
          var msg = (e && e.message) || '';
          var isQuota =
            name === 'QuotaExceededError' ||
            name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
            /quota|penuh|exceeded/i.test(msg);
          if (!isQuota) throw e;
          purgeOtherCaches(String(key));
          try {
            return orig(key, value);
          } catch (e2) {
            if (!window.__clincooCacheFullWarned) {
              window.__clincooCacheFullWarned = true;
              try { console.warn(MSG); } catch (_) {}
            }
          }
        }
      }
    });
  } catch (_) {}
})();
