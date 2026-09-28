// Cloudflare Pages Function — POST /api/notion-proxy
// Proxy minim untuk API Notion (api.notion.com mengirim token dari klien via
// header X-Notion-Token; token TIDAK pernah disimpan di server Clincoo — hanya
// diteruskan per-request, sama dengan pola konektor Drive yang sisi-server tanpa token).
// Dipakai tombol "Kirim ke Notion" di chat untuk menghindari pembatasan CORS browser.
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Notion-Token'
};

function json(obj, status) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: { 'Content-Type': 'application/json', ...CORS } });
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestPost({ request }) {
  const token = request.headers.get('X-Notion-Token') || '';
  if (!token) return json({ error: 'Token Notion tidak ditemukan (X-Notion-Token).' }, 401);
  let body;
  try { body = await request.json(); } catch (e) { return json({ error: 'Body JSON tidak valid.' }, 400); }
  if (!body || typeof body !== 'object') return json({ error: 'Body harus objek page Notion.' }, 400);
  try {
    const res = await fetch('https://api.notion.com/v1/pages', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });
    const text = await res.text();
    return new Response(text, { status: res.status, headers: { 'Content-Type': 'application/json', ...CORS } });
  } catch (e) {
    return json({ error: 'Gagal menghubungi Notion: ' + (e && e.message || e) }, 502);
  }
}
