// DIAGNOSTIC SEMENTARA (cutover D1) — GET: status d1Remote; ?write=1 juga INSERT marker.
// Tidak mengandung data sensitif. Setelah cutover terverifikasi, file ini DIHAPUS.
export async function onRequestGet({ request, env }) {
  const j = (o) => new Response(JSON.stringify(o), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
  try {
    const out = {
      ok: true,
      has_url: !!env.D1MIGR_URL,
      has_key: !!env.D1MIGR_KEY,
      wrapped: !!(env.DB && env.DB.__d1remote),
      url_host: env.D1MIGR_URL ? String(env.D1MIGR_URL).replace(/^https?:\/\//, '').split('/')[0] : null
    };
    const url = new URL(request.url);
    if (url.searchParams.get('write') === '1' && env.DB && env.DB.__d1remote) {
      const r = await env.DB.prepare(
        "INSERT INTO activity_log (action, details) VALUES ('d1_cutover_verify', ?)"
      ).bind('write dari prod shim ' + new Date().toISOString()).run();
      out.write_meta = r.meta || null;
    }
    return j(out);
  } catch (e) {
    return j({ ok: false, error: String(e && e.message) });
  }
}
