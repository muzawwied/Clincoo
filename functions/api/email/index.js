// Clincoo Email API — kirim email dari situs deploy pengguna (form kontak, notifikasi, verifikasi).
// Kredensial (API key) diterbitkan per proyek, tersimpan di D1, terisolasi antar proyek.
//
// Pengiriman via Cloudflare Email Service (Worker jembatan clincoo-mail):
//   1. Default  : dari noreply@clincoo.buzz, nama pengirim proyek TIDAK boleh menyertakan
//                 identitas tim Clincoo/Clinqoo (anti penipuan).
//   2. Kustom   : dari alamat domain kustom pengguna (domain harus ter-onboard di akun
//                 Cloudflare Clincoo / terhubung lewat Zona Domain Kustom).
//
// Kuota bulanan = penghitung tersendiri di email_settings (quota_used + quota_month):
// naik saat kirim sukses, TIDAK turun saat entri histori dihapus.
//
// Tier pengiriman:
//   0. Tanpa domain terverifikasi : pengirim default noreply@clincoo.buzz ("Clincoo Mail"),
//      penerima HANYA email akun Clincoo pemilik proyek (mode terbatas Cloudflare).
//   1. Domain terverifikasi      : pengirim kustom nama@domainmilikpengguna + nama tampilan,
//      penerima bebas (routing selesai setelah domain di-onboard di dashboard Cloudflare).
//
// GET  ?action=config&project_id=...                          → status, pengirim, domain, API key, kuota [auth]
// GET  ?action=history&project_id=...                         → histori kirim (CRUD: read)    [auth]
// POST {action:'activate', project_id}                        → aktifkan + terbitkan API key [auth]
// POST {action:'add_domain', project_id, domain}              → daftar domain + token verifikasi TXT [auth]
// POST {action:'check_domain', project_id}                    → cek TXT _clincoo-verify → verified [auth]
// POST {action:'set_domain_sender', project_id, local,
//        sender_name}                                          → alamat pengirim kustom @domain [auth]
// POST {action:'delete_domain', project_id}                   → hapus domain → kembali tier 0   [auth]
// POST {action:'regenerate', project_id}                      → terbitkan API key baru        [auth]
// POST {action:'revoke', project_id}                          → nonaktifkan + hapus API key   [auth]
// POST {action:'delete_log', project_id, id}                  → hapus entri histori (delete)  [auth]
// POST {action:'send', api_key, to, subject, html, reply_to}  → kirim email dari situs deploy  [publik via api_key]

import { guardProject, currentUser } from '../user-scope.js';
import { getSecret } from '../notify-helpers.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

const QUOTA_LIMIT = 1000;
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
  await db.prepare(`CREATE TABLE IF NOT EXISTS email_domains (
    project_id TEXT PRIMARY KEY,
    domain TEXT DEFAULT '',
    verify_token TEXT DEFAULT '',
    status TEXT DEFAULT 'pending',
    sender_email TEXT DEFAULT '',
    sender_name TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )`).run();
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

// ---- Domain kustom ----
function genToken() {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(b).map(function (x) { return x.toString(16).padStart(2, '0'); }).join('');
}

function validDomain(d) {
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(d) && d.length <= 200;
}

async function getDomain(db, projectId) {
  try {
    return await db.prepare('SELECT * FROM email_domains WHERE project_id = ?').bind(projectId).first() || null;
  } catch (e) { return null; }
}

function domainActive(dom) {
  return !!(dom && dom.status === 'verified');
}

function domainPayload(dom) {
  if (!dom || !dom.domain) return { domain: '', status: '', verify_token: '', txt_name: '', txt_value: '', sender_email: '', sender_name: '' };
  return {
    domain: dom.domain,
    status: dom.status || 'pending',
    verify_token: dom.verify_token || '',
    txt_name: '_clincoo-verify.' + dom.domain,
    txt_value: 'clincoo-verify=' + (dom.verify_token || ''),
    sender_email: dom.sender_email || '',
    sender_name: dom.sender_name || ''
  };
}

// Lookup TXT via DNS-over-HTTPS Cloudflare (port 443, aman dari Pages Function).
async function dnsTxtLookup(name) {
  try {
    const r = await fetch('https://cloudflare-dns.com/dns-query?name=' + encodeURIComponent(name) + '&type=TXT',
      { headers: { accept: 'application/dns-json' } });
    if (!r.ok) return [];
    const d = await r.json().catch(function () { return {}; });
    return (d.Answer || []).map(function (a) { return String(a.data || '').replace(/^"+|"+$/g, ''); });
  } catch (e) { return []; }
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

// Tier 0: tanpa domain aktif, penerima wajib = email akun pemilik proyek.
async function recipientAllowed(env, row, to) {
  const dom = await getDomain(env.DB, row.project_id);
  if (domainActive(dom)) return { ok: true, dom: dom };
  const owner = String((row.owner_email || '')).trim().toLowerCase();
  // Pemilik tak diketahui (proyek legacy tanpa user): biarkan lewat —
  // mode terbatas Cloudflare tetap membatasi penerima di lapisan pengiriman.
  if (!owner) return { ok: true, dom: dom, unresolved: true };
  if (String(to || '').trim().toLowerCase() === owner) return { ok: true, dom: dom };
  return {
    ok: false, dom: dom,
    reason: 'Sebelum domainmu aktif, email hanya bisa dikirim ke alamat akun Clincoo kamu. Tambahkan & verifikasi domain di menu Domain untuk membuka pengiriman bebas.'
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

function configPayload(row, used, log, dom) {
  const custom = !!(dom && dom.status === 'verified' && dom.sender_email);
  return {
    active: !!(row && row.active),
    api_key: (row && row.active && row.api_key) ? row.api_key : '',
    used: used || 0,
    limit: QUOTA_LIMIT,
    log: log || [],
    owner_email: (row && row.owner_email) || '',
    sender: {
      email: custom ? dom.sender_email : DEFAULT_FROM,
      name: custom && dom.sender_name ? dom.sender_name : 'Clincoo Mail',
      custom: custom
    },
    domain: domainPayload(dom)
  };
}

const DEFAULT_FROM = 'noreply@clincoo.buzz';

function stripHtml(h) {
  return String(h || '').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 5000);
}

function friendlyEmailError(code, reason) {
  if (code === 'E_SENDER_NOT_VERIFIED') return 'Domain pengirim belum terverifikasi di Cloudflare. Untuk pengirim kustom, pastikan domainmu sudah aktif di Clincoo (Zona Domain Kustom).';
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
  const dom = await getDomain(env.DB, row.project_id);
  const custom = domainActive(dom) && dom.sender_email;
  const fromMail = custom ? dom.sender_email : DEFAULT_FROM;
  const fromName = custom && dom.sender_name ? dom.sender_name : 'Clincoo Mail';
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
    if (action === 'history') {
      return json({ used: used, limit: QUOTA_LIMIT, items: await historyLog(env.DB, projectId, 100) });
    }
    await ensureOwnerEmail(env, row);
    return json(configPayload(row, used, await historyLog(env.DB, projectId, 10), await getDomain(env.DB, projectId)));
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
    if (used >= QUOTA_LIMIT) return json({ error: 'Kuota bulanan habis' }, 429);
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
    return json(configPayload(row, await quotaUsed(env.DB, projectId), [], await getDomain(env.DB, projectId)));
  }

  // ---- Domain kustom ----
  if (action === 'add_domain') {
    const row = await getRow(env.DB, projectId);
    if (!row || !row.active) return json({ error: 'Aktifkan email dulu' }, 400);
    const dom = String(body.domain || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '');
    if (!validDomain(dom)) return json({ error: 'Format domain tidak valid' }, 400);
    if (BANNED_EMAIL_DOMAINS.some(function (b) { return dom === b || dom.endsWith('.' + b); })) {
      return json({ error: 'Domain resmi Clincoo tidak bisa dipakai' }, 400);
    }
    const token = genToken();
    await env.DB.prepare(`INSERT INTO email_domains (project_id, domain, verify_token, status, updated_at)
      VALUES (?, ?, ?, 'pending', datetime('now'))
      ON CONFLICT(project_id) DO UPDATE SET domain = excluded.domain, verify_token = excluded.verify_token,
        status = 'pending', sender_email = '', sender_name = '', updated_at = datetime('now')`)
      .bind(projectId, dom, token).run();
    return json({ ok: true, domain: domainPayload(await getDomain(env.DB, projectId)) });
  }

  if (action === 'check_domain') {
    const dom = await getDomain(env.DB, projectId);
    if (!dom || !dom.domain) return json({ error: 'Belum ada domain terdaftar' }, 400);
    if (dom.status === 'verified') return json({ verified: true, domain: domainPayload(dom) });
    const txts = await dnsTxtLookup('_clincoo-verify.' + dom.domain);
    if (txts.some(function (t) { return t.indexOf(dom.verify_token) !== -1; })) {
      await env.DB.prepare("UPDATE email_domains SET status = 'verified', updated_at = datetime('now') WHERE project_id = ?").bind(projectId).run();
      return json({ verified: true, domain: domainPayload(await getDomain(env.DB, projectId)) });
    }
    return json({ verified: false, found: txts.length, domain: domainPayload(dom) });
  }

  if (action === 'set_domain_sender') {
    const dom = await getDomain(env.DB, projectId);
    if (!dom || dom.status !== 'verified') return json({ error: 'Verifikasi domain dulu' }, 400);
    const name = senderNameAllowed(body.sender_name);
    if (!name.ok) return json({ error: name.reason }, 400);
    const local = String(body.local || '').trim().toLowerCase();
    if (!local) {
      // kosong = kembali ke pengirim default
      await env.DB.prepare("UPDATE email_domains SET sender_email = '', sender_name = '', updated_at = datetime('now') WHERE project_id = ?").bind(projectId).run();
      return json({ ok: true, sender_email: '' });
    }
    if (!/^[a-z0-9]([a-z0-9._+-]{0,62}[a-z0-9])?$/.test(local)) return json({ error: 'Nama alamat tidak valid' }, 400);
    const email = local + '@' + dom.domain;
    await env.DB.prepare("UPDATE email_domains SET sender_email = ?, sender_name = ?, updated_at = datetime('now') WHERE project_id = ?")
      .bind(email, name.name, projectId).run();
    return json({ ok: true, sender_email: email, sender_name: name.name });
  }

  if (action === 'delete_domain') {
    await env.DB.prepare('DELETE FROM email_domains WHERE project_id = ?').bind(projectId).run();
    return json({ ok: true });
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
