// Cloudflare Pages Function — /api/screenshot (SELF-CONTAINED)
// Tool screenshot halaman web untuk AI Clincoo: buat gambar pratinjau URL
// dan kembalikan LINK gambar (hosted) yang bisa langsung dibagikan ke user.
// Sumber gambar: thum.io (utama, kualitas bagus) + fallback mshots WordPress.
// Endpoint: GET /api/screenshot?url=...&width=...  → { ok, url, fallback_url }
// Tool chat AI: take_screenshot (dieksekusi server-side di chat.js).

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};
export async function onRequestOptions() {
  return new Response(null, { status: 200, headers: CORS });
}

const MAX_WIDTH = 1600;
const DEFAULT_WIDTH = 1200;

export async function takeScreenshot(url, width) {
  url = String(url || '').trim();
  if (!/^https?:\/\//i.test(url)) return { error: 'URL tidak valid — harus diawali http:// atau https://' };
  if (url.length > 2000) return { error: 'URL terlalu panjang' };
  const w = Math.max(400, Math.min(parseInt(width, 10) || DEFAULT_WIDTH, MAX_WIDTH));
  // thum.io mengembalikan gambar siap pakai di URL stabil; mshots kadang butuh
  // refresh pertama (mengembalikan placeholder) — sediakan keduanya ke AI/user.
  const thumb = 'https://image.thum.io/get/width/' + w + '/' + url;
  const mshots = 'https://s.wordpress.com/mshots/v1/' + encodeURIComponent(url) + '?w=' + w;
  return {
    ok: true,
    url: thumb,
    fallback_url: mshots,
    note: 'Bila gambar masih kosong, tunggu beberapa detik lalu buka ulang link (layanan capture perlu waktu untuk halaman baru).'
  };
}

async function resolveUser(env, request) {
  try {
    const { initTables, getUserByToken, getToken } = await import('./auth/shared.js');
    await initTables(env.DB);
    const token = getToken(request);
    if (!token) return null;
    const u = await getUserByToken(env.DB, token);
    if (u) return true;
  } catch (e) {}
  return null;
}

export async function onRequestGet({ request, env }) {
  const ok = await resolveUser(env, request);
  if (!ok) return new Response(JSON.stringify({ error: 'Login diperlukan', need_login: true }), { status: 401, headers: { 'Content-Type': 'application/json', ...CORS } });
  const q = new URL(request.url).searchParams;
  const result = await takeScreenshot(q.get('url') || '', q.get('width'));
  return new Response(JSON.stringify(result), { status: result.error ? 400 : 200, headers: { 'Content-Type': 'application/json', ...CORS } });
}
