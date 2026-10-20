// Cloudflare Pages Function — /api/ai-bridge
// BRIDGE DATA: kredit-ai.pages.dev  <->  Clincoo (app.clincoo.buzz).
// Server-to-server only: klien tidak pernah memegang kunci. Rute ini PUBLIC di
// middleware karena tidak ada sesi login Clincoo — auth pakai HMAC kunci bersama.
//
// Auth (semua request):
//   X-Timestamp : epoch detik (jendela ±10 menit — anti replay)
//   X-Signature : hex HMAC-SHA256(KREDIT_AI_BRIDGE_KEY, "<timestamp>.<rawBody>")
// Kunci disimpan di D1 env_vars (global, is_secret=1) — jalur yang sama dengan
// MODELROUTER_API_KEY. Fallback: env Pages KREDIT_AI_BRIDGE_KEY.
//
// POST /api/ai-bridge
//   { action: 'lookup',  email }                       -> { exists, user_key }
//   { action: 'balance', email }                       -> { user_key, quota:{...}, packs:{...} }
//   { action: 'grant',   email, txn, amount, days? }    -> { granted, credits, expires_at }  (idempotent per txn)
//
// Grant = pembelian kredit QRIS di kredit-ai: kredit MASUK ke akun Clincoo milik
// email tsb sebagai paket aktif di tabel ai_packs (sumber data yang sama dengan
// Paket Kredit AI bawaan — jadi kredit langsung terpakai otomatis oleh /api/chat
// saat kuota langganan habis). Konversi nominal->kredit dihitung DI SINI
// (server Clincoo = sumber kebenaran, klien tidak bisa memanipulasi jumlah).

const CORS = {
  'Access-Control-Allow-Origin': 'https://kredit-ai.pages.dev',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Timestamp, X-Signature'
};

const BRIDGE_ORIGIN_OK = 'https://kredit-ai.pages.dev';

function j(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...CORS } });
}
export async function onRequestOptions() { return new Response(null, { status: 204, headers: CORS }); }

const TS_WINDOW_SEC = 600; // ±10 menit

async function getBridgeKey(env) {
  if (env.KREDIT_AI_BRIDGE_KEY) return env.KREDIT_AI_BRIDGE_KEY;
  try {
    const row = await env.DB.prepare("SELECT value FROM env_vars WHERE key = 'KREDIT_AI_BRIDGE_KEY'").first();
    if (row?.value) return row.value;
  } catch (e) {}
  return '';
}

async function hmacHex(secret, msg) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// Verifikasi HMAC + jendela waktu. Return {ok} atau {error: Response}.
async function verifyRequest(env, request, rawBody) {
  const secret = await getBridgeKey(env);
  if (!secret) return { error: j({ error: 'bridge belum terkonfigurasi' }, 503) };
  const ts = Number(request.headers.get('X-Timestamp') || '0');
  const sig = String(request.headers.get('X-Signature') || '');
  if (!ts || !sig) return { error: j({ error: 'tanda tangan bridge tidak ada' }, 401) };
  if (Math.abs(Math.floor(Date.now() / 1000) - ts) > TS_WINDOW_SEC) return { error: j({ error: 'timestamp kadaluarsa' }, 401) };
  const expected = await hmacHex(secret, ts + '.' + rawBody);
  if (sig !== expected) return { error: j({ error: 'tanda tangan bridge tidak valid' }, 401) };
  return { ok: true };
}

// Throttle ringan per IP (isolate-local, pola _middleware).
const _hits = new Map();
function throttle(ip, max, windowMs) {
  const now = Date.now();
  let b = _hits.get(ip);
  if (!b || now - b.start >= windowMs) b = { start: now, count: 0 };
  b.count++; _hits.set(ip, b);
  if (_hits.size > 5000) for (const [k, v] of _hits.entries()) if (now - v.start >= windowMs) _hits.delete(k);
  return b.count <= max;
}

// Konversi nominal Rp -> kredit — SAMA dengan kredit-ai (kreditOf + bonusPct).
// Sengaja diduplikasi di server Clincoo supaya jumlah grant tidak bisa dimanipulasi klien.
function bonusPct(a) {
  if (a >= 100000) return 25;
  if (a >= 50000) return 20;
  if (a >= 25000) return 10;
  return 0;
}
function creditsOf(amount) { return Math.floor(amount / 10 * (1 + bonusPct(amount) / 100)); }

const MIN_AMOUNT = 1000, MAX_AMOUNT = 100000000;
const DEFAULT_DAYS = 30;

async function ensureTables(db) {
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
  await db.prepare(`CREATE TABLE IF NOT EXISTS ai_bridge_orders (
    txn TEXT PRIMARY KEY,
    user_key TEXT,
    email TEXT,
    amount INTEGER,
    credits INTEGER,
    status TEXT DEFAULT 'granted',
    granted_at TEXT DEFAULT (datetime('now'))
  )`).run();
}

async function userKeyByEmail(db, email) {
  const row = await db.prepare('SELECT id FROM auth_users WHERE email = ?').bind(String(email).trim().toLowerCase()).first();
  return row ? 'u' + Number(row.id) : null;
}

export async function onRequestPost({ request, env }) {
  const db = env.DB;
  if (!db) return j({ error: 'D1 not bound' }, 500);
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  if (!throttle(ip, 60, 60_000)) return j({ error: 'terlalu banyak permintaan' }, 429);
  try {
    const rawBody = await request.text();
    const v = await verifyRequest(env, request, rawBody);
    if (v.error) return v.error;
    let body = {};
    try { body = JSON.parse(rawBody || '{}'); } catch (e) { return j({ error: 'body JSON tidak valid' }, 400); }
    const action = String(body.action || '');
    const email = String(body.email || '').trim().toLowerCase();
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return j({ error: 'email akun Clincoo tidak valid' }, 400);
    await ensureTables(db);

    if (action === 'lookup') {
      const userKey = await userKeyByEmail(db, email);
      return j({ exists: !!userKey, user_key: userKey || null, email });
    }

    if (action === 'balance') {
      const userKey = await userKeyByEmail(db, email);
      if (!userKey) return j({ exists: false, user_key: null }, 404);
      const now = new Date();
      const day = now.toISOString().slice(0, 10);
      const month = now.toISOString().slice(0, 7);
      let dailyUsed = 0, monthlyUsed = 0;
      try {
        const rows = await db.prepare('SELECT day, count FROM ai_quota WHERE user_key = ? AND day IN (?, ?)').bind(userKey, day, month).all();
        for (const r of rows.results || []) {
          if (r.day === day) dailyUsed = r.count || 0;
          if (r.day === month) monthlyUsed = r.count || 0;
        }
      } catch (e) {}
      const nowIso = now.toISOString();
      const packs = await db.prepare(
        'SELECT id, pack_id, name, credits_left, credits_total, expires_at FROM ai_packs WHERE user_key = ? AND credits_left > 0 AND expires_at > ? ORDER BY expires_at ASC'
      ).bind(userKey, nowIso).all();
      const list = packs.results || [];
      return j({
        exists: true, user_key: userKey, email,
        quota: { used_today: dailyUsed, used_month: monthlyUsed },
        packs: { credits_left: list.reduce((s, p) => s + (p.credits_left || 0), 0), active: list }
      });
    }

    if (action === 'grant') {
      const txn = String(body.txn || '').trim();
      const amount = Math.floor(Number(body.amount || 0));
      const days = Math.max(1, Math.min(365, Math.floor(Number(body.days || DEFAULT_DAYS) || DEFAULT_DAYS)));
      if (!txn || txn.length < 4 || txn.length > 100) return j({ error: 'txn tidak valid' }, 400);
      if (!amount || amount < MIN_AMOUNT || amount > MAX_AMOUNT) return j({ error: 'nominal harus Rp 1.000 – Rp 100.000.000' }, 400);
      const userKey = await userKeyByEmail(db, email);
      if (!userKey) return j({ error: 'Akun Clincoo dengan email tersebut tidak ditemukan.', exists: false }, 404);
      const credits = creditsOf(amount); // dihitung server, klien tidak bisa mengatur jumlah kredit
      if (credits < 1) return j({ error: 'nominal terlalu kecil' }, 400);

      // Klaim atomik per txn — webhook/ulang kapan pun tetap sekali grant.
      const claim = await db.prepare(
        'INSERT OR IGNORE INTO ai_bridge_orders (txn, user_key, email, amount, credits) VALUES (?, ?, ?, ?, ?)'
      ).bind(txn, userKey, email, amount, credits).run();
      if (!claim.meta || !claim.meta.changes) {
        return j({ granted: false, already: true, user_key: userKey, credits, txn });
      }
      const now = new Date();
      const expires = new Date(now.getTime() + days * 86400_000);
      await db.prepare(
        'INSERT INTO ai_packs (user_key, pack_id, name, price, credits_total, credits_left, purchased_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).bind(userKey, 'topup', 'Top-up Kredit AI (QRIS)', amount, credits, credits, now.toISOString(), expires.toISOString()).run();
      try {
        await db.prepare("INSERT INTO activity_log (action, details) VALUES (?, ?)")
          .bind('ai_bridge_grant', 'Top-up QRIS ' + txn + ': Rp' + amount + ' -> ' + credits + ' kredit untuk ' + userKey).run();
      } catch (e) {}
      return j({ granted: true, user_key: userKey, credits, amount, days, expires_at: expires.toISOString(), txn });
    }

    return j({ error: 'action tidak dikenal (lookup | balance | grant)' }, 400);
  } catch (err) {
    return j({ error: err.message }, 500);
  }
}

export async function onRequestGet() { return j({ error: 'gunakan POST' }, 405); }
