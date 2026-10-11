// GET /api/health -> cek ringan ketersediaan database (baca baris SUNGGUHAN).
// Dipakai halaman /maintenance.html untuk deteksi "sistem sudah normal" dan
// mengalihkan pengunjung otomatis. Publik (tanpa login) — hanya boolean.
// CATATAN: jangan pakai "SELECT 1" — itu tidak dihitung sebagai baca baris
// dan lolos meski kuota baca harian database sudah habis (hasil: cek bohong).
export async function onRequestOptions() { return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*' } }); }

export async function onRequestGet({ env }) {
  const db = env.DB;
  if (!db) return Response.json({ ok: false, reason: 'no-binding' }, { status: 503 });
  try {
    const row = await db.prepare("SELECT value FROM env_vars WHERE key = 'GOOGLE_CLIENT_ID'").first();
    return Response.json({ ok: !!(row && row.value) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    return Response.json({ ok: false }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}
