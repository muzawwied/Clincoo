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

import { guardProject } from '../user-scope.js';

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
    status TEXT DEFAULT 'pending',
    note TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )`).run();
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_pay_wd_project ON pay_withdrawals(project_id)`).run();
}

function randKey(n) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  for (let i = 0; i < n; i++) s += chars[bytes[i] % chars.length];
  return s;
}

function genOrderId() {
  return 'clincoo' + Date.now().toString(36) + randKey(9);
}

// ---- Saldo: total masuk (paid) - penarikan (pending + done) ----
async function calcBalance(db, projectId) {
  const paid = await db.prepare(`SELECT COALESCE(SUM(amount),0) AS total FROM pay_transactions WHERE project_id = ? AND status = 'paid'`).bind(projectId).first();
  const wd = await db.prepare(`SELECT COALESCE(SUM(amount),0) AS total FROM pay_withdrawals WHERE project_id = ? AND status != 'rejected'`).bind(projectId).first();
  const totalPaid = (paid && paid.total) || 0;
  const totalWithdrawn = (wd && wd.total) || 0;
  return { total_paid: totalPaid, total_withdrawn: totalWithdrawn, available: Math.max(0, totalPaid - totalWithdrawn) };
}


// ---- GET ----
export async function onRequestGet({ request, env }) {
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
  if (action === 'withdraw') {
    const deny = await guardPay(env, request, projectId);
    if (deny) return deny;
    const amount = Math.floor(Number(body.amount || 0));
    if (!amount || amount < 10000) return json({ success: false, message: 'Penarikan minimal Rp 10.000.' }, 400);
    const bal = await calcBalance(db, projectId);
    if (amount > bal.available) return json({ success: false, message: 'Saldo tersedia tidak cukup.' }, 400);
    await db.prepare(`INSERT INTO pay_withdrawals (project_id, amount, status) VALUES (?, ?, 'pending')`).bind(projectId, amount).run();
    return json({ success: true, message: 'Permintaan penarikan dikirim — tim Clincoo akan memprosesnya.' });
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
    const rows = await db.prepare('SELECT id, amount, status, note, created_at FROM pay_withdrawals WHERE project_id = ? ORDER BY id DESC LIMIT 25').bind(projectId).all();
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
