// Cloudflare Pages Function — /api/kredit
// Data KREDIT AI user yang login, real-time, untuk halaman sidebar "Kredit"
// (copy dashboard kredit-ai.pages.dev ke dalam app Clincoo — arahan pemilik, 8 Okt 2026).
//
// GET /api/kredit  (Bearer token, via auth-client.js)
//   {
//     email, saldo, terpakai,
//     riwayat:  [{ kredit, metode, waktu, harga }],   // sumber perolehan kredit (ai_packs)
//     chatLog:  [{ judul, kredit, waktu }],           // pemakaian per pesan (ai_usage)
//     integrasi: [{ nama, status, kredit }],          // pemakaian per model/jalur AI
//     active_packs: [...]
//   }
//
// Tabel sumber: ai_packs (perolehan), ai_usage (pemakaian per pesan, kolom
// in_chars/out_chars/cost), sama persis dengan yang dipakai /api/chat —
// jadi angka di sini selalu sinkron dengan potongan kredit nyata.

import { currentUser } from './user-scope.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};
export async function onRequestOptions() { return new Response(null, { status: 204, headers: CORS }); }

function j(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS } });
}

function fmtWaktu(iso, tsMs) {
  const d = iso ? new Date(iso) : (tsMs ? new Date(tsMs) : new Date());
  if (isNaN(d)) return '';
  const tgl = d.toLocaleDateString('id-ID', { day: 'numeric', month: 'short' });
  const jam = d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
  return tgl + ' · ' + jam;
}
function fmtIDR(n) { return 'Rp' + Number(n || 0).toLocaleString('id-ID'); }

export async function onRequestGet({ request, env }) {
  const db = env.DB;
  if (!db) return j({ error: 'D1 not bound' }, 500);
  try {
    const user = await currentUser(env, request);
    if (!user) return j({ error: 'Silakan login terlebih dahulu', need_login: true }, 401);
    const userKey = 'u' + user.id;

    // ---- Saldo: total kredit tersisa dari paket aktif (sumber = /api/chat) ----
    const now = new Date();
    const nowIso = now.toISOString();
    let packs = [];
    try {
      const r = await db.prepare(
        'SELECT id, pack_id, name, price, credits_total, credits_left, purchased_at, expires_at FROM ai_packs WHERE user_key = ? AND credits_left > 0 AND expires_at > ? ORDER BY expires_at ASC'
      ).bind(userKey, nowIso).all();
      packs = r.results || [];
    } catch (e) {}
    const saldo = packs.reduce((s, p) => s + (p.credits_left || 0), 0);

    // ---- Riwayat perolehan kredit (kartu di tab Transaksi) ----
    let allPacks = [];
    try {
      const r = await db.prepare(
        'SELECT pack_id, name, price, credits_total, credits_left, purchased_at FROM ai_packs WHERE user_key = ? ORDER BY purchased_at DESC LIMIT 50'
      ).bind(userKey).all();
      allPacks = r.results || [];
    } catch (e) {}
    const riwayat = allPacks.map(p => {
      let metode = 'Paket Kredit';
      if (p.pack_id === 'starter') metode = 'Bonus Percobaan';
      else if (p.pack_id === 'topup') metode = 'Top Up QRIS';
      else if (Number(p.price) === 0) metode = 'Bonus';
      return {
        kredit: p.credits_total || 0,
        metode,
        waktu: fmtWaktu(p.purchased_at),
        harga: Number(p.price) > 0 ? fmtIDR(p.price) : 'Gratis'
      };
    });

    // ---- Pemakaian per pesan (tab Chat, style tabel) ----
    let usage = [];
    try {
      const r = await db.prepare(
        'SELECT model, in_chars, out_chars, cost, ts FROM ai_usage WHERE user_key = ? ORDER BY ts DESC LIMIT 30'
      ).bind(userKey).all();
      usage = r.results || [];
    } catch (e) {}
    let terpakai = 0;
    try {
      const r = await db.prepare('SELECT SUM(cost) AS t FROM ai_usage WHERE user_key = ?').bind(userKey).first();
      terpakai = (r && r.t) || 0;
    } catch (e) {}
    const chatLog = usage.map(u => ({
      judul: 'Chat AI · ' + (u.model || 'model'),
      kredit: u.cost || 0,
      waktu: fmtWaktu(null, u.ts)
    }));

    // ---- Pemakaian per model/jalur (tab Integrasi AI, style tabel) ----
    let byModel = [];
    try {
      const r = await db.prepare(
        'SELECT model, SUM(cost) AS total, MAX(ts) AS terakhir FROM ai_usage WHERE user_key = ? GROUP BY model ORDER BY total DESC LIMIT 20'
      ).bind(userKey).all();
      byModel = (r.results || []).map(m => ({
        nama: m.model || 'Lainnya',
        status: m.terakhir && (now - new Date(m.terakhir)) < 7 * 86400_000 ? 'Aktif' : 'Nonaktif',
        kredit: m.total || 0
      }));
    } catch (e) {}

    return j({
      success: true,
      email: String(user.email || '').toLowerCase(),
      saldo,
      terpakai,
      riwayat,
      chatLog,
      integrasi: byModel,
      active_packs: packs
    });
  } catch (e) {
    return j({ error: 'Gagal memuat data kredit' }, 500);
  }
}
