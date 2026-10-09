import { currentUser, scopedKey, rowScope } from './user-scope.js';
import { getCpConnection, mirroredBalance, mirrorDelta } from './clincoopay-helpers.js';
import { emailTemplate, formatIDR, sendEmail, notifyEvent } from './notify-helpers.js';

// Cloudflare Pages Functions — Paket Kredit AI Clincoo (ala kuota internet).
// Dibeli di luar langganan (user langganan maupun gratis boleh beli).
// Aturan pakai (di-enforce server-side di /api/chat):
//   1. Kuota langganan dipakai lebih dulu; kalau habis → otomatis lanjut ke kredit paket.
//   2. Kredit paket TIDAK terkena cap harian — bebas dipakai selama masa aktif.
//   3. Beberapa paket aktif → yang paling cepat kadaluarsa dipakai duluan.
//   4. Kredit HANGUS saat masa aktif paket habis (sesuai desain "kuota internet").

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

// Katalog paket: makin lama durasi, makin murah harga per kredit (Rp125 → Rp39).
export const AI_PACKS = {
  kilat:  { id: 'kilat',  name: 'Kilat',  days: 2,  credits: 40,  price: 5000 },
  cepat:  { id: 'cepat',  name: 'Cepat',  days: 3,  credits: 75,  price: 7500 },
  rutin:  { id: 'rutin',  name: 'Rutin',  days: 5,  credits: 160, price: 12000 },
  sprint: { id: 'sprint', name: 'Sprint', days: 7,  credits: 300, price: 18000 },
  hemat:  { id: 'hemat',  name: 'Hemat',  days: 30, credits: 900, price: 35000 }
};

export async function onRequestOptions() {
  return new Response(null, { headers: CORS });
}

async function ensurePackTable(db) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS ai_packs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_key TEXT NOT NULL,
    pack_id TEXT NOT NULL,
    name TEXT,
    price INTEGER,
    credits_total INTEGER,
    credits_left INTEGER,
    purchased_at TEXT,
    expires_at TEXT
  )`).run();
  try { await db.prepare('CREATE INDEX IF NOT EXISTS idx_ai_packs_user ON ai_packs(user_key, expires_at)').run(); } catch (e) {}
}

// Daftar paket aktif milik user (kredit tersisa > 0 & belum kadaluarsa), kadaluarsa terdekat duluan.
export async function getActivePacks(db, userKey) {
  try {
    await ensurePackTable(db);
    const now = new Date().toISOString();
    const rows = await db.prepare(
      'SELECT id, pack_id, name, price, credits_total, credits_left, purchased_at, expires_at FROM ai_packs WHERE user_key = ? AND credits_left > 0.00001 AND expires_at > ? ORDER BY expires_at ASC'
    ).bind(userKey, now).all();
    return rows.results || [];
  } catch (e) { return []; }
}

// Dipakai /api/chat: konsumsi kredit dari paket aktif saat kuota langganan habis.
// Paket yang paling cepat kadaluarsa dipakai lebih dulu supaya kredit nggak terbuang.
export async function consumePackCredit(db, userKey, cost = 1) {
  try {
    const packs = await getActivePacks(db, userKey);
    let remaining = cost;
    for (const p of packs) {
      if (remaining <= 0) break;
      const take = Math.min(p.credits_left, remaining);
      remaining -= take;
      await db.prepare('UPDATE ai_packs SET credits_left = credits_left - ? WHERE id = ?').bind(take, p.id).run();
    }
    // [9 Okt] Pemakaian pecahan: debu < 0,00001 kredit dianggap habis supaya
    // paket tidak "hidup" selamanya dengan sisa tak terpakai.
    try {
      await db.prepare('UPDATE ai_packs SET credits_left = 0 WHERE user_key = ? AND credits_left > 0 AND credits_left < 0.00001').bind(userKey).run();
    } catch (e) {}
    return { ok: remaining <= 0.00001 };
  } catch (e) { return { ok: false }; }
}

// Baca saldo dompet (dengan dukungan mirroring ClincooPay — pola sama dgn subscription.js)
async function readBalance(db, user) {
  const balKey = await scopedKey(db, 'wallet_balance', user, 'balance');
  const balRow = await db.prepare('SELECT value FROM wallet_balance WHERE key = ?').bind(balKey).first();
  let balance = parseFloat(balRow?.value || '0');
  const conn = await getCpConnection(db, user.id);
  if (conn) {
    const wb = await mirroredBalance(conn);
    if (wb !== null) balance = wb;
  }
  return { balance, conn, balKey };
}

export async function onRequestGet({ request, env }) {
  const db = env.DB;
  if (!db) return new Response(JSON.stringify({ error: 'D1 not bound' }), { status: 500, headers: { 'Content-Type': 'application/json', ...CORS } });
  try {
    const user = await currentUser(env, request);
    if (!user) return new Response(JSON.stringify({ error: 'Silakan login terlebih dahulu', need_login: true }), { status: 401, headers: { 'Content-Type': 'application/json', ...CORS } });
    const userKey = 'u' + user.id;

    let balance = 0;
    try { balance = (await readBalance(db, user)).balance; } catch (e) {}
    const active = await getActivePacks(db, userKey);
    const creditsLeft = active.reduce((s, p) => s + (p.credits_left || 0), 0);

    return new Response(JSON.stringify({
      packs: Object.values(AI_PACKS),
      active_packs: active,
      credits_left_total: creditsLeft,
      balance
    }), { headers: { 'Content-Type': 'application/json', ...CORS } });
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Gagal memuat data paket kredit' }), { status: 500, headers: { 'Content-Type': 'application/json', ...CORS } });
  }
}

export async function onRequestPost({ request, env }) {
  const db = env.DB;
  if (!db) return new Response(JSON.stringify({ error: 'D1 not bound' }), { status: 500, headers: { 'Content-Type': 'application/json', ...CORS } });
  try {
    const user = await currentUser(env, request);
    if (!user) return new Response(JSON.stringify({ error: 'Silakan login terlebih dahulu', need_login: true }), { status: 401, headers: { 'Content-Type': 'application/json', ...CORS } });

    const body = await request.json().catch(() => ({}));
    const pack = AI_PACKS[String(body.pack_id || '').toLowerCase()];
    if (!pack) return new Response(JSON.stringify({ error: 'Paket kredit tidak dikenal' }), { status: 400, headers: { 'Content-Type': 'application/json', ...CORS } });

    const userKey = 'u' + user.id;
    await ensurePackTable(db);

    // Cek & potong saldo dompet (pola sama dengan pembelian langganan)
    let newBalance;
    try {
      const { balance, conn, balKey } = await readBalance(db, user);
      if (balance < pack.price) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Saldo tidak cukup',
          balance: balance,
          required: pack.price
        }), { status: 402, headers: { 'Content-Type': 'application/json', ...CORS } });
      }
      const uid = await rowScope(db, 'wallet_transactions', user);
      const txId = 'TX-' + Math.floor(100000 + Math.random() * 900000);
      await db.prepare('INSERT INTO wallet_transactions (id, title, amount, type, method, user_id) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(txId, 'Paket Kredit AI ' + pack.name + ' (' + pack.days + ' hari)', pack.price, 'out', 'Saldo Dompet', uid).run();
      newBalance = balance - pack.price;
      if (conn) {
        const mr = await mirrorDelta(conn, -pack.price, 'Clincoo: Paket Kredit AI ' + pack.name + ' (' + pack.days + ' hari)', txId);
        if (!mr.ok) {
          const kurang = String(mr.error).indexOf('tidak cukup') >= 0;
          return new Response(JSON.stringify({ success: false, error: kurang ? 'Saldo ClincooPay tidak cukup.' : mr.error }), { status: kurang ? 402 : 502, headers: { 'Content-Type': 'application/json' } });
        }
        newBalance = mr.balance;
      } else {
        await db.prepare('INSERT INTO wallet_balance (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
          .bind(balKey, String(newBalance)).run();
      }
    } catch (e) {
      return new Response(JSON.stringify({ success: false, error: 'Gagal memverifikasi saldo dompet' }), { status: 500, headers: { 'Content-Type': 'application/json', ...CORS } });
    }

    // Catat paket kredit milik user
    const now = new Date();
    const expires = new Date(now.getTime() + pack.days * 86400000);
    const info = await db.prepare(
      'INSERT INTO ai_packs (user_key, pack_id, name, price, credits_total, credits_left, purchased_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(userKey, pack.id, pack.name, pack.price, pack.credits, pack.credits, now.toISOString(), expires.toISOString()).run();

    // Notifikasi in-app + catat aktivitas + email konfirmasi (pola sama dengan langganan)
    try {
      await notifyEvent(db, user, {
        source: 'Kredit AI', type: 'credits',
        message: 'Paket Kredit AI ' + pack.name + ' aktif: ' + pack.credits + ' kredit selama ' + pack.days + ' hari. Total ' + formatIDR(pack.price) + ' dipotong dari Saldo Dompet.',
        link: 'https://app.clincoo.buzz/akun/langganan/kredit/'
      });
    } catch (e2) {}
    try {
      const uid = await rowScope(db, 'activity_log', user);
      await db.prepare('INSERT INTO activity_log (action, details, user_id) VALUES (?, ?, ?)')
        .bind('credits', 'Paket Kredit AI ' + pack.name + ' (' + pack.credits + ' kredit, ' + pack.days + ' hari) — ' + formatIDR(pack.price) + ' dari Saldo Dompet', uid).run();
    } catch (eAct) {}
    if (user && user.email) {
      try {
        await sendEmail(env, {
          toEmail: user.email, toName: user.name || '',
          subject: 'Paket Kredit AI Aktif — ' + pack.name,
          html: emailTemplate(
            'Kredit AI Aktif',
            user.name || '',
            'Paket Kredit AI ' + pack.name + ' Anda telah aktif. Kredit dapat dipakai kapan saja selama masa aktif (bebas batas harian) dan otomatis dipakai saat kuota langganan habis. Berikut rinciannya:',
            [
              ['Paket', pack.name],
              ['Jumlah Kredit', pack.credits + ' kredit'],
              ['Masa Aktif', pack.days + ' hari (s.d. ' + expires.toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', day: 'numeric', month: 'long', year: 'numeric' }) + ' WIB)'],
              ['Total Pembayaran', formatIDR(pack.price) + ' (Saldo Dompet)'],
              ['Saldo Dompet Tersisa', formatIDR(newBalance)]
            ],
            'Lihat Kredit Anda',
            'https://app.clincoo.buzz/akun/langganan/kredit/',
            'Sisa kredit dapat dilihat di halaman Kredit AI pada akun Clincoo Anda. Kredit yang tidak terpakai hingga masa aktif berakhir akan hangus.'
          )
        });
      } catch (e3) {}
    }

    return new Response(JSON.stringify({
      success: true,
      pack: { ...pack, expires_at: expires.toISOString(), credits_left: pack.credits },
      balance: newBalance
    }), { headers: { 'Content-Type': 'application/json', ...CORS } });
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Gagal memproses pembelian paket kredit' }), { status: 500, headers: { 'Content-Type': 'application/json', ...CORS } });
  }
}
