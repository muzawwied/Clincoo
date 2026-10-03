// Pembayaran — Clincoo sebagai payment gateway.
// Clincoo menerbitkan kredensial ClincooPay sendiri per proyek (account_id + secret + pay_key).
// Saat pembeli membayar, Clincoo-lah yang memanggil provider QRIS (Pakasir API v2) di belakang layar
// memakai kredensial gateway (env: PAKASIR_SLUG, PAKASIR_API_KEY).
// User TIDAK pernah tahu/memasukkan kredensial provider.
//
// Webhook masuk dari Pakasir ditangani functions/api/pay/webhook.js.
//
// POST {action:'activate', project_id}                    → aktifkan + terbitkan kredensial  [auth]
// GET  ?action=config&project_id=...                      → status, pay key, saldo            [auth]
// POST {action:'withdraw', project_id, amount}            → permintaan tarik saldo            [auth]
// POST {action:'transactions', project_id}               → log transaksi                    [auth]
// POST {action:'withdrawals', project_id}                → log penarikan                    [auth]
// POST {action:'create', key, amount, description}       → buat transaksi QRIS              [publik via pay_key]
// GET  ?action=status&key=...&order_id=...               → cek status transaksi              [publik via pay_key]
// POST {action:'callback', ...}                          → notifikasi dari provider → forward ke webhook proyek [callback secret]

import { guardProject, currentUser } from '../user-scope.js';
import { getSecret } from '../notify-helpers.js';

// Semua aksi ClincooPay wajib login + project_id — tidak ada jalur legacy global.
async function guardPay(env, request, projectId) {
  if (!projectId) return json({ error: 'unauthorized', need_login: true }, 401);
  return await guardProject(env, request, projectId);
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

const PAKASIR_API = 'https://app.pakasir.com';
// throttle cek status: Pakasir membatasi 4 detik per transaksi
const PKS_THROTTLE = new Map();

function gatewayReady(env) { return !!(env.PAKASIR_SLUG && env.PAKASIR_API_KEY); }

async function pakasirFetch(env, path, init) {
  try {
    const r = await fetch(PAKASIR_API + path, {
      ...init,
      headers: { 'X-Api-Key': env.PAKASIR_API_KEY, ...((init && init.headers) || {}) }
    });
    const text = await r.text();
    try { return JSON.parse(text); } catch (e) { return { error: 'invalid_response', message: 'Respon tidak valid dari server pembayaran' }; }
  } catch (e) { return { error: 'network', message: 'Tidak dapat terhubung ke server pembayaran' }; }
}

function qrImageUrl(qrString) {
  return qrString ? 'https://api.qrserver.com/v1/create-qr-code/?size=320x320&margin=12&data=' + encodeURIComponent(qrString) : '';
}

function mapPksStatus(st) {
  st = String(st || '').toLowerCase();
  if (st === 'completed') return 'paid';
  if (st === 'canceled' || st === 'cancelled' || st === 'expired') return 'expired';
  return 'pending';
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...CORS } });
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

async function ensureTables(db) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS pay_creds (
    project_id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    secret TEXT NOT NULL,
    pay_key TEXT NOT NULL,
    qris_method TEXT DEFAULT 'qris_two',
    fee_target TEXT DEFAULT 'merchant',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )`).run();
  await db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_pay_creds_key ON pay_creds(pay_key)`).run();
  // ---- Migrasi skema lama (era BuatQris: secret_token/umkm_name, tanpa kolom secret) ----
  try {
    await db.prepare('SELECT secret FROM pay_creds LIMIT 1').first();
  } catch (e) {
    // skema lama: pindahkan isi, buang kolom usang
    await db.prepare('DROP INDEX IF EXISTS idx_pay_creds_key').run();
    await db.prepare('DROP INDEX IF EXISTS idx_pay_creds_account').run();
    await db.prepare('ALTER TABLE pay_creds RENAME TO pay_creds_old').run();
    await db.prepare(`CREATE TABLE pay_creds (
      project_id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      secret TEXT NOT NULL,
      pay_key TEXT NOT NULL,
      qris_method TEXT DEFAULT 'qris_two',
      fee_target TEXT DEFAULT 'merchant',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )`).run();
    await db.prepare(`INSERT OR IGNORE INTO pay_creds (project_id, account_id, secret, pay_key, qris_method, fee_target, created_at, updated_at)
      SELECT project_id, account_id, COALESCE(secret_token, ''), pay_key, COALESCE(qris_method, 'qris_two'), COALESCE(fee_target, 'merchant'), created_at, updated_at FROM pay_creds_old`).run();
    await db.prepare('DROP TABLE pay_creds_old').run();
  }
  await db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_pay_creds_account ON pay_creds(account_id)`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS pay_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL,
    pay_key TEXT NOT NULL,
    order_id TEXT NOT NULL,
    trx_ref TEXT DEFAULT '',
    amount INTEGER NOT NULL,
    description TEXT DEFAULT '',
    status TEXT DEFAULT 'pending',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )`).run();
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_pay_tx_order ON pay_transactions(pay_key, order_id)`).run();
  // Migrasi kolom tambahan untuk halaman checkout hosted (/pay/) — idempotent
  try { await db.prepare("ALTER TABLE pay_transactions ADD COLUMN qr_string TEXT DEFAULT ''").run(); } catch (e) {}
  try { await db.prepare('ALTER TABLE pay_transactions ADD COLUMN total_payment INTEGER').run(); } catch (e) {}
  await db.prepare(`CREATE TABLE IF NOT EXISTS pay_withdrawals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL,
    amount INTEGER NOT NULL,
    fee INTEGER DEFAULT 0,
    dest_type TEXT DEFAULT '',
    dest_account TEXT DEFAULT '',
    status TEXT DEFAULT 'pending',
    note TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )`).run();
  // migrasi tabel produksi lama (kolom baru)
  for (const col of ["fee INTEGER DEFAULT 0", "dest_type TEXT DEFAULT ''", "dest_account TEXT DEFAULT ''"]) {
    try { await db.prepare('ALTER TABLE pay_withdrawals ADD COLUMN ' + col).run(); } catch (e) {}
  }
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_pay_wd_project ON pay_withdrawals(project_id)`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS pay_wd_dests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    ew_type TEXT NOT NULL,
    account TEXT NOT NULL,
    label TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS pay_wd_otp (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    project_id TEXT NOT NULL,
    amount INTEGER NOT NULL,
    dest_type TEXT NOT NULL,
    dest_account TEXT NOT NULL,
    code TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    attempts INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL
  )`).run();
}

function randKey(n) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  for (let i = 0; i < n; i++) s += chars[bytes[i] % chars.length];
  return s;
}

function genOrderId() {
  return 'clincoo' + randKey(17);
}

// ---- Saldo: total masuk (paid) - penarikan (pending + done) ----
// ---- Tarik saldo: fee, e-wallet, tanda tangan digital, email notifikasi ----
const WD_EWALLETS = ['dana', 'ovo', 'gopay', 'shopeepay', 'linkaja'];
const WD_EWALLET_LABEL = { dana: 'DANA', ovo: 'OVO', gopay: 'GoPay', shopeepay: 'ShopeePay', linkaja: 'LinkAja' };

async function wdFee(env) {
  const v = await getSecret(env, 'WITHDRAW_FEE');
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 2500;
}

function wdCanonical(w) {
  return ['wd', String(w.id), w.project_id, String(w.amount), String(w.fee || 0), w.dest_type, w.dest_account, w.created_at].join('|');
}

async function wdSign(env, w) {
  const secret = env.PAY_CALLBACK_SECRET || '';
  if (!secret) return '';
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(wdCanonical(w)));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function wdText(w, sig, verifyUrl) {
  return [
    'Permintaan penarikan dana baru dari Clincoo.',
    '',
    'ID: wd-' + w.id,
    'Proyek: ' + (w.project_title || w.project_id),
    'Pemilik proyek: ' + (w.owner_email || '-'),
    '',
    'Nominal: Rp ' + Number(w.amount).toLocaleString('id-ID'),
    'Biaya penarikan: Rp ' + Number(w.fee || 0).toLocaleString('id-ID'),
    'Total potong saldo: Rp ' + (Number(w.amount) + Number(w.fee || 0)).toLocaleString('id-ID'),
    'Diterima pemilik: Rp ' + Number(w.amount).toLocaleString('id-ID'),
    'Tujuan: ' + (WD_EWALLET_LABEL[w.dest_type] || w.dest_type) + ' - ' + w.dest_account,
    'Metode: e-wallet',
    'Waktu (server): ' + w.created_at + ' UTC',
    '',
    'Permintaan ini dibuat otomatis oleh server Clincoo dan bertanda tangan digital.',
    'Jangan proses penarikan tanpa verifikasi tanda tangan berikut.',
    '',
    'Tanda tangan (HMAC-SHA256): ' + (sig || 'TIDAK TERKONFIGURASI (set PAY_CALLBACK_SECRET)'),
    '',
    'Verifikasi cepat:',
    verifyUrl
  ].join('\n');
}

async function sendWithdrawEmail(env, w, sig, verifyUrl) {
  const url = await getSecret(env, 'MAIL_BRIDGE_URL');
  const bridgeKey = await getSecret(env, 'MAIL_BRIDGE_KEY');
  const to = await getSecret(env, 'WITHDRAW_NOTIFY_EMAIL');
  if (!url || !bridgeKey || !to) return { sent: false, reason: 'bridge atau tujuan belum dikonfigurasi' };
  const text = wdText(w, sig, verifyUrl);
  const html = text.split('&').join('&amp;').split('<').join('&lt;').split('>').join('&gt;').replace(/\n/g, '<br>');
  try {
    const r = await fetch(String(url).replace(/\/$/, '') + '/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Bridge-Key': String(bridgeKey) },
      body: JSON.stringify({
        to,
        from_email: 'noreply@clincoo.buzz',
        from_name: 'Clincoo Pembayaran',
        subject: '[Permintaan Penarikan] Rp ' + Number(w.amount).toLocaleString('id-ID') + ' - ' + (WD_EWALLET_LABEL[w.dest_type] || w.dest_type) + ' ' + w.dest_account + ' - ' + (w.project_title || w.project_id),
        html,
        text,
        ...(w.owner_email ? { reply_to: w.owner_email } : {})
      })
    });
    const data = await r.json().catch(() => ({}));
    return (r.ok && data.ok) ? { sent: true } : { sent: false, reason: data.error || ('HTTP ' + r.status) };
  } catch (e) {
    return { sent: false, reason: String((e && e.message) || e) };
  }
}

async function sendOtpEmail(env, toEmail, code, amount, dest) {
  const url = await getSecret(env, 'MAIL_BRIDGE_URL');
  const bridgeKey = await getSecret(env, 'MAIL_BRIDGE_KEY');
  if (!url || !bridgeKey || !toEmail) return false;
  const text = [
    'Kode verifikasi penarikan Clincoo',
    '',
    'Kode OTP: ' + code,
    'Nominal: Rp ' + Number(amount).toLocaleString('id-ID'),
    'Tujuan: ' + (WD_EWALLET_LABEL[dest.dest_type] || dest.dest_type) + ' - ' + dest.dest_account,
    '',
    'Kode berlaku 10 menit. JANGAN bagikan kode ini ke siapa pun.',
    'Jika kamu tidak meminta penarikan ini, abaikan email ini.'
  ].join('\n');
  const html = text.split('&').join('&amp;').split('<').join('&lt;').split('>').join('&gt;').replace(/\n/g, '<br>');
  try {
    const r = await fetch(String(url).replace(/\/$/, '') + '/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Bridge-Key': String(bridgeKey) },
      body: JSON.stringify({ to: toEmail, from_email: 'noreply@clincoo.buzz', from_name: 'Clincoo Pembayaran', subject: 'Kode OTP penarikan: ' + code, html, text })
    });
    const data = await r.json().catch(() => ({}));
    return r.ok && data.ok;
  } catch (e) { return false; }
}

async function calcBalance(db, projectId) {
  const paid = await db.prepare(`SELECT COALESCE(SUM(amount),0) AS total FROM pay_transactions WHERE project_id = ? AND status = 'paid'`).bind(projectId).first();
  const wd = await db.prepare(`SELECT COALESCE(SUM(amount + COALESCE(fee, 0)), 0) AS total FROM pay_withdrawals WHERE project_id = ? AND status != 'rejected'`).bind(projectId).first();
  const totalPaid = (paid && paid.total) || 0;
  const totalWithdrawn = (wd && wd.total) || 0;
  return { total_paid: totalPaid, total_withdrawn: totalWithdrawn, available: Math.max(0, totalPaid - totalWithdrawn) };
}


// ---- GET ----
export async function onRequestGet({ request, env }) {
  // verifikasi tanda tangan permintaan penarikan dari email (publik, gerbang = sig HMAC)
  {
    const u = new URL(request.url);
    if (u.searchParams.get('action') === 'withdraw_verify') {
      const id = Number(u.searchParams.get('id') || 0);
      const sig = String(u.searchParams.get('sig') || '');
      const row = id > 0 ? await env.DB.prepare('SELECT * FROM pay_withdrawals WHERE id = ?').bind(id).first() : null;
      if (!row) return json({ valid: false, message: 'Permintaan tidak ditemukan.' }, 404);
      const expect = await wdSign(env, row);
      const ok = !!expect && expect === sig.toLowerCase();
      return json({ valid: ok, message: ok ? 'Tanda tangan cocok — permintaan asli dari server Clincoo.' : 'Tanda tangan TIDAK cocok — jangan proses penarikan ini.', withdrawal: { id: row.id, project_id: row.project_id, amount: row.amount, fee: row.fee, dest_type: row.dest_type, dest_account: row.dest_account, status: row.status, created_at: row.created_at } });
    }
  }
  const db = env.DB;
  if (!db) return json({ error: 'D1 not bound' }, 500);
  await ensureTables(db);
  const url = new URL(request.url);
  const action = url.searchParams.get('action') || '';
  const projectId = url.searchParams.get('project_id') || '';

  if (action === 'config') {
    const deny = await guardPay(env, request, projectId);
    if (deny) return deny;
    const row = await db.prepare('SELECT * FROM pay_creds WHERE project_id = ?').bind(projectId).first();
    const bal = await calcBalance(db, projectId);
    if (!row) return json({ success: true, active: false, gateway_ready: gatewayReady(env), ...bal });
    return json({
      success: true,
      active: true,
      gateway_ready: gatewayReady(env),
      account_id: row.account_id,
      pay_key: row.pay_key,
      ...bal
    });
  }

  if (action === 'status') {
    const key = url.searchParams.get('key') || '';
    const orderId = url.searchParams.get('order_id') || '';
    if (!key || !orderId) return json({ error: 'key dan order_id wajib diisi' }, 400);
    const tx = await db.prepare('SELECT * FROM pay_transactions WHERE pay_key = ? AND order_id = ?').bind(key, orderId).first();
    if (!tx) return json({ error: 'transaksi tidak ditemukan' }, 404);
    const det = {
      order_id: tx.order_id, description: tx.description || '',
      qr_image: qrImageUrl(tx.qr_string || ''),
      total_payment: (tx.total_payment != null ? tx.total_payment : tx.amount),
      created_at: tx.created_at || ''
    };
    if (tx.status === 'paid') return json({ success: true, status: 'paid', amount: tx.amount, ...det });
    if (!tx.trx_ref) return json({ success: true, status: tx.status, amount: tx.amount, ...det });
    // hormati rate limit Pakasir: 4 detik per transaksi
    const last = PKS_THROTTLE.get(tx.id) || 0;
    if (Date.now() - last < 4000) return json({ success: true, status: tx.status, amount: tx.amount, ...det });
    PKS_THROTTLE.set(tx.id, Date.now());
    const d = await pakasirFetch(env, '/api/v2/transaction-status/' + encodeURIComponent(env.PAKASIR_SLUG) + '/' + encodeURIComponent(tx.trx_ref), { method: 'GET' });
    if (d.error) return json({ success: true, status: tx.status, amount: tx.amount, message: d.message || '', ...det });
    const st = mapPksStatus(d.status);
    if (st !== tx.status) {
      await db.prepare('UPDATE pay_transactions SET status = ?, updated_at = datetime(\'now\') WHERE id = ?').bind(st, tx.id).run();
    }
    return json({ success: true, status: st, amount: tx.amount, message: d.message || '', ...det });
  }

  return json({ error: 'action tidak dikenal' }, 400);
}

// ---- POST ----
export async function onRequestPost({ request, env }) {
  const db = env.DB;
  if (!db) return json({ error: 'D1 not bound' }, 500);
  await ensureTables(db);

  let body = {};
  try { body = await request.json(); } catch (e) { return json({ error: 'body JSON tidak valid' }, 400); }
  const action = body.action || '';
  const projectId = body.project_id || '';

  // ===== Aktifkan ClincooPay + terbitkan kredensial (auth) =====
  if (action === 'activate') {
    const deny = await guardPay(env, request, projectId);
    if (deny) return deny;
    const existing = await db.prepare('SELECT * FROM pay_creds WHERE project_id = ?').bind(projectId).first();
    if (existing) return json({ success: true, account_id: existing.account_id, pay_key: existing.pay_key });
    let accountId, secret, payKey;
    for (let i = 0; i < 5; i++) {
      accountId = 'CP' + randKey(10).toUpperCase();
      secret = 'clc_pay_ss_' + randKey(32);
      payKey = 'clc_pay_' + randKey(28);
      try {
        await db.prepare(`INSERT INTO pay_creds (project_id, account_id, secret, pay_key) VALUES (?, ?, ?, ?)`)
          .bind(projectId, accountId, secret, payKey).run();
        return json({ success: true, account_id: accountId, pay_key: payKey });
      } catch (e) { /* unik bentrok — ulangi */ }
    }
    return json({ error: 'Gagal menerbitkan kredensial, coba lagi.' }, 500);
  }

  // ===== Saldo ringkas (auth) =====
  if (action === 'summary') {
    const deny = await guardPay(env, request, projectId);
    if (deny) return deny;
    const bal = await calcBalance(db, projectId);
    return json({ success: true, ...bal, gateway_ready: gatewayReady(env) });
  }

  // ===== Tarik saldo → permintaan penarikan (auth) =====
  // ===== Tujuan penarikan tersimpan (CRUD e-wallet, per-akun) =====
  if (action === 'wd_dests') {
    const user = await currentUser(env, request);
    if (!user) return json({ success: false, message: 'Login diperlukan.' }, 401);
    const rows = await db.prepare('SELECT id, ew_type, account, label, created_at FROM pay_wd_dests WHERE user_id = ? ORDER BY id DESC').bind(user.id).all();
    return json({ success: true, destinations: rows.results || [] });
  }
  if (action === 'wd_dest_add') {
    const user = await currentUser(env, request);
    if (!user) return json({ success: false, message: 'Login diperlukan.' }, 401);
    const ew = String(body.ew_type || '').toLowerCase();
    const acc = String(body.account || '').replace(/[\s-]/g, '');
    const label = String(body.label || '').slice(0, 40);
    if (WD_EWALLETS.indexOf(ew) === -1) return json({ success: false, message: 'Pilih jenis e-wallet.' }, 400);
    if (!/^(?:0|62)8\d{7,12}$/.test(acc)) return json({ success: false, message: 'Nomor e-wallet tidak valid (contoh: 08123456789).' }, 400);
    await db.prepare('INSERT INTO pay_wd_dests (user_id, ew_type, account, label) VALUES (?, ?, ?, ?)').bind(user.id, ew, acc.replace(/^62/, '0'), label).run();
    return json({ success: true, message: 'Tujuan tersimpan.' });
  }
  if (action === 'wd_dest_update') {
    const user = await currentUser(env, request);
    if (!user) return json({ success: false, message: 'Login diperlukan.' }, 401);
    const id = Number(body.id || 0);
    const ew = String(body.ew_type || '').toLowerCase();
    const acc = String(body.account || '').replace(/[\s-]/g, '');
    const label = String(body.label || '').slice(0, 40);
    if (!id) return json({ success: false, message: 'Tujuan tidak ditemukan.' }, 404);
    if (WD_EWALLETS.indexOf(ew) === -1) return json({ success: false, message: 'Pilih jenis e-wallet.' }, 400);
    if (!/^(?:0|62)8\d{7,12}$/.test(acc)) return json({ success: false, message: 'Nomor e-wallet tidak valid (contoh: 08123456789).' }, 400);
    return (r.meta && r.meta.changes) ? json({ success: true, message: 'Tujuan diperbarui.' }) : json({ success: false, message: 'Tujuan tidak ditemukan.' }, 404);
  }
  if (action === 'wd_dest_delete') {
    const user = await currentUser(env, request);
    if (!user) return json({ success: false, message: 'Login diperlukan.' }, 401);
    const id = Number(body.id || 0);
    if (!id) return json({ success: false, message: 'Tujuan tidak ditemukan.' }, 404);
    const r = await db.prepare('DELETE FROM pay_wd_dests WHERE id = ? AND user_id = ?').bind(id, user.id).run();
    return (r.meta && r.meta.changes) ? json({ success: true, message: 'Tujuan dihapus.' }) : json({ success: false, message: 'Tujuan tidak ditemukan.' }, 404);
  }

  // ===== Kirim OTP penarikan ke email pemilik proyek =====
  if (action === 'withdraw_otp') {
    const deny = await guardPay(env, request, projectId);
    if (deny) return deny;
    const amount = Math.floor(Number(body.amount || 0));
    const destType = String(body.dest_type || '').toLowerCase();
    const destAccount = String(body.dest_account || '').replace(/[\s-]/g, '');
    if (!amount || amount < 10000) return json({ success: false, message: 'Penarikan minimal Rp 10.000.' }, 400);
    if (WD_EWALLETS.indexOf(destType) === -1) return json({ success: false, message: 'Pilih tujuan e-wallet.' }, 400);
    if (!/^(?:0|62)8\d{7,12}$/.test(destAccount)) return json({ success: false, message: 'Nomor e-wallet tidak valid.' }, 400);
    const acc = destAccount.replace(/^62/, '0');
    const fee = await wdFee(env);
    const bal = await calcBalance(db, projectId);
    if (amount + fee > bal.available) return json({ success: false, message: 'Saldo tersedia tidak cukup.' }, 400);
    // kirim OTP ke email pemilik proyek
    const own = await db.prepare('SELECT a.email FROM auth_users a JOIN user_projects p ON p.user_id = a.id WHERE p.id = ?').bind(projectId).first();
    if (!own || !own.email) return json({ success: false, message: 'Email pemilik proyek tidak ditemukan.' }, 400);
    const digits = new Uint8Array(6);
    crypto.getRandomValues(digits);
    const code = [...digits].map(d => String(d % 10)).join('');
    const r = await db.prepare(`INSERT INTO pay_wd_otp (user_id, project_id, amount, dest_type, dest_account, code, expires_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+10 minutes')) RETURNING id`).bind(
      (await currentUser(env, request)).id, projectId, amount, destType, acc, code
    ).first();
    const sent = await sendOtpEmail(env, own.email, code, amount, { dest_type: destType, dest_account: acc });
    if (!sent) return json({ success: false, message: 'Gagal mengirim OTP — coba lagi.' }, 500);
    const mask = own.email.replace(/^(.).*(@.*)$/, '$1*****$2');
    return json({ success: true, otp_id: r.id, expires_in: 600, sent_to: mask, message: 'Kode OTP dikirim ke ' + mask });
  }

  if (action === 'withdraw') {
    const deny = await guardPay(env, request, projectId);
    if (deny) return deny;
    const user = await currentUser(env, request);
    // ===== verifikasi OTP dulu =====
    const otpId = Number(body.otp_id || 0);
    const otpCode = String(body.otp_code || '').replace(/\D/g, '');
    if (!otpId || otpCode.length !== 6) return json({ success: false, message: 'Masukkan kode OTP dari email.' }, 400);
    const otp = otpId > 0 ? await db.prepare('SELECT * FROM pay_wd_otp WHERE id = ?').bind(otpId).first() : null;
    if (!otp || otp.user_id !== user.id || otp.project_id !== projectId) return json({ success: false, message: 'Kode OTP tidak dikenal — mulai ulang penarikan.' }, 400);
    if (otp.status !== 'pending') return json({ success: false, message: 'Kode OTP sudah dipakai — minta kode baru.' }, 400);
    if (otp.attempts >= 5) { await db.prepare(`UPDATE pay_wd_otp SET status = 'failed' WHERE id = ?`).bind(otpId).run(); return json({ success: false, message: 'Terlalu banyak percobaan — minta kode baru.' }, 400); }
    const nowRow = await db.prepare(`SELECT (datetime('now') > expires_at) AS exp FROM pay_wd_otp WHERE id = ?`).bind(otpId).first();
    if (nowRow && nowRow.exp) { await db.prepare(`UPDATE pay_wd_otp SET status = 'failed' WHERE id = ?`).bind(otpId).run(); return json({ success: false, message: 'Kode OTP kedaluwarsa — minta kode baru.' }, 400); }
    if (otp.code !== otpCode) {
      await db.prepare('UPDATE pay_wd_otp SET attempts = attempts + 1 WHERE id = ?').bind(otpId).run();
      const left = 5 - (otp.attempts + 1);
      return json({ success: false, message: 'Kode OTP salah' + (left > 0 ? ' — sisa percobaan: ' + left : ' — minta kode baru.') + '.' }, 400);
    }
    await db.prepare(`UPDATE pay_wd_otp SET status = 'used' WHERE id = ?`).bind(otpId).run();
    // data dari baris OTP = sumber kebenaran
    const amount = otp.amount;
    const destType = otp.dest_type;
    const acc = otp.dest_account;
    const fee = await wdFee(env);
    const bal = await calcBalance(db, projectId);
    if (amount + fee > bal.available) return json({ success: false, message: 'Saldo tersedia tidak cukup (nominal + biaya ' + (amount + fee).toLocaleString('id-ID') + ' > saldo ' + bal.available.toLocaleString('id-ID') + ').' }, 400);
    const row = await db.prepare(`INSERT INTO pay_withdrawals (project_id, amount, fee, dest_type, dest_account, status) VALUES (?, ?, ?, ?, ?, 'pending') RETURNING *`).bind(projectId, amount, fee, destType, acc).first();
    const proj = await db.prepare('SELECT title FROM user_projects WHERE id = ?').bind(projectId).first();
    const own = await db.prepare('SELECT a.email FROM auth_users a JOIN user_projects p ON p.user_id = a.id WHERE p.id = ?').bind(projectId).first();
    const w = { ...row, project_title: (proj && proj.title) || projectId, owner_email: (own && own.email) || '' };
    const sig = await wdSign(env, w);
    const verifyUrl = 'https://app.clincoo.buzz/api/pay?action=withdraw_verify&id=' + row.id + '&sig=' + encodeURIComponent(sig);
    const mail = await sendWithdrawEmail(env, w, sig, verifyUrl);
    return json({ success: true, id: row.id, fee: fee, deducted: amount + fee, sig: sig, email_sent: !!mail.sent, message: 'Permintaan penarikan dikirim — tim Clincoo akan memprosesnya.' + (mail.sent ? '' : ' (email notifikasi gagal dikirim, cek log)') });
  }

  // ===== Log transaksi (auth) =====
  if (action === 'transactions') {
    const deny = await guardPay(env, request, projectId);
    if (deny) return deny;
    const rows = await db.prepare('SELECT order_id, amount, description, status, created_at FROM pay_transactions WHERE project_id = ? ORDER BY id DESC LIMIT 25').bind(projectId).all();
    return json({ success: true, transactions: rows.results || [] });
  }

  // ===== Log penarikan (auth) =====
  if (action === 'withdrawals') {
    const deny = await guardPay(env, request, projectId);
    if (deny) return deny;
    const rows = await db.prepare('SELECT id, amount, fee, dest_type, dest_account, status, note, created_at FROM pay_withdrawals WHERE project_id = ? ORDER BY id DESC LIMIT 25').bind(projectId).all();
    return json({ success: true, withdrawals: rows.results || [] });
  }

  // ===== Buat transaksi (PUBLIK via pay_key — dipanggil situs deploy user) =====
  if (action === 'create') {
    const key = String(body.key || '').trim();
    const amount = Math.floor(Number(body.amount || 0));
    const description = String(body.description || '').slice(0, 100);
    if (!key) return json({ error: 'pay key wajib diisi' }, 400);
    if (!amount || amount < 1000 || amount > 100000000) return json({ error: 'Nominal harus Rp 1.000 – Rp 100.000.000' }, 400);
    const creds = await db.prepare('SELECT * FROM pay_creds WHERE pay_key = ?').bind(key).first();
    if (!creds) return json({ error: 'pay key tidak dikenal' }, 404);
    if (!gatewayReady(env)) {
      return json({ success: false, error: 'gateway_not_ready', message: 'Pembayaran QRIS ClincooPay sedang dalam proses aktivasi. Hubungi tim Clincoo.' }, 503);
    }

    const orderId = genOrderId();
    const txn = await pakasirFetch(env,
      '/api/v2/create-transaction/' + encodeURIComponent(env.PAKASIR_SLUG) + '/' + encodeURIComponent(orderId),
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method: 'qris', amount: amount }) });
    const ok = txn && txn.txn_id;
    await db.prepare('INSERT INTO pay_transactions (project_id, pay_key, order_id, trx_ref, amount, description, status, qr_string, total_payment) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(creds.project_id, key, orderId, ok ? txn.txn_id : '', amount, description, ok ? 'pending' : 'failed', txn.qr_string || '', txn.total_payment || amount).run();
    if (!ok) {
      return json({ success: false, message: (txn && (txn.message || txn.error)) || 'Gagal membuat QRIS ClincooPay.' }, 502);
    }
    const origin = new URL(request.url).origin;
    return json({
      success: true,
      order_id: orderId,
      checkout_url: origin + '/pay/?order_id=' + encodeURIComponent(orderId) + '&key=' + encodeURIComponent(key),
      amount: amount,
      qr_image: qrImageUrl(txn.qr_string),
      qr_string: txn.qr_string || '',
      va_number: txn.va_number || '',
      payment_url: txn.payment_link || '',
      total_payment: txn.total_payment || amount,
      expires_at: txn.expired_at || '',
      is_sandbox: !!txn.is_sandbox
    });
  }

  // ===== Callback dari provider → perbarui status + forward ke webhook proyek =====
  if (action === 'callback') {
    if (env.PAY_CALLBACK_SECRET) {
      const tok = request.headers.get('X-Callback-Token') || body.callback_token || '';
      if (tok !== env.PAY_CALLBACK_SECRET) return json({ error: 'unauthorized' }, 401);
    }
    const ref = String(body.order_id || body.txn_id || body.trx_id || body.transaction_id || body.invoice || body.reference || '').trim();
    if (!ref) return json({ error: 'order_id/trx_id wajib diisi' }, 400);
    let tx = await db.prepare('SELECT * FROM pay_transactions WHERE trx_ref = ?').bind(ref).first();
    if (!tx) tx = await db.prepare('SELECT * FROM pay_transactions WHERE order_id = ?').bind(ref).first();
    if (!tx) return json({ error: 'transaksi tidak ditemukan' }, 404);
    const st = pickStatus(body);
    if (st !== tx.status) {
      await db.prepare('UPDATE pay_transactions SET status = ?, updated_at = datetime(\'now\') WHERE id = ?').bind(st, tx.id).run();
    }
    await forwardPayWebhook(db, tx, st);
    return json({ success: true, status: st });
  }

  return json({ error: 'action tidak dikenal' }, 400);
}

// Forward notifikasi ke webhook pembayaran milik proyek (dipakai callback internal & webhook.js Pakasir)
export async function forwardPayWebhook(db, tx, st) {
  try {
    const row = await db.prepare(`SELECT value FROM project_settings WHERE project_id = ? AND key = 'webhook_settings'`).bind(tx.project_id).first();
    let url = '';
    if (row && row.value) { try { url = (JSON.parse(row.value) || {}).payWebhookUrl || ''; } catch (e) {} }
    if (url && st === 'paid') {
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event: 'payment.paid', order_id: tx.order_id, amount: tx.amount, description: tx.description, status: st, paid_at: new Date().toISOString() })
      }).catch(() => {});
    }
  } catch (e) {}
}

function pickStatus(d) {
  const s = (d.status || (d.data && d.data.status) || d.transaction_status || '').toLowerCase();
  if (['success', 'paid', 'berhasil', 'settlement', 'completed', 'lunas'].includes(s)) return 'paid';
  if (['expired', 'expire', 'gagal', 'failed', 'cancel', 'cancelled', 'canceled', 'batal'].includes(s)) return 'expired';
  return 'pending';
}
