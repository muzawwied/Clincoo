// Cloudflare Pages Function — GET /api/promo
// Promo 100 User Pertama: 100 user pertama yang klaim dapat Paket Pro hanya Rp5.000/bulan
// (reguler Rp49.000, Bulanan saja). Kuota disimpan di tabel promo_early_pro
// (1 baris/user — PRIMARY KEY mencegah klaim ganda; counter = COUNT(*), max 100).
// Klaim slot dicatat SAAT checkout sukses (subscription.js) dengan cleanup bila pembayaran gagal.
import { currentUser } from './user-scope.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': '*'
};

export const PROMO_EARLY = { plan: 'Pro', billing: 'Bulanan', price: 5000, original: 49000, maxUsers: 100 };
// Promo hanya utk USER BARU: akun yang terdaftar mulai 17 Sep 2026 00:00 WIB (user lama tidak eligible).
export const PROMO_START = '2026-09-16T17:00:00.000Z';

export async function isPromoNewUser(db, user) {
  if (!user || !user.id) return false;
  try {
    const row = await db.prepare('SELECT created_at FROM auth_users WHERE id = ?').bind(user.id).first();
    if (!row || !row.created_at) return false;
    const d = new Date(String(row.created_at).replace(' ', 'T') + (String(row.created_at).includes('Z') ? '' : 'Z'));
    return !isNaN(d.getTime()) && d.getTime() >= new Date(PROMO_START).getTime();
  } catch (e) { return false; }
}

export async function ensurePromoTable(db) {
  await db.prepare('CREATE TABLE IF NOT EXISTS promo_early_pro (user_key TEXT PRIMARY KEY, claimed_at TEXT)').run();
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: { 'Content-Type': 'application/json', ...CORS } });
}

export async function onRequestGet({ request, env }) {
  const db = env.DB;
  if (!db) return json({ error: 'D1 not bound' }, 500);
  // [8 Okt 2026, arahan pemilik] Promo 100 User Pertama (Pro Rp5.000) DIHENTIKAN.
  // Harga paket Pro kembali harga asli (Rp49.000) di semua halaman. Endpoint tetap
  // ada supaya halaman lama tidak error, tapi selalu melaporkan promo tidak aktif.
  return json({
    success: true,
    active: false,
    name: 'Promo 100 User Pertama',
    plan: PROMO_EARLY.plan,
    billing: PROMO_EARLY.billing,
    price: PROMO_EARLY.price,
    original: PROMO_EARLY.original,
    total: PROMO_EARLY.maxUsers,
    claimed: PROMO_EARLY.maxUsers,
    remaining: 0,
    loggedIn: false,
    hasClaimed: false,
    newUser: false,
    eligible: false
  });
}

export async function onRequestOptions() {
  return new Response(null, { headers: CORS });
}
