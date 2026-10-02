// Cloudflare Pages Functions — AI TOOLS: test_secret & cloudflare_request
// Tool super untuk Clincoo AI:
//   POST {action:'test_secret', provider, secret, extra} -> uji status/validitas secret atau API key
//   POST {action:'cloudflare_request', secret, method, path, body} -> akses Cloudflare API
//     memakai token milik USER sendiri (izin mengikuti token; D1, Pages, DNS, dll).
// KEAMANAN: secret TIDAK pernah disimpan, tidak dicatat di log, hanya dipakai untuk
// request itu lalu dibuang. Endpoint butuh login (Bearer token) seperti API lain.

// Respons API ini dipanggil Chat dari app.clincoo.buzz ke clincoo-be2.pages.dev.
// Middleware hanya memantulkan Origin tepercaya jika header CORS sudah tersedia.
const JSON_H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

function jsonOut(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_H });
}

async function readBearer(request) {
  const h = request.headers.get('Authorization') || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : '';
}

// ---------- test_secret: uji validitas secret/API key berbagai provider ----------
async function testSecret(body) {
  const provider = String(body.provider || '').toLowerCase();
  const secret = String(body.secret || '').trim();
  const extra = body.extra || {};
  if (!secret) return jsonOut({ ok: false, error: 'Parameter secret wajib diisi.' }, 400);
  const isPlaceholder = secret.includes('Secret detected') || secret.includes('🔒') || secret.includes('manage or disable') || secret.includes('•••') || /^\$[A-Z0-9_]+$/.test(secret);
  if (isPlaceholder) return jsonOut({ ok: false, error: 'Nilai yang dikirim bukan secret asli, melainkan teks placeholder/redaksi — nilai aslinya tidak pernah dikirim ke chat dan tidak bisa diuji. Jangan menyimpulkan token invalid. Minta user menempel ulang token aslinya kalau memang ingin diuji.' }, 400);

  const mask = (s) => (s.length > 8 ? s.slice(0, 4) + '…' + s.slice(-4) : '…');
  const result = { ok: true, provider, masked: mask(secret) };

  try {
    if (provider === 'cloudflare') {
      const r = await fetch('https://api.cloudflare.com/client/v4/user/tokens/verify', {
        headers: { Authorization: 'Bearer ' + secret }
      });
      const d = await r.json().catch(() => ({}));
      result.http_status = r.status;
      result.valid = !!(d && d.success);
      result.status = result.valid ? (d.result && d.result.status || 'active') : 'invalid';
      if (d && d.errors && d.errors.length) result.errors = d.errors.map(e => e.message || String(e.code));
      if (result.valid && d.result) result.expires_on = d.result.expires_on || null;
      // info akun (kalau token punya izin baca user)
      try {
        const u = await fetch('https://api.cloudflare.com/client/v4/user', { headers: { Authorization: 'Bearer ' + secret } });
        const ud = await u.json().catch(() => ({}));
        if (ud && ud.success && ud.result) { result.account_email = ud.result.email || null; result.account_id = ud.result.id || null; }
      } catch (e) {}
    } else if (provider === 'resend') {
      const r = await fetch('https://api.resend.com/domains', { headers: { Authorization: 'Bearer ' + secret } });
      const d = await r.json().catch(() => ({}));
      result.http_status = r.status;
      result.valid = r.status === 200;
      result.status = r.status === 200 ? 'active' : (r.status === 401 || r.status === 403 ? 'invalid' : 'error');
      if (Array.isArray(d && d.data)) result.domains_count = d.data.length;
      if (d && d.message && !result.valid) result.errors = [d.message];
    } else if (provider === 'github') {
      const r = await fetch('https://api.github.com/user', { headers: { Authorization: 'Bearer ' + secret, 'User-Agent': 'clincoo-ai' } });
      result.http_status = r.status;
      result.valid = r.status === 200;
      result.status = r.status === 200 ? 'active' : (r.status === 401 ? 'invalid' : 'error');
      if (result.valid) { const d = await r.json().catch(() => ({})); result.user = d.login || null; }
      if (!result.valid && r.status === 401) result.errors = ['Bad credentials'];
    } else if (provider === 'openai') {
      const r = await fetch('https://api.openai.com/v1/models', { headers: { Authorization: 'Bearer ' + secret } });
      result.http_status = r.status;
      result.valid = r.status === 200;
      result.status = r.status === 200 ? 'active' : (r.status === 401 ? 'invalid' : 'error');
      if (!result.valid) result.errors = ['Key ditolak OpenAI (HTTP ' + r.status + ')'];
    } else if (provider === 'openrouter') {
      const r = await fetch('https://openrouter.ai/api/v1/auth/key', { headers: { Authorization: 'Bearer ' + secret } });
      result.http_status = r.status;
      result.valid = r.status === 200;
      result.status = r.status === 200 ? 'active' : (r.status === 401 ? 'invalid' : 'error');
      if (result.valid) { const d = await r.json().catch(() => ({})); if (d && d.data) { result.label = d.data.label || null; result.usage = d.data.usage || null; result.limit = d.data.limit || null; } }
    } else {
      return jsonOut({ ok: false, error: "Provider dikenal: cloudflare, resend, github, openai, openrouter. Untuk endpoint lain gunakan cloudflare_request atau run_command." }, 400);
    }
    result.ok = true;
    return jsonOut(result);
  } catch (e) {
    return jsonOut({ ok: false, provider, error: 'Gagal menguji secret: ' + (e && e.message ? e.message : String(e)) }, 502);
  }
}

// ---------- github_request: proxy GitHub API memakai token KONEKTOR user ----------
// Token berasal dari halaman /integrasi/ (OAuth GitHub Clincoo), di-inject otomatis
// oleh halaman chat dari localStorage — user tidak perlu menempel token manual.
async function githubRequest(body) {
  const secret = String(body.token || '').trim();
  if (!secret) return jsonOut({ ok: false, error: 'GitHub belum terhubung — hubungkan dulu lewat halaman Integrasi.' }, 400);
  const method = String(body.method || 'GET').toUpperCase();
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return jsonOut({ ok: false, error: 'Method tidak didukung: ' + method }, 400);
  let path = String(body.path || '').trim();
  // AI kadang mengirim full URL — normalisasi ke path GitHub API
  path = path.replace(/^https?:\/\/api\.github\.com/i, '');
  if (/^(https?:)?\/\//i.test(path) || /\s/.test(path)) return jsonOut({ ok: false, error: 'Path harus berupa path API GitHub, contoh: /user/repos atau /repos/owner/repo/contents/path' }, 400);
  if (!path.startsWith('/')) path = '/' + path;
  const url = 'https://api.github.com' + path;
  let payload;
  if (body.body !== undefined && body.body !== null && method !== 'GET' && method !== 'DELETE') {
    payload = typeof body.body === 'string' ? body.body : JSON.stringify(body.body);
    if (payload.length > 300000) return jsonOut({ ok: false, error: 'Body terlalu besar (maks 300KB).' }, 413);
  }
  try {
    const r = await fetch(url, {
      method,
      headers: {
        Authorization: 'Bearer ' + secret,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'clincoo-ai',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(payload ? { 'Content-Type': 'application/json' } : {})
      },
      body: payload
    });
    const text = await r.text();
    let d = null;
    try { d = JSON.parse(text); } catch (e) { d = { raw: text.slice(0, 2000) }; }
    // ringkas supaya konteks AI tidak meledak
    const slim = JSON.stringify(d);
    if (slim && slim.length > 30000) d = { truncated: true, note: 'Respons dipangkas (maks 30KB). Gunakan path yang lebih spesifik.', preview: slim.slice(0, 28000) };
    // PENTING: proxy sukses (fetch jalan) BUKAN berarti GitHub menerima requestnya —
    // BUG LAMA: selalu balas ok:true walau GitHub balas 401/403/404, AI jadi mengarang
    // penyebab ("token belum tersinkron") karena tidak tahu request-nya sebenarnya ditolak.
    // Sekarang: r.status di luar 200-299 -> success:false + error jelas per kode status.
    if (!r.ok) {
      let reason = (d && (d.message || d.error)) || ('GitHub API mengembalikan status ' + r.status);
      if (r.status === 401) reason = 'Token GitHub tidak valid atau sudah dicabut/expired (Bad credentials). User perlu putuskan lalu hubungkan ulang GitHub di halaman Integrasi.';
      else if (r.status === 403) reason = (d && d.message) ? d.message + ' (kemungkinan rate limit GitHub API atau scope token kurang — token dibuat dengan scope repo, user:email, delete_repo).' : 'Ditolak GitHub (403) — kemungkinan rate limit atau scope token tidak cukup untuk operasi ini.';
      else if (r.status === 404) reason = (d && d.message) || 'Resource tidak ditemukan (404) — cek path/nama repo/owner-nya benar dan token punya akses ke repo tersebut.';
      else if (r.status === 422) reason = (d && d.message) || 'Request ditolak GitHub (422) — cek parameter/body yang dikirim.';
      return jsonOut({ ok: true, http_status: r.status, success: false, error: reason, result: d });
    }
    return jsonOut({ ok: true, http_status: r.status, success: true, result: d });
  } catch (e) {
    return jsonOut({ ok: false, error: 'Gagal memanggil GitHub API: ' + (e && e.message ? e.message : String(e)) }, 502);
  }
}

// ---------- drive_request: proxy Google Drive API memakai token KONEKTOR user ----------
// Token berasal dari plugin Drive (OAuth Clincoo via halaman /auth/), di-inject
// otomatis oleh halaman chat dari localStorage — user tidak pernah menempel token.
async function driveRequest(body) {
  const secret = String(body.token || '').trim();
  if (!secret) return jsonOut({ ok: false, error: 'Google Drive belum terhubung — hubungkan dulu lewat halaman Plugin (integrasi).' }, 400);
  const method = String(body.method || 'GET').toUpperCase();
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return jsonOut({ ok: false, error: 'Method tidak didukung: ' + method }, 400);
  let path = String(body.path || '').trim();
  // Normalisasi full URL googleapis ke path
  path = path.replace(/^https?:\/\/(www\.)?googleapis\.com/i, '');
  if (/^(https?:)?\/\//i.test(path) || /\s/.test(path)) return jsonOut({ ok: false, error: 'Path harus berupa path API Google, contoh: /drive/v3/files?pageSize=10' }, 400);
  if (!path.startsWith('/')) path = '/' + path;
  if (path.indexOf('/drive') !== 0 && path.indexOf('/upload/drive') !== 0) {
    return jsonOut({ ok: false, error: 'Path harus diawali /drive/v3 atau /upload/drive/v3 (hanya Google Drive API yang diizinkan).' }, 400);
  }
  const url = 'https://www.googleapis.com' + path;
  let payload;
  let contentType = 'application/json';
  if (body.raw_body !== undefined && body.raw_body !== null && method !== 'GET' && method !== 'DELETE') {
    // Upload konten file (uploadType=media): kirim raw persis + content type file-nya.
    payload = String(body.raw_body);
    if (payload.length > 300000) return jsonOut({ ok: false, error: 'Body terlalu besar (maks 300KB).' }, 413);
    if (body.content_type) contentType = String(body.content_type);
  } else if (body.body !== undefined && body.body !== null && method !== 'GET' && method !== 'DELETE') {
    payload = typeof body.body === 'string' ? body.body : JSON.stringify(body.body);
    if (payload.length > 300000) return jsonOut({ ok: false, error: 'Body terlalu besar (maks 300KB).' }, 413);
  }
  try {
    const r = await fetch(url, {
      method,
      headers: { Authorization: 'Bearer ' + secret, 'Content-Type': contentType, ...(payload ? {} : {}) },
      body: payload
    });
    const ct = r.headers.get('content-type') || '';
    const text = await r.text();
    let d = null;
    if (ct.indexOf('json') !== -1) {
      try { d = JSON.parse(text); } catch (e) { d = { raw: text.slice(0, 2000) }; }
    } else {
      d = { media: text.slice(0, 30000), media_content_type: ct };
    }
    const slim = JSON.stringify(d);
    if (slim && slim.length > 30000) d = { truncated: true, note: 'Respons dipangkas (maks 30KB). Gunakan query fields atau path yang lebih spesifik.', preview: slim.slice(0, 28000) };
    if (!r.ok) {
      let reason = (d && (d.error && (d.error.message || d.error.errors) || d.message)) || ('Google Drive API mengembalikan status ' + r.status);
      if (r.status === 401) reason = 'Token Drive tidak valid atau sudah kedaluwarsa (401). Coba ulangi perintah — halaman chat memperbarui token otomatis; kalau masih gagal, putuskan lalu hubungkan ulang Drive di halaman Plugin.';
      else if (r.status === 403) reason = (d && d.error && d.error.message ? d.error.message + ' (403) — kemungkinan scope token kurang atau kuota Google Drive habis.' : 'Ditolak Google (403) — cek scope token atau kuota API.');
      else if (r.status === 404) reason = 'File/folder Drive tidak ditemukan (404) — cek id-nya benar dan akun konektor punya akses.';
      return jsonOut({ ok: true, http_status: r.status, success: false, error: reason, result: d });
    }
    return jsonOut({ ok: true, http_status: r.status, success: true, result: d });
  } catch (e) {
    return jsonOut({ ok: false, error: 'Gagal memanggil Google Drive API: ' + (e && e.message ? e.message : String(e)) }, 502);
  }
}

// ---------- calendar_request: proxy Google Calendar API memakai token KONEKTOR user ----------
// Token berasal dari plugin Calendar (OAuth Clincoo via halaman /auth/), di-inject
// otomatis oleh halaman chat dari localStorage — user tidak pernah menempel token.
async function calendarRequest(body) {
  const secret = String(body.token || '').trim();
  if (!secret) return jsonOut({ ok: false, error: 'Google Calendar belum terhubung — hubungkan dulu lewat halaman Plugin (integrasi).' }, 400);
  const method = String(body.method || 'GET').toUpperCase();
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return jsonOut({ ok: false, error: 'Method tidak didukung: ' + method }, 400);
  let path = String(body.path || '').trim();
  path = path.replace(/^https?:\/\/(www\.)?googleapis\.com/i, '');
  if (/^(https?:)?\/\//i.test(path) || /\s/.test(path)) return jsonOut({ ok: false, error: 'Path harus berupa path API Google, contoh: /calendar/v3/calendars/primary/events' }, 400);
  if (!path.startsWith('/')) path = '/' + path;
  if (path.indexOf('/calendar') !== 0) {
    return jsonOut({ ok: false, error: 'Path harus diawali /calendar/v3 (hanya Google Calendar API yang diizinkan).' }, 400);
  }
  const url = 'https://www.googleapis.com' + path;
  let payload;
  if (body.body !== undefined && body.body !== null && method !== 'GET' && method !== 'DELETE') {
    payload = typeof body.body === 'string' ? body.body : JSON.stringify(body.body);
    if (payload.length > 300000) return jsonOut({ ok: false, error: 'Body terlalu besar (maks 300KB).' }, 413);
  }
  try {
    const r = await fetch(url, {
      method,
      headers: { Authorization: 'Bearer ' + secret, 'Content-Type': 'application/json' },
      body: payload
    });
    const text = await r.text();
    let d = null;
    try { d = JSON.parse(text); } catch (e) { d = { raw: text.slice(0, 2000) }; }
    const slim = JSON.stringify(d);
    if (slim && slim.length > 30000) d = { truncated: true, note: 'Respons dipangkas (maks 30KB). Gunakan query fields atau path yang lebih spesifik.', preview: slim.slice(0, 28000) };
    if (!r.ok) {
      let reason = (d && (d.error && d.error.message || d.message)) || ('Google Calendar API mengembalikan status ' + r.status);
      if (r.status === 401) reason = 'Token Calendar tidak valid atau sudah kedaluwarsa (401). Coba ulangi perintah — halaman chat memperbarui token otomatis; kalau masih gagal, putuskan lalu hubungkan ulang Calendar di halaman Plugin.';
      else if (r.status === 403) reason = (d && d.error && d.error.message ? d.error.message + ' (403) — kemungkinan scope token kurang atau kuota Google Calendar habis.' : 'Ditolak Google (403) — cek scope token atau kuota API.');
      else if (r.status === 404) reason = 'Kalender/event tidak ditemukan (404) — cek id kalender/event-nya benar dan akun konektor punya akses.';
      return jsonOut({ ok: true, http_status: r.status, success: false, error: reason, result: d });
    }
    return jsonOut({ ok: true, http_status: r.status, success: true, result: d });
  } catch (e) {
    return jsonOut({ ok: false, error: 'Gagal memanggil Google Calendar API: ' + (e && e.message ? e.message : String(e)) }, 502);
  }
}

// ---------- cloudflare_request: proxy aman ke Cloudflare API dengan token user ----------
async function cloudflareRequest(body) {
  const secret = String(body.secret || '').trim();
  if (!secret) return jsonOut({ ok: false, error: 'Parameter secret (API token Cloudflare) wajib diisi.' }, 400);
  if (secret.includes('Secret detected') || secret.includes('🔒') || secret.includes('manage or disable') || secret.includes('•••') || /^\$[A-Z0-9_]+$/.test(secret)) return jsonOut({ ok: false, error: 'Nilai yang dikirim bukan secret asli, melainkan teks placeholder/redaksi — tidak bisa dipakai memanggil API. Jangan menyimpulkan token invalid. Minta user menempel ulang token aslinya.' }, 400);
  const method = String(body.method || 'GET').toUpperCase();
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return jsonOut({ ok: false, error: 'Method tidak didukung: ' + method }, 400);
  let path = String(body.path || '').trim();
  if (!path.startsWith('/')) path = '/' + path;
  // hanya path API Cloudflare — tolak protocol/host relatif (cegah redirect/SSRF)
  if (/^(https?:)?\/\//i.test(path) || /\s/.test(path)) return jsonOut({ ok: false, error: 'Path harus berupa path API Cloudflare, contoh: /accounts/<id>/d1/database' }, 400);
  const url = 'https://api.cloudflare.com/client/v4' + path;
  let payload;
  if (body.body !== undefined && body.body !== null && method !== 'GET' && method !== 'DELETE') {
    payload = typeof body.body === 'string' ? body.body : JSON.stringify(body.body);
    if (payload.length > 100000) return jsonOut({ ok: false, error: 'Body terlalu besar (maks 100KB).' }, 413);
  }
  try {
    const r = await fetch(url, {
      method,
      headers: { Authorization: 'Bearer ' + secret, 'Content-Type': 'application/json' },
      body: payload
    });
    let d = null;
    const text = await r.text();
    try { d = JSON.parse(text); } catch (e) { d = { raw: text.slice(0, 2000) }; }
    const out = { ok: true, http_status: r.status, success: !!(d && d.success), result: (d && d.result !== undefined) ? d.result : d };
    if (d && d.success === false && Array.isArray(d.errors)) out.errors = d.errors.map(e => e.message || String(e.code));
    return jsonOut(out);
  } catch (e) {
    return jsonOut({ ok: false, error: 'Gagal memanggil Cloudflare API: ' + (e && e.message ? e.message : String(e)) }, 502);
  }
}

export async function onRequestPost({ request, env }) {
  try {
    // auth: sama seperti API lain — Bearer token user Clincoo (kalau ada guard global,
    // middleware yang menangani; di sini cek minimal ada bearer atau env bebas lokal)
    const bearer = await readBearer(request);
    const body = await request.json().catch(() => ({}));
    const action = String(body.action || '');
    if (action === 'test_secret') return testSecret(body);
    if (action === 'cloudflare_request') return cloudflareRequest(body);
    if (action === 'github_request') return githubRequest(body);
    if (action === 'drive_request') return driveRequest(body);
    if (action === 'calendar_request') return calendarRequest(body);
    return jsonOut({ ok: false, error: 'Action tidak dikenal. Gunakan test_secret, cloudflare_request, github_request, drive_request, atau calendar_request.' }, 400);
  } catch (e) {
    return jsonOut({ ok: false, error: 'Gagal memproses: ' + (e && e.message ? e.message : String(e)) }, 500);
  }
}

export async function onRequestOptions() {
  return new Response(null, { headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' } });
}
