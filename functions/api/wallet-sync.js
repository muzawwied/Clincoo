// Cloudflare Pages Functions — Backend data WEB WALLET (mandiri)
//
// Data wallet web disimpan di tabelnya SENDIRI di D1 (wallet_web_balance,
// wallet_web_transactions, wallet_web_notifications) — terpisah penuh dari
// data dompet Clincoo (wallet_balance / wallet_transactions) dan tidak
// terhubung ke akun Clincoo sama sekali.
//
// Identitas wallet = alamat wallet (0x + 40 hex) yang digenerate per
// perangkat di web wallet dan tersimpan di localStorage-nya.
//
// GET  /api/wallet-sync?action=external_pull&addr=0x..  -> snapshot wallet terbaru
// POST /api/wallet-sync  { action:'external_push', addr, data }  -> simpan saldo+transaksi
// POST /api/wallet-sync  { action:'external_read', addr, id }     -> tandai notifikasi dibaca
//
// Protokol data: { balance: number, transactions: [{ id?, title, amount, type:'in'|'out', method? }] }
// Notifikasi wallet dibuat OTOMATIS di server untuk transaksi baru (transfer keluar / saldo masuk).

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

function j(data, status) {
  return new Response(JSON.stringify(data), { status: status || 200, headers: { 'Content-Type': 'application/json', ...CORS } });
}

export async function onRequestOptions() { return new Response(null, { headers: CORS }); }

function validAddr(a) {
  return typeof a === 'string' && /^0x[0-9a-f]{16,64}$/i.test(a);
}

async function ensureTables(db) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS wallet_web_balance (
    addr TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT '0'
  )`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS wallet_web_transactions (
    id TEXT PRIMARY KEY,
    addr TEXT NOT NULL,
    title TEXT,
    amount REAL,
    type TEXT,
    method TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS wallet_web_notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    addr TEXT NOT NULL,
    source TEXT,
    message TEXT,
    type TEXT DEFAULT 'info',
    read INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  )`).run();
}

async function snapshot(db, addr) {
  const bal = await db.prepare('SELECT value FROM wallet_web_balance WHERE addr = ?').bind(addr).first();
  const txRes = await db.prepare('SELECT * FROM wallet_web_transactions WHERE addr = ? ORDER BY created_at DESC, id DESC LIMIT 100').bind(addr).all();
  const nRes = await db.prepare('SELECT * FROM wallet_web_notifications WHERE addr = ? ORDER BY created_at DESC, id DESC LIMIT 20').bind(addr).all();
  return {
    balance: parseFloat(bal?.value || '0'),
    transactions: txRes.results || [],
    notifications: (nRes.results || []).map(n => ({
      id: n.id, source: n.source, message: n.message, type: n.type || 'info', read: n.read || 0, created_at: n.created_at
    }))
  };
}

export async function onRequestGet({ request, env }) {
  const db = env.DB;
  if (!db) return j({ error: 'D1 not bound' }, 500);
  try {
    const url = new URL(request.url);
    if (url.searchParams.get('action') === 'external_pull') {
      const addr = (url.searchParams.get('addr') || '').trim();
      if (!validAddr(addr)) return j({ error: 'Alamat wallet tidak valid' }, 400);
      await ensureTables(db);
      const snap = await snapshot(db, addr);
      return j({ synced_at: new Date().toISOString(), data: snap });
    }
    return j({ error: 'Aksi tidak dikenal' }, 400);
  } catch (err) { return j({ error: err.message }, 500); }
}

export async function onRequestPost({ request, env }) {
  const db = env.DB;
  if (!db) return j({ error: 'D1 not bound' }, 500);
  try {
    const body = await request.json();
    const addr = String(body.addr || '').trim();
    if (!validAddr(addr)) return j({ error: 'Alamat wallet tidak valid' }, 400);
    await ensureTables(db);

    // Simpan saldo + transaksi dari web wallet (upsert berbasis id, tanpa duplikat)
    if (body.action === 'external_push') {
      const data = body.data || {};

      if (data.balance != null) {
        const bal = parseFloat(data.balance);
        if (!isNaN(bal)) {
          await db.prepare('INSERT INTO wallet_web_balance (addr, value) VALUES (?, ?) ON CONFLICT(addr) DO UPDATE SET value = excluded.value')
            .bind(addr, String(bal)).run();
        }
      }

      let newNotifs = 0;
      if (Array.isArray(data.transactions)) {
        for (const t of data.transactions.slice(0, 200)) {
          if (!t || t.title == null || t.amount == null) continue;
          const amount = parseFloat(t.amount);
          if (isNaN(amount)) continue;
          const title = String(t.title);
          const type = (t.type === 'out') ? 'out' : 'in';
          const method = String(t.method || 'wallet');

          // Upsert berbasis ID: id dari web wallet dipertahankan (tanpa duplikat).
          // Guard kepemilikan: id yang sudah dipakai alamat lain => pakai id baru.
          let txId = (t.id != null && String(t.id)) ? String(t.id) : null;
          if (txId) {
            const existing = await db.prepare('SELECT addr FROM wallet_web_transactions WHERE id = ?').bind(txId).first();
            if (existing && existing.addr !== addr) txId = null; // id dipakai alamat lain -> id baru
            else if (existing) {
              // Transaksi lama: update saja, created_at dipertahankan, tanpa notifikasi
              await db.prepare(`INSERT INTO wallet_web_transactions (id, addr, title, amount, type, method)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET title = excluded.title, amount = excluded.amount, type = excluded.type, method = excluded.method`)
                .bind(txId, addr, title, amount, type, method).run();
              continue;
            } else {
              // Transaksi baru ber-ID -> simpan + notifikasi otomatis
              await db.prepare('INSERT INTO wallet_web_transactions (id, addr, title, amount, type, method) VALUES (?, ?, ?, ?, ?, ?)')
                .bind(txId, addr, title, amount, type, method).run();
              if (newNotifs < 5) {
                newNotifs++;
                const msg = (type === 'in')
                  ? 'Saldo masuk Rp ' + amount.toLocaleString('id-ID') + ' - ' + title
                  : 'Transfer keluar Rp ' + amount.toLocaleString('id-ID') + ' - ' + title;
                await db.prepare('INSERT INTO wallet_web_notifications (addr, source, message, type) VALUES (?, ?, ?, ?)')
                  .bind(addr, 'Wallet', msg, type).run();
              }
              continue;
            }
          }
          // Push tanpa id: hindari duplikat judul+nominal (idempotensi ringan)
          const dup = await db.prepare('SELECT id FROM wallet_web_transactions WHERE addr = ? AND title = ? AND amount = ? LIMIT 1')
            .bind(addr, title, amount).first();
          if (dup) continue;
          txId = 'TX-' + Date.now() + '-' + Math.floor(1000 + Math.random() * 9000);
          await db.prepare('INSERT INTO wallet_web_transactions (id, addr, title, amount, type, method) VALUES (?, ?, ?, ?, ?, ?)')
            .bind(txId, addr, title, amount, type, method).run();
          // Notifikasi otomatis untuk transaksi baru (maks 5 per push)
          if (newNotifs < 5) {
            newNotifs++;
            const msg = (type === 'in')
              ? 'Saldo masuk Rp ' + amount.toLocaleString('id-ID') + ' - ' + title
              : 'Transfer keluar Rp ' + amount.toLocaleString('id-ID') + ' - ' + title;
            await db.prepare('INSERT INTO wallet_web_notifications (addr, source, message, type) VALUES (?, ?, ?, ?)')
              .bind(addr, 'Wallet', msg, type).run();
          }
        }
        // Replace penuh tanpa saldo eksplisit -> hitung ulang dari transaksi
        if (data.replace && data.balance == null) {
          const res = await db.prepare("SELECT COALESCE(SUM(CASE WHEN type='in' THEN amount ELSE -amount END), 0) AS b FROM wallet_web_transactions WHERE addr = ?").bind(addr).first();
          await db.prepare('INSERT INTO wallet_web_balance (addr, value) VALUES (?, ?) ON CONFLICT(addr) DO UPDATE SET value = excluded.value')
            .bind(addr, String(res?.b || 0)).run();
        }
      }

      const snap = await snapshot(db, addr);
      return j({ success: true, synced_at: new Date().toISOString(), data: snap });
    }

    // Tandai notifikasi wallet sudah dibaca
    if (body.action === 'external_read') {
      const nid = parseInt(body.id, 10);
      if (!nid) return j({ error: 'id notifikasi tidak valid' }, 400);
      await db.prepare('UPDATE wallet_web_notifications SET read = 1 WHERE id = ? AND addr = ?').bind(nid, addr).run();
      return j({ success: true });
    }

    return j({ error: 'Aksi tidak dikenal' }, 400);
  } catch (err) { return j({ error: err.message }, 500); }
}
