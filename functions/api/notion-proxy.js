// Cloudflare Pages Function — POST /api/notion-proxy
// Proxy minim untuk API Notion. Token dikirim klien via header X-Notion-Token
// (token OAuth dari konektor /api/notion-oauth atau internal token user) dan
// TIDAK pernah disimpan di server Clincoo — hanya diteruskan per-request.
// Dipakai tombol "Kirim ke Notion" di chat (hindari pembatasan CORS browser).
// Body:
//   { action: 'search' }                     -> daftar halaman yang bisa diakses token
//   { action: 'page', page_id }              -> info 1 halaman (validasi)
//   lain / tanpa action                      -> buat halaman baru (body = objek page Notion)
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Notion-Token, Authorization'
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
  if (!body || typeof body !== 'object') return json({ error: 'Body harus objek JSON.' }, 400);

  const notionHeaders = {
    'Authorization': 'Bearer ' + token,
    'Notion-Version': '2022-06-28',
    'Content-Type': 'application/json'
  };

  try {
    // ---- aksi: cari halaman yang bisa diakses (untuk pemilih halaman tujuan) ----
    if (body.action === 'search') {
      const res = await fetch('https://api.notion.com/v1/search', {
        method: 'POST',
        headers: notionHeaders,
        body: JSON.stringify({
          filter: { property: 'object', value: 'page' },
          page_size: 50,
          sort: { direction: 'descending', timestamp: 'last_edited_time' }
        })
      });
      const text = await res.text();
      let pages = [];
      try {
        const data = JSON.parse(text);
        pages = (data.results || []).map(p => {
          const props = (p.properties && Object.values(p.properties)) || [];
          let title = '';
          for (const pr of props) {
            if (pr && pr.type === 'title' && Array.isArray(pr.title) && pr.title.length) {
              title = pr.title.map(t => (t.plain_text || '')).join('');
              break;
            }
          }
          return { id: p.id, title: title || 'Tanpa judul', parent_type: (p.parent && p.parent.type) || '' };
        });
        return new Response(JSON.stringify({ ok: res.ok, status: res.status, pages }), {
          status: res.ok ? 200 : res.status,
          headers: { 'Content-Type': 'application/json', ...CORS }
        });
      } catch (eP) {
        return new Response(text, { status: res.status, headers: { 'Content-Type': 'application/json', ...CORS } });
      }
    }

    // ---- aksi: info 1 halaman (validasi halaman tujuan) ----
    if (body.action === 'page') {
      const pid = String(body.page_id || '').replace(/-/g, '');
      if (!/^[0-9a-f]{32}$/i.test(pid)) return json({ error: 'ID halaman tidak valid.' }, 400);
      const res = await fetch('https://api.notion.com/v1/pages/' + pid, { headers: notionHeaders });
      const text = await res.text();
      let out = { ok: res.ok, status: res.status };
      try {
        const data = JSON.parse(text);
        if (res.ok) {
          const props = (data.properties && Object.values(data.properties)) || [];
          let title = '';
          for (const pr of props) {
            if (pr && pr.type === 'title' && Array.isArray(pr.title) && pr.title.length) {
              title = pr.title.map(t => (t.plain_text || '')).join('');
              break;
            }
          }
          out = { ok: true, status: 200, id: data.id, title: title || 'Tanpa judul', parent_type: (data.parent && data.parent.type) || '' };
        } else {
          out = { ok: false, status: res.status, error: (data.message || data.code || 'gagal') };
        }
      } catch (eJ) {}
      return json(out, res.ok ? 200 : res.status);
    }

    // ---- default: buat halaman baru (body = objek page Notion utuh) ----
    const res = await fetch('https://api.notion.com/v1/pages', {
      method: 'POST',
      headers: notionHeaders,
      body: JSON.stringify(body)
    });
    const text = await res.text();
    return new Response(text, { status: res.status, headers: { 'Content-Type': 'application/json', ...CORS } });
  } catch (e) {
    return json({ error: 'Gagal menghubungi Notion: ' + (e && e.message || e) }, 502);
  }
}
