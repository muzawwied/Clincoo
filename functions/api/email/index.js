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
  // Kolom baru untuk deployment lama (idempoten).
  for (const col of ['sender_email', 'sender_key', 'owner_email']) {
    try { await db.prepare(`ALTER TABLE email_settings ADD COLUMN ${col} TEXT DEFAULT ''`).run(); } catch (e) {}
  }
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
  // Pemilik tak diketahui (proyek legacy tanpa user): biarkan lewat —
  // mode terbatas Cloudflare tetap membatasi penerima di lapisan pengiriman.
  if (!owner) return { ok: true, unresolved: true };
  if (String(to || '').trim().toLowerCase() === owner) return { ok: true };
  return {
    ok: false,
    reason: 'Email Clincoo hanya bisa dikirim ke alamat akun Clincoo kamu (batasan layanan email Cloudflare).'
  };
}

// Kuota bulanan dari penghitung email_settings. Bulan baru / belum pernah dihitung →
// inisialisasi SEKALI dari histori bulan berjalan, lalu lepas dari histori
// (hapus entri log tidak mengurangi kuota: email sudah benar-benar terkirim).
async function quotaUsed(db, projectId) {
  const month = new Date().toISOString().slice(0, 7);
  const row = await db.prepare('SELECT quota_used, quota_month FROM email_settings WHERE project_id = ?').bind(projectId).first();
  if (row && row.quota_month === month && row.quota_used !== null && row.quota_used !== undefined) return row.quota_used;
  const r = await db.prepare(
    "SELECT COUNT(*) AS c FROM email_log WHERE project_id = ? AND status = 'terkirim' AND created_at >= datetime('now', 'start of month')"
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
  const r = await db.prepare('SELECT id, to_addr as "to", subject, status, created_at as time FROM email_log WHERE project_id = ? ORDER BY id DESC LIMIT ?')
    .bind(projectId, limit || 100).all();
  return (r.results || []).map(function (x) {
    return { id: x.id, to: x.to, subject: x.subject, status: x.status, time: (x.time || '').replace('T', ' ').slice(0, 16) };
  });
}

function configPayload(row, used, log, limit) {
  return {
    active: !!(row && row.active),
    api_key: (row && row.active && row.api_key) ? row.api_key : '',
    used: used || 0,
    limit: limit || EMAIL_LIMIT_FALLBACK,
    log: log || [],
    owner_email: (row && row.owner_email) || '',
    sender: { email: DEFAULT_FROM, name: 'Clincoo Mail', custom: false }
  };
}

const DEFAULT_FROM = 'noreply@clincoo.buzz';

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
  return reason || 'Pengiriman gagal';
}

// Kirim via Cloudflare Email Service, lewat Worker jembatan clincoo-mail
// (Pages belum mendukung binding send_email, jadi diproxy via Worker).
async function sendProjectEmail(env, row, opts) {
  const url = await getSecret(env, 'MAIL_BRIDGE_URL');
  const bridgeKey = await getSecret(env, 'MAIL_BRIDGE_KEY');
  if (!url || !bridgeKey) return { sent: false, via: 'cloudflare', code: 'BRIDGE_BELUM_TERKONFIGURASI', reason: null };
  const fromMail = DEFAULT_FROM;
  const fromName = 'Clincoo Mail';
  try {
    const r = await fetch(String(url).replace(/\/$/, '') + '/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Bridge-Key': String(bridgeKey) },
      body: JSON.stringify({
        to: opts.toEmail,
        from_email: fromMail,
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
      return json({ used: used, limit: limit, items: await historyLog(env.DB, projectId, 100) });
    }
    await ensureOwnerEmail(env, row);
    return json(configPayload(row, used, await historyLog(env.DB, projectId, 10), limit));
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
    const result = await sendProjectEmail(env, row, {
      toEmail: body.to,
      subject: String(body.subject).slice(0, 200),
      html: String(body.html),
      replyTo: body.reply_to || row.contact_to || ''
    });
    await env.DB.prepare('INSERT INTO email_log (project_id, to_addr, subject, status) VALUES (?, ?, ?, ?)')
      .bind(row.project_id, body.to, String(body.subject).slice(0, 200), result.sent ? 'terkirim' : 'gagal').run();
    if (result.sent) await bumpQuota(env.DB, row.project_id);
    return json({ sent: !!result.sent, reason: result.sent ? null : friendlyEmailError(result.code, result.reason) });
  }

  const projectId = body.project_id || '';
  const denied = await guardEmail(env, request, projectId);
  if (denied) return denied;
  await ensureTables(env.DB);

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
    return json(configPayload(row, await quotaUsed(env.DB, projectId), [], await emailQuotaLimitForUser(env, user)));
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

  return json({ error: 'unknown_action' }, 400);
}
