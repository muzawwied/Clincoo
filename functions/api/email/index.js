// Clincoo Email API — kirim email dari situs deploy pengguna (form kontak, notifikasi, verifikasi).
// Kredensial (API key) diterbitkan per proyek, tersimpan di D1, terisolasi antar proyek.
//
// Pengiriman via Cloudflare Email Service (Worker jembatan clincoo-mail):
//   dari noreply@clincoo.buzz, nama pengirim TIDAK boleh menyertakan identitas
//   tim Clincoo/Clinqoo (anti penipuan). Fitur domain kustom dihapus: Cloudflare
//   hanya mengizinkan pengiriman dari domain yang zone-nya berada di akun Cloudflare
//   yang sama dengan Worker pengirim — domain milik user (di akun CF user sendiri)
//   tidak bisa dipakai jembatan email Clincoo.
//
// Kuota bulanan = penghitung tersendiri di email_settings (quota_used + quota_month):
// naik saat kirim sukses, TIDAK turun saat entri histori dihapus.
//
// Penerima HANYA email akun Clincoo pemilik proyek (mode terbatas Cloudflare:
// tanpa sending domain yang ter-onboard, Cloudflare hanya mengizinkan penerima terverifikasi).
//
// GET  ?action=config&project_id=...                          → status, pengirim, API key, kuota [auth]
// GET  ?action=history&project_id=...                         → histori kirim (CRUD: read)    [auth]
// POST {action:'activate', project_id}                        → aktifkan + terbitkan API key [auth]
// POST {action:'regenerate', project_id}                      → terbitkan API key baru        [auth]
// POST {action:'revoke', project_id}                          → nonaktifkan + hapus API key   [auth]
// POST {action:'delete_log', project_id, id}                  → hapus entri histori (delete)  [auth]
// POST {action:'send', api_key, to, subject, html, reply_to}  → kirim email dari situs deploy  [publik via api_key]
// GET  ?action=broadcast_list&project_id=...               → riwayat broadcast            [auth]
// GET  ?action=audience_list&project_id=...                → daftar kontak audiens        [auth]
// POST {action:'broadcast', project_id, to, subject, html}  → kirim massal (maks 50 penerima) [auth]

import { guardProject, currentUser } from '../user-scope.js';
import { getEffectivePlan, getEffectivePlanByUserKey } from '../plan-helpers.js';
import { getSecret } from '../notify-helpers.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

// Kuota email bulanan per paket akun pemilik proyek (Okt 2026): Starter 100 / Pro 500 / Bisnis 1000.
const PLAN_EMAIL_LIMITS = { Starter: 100, Pro: 500, Bisnis: 1000 };
const EMAIL_LIMIT_FALLBACK = 100;

// Batas kuota untuk rute auth (config/history/activate) — user = pemilik proyek.
async function emailQuotaLimitForUser(env, user) {
  try {
    if (user && user.id != null) {
      const eff = await getEffectivePlan(env.DB, user);
      return PLAN_EMAIL_LIMITS[eff.plan] || EMAIL_LIMIT_FALLBACK;
    }
  } catch (e) {}
  return EMAIL_LIMIT_FALLBACK;
}

// Batas kuota untuk rute publik (send via api_key): cari pemilik proyek dulu.
async function emailQuotaLimitForProject(env, projectId) {
  try {
    const p = await env.DB.prepare('SELECT user_id FROM user_projects WHERE id = ?').bind(String(projectId)).first();
    if (p && p.user_id != null) {
      const eff = await getEffectivePlanByUserKey(env.DB, 'u' + p.user_id);
      return PLAN_EMAIL_LIMITS[eff.plan] || EMAIL_LIMIT_FALLBACK;
    }
  } catch (e) {}
  return EMAIL_LIMIT_FALLBACK;
}
const KEY_PREFIX = 'clc_email_';

// Nama identitas tim — tidak boleh dipakai pengirim proyek (anti penipuan atas nama Clincoo).
const BANNED_NAME_PATTERNS = [/clin\s*coo/i, /clin\s*qoo/i, /tim\s+clin/i];
const BANNED_EMAIL_DOMAINS = ['clincoo.buzz', 'clinqoo.com', 'clincoo.com'];
// Local part @clincoo.buzz yang dilarang diklaim proyek (kesan resmi/official → phishing).
const RESERVED_LOCALS = ['noreply','no-reply','donotreply','support','admin','administrator',
  'security','official','staff','team','billing','finance','help','helpdesk','info','contact','hello',
  'mail','email','root','postmaster','webmaster','service','cs','legal','privacy'];
function senderAddrAllowed(addr) {
  const local = String(addr || '').split('@')[0].trim().toLowerCase().replace(/[^a-z0-9.-]/g, '');
  return RESERVED_LOCALS.indexOf(local) === -1;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...CORS } });
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

async function ensureTables(db) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS email_settings (
    project_id TEXT PRIMARY KEY,
    api_key TEXT,
    active INTEGER DEFAULT 0,
    from_name TEXT DEFAULT '',
    contact_to TEXT DEFAULT '',
    sender_email TEXT DEFAULT '',
    sender_key TEXT DEFAULT '',
    quota_used INTEGER DEFAULT 0,
    quota_month TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )`).run();
  await db.prepare('CREATE UNIQUE INDEX IF NOT EXISTS idx_email_settings_key ON email_settings(api_key)').run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS email_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL,
    to_addr TEXT NOT NULL,
    subject TEXT DEFAULT '',
    status TEXT DEFAULT 'terkirim',
    created_at TEXT DEFAULT (datetime('now'))
  )`).run();
  await db.prepare('CREATE INDEX IF NOT EXISTS idx_email_log_project ON email_log(project_id, created_at)').run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS email_broadcasts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL,
    subject TEXT DEFAULT '',
    total INTEGER DEFAULT 0,
    sent INTEGER DEFAULT 0,
    failed INTEGER DEFAULT 0,
    failures TEXT DEFAULT '[]',
    created_at TEXT DEFAULT (datetime('now'))
  )`).run();
  await db.prepare('CREATE INDEX IF NOT EXISTS idx_email_bcast_project ON email_broadcasts(project_id, created_at)').run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS email_audience (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL,
    email TEXT NOT NULL,
    name TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  )`).run();
  await db.prepare('CREATE UNIQUE INDEX IF NOT EXISTS idx_email_audience_project_email ON email_audience(project_id, email)').run();
  // Kolom baru untuk deployment lama (idempoten).
  for (const col of ['sender_email', 'sender_key', 'owner_email']) {
    try { await db.prepare(`ALTER TABLE email_settings ADD COLUMN ${col} TEXT DEFAULT ''`).run(); } catch (e) {}
  }
  try { await db.prepare(`ALTER TABLE email_broadcasts ADD COLUMN recipients TEXT DEFAULT '[]'`).run(); } catch (e) {}
}

function genApiKey() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  for (let i = 0; i < 32; i++) s += chars[bytes[i] % chars.length];
  return KEY_PREFIX + s;
}

function validEmail(e) {
  return typeof e === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim());
}

// Validasi anti-impersonasi: nama pengirim tidak boleh menyertakan identitas tim Clincoo.
function senderNameAllowed(name) {
  const n = String(name || '').trim();
  if (!n) return { ok: true, name: '' };
  for (const p of BANNED_NAME_PATTERNS) {
    if (p.test(n)) return { ok: false, reason: 'Nama pengirim tidak boleh memakai nama atau identitas tim Clincoo/Clinqoo.' };
  }
  return { ok: true, name: n.slice(0, 100) };
}

async function getRow(db, projectId) {
  return await db.prepare('SELECT * FROM email_settings WHERE project_id = ?').bind(projectId).first();
}

// Email akun pemilik proyek — backfill lazy untuk baris lama (kolom owner_email baru).
async function ensureOwnerEmail(env, row) {
  if (!row || row.owner_email) return row ? row.owner_email : '';
  try {
    const p = await env.DB.prepare('SELECT user_id FROM user_projects WHERE id = ?').bind(String(row.project_id)).first();
    if (p && p.user_id != null) {
      const u = await env.DB.prepare('SELECT email FROM auth_users WHERE id = ?').bind(p.user_id).first();
      if (u && u.email) {
        try { await env.DB.prepare("UPDATE email_settings SET owner_email = ?, updated_at = datetime('now') WHERE project_id = ?").bind(u.email, row.project_id).run(); } catch (e) {}
        return u.email;
      }
    }
  } catch (e) {}
  return row.owner_email || '';
}

// Penerima wajib = email akun pemilik proyek (batasan Cloudflare tanpa sending domain).
async function recipientAllowed(env, row, to) {
  const owner = String((row.owner_email || '')).trim().toLowerCase();
  if (String(to || '').trim().toLowerCase() === owner) return { ok: true, via: 'cloudflare' };
  // Penerima luar: lewat Resend (domain clincoo.buzz terverifikasi) bila terpasang.
  if (await getSecret(env, 'RESEND_API_KEY')) return { ok: true, via: 'resend' };
  // Pemilik tak diketahui (proyek legacy tanpa user): biarkan lewat —
  // mode terbatas Cloudflare tetap membatasi penerima di lapisan pengiriman.
  if (!owner) return { ok: true, via: 'cloudflare', unresolved: true };
  return {
    ok: false,
    reason: 'Email Clincoo hanya bisa dikirim ke alamat akun Clincoo kamu (batasan layanan email Cloudflare).'
  };
}

// Kuota bulanan dari penghitung email_settings. Bulan baru / belum pernah dihitung →
// inisialisasi SEKALI dari histori bulan berjalan, lalu lepas dari histori
// (hapus entri log tidak mengurangi kuota: email sudah benar-benar terkirim).
async function quotaUsed(db, projectId) {
  // Label bulan dalam WIB (UTC+7) — konsisten dengan waktu histori yang tampil WIB.
  const month = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 7);
  const row = await db.prepare('SELECT quota_used, quota_month FROM email_settings WHERE project_id = ?').bind(projectId).first();
  if (row && row.quota_month === month && row.quota_used !== null && row.quota_used !== undefined) return row.quota_used;
  const r = await db.prepare(
    "SELECT COUNT(*) AS c FROM email_log WHERE project_id = ? AND status = 'terkirim' AND created_at >= datetime('now', '-7 hours', 'start of month')"
  ).bind(projectId).first();
  const used = (r && r.c) || 0;
  try {
    await db.prepare('UPDATE email_settings SET quota_used = ?, quota_month = ? WHERE project_id = ?').bind(used, month, projectId).run();
  } catch (e) {}
  return used;
}

async function bumpQuota(db, projectId) {
  await quotaUsed(db, projectId); // pastikan penghitung bulan ini sudah terinisialisasi
  try {
    await db.prepare('UPDATE email_settings SET quota_used = quota_used + 1 WHERE project_id = ?').bind(projectId).run();
  } catch (e) {}
}

async function guardEmail(env, request, projectId) {
  if (!projectId) return json({ error: 'unauthorized', need_login: true }, 401);
  const denied = await guardProject(env, request, projectId);
  if (denied) return denied;
  const user = await currentUser(env, request);
  if (!user) return json({ error: 'unauthorized', need_login: true }, 401);
  return null;
}

async function historyLog(db, projectId, limit) {
  // Waktu disimpan UTC di D1; tampilkan dalam WIB (UTC+7) agar log & grafik akurat untuk pengguna Indonesia.
  const r = await db.prepare("SELECT id, to_addr as \"to\", subject, status, strftime('%Y-%m-%d %H:%M', created_at, '+7 hours') as time FROM email_log WHERE project_id = ? ORDER BY id DESC LIMIT ?")
    .bind(projectId, limit || 100).all();
  return (r.results || []).map(function (x) {
    return { id: x.id, to: x.to, subject: x.subject, status: x.status, time: (x.time || '').replace('T', ' ').slice(0, 16) };
  });
}

async function projectDisplayName(db, row) {
  const custom = String((row && row.from_name) || '').trim();
  if (custom) return custom;
  try {
    const p = await db.prepare('SELECT title FROM user_projects WHERE id = ?').bind(String(row.project_id)).first();
    if (p && p.title) {
      const t = String(p.title).replace(/["<>\r\n]/g, '').slice(0, 60);
      // Judul proyek pun tidak boleh meng-impersonasi tim Clincoo di email keluar.
      const ok = senderNameAllowed(t);
      if (ok.ok && ok.name) return ok.name;
    }
  } catch (e) {}
  return 'Clincoo Mail';
}

async function configPayload(env, row, used, log, limit) {
  return {
    active: !!(row && row.active),
    from_name: (row && row.from_name) || '',
    sender_email: (row && row.sender_email) || '',
    api_key: (row && row.active && row.api_key) ? row.api_key : '',
    used: used || 0,
    limit: limit || EMAIL_LIMIT_FALLBACK,
    log: log || [],
    owner_email: (row && row.owner_email) || '',
    sender: { email: (row && row.sender_email) || DEFAULT_FROM, name: await projectDisplayName(env.DB, row), custom: !!(row && (row.sender_email || row.from_name)) }
  };
}

const DEFAULT_FROM = 'noreply@clincoo.buzz';

function sanitizeSender(body) {
  let from_name = String((body && body.from_name) || '').trim().replace(/["<>\r\n]/g, '').slice(0, 60);
  // Anti-impersonasi: nama pengirim dilarang menyertakan identitas tim Clincoo/Clinqoo.
  const nameOk = senderNameAllowed(from_name);
  if (!nameOk.ok) return { error: nameOk.reason };
  from_name = nameOk.name;
  const sender_email = String((body && body.sender_email) || '').trim().toLowerCase();
  if (sender_email) {
    if (!validEmail(sender_email)) return { error: 'Alamat pengirim tidak valid' };
    if (sender_email.slice(-13) !== '@clincoo.buzz') return { error: 'Alamat pengirim harus di domain @clincoo.buzz' };
  }
  return { from_name: from_name, sender_email: sender_email };
}

function stripHtml(h) {
  return String(h || '').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 5000);
}

function friendlyEmailError(code, reason) {
  if (code === 'E_SENDER_NOT_VERIFIED') return 'Domain pengirim belum terverifikasi di Cloudflare — hubungi tim Clincoo.';
  if (code === 'E_RATE_LIMIT_EXCEEDED') return 'Terlalu banyak email dalam waktu singkat — tunggu sebentar lalu coba lagi.';
  if (code === 'E_DAILY_LIMIT_EXCEEDED') return 'Kuota harian Cloudflare tercapai — coba lagi besok.';
  if (code === 'E_DELIVERY_FAILED') return 'Penerima menolak email — periksa alamat tujuan.';
  if (code === 'E_INTERNAL_SERVER_ERROR') return 'Layanan email Cloudflare sedang sibuk — coba lagi sebentar.';
  if (code === 'BINDING_SEND_EMAIL_BELUM_AKTIF') return 'Layanan email belum aktif di server — hubungi tim Clincoo.';
  if (code === 'BRIDGE_BELUM_TERKONFIGURASI') return 'Layanan email belum dikonfigurasi di server — hubungi tim Clincoo.';
  if (code === 'E_RECIPIENT_NOT_ALLOWED') return 'Penerima belum terverifikasi di Cloudflare — mode terbatas layanan email Clincoo. Hubungi tim Clincoo bila email ini penting.';
  if (code === 'RESEND_BELUM_TERKONFIGURASI') return 'Layanan email belum dikonfigurasi di server — hubungi tim Clincoo.';
  if (code === 'RESEND_401' || code === 'RESEND_403') return 'Kunci/domain pengirim email belum valid di server — hubungi tim Clincoo.';
  if (code === 'RESEND_429') return 'Terlalu banyak email dalam waktu singkat (batas harian Resend) — tunggu sebentar lalu coba lagi.';
  if (code === 'RESEND_422') return 'Alamat atau isi email ditolak Resend — periksa alamat tujuan.';
  if (String(code || '').indexOf('RESEND_') === 0) return 'Layanan pengirim email (Resend) sedang bermasalah — coba lagi sebentar.';
  return reason || 'Pengiriman gagal';
}

// Kirim ke penerima LUAR (non-akun Clincoo) via Resend — domain clincoo.buzz terverifikasi.
async function sendViaResend(env, row, opts) {
  const key = await getSecret(env, 'RESEND_API_KEY');
  if (!key) return { sent: false, via: 'resend', code: 'RESEND_BELUM_TERKONFIGURASI', reason: null };
  try {
    const fromAddr = senderAddrAllowed(row.sender_email) ? (String(row.sender_email || '') || DEFAULT_FROM) : DEFAULT_FROM;
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + String(key) },
      body: JSON.stringify({
        from: '"' + (await projectDisplayName(env.DB, row)) + '" <' + fromAddr + '>',
        to: [opts.toEmail],
        subject: opts.subject,
        html: opts.html,
        text: stripHtml(opts.html),
        ...(opts.replyTo ? { reply_to: opts.replyTo } : {})
      })
    });
    const data = await r.json().catch(function () { return {}; });
    if (r.ok && (data.id || data.sent)) return { sent: true, via: 'resend', messageId: data.id || null };
    return { sent: false, via: 'resend', code: 'RESEND_' + r.status, reason: (data && (data.message || data.name)) || ('HTTP ' + r.status) };
  } catch (e) {
    return { sent: false, via: 'resend', code: null, reason: String((e && e.message) || e) };
  }
}

// Kirim via Cloudflare Email Service, lewat Worker jembatan clincoo-mail
// (Pages belum mendukung binding send_email, jadi diproxy via Worker).
async function sendProjectEmail(env, row, opts) {
  const url = await getSecret(env, 'MAIL_BRIDGE_URL');
  const bridgeKey = await getSecret(env, 'MAIL_BRIDGE_KEY');
  if (!url || !bridgeKey) return { sent: false, via: 'cloudflare', code: 'BRIDGE_BELUM_TERKONFIGURASI', reason: null };
  let customAddr = String(row.sender_email || '').trim();
  if (customAddr && !senderAddrAllowed(customAddr)) customAddr = ''; // alamat reserved legacy → pakai default
  const fromName = await projectDisplayName(env.DB, row);
  async function attempt(fromAddr) {
    const r = await fetch(String(url).replace(/\/$/, '') + '/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Bridge-Key': String(bridgeKey) },
      body: JSON.stringify({
        to: opts.toEmail,
        from_email: fromAddr,
        from_name: fromName,
        subject: opts.subject,
        html: opts.html,
        text: stripHtml(opts.html),
        ...(opts.replyTo ? { reply_to: opts.replyTo } : {})
      })
    });
    const data = await r.json().catch(function () { return {}; });
    if (r.ok && data.ok) return { sent: true, via: 'cloudflare', messageId: data.messageId || null };
    return { sent: false, via: 'cloudflare', code: data.code || null, reason: data.error || ('HTTP ' + r.status) };
  }
  try {
    const res = await attempt(customAddr || DEFAULT_FROM);
    // Alamat kustom ditolak bridge? coba sekali lagi dengan default noreply.
    if (!res.sent && customAddr && customAddr !== DEFAULT_FROM) {
      const retry = await attempt(DEFAULT_FROM);
      if (retry.sent) return retry;
    }
    return res;
  } catch (e) {
    return { sent: false, via: 'cloudflare', code: null, reason: String((e && e.message) || e) };
  }
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const action = url.searchParams.get('action');
  const projectId = url.searchParams.get('project_id') || '';

  if (action === 'config' || action === 'history') {
    const denied = await guardEmail(env, request, projectId);
    if (denied) return denied;
    await ensureTables(env.DB);
    const row = await getRow(env.DB, projectId);
    if (!row) return json({ error: 'not_found' }, 404);
    const used = await quotaUsed(env.DB, projectId);
    const limit = await emailQuotaLimitForUser(env, await currentUser(env, request));
    if (action === 'history') {
      return json({ used: used, limit: limit, from_name: row.from_name || '', sender_email: row.sender_email || '', items: await historyLog(env.DB, projectId, 100) });
    }
    await ensureOwnerEmail(env, row);
    return json(await configPayload(env, row, used, await historyLog(env.DB, projectId, 10), limit));
  }

  if (action === 'audience_list') {
    const denied = await guardEmail(env, request, projectId);
    if (denied) return denied;
    await ensureTables(env.DB);
    const rows = await env.DB.prepare(
      'SELECT email, name FROM email_audience WHERE project_id = ? ORDER BY id DESC LIMIT 200'
    ).bind(projectId).all();
    const items = (rows && rows.results ? rows.results : []).map(function (r) { return { email: r.email, name: r.name || '' }; });
    return json({ items: items });
  }

  if (action === 'broadcast_list') {
    const denied = await guardEmail(env, request, projectId);
    if (denied) return denied;
    await ensureTables(env.DB);
    const rows = await env.DB.prepare(
      'SELECT id, subject, total, sent, failed, failures, recipients, created_at FROM email_broadcasts WHERE project_id = ? ORDER BY id DESC LIMIT 25'
    ).bind(projectId).all();
    const items = (rows && rows.results ? rows.results : []).map(function (r) {
      let f = [], rc = [];
      try { f = JSON.parse(r.failures || '[]'); } catch (e) {}
      try { rc = JSON.parse(r.recipients || '[]'); } catch (e) {}
      return { id: r.id, subject: r.subject, total: r.total, sent: r.sent, failed: r.failed, failures: f.slice(0, 10), recipients: rc, created_at: r.created_at };
    });
    return json({ items: items });
  }

  return json({ error: 'unknown_action' }, 400);
}

export async function onRequestPost({ request, env }) {
  let body = {};
  try { body = await request.json(); } catch (e) {}
  const action = body.action;

  // ---- Kirim email dari situs deploy via API key (tidak butuh login) ----
  if (action === 'send') {
    const apiKey = (body.api_key || (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '')).trim();
    if (!apiKey) return json({ error: 'api_key diperlukan' }, 401);
    if (!body.to || !body.subject || !body.html) return json({ error: 'to, subject, dan html wajib diisi' }, 400);
    if (!validEmail(body.to)) return json({ error: 'Alamat email tujuan tidak valid' }, 400);
    await ensureTables(env.DB);
    const row = await env.DB.prepare('SELECT * FROM email_settings WHERE api_key = ? AND active = 1').bind(apiKey).first();
    if (!row) return json({ error: 'API key tidak valid atau belum aktif' }, 401);
    const used = await quotaUsed(env.DB, row.project_id);
    if (used >= (await emailQuotaLimitForProject(env, row.project_id))) return json({ error: 'Kuota bulanan habis' }, 429);
    await ensureOwnerEmail(env, row);
    const allow = await recipientAllowed(env, row, body.to);
    if (!allow.ok) return json({ error: allow.reason }, 422);
    const sendOpts = {
      toEmail: body.to,
      subject: String(body.subject).slice(0, 200),
      html: String(body.html),
      replyTo: body.reply_to || row.contact_to || ''
    };
    const result = (allow.via === 'resend')
      ? await sendViaResend(env, row, sendOpts)
      : await sendProjectEmail(env, row, sendOpts);
    await env.DB.prepare('INSERT INTO email_log (project_id, to_addr, subject, status) VALUES (?, ?, ?, ?)')
      .bind(row.project_id, body.to, String(body.subject).slice(0, 200), result.sent ? 'terkirim' : 'gagal').run();
    if (result.sent) await bumpQuota(env.DB, row.project_id);
    return json({ sent: !!result.sent, reason: result.sent ? null : friendlyEmailError(result.code, result.reason) });
  }

  const projectId = body.project_id || '';
  const denied = await guardEmail(env, request, projectId);
  if (denied) return denied;
  await ensureTables(env.DB);

  if (action === 'sender_check') {
    const email = String(body.sender_email || '').trim().toLowerCase();
    if (!email) return json({ available: true });
    if (!senderAddrAllowed(email)) return json({ available: false, reserved: true });
    const dup = await env.DB.prepare('SELECT project_id FROM email_settings WHERE sender_email = ? AND project_id != ?').bind(email, projectId).first();
    return json({ available: !dup });
  }

  if (action === 'sender') {
    const v = sanitizeSender(body);
    if (v.error) return json({ error: v.error }, 422);
    const row = await getRow(env.DB, projectId);
    if (!row) return json({ error: 'not_found' }, 404);
    if (v.sender_email) {
      if (!senderAddrAllowed(v.sender_email)) return json({ error: 'Alamat pengirim itu dipesan untuk sistem Clincoo — pilih alamat lain' }, 422);
      const dup = await env.DB.prepare('SELECT project_id FROM email_settings WHERE sender_email = ? AND project_id != ?').bind(v.sender_email, projectId).first();
      if (dup) return json({ error: 'Alamat pengirim sudah dipakai proyek lain' }, 409);
    }
    await env.DB.prepare("UPDATE email_settings SET from_name = ?, sender_email = ?, updated_at = datetime('now') WHERE project_id = ?")
      .bind(v.from_name, v.sender_email, projectId).run();
    const fresh = await getRow(env.DB, projectId);
    const used = await quotaUsed(env.DB, projectId);
    return json(await configPayload(env, fresh, used, await historyLog(env.DB, projectId, 10), await emailQuotaLimitForUser(env, await currentUser(env, request))));
  }

  if (action === 'activate') {
    const user = await currentUser(env, request);
    const ownerEmail = (user && user.email) || '';
    const existing = await getRow(env.DB, projectId);
    if (existing) {
      await env.DB.prepare("UPDATE email_settings SET active = 1, api_key = COALESCE(api_key, ?), owner_email = COALESCE(NULLIF(owner_email, ''), ?), updated_at = datetime('now') WHERE project_id = ?")
        .bind(genApiKey(), ownerEmail, projectId).run();
    } else {
      await env.DB.prepare('INSERT INTO email_settings (project_id, api_key, active, owner_email) VALUES (?, ?, 1, ?)')
        .bind(projectId, genApiKey(), ownerEmail).run();
    }
    const row = await getRow(env.DB, projectId);
    return json(await configPayload(env, row, await quotaUsed(env.DB, projectId), [], await emailQuotaLimitForUser(env, user)));
  }


  if (action === 'regenerate') {
    const row = await getRow(env.DB, projectId);
    if (!row) return json({ error: 'Aktifkan email dulu' }, 400);
    const newKey = genApiKey();
    await env.DB.prepare("UPDATE email_settings SET api_key = ?, active = 1, updated_at = datetime('now') WHERE project_id = ?").bind(newKey, projectId).run();
    return json({ api_key: newKey });
  }

  if (action === 'revoke') {
    const row = await getRow(env.DB, projectId);
    if (!row) return json({ error: 'Aktifkan email dulu' }, 400);
    await env.DB.prepare("UPDATE email_settings SET active = 0, api_key = NULL, updated_at = datetime('now') WHERE project_id = ?").bind(projectId).run();
    return json({ ok: true });
  }


  if (action === 'delete_log') {
    const row = await getRow(env.DB, projectId);
    if (!row) return json({ error: 'Aktifkan email dulu' }, 400);
    const id = parseInt(body.id, 10);
    if (!id) return json({ error: 'id tidak valid' }, 400);
    await env.DB.prepare('DELETE FROM email_log WHERE id = ? AND project_id = ?').bind(id, projectId).run();
    return json({ ok: true });
  }

  // ---- Broadcast: kirim ke banyak penerima sekaligus (login pemilik proyek) ----
  if (action === 'broadcast') {
    const row = await getRow(env.DB, projectId);
    if (!row) return json({ error: 'Aktifkan email dulu' }, 400);
    if (!body.subject || !body.html) return json({ error: 'subject dan html wajib diisi' }, 400);
    const MAX_BCAST = 50; // batas subrequest Cloudflare per request
    let raw = body.to || body.recipients || [];
    const parts = Array.isArray(raw) ? raw : String(raw).split(/[\s,;]+/);
    const seen = {}; const targets = [];
    for (const t of parts) {
      const e = String(t || '').trim().toLowerCase();
      if (e && !seen[e] && validEmail(e)) { seen[e] = 1; targets.push(e); }
    }
    if (!targets.length) return json({ error: 'Daftar penerima kosong atau tidak ada alamat valid' }, 422);
    if (targets.length > MAX_BCAST) return json({ error: 'Maksimal ' + MAX_BCAST + ' penerima per broadcast (batas layanan)' }, 422);
    const used = await quotaUsed(env.DB, projectId);
    const limit = await emailQuotaLimitForUser(env, await currentUser(env, request));
    const sisa = Math.max(0, limit - used);
    if (targets.length > sisa) return json({ error: 'Kuota bulanan tidak cukup: sisa ' + sisa + ' email, broadcast ini butuh ' + targets.length + '. Kurangi penerima atau tunggu kuota reset bulan depan.' }, 429);
    await ensureOwnerEmail(env, row);
    const subject = String(body.subject).slice(0, 200);
    const html = String(body.html);
    let sent = 0; const failures = [];
    for (const to of targets) {
      let ok = false; let reason = '';
      try {
        const allow = await recipientAllowed(env, row, to);
        if (!allow.ok) reason = allow.reason;
        else {
          const opts = { toEmail: to, subject: subject, html: html, replyTo: body.reply_to || '' };
          const res = (allow.via === 'resend') ? await sendViaResend(env, row, opts) : await sendProjectEmail(env, row, opts);
          ok = !!res.sent;
          if (!ok) reason = friendlyEmailError(res.code, res.reason);
        }
      } catch (e) { reason = 'Gagal tak terduga saat mengirim'; }
      await env.DB.prepare('INSERT INTO email_log (project_id, to_addr, subject, status) VALUES (?, ?, ?, ?)')
        .bind(projectId, to, subject, ok ? 'terkirim' : 'gagal').run();
      if (ok) { sent++; await bumpQuota(env.DB, projectId); }
      else failures.push({ to: to, reason: reason || 'Gagal mengirim' });
    }
    await env.DB.prepare('INSERT INTO email_broadcasts (project_id, subject, total, sent, failed, failures, recipients) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(projectId, subject, targets.length, sent, failures.length, JSON.stringify(failures.slice(0, 50)), JSON.stringify(targets)).run();
    return json({ ok: true, total: targets.length, sent: sent, failed: failures.length, failures: failures });
  }

  return json({ error: 'unknown_action' }, 400);
}
