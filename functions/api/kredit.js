// Cloudflare Pages Function — /api/kredit
// Data KREDIT AI user yang login, real-time, untuk halaman sidebar "Kredit"
// (copy dashboard kredit-ai.pages.dev ke dalam app Clincoo — arahan pemilik, 8 Okt 2026).
//
// [8 Okt 2026, revisi pemilik] Histori TIDAK menyebut nama provider/model.
// Tabel dibuat lebih lengkap: transaksi + sisa/status/masa aktif, chat
// dikelompokkan per hari (pesan + kredit), integrasi per fitur Clincoo.
//
// GET /api/kredit  (Bearer token, via auth-client.js)
//   {
//     email, saldo, terpakai,
//     riwayat:  [{ sumber, kredit, sisa, harga, status, waktu, hingga }],
//     chatHarian: [{ tanggal, pesan, kredit }],
//     integrasi: [{ nama, status, pesan, kredit }]
//   }
//
// Tabel sumber: ai_packs (perolehan), ai_usage (pemakaian per pesan) —
// sama persis dengan yang dipakai /api/chat, jadi angka selalu sinkron.

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

const TZ = 'Asia/Jakarta';
function fmtTanggal(d) { return d.toLocaleDateString('id-ID', { day: 'numeric', month: 'short', timeZone: TZ }); }
function fmtTanggalPanjang(d) { return d.toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric', timeZone: TZ }); }
function fmtJam(d) { return d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', timeZone: TZ }); }
function fmtIDR(n) { return 'Rp' + Number(n || 0).toLocaleString('id-ID'); }

export async function onRequestGet({ request, env }) {
  const db = env.DB;
  if (!db) return j({ error: 'D1 not bound' }, 500);
  try {
    const user = await currentUser(env, request);
    if (!user) return j({ error: 'Silakan login terlebih dahulu', need_login: true }, 401);
    const userKey = 'u' + user.id;
    const now = new Date();

    // ---- Saldo: total kredit tersisa dari paket aktif (sumber = /api/chat) ----
    let allPacks = [];
    try {
      const r = await db.prepare(
        'SELECT id, pack_id, name, price, credits_total, credits_left, purchased_at, expires_at FROM ai_packs WHERE user_key = ? ORDER BY purchased_at DESC LIMIT 100'
      ).bind(userKey).all();
      allPacks = r.results || [];
    } catch (e) {}
    const saldo = allPacks
      .filter(p => (p.credits_left || 0) > 0 && p.expires_at && new Date(p.expires_at) > now)
      .reduce((s, p) => s + (p.credits_left || 0), 0);

    // ---- Riwayat transaksi (tab Transaksi) — tanpa nama provider ----
    const riwayat = allPacks.map(p => {
      let sumber = 'Paket Kredit';
      if (p.pack_id === 'starter') sumber = 'Bonus Percobaan';
      else if (p.pack_id === 'topup') sumber = 'Top Up QRIS';
      else if (Number(p.price) === 0) sumber = 'Bonus';
      const aktif = (p.credits_left || 0) > 0 && p.expires_at && new Date(p.expires_at) > now;
      const status = aktif ? 'Aktif' : ((p.credits_left || 0) <= 0 ? 'Habis' : 'Kedaluwarsa');
      const d = p.purchased_at ? new Date(p.purchased_at) : null;
      return {
        sumber,
        kredit: p.credits_total || 0,
        sisa: p.credits_left || 0,
        harga: Number(p.price) > 0 ? fmtIDR(p.price) : 'Gratis',
        status,
        waktu: d ? (fmtTanggal(d) + ' · ' + fmtJam(d)) : '',
        hingga: aktif ? fmtTanggalPanjang(new Date(p.expires_at)) : ''
      };
    });

    // ---- Pemakaian: total, per hari (tab Chat) ----
    let usage = [];
    try {
      const r = await db.prepare(
        'SELECT ts, cost FROM ai_usage WHERE user_key = ? ORDER BY ts DESC LIMIT 500'
      ).bind(userKey).all();
      usage = r.results || [];
    } catch (e) {}
    let terpakai = 0;
    try {
      const r = await db.prepare('SELECT SUM(cost) AS t FROM ai_usage WHERE user_key = ?').bind(userKey).first();
      terpakai = (r && r.t) || 0;
    } catch (e) {}

    const perHari = new Map(); // key: yyyy-mm-dd (Asia/Jakarta)
    usage.forEach(u => {
      const d = new Date(u.ts);
      const key = d.toLocaleDateString('en-CA', { timeZone: TZ }); // yyyy-mm-dd
      let e = perHari.get(key);
      if (!e) { e = { _d: d, tanggal: fmtTanggal(d), pesan: 0, kredit: 0 }; perHari.set(key, e); }
      e.pesan++;
      e.kredit += u.cost || 0;
    });
    const chatHarian = Array.from(perHari.values())
      .sort((a, b) => b._d - a._d)
      .slice(0, 30)
      .map(e => ({ tanggal: e.tanggal, pesan: e.pesan, kredit: e.kredit }));

    // ---- Integrasi AI (tab): per fitur Clincoo — TANPA nama provider ----
    let totalPesan = 0;
    let terakhirTs = 0;
    try {
      const r = await db.prepare('SELECT COUNT(*) AS c, MAX(ts) AS m FROM ai_usage WHERE user_key = ?').bind(userKey).first();
      totalPesan = (r && r.c) || 0;
      terakhirTs = (r && r.m) || 0;
    } catch (e) {}
    const integrasi = totalPesan ? [{
      nama: 'Chat Clincoo',
      status: terakhirTs && (now - new Date(terakhirTs)) < 7 * 86400_000 ? 'Aktif' : 'Nonaktif',
      pesan: totalPesan,
      kredit: terpakai
    }] : [];

    return j({
      success: true,
      email: String(user.email || '').toLowerCase(),
      saldo,
      terpakai,
      riwayat,
      chatHarian,
      integrasi
    });
  } catch (e) {
    return j({ error: 'Gagal memuat data kredit' }, 500);
  }
}
