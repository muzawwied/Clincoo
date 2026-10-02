// Inti mini-app email Clincoo — dipakai bersama seluruh halaman /proyek/pengaturan/email/kirim/
var API_BASE = (['clincoo-be2.pages.dev','app.clincoo.buzz','localhost','127.0.0.1'].indexOf(location.hostname) === -1) ? 'https://app.clincoo.buzz/api' : '/api';
var _apiToken = '';
try { _apiToken = localStorage.getItem('clinqoo_auth_token') || localStorage.getItem('clinqoo_token') || ''; } catch (e) {}

function _pid() {
  try {
    var q = new URLSearchParams(location.search).get('id');
    if (q && q.indexOf('proj_') === 0) return q;
    if (typeof getClinqooProjectId === 'function') {
      var g = getClinqooProjectId();
      if (g) return g;
    }
    var plain = '', ns = [], ids = {};
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i); if (!k) continue;
      var v = localStorage.getItem(k); if (!v) continue;
      if (k === 'clinqoo_current_project_id') plain = v;
      else if (/:clinqoo_current_project_id$/.test(k) && v.indexOf('proj_') === 0) ns.push(v);
      else if (k === 'clinqoo_projects' || /:clinqoo_projects$/.test(k)) {
        try { JSON.parse(v).forEach(function(pr){ if(pr&&pr.id) ids[pr.id]=1; }); } catch(e){}
      }
    }
    var has = Object.keys(ids).length > 0;
    for (var j = 0; j < ns.length; j++) { if (!has || ids[ns[j]]) return ns[j]; }
    if (plain && plain.indexOf('proj_') === 0 && (!has || ids[plain])) return plain;
    for (var id in ids) return id;
    return ns[0] || plain || '';
  } catch (e) { return ''; }
}
function _hdrs() { return { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + _apiToken }; }
function _esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
function _cacheKey() { return 'clincoo_email_history_' + _pid(); }
function _readCache() { try { return JSON.parse(localStorage.getItem(_cacheKey()) || 'null'); } catch (e) { return null; } }
function _clearCache() { try { localStorage.removeItem(_cacheKey()); localStorage.removeItem('clincoo_email_cfg_' + _pid()); } catch (e) {} }

function emailToast(msg, ok) {
  var t = document.getElementById('email-toast');
  if (!t) { return; }
  t.textContent = msg;
  t.className = 'fixed bottom-6 left-1/2 -translate-x-1/2 z-50 px-4 py-2.5 rounded-full text-xs font-medium shadow-lg transition-opacity duration-300 ' + (ok ? 'bg-black text-white dark:bg-white dark:text-black' : 'bg-gray-800 text-white dark:bg-slate-700 dark:text-gray-100');
  t.style.opacity = '1';
  clearTimeout(window._emailToastT);
  window._emailToastT = setTimeout(function () { t.style.opacity = '0'; }, 2800);
}

function _apiPost(action, body) {
  var payload = Object.assign({ action: action, project_id: _pid() }, body || {});
  return fetch(API_BASE + '/email', { method: 'POST', headers: _hdrs(), body: JSON.stringify(payload) })
    .then(function (r) {
      return r.ok ? r.json() : r.json().catch(function () { return {}; }).then(function (j) {
        return Promise.reject({ status: r.status, error: j.error || '' });
      });
    });
}

// --- state: loading (shell terlihat) / login / belum aktif / aktif ---
function renderEmailState(mode) {
  var off = (mode === 'login' || mode === 'inactive');
  document.getElementById('kirim-login').classList.toggle('hidden', mode !== 'login');
  document.getElementById('kirim-inactive').classList.toggle('hidden', mode !== 'inactive');
  document.getElementById('kirim-active').classList.toggle('hidden', off);
  if (mode === 'login') {
    document.getElementById('kirim-login-btn').href = '/auth/?next=' + encodeURIComponent(location.pathname + location.search);
  }
  if (mode !== 'active') _clearCache();
}

// --- gerbang data: cek login/aktif, cache config, lalu callback ---
function emailGate(onActive) {
  var cached = null;
  try { cached = JSON.parse(localStorage.getItem('clincoo_email_cfg_' + _pid()) || 'null'); } catch (e) {}
  if (cached && cached.api_key) { renderEmailState('active'); if (onActive) onActive(cached); }
  fetch(API_BASE + '/email?action=config&project_id=' + encodeURIComponent(_pid()), { headers: _hdrs() })
    .then(function (r) { return r.ok ? r.json() : Promise.reject(r.status); })
    .then(function (cfg) {
      renderEmailState('active');
      try { localStorage.setItem('clincoo_email_cfg_' + _pid(), JSON.stringify(cfg)); } catch (e) {}
      if (onActive) onActive(cfg);
    })
    .catch(function (st) {
      if (st === 401) { renderEmailState('login'); }
      else if (st === 404) { renderEmailState('inactive'); }
      else if (!cached) { renderEmailState('inactive'); }
    });
}

// --- menu titik-3 header: navigasi email ---
document.addEventListener('DOMContentLoaded', function () {
  try {
    document.querySelectorAll('#header-more-menu a').forEach(function (a) {
      if (a.pathname === location.pathname) a.classList.add('font-semibold');
    });
  } catch (e) {}
});
