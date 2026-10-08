// Middleware /api/* — semua endpoint wajib login (Bearer), KECUALI:
//   - /api/auth/*        (login, register, me, oauth akun)
//   - /api/github-oauth* (redirect callback GitHub, tanpa header Bearer)
//   - /api/topup*        (callback Xendit divalidasi sendiri via x-callback-token)
//   - /api/topup-qris*   (webhook BuatQris diverifikasi sendiri via HMAC X-BuatQris-Signature; create/status wajib Bearer di dalam handler)
//   - /api/scheduled-tasks (endpoint memvalidasi sendiri: aksi user wajib Bearer, run_due wajib x-cron-secret)
//   - /api/wallet-sync*  (endpoint memvalidasi sendiri: config wajib Bearer; jalur eksternal wajib api_key)
//   - /api/collab*        (GET info undangan publik via token rahasia; POST divalidasi sendiri di collab.js)
//   - /api/chat*          (PROXY kuota AI per-user — validasi sendiri: token lokal atau be2)
//   - /api/wa*            (webhook WhatsApp Meta: verifikasi hub.challenge + struktur payload; kirim manual wajib Bearer admin)
//   - /api/template-submissions* (galeri template publik: GET list setuju & track = publik;
//                                  POST submit memvalidasi Bearer sendiri di handler;
//                                  review via token unik per pengajuan)
//   - /api/email*         (Email API: aksi kelola wajib Bearer; action=send publik via api_key per proyek, divalidasi sendiri)
//   - preflight OPTIONS  (CORS)
// Respons 401 sama seperti versi production: {"error":"Login diperlukan","need_login":true}
//
// ===== LAPISAN KEAMANAN GLOBAL (anti-DDoS L7, anti-phishing, anti-celah umum) =====
//   1. Rate limit per IP (global, auth, admin) — sliding window in-memory per isolate.
//      Serangan volumetrik (L3/L4) diserap Cloudflare; lapisan ini melindungi aplikasi (L7).
//   2. Validasi Origin untuk request yang mengubah data (POST/PUT/PATCH/DELETE) ke
//      /api/auth dan /api/admin — mencegah request lintas situs dari halaman phishing.
//   3. Cap ukuran body (1.5 MB) — mencegah flood payload besar.
//   4. Blokir cepat path scanner umum (.env, wp-login, .php, .git, phpmyadmin).
//   5. Security headers di semua respons API + Cache-Control: no-store untuk /api/admin
//      (data sensitif tidak pernah nempel di cache).
import { initTables as initAuthTables, getUserByToken, getToken } from './auth/shared.js';

// /api/pay  -> publik: action create/status meng-autentikasi sendiri via pay_key
//             (clc_pay_...) demi situs deploy; action lain tetap cek sesi (requireOwned).
// /api/mcp  -> publik: klien AI luar tidak punya sesi Clincoo; handler mcp.js
//             memverifikasi token MCP per proyek + izin read/write/delete sendiri.
const PUBLIC = [/^\/api\/admin\/auth(\/|$)/, /^\/api\/pay(\/|$)/, /^\/api\/ai$/, /^\/api\/mcp(\/|$)/, /^\/api\/fn-db(\/|$)/, /^\/api\/beta-claim(\/|$)/, /^\/api\/promo(\/|$)/, /^\/api\/template-submissions(\/|$)/, /^\/api\/auth(\/|$)/, /^\/api\/github-oauth(\/|$)/, /^\/api\/topup(-qris)?(\/|$)/, /^\/api\/wallet(\/|$)/, /^\/api\/scheduled-tasks(\/|$)/, /^\/api\/user-report-sync(\/|$)/, /^\/api\/wallet-sync(\/|$)/, /^\/api\/collab(\/|$)/, /^\/api\/chat(\/|$)/, /^\/api\/prompt-templates(\/|$)/, /^\/api\/wa(\/|$)/, /^\/api\/email(\/|$)/, /^\/api\/promo-email(\/|$)/];

// ---- 1. RATE LIMIT (anti-DDoS L7 / anti-brute-force) ----
const _buckets = new Map(); // key -> array timestamp
const RL = {
  global: { limit: 400, window: 5 * 60 * 1000 },   // per IP: semua /api/*
  auth:   { limit: 40,  window: 5 * 60 * 1000 },   // per IP: /api/auth/* (anti brute-force login)
  admin:  { limit: 180, window: 5 * 60 * 1000 },   // per IP: /api/admin/*
  claim:  { limit: 8, window: 10 * 60 * 1000 }     // per IP: /api/beta-claim (kirim email klaim)
};
function rateLimit(key, cfg) {
  const now = Date.now();
  let arr = (_buckets.get(key) || []).filter(t => now - t < cfg.window);
  if (arr.length >= cfg.limit) { _buckets.set(key, arr); return false; }
  arr.push(now);
  _buckets.set(key, arr);
  if (_buckets.size > 8000) { // gc ringan agar memori isolate tidak membengkak
    for (const [k, v] of _buckets) if (!v.some(t => now - t < cfg.window)) _buckets.delete(k);
  }
  return true;
}
function ipOf(request) {
  return (request.headers.get('cf-connecting-ip') || (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown');
}
function tooMany(retryAfter) {
  return new Response(JSON.stringify({ error: 'Terlalu banyak permintaan. Coba lagi nanti.' }), {
    status: 429,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Retry-After': String(retryAfter) }
  });
}

// ---- 2. VALIDASI ORIGIN (anti-phishing / anti-lints-situs) ----
// DUA TINGKAT KEPERCAYAAN (perbaikan keamanan):
//  a) originOk — LONGGAR: hanya untuk echo CORS preflight (OPTIONS). Diperlukan karena
//     situs hasil deploy user (subdomain *.biz.id lama dan cadangan *.pages.dev)
//     memanggil /api/fn lintas-origin. Token auth = header Bearer (bukan cookie),
//     jadi echo CORS longgar tidak memberi akses apa pun tanpa token.
//  b) strictOriginOk — KETAT: untuk mutasi /api/auth dan /api/admin. HANYA host milik
//     Clincoo sendiri. Sebelumnya regex menerima SEMUA subdomain *.pages.dev /
//     *.workers.dev milik siapa pun (halaman phising siapa pun lolos cek ini).
const ORIGIN_ALLOW = /^(^[^.:]+\.pages\.dev$)|(^muzawwied\.github\.io$)|(^[^.:]+\.workers\.dev$)|(^([\w-]+\.)*clincoo\.buzz$)|(^([\w-]+\.)*clin[q]oo\.biz\.id$)|(^([\w-]+\.)*clincoo\.biz\.id$)/;
const ORIGIN_STRICT = /^(^clincoo-be2\.pages\.dev$)|(^clin[q]oo\.pages\.dev$)|(^muzawwied\.github\.io$)|(^([\w-]+\.)*clincoo\.buzz$)|(^localhost(:\d+)?$)/;
function originOk(request) {
  const origin = request.headers.get('origin');
  if (!origin) return true; // curl / webhook server (BuatQris, e-wallet) — tanpa browser
  try {
    const o = new URL(origin);
    const host = new URL(request.url).host;
    return o.host === host || ORIGIN_ALLOW.test(o.host);
  } catch { return false; }
}
function strictOriginOk(request) {
  const origin = request.headers.get('origin');
  if (!origin) return false; // mutasi auth/admin WAJIB bawa Origin browser resmi
  try {
    const o = new URL(origin);
    const host = new URL(request.url).host;
    return o.host === host || ORIGIN_STRICT.test(o.host);
  } catch { return false; }
}

// ---- 4. PATH SCANNER ----
const SCANNER = /(\.env|wp-login|\.php|\.git|phpmyadmin|wp-admin)/i;


// ---- CCTV: catat pemblokiran (scanner / rate-limit / origin jahat) ke security_events ----
let _secTableOk = false;
async function logBlocked(env, type, ip, detail) {
  if (!env.DB) return;
  try {
    if (!_secTableOk) {
      await env.DB.prepare("CREATE TABLE IF NOT EXISTS security_events (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, ip TEXT, email TEXT, detail TEXT, created_at TEXT DEFAULT (datetime('now')))");
      _secTableOk = true;
    }
    await env.DB.prepare("INSERT INTO security_events (type, ip, detail) VALUES (?, ?, ?)").bind(type, ip || null, detail || null).run();
  } catch (e) { /* jangan ganggu respons */ }
}

export async function onRequest({ request, env, next }) {
  if (request.method === 'OPTIONS') {
    // Preflight CORS: hanya echo origin yang lolos allowlist (bukan '*' — audit #3).
    // Origin asing tetap bisa request tanpa-cors dari server, tapi browser diblok.
    const origin = request.headers.get('origin');
    if (origin && originOk(request)) {
      return new Response(null, { status: 204, headers: {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': request.headers.get('access-control-request-headers') || 'Content-Type, Authorization',
        'Access-Control-Max-Age': '86400',
        'Vary': 'Origin'
      } });
    }
    return new Response(null, { status: 204 });
  }
  const url = new URL(request.url);
  const path = url.pathname;

  // 4. Blokir path scanner umum dengan cepat (tanpa beban D1)
  if (SCANNER.test(path)) {
    await logBlocked(env, 'scanner_blocked', ipOf(request), path);
    return new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
  }

  // 1. Rate limit per IP — kelas berbeda untuk auth & admin
  const ip = ipOf(request);
  if (!rateLimit('g:' + ip, RL.global)) { await logBlocked(env, 'rate_limited', ip, 'global ' + path); return tooMany(60); }
  if (/^\/api\/admin(\/|$)/.test(path) && !rateLimit('m:' + ip, RL.admin)) { await logBlocked(env, 'rate_limited', ip, 'admin ' + path); return tooMany(60); }
  if (/^\/api\/beta-claim(\/|$)/.test(path) && request.method === 'POST' && !rateLimit('c:' + ip, RL.claim)) { await logBlocked(env, 'rate_limited', ip, 'beta-claim ' + path); return tooMany(60); }

  // 1b. Rate limit DURABEL (D1) untuk request autentikasi yang mengubah data
  //     (login/register/sesi) — anti brute-force yang tahan lintas-isolate.
  //     In-memory di atas tetap jadi lapisan pertama yang murah.
  const mutatesNow = request.method !== 'GET' && request.method !== 'HEAD';
  if (mutatesNow && /^\/api\/auth(\/|$)/.test(path) && env.DB) {
    try {
      const minute = Math.floor(Date.now() / 60000); // jendela 1 menit
      const window = Math.floor(minute / 5);         // bucket 5 menit
      const key = ip + '|' + window;
      await env.DB.prepare('CREATE TABLE IF NOT EXISTS rl_auth (k TEXT PRIMARY KEY, c INTEGER DEFAULT 0, exp INTEGER)').run();
      const row = await env.DB.prepare('SELECT c FROM rl_auth WHERE k = ?').bind(key).first();
      const count = (row?.c || 0) + 1;
      if (!row) {
        await env.DB.prepare('INSERT INTO rl_auth (k, c, exp) VALUES (?, 1, ?)').bind(key, (window + 1) * 5 * 60000).run();
      } else {
        await env.DB.prepare('UPDATE rl_auth SET c = ? WHERE k = ?').bind(count, key).run();
      }
      if (count > 20) return tooMany(60); // 20 percobaan / 5 menit per IP
      if (count === 1) { // bersihkan entri kedaluwarsa sesekali
        try { await env.DB.prepare('DELETE FROM rl_auth WHERE exp < ?').bind(Date.now()).run(); } catch (e2) {}
      }
    } catch (e) { /* jangan blokir traffic karena DB gangguan */ }
  }

  // 2. Anti-lintas-situs untuk request yang mengubah data di endpoint sensitif
  const mutates = request.method !== 'GET' && request.method !== 'HEAD';
  if (mutates && (/^\/api\/(auth|admin)(\/|$)/.test(path)) && !strictOriginOk(request)) {
    await logBlocked(env, 'origin_blocked', ipOf(request), path + ' dari ' + (request.headers.get('origin') || '?'));
    return new Response(JSON.stringify({ error: 'Permintaan lintas situs ditolak.' }), {
      status: 403, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }

  // 2b. ANTI-BOT /api/auth: hanya browser sungguhan yang sah.
  //     Auth email sudah dihapus total -> tidak ada lagi klien non-browser (curl/SDK)
  //     yang sah menyentuh /api/auth. UA bot diblok; request yang mengubah data WAJIB
  //     membawa Origin browser resmi (sebelumnya origin kosong masih diizinkan).
  if (/^\/api\/auth(\/|$)/.test(path)) {
    const ua = request.headers.get('user-agent') || '';
    const BOT_UA = /(curl|wget|python-requests|python-urllib|scrapy|httpclient|go-http|java\/|libwww|okhttp|axios|node-fetch|bot|crawler|spider|headlesschrome|phantomjs|selenium|puppeteer|playwright)/i;
    if (!ua || BOT_UA.test(ua)) {
      await logBlocked(env, 'bot_ua_blocked', ip, path + ' UA=' + (ua || 'kosong').slice(0, 90));
      return new Response(JSON.stringify({ error: 'Ditolak.' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
    }
    if (mutates && !(request.headers.get('origin') && strictOriginOk(request))) {
      await logBlocked(env, 'origin_blocked', ip, 'auth-wajib-origin ' + path);
      return new Response(JSON.stringify({ error: 'Permintaan lintas situs ditolak.' }), {
        status: 403, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }
  }

  // 3. Cap ukuran body (anti flood payload besar)
  // [8 Okt 2026] Pengecualian: POST /api/chat & /api/ai (mode placeholder AI) —
  // sesi chat lama bisa >1.5MB (riwayat+foto+hasil tool); gate ini dulunya membuat
  // request gagal SEBELUM placeholder dijawab -> client jatuh ke fallback -> guest
  // ditolak 401 -> user lihat "Lagi ada gangguan koneksi". Handler placeholder
  // TIDAK membaca body besar, jadi tidak ada risiko flood ekstra di jalur ini.
  const cl = parseInt(request.headers.get('content-length') || '0', 10);
  const aiPhBypass = mutates && ((/^\/api\/chat(\/|$)/.test(path)) || path === '/api/ai');
  if (cl > 1500000 && !aiPhBypass) {
    // Pengecualian: simpan file workspace (/api/project-files) — file media besar
    // (mp3 dll) dikirim klien sebagai SATU body JSON berisi content_b64, jadi butuh
    // cap lebih besar. HANYA untuk request yang LOGIN: token divalidasi dulu;
    // guest / token tak valid tetap kena cap 1.5MB.
    // Pengecualian kedua: /api/chat (login) — sesi AI dengan banyak tool-use panjang
    // (baca halaman web, buat/baca beberapa backend function sekaligus, hasil tool
    // bertumpuk) bisa membuat body (system prompt + riwayat + tool_results) tembus
    // 1.5MB meski bukan upload file. Tanpa ini, sesi panjang kena 413 di SEMUA jalur
    // termasuk fallback retry-nya (body sama besar) -> user cuma lihat "ada gangguan
    // koneksi" padahal penyebabnya payload kelewat besar, bukan koneksi.
    let bigUpload = false;
    // Pengecualian ketiga: /api/deploy-upload (login) — proxy upload aset Pages
    // untuk deploy orkestrasi browser; satu file besar (maks 25 MB) dikirim
    // sebagai SATU payload JSON base64, jadi butuh cap 50 MB juga.
    const isBigPath = path === '/api/project-files' || path === '/api/deploy-upload' || /^\/api\/chat(\/|$)/.test(path);
    const capFor = (path === '/api/project-files' || path === '/api/deploy-upload') ? 50 * 1024 * 1024 : 15 * 1024 * 1024;
    if (cl <= capFor && isBigPath && mutates) {
      try {
        if (env.DB) {
          await initAuthTables(env.DB);
          const u = await getUserByToken(env.DB, getToken(request));
          if (u) bigUpload = true;
        }
      } catch (e) { /* anggap guest */ }
    }
    if (!bigUpload) {
      // CORS wajib ada di sini: editor produksi (app.clincoo.buzz / domain pages.dev lama)
      // memanggil API lintas-origin (clincoo-be2.pages.dev). Tanpa header ini browser
      // memblokir respons dari dibaca skrip -> fetch() melempar "Failed to fetch" dan
      // pesan asli ("Payload terlalu besar") tidak pernah sampai ke user (notifikasi
      // workspace jadi salah diagnosis sebagai masalah koneksi).
      return new Response(JSON.stringify({ error: 'Payload terlalu besar.' }), {
        status: 413, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }
  }

  let publicRoute = false;
  for (const re of PUBLIC) if (re.test(path)) { publicRoute = true; break; }

  // Panel Admin mandiri (admin.clincoo.buzz): /api/admin/* boleh lolos via kunci panel
  // (header x-admin-key, env ADMIN_PANEL_KEY) — divalidasi ketat di sini DAN lagi di
  // handler admin.js (keyAuthUser). Origin mutasi tetap wajib lolos strictOriginOk.
  if (!publicRoute && /^\/api\/admin(\/|$)/.test(path) && env.ADMIN_PANEL_KEY) {
    const expected = String(env.ADMIN_PANEL_KEY).trim();
    const given = (request.headers.get('x-admin-key') || '').trim();
    if (given && given.length === expected.length) {
      let diff = 0;
      for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ given.charCodeAt(i);
      if (diff === 0) publicRoute = true;
    }
  }
  // /api/fn/<nama>?key=... = WEBHOOK PUBLIK: validasi name+key rahasia dilakukan
  // sendiri di handler fn/[name].js (is_public + webhook_secret + rate limit per IP).
  if (!publicRoute && /^\/api\/fn\/[^/]+$/.test(path) && url.searchParams.get('key')) publicRoute = true;

  if (!publicRoute) {
    try {
      if (env.DB) {
        await initAuthTables(env.DB);
        const user = await getUserByToken(env.DB, getToken(request));
        if (user) publicRoute = true; // lolos auth
      }
    } catch (e) { /* lanjut ke 401 */ }
    if (!publicRoute) {
      return new Response(JSON.stringify({ error: 'Login diperlukan', need_login: true }), {
        status: 401,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }
  }

  // 5. Security headers + no-store untuk data sensitif admin
  const res = await next();
  try {
    const h = new Headers(res.headers);
    // CORS allowlist (audit #3): handler lama menulis '*'; ganti dengan origin
    // request bila lolos allowlist, atau hapus sama sekali bila origin asing.
    const reqOrigin = request.headers.get('origin');
    if (reqOrigin && h.get('Access-Control-Allow-Origin')) {
      if (originOk(request)) {
        h.set('Access-Control-Allow-Origin', reqOrigin);
        try { h.append('Vary', 'Origin'); } catch (e) {}
      } else {
        h.delete('Access-Control-Allow-Origin');
        h.delete('Access-Control-Allow-Headers');
        h.delete('Access-Control-Allow-Methods');
      }
    }
    h.set('X-Content-Type-Options', 'nosniff');
    h.set('X-Frame-Options', 'DENY');
    h.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    h.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if (/^\/api\/(admin|auth|topup|wallet)(\/|$)/.test(path)) h.set('Cache-Control', 'no-store');
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
  } catch (e) { return res; }
}
