// Deploy Engine — publish file workspace per proyek ke Cloudflare Pages (Direct Upload asli).
// Semua operasi wajib lolos guard kepemilikan (anti-IDOR) dan membaca file dari
// tabel per-proyek, jadi hanya pemilik akun yang bisa deploy proyeknya sendiri.
// POST /api/deploy {project_id} = deploy; action 'unpublish' = hapus situs;
// action 'add_domain'/'remove_domain' = kelola domain kustom; GET = status situs.

import { getProjectTables, tableFor } from './_tables.js';
import { transform as tsTransform } from './_ts-compile.js';
import { guardProject, currentUser } from './user-scope.js';
import { getEffectivePlan, getMonthlyDeployCount, bumpMonthlyDeployCount, ADMIN_EMAILS } from './plan-helpers.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

const API_BASE = 'https://api.cloudflare.com/client/v4';

const MIME = {
  html: 'text/html;charset=utf-8', htm: 'text/html;charset=utf-8', css: 'text/css',
  js: 'application/javascript', mjs: 'application/javascript', json: 'application/json',
  svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', ico: 'image/x-icon',
  txt: 'text/plain;charset=utf-8', md: 'text/markdown;charset=utf-8', csv: 'text/csv',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
  mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', wav: 'audio/wav',
  wasm: 'application/wasm', xml: 'application/xml', pdf: 'application/pdf'
};

// [9 Okt 2026] VERIFIKASI PASCA-DEPLOY (mesin bukti, TANPA LLM, gratis): ambil HTML
// index dari URL publik sekali, cek status HTTP, judul halaman, dan keseimbangan tag.
// Hasilnya masuk respons deploy -> tool result AI -> AI melihat FAKTA (bukan klaim)
// dan bisa memperbaiki sendiri sebelum bilang "selesai". Gagal ambil = verify tercatat
// "belum bisa diverifikasi", deploy tetap SUKSES (verifikasi gak boleh memblokir).
async function verifyDeployedPage(url) {
  const out = { checked_url: url, ok: false };
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ClincooVerify/1.0)' }, signal: ctrl.signal, redirect: 'follow' });
    clearTimeout(t);
    out.http_status = res.status;
    if (res.status !== 200) { out.error = 'HTTP ' + res.status + ' (bukan 200)'; return out; }
    const body = await res.text().catch(() => '');
    if (!body) { out.error = 'halaman kosong / body tidak terbaca'; return out; }
    const isHtml = /<html|<!doctype/i.test(body);
    if (!isHtml) { out.error = 'bukan halaman HTML (mungkin file/JSON)'; return out; }
    const titleM = body.match(/<title[^>]*>([^<]*)<\/title>/i);
    out.title = titleM ? titleM[1].trim() : '';
    if (!out.title) out.warnings = ['<title> kosong — SEO & tab browser rusak'];
    if (/\b404\b|page not found|nothing here yet|\berror\b\s*\bpage\b/i.test(body.slice(0, 2000)))
      out.warnings = (out.warnings || []).concat(['tampilan error/404 terdeteksi di awal halaman']);
    // keseimbangan tag HTML (strip komentar, script, style dulu biar isi JS gak salah baca)
    const clean = body.replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<script\b[\s\S]*?<\/script>/gi, '')
      .replace(/<style\b[\s\S]*?<\/style>/gi, '');
    const voids = new Set(['area','base','br','col','embed','hr','img','input','link','meta','param','source','track','wbr']);
    const stack = [];
    const re = /<\/?([a-zA-Z][a-zA-Z0-9-]*)(?:\s[^>]*)?>/g;
    let m, tagErr = null;
    while ((m = re.exec(clean)) && !tagErr) {
      const tag = m[1].toLowerCase();
      if (voids.has(tag)) continue;
      if (m[0].startsWith('</')) {
        const last = stack.pop();
        if (last !== tag) { tagErr = '</' + tag + '> tidak cocok (terbuka terakhir: <' + (last || 'TIDAK ADA') + '>)'; }
      } else { stack.push(tag); }
    }
    if (!tagErr && stack.length) tagErr = '<' + stack[stack.length - 1] + '> belum ditutup';
    if (tagErr) { out.error = 'HTML rusak: ' + tagErr; return out; }
    out.ok = true;
    out.message = 'Halaman live: HTTP 200, HTML seimbang, judul: ' + (out.title ? JSON.stringify(out.title) : '(kosong)');
    return out;
  } catch (e) {
    out.error = 'belum bisa diverifikasi (' + ((e && e.message) || 'timeout/koneksi') + ') — coba lagi dengan take_screenshot bila perlu';
    return out;
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...CORS } });
}

function b64(str) {
  return btoa(unescape(encodeURIComponent(String(str || ''))));
}

// base64 -> string asli (file besar disimpan sebagai chunk base64 dari string
// asli — bisa teks murni atau data-URL gambar — jadi didecode kembali ke string)
function unb64(b64Str) {
  const bin = atob(String(b64Str || ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder('utf-8').decode(bytes);
}

function slugify(s) {
  return String(s || '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

async function sha256hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function cfFetch(path, apiKey, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (opts.body && typeof opts.body === 'string' && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  if (!headers['Authorization']) headers['Authorization'] = 'Bearer ' + apiKey;
  let lastErr = null;
  // Maks 3 percobaan: fetch timeout (30 detik), jaringan terputus, atau API balas
  // 5xx/429 dicoba ulang dengan jeda — hickup Cloudflare sesaat tidak lagi
  // menggagalkan publish dengan "Cloudflare API tidak merespons".
  for (let attempt = 1; attempt <= 3; attempt++) {
    let res = null;
    try {
      res = await fetch(API_BASE + path, { ...opts, headers, signal: AbortSignal.timeout(30000) });
    } catch (e) {
      lastErr = new Error('Server deployment tidak merespons (' + (e && e.name === 'TimeoutError' ? 'timeout' : 'jaringan') + ')');
      if (attempt < 3) { await new Promise(r => setTimeout(r, 1200 * attempt)); continue; }
      throw lastErr;
    }
    let data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    if (!data) {
      lastErr = new Error('Server deployment tidak merespons (HTTP ' + res.status + ')');
      if ((res.status >= 500 || res.status === 429) && attempt < 3) {
        await new Promise(r => setTimeout(r, 1200 * attempt));
        continue;
      }
      throw lastErr;
    }
    if (!data.success) {
      const first = (data.errors && data.errors[0]) || {};
      if (res.status === 429 && attempt < 3) { // rate limit: jeda lebih lama lalu coba lagi
        lastErr = new Error(first.message || ('HTTP ' + res.status));
        await new Promise(r => setTimeout(r, 2000 * attempt));
        continue;
      }
      const err = new Error(first.message || ('HTTP ' + res.status));
      err.code = first.code;
      throw err;
    }
    return data.result;
  }
  throw lastErr || new Error('Server deployment tidak merespons');
}

async function getSetting(db, table, projectId, key) {
  try {
    const row = await db.prepare(`SELECT value FROM ${table} WHERE project_id = ? AND key = ?`).bind(projectId, key).first();
    return row ? row.value : null;
  } catch (e) { return null; }
}

// Integrasi Webhook aktif: kirim event deploy ke endpoint yang tersimpan di project-settings.
// Format webhook_settings: { webhooks:[{url,method}], deployEvent:'all|success|fail|none', retry:bool }
async function fireWebhooks(db, table, projectId, status, payload) {
  try {
    const raw = await getSetting(db, table, projectId, 'webhook_settings');
    if (!raw) return;
    let cfg; try { cfg = JSON.parse(raw); } catch (e) { return; }
    const evFilter = cfg.deployEvent || 'all';
    if (evFilter === 'none') return;
    if (evFilter !== 'all' && evFilter !== status) return;
    const hooks = Array.isArray(cfg.webhooks) ? cfg.webhooks.filter(h => h && h.url) : [];
    if (!hooks.length) return;
    const attempts = cfg.retry ? 2 : 1;
    await Promise.all(hooks.slice(0, 10).map(async h => {
      for (let a = 0; a < attempts; a++) {
        try {
          const method = (h.method === 'GET' || h.method === 'PUT') ? h.method : 'POST';
          await fetch(h.url, {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: method === 'GET' ? undefined : JSON.stringify(payload)
          });
          break; // terkirim — tidak perlu retry
        } catch (e) { /* coba lagi bila retry aktif */ }
      }
    }));
  } catch (e) { /* webhook tidak boleh membatalkan deploy */ }
}

async function setPhase(db, table, projectId, text) {
  try { await setSetting(db, table, projectId, 'deploy_phase', text || ''); } catch (e) {}
}

async function setSetting(db, table, projectId, key, value) {
  // Tabel project_settings per-proyek hanya punya kolom (project_id, key, value) —
  // JANGAN pakai updated_at/ON CONFLICT, itu membuat insert GAGAL SENYAP
  // (pages_project & last_deploy_by tidak pernah tersimpan).
  try {
    await db.prepare(`INSERT OR REPLACE INTO ${table} (project_id, key, value) VALUES (?, ?, ?)`)
      .bind(projectId, key, String(value)).run();
  } catch (e) {}
}

export async function getCreds(db) {
  const keyRow = await db.prepare("SELECT value FROM user_preferences WHERE key = 'cloudflare_api_key'").first();
  const acctRow = await db.prepare("SELECT value FROM user_preferences WHERE key = 'cloudflare_account_id'").first();
  return { apiKey: keyRow ? keyRow.value : '', accountId: acctRow ? acctRow.value : '' };
}

// Nama project Pages untuk proyek ini: pakai yang tersimpan (stabil), kalau belum ada
// TURUNKAN DARI NAMA PROYEK (app_name > ai_name > title) lalu tambahkan suffix
// huruf+angka (hash pendek project_id, terlihat acak namun deterministik supaya
// GET dan POST tidak pernah menghasilkan nama berbeda untuk proyek yang sama).
// Suffix unik per proyek: dua akun BERBEDA yang memakai nama sama tidak boleh
// berakhir di project Pages yang sama — deployment satu sama lain akan bocor.
function projHash(projectId) {
  let h = 5381;
  const s = String(projectId || '');
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36).padStart(5, '0').slice(-5);
}

// Nama proyek pilihan (sesuai isi situs): app_name manual > ai_name (dibuat AI dari
// konten situs) > title. Dibaca dari project_settings lalu user_projects.
async function getPreferredName(db, table, projectId) {
  const app = await getSetting(db, table, projectId, 'app_name');
  if (app) return app;
  try {
    const row = await db.prepare('SELECT ai_name, title FROM user_projects WHERE id = ?').bind(String(projectId)).first();
    if (row) return row.ai_name || row.title || '';
  } catch (e) {}
  return '';
}

export async function resolvePagesName(db, table, projectId) {
  const stored = await getSetting(db, table, projectId, 'pages_project');
  if (stored) return stored;
  const preferred = await getPreferredName(db, table, projectId);
  // slug dari nama proyek, tanpa tanda hubung, maks 12 karakter agar CNAME target tetap pendek
  const slug = slugify(String(preferred || '')).replace(/-/g, '').slice(0, 12);
  const name = ((slug || projHash(projectId)) + '-' + projHash(projectId)).slice(0, 60);
  await setSetting(db, table, projectId, 'pages_project', name); // simpan -> stabil selamanya
  return name;
}

// Halaman gerbang password — disuntik ke deploy saat visibilitas = Dilindungi Password.
const GATE_PAGE_HTML = `<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Akses Terlindungi</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; min-height: 100vh; display: flex; align-items: center; justify-content: center; background: #0a0a0a; color: #fff; }
  body.light { background: #fafafa; color: #111; }
  .card { width: 100%; max-width: 380px; padding: 40px 32px; text-align: center; }
  .lock { width: 48px; height: 48px; margin: 0 auto 20px; border-radius: 12px; background: rgba(255,255,255,.08); display: flex; align-items: center; justify-content: center; }
  body.light .lock { background: rgba(0,0,0,.05); }
  h1 { font-size: 20px; font-weight: 700; margin-bottom: 6px; }
  p { font-size: 14px; opacity: .6; margin-bottom: 24px; }
  input { width: 100%; padding: 12px 16px; font-size: 15px; border: 1px solid rgba(255,255,255,.15); border-radius: 10px; background: transparent; color: inherit; outline: none; text-align: center; margin-bottom: 12px; }
  body.light input { border-color: rgba(0,0,0,.15); }
  input:focus { border-color: #3b82f6; }
  button { width: 100%; padding: 12px; font-size: 15px; font-weight: 600; background: #fff; color: #111; border: 0; border-radius: 10px; cursor: pointer; }
  body.light button { background: #111; color: #fff; }
  button:disabled { opacity: .5; cursor: wait; }
  .err { color: #ef4444; font-size: 13px; margin-top: 12px; min-height: 18px; }
</style>
</head>
<body>
<div class="card">
  <div class="lock"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg></div>
  <h1>Situs ini terlindungi</h1>
  <p>Masukkan password untuk melanjutkan</p>
  <form id="f"><input id="pw" type="password" placeholder="Password" autofocus autocomplete="current-password"><button id="btn" type="submit">Masuk</button></form>
  <div class="err" id="err"></div>
</div>
<script>
  if (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) document.body.classList.add('light');
  document.getElementById('f').addEventListener('submit', async function (e) {
    e.preventDefault();
    var btn = document.getElementById('btn'), err = document.getElementById('err');
    btn.disabled = true; err.textContent = '';
    try {
      var res = await fetch('/__gate-auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: document.getElementById('pw').value }) });
      var data = await res.json().catch(function () { return {}; });
      if (res.ok && data.ok) { location.replace('/'); return; }
      err.textContent = data.error || 'Password salah';
    } catch (e2) { err.textContent = 'Tidak dapat menghubungi server'; }
    btn.disabled = false;
  });
</script>
</body>
</html>`;

// === URL PREVIEW PER PROYEK ===
// Preview di-host di project Pages terpisah '<name>-prv' (custom domain Pages hanya
// melayani branch produksi, jadi preview tidak bisa berupa branch di project utama).
// URL preview mengikuti pola domain publik: <prvName>.clincoo.biz.id.
function prvNameFor(name) {
  return name.slice(0, 58) + '-prv';
}

// Lihat project Pages tanpa membuat baru (8000007 = belum ada).
async function lookupProject(creds, name) {
  try {
    return await cfFetch('/accounts/' + creds.accountId + '/pages/projects/' + name, creds.apiKey);
  } catch (e) {
    if (e.code === 8000007) return null;
    throw e;
  }
}

// Pastikan project ada; jika baru dibuat, TUNGGU sampai terpropagasi di semua
// layanan Cloudflare (upload-token dll. bisa balas "Project not found" sesaat
// setelah create — race condition nyata yang pernah membuat deploy gagal).
// Domain publik bawaan: tiap proyek yang dideploy otomatis dapat
// <project>.clincoo.biz.id selain <project>.pages.dev.
// CATATAN PENTING: zona clincoo.biz.id bisa berada di akun Cloudflare yang
// BERBEDA dari akun tempat project Pages berada. Kalau begitu, Cloudflare
// TIDAK otomatis membuat record DNS saat domain dipasang, dan subdomain
// tidak pernah aktif (status domain stuck "pending: CNAME record not set").
// Karena itu di sini kita juga membuat/memperbaiki record CNAME
// <project>.clincoo.biz.id -> <project>.pages.dev lewat API DNS.
// Token API Cloudflare di pengaturan deploy harus punya permission:
//   Account (akun Pages): Cloudflare Pages -> Edit
//   Zone (clincoo.biz.id): DNS -> Edit  (+ Zone -> Read untuk lookup zona)
// Kalau token tidak bisa mengelola zona, gagal diam-diam dan link publik
// tetap memakai pages.dev (halaman Domain Kustom menampilkan status pending).
const PUB_SUFFIX = '.clincoo.biz.id';
const PUB_ZONE = 'clincoo.biz.id';
// Domain publik LEGACY: situs yang dideploy sebelum migrasi domain masih
// memakai subdomain biz.id lama. Tetap dikenali (dikecualikan dari daftar
// domain kustom, dibersihkan saat unpublish) supaya situs lama tetap rapi.
const LEGACY_PUB_SUFFIX = '.clinq' + 'oo.biz.id';
const LEGACY_PUB_ZONE = 'clinq' + 'oo.biz.id';

// Pastikan record CNAME <project>.clincoo.biz.id -> <project>.pages.dev ada.
// Return true kalau record sudah benar / berhasil dibuat, false kalau tidak
// bisa dikelola dari sini (tanpa akses zona, dsb).
async function ensurePublicDomainDns(creds, domain, pagesName) {
  try {
    const zones = await cfFetch('/zones?name=' + PUB_ZONE, creds.apiKey);
    const zoneId = zones && zones.length && zones[0].id;
    if (!zoneId) return false;
    // Target CNAME = subdomain pages.dev ASLI project (bisa berbeda dari nama
    // project, mis. project "clincoo" punya clincoo-be2.pages.dev).
    let target = pagesName + '.pages.dev';
    try {
      const proj = await cfFetch('/accounts/' + creds.accountId + '/pages/projects/' + pagesName, creds.apiKey);
      if (proj && proj.subdomain) target = proj.subdomain;
    } catch (e) {}
    let existing = null;
    try {
      const recs = await cfFetch('/zones/' + zoneId + '/dns_records?type=CNAME&name=' + domain, creds.apiKey);
      existing = (recs || []).find(r => r && r.type === 'CNAME') || null;
    } catch (e) { existing = null; }
    if (existing) {
      if (existing.content === target && existing.proxied) return true; // sudah benar
      await cfFetch('/zones/' + zoneId + '/dns_records/' + existing.id, creds.apiKey, {
        method: 'PUT',
        body: JSON.stringify({ type: 'CNAME', name: domain, content: target, proxied: true, ttl: 1 })
      });
      return true;
    }
    try {
      await cfFetch('/zones/' + zoneId + '/dns_records', creds.apiKey, {
        method: 'POST',
        body: JSON.stringify({ type: 'CNAME', name: domain, content: target, proxied: true, ttl: 1 })
      });
      return true;
    } catch (e) {
      if (e && e.code === 81057) return true; // record sudah ada (race) -> sukses
      return false;
    }
  } catch (e) { return false; }
}

// Hapus record CNAME <domain> dari zona publik clincoo.biz.id / legacy (dipakai saat unpublish
// supaya subdomain gratis tidak menggantung menunjuk project yang sudah dihapus).
async function removePublicDomainDns(creds, domain) {
  try {
    const zoneName = domain.endsWith(LEGACY_PUB_SUFFIX) ? LEGACY_PUB_ZONE : PUB_ZONE;
    const zones = await cfFetch('/zones?name=' + zoneName, creds.apiKey);
    const zoneId = zones && zones.length && zones[0].id;
    if (!zoneId) return;
    let recs = [];
    try { recs = await cfFetch('/zones/' + zoneId + '/dns_records?type=CNAME&name=' + domain, creds.apiKey) || []; } catch (e) { recs = []; }
    for (const r of (recs || [])) {
      if (r && r.type === 'CNAME') {
        try { await cfFetch('/zones/' + zoneId + '/dns_records/' + r.id, creds.apiKey, { method: 'DELETE' }); } catch (e) {}
      }
    }
  } catch (e) {}
}

async function ensurePublicDomain(creds, pagesName, pubLabel) {
  // [10 Okt, arahan pemilik] pubLabel = subdomain pilihan user (TANPA suffix acak);
  // kosong -> pakai nama project (perilaku lama). Domain tetap menunjuk ke project
  // pagesName yang stabil — rename tidak pernah memindahkan isi situs.
  const domain = (pubLabel || pagesName) + PUB_SUFFIX;
  try {
    await cfFetch('/accounts/' + creds.accountId + '/pages/projects/' + pagesName + '/domains', creds.apiKey, {
      method: 'POST', body: JSON.stringify({ name: domain })
    });
  } catch (e) {
    // 8000013 & 8000018 = domain sudah terpasang di project ini -> lanjut cek DNS & status.
    // BUG FIX: dulu hanya 8000013 yang diizinkan, padahal Cloudflare membalas 8000018
    // ("You have already added this custom domain") utk domain yang sudah terpasang.
    // Akibatnya: deploy PERTAMA dapat <project>.clincoo.biz.id, tapi SEMUA deploy
    // berikutnya ensurePublicDomain() menyerah -> response balik ke <project>.pages.dev
    // (padahal subdomain biz.id aktif). Cocok dengan log deploy p_proj1791073192675.
    if (e && e.code !== 8000013 && e.code !== 8000018) return null;
  }
  const dnsOk = await ensurePublicDomainDns(creds, domain, pagesName);
  // Domain baru saja dipasang -> status Cloudflare masih "pending" beberapa
  // detik. TANPA polling, deploy balik memberi URL pages.dev (AI lalu kasih
  // link format lama ke user). Polling maks 5x3s (=15s) sampai status
  // "active"; kalau DNS tidak bisa dikelola dari sini, cek statusnya saja.
  for (let i = 0; i < 5; i++) {
    if (i > 0) await new Promise(r => setTimeout(r, 3000));
    try {
      const info = await cfFetch('/accounts/' + creds.accountId + '/pages/projects/' + pagesName + '/domains/' + domain, creds.apiKey);
      if (info && info.status === 'active') return domain;
      if (info && info.status && info.status !== 'pending' && !dnsOk) break; // error domain (bukan sekadar pending) -> jangan nunggu
    } catch (e) { if (!dnsOk) break; }
    if (!dnsOk && i === 0) break; // tanpa akses DNS & belum aktif -> jangan menunda deploy
  }
  if (dnsOk) { // DNS benar tapi Cloudflare belum selesai validasi -> domain akan aktif sendiri
    return domain;
  }
  return null;
}

async function ensurePagesProject(creds, name) {
  let project = await lookupProject(creds, name);
  if (!project) {
    try {
      project = await cfFetch('/accounts/' + creds.accountId + '/pages/projects', creds.apiKey, {
        method: 'POST', body: JSON.stringify({ name, production_branch: 'main' })
      });
    } catch (e) {
      if (e.code !== 8000002) throw e; // "already exists": nama sisa hapus/limbo -> lanjut tunggu lookup
    }
    for (let i = 0; i < 12; i++) { // tunggu propagasi maks ~36 detik
      await new Promise(r => setTimeout(r, 3000));
      const check = await lookupProject(creds, name);
      if (check) { project = check; break; }
    }
  }
  return project;
}

async function readFiles(db, table, projectId) {
  try {
    // kolom is_big wajib ada sebelum dipakai (proyek lama belum punya kolom ini)
    try { await db.prepare(`ALTER TABLE ${table} ADD COLUMN is_big INTEGER DEFAULT 0`).run(); } catch (e) {}
    // Muat file KECIL utuh; file BESAR hanya metadata (is_big=1, content='') —
    // kontennya diambil dari chunk D1 satu-per-satu hanya saat dibutuhkan.
    // Ini yang membuat proyek berisi BANYAK FILE BESAR bisa dideploy tanpa
    // meledakkan batas memori Worker (128 MB): memori puncak = satu file.
    const { results } = await db.prepare(`SELECT path, content, is_big, size FROM ${table} WHERE project_id = ?`).bind(projectId).all();
    return (results || []).map(r => ({ path: r.path, content: r.is_big ? '' : (r.content || ''), is_big: r.is_big ? 1 : 0, size: Number(r.size) || 0 }));
  } catch (e) { return []; }
}

// Konten file besar (dibangun ulang dari chunk D1) — dipakai saat hash/upload.
async function bigFileContent(db, chunksTable, path) {
  try {
    const ch = await db.prepare(`SELECT chunk FROM ${chunksTable} WHERE path = ? ORDER BY idx ASC`).bind(path).all();
    const b64Str = (ch.results || []).map(c => c.chunk || '').join('');
    return b64Str ? unb64(b64Str) : '';
  } catch (e) { return ''; }
}

// Nilai base64 file besar LANGSUNG dari chunk D1, tanpa membangun string
// data-URL utuh: chunk pertama diperiksa headernya, payload digabung per
// potongan. Puncak memori ~2x payload — bukan ~5x seperti decode penuh
// (atob + Uint8Array + TextDecoder + concat) yang bikin Worker 1102.
async function bigFileValue(db, chunksTable, path) {
  // Baca chunk PER-GROUP (8 chunk ≈ 5 MB per kueri), bukan semua sekaligus:
  // satu kueri besar (60 baris × 600 KB = 36 MB) memuncakkan memori Worker
  // dan memicu error 1102 saat deploy file besar.
  let count = 0;
  try {
    const r = await db.prepare(`SELECT COUNT(*) c FROM ${chunksTable} WHERE path = ?`).bind(path).first();
    count = (r && Number(r.c)) || 0;
  } catch (e) { return null; }
  if (!count) return null;
  let firstChunk = '';
  try {
    const r0 = await db.prepare(`SELECT chunk FROM ${chunksTable} WHERE path = ? AND idx = 0`).bind(path).first();
    firstChunk = (r0 && r0.chunk) || '';
  } catch (e) { return null; }
  const first = unb64(firstChunk);
  let decodeMode = false, skip = 0;
  if (first.startsWith('data:')) {
    const comma = first.indexOf(',');
    if (comma > 0 && /;base64$/i.test(first.slice(0, comma))) { decodeMode = true; skip = comma + 1; }
  }
  const parts = [decodeMode ? first.slice(skip) : firstChunk];
  const PAGE = 8;
  for (let i = 1; i < count; i += PAGE) {
    let rows = null;
    try {
      rows = await db.prepare(`SELECT chunk FROM ${chunksTable} WHERE path = ? AND idx >= ? AND idx < ? ORDER BY idx ASC`).bind(path, i, i + PAGE).all();
    } catch (e) { continue; }
    for (const r of (rows.results || [])) parts.push(decodeMode ? unb64(r.chunk || '') : (r.chunk || ''));
  }
  return parts.length === 1 ? parts[0] : parts.join('');
}

// Kunci aset = 32 karakter pertama SHA-256(base64 + ekstensi) — hasil identik
// sha256hex(value + ext), tapi encodeInto memakai satu buffer TANPA menyalin
// string raksasa, supaya file 25 MB tidak menggandakan memori.
async function assetKey(value, ext) {
  const enc = new TextEncoder();
  const buf = new Uint8Array(value.length + ext.length);
  enc.encodeInto(value, buf);
  enc.encodeInto(ext, buf.subarray(value.length));
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
  let hex = '';
  for (let i = 0; i < 16; i++) hex += h[i].toString(16).padStart(2, '0');
  return hex;
}

// ==== Mutasi konten saat deploy — dipakai jalur legacy maupun action 'prepare' ====
// transpile TS/JSX, favicon otomatis dari logo, gerbang password (_worker.js),
// noindex _headers. Memutasi array files lewat helper fileContent/setContent.
async function applyDeployMutations(db, T, projectId, files, fileContent, setContent, user, planInfo) {
    // === Transpile otomatis TypeScript/JSX saat deploy (fitur "AI masak, Clincoo deploy") ===
    // File .ts/.tsx/.jsx di workspace dikompilasi server-side menjadi .js murni (sucrase:
    // hapus tipe/interface, JSX klasik -> React.createElement). Referensi ekstensi di HTML
    // (mis. src="app.ts") dan import relatif antar file ditulis ulang ke ".js".
    // Hasil deploy tetap 100% statis — tidak butuh Node/npm di server.
    {
      const jsPathOf = p => String(p).replace(/\.(tsx?|jsx)$/i, '.js');
      const existing = new Set(files.map(f => String(f.path)));
      const isTSSrc = p => /\.(ts|tsx|jsx)$/i.test(String(p)) && !/\.d\.ts$/i.test(String(p));
      const tsSources = files.filter(f => isTSSrc(f.path));
      if (tsSources.length) {
        await setPhase(db, T.projectSettings, projectId, 'Mengompilasi TypeScript (' + tsSources.length + ' file)...');
        const compiled = new Map(); // path .js hasil kompilasi -> content
        const drop = new Set();     // file sumber .ts/.tsx/.jsx yang TIDAK dideploy
        for (const f of tsSources) {
          const jsPath = jsPathOf(f.path);
          if (existing.has(jsPath)) { drop.add(f.path); continue; } // .js eksplisit di workspace menang
          const transforms = /\.(tsx|jsx)$/i.test(String(f.path)) ? ['typescript', 'jsx'] : ['typescript'];
          let code;
          try {
            code = tsTransform(String(await fileContent(f) || ''), { transforms, jsxRuntime: 'classic', production: true }).code;
          } catch (e) {
            return json({ error: 'Gagal mengompilasi ' + f.path + ': ' + (e && e.message ? e.message : String(e)) }, 400);
          }
          // import relatif antar file TS: perbaiki ekstensi & tambahkan .js bila tanpa ekstensi.
          const norm = (dir, spec) => (dir + spec).replace(/^\.\//, '');
          const dir = String(f.path).replace(/[^/]+$/, '');
          code = code.replace(/(from\s*["'])(\.[^"']+)(["'])/g, (m, a, spec, z) => {
            if (/\.(tsx?|jsx)$/i.test(spec)) return a + spec.replace(/\.(tsx?|jsx)$/i, '.js') + z;
            if (/\.[a-z0-9]+$/i.test(spec)) return m; // sudah ada ekstensi lain (mis. .json)
            const base = norm(dir, spec);
            for (const cand of [base + '.js', base + '.ts', base + '.tsx']) {
              if (existing.has(cand)) { return a + spec + '.js' + z; }
            }
            return m;
          });
          // import CSS side-effect tidak berlaku di browser — hapus.
          code = code.replace(/^import\s+["'][^"']+\.css["'];?\s*$/gm, '');
          compiled.set(jsPath, code);
          drop.add(f.path);
        }
        // tulis ulang referensi ekstensi TS di HTML -> .js
        for (const f of files) {
          if (!/\.html?$/i.test(String(f.path))) continue;
          const c = await fileContent(f);
          setContent(f, c.replace(/\.(tsx?|jsx)(["'?#\s])/g, '.js$2'));
        }
        const keep = files.filter(f => !drop.has(String(f.path)) && !/\.d\.ts$/i.test(String(f.path)));
        for (const [p, c] of compiled) keep.push({ path: p, content: c });
        keep.sort((a, b) => String(a.path).localeCompare(String(b.path)));
        files.length = 0;
        files.push(...keep);
      }
    }

    // === Logo Aplikasi -> favicon otomatis (Pengaturan > Umum) ===
    // Logo yang diunggah di Pengaturan > Umum dipasang sebagai favicon situs:
    // tag <link rel="icon"> lama diganti dengan logo, jadi ikon tab browser
    // otomatis mengikuti logo aplikasi sejak deploy berikutnya.
    let logoPath = null;
    try { logoPath = await getSetting(db, T.projectSettings, projectId, 'app_logo'); } catch (e) {}
    logoPath = String(logoPath || '').replace(/^[\/\\]+/, '');
    if (logoPath && files.some(function (f) { return f.path === logoPath; })) {
      const iconTag = '<link rel="icon" href="/' + logoPath + '">' +
                      '<link rel="apple-touch-icon" href="/' + logoPath + '">';
      for (const f of files) {
        if (!/\.html?$/i.test(String(f.path))) continue;
        try {
          let html = await fileContent(f);
          html = html.replace(/<link[^>]+rel=["']?(apple-touch-icon|shortcut icon|icon)["']?[^>]*>/gi, '');
          if (/<\/head>/i.test(html)) html = html.replace(/<\/head>/i, iconTag + '</head>');
          else html = iconTag + html;
          setContent(f, html);
        } catch (e) {}
      }
      await setPhase(db, T.projectSettings, projectId, 'Memasang logo sebagai favicon...');
    }
    if (!files.length) {
      return json({ error: 'Workspace proyek masih kosong — tidak ada file untuk dideploy. Buat file dulu di halaman Workspace.' }, 400);
    }

    // === Visibilitas & Akses (dari halaman Pengaturan > Visibilitas & Akses) ===
    // - mode 'password'  -> gerbang auth sebelum situs bisa dibuka (_worker.js + __gate.html)
    // - indexSearch = 0   -> _headers X-Robots-Tag: noindex (mesin pencari tidak mengindeks)
    let vis = null;
    try {
      const visRaw = await getSetting(db, T.projectSettings, projectId, 'visibility_settings');
      vis = visRaw ? JSON.parse(visRaw) : null;
    } catch (e) { vis = null; }

    const visGateAllowed = ADMIN_EMAILS.has((user && user.email) || '') || planInfo.plan === 'Bisnis';
    if (!visGateAllowed && vis && vis.mode === 'password') {
      // Enforcement paket: gerbang password = fitur Paket Bisnis — deploy tetap jalan tanpa gerbang
      vis = null;
      try { await setPhase(db, T.projectSettings, projectId, ''); } catch (e) {}
    }
    if (vis && vis.mode === 'password' && /^[a-f0-9]{64}$/.test(String(vis.pass_hash || ''))) {
      const workerJs = [
        'const GATE_TOKEN = "' + vis.pass_hash + '";',
        'const COOKIE_NAME = "clincoo_gate";',
        'async function sha256hexGate(str) {',
        '  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));',
        '  return [...new Uint8Array(buf)].map(function (b) { return b.toString(16).padStart(2, "0"); }).join("");',
        '}',
        'export default {',
        '  async fetch(request, env) {',
        '    const url = new URL(request.url);',
        '    if (url.pathname === "/__gate.html" || url.pathname === "/__gate-auth") {',
        '      if (url.pathname === "/__gate-auth") {',
        '        if (request.method !== "POST") return new Response(null, { status: 405 });',
        '        const body = await request.json().catch(function () { return {}; });',
        '        const digest = await sha256hexGate("clincoo-gate:" + String(body.password || ""));',
        '        if (digest === GATE_TOKEN) {',
        '          return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json", "Set-Cookie": COOKIE_NAME + "=" + GATE_TOKEN + "; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax" } });',
        '        }',
        '        return new Response(JSON.stringify({ ok: false, error: "Password salah" }), { status: 401, headers: { "Content-Type": "application/json" } });',
        '      }',
        '      return env.ASSETS.fetch(request);',
        '    }',
        '    const cookie = request.headers.get("Cookie") || "";',
        '    const ok = cookie.split(/;\\s*/).some(function (c) { return c === COOKIE_NAME + "=" + GATE_TOKEN; });',
        '    if (ok) return env.ASSETS.fetch(request);',
        '    return new Response(null, { status: 302, headers: { Location: "/__gate.html" } });',
        '  }',
        '};'
      ].join('\n');
      files.push({ path: '_worker.js', content: workerJs });
      files.push({ path: '__gate.html', content: GATE_PAGE_HTML });
      await setPhase(db, T.projectSettings, projectId, 'Gerbang password dipasang ke situs...');
    }

    if (vis && String(vis.indexSearch) === '0') {
      const NOINDEX = 'X-Robots-Tag: noindex, nofollow';
      const ex = files.findIndex(function (f) { return f.path === '_headers'; });
      if (ex > -1) {
        const hc = await fileContent(files[ex]);
        if (hc.indexOf('X-Robots-Tag') === -1) {
          setContent(files[ex], hc.replace(/\n*$/, '') + '\n/*\n  ' + NOINDEX + '\n');
        }
      } else {
        files.push({ path: '_headers', content: '/*\n  ' + NOINDEX + '\n' });
      }
    }
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

// Cache status deploy (GET non-fast) per proyek: halaman domain kustom melakukan
// polling tiap 20 detik; tanpa cache setiap polling menunggu 3x round-trip API
// Cloudflare. Cache 45 detik membuat polling ringan; POST (deploy/unpublish/
// add_domain/remove_domain) otomatis menghapus cache supaya tidak ada data basi.
const STATUS_TTL_MS = 45 * 1000;
const statusCache = new Map();

function statusCacheGet(pid) {
  const e = statusCache.get(pid);
  if (!e) return null;
  if (Date.now() - e.at > STATUS_TTL_MS) { statusCache.delete(pid); return null; }
  return e.body;
}
function statusCacheSet(pid, body) {
  try {
    statusCache.set(pid, { at: Date.now(), body });
    if (statusCache.size > 400) statusCache.delete(statusCache.keys().next().value);
  } catch (e) {}
}
function statusCacheDel(pid) { try { if (pid) statusCache.delete(pid); } catch (e) {} }

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const projectId = url.searchParams.get('project_id') || '';
  const deny = await guardProject(env, request, projectId);
  if (deny) return deny;
  try {
    const db = env.DB;
    const creds = await getCreds(db);
    if (!creds.apiKey) return json({ error: 'API key deployment belum dikonfigurasi' }, 500);
    const T = await getProjectTables(db, projectId);
    const name = await resolvePagesName(db, T.projectSettings, projectId);
    const pagesUrl = 'https://' + name + '.pages.dev';

    // [10 Okt, arahan pemilik] Cek ketersediaan subdomain publik untuk ikon centang
    // di halaman deploy: tersedia = tidak ada DNS live utk <sub>.clincoo.biz.id
    // (atau memang milik proyek ini sendiri).
    if (url.searchParams.get('action') === 'check_sub') {
      const sub = slugify(String(url.searchParams.get('sub') || '').trim().toLowerCase());
      if (!sub || sub.length < 3 || sub.length > 40) return json({ available: false, reason: 'invalid' });
      const ownPub = (await getSetting(db, T.projectSettings, projectId, 'public_subdomain')) || '';
      if (sub === ownPub || sub === name) return json({ available: true, own: true });
      let taken = false;
      try {
        const doh = await fetch('https://cloudflare-dns.com/dns-query?name=' + encodeURIComponent(sub + PUB_SUFFIX) + '&type=A', { headers: { accept: 'application/dns-json' } });
        const dj = await doh.json().catch(() => null);
        taken = !!(dj && Array.isArray(dj.Answer) && dj.Answer.length);
      } catch (e) {}
      return json({ available: !taken, reason: taken ? 'taken' : '' });
    }

    const _cached = statusCacheGet(projectId);
    if (_cached) return json(_cached);

    // Mode cepat: hanya nama Pages + URL (murni D1, tanpa round-trip API Cloudflare).
    // Dipakai halaman domain kustom supaya nilai record DNS terisi < 200 ms,
    // bukan menunggu status deployment (yang bisa masing-masing ratusan ms).
    if (url.searchParams.get('fast') === '1') {
      // deployed=true hanya bila log sukses terakhir lebih BARU daripada log
      // unpublish terakhir (log urut DESC). Tanpa ini, setelah "Batalkan Publikasi"
      // mode fast tetap bilang deployed (log sukses lama masih ada).
      let deployed = false;
      try {
        const { results } = await db.prepare(`SELECT status FROM ${T.deployLogs} WHERE project_id = ? ORDER BY id DESC LIMIT 10`).bind(projectId).all();
        const ls = results || [];
        const iUn = ls.findIndex(l => l && l.status === 'unpublished');
        const iOk = ls.findIndex(l => l && l.status === 'success');
        deployed = iOk !== -1 && (iUn === -1 || iOk < iUn);
      } catch (e) {}
      return json({ pages_project: name, pages_url: pagesUrl, public_subdomain: (await getSetting(db, T.projectSettings, projectId, 'public_subdomain')) || name, deployed, fast: true, api_rev: 'uniq4' });
    }

    // Ambil project, deployment terakhir, dan domains PARALEL.
    // Sebelumnya 3x round-trip Cloudflare BERURUTAN -> halaman domain terasa lambat.
    const [project, deps, doms] = await Promise.all([
      lookupProject(creds, name).catch(() => null),
      cfFetch('/accounts/' + creds.accountId + '/pages/projects/' + name + '/deployments?per_page=1', creds.apiKey).catch(() => null),
      cfFetch('/accounts/' + creds.accountId + '/pages/projects/' + name + '/domains', creds.apiKey).catch(() => null)
    ]);

    let last = null;
    let domains = [];
    if (project && Array.isArray(deps)) {
      const d = (deps && deps[0]) || null;
      if (d) {
        last = {
          id: d.id,
          status: (d.latest_stage && d.latest_stage.status) || d.status || 'idle',
          url: (d.aliases && d.aliases[0]) || d.url || pagesUrl,
          created: d.created_on
        };
      }
    }
    if (project && Array.isArray(doms)) {
      // Kecualikan subdomain publik otomatis (<project>.clincoo.biz.id & legacy) dari daftar
      // "domain kustom" — itu domain gratis bawaan, bukan domain kustom milik user.
      domains = doms.filter(x => x && x.name !== name + PUB_SUFFIX && !x.name.endsWith(LEGACY_PUB_SUFFIX)).map(x => ({ name: x.name, status: x.status || 'pending' }));
    }
    const pubLabel = (await getSetting(db, T.projectSettings, projectId, 'public_subdomain')) || '';
    // [10 Okt] default = domain publik berlabel (JANGAN jatuh ke pages.dev walau domain
    // belum berstatus aktif) — URL internal tidak boleh bocor ke tampilan user.
    let publicUrl = 'https://' + (pubLabel || name) + PUB_SUFFIX;
    if (Array.isArray(doms)) {
      const isUp = function (x) { return x && (x.status === 'active' || x.status === 'initializing'); };
      const pd = (pubLabel ? doms.find(x => x && x.name === pubLabel + PUB_SUFFIX && isUp(x)) : null)
        || doms.find(x => x && x.name === name + PUB_SUFFIX && isUp(x))
        || doms.find(x => x && x.name === name + LEGACY_PUB_SUFFIX && isUp(x));
      if (pd) publicUrl = 'https://' + pd.name;
    }

    let logs = [];
    try {
      const { results } = await db.prepare(`SELECT status, url, message, created_at FROM ${T.deployLogs} WHERE project_id = ? ORDER BY id DESC LIMIT 10`).bind(projectId).all();
      logs = results || [];
    } catch (e) {}

    const lastDeployBy = await getSetting(db, T.projectSettings, projectId, 'last_deploy_by');
    const deployPhase = await getSetting(db, T.projectSettings, projectId, 'deploy_phase');
    // Log 'unpublished' (situs ditarik via Batalkan Publikasi) yang lebih BARU
    // dari log sukses/preview terakhir berarti situs kini TIDAK aktif. Tanpa gate
    // ini, status masih memakai log sukses lama sehingga dashboard tetap
    // menampilkan "Situs aktif" padahal publikasinya sudah dibatalkan.
    let pulledNow = false, previewPulled = false;
    if (Array.isArray(logs) && logs.length) {
      const iUn = logs.findIndex(l => l && l.status === 'unpublished');
      if (iUn !== -1) {
        const iOk = logs.findIndex(l => l && l.status === 'success');
        const iPrv = logs.findIndex(l => l && l.status === 'preview');
        pulledNow = iOk === -1 || iUn < iOk;
        previewPulled = iPrv === -1 || iUn < iPrv;
      }
    }
    // last_deployment juga disintesis dari log D1 bila daftar deployment Cloudflare
    // tidak terbaca/kosong, supaya halaman tidak salah bilang "belum pernah deploy".
    if (!last && !pulledNow && Array.isArray(logs)) {
      const okLog = logs.find(l => l && l.status === 'success');
      if (okLog) last = { id: 'd1-' + (okLog.created_at || ''), status: 'success', url: okLog.url || pagesUrl, created: okLog.created_at || '' };
    }
    const deployed = !pulledNow && ((Array.isArray(logs) && logs.some(l => l && l.status === 'success'))
      || (last && ['success', 'active'].includes(last.status))
      || (Array.isArray(deps) && deps.length > 0));
    const previewDeployed = !previewPulled && (Array.isArray(logs) && logs.some(l => l && l.status === 'preview'));
    const previewLog = (Array.isArray(logs) ? logs.find(l => l && l.status === 'preview') : null);
    const previewUrl = previewLog ? previewLog.url : ('https://' + prvNameFor(name) + PUB_SUFFIX);
    // Deteksi perubahan kode: MAX(updated_at) berkas vs waktu deploy sukses terakhir.
    // Dipakai dashboard untuk CTA "Deploy Pembaruan" real-time.
    let filesChanged = false, filesUpdatedAt = '';
    try {
      const fr = await db.prepare(`SELECT MAX(updated_at) AS m FROM ${T.files} WHERE project_id = ?`).bind(projectId).first();
      filesUpdatedAt = (fr && fr.m) || '';
      const lastOk = Array.isArray(logs) ? logs.find(l => l && l.status === 'success') : null;
      const fu = filesUpdatedAt ? Date.parse(String(filesUpdatedAt).replace(' ', 'T') + 'Z') : 0;
      const ld = lastOk && lastOk.created_at ? Date.parse(String(lastOk.created_at).replace(' ', 'T') + 'Z') : 0;
      if (fu && fu > ld) filesChanged = true;
    } catch (e) {}
    const _statusBody = { pages_project: name, pages_url: pagesUrl, public_url: publicUrl, public_subdomain: pubLabel || name, deployed, preview_url: previewUrl, preview_deployed: previewDeployed, last_deployment: last, last_deploy_by: lastDeployBy || '', domains, logs, deploy_phase: deployPhase || '', files_changed: filesChanged, files_updated_at: filesUpdatedAt, api_rev: 'uniq6' };
    statusCacheSet(projectId, _statusBody);
    return json(_statusBody);
  } catch (err) {
    try {
      const db = env.DB;
      const T = await getProjectTables(db, projectId);
      await setPhase(db, T.projectSettings, projectId, '');
    } catch (e2) {}
    return json({ error: err.message }, 500);
  }
}

export async function onRequestPost({ request, env }) {
  let body = {};
  try { body = await request.json(); } catch (e) {}
  const projectId = body.project_id || '';
  const deny = await guardProject(env, request, projectId);
  if (deny) return deny;
  statusCacheDel(projectId);
  // body.preview=true -> deploy ke project Pages terpisah '<name>-prv' (URL preview).
  // Preview TIDAK menyentuh situs produksi, TIDAK makan kuota deploy bulanan,
  // tidak menghitung last_deploy_by, dan tidak memicu webhook deploy (log status 'preview').
  const isPreview = body.preview === true;
  try {
    const db = env.DB;
    const creds = await getCreds(db);
    if (!creds.apiKey) return json({ error: 'API key deployment belum dikonfigurasi' }, 500);
    const T = await getProjectTables(db, projectId);
    let name = await resolvePagesName(db, T.projectSettings, projectId);
    // [10 Okt, arahan pemilik] SUBDOMAIN PUBLIK = PERSIS pilihan user, TANPA suffix
    // karakter acak. Project Pages TETAP pakai nama stabil resolvePagesName — rename
    // tidak lagi membuat project baru (itu penyebab subdomain baru 404: situsnya
    // tertinggal di project lama). <sub>.clincoo.biz.id hanya CNAME ke project yang sama.
    const subRaw = String(body.subdomain || '').trim().toLowerCase();
    const prevPubLabel = (await getSetting(db, T.projectSettings, projectId, 'public_subdomain')) || '';
    if (subRaw) {
      const sub = slugify(subRaw);
      if (sub && sub.length >= 3 && sub.length <= 40 && sub !== prevPubLabel) {
        if (prevPubLabel) { try { await setSetting(db, T.projectSettings, projectId, 'prev_public_subdomain', prevPubLabel); } catch (e) {} }
        await setSetting(db, T.projectSettings, projectId, 'public_subdomain', sub);
      }
    }
    const pubLabel = (await getSetting(db, T.projectSettings, projectId, 'public_subdomain')) || '';
    const pagesUrl = 'https://' + name + '.pages.dev';

    if (body.action === 'unpublish') {
      const existing = await lookupProject(creds, name);
      if (!existing) {
        await db.prepare(`INSERT INTO ${T.deployLogs} (project_id, status, url, message, created_at) VALUES (?, 'unpublished', '', ?, datetime('now'))`)
          .bind(projectId, 'tidak ada situs aktif').run();
        return json({ success: true, unpublished: name, note: 'Situs belum pernah dideploy — tidak ada yang perlu ditarik.' });
      }
      try {
        // Project preview '-prv' ikut ditarik (best effort): lepaskan domain + CNAME
        // publiknya dulu, lalu hapus project-nya.
        try {
          const prvName0 = prvNameFor(name);
          let pdoms = [];
          try { pdoms = await cfFetch('/accounts/' + creds.accountId + '/pages/projects/' + prvName0 + '/domains', creds.apiKey) || []; } catch (e) { pdoms = []; }
          for (const d of (pdoms || [])) {
            if (!d || !d.name) continue;
            try { await cfFetch('/accounts/' + creds.accountId + '/pages/projects/' + prvName0 + '/domains/' + d.name, creds.apiKey, { method: 'DELETE' }); } catch (e) {}
            if (d.name.endsWith(PUB_SUFFIX) || d.name.endsWith(LEGACY_PUB_SUFFIX)) await removePublicDomainDns(creds, d.name);
          }
          await cfFetch('/accounts/' + creds.accountId + '/pages/projects/' + prvName0, creds.apiKey, { method: 'DELETE' });
        } catch (e) {}
        // Cloudflare menolak menghapus project Pages yang masih punya custom domain
        // terpasang (termasuk subdomain gratis <project>.clincoo.biz.id) —
        // lepaskan semua domain dulu, lalu hapus project.
        let doms = [];
        try { doms = await cfFetch('/accounts/' + creds.accountId + '/pages/projects/' + name + '/domains', creds.apiKey) || []; } catch (e) { doms = []; }
        for (const d of (doms || [])) {
          if (!d || !d.name) continue;
          try { await cfFetch('/accounts/' + creds.accountId + '/pages/projects/' + name + '/domains/' + d.name, creds.apiKey, { method: 'DELETE' }); } catch (e) {}
          if (d.name.endsWith(PUB_SUFFIX) || d.name.endsWith(LEGACY_PUB_SUFFIX)) await removePublicDomainDns(creds, d.name);
        }
        await cfFetch('/accounts/' + creds.accountId + '/pages/projects/' + name, creds.apiKey, { method: 'DELETE' });
      } catch (e) {
        if (e.code !== 8000007) {
          await db.prepare(`INSERT INTO ${T.deployLogs} (project_id, status, url, message, created_at) VALUES (?, 'failed', '', ?, datetime('now'))`)
            .bind(projectId, 'unpublish gagal: ' + e.message).run();
          return json({ error: e.message }, 500);
        }
      }
      await db.prepare(`INSERT INTO ${T.deployLogs} (project_id, status, url, message, created_at) VALUES (?, 'unpublished', '', ?, datetime('now'))`)
        .bind(projectId, 'situs ditarik').run();
      return json({ success: true, unpublished: name });
    }

    if (body.action === 'add_domain' || body.action === 'remove_domain') {
      const domain = String(body.domain || '').trim().toLowerCase();
      if (!domain || !/^([a-z0-9-]+\.)+[a-z]{2,}$/.test(domain)) return json({ error: 'Domain tidak valid' }, 400);
      await ensurePagesProject(creds, name);
      const isAdd = body.action === 'add_domain';
      try {
        await cfFetch('/accounts/' + creds.accountId + '/pages/projects/' + name + '/domains' + (isAdd ? '' : '/' + domain), creds.apiKey, {
          method: isAdd ? 'POST' : 'DELETE',
          body: isAdd ? JSON.stringify({ name: domain }) : undefined
        });
      } catch (e) {
        return json({ error: e.message }, 500);
      }
      return json({ success: true, action: body.action, domain });
    }

    // ===== AI DNS MANAGER: tool manage_domain (action set_dns/dns_status/delete_dns) =====
    // AI Clincoo bisa langsung menyetel record DNS domain kustom — asal zona domainnya
    // ada di akun Cloudflare yang tersimpan di Pengaturan Deploy (creds di atas).
    if (body.action === 'dns_status' || body.action === 'set_dns' || body.action === 'delete_dns') {
      const domain = String(body.domain || '').trim().toLowerCase();
      if (!domain || !/^([a-z0-9-]+\.)+[a-z]{2,}$/.test(domain)) return json({ error: 'Domain tidak valid' }, 400);
      // Cari zona: domain lalu induknya (www.hypeemart.my.id -> hypeemart.my.id)
      let zone = null;
      const parts = domain.split('.');
      for (let i = 0; i < parts.length - 1 && !zone; i++) {
        const cand = parts.slice(i).join('.');
        if (cand.split('.').length < 2) break;
        try {
          const r = await cfFetch('/zones?name=' + encodeURIComponent(cand), creds.apiKey);
          if (Array.isArray(r) && r.length) zone = r[0];
        } catch (e) {}
      }
      if (!zone) return json({ error: 'Zona DNS untuk ' + domain + ' tidak ditemukan di akun deployment yang tersimpan di Pengaturan Deploy. Kalau domainnya dikelola provider lain (IDWebhost, Namecheap, dll), record DNS harus dibuat di panel provider tersebut: CNAME ' + domain + ' -> ' + name + '.pages.dev' }, 404);
      const target = name + '.pages.dev';
      let recs = [];
      try { recs = await cfFetch('/zones/' + zone.id + '/dns_records?name=' + encodeURIComponent(domain) + '&per_page=100', creds.apiKey) || []; } catch (e) {}
      const relevant = (recs || []).filter(r => r && ['CNAME', 'A', 'AAAA', 'TXT'].includes(r.type));
      const summary = relevant.map(r => ({ id: r.id, type: r.type, name: r.name, content: r.content, proxied: !!r.proxied }));
      if (body.action === 'dns_status') {
        return json({ success: true, zone: zone.name, records: summary, needed: { type: 'CNAME', name: domain, content: target, proxied: true }, pages_target: target, note: 'Setel CNAME ' + domain + ' -> ' + target + ' (proxied) supaya domain mengarah ke situs.' });
      }
      if (body.action === 'delete_dns') {
        let removed = [];
        for (const r of relevant) {
          try { await cfFetch('/zones/' + zone.id + '/dns_records/' + r.id, creds.apiKey, { method: 'DELETE' }); removed.push(r.type + ' ' + r.name + ' -> ' + r.content); } catch (e) {}
        }
        return json({ success: true, removed: removed, zone: zone.name });
      }
      // set_dns: pastikan CNAME -> <pages>.pages.dev (proxied). Konflik A/AAAA di nama
      // yang sama otomatis dihapus (CNAME tidak bisa berdampingan dengan A/AAAA).
      let removedConflicts = [];
      for (const r of relevant) {
        if (r.type === 'A' || r.type === 'AAAA') {
          try { await cfFetch('/zones/' + zone.id + '/dns_records/' + r.id, creds.apiKey, { method: 'DELETE' }); removedConflicts.push(r.type + ' ' + (r.content || '')); } catch (e) {}
        }
      }
      const existing = relevant.find(r => r.type === 'CNAME');
      if (existing && existing.content === target) {
        return json({ success: true, already_ok: true, record: { type: 'CNAME', name: domain, content: target, proxied: existing.proxied }, removed_conflicts: removedConflicts, zone: zone.name });
      }
      try {
        let rec;
        if (existing) {
          rec = await cfFetch('/zones/' + zone.id + '/dns_records/' + existing.id, creds.apiKey, { method: 'PUT', body: JSON.stringify({ type: 'CNAME', name: domain, content: target, proxied: true, comment: 'Dipasang otomatis oleh AI Clincoo' }) });
        } else {
          rec = await cfFetch('/zones/' + zone.id + '/dns_records', creds.apiKey, { method: 'POST', body: JSON.stringify({ type: 'CNAME', name: domain, content: target, proxied: true, comment: 'Dipasang otomatis oleh AI Clincoo' }) });
        }
        return json({ success: true, action: 'set_dns', record: { type: 'CNAME', name: rec.name || domain, content: rec.content || target, proxied: rec.proxied !== false }, updated: !!existing, removed_conflicts: removedConflicts, zone: zone.name, note: 'Record CNAME ' + domain + ' -> ' + target + ' aktif. Domain bisa dipasang ke situs lewat manage_domain action add.' });
      } catch (e) {
        return json({ error: 'Gagal menyetel record DNS: ' + e.message }, 500);
      }
    }

    // ==== Deploy orkestrasi browser (proyek berisi banyak file besar) ====
    // Worker paket gratis dibatasi ~10ms CPU per request — hash & upload file
    // besar tidak muat dalam satu request (error 1102). Alur barunya:
    // 'prepare' -> token + daftar file + patch konten (ringan), browser
    // meng-hash & meng-upload lewat proxy streaming /api/deploy-upload
    // (body diteruskan tanpa di-parse — CPU ~0), lalu 'finalize' membuat
    // deployment dari manifest kunci saja. Jalur legacy (tanpa action) tetap
    // berfungsi untuk proyek kecil dan deploy dari tool AI.
    if (body.action === 'phase') {
      await setPhase(db, T.projectSettings, projectId, String(body.text || '').slice(0, 200));
      return json({ success: true });
    }

    if (body.action === 'prepare') {
      const user = await currentUser(env, request);
      const planInfo = await getEffectivePlan(db, user);
      if (planInfo.limits.deployLimit !== null && planInfo.limits.deployLimit !== undefined) {
        const used = await getMonthlyDeployCount(db, user && user.id);
        if (used >= planInfo.limits.deployLimit) {
          return json({ error: 'Kuota deploy paket ' + planInfo.plan + ' habis: maksimal ' + planInfo.limits.deployLimit + ' deploy per bulan (sudah terpakai ' + used + '). Upgrade paket di halaman Langganan untuk deploy lagi.', upgrade_needed: true, plan: planInfo.plan, limit: planInfo.limits.deployLimit, used: used }, 402);
        }
      }
      await setPhase(db, T.projectSettings, projectId, 'Menyiapkan proyek Pages...');
      // metadata saja — file besar TANPA konten (prepare tetap ringan di semua ukuran proyek)
      const files = await readFiles(db, T.files, projectId);
      if (!files.length) {
        await setPhase(db, T.projectSettings, projectId, '');
        return json({ error: 'Workspace proyek masih kosong — tidak ada file untuk dideploy. Buat file dulu di halaman Workspace.' }, 400);
      }
      if (files.length > 20000) {
        await setPhase(db, T.projectSettings, projectId, '');
        return json({ error: 'Terlalu banyak file (' + files.length + ') — server deployment membatasi 20.000 file per deployment. Kurangi jumlah file lalu deploy lagi.' }, 413);
      }
      // konten hanya untuk file KODE yang bisa dimutasi saat deploy (transpile/
      // favicon/noindex/gerbang) — selalu baris kecil, CPU & memori terjaga
      const codeRows = await db.prepare(
        `SELECT path, content FROM ${T.files} WHERE project_id = ? AND is_big = 0 AND (path LIKE '%.ts' OR path LIKE '%.tsx' OR path LIKE '%.jsx' OR path LIKE '%.html' OR path LIKE '%.htm' OR path = '_headers' OR path = '_worker.js')`
      ).bind(projectId).all();
      const contentByPath = new Map((codeRows.results || []).map(r => [r.path, r.content || '']));
      for (const f of files) { const c = contentByPath.get(f.path); if (c !== undefined) f.content = c; f.origContent = f.content; }
      // mutasi deploy identik dengan jalur legacy (file besar dilewati — kontennya
      // di-hash apa adanya dari chunk; favicon/tulis-ulang .ts tidak berlaku utk file raksasa)
      await applyDeployMutations(db, T, projectId, files, async f => String(f.content || ''), (f, c) => { f.content = c; }, user, planInfo);
      // patch = konten yang berubah + file virtual hasil mutasi (kompilasi .ts, _worker.js, __gate.html, _headers)
      const patch = {};
      for (const f of files) {
        if (typeof f.content === 'string' && f.content && f.content !== f.origContent) patch[f.path] = f.content;
      }
      // guard ukuran — sama dengan jalur legacy: maks 250 MB per deploy
      let totalBytes = 0;
      for (const f of files) totalBytes += f.is_big ? (Number(f.size) || 0) : (f.content ? String(f.content).length : (Number(f.size) || 0));
      if (totalBytes > 250 * 1024 * 1024) {
        await setPhase(db, T.projectSettings, projectId, '');
        return json({ error: 'Proyek terlalu besar untuk sekali deploy (' + Math.round(totalBytes / (1024 * 1024)) + ' MB, maksimal 250 MB per deploy). Kurangi ukuran proyek — pecah jadi beberapa situs atau hapus file/aset terbesar — lalu deploy lagi.' }, 413);
      }
      await ensurePagesProject(creds, name);
      await setSetting(db, T.projectSettings, projectId, 'pages_project', name);
      const tokenRes = await cfFetch('/accounts/' + creds.accountId + '/pages/projects/' + name + '/upload-token', creds.apiKey);
      const list = files.map(f => {
        const ext = (String(f.path).split('.').pop() || '').toLowerCase();
        return { path: f.path, ext: ext, is_big: f.is_big ? 1 : 0, size: Number(f.size) || 0, contentType: MIME[ext] || 'application/octet-stream' };
      });
      await setPhase(db, T.projectSettings, projectId, 'Menghitung ' + list.length + ' file...');
      return json({ success: true, action: 'prepare', jwt: tokenRes.jwt, pages_project: name, pages_url: pagesUrl, files: list, patch: patch });
    }

    if (body.action === 'finalize') {
      const manifest = (body.manifest && typeof body.manifest === 'object' && !Array.isArray(body.manifest)) ? body.manifest : null;
      if (!manifest || !Object.keys(manifest).length) return json({ error: 'manifest wajib diisi (peta path -> kunci aset hasil upload).' }, 400);
      for (const k of Object.keys(manifest)) {
        if (typeof manifest[k] !== 'string' || !/^[a-f0-9]{32}$/.test(manifest[k])) return json({ error: 'manifest tidak valid: kunci aset untuk ' + k + ' bukan hash 32-karakter.' }, 400);
      }
      await setPhase(db, T.projectSettings, projectId, 'Memproses deployment...');
      const form = new FormData();
      const m = {};
      for (const k of Object.keys(manifest)) m['/' + String(k).replace(/^\/+/, '')] = manifest[k];
      form.append('manifest', JSON.stringify(m));
      form.append('branch', 'main');
      const depRes = await fetch(API_BASE + '/accounts/' + creds.accountId + '/pages/projects/' + name + '/deployments', {
        method: 'POST', headers: { Authorization: 'Bearer ' + creds.apiKey }, body: form
      });
      const depData = await depRes.json().catch(() => null);
      if (!depData || !depData.success) {
        const msg = depData && depData.errors && depData.errors[0] ? depData.errors[0].message : ('HTTP ' + depRes.status);
        try { await db.prepare(`INSERT INTO ${T.deployLogs} (project_id, status, url, message, created_at) VALUES (?, 'failed', '', ?, datetime('now'))`).bind(projectId, 'deploy gagal: ' + msg).run(); } catch (e) {}
        await fireWebhooks(db, T.projectSettings, projectId, 'fail', { event: 'deploy.failed', project_id: projectId, pages_project: name, error: msg, at: new Date().toISOString() });
        await setPhase(db, T.projectSettings, projectId, '');
        return json({ error: 'Deployment ditolak server. Coba lagi, atau periksa pengaturan proyek Anda.' }, 500);
      }
      const dep = depData.result || {};
      const pubDomain = await ensurePublicDomain(creds, name, pubLabel);
      // [10 Okt] lepas domain publik LAMA (otomatis/label sebelumnya) best-effort.
      // Marker dibaca dari D1: prepare (request sebelumnya) sudah menimpa
      // public_subdomain dengan label baru — prevPubLabel di request INI tidak
      // lagi memuat label lama.
      if (pubDomain) {
        const prevPubMark = (await getSetting(db, T.projectSettings, projectId, 'prev_public_subdomain')) || '';
        for (const od of [name + PUB_SUFFIX, prevPubMark ? (prevPubMark + PUB_SUFFIX) : '']) {
          if (!od || od === pubDomain) continue;
          try { await cfFetch('/accounts/' + creds.accountId + '/pages/projects/' + name + '/domains/' + od, creds.apiKey, { method: 'DELETE' }); } catch (e) {}
          try { await removePublicDomainDns(creds, od); } catch (e) {}
        }
        if (prevPubMark) { try { await setSetting(db, T.projectSettings, projectId, 'prev_public_subdomain', ''); } catch (e) {} }
      }
      const pubUrl = pubDomain ? ('https://' + pubDomain) : pagesUrl;
      const n = Object.keys(manifest).length;
      try {
        await db.prepare(`INSERT INTO ${T.deployLogs} (project_id, status, url, message, created_at) VALUES (?, 'success', ?, ?, datetime('now'))`)
          .bind(projectId, pubUrl, 'deploy ' + n + ' file ke ' + name).run();
      } catch (e) {}
      await setPhase(db, T.projectSettings, projectId, '');
      const user = await currentUser(env, request);
      await bumpMonthlyDeployCount(db, user && user.id);
      try { await setSetting(db, T.projectSettings, projectId, 'last_deploy_by', (user && (user.name || user.email)) || 'pengguna'); } catch (e) {}
      await fireWebhooks(db, T.projectSettings, projectId, 'success', {
        event: 'deploy.success', project_id: projectId, pages_project: name, pages_url: pubUrl, file_count: n, at: new Date().toISOString()
      });
      const vfy1 = await verifyDeployedPage(pubDomain ? ('https://' + pubDomain) : pubUrl);
      return json({
        success: true, pages_project: name, pages_url: pubUrl, public_url: pubDomain ? ('https://' + pubDomain) : pagesUrl,
        public_domain: pubDomain || '', verify: vfy1, deployment: { id: dep.id, url: (dep.aliases && dep.aliases[0]) || dep.url || pagesUrl, aliases: dep.aliases || [], status: (dep.latest_stage && dep.latest_stage.status) || 'idle', created: dep.created_on }, fileCount: n,
        warnings: logoWarnings || []
      });
    }

    // Kuota deploy per paket langganan (Starter 5x/bln, Pro 25x/bln, Bisnis tanpa batas)
    const user = await currentUser(env, request);
    const planInfo = await getEffectivePlan(db, user);
    if (!isPreview && planInfo.limits.deployLimit !== null && planInfo.limits.deployLimit !== undefined) {
      const used = await getMonthlyDeployCount(db, user && user.id);
      if (used >= planInfo.limits.deployLimit) {
        return json({ error: 'Kuota deploy paket ' + planInfo.plan + ' habis: maksimal ' + planInfo.limits.deployLimit + ' deploy per bulan (sudah terpakai ' + used + '). Upgrade paket di halaman Langganan untuk deploy lagi.', upgrade_needed: true, plan: planInfo.plan, limit: planInfo.limits.deployLimit, used: used }, 402);
      }
    }

    const files = await readFiles(db, T.files, projectId);

    // File besar: konten dimuat satu-per-satu; mutasi konten saat deploy
    // (favicon, tulis ulang .ts -> .js, _headers) ditampung di contentOverrides.
    const chunksTable = tableFor('file_chunks', projectId);
    const contentOverrides = new Map();
    const fileContent = async f => {
      const ov = contentOverrides.get(String(f.path));
      if (ov !== undefined) return ov;
      if (f.is_big) return await bigFileContent(db, chunksTable, String(f.path));
      return String(f.content || '');
    };
    const setContent = (f, c) => {
      if (f.is_big) { contentOverrides.set(String(f.path), c); f.content = ''; }
      else f.content = c;
    };

    await applyDeployMutations(db, T, projectId, files, fileContent, setContent, user, planInfo);

    // [10 Okt, laporan pemilik: logo jadi placeholder bulat kosong di halaman utama]
    // HTML yang merujuk file logo (logo.png/jpg/jpeg/svg/webp/ico) tapi filenya
    // tidak ada di workspace -> di situs tampil kotak logo kosong. Deteksi
    // SEBELUM unggah dan laporkan via warnings pada respons sukses, supaya
    // AI/klien tahu harus membuat ulang logonya, bukan bingung lihat placeholder.
    const logoWarnings = [];
    {
      const owned = new Set(files.map(f => String(f.path).toLowerCase()));
      const refRe = /(?:src|href|content|data-src|data-logo)\s*=\s*["']([^"']*logo[^"']*\.(?:png|jpe?g|svg|webp|ico))["']/gi;
      for (const f of files) {
        if (!/\.html?$/i.test(String(f.path)) || f.is_big) continue;
        const html = String(f.content || '');
        let m;
        while ((m = refRe.exec(html)) !== null) {
          const ref0 = String(m[1] || '').split(/[?#]/)[0];
          if (/^(?:https?:)?\/\//i.test(ref0) || ref0.startsWith('data:')) continue;
          const ref = ref0.replace(/^\.?\//, '').toLowerCase();
          if (ref && !owned.has(ref)) {
            const w = String(f.path) + ' merujuk ' + ref + ' yang tidak ada di workspace (logo akan tampil kosong)';
            if (logoWarnings.indexOf(w) === -1) logoWarnings.push(w);
          }
        }
      }
      if (logoWarnings.length) {
        try { await db.prepare(`INSERT INTO ${T.deployLogs} (project_id, status, url, message, created_at) VALUES (?, 'warning', '', ?, datetime('now'))`)
          .bind(projectId, 'peringatan aset logo: ' + logoWarnings.join('; ')).run(); } catch (e) {}
      }
    }

    await setPhase(db, T.projectSettings, projectId, 'Menyiapkan proyek Pages...');
    // Guard ukuran: deploy kini STREAMING — file besar diproses satu-per-satu
    // dari chunk D1 (memori puncak = satu file terbesar), jadi batas deploy
    // dinaikkan dari 45 MB ke 250 MB total, masih aman di bawah timeout ~100
    // detik proxy Cloudflare. Lebih dari itu ditolak lebih awal dengan pesan
    // jelas — bukan 524/HTML misterius yang sulit dipahami user.
    const MAX_DEPLOY_BYTES = 250 * 1024 * 1024;
    let totalBytes = 0;
    for (const f of files) {
      const ov = contentOverrides.get(String(f.path));
      totalBytes += ov !== undefined ? ov.length : (f.is_big ? (Number(f.size) || 0) : String(f.content || '').length);
    }
    if (totalBytes > MAX_DEPLOY_BYTES) {
      await setPhase(db, T.projectSettings, projectId, '');
      return json({ error: 'Proyek terlalu besar untuk sekali deploy (' + Math.round(totalBytes / (1024 * 1024)) + ' MB, maksimal 250 MB per deploy). Kurangi ukuran proyek — pecah jadi beberapa situs atau hapus file/aset terbesar — lalu deploy lagi.' }, 413);
    }
    const targetName = isPreview ? prvNameFor(name) : name;
    await ensurePagesProject(creds, targetName);
    await setSetting(db, T.projectSettings, projectId, 'pages_project', name);

    const tokenRes = await cfFetch('/accounts/' + creds.accountId + '/pages/projects/' + targetName + '/upload-token', creds.apiKey);
    const jwt = tokenRes.jwt;

    // Kunci aset dihitung SATU FILE PADA SATU WAKTU: konten file besar dibaca
    // dari chunk D1 hanya di sini, dipakai untuk kunci, lalu dibuang. Memori
    // tetap seukuran satu file terbesar (25 MB), bukan seluruh proyek — jadi
    // proyek berisi banyak file besar tidak lagi membuat Worker OOM.
    // Nilai base64 satu file: file besar STREAMING dari chunk (tanpa data-URL
    // utuh), file kecil dari baris/override (bisa berupa data-URL kecil —
    // di-decode jadi base64 murni supaya terunggah sebagai file asli).
    const assetValue = async f => {
      if (f.is_big) {
        const value = await bigFileValue(db, chunksTable, String(f.path));
        return value === null ? { value: '', est: 0 } : { value, est: value.length };
      }
      const raw = String(f.content || '');
      const dm = raw.startsWith('data:') && /^data:([a-z0-9.+-]+\/\/[a-z0-9.+-]+)?;base64,([A-Za-z0-9+/=]+)$/i.exec(raw);
      if (dm && raw.length < 34_000_000) return { value: dm[2], est: raw.length };
      return { value: b64(raw), est: raw.length };
    };
    const assets = [];
    for (const f of files) {
      const ext = (String(f.path).split('.').pop() || '').toLowerCase();
      const { value, est } = await assetValue(f);
      assets.push({
        key: await assetKey(value, ext),
        est: est, // perkiraan ukuran payload — dasar pembagian batch upload
        ext,
        path: f.path,
        contentType: MIME[ext] || 'application/octet-stream',
        src: f // baris aslinya — nilai dimuat ulang saat giliran upload
      });
    }

    let missing = assets.map(a => a.key);
    try {
      const miss = await cfFetch('/pages/assets/check-missing', creds.apiKey, {
        method: 'POST', headers: { Authorization: 'Bearer ' + jwt }, body: JSON.stringify({ hashes: assets.map(a => a.key) })
      });
      if (Array.isArray(miss)) missing = miss;
    } catch (e) {}

    const toUpload = assets.filter(a => missing.indexOf(a.key) > -1);
    if (toUpload.length) await setPhase(db, T.projectSettings, projectId, 'Mengunggah ' + toUpload.length + ' file (0/' + toUpload.length + ')...');
    // Pembagian batch kini berdasarkan ANGGARAN BYTE, bukan jumlah file: payload
    // /pages/assets/upload dibatasi ~50 MB oleh Cloudflare, jadi batch lama
    // (apa adanya 25 file) ditolak kalau isinya file besar. File > 8 MB dikirim
    // SATU-SATU supaya memori payload + salinan JSON.stringify tetap aman.
    const SMALL_BATCH_BYTES = 8_000_000;
    const BIG_SOLO = 8_000_000;
    const smallBatches = [];
    const bigs = [];
    let cur = [], curBytes = 0;
    for (const a of toUpload) {
      const est = a.est || 0;
      if (est > BIG_SOLO) { bigs.push(a); continue; }
      if (curBytes + est > SMALL_BATCH_BYTES) { smallBatches.push(cur); cur = []; curBytes = 0; }
      cur.push(a); curBytes += est;
    }
    if (cur.length) smallBatches.push(cur);
    let uploaded = 0;
    const uploadBatch = async batch => {
      const payload = [];
      for (const a of batch) {
        const { value } = await assetValue(a.src);
        payload.push({ key: a.key, value, metadata: { contentType: a.contentType }, base64: true });
      }
      await cfFetch('/pages/assets/upload', creds.apiKey, {
        method: 'POST', headers: { Authorization: 'Bearer ' + jwt }, body: JSON.stringify(payload)
      });
      uploaded += batch.length;
      await setPhase(db, T.projectSettings, projectId, 'Mengunggah ' + toUpload.length + ' file (' + uploaded + '/' + toUpload.length + ')...');
    };
    // File kecil: batch paralel (maks 3 in-flight ≈ 24 MB payload, jauh di bawah 50 MB/batch)
    for (let i = 0; i < smallBatches.length; i += 3) {
      await Promise.all(smallBatches.slice(i, i + 3).map(uploadBatch));
    }
    // File besar: satu per satu — memori puncak hanya ~2 salinan file terbesar
    for (const a of bigs) await uploadBatch([a]);

    try {
      await cfFetch('/pages/assets/upsert-hashes', creds.apiKey, {
        method: 'POST', headers: { Authorization: 'Bearer ' + jwt }, body: JSON.stringify({ hashes: assets.map(a => a.key) })
      });
    } catch (e) {}

    await setPhase(db, T.projectSettings, projectId, 'Memproses deployment...');
    const form = new FormData();
    const manifest = {};
    for (const a of assets) manifest['/' + a.path] = a.key;
    form.append('manifest', JSON.stringify(manifest));
    form.append('branch', 'main');
    const depRes = await fetch(API_BASE + '/accounts/' + creds.accountId + '/pages/projects/' + targetName + '/deployments', {
      method: 'POST', headers: { Authorization: 'Bearer ' + creds.apiKey }, body: form
    });
    const depData = await depRes.json().catch(() => null);
    if (!depData || !depData.success) {
      const msg = depData && depData.errors && depData.errors[0] ? depData.errors[0].message : ('HTTP ' + depRes.status);
      await db.prepare(`INSERT INTO ${T.deployLogs} (project_id, status, url, message, created_at) VALUES (?, 'failed', '', ?, datetime('now'))`)
        .bind(projectId, 'deploy gagal: ' + msg).run();
      await fireWebhooks(db, T.projectSettings, projectId, 'fail', {
        event: 'deploy.failed', project_id: projectId, pages_project: name, error: msg, at: new Date().toISOString()
      });
      await setPhase(db, T.projectSettings, projectId, '');
      return json({ error: 'Deployment ditolak server. Coba lagi, atau periksa pengaturan proyek Anda.' }, 500);
    }
    const dep = depData.result || {};
    const pubDomain = await ensurePublicDomain(creds, targetName, isPreview ? '' : pubLabel);
    if (!isPreview && pubDomain) {
      // [10 Okt] lepas domain publik lama (auto/label sebelumnya) — sama dgn finalize
      const prevPubMark = (await getSetting(db, T.projectSettings, projectId, 'prev_public_subdomain')) || '';
      for (const od of [name + PUB_SUFFIX, prevPubMark ? (prevPubMark + PUB_SUFFIX) : '']) {
        if (!od || od === pubDomain) continue;
        try { await cfFetch('/accounts/' + creds.accountId + '/pages/projects/' + name + '/domains/' + od, creds.apiKey, { method: 'DELETE' }); } catch (e) {}
        try { await removePublicDomainDns(creds, od); } catch (e) {}
      }
      if (prevPubMark) { try { await setSetting(db, T.projectSettings, projectId, 'prev_public_subdomain', ''); } catch (e) {} }
    }

    // Log sukses dibungkus try/catch: gagal mencatat log TIDAK boleh membuat
    // deploy sukses dilaporkan gagal (pernah bikin user nyangkut di halaman
    // "Mulai Konfigurasi" padahal situsnya sudah online).
    const pubUrl = pubDomain ? ('https://' + pubDomain) : ('https://' + (isPreview ? targetName : (pubLabel || targetName)) + PUB_SUFFIX);
    try {
      await db.prepare(`INSERT INTO ${T.deployLogs} (project_id, status, url, message, created_at) VALUES (?, ?, ?, ?, datetime('now'))`)
        .bind(projectId, isPreview ? 'preview' : 'success', pubUrl, (isPreview ? 'preview ' : 'deploy ') + files.length + ' file ke ' + targetName).run();
    } catch (e) {}
    await setPhase(db, T.projectSettings, projectId, '');
    if (!isPreview) {
      await bumpMonthlyDeployCount(db, user && user.id);
      try { await setSetting(db, T.projectSettings, projectId, 'last_deploy_by', (user && (user.name || user.email)) || 'pengguna'); } catch (e) {}
      await fireWebhooks(db, T.projectSettings, projectId, 'success', {
        event: 'deploy.success', project_id: projectId, pages_project: name, pages_url: pubUrl, file_count: files.length, at: new Date().toISOString()
      });
    }

    const vfy2 = await verifyDeployedPage(pubDomain ? ('https://' + pubDomain) : pubUrl);
    return json({
      success: true,
      pages_project: name,
      pages_url: pubUrl,
      public_url: pubDomain ? ('https://' + pubDomain) : pagesUrl,
      public_domain: pubDomain || '',
      verify: vfy2,
      preview: isPreview,
      preview_url: pubDomain ? ('https://' + pubDomain) : ('https://' + targetName + '.pages.dev'),
      deployment: {
        id: dep.id,
        url: (dep.aliases && dep.aliases[0]) || dep.url || pagesUrl,
        aliases: dep.aliases || [],
        status: (dep.latest_stage && dep.latest_stage.status) || 'idle',
        created: dep.created_on
      },
      fileCount: files.length
    });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
