// GET /api/health -> cek ringan ketersediaan database (1 baca baris).
// Dipakai halaman /maintenance.html untuk deteksi "sistem sudah normal" dan
// mengalihkan pengunjung otomatis. Publik (tanpa login) — hanya boolean.
export async function onRequestOptions() { return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*' } }); }

export async function onRequestGet({ env }) {
  const db = env.DB;
  if (!db) return Response.json({ ok: false, reason: 'no-binding' }, { status: 503 });
  try {
    await db.prepare('SELECT 1').first();
    return Response.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    return Response.json({ ok: false }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}
