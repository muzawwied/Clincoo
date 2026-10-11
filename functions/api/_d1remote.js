// _d1remote.js — d1Remote shim (opsional).
// Jika env DB_GATEWAY_URL + DB_GATEWAY_KEY diset, env.DB dibungkus jadi proxy
// yang menjalankan semua query lewat gateway D1 lintas akun (Worker di akun
// baru). Jika tidak diset, env.DB asli dipakai apa adanya (tidak ada perilaku
// berubah). Dipasang di _middleware.js SEBELUM handler lain jalan.
export function maybeWrapDB(env) {
  if (!env) return;
  const url = env.DB_GATEWAY_URL, key = env.DB_GATEWAY_KEY;
  if (!url || !key || (env.DB && env.DB.__d1remote)) return;
  const base = String(url).replace(/\/+$/, '');
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer ' + String(key)
  };

  async function call(path, payload) {
    let r;
    try {
      r = await fetch(base + path, { method: 'POST', headers, body: JSON.stringify(payload) });
    } catch (e) {
      throw new Error('d1remote: fetch gagal (' + (e && e.message) + ')');
    }
    let j = null;
    try { j = await r.json(); } catch {}
    if (!r.ok) {
      throw new Error('d1remote: http ' + r.status + (j && j.error ? ' — ' + j.error : ''));
    }
    const res = j && j.result;
    if (!res || res.success === false) {
      throw new Error('d1remote: ' + ((res && res.error) || 'respons tidak valid'));
    }
    return res;
  }

  function stmt(sql, params) {
    return {
      __sql: sql,
      __params: params || [],
      bind: function () { return stmt(sql, Array.from(arguments)); },
      first: async function () {
        const r = await call('/query', { sql, params: params || [] });
        return r.results && r.results.length ? r.results[0] : null;
      },
      all: async function () {
        const r = await call('/query', { sql, params: params || [] });
        return { results: r.results || [], meta: r.meta || {} };
      },
      run: async function () {
        const r = await call('/query', { sql, params: params || [] });
        return { results: r.results || [], meta: r.meta || {}, success: true };
      },
      raw: async function () {
        const r = await call('/query', { sql, params: params || [] });
        return [r.results || [], r.meta || {}];
      }
    };
  }

  env.DB = {
    __d1remote: true,
    prepare: function (sql) { return stmt(sql, null); },
    batch: async function (statements) {
      const arr = Array.isArray(statements) ? statements : [statements];
      return call('/batch', {
        statements: arr.map(function (s) {
          return { sql: s.__sql, params: s.__params || [] };
        })
      });
    },
    async exec(sql) {
      // dipakai untuk multi-statement (mis. inisialisasi tabel) — kirim per blok kecil
      const parts = String(sql).split(/;\s*\n/).filter(Boolean);
      return call('/batch', { statements: parts.map(function (p) { return { sql: p }; }) });
    },
    async dump() { throw new Error('d1remote: dump tidak didukung'); }
  };
}
