// [22 Okt] Jejak upload workspace: klien (/proyek/code) mengirim ringkasan kejadian
// (impor mulai/selesai, push ok/gagal, kuota penuh) supaya kegagalan di perangkat
// user tidak lagi "hilang tanpa jejak". Tidak menyimpan isi file / data pribadi.
// PUBLIC (tanpa login) — payload kecil, dibatasi & dibersihkan otomatis.
let _tblOk = false;
export async function onRequestPost({ request, env }) {
  if (!env.DB) return new Response(JSON.stringify({ ok: false }), { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
  const db = env.DB;
  try {
    const body = await request.json();
    const pid = String((body && body.project_id) || '').slice(0, 64);
    const ua = String((body && body.ua) || '').slice(0, 140);
    const events = Array.isArray(body && body.events) ? body.events.slice(0, 12) : [];
    const clean = events.map(e => ({
      t: String((e && e.t) || '').slice(0, 12),
      k: String((e && e.k) || '').slice(0, 24),
      d: String((e && e.d) || '').slice(0, 180)
    }));
    if (!pid || !clean.length) return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
    if (!_tblOk) {
      await db.prepare(`CREATE TABLE IF NOT EXISTS ws_client_diag (
        id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT, ua TEXT, events TEXT, created_at TEXT DEFAULT (datetime('now'))
      )`).run();
      try { await db.prepare(`ALTER TABLE ws_client_diag ADD COLUMN ua TEXT`).run(); } catch (e) {}
      _tblOk = true;
    }
    await db.prepare('INSERT INTO ws_client_diag (project_id, ua, events) VALUES (?, ?, ?)')
      .bind(pid, ua, JSON.stringify(clean)).run();
    try { await db.prepare("DELETE FROM ws_client_diag WHERE created_at < datetime('now','-2 days')").run(); } catch (e) {}
    return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false }), { status: 400, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
  }
}
