// Cloudflare Pages Function — /api/template-purchase
// Beli template premium (AI Router Console) pakai saldo kredit AI (arahan pemilik, 8 Okt 2026).
// Harga 15.000 kredit per template; sekali beli terbuka selamanya untuk akun.
// Berlaku untuk SEMUA paket (Pro & Bisnis juga wajib bayar). saas/properti = khusus paket Pro, tanpa beli.
//
// GET  /api/template-purchase  → { price, pro_templates: [...], purchased: [...] }
// POST /api/template-purchase { key }
//      → { ok: true, already: true }  kalau sudah pernah dibeli
//      → { ok: true, saldo }           setelah potong kredit
//      → 402 { error: 'Saldo kredit tidak cukup', saldo }  kalau kurang

import { currentUser } from './user-scope.js';
import { getActivePacks, consumePackCredit } from './ai-packs.js';

// [8 Okt 2026, arahan pemilik] Harga AI Router Console: Rp25.000 dasar (Pro −Rp5.000, Bisnis Rp15.000).
// Konversi: Rp1.000 = 100 kredit → kredit = rupiah / 10. Server pegang harga resmi per paket user.
const BASE_CREDITS = 2500;
const PLAN_CREDITS = { Starter: 2500, Pro: 2000, Bisnis: 1500 };
const PLAN_RP = { Starter: 25000, Pro: 20000, Bisnis: 15000 };

async function userPlan(db, userId) {
  try {
    const row = await db.prepare('SELECT value FROM subscription WHERE key = ?').bind('u' + userId + ':plan').first();
    const plan = row && row.value ? row.value : 'Starter';
    return PLAN_CREDITS[plan] ? plan : 'Starter';
  } catch (e) { return 'Starter'; }
}
const PRO_KEYS = ['ai-router']; // template bayar-kredit (semua paket); saas/properti khusus paket Pro

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

function j(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS } });
}

async function ensurePurchaseTable(db) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS template_purchases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_key TEXT NOT NULL,
    template_key TEXT NOT NULL,
    price_credits INTEGER NOT NULL,
    purchased_at TEXT
  )`).run();
  try { await db.prepare('CREATE INDEX IF NOT EXISTS idx_tpl_purchases_user ON template_purchases(user_key, template_key)').run(); } catch (e) {}
}

async function listPurchased(db, userKey) {
  try {
    await ensurePurchaseTable(db);
    const r = await db.prepare('SELECT template_key FROM template_purchases WHERE user_key = ?').bind(userKey).all();
    return (r.results || []).map(x => x.template_key);
  } catch (e) { return []; }
}

async function saldoKredit(db, userKey) {
  const packs = await getActivePacks(db, userKey);
  return packs.reduce((s, p) => s + (p.credits_left || 0), 0);
}

export async function onRequestOptions() { return new Response(null, { status: 204, headers: CORS }); }

// [8 Okt 2026, arahan pemilik] Akun berikut boleh pakai template kredit (AI Router) GRATIS:
// dianggap sudah "memiliki" semua template kredit tanpa memotong saldo.
const FREE_ACCESS_EMAILS = new Set(['devconium@gmail.com']);

export async function onRequestGet({ request, env }) {
  const db = env.DB;
  if (!db) return j({ error: 'D1 not bound' }, 500);
  try {
    const user = await currentUser(env, request);
    if (!user) return j({ error: 'Silakan login terlebih dahulu', need_login: true }, 401);
    let purchased = await listPurchased(db, 'u' + user.id);
    if (FREE_ACCESS_EMAILS.has(String(user.email || '').toLowerCase())) {
      const merged = purchased.slice();
      for (const k of PRO_KEYS) if (merged.indexOf(k) === -1) merged.push(k);
      purchased = merged;
    }
    const plan = await userPlan(db, user.id);
    return j({ price: PLAN_CREDITS[plan], base: BASE_CREDITS, plan, price_rp: PLAN_RP[plan], pro_templates: PRO_KEYS, purchased });
  } catch (e) {
    return j({ error: 'Gagal memuat data pembelian template' }, 500);
  }
}

export async function onRequestPost({ request, env }) {
  const db = env.DB;
  if (!db) return j({ error: 'D1 not bound' }, 500);
  try {
    const user = await currentUser(env, request);
    if (!user) return j({ error: 'Silakan login terlebih dahulu', need_login: true }, 401);
    const userKey = 'u' + user.id;

    let body = {};
    try { body = await request.json() || {}; } catch (e) {}
    const key = String(body.key || '');

    if (PRO_KEYS.indexOf(key) === -1) return j({ error: 'Template tidak dikenal / bukan template PRO' }, 400);

    const purchased = await listPurchased(db, userKey);
    if (purchased.indexOf(key) !== -1) return j({ ok: true, already: true, purchased });
    // allowlist gratis: tandai punya tanpa memotong saldo
    if (FREE_ACCESS_EMAILS.has(String(user.email || '').toLowerCase())) {
      try {
        await db.prepare('INSERT INTO template_purchases (user_key, template_key, price_credits, purchased_at) VALUES (?, ?, 0, datetime(\'now\'))')
          .bind(userKey, key).run();
      } catch (e) {}
      return j({ ok: true, key, free_access: true, purchased: await listPurchased(db, userKey) });
    }

    const plan = await userPlan(db, user.id);
    const PRICE = PLAN_CREDITS[plan];

    const saldo = await saldoKredit(db, userKey);
    if (saldo < PRICE) {
      return j({ error: 'Saldo kredit tidak cukup', saldo, price: PRICE, base: BASE_CREDITS }, 402);
    }

    const res = await consumePackCredit(db, userKey, PRICE);
    if (!res || !res.ok) return j({ error: 'Gagal memotong kredit — coba lagi', saldo }, 500);

    await ensurePurchaseTable(db);
    await db.prepare(
      'INSERT INTO template_purchases (user_key, template_key, price_credits, purchased_at) VALUES (?, ?, ?, ?)'
    ).bind(userKey, key, PRICE, new Date().toISOString()).run();

    const saldoSisa = await saldoKredit(db, userKey);
    return j({ ok: true, key, saldo: saldoSisa, purchased: await listPurchased(db, userKey) });
  } catch (e) {
    return j({ error: 'Gagal memproses pembelian' }, 500);
  }
}
