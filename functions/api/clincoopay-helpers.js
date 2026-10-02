// ClincooPay — jembatan saldo Clincoo ↔ web Wallet (backend wallet-muz, D1 wallet-db)
// Saldo terhubung 2 arah: wallet-muz jadi sumber kebenaran saldo; Clincoo baca live & tulis delta.
const WALLET_API = 'https://wallet-muz.pages.dev/api/wallet';
export { WALLET_API };

export async function ensureCpTable(db) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS clincoopay_connections (
    user_id TEXT PRIMARY KEY,
    wallet_address TEXT NOT NULL,
    token TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  )`).run();
}

// Koneksi ClincooPay milik user (null = belum terhubung)
export async function getCpConnection(db, uid) {
  if (!uid) return null;
  try {
    await ensureCpTable(db);
    const row = await db.prepare('SELECT wallet_address, token FROM clincoopay_connections WHERE user_id = ?').bind(uid).first();
    return row || null;
  } catch (e) { return null; }
}

// Saldo live web wallet (null = gagal fetch / tidak terhubung)
export async function mirroredBalance(conn) {
  if (!conn) return null;
  try {
    const r = await fetch(WALLET_API + '?action=state&address=' + encodeURIComponent(conn.wallet_address));
    const d = await r.json();
    if (d && d.success) return Number(d.balance) || 0;
  } catch (e) {}
  return null;
}

// Kirim mutasi saldo (delta +/-) ke web wallet — idempotent via txid unik per transaksi.
// Return { ok:true, balance } | { ok:false, error }
export async function mirrorDelta(conn, delta, note, txid) {
  if (!conn) return { ok: false, error: 'Dompet belum dihubungkan' };
  try {
    const r = await fetch(WALLET_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'external_delta',
        address: conn.wallet_address,
        token: conn.token,
        app: 'clincoo',
        delta: Math.round(delta),
        note: String(note || '').slice(0, 140),
        txid: String(txid || '').slice(0, 64)
      })
    });
    const d = await r.json().catch(() => ({}));
    if (d && d.success) return { ok: true, balance: Number(d.balance) || 0 };
    return { ok: false, error: (d && d.error) || 'Gagal sinkron ke ClincooPay' };
  } catch (e) {
    return { ok: false, error: 'Tidak dapat terhubung ke server ClincooPay' };
  }
}
