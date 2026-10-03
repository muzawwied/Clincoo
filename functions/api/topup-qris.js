// Cloudflare Pages Functions - Top Up via QRIS BuatQris (api.buatqris.site)
// Flow: pilih QRIS -> create QRIS di BuatQris -> frontend tampilkan QR (image/qr_url)
//       -> bayar -> webhook bertanda tangan (X-BuatQris-Signature, HMAC-SHA256) -> saldo masuk D1
// Env (Cloudflare Pages vars atau tabel env_vars D1, global):
//   BUATQRIS_ACCOUNT_ID      (wajib) — dari dashboard BuatQris (Developer > Open API)
//   BUATQRIS_SECRET_TOKEN   (wajib) — secret token API
//   BUATQRIS_WEBHOOK_SECRET (opsional) — kunci tanda tangan webhook; jika kosong pakai secret_token
//   BUATQRIS_METHOD         (opsional) — metode qris: qris_one..qris_four, default 'qris_two'
// Callback URL (di dashboard BuatQris): https://<domain>/api/topup-qris
// Referensi order ditanam di `description` QRIS ("Clincoo clincoo-pay-xxx") sehingga
// webhook apa pun formatnya tetap bisa dicocokkan ke order — plus verifikasi HMAC.

import { currentUser } from './user-scope.js';
import { creditTopup } from './topup.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

export async function onRequestOptions() {
  return new Response(null, { headers: CORS });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...CORS } });
}

async function getSecret(env, key) {
  if (env[key]) return env[key];
  try {
    const row = await env.DB.prepare('SELECT value FROM env_vars WHERE key = ? AND (project_id IS NULL OR project_id = \'\')').bind(key).first();
    if (row?.value) return row.value;
  } catch {}
  return null;
}

const BQ_BASE = 'https://api.buatqris.site';
const BQ_ORDER_PREFIX = 'clincoo-pay-';

// Panggil API BuatQris (POST, form-urlencoded seperti contoh resmi mereka)
async function bqPost(params) {
  try {
    const res = await fetch(BQ_BASE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString()
    });
    return await res.json();
  } catch { return null; }
}

// Klaim order atomik: mencegah kredit ganda saat webhook datang berkali-kali
async function claimOrder(db, orderId) {
  const r = await db.prepare("UPDATE topup_orders SET status = 'paid' WHERE id = ? AND status = 'pending'").bind(orderId).run();
  return (r.meta?.changes || 0) > 0;
}

async function ensureTopupTable(db) {
  // Tabel topup_orders kini dibuat runtime (sebelumnya hanya ada di schema.sql —
  // produksi bisa kehilangan tabel ini dan INSERT QRIS gagal "no such table").
  await db.prepare(`CREATE TABLE IF NOT EXISTS topup_orders (
    id TEXT PRIMARY KEY,
    amount REAL NOT NULL,
    method TEXT,
    status TEXT DEFAULT 'pending',
    xendit_id TEXT,
    invoice_url TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    paid_at TEXT,
    user_id TEXT,
    qr_url TEXT,
    bill_total REAL,
    expires_at TEXT
  )`).run();
}

async function ensureQrisColumns(db) {
  // Kolom netral (provider-agnostic); migrasi dari kolom lama pakasir_* bila ada
  try { await db.prepare('ALTER TABLE topup_orders ADD COLUMN qr_url TEXT').run(); } catch (e) {}
  try { await db.prepare('ALTER TABLE topup_orders ADD COLUMN bill_total REAL').run(); } catch (e) {}
  try { await db.prepare('ALTER TABLE topup_orders ADD COLUMN expires_at TEXT').run(); } catch (e) {}
  try { await db.prepare('UPDATE topup_orders SET qr_url = pakasir_qr WHERE qr_url IS NULL AND pakasir_qr IS NOT NULL').run(); } catch (e) {}
  try { await db.prepare('UPDATE topup_orders SET bill_total = pakasir_total WHERE bill_total IS NULL AND pakasir_total IS NOT NULL').run(); } catch (e) {}
  try { await db.prepare('UPDATE topup_orders SET expires_at = pakasir_expired WHERE expires_at IS NULL AND pakasir_expired IS NOT NULL').run(); } catch (e) {}
  try { await db.prepare('ALTER TABLE topup_orders DROP COLUMN pakasir_qr').run(); } catch (e) {}
  try { await db.prepare('ALTER TABLE topup_orders DROP COLUMN pakasir_total').run(); } catch (e) {}
  try { await db.prepare('ALTER TABLE topup_orders DROP COLUMN pakasir_expired').run(); } catch (e) {}
}

// GET /api/topup-qris?action=ping           -> status konfigurasi (untuk UI)
// GET /api/topup-qris?action=history  -> riwayat order QRIS user yang login
// GET /api/topup-qris?action=status&order_id -> status order (webhook = sumber kebenaran)
export async function onRequestGet({ request, env }) {
  const db = env.DB;
  if (!db) return json({ error: 'D1 not bound' }, 500);
  const url = new URL(request.url);
  const action = url.searchParams.get('action');

  if (action === 'ping') {
    const accountId = await getSecret(env, 'BUATQRIS_ACCOUNT_ID');
    return json({ configured: !!(accountId && (await getSecret(env, 'BUATQRIS_SECRET_TOKEN'))), provider: 'buatqris' });
  }

  // Riwayat order QRIS user (halaman langganan: histori transaksi checkout)
  if (action === 'history') {
    const user = await currentUser(env, request);
    if (!user) return json({ success: false, need_login: true }, 401);
    let rows = [];
    try {
      const r = await db.prepare(
        "SELECT id, amount, method, status, bill_total, created_at, expires_at FROM topup_orders WHERE user_id = ? OR user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 25"
      ).bind(String(user.id), String(user.id) + '').all();
      rows = (r && r.results) || [];
    } catch (e) {}
    return json({ success: true, orders: rows.map(function (o) {
      return { order_id: o.id, amount: o.amount, method: 'QRIS', status: o.status, total: o.bill_total || o.amount, created_at: o.created_at, expires_at: o.expires_at || null };
    }) });
  }

  // Order terakhir milik user yang login (untuk restore halaman checkout dari email pengingat)
  if (action === 'pending') {
    const user = await currentUser(env, request);
    if (!user) return json({ success: false, need_login: true }, 401);
    let order = null;
    try {
      order = await db.prepare(
        "SELECT * FROM topup_orders WHERE (user_id = ? OR user_id = ?) AND datetime(created_at) >= datetime('now', '-48 hours') ORDER BY created_at DESC, rowid DESC LIMIT 1"
      ).bind(String(user.id), String(user.id) + '').first();
    } catch (e) {}
    if (!order) return json({ success: true, order: null });
    return json({
      success: true,
      order: {
        order_id: order.id,
        amount: order.amount,
        status: order.status,
        qr_image: order.qr_url || null,
        total_payment: order.bill_total || order.amount,
        expired_at: order.expires_at || null
      }
    });
  }

  if (action === 'status') {
    const orderId = url.searchParams.get('order_id');
    if (!orderId) return json({ error: 'order_id required' }, 400);
    let order = null;
    try { order = await db.prepare('SELECT * FROM topup_orders WHERE id = ?').bind(orderId).first(); } catch (e) {}
    if (!order) return json({ error: 'order not found' }, 404);
    return json({ success: true, order_id: order.id, status: order.status, amount: order.amount, credited: order.status === 'paid' });
  }

  return json({ error: 'unknown action' }, 400);
}

// POST /api/topup-qris
//  a) {action:'create', amount}                -> buat transaksi QRIS di BuatQris, simpan order pending
//  b) {action:'cancel', order_id}              -> batalkan order (D1)
//  c) Webhook BuatQris (event callback)         -> verifikasi HMAC -> kredit saldo
export async function onRequestPost({ request, env }) {
  const db = env.DB;
  if (!db) return json({ error: 'D1 not bound' }, 500);

  const rawBody = await request.text();
  let body = {};
  try { body = JSON.parse(rawBody || '{}'); } catch { body = {}; }

  // ---- Webhook BuatQris (event callback, tanpa action create/cancel) ----
  if (body.action !== 'create' && body.action !== 'cancel') {
    // Verifikasi tanda tangan HMAC-SHA256: X-BuatQris-Signature atas RAW body
    const secret = (await getSecret(env, 'BUATQRIS_WEBHOOK_SECRET')) || (await getSecret(env, 'BUATQRIS_SECRET_TOKEN'));
    if (!secret) return json({ received: false, error: 'not configured' }, 503);
    const sig = String(request.headers.get('x-buatqris-signature') || request.headers.get('x-buatqris-signature'.toUpperCase()) || '');
    if (!sig) return json({ received: false, error: 'signature missing' }, 401);
    let expected = '';
    try {
      // HMAC-SHA256 via WebCrypto standar (Workers mendukung crypto.subtle)
      const enc = new TextEncoder();
      const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      const sigBuf = await crypto.subtle.sign('HMAC', key, enc.encode(rawBody));
      expected = [...new Uint8Array(sigBuf)].map(b => b.toString(16).padStart(2, '0')).join('');
    } catch (e) {
      return json({ received: false, error: 'hmac error' }, 500);
    }
    const given = sig.replace(/^sha256=/i, '').toLowerCase();
    if (given !== expected) return json({ received: false, error: 'signature invalid' }, 401);

    // Cari referensi order kita (ditanam di description QRIS) di mana pun posisinya
    const raw = String(rawBody || '') + ' ' + JSON.stringify(body || {});
    const m = raw.match(new RegExp(BQ_ORDER_PREFIX + '[A-Za-z0-9-]+'));
    if (!m) return json({ received: true, matched: false });

    const orderId = m[0];
    let order = null;
    try { order = await db.prepare('SELECT * FROM topup_orders WHERE id = ?').bind(orderId).first(); } catch (e) {}
    if (!order) return json({ received: true, matched: false });

    // Deteksi status dari payload (nama field callback bervariasi — cocokkan fleksibel)
    const low = raw.toLowerCase();
    const negative = ['pending', 'expire', 'expired', 'failed', 'fail', 'gagal', 'cancel', 'cancelled', 'refund'];
    const positive = ['success', 'paid', 'berhasil', 'complete', 'completed', 'settlement'];
    const isNeg = negative.some(w => low.includes(w));
    const isPos = positive.some(w => low.includes(w));

    if (isPos && !isNeg && order.status === 'pending') {
      if (await claimOrder(db, order.id)) {
        const fresh = await db.prepare('SELECT * FROM topup_orders WHERE id = ?').bind(order.id).first();
        try { await creditTopup(env, fresh); } catch (e) {}
        try { await db.prepare('INSERT INTO activity_log (action, details, user_id) VALUES (?, ?, ?)')
          .bind('topup_buatqris_paid', order.id + ' (' + order.amount + ')', order.user_id).run(); } catch (e) {}
      }
    }
    return json({ received: true, matched: true });
  }

  // ---- Batalkan order ----
  if (body.action === 'cancel') {
    const orderId = String(body.order_id || '');
    if (!orderId) return json({ error: 'order_id required' }, 400);
    let order = null;
    try { order = await db.prepare('SELECT * FROM topup_orders WHERE id = ?').bind(orderId).first(); } catch (e) {}
    if (!order) return json({ error: 'order not found' }, 404);
    if (order.status === 'pending') {
      await db.prepare("UPDATE topup_orders SET status = 'failed' WHERE id = ?").bind(order.id).run();
    }
    return json({ success: true });
  }

  // ---- Buat transaksi QRIS baru ----
  const tpUser = await currentUser(env, request);
  if (!tpUser) return json({ error: 'Login diperlukan', need_login: true }, 401);

  const amount = parseInt(body.amount, 10);
  if (!amount || amount < 10000) return json({ error: 'minimal top up 10000' }, 400);

  const accountId = await getSecret(env, 'BUATQRIS_ACCOUNT_ID');
  const secretToken = await getSecret(env, 'BUATQRIS_SECRET_TOKEN');
  if (!accountId || !secretToken) {
    return json({
      error: 'payment_not_configured',
      message: 'BuatQris belum dikonfigurasi. Isi BUATQRIS_ACCOUNT_ID dan BUATQRIS_SECRET_TOKEN (dari dashboard BuatQris > Developer > Open API) di Environment.'
    }, 503);
  }
  const method = (await getSecret(env, 'BUATQRIS_METHOD')) || 'qris_two';

  const orderId = BQ_ORDER_PREFIX + Date.now() + '-' + Math.floor(Math.random() * 1000);

  const pay = await bqPost({
    action: 'api_create_qris',
    account_id: accountId,
    secret_token: secretToken,
    amount: String(amount),
    description: 'Top up saldo Clincoo ' + orderId,
    qris_method: method
  });
  // Respons BuatQris: { qr_url, payment_url, status, ... } (tahan terhadap bungkus data)
  const p = (pay && (pay.qr_url || pay.payment_url || pay.status)) ? pay : (pay && pay.data) || null;
  if (!p || !p.qr_url) {
    return json({ error: 'buatqris_error', message: (pay && pay.message) || (pay && pay.msg) || 'Gagal membuat QRIS di BuatQris (cek saldo/akun/konfigurasi API).' }, 502);
  }

  await ensureTopupTable(db);
  await ensureQrisColumns(db);

  // total tagihan (jika BuatQris menambahkan kode unik, pakai nilai dari mereka)
  const total = parseInt(p.total_amount || p.total || p.total_payment || p.amount || amount, 10) || amount;

  await db.prepare(
    'INSERT INTO topup_orders (id, amount, method, status, xendit_id, invoice_url, user_id, qr_url, bill_total, expires_at) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)'
  ).bind(orderId, amount, 'QRIS (BuatQris)', 'pending', p.payment_url || null, tpUser.id, p.qr_url, total, new Date(Date.now() + 15 * 60 * 1000).toISOString()).run();

  try {
    await db.prepare('INSERT INTO activity_log (action, details, user_id) VALUES (?, ?, ?)')
      .bind('topup_qris_created', orderId + ' (' + amount + ') via BuatQris', tpUser.id).run();
  } catch (e) {}

  return json({
    success: true,
    order_id: orderId,
    qr_string: p.qr_url,        // kompatibel UI lama (field ini berisi URL gambar QR)
    qr_image: p.qr_url,         // URL gambar QR siap tampil
    payment_url: p.payment_url || null,
    amount: amount,
    fee: 0,
    total_payment: total,
    expired_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    provider: 'buatqris'
  });
}
