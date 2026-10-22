// _d1remote.js — d1Remote shim (opsional).
// Jika env D1MIGR_URL + D1MIGR_KEY diset, env.DB dibungkus jadi proxy
// yang menjalankan semua query lewat gateway D1 lintas akun (Worker di akun
// baru). Jika tidak diset, env.DB asli dipakai apa adanya (tidak ada perilaku
// berubah). Dipasang di _middleware.js SEBELUM handler lain jalan.
export function maybeWrapDB(env) {
  if (!env) return;
  const url = env.D1MIGR_URL, key = env.D1MIGR_KEY;
  if (!url || !key || (env.DB && env.DB.__d1remote)) return;
  const base = String(url).replace(/\/+$/, '');
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer ' + String(key)
  };

  const gq = globalThis;
  gq.__d1qTrace = [];
  async function call(path, payload) {
    let r;
    gq.__d1qTrace.push(String((payload && payload.sql) || (payload && payload.statements && 'BATCH(' + payload.statements.length + ')') || path).slice(0, 90));
    try {
      r = await fetch(base + path, { method: 'POST', headers, body: JSON.stringify(payload) });
    } catch (e) {
      const tr = gq.__d1qTrace;
      throw new Error('d1remote: fetch gagal (' + (e && e.message) + ') [q#' + tr.length + ' | ' + tr.slice(-14).join(' ; ') + ']');
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

  // [13 Okt] HEMAT KUOTA GATEWAY: tiap query D1 prod = 1 request Worker di akun gateway
  // (paket gratis 100 ribu/hari; sempat 280 ribu -> error 1027 -> login "Client ID Google
  // tidak tersedia"). DDL idempoten (CREATE ... IF NOT EXISTS, dan ALTER ADD COLUMN yang
  // sudah pernah dicoba) cukup dikirim SEKALI per isolate; sisanya dilewati lokal.
  const g = globalThis;
  g.__d1ddlDone = g.__d1ddlDone || new Set();
  const DDL_IDEMP = /^\s*(create\s+(unique\s+)?(table|index)\s+if\s+not\s+exists|alter\s+table\s+\S+\s+add\s+column)\b/i;
  const ddlKey = (sql) => String(sql).replace(/\s+/g, ' ').trim();
  const ddlSkip = (sql) => DDL_IDEMP.test(sql) && g.__d1ddlDone.has(ddlKey(sql));
  const ddlMark = (sql) => { if (DDL_IDEMP.test(sql)) g.__d1ddlDone.add(ddlKey(sql)); };
  const OKRES = { results: [], meta: {}, success: true };

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
        if (ddlSkip(sql)) return OKRES;
        let r;
        try {
          r = await call('/query', { sql, params: params || [] });
        } catch (e) {
          // ALTER ADD COLUMN yang gagal ("duplicate column") = kolom sudah ada -> jangan diulang tiap request
          if (/^\s*alter\s+table/i.test(sql) && /duplicate column/i.test(String(e && e.message))) ddlMark(sql);
          throw e;
        }
        ddlMark(sql);
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
