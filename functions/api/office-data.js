// office-data.js — statistik baca-saja untuk karakter AI Clincoo Office.
// Dipanggil klien Clincoo Office (Worker office) memakai kunci rahasia
// OFFICE_DATA_KEY. HANYA angka agregat (jumlah), TIDAK ADA data pribadi
// (email/nama) yang pernah keluar lewat endpoint ini.
// Diakses publik di middleware (PUBLIC list) tapi validasi kunci di sini.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-office-key',
  'Access-Control-Allow-Methods': 'GET, OPTIONS'
};
const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status, headers: { 'Content-Type': 'application/json', ...CORS }
});

export async function onRequestOptions() { return new Response(null, { status: 204, headers: CORS }); }

export async function onRequestGet({ request, env }) {
  try {
    const url = new URL(request.url);
    const key = String(url.searchParams.get('key') || request.headers.get('x-office-key') || '');
    const expected = String(env.OFFICE_DATA_KEY || '');
    // bandingkan konstan-waktu sederhana (anti timing oracle)
    if (!expected || key.length !== expected.length) return json({ error: 'unauthorized' }, 401);
    let diff = 0;
    for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ key.charCodeAt(i);
    if (diff !== 0) return json({ error: 'unauthorized' }, 401);

    const db = env.DB;
    if (!db) return json({ error: 'D1 not bound' }, 500);

    const q = async (sql) => {
      try { const r = await db.prepare(sql).first(); return r || {}; } catch (e) { return {}; }
    };
    const users = await q(`SELECT COUNT(*) c,
        SUM(CASE WHEN created_at >= datetime('now', 'start of day') THEN 1 ELSE 0 END) hari_ini
      FROM auth_users`);
    const sess = await q(`SELECT COUNT(*) c FROM auth_sessions WHERE expires_at > datetime('now')`);
    const proj = await q(`SELECT COUNT(*) c,
        SUM(CASE WHEN updated_at >= datetime('now', '-7 days') THEN 1 ELSE 0 END) minggu_ini
      FROM user_projects`);

    const out = {
      ok: true,
      generated_at: new Date().toISOString(),
      users_total: Number(users.c) || 0,
      users_new_today: Number(users.hari_ini) || 0,
      sessions_active: Number(sess.c) || 0,
      projects_total: Number(proj.c) || 0,
      projects_active_7d: Number(proj.minggu_ini) || 0
    };
    return json(out);
  } catch (e) {
    return json({ error: String((e && e.message) || e) }, 500);
  }
}
