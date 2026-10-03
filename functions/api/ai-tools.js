// Cloudflare Pages Functions — AI TOOLS: test_secret & cloudflare_request
// Tool super untuk Clincoo AI:
//   POST {action:'test_secret', provider, secret, extra} -> uji status/validitas secret atau API key
//   POST {action:'cloudflare_request', secret, method, path, body} -> akses Cloudflare API
//   POST {action:'build_apk', token, build_action, url/app_name/package_id/build_id...}
//     -> buat APK Android dari website (fondasi PressForge, build GitHub Actions)
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

// ---------- build_apk: buat APK Android dari website via fondasi PressForge ----------
// Build dijalankan GitHub Actions di repo user "pressforge-builds" (workflow build.yml
// dari PressForge: generate proyek WebView -> gradle assembleRelease -> sign -> artifact "apk").
// Token GitHub konektor user dikirim klien dari localStorage (sama seperti github_request).
const APK_REPO_NAME = 'pressforge-builds';
const APK_WORKFLOW_PATH = '.github/workflows/build.yml';
const APK_GENERATOR_PATH = '.forge/generate.py';
const APK_WORKFLOW = `name: build
run-name: forge-\${{ inputs.build_id }}
on:
  workflow_dispatch:
    inputs:
      build_id: { required: true }
      url: { required: true }
      app_name: { required: true }
      package_id: { required: true }
      orientation: { required: true, default: portrait }
      fullscreen: { required: true, default: "true" }
permissions:
  contents: read
jobs:
  apk:
    runs-on: ubuntu-latest
    env:
      BUILD_ID: \${{ inputs.build_id }}
      APP_URL: \${{ inputs.url }}
      APP_NAME: \${{ inputs.app_name }}
      PKG: \${{ inputs.package_id }}
      ORIENT: \${{ inputs.orientation }}
      FULLSCREEN: \${{ inputs.fullscreen }}
    steps:
      - uses: actions/checkout@v4
      - name: Siapkan Java
        uses: actions/setup-java@v4
        with: { distribution: temurin, java-version: "17" }
      - name: Siapkan Gradle
        uses: gradle/actions/setup-gradle@v4
        with: { gradle-version: "8.7" }
      - name: Susun proyek Android
        run: python3 .forge/generate.py
      - name: Compile APK
        run: gradle -p app-src assembleRelease --no-daemon
      - name: Signing APK
        run: |
          BT=$ANDROID_HOME/build-tools/$(ls $ANDROID_HOME/build-tools | sort -V | tail -1)
          keytool -genkeypair -keystore forge.jks -storepass forgepass -keypass forgepass -alias forge -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=PressForge"
          $BT/zipalign -p -f 4 app-src/app/build/outputs/apk/release/app-release-unsigned.apk aligned.apk
          mkdir -p out
          $BT/apksigner sign --ks forge.jks --ks-pass pass:forgepass --key-pass pass:forgepass --out out/app.apk aligned.apk
      - name: Upload APK
        uses: actions/upload-artifact@v4
        with: { name: apk, path: out/app.apk, retention-days: 7 }
`;

function apkB64(s) { return btoa(unescape(encodeURIComponent(s))); }
function apkNewId() { return Math.random().toString(36).slice(2, 12).padEnd(10, '0').slice(0, 10); }
function apkSlugToPackage(url) {
  try {
    const host = (url.replace(/^https?:\/\//, '').split('/')[0] || '').toLowerCase();
    const parts = host.split('.').filter(Boolean).reverse().map((p) => p.replace(/[^a-z0-9_]/g, ''));
    const clean = parts.filter(Boolean).map((p) => (/^[a-z]/.test(p) ? p : 'x' + p));
    if (!clean.length) return 'app.forge.web';
    return [...clean, 'app'].join('.');
  } catch (e) { return 'app.forge.web'; }
}

async function apkGh(token, path, init = {}) {
  return fetch('https://api.github.com' + path, {
    ...init,
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'clincoo-ai',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(init.headers || {})
    }
  });
}

async function apkGhJson(token, path, init = {}) {
  const r = await apkGh(token, path, init);
  const d = await r.json().catch(() => ({}));
  return { status: r.status, ok: r.ok, data: d };
}

async function apkEnsureFiles(token, repo) {
  for (const [path, content] of [[APK_WORKFLOW_PATH, APK_WORKFLOW]]) {
    const r = await apkGhJson(token, `/repos/${repo}/contents/${path}`);
    if (r.status === 404) {
      await apkGhJson(token, `/repos/${repo}/contents/${path}`, {
        method: 'PUT',
        body: JSON.stringify({ message: 'PressForge workflow (auto)', content: apkB64(content) })
      });
    }
  }
}

// Ambil base64 PNG ikon: dari args user, atau salin icons/default.png milik repo.
async function apkResolveIcon(token, repo, iconBase64) {
  let b64 = String(iconBase64 || '').trim();
  const m = b64.match(/^data:image\/[a-z+]+;base64,(.+)$/i);
  if (m) b64 = m[1];
  b64 = b64.replace(/\s/g, '');
  if (b64) {
    if (b64.length > 2000000) return { error: 'Ikon terlalu besar (maks ~1.5MB PNG).' };
    return { b64 };
  }
  const r = await apkGhJson(token, `/repos/${repo}/contents/icons/default.png`);
  if (r.ok && r.data && r.data.content) return { b64: String(r.data.content).replace(/\s/g, '') };
  return { error: 'Ikon default tidak tersedia di repo pressforge-builds (icons/default.png).' };
}

// --- unzip ringan: cari satu file di zip artifact GitHub Actions ---
function apkZipFind(u8, dv, name) {
  let eocd = -1;
  const floor = Math.max(0, u8.length - 22 - 65536);
  for (let i = u8.length - 22; i >= floor; i--) {
    if (u8[i] === 0x50 && u8[i + 1] === 0x4b && u8[i + 2] === 0x05 && u8[i + 3] === 0x06) { eocd = i; break; }
  }
  if (eocd < 0) return null;
  const count = dv.getUint16(eocd + 10, true);
  let off = dv.getUint32(eocd + 16, true);
  const td = new TextDecoder();
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(off, true) !== 0x02014b50) break;
    const method = dv.getUint16(off + 10, true);
    const csize = dv.getUint32(off + 20, true);
    const nlen = dv.getUint16(off + 28, true);
    const elen = dv.getUint16(off + 30, true);
    const clen = dv.getUint16(off + 32, true);
    const lho = dv.getUint32(off + 42, true);
    const nm = td.decode(u8.subarray(off + 46, off + 46 + nlen));
    if (nm === name) {
      const lnlen = dv.getUint16(lho + 26, true);
      const lelen = dv.getUint16(lho + 28, true);
      return { method, csize, start: lho + 30 + lnlen + lelen };
    }
    off += 46 + nlen + elen + clen;
  }
  return null;
}

async function apkZipExtract(buf, name) {
  const u8 = new Uint8Array(buf);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const e = apkZipFind(u8, dv, name);
  if (!e) return null;
  const comp = u8.subarray(e.start, e.start + e.csize);
  if (e.method === 0) return comp;
  if (e.method === 8) {
    const ds = new DecompressionStream('deflate-raw');
    const stream = new Blob([comp]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  throw new Error('Metode kompresi zip tidak didukung (' + e.method + ')');
}

function apkB64FromU8(u8) {
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
  return btoa(s);
}

async function buildApk(body) {
  const token = String(body.token || '').trim();
  if (!token) return jsonOut({ ok: false, error: 'GitHub belum terhubung — hubungkan dulu lewat halaman Integrasi Clincoo.' }, 400);
  const op = String(body.build_action || body.apk_action || 'start').toLowerCase();

  const me = await apkGhJson(token, '/user');
  if (!me.ok) return jsonOut({ ok: false, error: me.status === 401 ? 'Token GitHub tidak valid/expired — hubungkan ulang GitHub di halaman Integrasi.' : ('Gagal mengakses GitHub (HTTP ' + me.status + ').') }, 502);
  const owner = me.data.login;
  const repo = owner + '/' + APK_REPO_NAME;

  // ---------- START ----------
  if (op === 'start') {
    let url = String(body.url || '').trim();
    if (!/^https?:\/\/.+\..+/i.test(url)) return jsonOut({ ok: false, error: 'Parameter url wajib URL lengkap (http/https), contoh "https://app.clincoo.buzz".' }, 400);
    if (url.length > 500) return jsonOut({ ok: false, error: 'URL terlalu panjang.' }, 400);
    let appName = String(body.app_name || '').trim();
    if (!appName) {
      try { appName = (url.replace(/^https?:\/\//, '').split('/')[0] || '').replace(/^www\./, ''); } catch (e) { appName = 'Aplikasi Web'; }
    }
    if (appName.length > 40) appName = appName.slice(0, 40);
    let pkg = String(body.package_id || '').trim().toLowerCase();
    if (pkg && !/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(pkg)) return jsonOut({ ok: false, error: 'package_id tidak valid (format: com.contoh.app, huruf kecil).' }, 400);
    if (!pkg) pkg = apkSlugToPackage(url);
    const orientation = String(body.orientation || 'portrait').toLowerCase() === 'landscape' ? 'landscape' : 'portrait';
    const fullscreen = body.fullscreen === false || body.fullscreen === 'false' ? 'false' : 'true';
    const buildId = apkNewId();

    const rr = await apkGhJson(token, `/repos/${repo}`);
    if (rr.status === 404) return jsonOut({ ok: false, error: 'Repo ' + repo + ' tidak ditemukan di akun GitHub-mu — fondasi PressForge belum tersedia.' }, 404);
    if (!rr.ok) return jsonOut({ ok: false, error: 'Gagal memeriksa repo ' + repo + ' (HTTP ' + rr.status + ').' }, 502);

    await apkEnsureFiles(token, repo);
    const icon = await apkResolveIcon(token, repo, body.icon_base64);
    if (icon.error) return jsonOut({ ok: false, error: icon.error }, 400);

    const up = await apkGhJson(token, `/repos/${repo}/contents/icons/${buildId}.png`, {
      method: 'PUT',
      body: JSON.stringify({ message: 'icon ' + buildId, content: icon.b64 })
    });
    if (!up.ok) return jsonOut({ ok: false, error: 'Gagal mengunggah ikon (HTTP ' + up.status + '): ' + ((up.data && up.data.message) || '') }, 502);

    const dispatchBody = JSON.stringify({
      ref: (rr.data.default_branch || 'main'),
      inputs: { build_id: buildId, url: url, app_name: appName, package_id: pkg, orientation: orientation, fullscreen: String(fullscreen) }
    });
    let lastErr = '';
    for (let i = 0; i < 3; i++) {
      const r = await apkGh(token, `/repos/${repo}/actions/workflows/build.yml/dispatches`, { method: 'POST', body: dispatchBody, headers: { 'Content-Type': 'application/json' } });
      if (r.status === 204) return jsonOut({ ok: true, success: true, build_id: buildId, app_name: appName, package_id: pkg, url: url, orientation: orientation, fullscreen: fullscreen === 'true', repo: repo, status: 'started', note: 'Build berjalan di GitHub Actions (~3-5 menit). Lanjutkan dengan action status memakai build_id ini, beri update ke user, dan setelah done panggil action download.' });
      const t = await r.text().catch(() => '');
      lastErr = `HTTP ${r.status}: ${t.slice(0, 200)}`;
      if (r.status === 403 || r.status === 401) break;
      await new Promise((res) => setTimeout(res, 2500));
    }
    return jsonOut({ ok: false, error: 'Gagal memulai build: ' + lastErr }, 502);
  }

  // ---------- STATUS ----------
  if (op === 'status') {
    const buildId = String(body.build_id || '').trim();
    if (!/^[a-z0-9]{6,16}$/.test(buildId)) return jsonOut({ ok: false, error: 'build_id tidak valid.' }, 400);
    const runs = await apkGhJson(token, `/repos/${repo}/actions/workflows/build.yml/runs?per_page=30`);
    if (!runs.ok) return jsonOut({ ok: false, error: 'Gagal mengambil daftar build (HTTP ' + runs.status + ').' }, 502);
    const run = (runs.data.workflow_runs || []).find((r) => r.display_title === 'forge-' + buildId);
    if (!run) return jsonOut({ ok: true, success: true, build_id: buildId, found: false, status: 'queued', message: 'Run belum muncul — runner GitHub sedah disiapkan, coba lagi beberapa detik.' });
    const jobs = await apkGhJson(token, `/repos/${repo}/actions/runs/${run.id}/jobs`);
    const steps = ((jobs.data && jobs.data.jobs && jobs.data.jobs[0] && jobs.data.jobs[0].steps) || [])
      .filter((x) => !/^(Set up job|Complete job|Post |Set up)/.test(x.name || ''))
      .map((x) => ({ name: x.name, status: x.status, conclusion: x.conclusion }));
    const total = Math.max(steps.length, 1);
    const doneCount = steps.filter((x) => x.status === 'completed').length;
    const out = {
      ok: true, success: true, build_id: buildId, found: true,
      run_id: run.id, status: run.status, conclusion: run.conclusion,
      html_url: run.html_url,
      progress: run.status === 'completed' ? 100 : Math.round((doneCount / total) * 90),
      steps: steps
    };
    if (run.status === 'completed' && run.conclusion === 'success') {
      out.status = 'done';
      const arts = await apkGhJson(token, `/repos/${repo}/actions/runs/${run.id}/artifacts`);
      const art = ((arts.data && arts.data.artifacts) || []).find((a) => a.name === 'apk' && !a.expired);
      out.apk_ready = !!art;
      out.apk_size_bytes = art ? art.size_in_bytes : null;
      out.message = art ? 'APK siap diunduh — panggil action download dengan build_id ini.' : 'Build selesai tapi artifact APK tidak ditemukan/expired (artifact tersimpan 7 hari).';
    } else if (run.status === 'completed') {
      out.status = 'failed';
      const failed = steps.filter((x) => x.conclusion === 'failure').map((x) => x.name);
      out.failed_steps = failed;
      out.message = 'Build gagal: ' + (failed.join(', ') || run.conclusion) + '. Lihat detail: ' + run.html_url;
    } else {
      out.message = 'Build ' + (out.progress) + '% — status: ' + run.status + '. Panggil status lagi setelah beberapa detik.';
    }
    return jsonOut(out);
  }

  // ---------- DOWNLOAD ----------
  if (op === 'download') {
    const buildId = String(body.build_id || '').trim();
    if (!/^[a-z0-9]{6,16}$/.test(buildId)) return jsonOut({ ok: false, error: 'build_id tidak valid.' }, 400);
    const runs = await apkGhJson(token, `/repos/${repo}/actions/workflows/build.yml/runs?per_page=30`);
    if (!runs.ok) return jsonOut({ ok: false, error: 'Gagal mengambil daftar build (HTTP ' + runs.status + ').' }, 502);
    const run = (runs.data.workflow_runs || []).find((r) => r.display_title === 'forge-' + buildId);
    if (!run) return jsonOut({ ok: false, error: 'Build ' + buildId + ' tidak ditemukan.' }, 404);
    if (!(run.status === 'completed' && run.conclusion === 'success')) return jsonOut({ ok: false, error: 'Build belum selesai (status: ' + run.status + (run.conclusion ? '/' + run.conclusion : '') + '). Panggil status dulu sampai done.' }, 409);
    const arts = await apkGhJson(token, `/repos/${repo}/actions/runs/${run.id}/artifacts`);
    const art = ((arts.data && arts.data.artifacts) || []).find((a) => a.name === 'apk' && !a.expired);
    if (!art) return jsonOut({ ok: false, error: 'Artifact APK tidak ditemukan atau sudah kedaluwarsa (hanya tersimpan 7 hari di GitHub).' }, 404);
    if (art.size_in_bytes > 26214400) return jsonOut({ ok: false, error: 'APK terlalu besar untuk diunduh lewat chat (' + Math.round(art.size_in_bytes / 1048576) + 'MB). Unduh manual: ' + run.html_url }, 413);
    let r = await apkGh(token, `/repos/${repo}/actions/artifacts/${art.id}/zip`, { redirect: 'manual' });
    const loc = r.headers.get('location');
    if (r.status >= 300 && r.status < 400 && loc) r = await fetch(loc);
    if (!r.ok) return jsonOut({ ok: false, error: 'Gagal mengunduh artifact dari GitHub (HTTP ' + r.status + ').' }, 502);
    const zipBuf = await r.arrayBuffer();
    let apk = null;
    try { apk = await apkZipExtract(zipBuf, 'app.apk'); } catch (e) { return jsonOut({ ok: false, error: 'Gagal mengekstrak APK dari artifact: ' + (e && e.message ? e.message : String(e)) }, 500); }
    if (!apk) return jsonOut({ ok: false, error: 'File app.apk tidak ada di dalam artifact.' }, 500);
    const safeName = String(body.app_name || 'app').replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 40) || 'app';
    return jsonOut({
      ok: true, success: true, build_id: buildId, run_id: run.id,
      filename: safeName + '-' + buildId + '.apk',
      size: apk.length,
      apk_base64: apkB64FromU8(apk)
    });
  }

  return jsonOut({ ok: false, error: 'build_action tidak dikenal: ' + op + '. Gunakan start, status, atau download.' }, 400);
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
    if (action === 'build_apk') return buildApk(body);
    return jsonOut({ ok: false, error: 'Action tidak dikenal. Gunakan test_secret, cloudflare_request, github_request, drive_request, calendar_request, atau build_apk.' }, 400);
  } catch (e) {
    return jsonOut({ ok: false, error: 'Gagal memproses: ' + (e && e.message ? e.message : String(e)) }, 500);
  }
}

export async function onRequestOptions() {
  return new Response(null, { headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' } });
}
