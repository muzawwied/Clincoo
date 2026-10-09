// Cloudflare Pages Function — /api/kredit-topup
// TOP UP KREDIT AI langsung di dalam Clincoo (tanpa pindah ke kredit-ai.pages.dev).
// [8 Okt 2026, arahan pemilik] Semua alur — input nominal sampai QRIS — harus di
// URL Clincoo (app.clincoo.buzz/akun/kredit/topup/), bukan situs lain.
//
// Provider QRIS sama dengan saldo: BuatQris (api.buatqris.site), kredensial dari
// env/env_vars (BUATQRIS_ACCOUNT_ID, BUATQRIS_SECRET_TOKEN) — sudah terpasang.
//
// POST /api/kredit-topup  { action:'create', amount }   (Bearer sesi login)
//   -> { success, order_id, qr_image, total, fee, expires_at }
// GET  /api/kredit-topup?action=status&order_id=...     (Bearer sesi login)
//   -> { success, status: 'pending'|'paid'|'expired', credits? }
// GET  /api/kredit-topup?action=qrimg&u=...             (proxy unduh gambar QR)
//
// Grant kredit: idempotent per order — klaim atomik status pending->paid di tabel
// kredit_topups, lalu paket masuk ke ai_packs (sumber data /api/kredit & /api/chat).
// Konfirmasi pembayaran lewat 2 jalur: (1) webhook BuatQris -> /api/topup-qris
// (branch kredit-ai-), (2) polling status dari halaman (verifikasi server ke
// BuatQris). Keduanya aman dipanggil berkali-kali.
//
// Konversi nominal->kredit SAMA dengan ai-bridge (creditsOf): 100 kredit per
// Rp1.000 + bonus 10%/20%/25% mulai Rp25rb/Rp50rb/Rp100rb. Dihitung di server.

import { currentUser } from './user-scope.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};
export async function onRequestOptions() { return new Response(null, { status: 204, headers: CORS }); }

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS } });
}

const BQ_BASE = 'https://api.buatqris.site';
const ORDER_PREFIX = 'kredit-ai-';
const MIN_AMOUNT = 1000, MAX_AMOUNT = 100000000;
const PACK_DAYS = 30;

async function getSecret(env, key) {
  if (env[key]) return env[key];
  try {
    const row = await env.DB.prepare("SELECT value FROM env_vars WHERE key = ? AND (project_id IS NULL OR project_id = '')").bind(key).first();
    if (row?.value) return row.value;
  } catch (e) {}
  return null;
}

async function bqPost(params) {
  try {
    const res = await fetch(BQ_BASE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString()
    });
    return await res.json();
  } catch (e) { return null; }
}

function bonusPct(a) {
  if (a >= 100000) return 25;
  if (a >= 50000) return 20;
  if (a >= 25000) return 10;
  return 0;
}
function creditsOf(amount) { return Math.floor(amount / 10 * (1 + bonusPct(amount) / 100)); }

async function ensureTable(db) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS kredit_topups (
    id TEXT PRIMARY KEY,
    user_key TEXT NOT NULL,
    user_id TEXT,
    amount INTEGER NOT NULL,
    credits INTEGER NOT NULL,
    status TEXT DEFAULT 'pending',
    bq_txn TEXT,
    qr_url TEXT,
    bill_total INTEGER,
    expires_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    paid_at TEXT
  )`).run();
}

// Grant idempotent: klaim atomik pending->paid, lalu paket masuk ai_packs.
// Dipakai oleh polling di sini DAN oleh webhook di /api/topup-qris (import).
export async function claimKreditTopup(db, orderId) {
  const claim = await db.prepare("UPDATE kredit_topups SET status = 'paid', paid_at = datetime('now') WHERE id = ? AND status = 'pending'").bind(orderId).run();
  if (!claim.meta || !claim.meta.changes) return { granted: false, already: true };
  const t = await db.prepare('SELECT * FROM kredit_topups WHERE id = ?').bind(orderId).first();
  if (!t) return { granted: false, already: true };
  const now = new Date();
  const expires = new Date(now.getTime() + PACK_DAYS * 86400_000);
  await db.prepare(
    'INSERT INTO ai_packs (user_key, pack_id, name, price, credits_total, credits_left, purchased_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(t.user_key, 'topup', 'Top-up Kredit AI (QRIS)', t.amount, t.credits, t.credits, now.toISOString(), expires.toISOString()).run();
  try {
    await db.prepare('INSERT INTO activity_log (action, details, user_id) VALUES (?, ?, ?)')
      .bind('kredit_topup_paid', t.id + ': Rp' + t.amount + ' -> ' + t.credits + ' kredit', t.user_id).run();
  } catch (e) {}
  return { granted: true, credits: t.credits, amount: t.amount, user_key: t.user_key, expires_at: expires.toISOString() };
}

// Cek status di BuatQris dan (jika lunas) grant. Boleh dipanggil berkali-kali.
async function bqStatus(env, bqTxn) {
  const accountId = await getSecret(env, 'BUATQRIS_ACCOUNT_ID');
  const secretToken = await getSecret(env, 'BUATQRIS_SECRET_TOKEN');
  if (!accountId || !secretToken || !bqTxn) return null;
  const d = await bqPost({ action: 'api_check_status', account_id: accountId, secret_token: secretToken, transaction_id: bqTxn });
  return (d && (d.data || d)) || null;
}

export async function onRequestPost({ request, env }) {
  const db = env.DB;
  if (!db) return json({ error: 'D1 not bound' }, 500);
  try {
    const user = await currentUser(env, request);
    if (!user) return json({ success: false, need_login: true, error: 'Silakan login terlebih dahulu' }, 401);
    let body = {};
    try { body = await request.json(); } catch (e) {}
    if (body.action !== 'create') return json({ error: 'action tidak dikenal' }, 400);

    const amount = Math.floor(Number(body.amount || 0));
    if (!amount || amount < MIN_AMOUNT || amount > MAX_AMOUNT) {
      return json({ success: false, message: 'Nominal harus Rp 1.000 – Rp 100.000.000' }, 400);
    }

    const accountId = await getSecret(env, 'BUATQRIS_ACCOUNT_ID');
    const secretToken = await getSecret(env, 'BUATQRIS_SECRET_TOKEN');
    if (!accountId || !secretToken) return json({ success: false, message: 'QRIS belum terkonfigurasi.' }, 503);
    const method = (await getSecret(env, 'BUATQRIS_METHOD')) || 'qris_two';

    const orderId = ORDER_PREFIX + Date.now() + '-' + Math.floor(Math.random() * 1000);
    const pay = await bqPost({
      action: 'api_create_qris',
      account_id: accountId,
      secret_token: secretToken,
      amount: String(amount),
      description: 'Clincoo Kredit AI ' + orderId,
      qris_method: method
    });
    const p = (pay && (pay.qr_url || pay.payment_url || pay.status)) ? pay : (pay && pay.data) || null;
    if (!p || !p.qr_url || !p.transaction_id) {
      return json({ success: false, message: (pay && (pay.message || pay.msg)) || 'Gagal membuat QRIS.' }, 502);
    }

    const credits = creditsOf(amount);
    const total = parseInt(p.total_amount || p.total || p.total_payment || amount, 10) || amount;
    const fee = Math.max(0, total - amount);

    await ensureTable(db);
    await db.prepare(
      'INSERT INTO kredit_topups (id, user_key, user_id, amount, credits, status, bq_txn, qr_url, bill_total, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(orderId, 'u' + user.id, String(user.id), amount, credits, 'pending', p.transaction_id, p.qr_url, total, p.expired_at || new Date(Date.now() + 15 * 60 * 1000).toISOString()).run();

    return json({
      success: true,
      order_id: orderId,
      qr_image: p.qr_url,
      total, fee, amount, credits,
      expires_at: p.expired_at || ''
    });
  } catch (e) {
    return json({ error: 'Gagal membuat QRIS' }, 500);
  }
}

export async function onRequestGet({ request, env }) {
  const db = env.DB;
  if (!db) return json({ error: 'D1 not bound' }, 500);
  const url = new URL(request.url);
  const action = url.searchParams.get('action');

  // Proxy gambar QR untuk unduhan (host di-whitelist)
  if (action === 'qrimg') {
    const u = String(url.searchParams.get('u') || '');
    let host = '';
    try { host = new URL(u).hostname; } catch (e) {}
    if (!host || !(host === 'api.buatqris.site' || host.endsWith('.buatqris.site') || host === 'api.qrserver.com')) {
      return new Response('Host tidak diizinkan.', { status: 400, headers: CORS });
    }
    try {
      const res = await fetch(u, { headers: { Referer: 'https://app.clincoo.buzz' } });
      const buf = await res.arrayBuffer();
      return new Response(buf, {
        status: 200,
        headers: {
          'Content-Type': res.headers.get('Content-Type') || 'image/png',
          'Cache-Control': 'public, max-age=900',
          'Content-Disposition': 'attachment; filename="qris-kredit-ai-clincoo.png"',
          ...CORS
        }
      });
    } catch (e) { return new Response('Gagal mengambil gambar QR.', { status: 502, headers: CORS }); }
  }

  // [9 Okt 2026, arahan pemilik] Order PENDING terakhir milik user — halaman bayar
  // memakai ini untuk pulih ke layar QRIS setelah refresh / buka tab baru, biar
  // order yang belum dibayar tidak hilang dan tidak balik ke halaman nominal.
  if (action === 'pending') {
    const user = await currentUser(env, request);
    if (!user) return json({ success: false, need_login: true }, 401);
    let t = null;
    try { t = await db.prepare("SELECT * FROM kredit_topups WHERE user_key = ? AND status = 'pending' ORDER BY created_at DESC, rowid DESC LIMIT 1").bind('u' + user.id).first(); } catch (e) {}
    if (!t) return json({ success: false, none: true });
    return json({
      success: true,
      order_id: t.id,
      qr_image: t.qr_url,
      amount: t.amount,
      credits: t.credits,
      total: t.bill_total || t.amount,
      fee: Math.max(0, (t.bill_total || t.amount) - t.amount),
      expires_at: t.expires_at || ''
    });
  }

  // [9 Okt 2026, arahan pemilik] Order PENDING terakhir milik user — halaman bayar
  // memakai ini untuk pulih ke layar QRIS setelah refresh / buka tab baru, biar
  // order yang belum dibayar tidak hilang dan tidak balik ke halaman nominal.
  if (action === 'pending') {
    const user = await currentUser(env, request);
    if (!user) return json({ success: false, need_login: true }, 401);
    let t = null;
    try { t = await db.prepare("SELECT * FROM kredit_topups WHERE user_key = ? AND status = 'pending' ORDER BY created_at DESC, rowid DESC LIMIT 1").bind('u' + user.id).first(); } catch (e) {}
    if (!t) return json({ success: false, none: true });
    return json({
      success: true,
      order_id: t.id,
      qr_image: t.qr_url,
      amount: t.amount,
      credits: t.credits,
      total: t.bill_total || t.amount,
      fee: Math.max(0, (t.bill_total || t.amount) - t.amount),
      expires_at: t.expires_at || ''
    });
  }

  if (action === 'status') {
    const user = await currentUser(env, request);
    if (!user) return json({ success: false, need_login: true }, 401);
    const orderId = String(url.searchParams.get('order_id') || '');
    if (!orderId) return json({ error: 'order_id wajib diisi' }, 400);
    let t = null;
    try { t = await db.prepare('SELECT * FROM kredit_topups WHERE id = ? AND user_key = ?').bind(orderId, 'u' + user.id).first(); } catch (e) {}
    if (!t) return json({ success: false, error: 'order tidak ditemukan' }, 404);

    if (t.status === 'pending') {
      // Verifikasi ke BuatQris (server-side) — kalau lunas, grant sekarang.
      const d = await bqStatus(env, t.bq_txn);
      const st = String((d && d.status) || '').toLowerCase();
      if (['success', 'paid', 'berhasil', 'settlement'].indexOf(st) !== -1) {
        const g = await claimKreditTopup(db, orderId);
        return json({ success: true, status: 'paid', credits: g.credits || t.credits });
      }
      if (['expired', 'expire', 'fail', 'failed', 'cancel', 'cancelled'].indexOf(st) !== -1) {
        await db.prepare("UPDATE kredit_topups SET status = 'expired' WHERE id = ? AND status = 'pending'").bind(orderId).run();
        return json({ success: true, status: 'expired' });
      }
      return json({ success: true, status: 'pending' });
    }
    return json({ success: true, status: t.status, credits: t.credits });
  }

  return json({ error: 'action tidak dikenal' }, 400);
}
