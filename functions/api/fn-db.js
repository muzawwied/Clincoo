// Cloudflare Pages Function — /api/fn-db (BRIDGE DATABASE untuk backend function)
// Dipanggil oleh runner Node.js di sandbox E2B (bukan oleh browser): shim `db`
// di dalam kode function user memanggil endpoint ini. Keamanan:
//   - token HMAC-SHA256 (dibuat server per invoke, kedaluwarsa 10 menit),
//     payload memuat user_key -> akses DIPERSEMPIT ke data user itu sendiri;
//   - TIDAK menerima token login user biasa (sandbox tidak pernah melihat
//     kredensial user);
//   - rate limit bridge 600/5 menit per user (invoke sudah dibatasi terpisah);
//   - kuota paket (rows/bytes) tetap dipegang makeDb di fns.js.
// Tanpa CORS: endpoint internal server-to-server.

import { makeDb, getPlan } from './fns.js';

const MAX_K = 512;
const MAX_V_BYTES = 100_000;
const OPS = new Set(['get', 'set', 'del', 'list', 'count']);

function b64urlDecode(s) {
  s = String(s || '').replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return atob(s);
}
function hex(a) {
  return [...new Uint8Array(a)].map(b => b.toString(16).padStart(2, '0')).join('');
}
function json(obj, status) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: { 'Content-Type': 'application/json' } });
}
async function getBridgeSecret(DB) {
  await DB.prepare('CREATE TABLE IF NOT EXISTS fn_bridge (k TEXT PRIMARY KEY, v TEXT)').run();
  const row = await DB.prepare('SELECT v FROM fn_bridge WHERE k = ?').bind('secret').first();
  return row?.v || '';
}

async function verifyToken(DB, t) {
  try {
    const parts = String(t || '').split('.');
    if (parts.length !== 2) return null;
    const secret = await getBridgeSecret(DB);
    if (!secret) return null;
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(parts[0]));
    const expect = hex(sig);
    // bandingkan panjang dulu lalu isi (mitigasi timing)
    if (expect.length !== parts[1].length || expect !== parts[1]) return null;
    const payload = JSON.parse(b64urlDecode(parts[0]));
    if (!payload || !payload.u || !payload.exp || Date.now() > payload.exp) return null;
    return payload;
  } catch (e) { return null; }
}

async function bridgeRateLimit(DB, userKey) {
  try {
    const window = Math.floor(Date.now() / (5 * 60 * 1000));
    await DB.prepare('CREATE TABLE IF NOT EXISTS rl_fn (k TEXT PRIMARY KEY, c INTEGER DEFAULT 0)').run();
    const row = await DB.prepare('SELECT c FROM rl_fn WHERE k = ?').bind('bridge|' + userKey + '|' + window).first();
    const count = (row?.c || 0) + 1;
    if (!row) await DB.prepare('INSERT INTO rl_fn (k, c) VALUES (?, 1)').bind('bridge|' + userKey + '|' + window).run();
    else await DB.prepare('UPDATE rl_fn SET c = ? WHERE k = ?').bind(count, 'bridge|' + userKey + '|' + window).run();
    if (count === 1) {
      try { await DB.prepare("DELETE FROM rl_fn WHERE k LIKE ?").bind('bridge|' + userKey + '|' + (window - 1) + '%').run(); } catch (e) {}
    }
    return count <= 600;
  } catch (e) { return true; }
}

export async function onRequestPost({ request, env }) {
  if (!env || !env.DB) return json({ error: 'Database tidak tersedia' }, 500);
  let body = {};
  try { body = await request.json(); } catch (e) { return json({ error: 'Body JSON tidak valid' }, 400); }
  const op = String(body.op || '');
  if (!OPS.has(op)) return json({ error: 'Op tidak dikenal: get|set|del|list|count' }, 400);
  const payload = await verifyToken(env.DB, body.t);
  if (!payload) return json({ error: 'Token bridge tidak valid atau kedaluwarsa.' }, 403);
  if (!(await bridgeRateLimit(env.DB, payload.u))) return json({ error: 'Terlalu banyak operasi database. Coba lagi sebentar.' }, 429);
  try {
    const plan = await getPlan(env.DB, payload.u);
    // Database tanpa server (bagian Backend functions) = paket Bisnis —
    // ditegakkan di server untuk semua operasi (get/set/del/list/count).
    if (plan !== 'Bisnis') return json({ error: 'Fitur ini hanya untuk paket Bisnis.', plan_gate: true, minPlan: 'Bisnis', plan: plan, upgrade_needed: true }, 403);
    const db = makeDb(env.DB, payload.u, plan);
    if (op === 'get') return json({ ok: 1, result: await db.get(String(body.k || '')) });
    if (op === 'set') {
      if (body.v === undefined) return json({ error: 'Nilai (v) wajib untuk set.' }, 400);
      const vs = (typeof body.v === 'string') ? body.v : JSON.stringify(body.v);
      if (vs.length > MAX_V_BYTES) return json({ error: 'Nilai db terlalu besar (maksimal 100KB per data).' }, 400);
      return json({ ok: 1, result: await db.set(String(body.k || ''), body.v) });
    }
    if (op === 'del') return json({ ok: 1, result: await db.del(String(body.k || '')) });
    if (op === 'list') return json({ ok: 1, result: await db.list(String(body.prefix || '')) });
    if (op === 'count') return json({ ok: 1, result: await db.count() });
  } catch (e) {
    return json({ error: (e && e.message) || 'Operasi database gagal.' });
  }
  return json({ error: 'Op tidak dikenal' }, 400);
}
