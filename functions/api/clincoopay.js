// API ClincooPay — hubungkan / putuskan dompet web Wallet milik akun Clincoo
// GET  /api/clincoopay            -> status koneksi
// POST /api/clincoopay {action:'link', wallet_address, pin}  -> verifikasi PIN di server wallet, simpan token koneksi
// POST /api/clincoopay {action:'unlink'}                    -> putuskan
import { currentUser } from './user-scope.js';
import { ensureCpTable, getCpConnection, mirroredBalance, WALLET_API } from './clincoopay-helpers.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};
function j(data, status) {
  return new Response(JSON.stringify(data), { status: status || 200, headers: { 'Content-Type': 'application/json', ...CORS } });
}
export async function onRequestOptions() { return new Response(null, { headers: CORS }); }

export async function onRequestGet({ request, env }) {
  try {
    const db = env.DB;
    const user = await currentUser(env, request);
    if (!db) return j({ error: 'D1 not bound' }, 500);
    if (!user) return j({ connected: false });
    const conn = await getCpConnection(db, user.id);
    if (!conn) return j({ connected: false });
    const bal = await mirroredBalance(conn);
    return j({ connected: true, wallet_address: conn.wallet_address, wallet_balance: bal });
  } catch (err) {
    return j({ error: err.message }, 500);
  }
}

export async function onRequestPost({ request, env }) {
  const db = env.DB;
  if (!db) return j({ error: 'D1 not bound' }, 500);
  try {
    const body = await request.json();
    const action = body.action || '';
    const user = await currentUser(env, request);
    if (!user) return j({ error: 'Login diperlukan', need_login: true }, 401);
    await ensureCpTable(db);

    // ---- alur koneksi baru: ID wallet → konfirmasi di aplikasi Wallet → PIN ----
    if (action === 'connect_start') {
      const walletId = String(body.wallet_id || '').trim();
      if (!/^[A-Za-z0-9]{10}$/.test(walletId)) return j({ error: 'ID Wallet tidak valid — harus 10 karakter huruf/angka.' }, 400);
      const r = await fetch(WALLET_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'connect_request', wallet_id: walletId, app: 'clincoo' })
      });
      const d = await r.json().catch(() => ({}));
      if (!d || !d.success) return j({ error: (d && d.error) || 'Gagal mengirim permintaan ke Wallet.' }, 404);
      return j({ success: true, request_id: d.request_id });
    }

    if (action === 'connect_status') {
      const rid = String(body.request_id || '').slice(0, 40);
      const r = await fetch(WALLET_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'connect_status', request_id: rid })
      });
      const d = await r.json().catch(() => ({}));
      if (!d || !d.success) return j({ error: (d && d.error) || 'Gagal memeriksa status permintaan.' }, 404);
      return j({ success: true, status: d.status });
    }

    if (action === 'connect_finish') {
      const rid = String(body.request_id || '').slice(0, 40);
      const pin = String(body.pin || '').trim();
      if (!rid) return j({ error: 'Permintaan tidak valid' }, 400);
      if (!/^\d{6}$/.test(pin)) return j({ error: 'PIN harus 6 digit angka.' }, 400);
      const r = await fetch(WALLET_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'connect_finalize', request_id: rid, pin: pin, app: 'clincoo' })
      });
      const d = await r.json().catch(() => ({}));
      if (!d || !d.success) return j({ error: (d && d.error) || 'Gagal menghubungkan dompet.' }, 401);
      if (!d.address) return j({ error: 'Respons Wallet tidak valid' }, 502);
      await db.prepare('DELETE FROM clincoopay_connections WHERE user_id = ?').bind(user.id).run();
      await db.prepare('INSERT INTO clincoopay_connections (user_id, wallet_address, token) VALUES (?, ?, ?)')
        .bind(user.id, d.address, d.token).run();
      return j({ success: true, connected: true, wallet_address: d.address, wallet_balance: Number(d.balance) || 0 });
    }

    if (action === 'unlink') {
      await db.prepare('DELETE FROM clincoopay_connections WHERE user_id = ?').bind(user.id).run();
      return j({ success: true, connected: false });
    }

    return j({ error: 'Aksi tidak dikenal' }, 400);
  } catch (err) {
    return j({ error: err.message }, 500);
  }
}
