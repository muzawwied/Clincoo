// Clincoo Auth Client — gate login + injeksi token ke semua API call
// Wajib dimuat PERTAMA di semua halaman (kecuali halaman auth di /auth/).
(function () {
  var TOKEN_KEY = 'clincoo_auth_token';
  var isAuthPage = /\/auth\/(index\.html)?(\?|$)|akun\/auth\.html(\?|$)/.test(location.pathname + location.search);
  var AUTH_URL = (location.hostname.indexOf('github.io') !== -1)
    ? '/Clincoo./auth/'
    : '/auth/';

// ===== NAMESPACE DATA PER AKUN =====
var NS_USER_KEY = 'clincoo_auth_user';
var NS_AUTH_RE = /^clincoo_auth_/;
var NS_NS_RE = /^u\d+:/;
var NS_raw = window.localStorage;

function nsPrefix() {
  try {
    var u = JSON.parse(NS_raw.getItem(NS_USER_KEY) || 'null');
    if (u && u.id) return 'u' + u.id + ':';
  } catch (e) {}
  return '';
}

function nsRealKey(k) {
  k = String(k);
  if (NS_AUTH_RE.test(k)) return k;
  nsClaimLegacy();
  var p = nsPrefix();
  return p ? p + k : k;
}

var NS_claimedPrefix = '';
function nsClaimLegacy() {
  var p = nsPrefix();
  if (!p) return;
  try {
    ['clincoo_gh_token', 'clincoo_gh_user', 'clincoo_drive_token', 'clincoo_drive_refresh', 'clincoo_drive_user', 'clincoo_drive_expiry'].forEach(function (k) {
      var legacy = NS_raw.getItem(k);
      if (legacy !== null && NS_raw.getItem(p + k) === null) NS_raw.setItem(p + k, legacy);
      if (legacy !== null) NS_raw.removeItem(k);
    });
  } catch (e) {}
  if (p === NS_claimedPrefix || NS_raw.getItem(p + '__claimed')) return;
  NS_claimedPrefix = p;
  try {
    var toMove = [];
    for (var i = 0; i < NS_raw.length; i++) {
      var k = NS_raw.key(i);
      if (k && !NS_AUTH_RE.test(k) && !NS_NS_RE.test(k)) toMove.push(k);
    }
    for (var j = 0; j < toMove.length; j++) {
      var kk = toMove[j];
      NS_raw.setItem(p + kk, NS_raw.getItem(kk));
      NS_raw.removeItem(kk);
    }
    NS_raw.setItem(p + '__claimed', '1');
  } catch (e) {}
}

function nsEach(fn) {
  var p = nsPrefix();
  if (!p) { for (var i = 0; i < NS_raw.length; i++) { var k = NS_raw.key(i); if (k) fn(k, k); } return; }
  for (var m = 0; m < NS_raw.length; m++) {
    var kk = NS_raw.key(m);
    if (kk && kk.indexOf(p) === 0) fn(kk, kk.slice(p.length));
  }
}

var NS_shim = {
  getItem: function (k) { return NS_raw.getItem(nsRealKey(k)); },
  setItem: function (k, v) { NS_raw.setItem(nsRealKey(k), String(v)); },
  removeItem: function (k) { NS_raw.removeItem(nsRealKey(k)); },
  clear: function () { nsEach(function (real) { NS_raw.removeItem(real); }); },
  key: function (i) { var c = 0, out = null; nsEach(function (real, user) { if (c++ === i) out = user; }); return out; }
};
Object.defineProperty(NS_shim, 'length', { get: function () { var c = 0; nsEach(function () { c++; }); return c; } });

var NS_proxy = new Proxy(NS_shim, {
  get: function (t, prop) {
    if (prop in t) return t[prop];
    return NS_raw.getItem(nsRealKey(prop));
  },
  set: function (t, prop, v) {
    if (prop in t) return true;
    NS_raw.setItem(nsRealKey(prop), String(v));
    return true;
  },
  deleteProperty: function (t, prop) {
    if (prop in t) return true;
    NS_raw.removeItem(nsRealKey(prop));
    return true;
  },
  has: function (t, prop) {
    if (prop in t) return true;
    return NS_raw.getItem(nsRealKey(prop)) !== null;
  }
});

try {
  Object.defineProperty(window, 'localStorage', { value: NS_proxy, configurable: true, writable: true });
  nsClaimLegacy();
} catch (e) {}

  function getToken() {
    try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; }
  }
  window.ClincooAuth = {
    getToken: getToken,
    authUrl: AUTH_URL,
    logout: function (ev, opts) {
      if (ev && ev.preventDefault) { try { ev.preventDefault(); } catch (e) {} }
      if (!(opts && opts.skipConfirm)) {
        if (this._modalOpen) return;
        this._modalOpen = true;
        this._confirmLogout();
        return;
      }
      this._doLogout();
    },
    _doLogout: function () {
      var API = (['clincoo-be2.pages.dev','localhost','127.0.0.1'].indexOf(location.hostname) === -1) ? 'https://clincoo-be2.pages.dev' : '';
      var done = false;
      var finish = function () {
        if (done) return;
        done = true;
        try { localStorage.removeItem(TOKEN_KEY); } catch (e) {}
        location.replace(AUTH_URL);
      };
      var tk = getToken();
      if (tk) {
        try {
          fetch(API + '/api/auth/logout', { method: 'POST', headers: { 'Authorization': 'Bearer ' + tk } })
            .catch(function () {}).then(finish);
          setTimeout(finish, 1500);
        } catch (e) { finish(); }
      } else {
        finish();
      }
    },
    _confirmLogout: function () {
      var self = this;
      var ov = document.createElement('div');
      ov.id = 'clq-logout-modal';
      ov.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(15,23,42,.45);display:flex;align-items:center;justify-content:center;padding:16px;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif';
      // Ikuti tema halaman: bg kotak menyesuaikan bg halaman (dark mode -> surface gelap, bukan putih menyala)
      var dark = false;
      try { dark = document.body.classList.contains('dark-mode'); } catch (e) {}
      var boxBg = dark ? '#0a0a0a' : '#ffffff';
      var boxBrd = dark ? 'border:1px solid #222222;' : '';
      var hCol = dark ? '#f0f0f0' : '#0f172a';
      var pCol = dark ? '#888888' : '#64748b';
      var btnBrd = dark ? '#222222' : '#e2e8f0';
      var btnBg = dark ? '#0a0a0a' : '#ffffff';
      var btnCol = dark ? '#b0b0b0' : '#334155';
      ov.innerHTML = '<div role="dialog" aria-modal="true" aria-label="Konfirmasi keluar" style="background:' + boxBg + ';' + boxBrd + 'border-radius:12px;max-width:340px;width:100%;padding:24px;box-shadow:0 20px 50px rgba(15,23,42,.25);text-align:center">'
        + '<h3 style="margin:0 0 8px;font-size:17px;font-weight:600;color:' + hCol + '">Keluar dari akun?</h3>'
        + '<p style="margin:0 0 20px;font-size:14px;line-height:1.5;color:' + pCol + '">Kamu akan dikeluarkan dari Clincoo dan perlu login ulang untuk kembali.</p>'
        + '<div style="display:flex;gap:10px">'
        + '<button type="button" id="clq-logout-cancel" style="flex:1;padding:10px 0;border:1px solid ' + btnBrd + ';background:' + btnBg + ';color:' + btnCol + ';border-radius:10px;font-size:14px;font-weight:500;cursor:pointer">Batal</button>'
        + '<button type="button" id="clq-logout-yes" style="flex:1;padding:10px 0;border:none;background:transparent;color:#ef4444;font-size:14px;font-weight:600;cursor:pointer">Keluar</button>'
        + '</div></div>';
      document.body.appendChild(ov);
      var close = function () { self._modalOpen = false; if (ov.parentNode) ov.parentNode.removeChild(ov); };
      ov.addEventListener('click', function (e) { if (e.target === ov) close(); });
      ov.querySelector('#clq-logout-cancel').addEventListener('click', close);
      ov.querySelector('#clq-logout-yes').addEventListener('click', function () { close(); self._doLogout(); });
      document.addEventListener('keydown', function esc(e) { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); } });
    }
  };

  if (!isAuthPage && !getToken()) {
    try {
      location.replace(AUTH_URL + '?next=' + encodeURIComponent(location.href));
    } catch (e) {}
    return;
  }

  var origFetch = window.fetch;
  window.fetch = function (input, init) {
    init = init || {};
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    var isApi = /\/api\//.test(url) || /clincoo-be2\.pages\.dev/.test(url) || /app\.clincoo\.buzz\/api/.test(url);
    var isAuthApi = /\/api\/auth\//.test(url);
    if (isApi && !isAuthApi) {
      try {
        var headers = new Headers((init && init.headers) || (input && input.headers) || undefined);
        var tk = getToken();
        if (tk && !headers.get('Authorization')) headers.set('Authorization', 'Bearer ' + tk);
        init.headers = headers;
      } catch (e) {}
    }
    var p = origFetch.call(this, input, init);
    return p.then(function (res) {
      try {
        if (res.status === 401 && !isAuthPage && isApi && !isAuthApi) {
          location.replace(AUTH_URL + '?next=' + encodeURIComponent(location.href));
        }
      } catch (e) {}
      return res;
    });
  };

  var PROJECT_PAGES = ['chat', 'workspace', 'environment', 'keamanan',
    'pengaturan', 'umum', 'build-deployment', 'build-deployment-config', 'build-deployment-dashboard', 'domain-kustom',
    'keamanan-https', 'visibilitas-akses', 'integrasi-webhook', 'zona-bahaya', 'workspace-editor', 'editor',
    'server-mcp', 'email', 'kirim', 'pembayaran', 'integrasi-ai', 'integrasi'];

  function patchProjectLinks() {
    if (!isAuthPage && location.pathname.indexOf('/proyek/') !== -1) {
      try {
        var qid = new URLSearchParams(location.search).get('id');
        var pid = qid || (function () { try { return localStorage.getItem('clincoo_current_project_id') || ''; } catch (e) { return ''; } })();
        if (!pid) return;
        try { localStorage.setItem('clincoo_current_project_id', pid); } catch (e) {}
        var anchors = document.querySelectorAll('a[href]');
        for (var i = 0; i < anchors.length; i++) {
          var href = anchors[i].getAttribute('href') || '';
          var bare = href.split('?')[0];
          var bareKey = (bare.split('/').filter(Boolean).pop() || '').replace(/\.html$/, '');
          var isPengaturan = bare.indexOf('/proyek/pengaturan/') !== -1 || bare.indexOf('/proyek/build-deployment') !== -1;
          if (PROJECT_PAGES.indexOf(bareKey) !== -1 || isPengaturan) {
            if (href.indexOf('id=') === -1)
              anchors[i].setAttribute('href', bare + '?id=' + encodeURIComponent(pid));
          }
        }
      } catch (e) {}
    }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', patchProjectLinks);
  } else {
    patchProjectLinks();
  }
})();
