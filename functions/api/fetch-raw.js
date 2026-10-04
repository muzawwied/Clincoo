// Cloudflare Pages Functions - raw fetch proxy untuk tool clone_url.
// Mengunduh isi URL apa adanya (HTML/CSS/JS) dari sisi server agar tidak
// kena pembatasan CORS browser. http/https saja, maks 256KB per file,
// timeout 12 detik, host internal/lokal diblokir (SSRF dasar).

const MAX_BYTES = 262144;

function jsonOut(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
  });
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    }
  });
}

export async function onRequestPost({ request }) {
  try {
    const body = await request.json().catch(() => ({}));
    const url = String((body && body.url) || '').trim();
    if (!/^https?:\/\//i.test(url)) return jsonOut({ error: 'Parameter url wajib berupa URL lengkap (http/https).' }, 400);

    let host = '';
    try { host = new URL(url).hostname.toLowerCase(); } catch (e) { return jsonOut({ error: 'URL tidak valid.' }, 400); }
    if (!host || /^(localhost|127\.|0\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|::1|\[)/.test(host)) {
      return jsonOut({ error: 'Host internal/lokal tidak diizinkan.' }, 400);
    }

    let res;
    try {
      res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; ClincooClone/1.0; +https://clincoo.buzz)',
          'Accept': 'text/html,application/xhtml+xml,text/css,application/javascript,text/plain,*/*'
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(12000)
      });
    } catch (e) {
      return jsonOut({ error: 'Gagal terhubung ke situs: ' + (e && e.message ? e.message : String(e)) }, 400);
    }
    if (!res.ok) return jsonOut({ error: 'Situs menolak permintaan (HTTP ' + res.status + ').' }, 400);

    const buf = await res.arrayBuffer().catch(() => null);
    if (!buf || !buf.byteLength) return jsonOut({ error: 'Respons situs kosong.' }, 400);
    const truncated = buf.byteLength > MAX_BYTES;
    const bytes = new Uint8Array(truncated ? buf.slice(0, MAX_BYTES) : buf);

    // base64 per chunk (hindari stack overflow btoa pada array besar)
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    const b64 = btoa(bin);

    return jsonOut({
      ok: true,
      status: res.status,
      content_type: res.headers.get('content-type') || '',
      final_url: res.url || url,
      base64: b64,
      size: bytes.length,
      truncated: truncated
    }, 200);
  } catch (e) {
    return jsonOut({ error: 'Proxy gagal: ' + (e && e.message ? e.message : String(e)) }, 400);
  }
}
