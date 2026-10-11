// DIAGNOSTIC SEMENTARA (cutover D1) — mengembalikan status d1Remote tanpa data sensitif.
// Dipanggil dalam sesi login; setelah cutover diverifikasi, file ini dihapus.
export async function onRequestGet({ request, env }) {
  const j = (o) => new Response(JSON.stringify(o), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
  try {
    return j({
      ok: true,
      has_url: !!env.D1MIGR_URL,
      has_key: !!env.D1MIGR_KEY,
      wrapped: !!(env.DB && env.DB.__d1remote),
      url_host: env.D1MIGR_URL ? String(env.D1MIGR_URL).replace(/^https?:\/\//, '').split('/')[0] : null
    });
  } catch (e) {
    return j({ ok: false, error: String(e && e.message) });
  }
}
