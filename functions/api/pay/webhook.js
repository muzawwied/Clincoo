// Webhook dari Pakasir (API v2): POST /api/pay/webhook
// Body: {txn_id, order_id, amount, is_sandbox, status, completed_at} + header X-Secret.
// URL ini diisi di halaman detail proyek Pakasir (kolom Webhook URL).
import { forwardPayWebhook } from './index.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Secret'
};

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestPost({ request, env }) {
  const db = env.DB;
  if (!db) return new Response(JSON.stringify({ error: 'D1 not bound' }), { status: 500, headers: { 'Content-Type': 'application/json', ...CORS } });

  let body = {};
  try { body = await request.json(); } catch (e) {
    return new Response(JSON.stringify({ error: 'body JSON tidak valid' }), { status: 400, headers: { 'Content-Type': 'application/json', ...CORS } });
  }

  // verifikasi keaslian webhook (opsional: aktif jika PAKASIR_WEBHOOK_SECRET diset)
  if (env.PAKASIR_WEBHOOK_SECRET) {
    const secret = request.headers.get('X-Secret') || '';
    if (secret !== env.PAKASIR_WEBHOOK_SECRET) {
      return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json', ...CORS } });
    }
  }

  const txnId = String(body.txn_id || '').trim();
  const orderId = String(body.order_id || '').trim();
  if (!txnId && !orderId) {
    return new Response(JSON.stringify({ error: 'txn_id/order_id wajib diisi' }), { status: 400, headers: { 'Content-Type': 'application/json', ...CORS } });
  }

  // cari transaksi ClincooPay: prioritas txn_id provider (trx_ref), fallback order_id internal
  let tx = txnId ? await db.prepare('SELECT * FROM pay_transactions WHERE trx_ref = ?').bind(txnId).first() : null;
  if (!tx && orderId) tx = await db.prepare('SELECT * FROM pay_transactions WHERE order_id = ?').bind(orderId).first();
  if (!tx) {
    return new Response(JSON.stringify({ error: 'transaksi tidak ditemukan' }), { status: 404, headers: { 'Content-Type': 'application/json', ...CORS } });
  }

  const st = String(body.status || '').toLowerCase() === 'completed' ? 'paid' : 'pending';
  if (st !== tx.status) {
    await db.prepare('UPDATE pay_transactions SET status = ?, updated_at = datetime(\'now\') WHERE id = ?').bind(st, tx.id).run();
  }
  await forwardPayWebhook(db, tx, st);

  return new Response(JSON.stringify({ success: true, status: st }), { status: 200, headers: { 'Content-Type': 'application/json', ...CORS } });
}
