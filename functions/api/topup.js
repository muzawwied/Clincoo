import { currentUser, scopedKey, getUserById } from './user-scope.js';
import { emailTemplate, formatIDR, sendEmail, notifyEvent } from './notify-helpers.js';
// Cloudflare Pages Functions - Top Up via Xendit Invoice (real-time)
// Flow: pilih metode -> buat Invoice Xendit -> bayar -> webhook/poll verifikasi -> saldo masuk D1
// Env: XENDIT_SECRET_KEY (wajib) & XENDIT_CALLBACK_TOKEN (opsional, utk verifikasi webhook)
// Alternatif env: tabel env_vars D1 (key: XENDIT_SECRET_KEY / XENDIT_CALLBACK_TOKEN)

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
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

// Deteksi mode: test key (xnd_development_) = SANDBOX, production key = LIVE
function xenditMode(secretKey) {
  if (!secretKey) return null;
  return secretKey.startsWith('xnd_development_') ? 'sandbox' : 'live';
}

// Saluran pembayaran realistis + logo resmi dari Wikimedia Commons
const CHANNELS = [
  { id: 'qris', label: 'QRIS', note: 'Semua e-wallet & m-banking (DANA, ShopeePay, dll)', category: 'qris', methods: ['QRIS'], logo: 'https://commons.wikimedia.org/wiki/Special:FilePath/QRIS%20Logo.svg?width=200' },
  { id: 'gopay', label: 'GoPay', note: 'Scan QRIS dengan aplikasi Gojek', category: 'qris', methods: ['QRIS'], logo: 'https://commons.wikimedia.org/wiki/Special:FilePath/GoPay%20logo.svg?width=200' },
  { id: 'ovo', label: 'OVO', note: 'Bayar langsung dari saldo OVO', category: 'ewallet', methods: ['OVO'], logo: 'https://commons.wikimedia.org/wiki/Special:FilePath/Logo%20ovo%20purple.svg?width=200' },
  { id: 'bca', label: 'BCA Virtual Account', note: 'Transfer ke rekening virtual BCA', category: 'va', methods: ['BCA'], logo: 'https://commons.wikimedia.org/wiki/Special:FilePath/Bank%20Central%20Asia.svg?width=200' },
  { id: 'mandiri', label: 'Mandiri Virtual Account', note: 'Transfer ke rekening virtual Mandiri', category: 'va', methods: ['MANDIRI'], logo: 'https://commons.wikimedia.org/wiki/Special:FilePath/Bank%20Mandiri%20logo%202016.svg?width=200' },
  { id: 'bri', label: 'BRI Virtual Account', note: 'Transfer ke rekening virtual BRI', category: 'va', methods: ['BRI'], logo: 'https://commons.wikimedia.org/wiki/Special:FilePath/Bank-Rakyat-Indonesia-Logo.svg?width=200' },
  { id: 'bni', label: 'BNI Virtual Account', note: 'Transfer ke rekening virtual BNI', category: 'va', methods: ['BNI'], logo: 'https://commons.wikimedia.org/wiki/Special:FilePath/Bank%20Negara%20Indonesia%20logo%20%282004%29.svg?width=200' }
];

// GET /api/topup?action=channels — daftar metode pembayaran (data real-time utk frontend)
// GET /api/topup?action=status&order_id=X — cek status order (live check ke Xendit + D1)
export async function onRequestGet({ request, env }) {
  try {
    const url = new URL(request.url);
    const action = url.searchParams.get('action');

    if (action === 'channels') {
      const secretKey = await getSecret(env, 'XENDIT_SECRET_KEY');
      return json({ channels: CHANNELS, configured: !!secretKey, mode: xenditMode(secretKey) });
    }

    if (action === 'status') {
      const orderId = url.searchParams.get('order_id');
      if (!orderId) return json({ error: 'order_id required' }, 400);

      let order = await env.DB.prepare('SELECT * FROM topup_orders WHERE id = ?').bind(orderId).first();
      if (!order) return json({ error: 'order not found' }, 404);

      // Jika masih pending: cek live ke Xendit (real-time, tanpa bergantung webhook)
      if (order.status === 'pending' && order.xendit_id) {
        const secretKey = await getSecret(env, 'XENDIT_SECRET_KEY');
        if (secretKey) {
          try {
            const inv = await xenditGet('/v2/invoices/' + order.xendit_id, secretKey);
            if (inv && (inv.status === 'PAID' || inv.status === 'SETTLED')) {
              await creditTopup(env, order);
              order = await env.DB.prepare('SELECT * FROM topup_orders WHERE id = ?').bind(orderId).first();
            } else if (inv && inv.status === 'EXPIRED' && order.status === 'pending') {
              await env.DB.prepare("UPDATE topup_orders SET status = 'failed' WHERE id = ?").bind(orderId).run();
              order = await env.DB.prepare('SELECT * FROM topup_orders WHERE id = ?').bind(orderId).first();
            }
          } catch (e) { /* jaringan bermasalah — kembalikan status D1 */ }
        }
      }

      const stUser = await currentUser(env, request);
      const stBalKey = await scopedKey(env.DB, 'wallet_balance', stUser, 'balance');
      const balRow = await env.DB.prepare('SELECT value FROM wallet_balance WHERE key = ?').bind(stBalKey).first();
      return json({
        order_id: order.id,
        amount: order.amount,
        method: order.method,
        status: order.status,
        invoice_url: order.invoice_url,
        balance: parseFloat(balRow?.value || '0')
      });
    }

    return json({ error: 'unknown action' }, 400);
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}

// POST /api/topup
//  a) {action:'create', amount, method} -> buat Invoice Xendit
//  b) Callback Xendit (header x-callback-token) -> verifikasi -> kredit saldo
export async function onRequestPost({ request, env }) {
  const db = env.DB;
  if (!db) return json({ error: 'D1 not bound' }, 500);

  const callbackToken = request.headers.get('x-callback-token');

  // ---- Callback/webhook Xendit ----
  if (callbackToken) {
    const expected = await getSecret(env, 'XENDIT_CALLBACK_TOKEN');
    if (!expected || callbackToken !== expected) return json({ error: 'invalid callback token' }, 403);

    let body = {};
    try { body = await request.json(); } catch { return json({ error: 'invalid body' }, 400); }

    if (body.status === 'PAID' || body.status === 'SETTLED') {
      const order = await db.prepare('SELECT * FROM topup_orders WHERE id = ?').bind(body.external_id).first();
      if (order && order.status !== 'paid') {
        await creditTopup(env, order);
      }
    } else if (['EXPIRED', 'EXPIRED'].includes(body.status)) {
      await db.prepare("UPDATE topup_orders SET status = 'failed' WHERE id = ? AND status = 'pending'").bind(body.external_id).run();
    }
    return json({ received: true });
  }

  // ---- Buat transaksi top-up ----
  let body = {};
  try { body = await request.json(); } catch { return json({ error: 'invalid body' }, 400); }

  if (body.action !== 'create') return json({ error: 'unknown action' }, 400);

  const secretKey = await getSecret(env, 'XENDIT_SECRET_KEY');
  if (!secretKey) {
    return json({
      error: 'payment_not_configured',
      message: 'XENDIT_SECRET_KEY belum diatur. Tambahkan di Cloudflare Pages > Settings > Environment variables, atau di tabel env_vars.'
    }, 503);
  }

  const amount = parseInt(body.amount, 10);
  if (!amount || amount < 10000) return json({ error: 'minimal top up 10000' }, 400);

  const channel = CHANNELS.find(c => c.id === body.method) || CHANNELS[0];
  const orderId = 'TOPUP-' + Date.now() + '-' + Math.floor(Math.random() * 1000);
  const tpUser = await currentUser(env, request);
  const tpUid = tpUser ? tpUser.id : null;
  try { await db.prepare('ALTER TABLE topup_orders ADD COLUMN user_id INTEGER').run(); } catch (e) {}

  // Buat Invoice Xendit — hanya metode yang dipilih user
  const invoice = await xenditPost('/v2/invoices', secretKey, {
    external_id: orderId,
    amount: amount,
    currency: 'IDR',
    description: 'Top Up Saldo Clincoo',
    invoice_duration: 3600,
    payment_methods: channel.methods
  });

  if (!invoice || !invoice.id || !invoice.invoice_url) {
    return json({ error: 'xendit_error', message: (invoice && (invoice.message || JSON.stringify(invoice))) || 'Gagal membuat invoice Xendit' }, 502);
  }

  // Simpan order pending
  await db.prepare(
    'INSERT INTO topup_orders (id, amount, method, status, xendit_id, invoice_url, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).bind(orderId, amount, channel.label, 'pending', invoice.id, invoice.invoice_url, tpUid).run();

  try {
    await db.prepare('INSERT INTO activity_log (action, details) VALUES (?, ?)')
      .bind('topup_created', orderId + ' (' + channel.label + ': ' + amount + ')').run();
  } catch {}

  return json({
    success: true,
    order_id: orderId,
    invoice_url: invoice.invoice_url,
    expires_at: invoice.expiry_date || null,
    channel: channel.id,
    label: channel.label,
    mode: xenditMode(secretKey)
  });
}

// Kredit saldo D1 — dipakai webhook & live status (idempotent via status order)
// Di-export untuk dipakai juga oleh topup-qris.js (QRIS BuatQris)
export async function creditTopup(env, order) {
  const db = env.DB;
  const owner = await getUserById(db, order.user_id);
  const balKey = await scopedKey(db, 'wallet_balance', owner, 'balance');
  const txId = 'TX-' + Math.floor(100000 + Math.random() * 900000);
  try { await db.prepare('ALTER TABLE wallet_transactions ADD COLUMN user_id INTEGER').run(); } catch (e) {}
  await db.prepare('INSERT INTO wallet_transactions (id, title, amount, type, method, user_id) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(txId, 'Isi Saldo via ' + (order.method || 'Xendit'), order.amount, 'in', order.method || 'Xendit', order.user_id || null).run();

  const balRow = await db.prepare('SELECT value FROM wallet_balance WHERE key = ?').bind(balKey).first();
  const balance = parseFloat(balRow?.value || '0') + parseFloat(order.amount);
  await db.prepare('INSERT INTO wallet_balance (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .bind(balKey, String(balance)).run();

  await db.prepare("UPDATE topup_orders SET status = 'paid', paid_at = datetime('now') WHERE id = ?").bind(order.id).run();

  // Notifikasi in-app + email konfirmasi (Brevo) ke pemilik akun
  if (owner) {
    const nres = { notif: false, email: null };
    try {
      nres.notif = await notifyEvent(db, owner, {
        source: 'Dompet', type: 'wallet',
        message: 'Top up ' + formatIDR(order.amount) + ' via ' + (order.method || 'Xendit') + ' berhasil. Saldo sekarang ' + formatIDR(balance) + '.',
        link: 'https://muzawwied.github.io/Clincoo./akun/dompet/'
      });
    } catch (e) {}
    if (owner.email) {
      try {
        nres.email = await sendEmail(env, {
          toEmail: owner.email, toName: owner.name || '',
          subject: 'Konfirmasi Top Up Clincoo — ' + formatIDR(order.amount),
          html: emailTemplate(
            'Top Up Berhasil',
            owner.name || '',
            'Top up saldo Clincoo Anda telah berhasil diproses dan saldo telah masuk ke Dompet Anda. Berikut rincian transaksinya:',
            [
              ['Jumlah Top Up', formatIDR(order.amount) + ' (' + (order.method || 'Xendit') + ')'],
              ['Saldo Saat Ini', formatIDR(balance)],
              ['Order ID', order.id]
            ],
            'Lihat Riwayat Dompet',
            'https://muzawwied.github.io/Clincoo./akun/dompet/',
            'Rincian lengkap transaksi dapat dilihat di halaman Dompet pada akun Clincoo Anda.'
          )
        });
      } catch (e) {}
    }
    try {
      await db.prepare('INSERT INTO activity_log (action, details, user_id) VALUES (?, ?, ?)')
        .bind('notify_email_result', 'notif=' + String(nres.notif) + ' email=' + JSON.stringify(nres.email).slice(0, 200), order.user_id || null).run();
    } catch (e2) {}
  }

  try {
    try { await db.prepare('ALTER TABLE activity_log ADD COLUMN user_id INTEGER').run(); } catch (e) {}
    await db.prepare('INSERT INTO activity_log (action, details, user_id) VALUES (?, ?, ?)')
      .bind('topup_paid', order.id + ' (+' + order.amount + ')', order.user_id || null).run();
  } catch {}
}

// ---- Xendit API helpers ----
function xenditAuth(secretKey) {
  return 'Basic ' + btoa(secretKey + ':');
}

async function xenditPost(path, secretKey, payload) {
  try {
    const res = await fetch('https://api.xendit.co' + path, {
      method: 'POST',
      headers: { 'Authorization': xenditAuth(secretKey), 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    return res.ok ? data : { error: true, ...data };
  } catch (e) {
    return { error: true, message: e.message };
  }
}

async function xenditGet(path, secretKey) {
  try {
    const res = await fetch('https://api.xendit.co' + path, {
      headers: { 'Authorization': xenditAuth(secretKey) }
    });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}
