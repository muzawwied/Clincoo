/* Adapter penyimpanan: mode API (backend D1) bila tersedia, fallback localStorage (simulasi) */
(function () {
  const LS_KEY = 'clincoo_exp_domains';
  // Data domain lama di perangkat dibersihkan: daftar domain kini selalu real-time dari API per akun.
  try { localStorage.removeItem(LS_KEY); } catch (e) {}
  let apiMode = null; // null = belum dicek

  const API_BASE = (location.hostname === 'clincoo-domain.pages.dev') ? '/api' : 'https://clincoo-domain.pages.dev/api';
  const probe = fetch(API_BASE + '/health', { headers: { accept: 'application/json' } })
    .then(r => r.ok && r.json())
    .then(d => { apiMode = !!(d && d.ok); })
    .catch(() => { apiMode = false; });

  function lsList() { try { return JSON.parse(localStorage.getItem(LS_KEY)) || []; } catch (e) { return []; } }
  function lsSave(l) { localStorage.setItem(LS_KEY, JSON.stringify(l)); }
  function lsStoreKey(domain, k) { return 'clincoo_exp_' + k + '_' + domain; }

  function stableToken(d) {
    let h = 5381;
    for (let i = 0; i < d.length; i++) h = ((h << 5) + h + d.charCodeAt(i)) >>> 0;
    let hex = h.toString(16) + ((h * 2654435761) >>> 0).toString(16);
    while (hex.length < 24) hex += hex;
    return 'clincoo-verify=' + hex.slice(0, 24);
  }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function validDomain(v) {
    const s = (v || '').trim().toLowerCase();
    if (!s || /\s/.test(s) || s.length > 253) return false;
    if (!/^[a-z0-9.-]+$/.test(s)) return false;
    const parts = s.split('.');
    if (parts.length < 2) return false;
    if (!/^[a-z]{2,}$/.test(parts[parts.length - 1])) return false;
    return parts.every(p => p && p.length <= 63 && /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(p));
  }

  // Data domain kini per akun: setiap request membawa token login Clincoo (Bearer).
  function authToken() { try { return localStorage.getItem('clinqoo_auth_token') || localStorage.getItem('clinqoo_token') || ''; } catch (e) { return ''; } }
  const api = (path, opts) => {
    const headers = { 'Content-Type': 'application/json' };
    const tok = authToken();
    if (tok) headers['Authorization'] = 'Bearer ' + tok;
    return fetch(API_BASE + path.replace(/^\/api/, ''), Object.assign({ headers: headers }, opts || {})).then(r => r.json());
  };

  window.store = {
    get apiMode() { return apiMode; },
    ready: probe,
    validDomain,
    stableToken,
    uid,
    list() {
      // Selalu real-time dari API; tanpa fallback data lama (localStorage) supaya tiap akun melihat data terbarunya sendiri.
      return probe.then(() => apiMode
        ? api('/api/domains').then(d => d.domains || [])
        : []);
    },
    create(name) {
      return probe.then(() => apiMode
        ? api('/api/domains', { method: 'POST', body: JSON.stringify({ name }) }).then(d => d.domain)
        : (() => {
            const l = lsList();
            let row = l.find(x => x.name === name);
            if (!row) {
              row = { id: uid(), name, note: '', status: 'pending', created: new Date().toISOString() };
              l.push(row); lsSave(l);
            }
            return row;
          })());
    },
    zoneInfo(domain) {
      return probe.then(() => apiMode
        ? api('/api/domains/' + encodeURIComponent(domain) + '/zone')
        : { ok: true, simulated: true, zone: null });
    },
    ensureZone(domain) {
      return probe.then(() => apiMode
        ? api('/api/domains/' + encodeURIComponent(domain) + '/zone', { method: 'POST' })
        : { ok: false, simulated: true, message: 'Mode simulasi — nameserver otomatis belum tersedia di sini.' });
    },
    remove(name) {
      return probe.then(() => apiMode
        ? api('/api/domains/' + encodeURIComponent(name), { method: 'DELETE' })
        : (lsSave(lsList().filter(x => x.name !== name)), null));
    },
    verify(name) {
      return probe.then(() => apiMode
        ? api('/api/domains/' + encodeURIComponent(name) + '/verify', { method: 'POST' })
        : { ok: false, simulated: true, message: 'Record belum terdeteksi. Propagasi DNS butuh beberapa menit — pastikan record sudah tersimpan di penyedia domain-mu, lalu periksa lagi.' });
    },
    getSettings(domain, defaults) {
      return probe.then(() => apiMode
        ? api('/api/domains/' + encodeURIComponent(domain) + '/settings').then(d => Object.assign({}, defaults, d.settings))
        : Object.assign({}, defaults, Object.fromEntries(Object.keys(defaults).map(k => [k, localStorage.getItem(lsStoreKey(domain, 'set_' + k))]).filter(p => p[1] !== null))));
    },
    setSetting(domain, k, v) {
      return probe.then(() => apiMode
        ? api('/api/domains/' + encodeURIComponent(domain) + '/settings', { method: 'POST', body: JSON.stringify({ [k]: String(v) }) })
        : (localStorage.setItem(lsStoreKey(domain, 'set_' + k), String(v)), null));
    },
    listDns(domain) {
      return probe.then(() => apiMode
        ? api('/api/domains/' + encodeURIComponent(domain) + '/dns')
        : { ok: true, simulated: true, records: JSON.parse(localStorage.getItem(lsStoreKey(domain, 'dns')) || '[]') });
    },
    addDns(domain, rec) {
      return probe.then(() => apiMode
        ? api('/api/domains/' + encodeURIComponent(domain) + '/dns', { method: 'POST', body: JSON.stringify(rec) })
        : (() => {
            const l = JSON.parse(localStorage.getItem(lsStoreKey(domain, 'dns')) || '[]');
            l.push(Object.assign({ id: 'r' + uid() }, rec));
            localStorage.setItem(lsStoreKey(domain, 'dns'), JSON.stringify(l));
            return { ok: true, simulated: true };
          })());
    },
    deleteDns(domain, id) {
      return probe.then(() => apiMode
        ? api('/api/domains/' + encodeURIComponent(domain) + '/dns/' + encodeURIComponent(id), { method: 'DELETE' })
        : (() => {
            const l = JSON.parse(localStorage.getItem(lsStoreKey(domain, 'dns')) || '[]').filter(r => r.id !== id);
            localStorage.setItem(lsStoreKey(domain, 'dns'), JSON.stringify(l));
            return { ok: true };
          })());
    }
  };
})();
