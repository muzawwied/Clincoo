// Cloudflare Pages Functions - Wallet Backend (per-account)
import { currentUser, scopedKey, rowScope } from './user-scope.js';
import { emailTemplate, formatIDR, sendEmail, notifyEvent, getUserByEmail } from './notify-helpers.js';
import { getCpConnection, mirroredBalance, mirrorDelta, WALLET_API } from './clinqoopay-helpers.js';
import { ADMIN_EMAILS } from './plan-helpers.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

function j(data, status) {
  return new Response(JSON.stringify(data), { status: status || 200, headers: { 'Content-Type': 'application/json', ...CORS } });
}

export async function onRequestOptions() { return new Response(null, { headers: CORS }); }

// Ambil secret dari env Pages atau tabel env_vars D1 (per-proyek, key global = project_id NULL)
async function getSecret(env, key) {
  if (env[key]) return env[key];
  try {
    const row = await env.DB.prepare("SELECT value FROM env_vars WHERE key = ? AND (project_id IS NULL OR project_id = '')").bind(key).first();
    if (row?.value) return row.value;
  } catch {}
  return null;
}

function isUserAdmin(user) {
  if (!user) return false;
  if (user.role === 'admin' || user.role === 'owner') return true;
  if (user.email && ADMIN_EMAILS.has(user.email.toLowerCase())) return true;
  return false;
}

// KEAMANAN SALDO (fix 21 Sep 2026): dulunya email di payload SAJA cukup untuk
// dianggap pemilik akun — siapa pun yang tahu email user (termasuk akun sendiri)
// bisa menambah transaksi "in" tanpa gateway = cetak saldo gratis. Sekarang
// fail-closed: identitas hanya dari sesi login, ATAU email + x-callback-token
// yang cocok dengan XENDIT_CALLBACK_TOKEN (callback gateway legacy Base44/Koda).
// Webhook Xendit asli tetap memakai /api/topup dengan verifikasi x-callback-token.
async function resolveOwner(env, request, body) {
  const u = await currentUser(env, request);
  if (u) return { user: u, callbackVerified: false };
  const cbToken = request.headers.get('x-callback-token');
  if (cbToken) {
    const expected = await getSecret(env, 'XENDIT_CALLBACK_TOKEN');
    if (expected && cbToken === expected) {
      const cands = [];
      if (body) {
        if (body.email) cands.push(body.email);
        if (body.payer_email) cands.push(body.payer_email);
      }
      for (const c of cands) {
        if (!c) continue;
        const found = await getUserByEmail(env.DB, c);
        if (found) return { user: found, callbackVerified: true };
      }
    }
  }
  return { user: null, callbackVerified: false };
}

// GET /api/wallet?action=transactions — list transaksi; GET /api/wallet — saldo
export async function onRequestGet({ request, env }) {
  const db = env.DB;
  if (!db) return j({ error: 'D1 not bound' }, 500);
  try {
    const url = new URL(request.url);
    const action = url.searchParams.get('action');
    const user = await currentUser(env, request);

    if (action === 'transactions') {
      const uid = await rowScope(db, 'wallet_transactions', user);
      if (!uid) return j({ transactions: [] }); // tanpa login: jangan bocorkan transaksi akun lain
      const txs = await db.prepare('SELECT * FROM wallet_transactions WHERE user_id = ? ORDER BY created_at DESC').bind(uid).all();
      let merged = (txs.results || []).map(function(t){ return { id: String(t.id), title: t.title, amount: Number(t.amount) || 0, type: t.type, method: t.method || '', created_at: t.created_at }; });
      if (url.searchParams.get('full') === '1' && user) {
        const conn = await getCpConnection(db, user.id);
        if (conn) {
          try {
            const r = await fetch(WALLET_API + '?action=transactions&address=' + encodeURIComponent(conn.wallet_address));
            const d = await r.json();
            const seen = new Set(merged.map(function(t){ return t.id; }));
            const remotes = (d && d.transactions) || [];
            for (const t of remotes) {
              const tid = t.id ? String(t.id) : ('cp-' + (t.date || '') + '-' + (t.amount || 0));
              if (seen.has(tid)) continue;
              seen.add(tid);
              merged.push({ id: tid, title: (t.note || t.name || 'Transaksi ClincooPay'), amount: Number(t.amount) || 0, type: (t.type === 'masuk') ? 'in' : 'out', method: 'ClincooPay', created_at: t.date });
            }
          } catch (e) {}
        }
      }
      merged.sort(function(a, b){
        const ta = new Date(String(a.created_at || '').replace(' ', 'T') + (String(a.created_at || '').length <= 10 ? 'T00:00:00' : '')).getTime() || 0;
        const tb = new Date(String(b.created_at || '').replace(' ', 'T') + (String(b.created_at || '').length <= 10 ? 'T00:00:00' : '')).getTime() || 0;
        return tb - ta;
      });
      return j({ transactions: merged });
    }

    if (!user) return j({ balance: 0 }); // tanpa login: jangan bocorkan saldo legacy bersama (key non-scoped)
    const balKey = await scopedKey(db, 'wallet_balance', user, 'balance');
    const row = await db.prepare('SELECT value FROM wallet_balance WHERE key = ?').bind(balKey).first();
    // ClincooPay: dompet terhubung → saldo live dari web Wallet (mirroring 2 arah, frontend tidak berubah)
    if (user) {
      const conn = await getCpConnection(db, user.id);
      if (conn) {
        const wb = await mirroredBalance(conn);
        if (wb !== null) return j({ balance: wb, mirrored: true, wallet_address: conn.wallet_address });
      }
    }
    return j({ balance: parseFloat(row?.value || '0') });
  } catch (err) {
    return j({ error: err.message }, 500);
  }
}


// POST /api/wallet — add_transaction | set_balance | clear_transactions
export async function onRequestPost({ request, env }) {
  const db = env.DB;
  if (!db) return j({ error: 'D1 not bound' }, 500);
  try {
    const body = await request.json();
    const action = body.action || 'add_transaction';
    const { user, callbackVerified } = await resolveOwner(env, request, body);
    const balKey = await scopedKey(db, 'wallet_balance', user, 'balance');
    const uid = user ? user.id : null;

    // Mutasi dompet wajib login — mencegah penulisan/penghapusan data lintas akun
    if (!uid) return j({ error: 'Login diperlukan', need_login: true }, 401);

    if (action === 'add_transaction') {
      const { title, amount, type, method } = body;
      if (!title || amount == null || !type) return j({ error: 'title, amount, type required' }, 400);
      const parsedAmount = parseFloat(amount);
      if (isNaN(parsedAmount)) return j({ error: 'amount tidak valid' }, 400);

      // KEAMANAN SALDO (fix 21 Sep 2026): kredit "in" hanya dari sumber terverifikasi —
      // (a) callback gateway bertoken valid, atau (b) ClincooPay terhubung (saldo diambil
      // nyata dari web Wallet lewat mirrorDelta di bawah; gagal potong = gagal kredit).
      // User biasa TIDAK lagi bisa mencatat transaksi masuk sendiri dari endpoint ini.
      if (type === 'in' && !callbackVerified) {
        const conn0 = await getCpConnection(db, uid);
        if (!conn0) {
          return j({ error: 'Kredit saldo hanya melalui top up (QRIS/Xendit) atau ClincooPay yang terhubung.' }, 403);
        }
      }

      await rowScope(db, 'wallet_transactions', user);

      // Idempotensi top up Xendit: order_id yang sudah pernah dikreditkan tidak dikreditkan/dinotifikasi lagi
      // (mencegah saldo & notif dobel jika pemanggil — mis. callback Koda — mengirim request yang sama 2x)
      const orderId = (String(title).match(/\[(TOPUP-[^\]]+)\]/) || [])[1] || null;
      if (orderId) {
        const dup = await db.prepare('SELECT id FROM wallet_transactions WHERE user_id = ? AND title = ? LIMIT 1').bind(uid, title).first();
        if (dup) {
          const balRowDup = await db.prepare('SELECT value FROM wallet_balance WHERE key = ?').bind(balKey).first();
          return j({ success: true, id: dup.id, balance: parseFloat(balRowDup?.value || '0'), duplicate: true });
        }
      }

      const txId = 'TX-' + Math.floor(100000 + Math.random() * 900000);
      await db.prepare('INSERT INTO wallet_transactions (id, title, amount, type, method, user_id) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(txId, title, parsedAmount, type, method || '', uid).run();

      // ClincooPay: pengguna terhubung → saldo di web Wallet yang diubah (mirroring 2 arah)
      const cpConn = await getCpConnection(db, uid);
      if (cpConn && (type === 'in' || type === 'out')) {
        const delta = type === 'in' ? Math.abs(parsedAmount) : -Math.abs(parsedAmount);
        const mr = await mirrorDelta(cpConn, delta, 'Clincoo: ' + String(title), txId);
        if (!mr.ok) {
          const kurang = String(mr.error).indexOf('tidak cukup') >= 0;
          return j({ error: kurang ? 'Saldo ClincooPay tidak cukup.' : mr.error }, kurang ? 402 : 502);
        }
        return j({ success: true, id: txId, balance: mr.balance, mirrored: true });
      }

      const balRow = await db.prepare('SELECT value FROM wallet_balance WHERE key = ?').bind(balKey).first();
      let balance = parseFloat(balRow?.value || '0');
      if (type === 'in') balance += parsedAmount;
      else if (type === 'out') balance -= parsedAmount;

      await db.prepare('INSERT INTO wallet_balance (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .bind(balKey, String(balance)).run();

      // Notifikasi in-app + email konfirmasi (Resend) — hanya utk transaksi hasil top up Xendit
      if (/^top up xendit/i.test(String(title))) {
        const nres = { notif: false, email: null };
        try {
          nres.notif = await notifyEvent(db, user, {
            source: 'Dompet', type: 'wallet',
            message: 'Top up ' + formatIDR(parsedAmount) + ' via ' + (method || 'Xendit') + ' berhasil. Saldo sekarang ' + formatIDR(balance) + '.',
            link: 'https://app.clincoo.buzz/akun/dompet/'
          });
        } catch (e) { nres.notifErr = String(e && e.message || e); }
        if (user && user.email) {
          try {
            nres.email = await sendEmail(env, {
              toEmail: user.email, toName: user.name || '',
              subject: 'Konfirmasi Top Up Clincoo — ' + formatIDR(parsedAmount),
              html: emailTemplate(
                'Top Up Berhasil',
                user.name || '',
                'Top up saldo Clincoo Anda telah berhasil diproses dan saldo telah masuk ke Dompet Anda. Berikut rincian transaksinya:',
                [
                  ['Jumlah Top Up', formatIDR(parsedAmount) + ' (' + (method || 'Xendit') + ')'],
                  ['Saldo Saat Ini', formatIDR(balance)],
                  ['ID Transaksi', txId],
                  ['Order ID', orderId]
                ],
                'Lihat Riwayat Dompet',
                'https://app.clincoo.buzz/akun/dompet/',
                'Rincian lengkap transaksi dapat dilihat di halaman Dompet pada akun Clincoo Anda.'
              )
            });
          } catch (e) { nres.emailErr = String(e && e.message || e); }
        }
        try {
          await rowScope(db, 'activity_log', user);
          await db.prepare('INSERT INTO activity_log (action, details, user_id) VALUES (?, ?, ?)')
            .bind('notify_email_result', 'notif=' + String(nres.notif) + ' email=' + JSON.stringify(nres.email).slice(0, 200), uid).run();
        } catch (e2) {}
      }

      try {
        await rowScope(db, 'activity_log', user);
        await db.prepare('INSERT INTO activity_log (action, details, user_id) VALUES (?, ?, ?)').bind('wallet_transaction', title + ' (' + type + ': ' + amount + ')', uid).run();
      } catch {}

      return j({ success: true, id: txId, balance });
    }

    if (action === 'transfer') {
      // Kirim saldo ke pengguna Clincoo lain (via email) — double-entry: out pengirim, in penerima
      const toEmail = String(body.to_email || '').trim().toLowerCase();
      const amount = Math.floor(parseFloat(body.amount));
      const note = String(body.note || '').slice(0, 140);
      if (!toEmail || toEmail.indexOf('@') < 1) return j({ error: 'Email penerima tidak valid' }, 400);
      if (!amount || amount < 1000) return j({ error: 'Minimal kirim saldo 1.000' }, 400);
      if (String(user.email || '').toLowerCase() === toEmail) return j({ error: 'Tidak bisa mengirim ke akun sendiri' }, 400);
      const target = await getUserByEmail(db, toEmail);
      if (!target) return j({ error: 'Akun penerima tidak ditemukan. Pastikan email sudah terdaftar di Clincoo.' }, 404);

      const senderBalKey = await scopedKey(db, 'wallet_balance', user, 'balance');
      const balRow = await db.prepare('SELECT value FROM wallet_balance WHERE key = ?').bind(senderBalKey).first();
      let balance = parseFloat(balRow?.value || '0');
      // ClincooPay: pengirim terhubung → cek saldo live web Wallet
      const senderConn = await getCpConnection(db, uid);
      if (senderConn) {
        const wb = await mirroredBalance(senderConn);
        if (wb !== null) balance = wb;
      }
      if (balance < amount) return j({ error: 'Saldo tidak cukup. Saldo Anda ' + formatIDR(balance) + '.', balance: balance, required: amount }, 402);

      const recvBalKey = await scopedKey(db, 'wallet_balance', target, 'balance');
      const txIdOut = 'TX-' + Math.floor(100000 + Math.random() * 900000);
      const txIdIn = 'TX-' + Math.floor(100000 + Math.random() * 900000);
      const recvRow = await db.prepare('SELECT value FROM wallet_balance WHERE key = ?').bind(recvBalKey).first();
      let newBalance = balance - amount;
      const senderLabel = (user.name || user.email || 'Pengirim');
      const targetLabel = (target.name || target.email || 'Penerima');
      const titleOut = 'Kirim Saldo ke ' + targetLabel + (note ? ' — ' + note : '');
      const titleIn = 'Terima Saldo dari ' + senderLabel + (note ? ' — ' + note : '');

      // Catat transaksi kedua pihak
      await db.prepare('INSERT INTO wallet_transactions (id, title, amount, type, method, user_id) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(txIdOut, titleOut, amount, 'out', 'Kirim Saldo', uid).run();
      await db.prepare('INSERT INTO wallet_transactions (id, title, amount, type, method, user_id) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(txIdIn, titleIn, amount, 'in', 'Terima Saldo', target.id).run();

      // ClincooPay: mirror debit pengirim ke web Wallet (idempotent via txIdOut)
      if (senderConn) {
        const mr = await mirrorDelta(senderConn, -amount, 'Clincoo: ' + titleOut, txIdOut);
        if (!mr.ok) {
          const kurang = String(mr.error).indexOf('tidak cukup') >= 0;
          return j({ error: kurang ? 'Saldo ClincooPay tidak cukup.' : mr.error }, kurang ? 402 : 502);
        }
        newBalance = mr.balance;
      }
      // ClincooPay: mirror kredit penerima bila terhubung
      const recvConn = await getCpConnection(db, target.id);
      let recvBalance = parseFloat(recvRow?.value || '0') + amount;
      if (recvConn) {
        const mr2 = await mirrorDelta(recvConn, amount, 'Clincoo: ' + titleIn, txIdIn);
        if (mr2.ok) recvBalance = mr2.balance;
      }

      // Update saldo kedua pihak (hanya yang LOKAL — pengguna terhubung ClincooPay dikelola web Wallet)
      if (!senderConn) {
        await db.prepare('INSERT INTO wallet_balance (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
          .bind(senderBalKey, String(newBalance)).run();
      }
      if (!recvConn) {
        await db.prepare('INSERT INTO wallet_balance (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
          .bind(recvBalKey, String(recvBalance)).run();
      }

      // Notifikasi in-app kedua pihak
      try {
        await notifyEvent(db, user, {
          source: 'Dompet', type: 'wallet',
          message: 'Kirim ' + formatIDR(amount) + ' ke ' + targetLabel + ' berhasil. Saldo sekarang ' + formatIDR(newBalance) + '.',
          link: 'https://app.clincoo.buzz/akun/dompet/'
        });
      } catch (e) {}
      try {
        await notifyEvent(db, target, {
          source: 'Dompet', type: 'wallet',
          message: 'Anda menerima ' + formatIDR(amount) + ' dari ' + senderLabel + '. Saldo sekarang ' + formatIDR(recvBalance) + '.',
          link: 'https://app.clincoo.buzz/akun/dompet/'
        });
      } catch (e) {}

      // Email konfirmasi ke penerima
      if (target && target.email) {
        try {
          await sendEmail(env, {
            toEmail: target.email, toName: target.name || '',
            subject: 'Anda Menerima Saldo Clincoo — ' + formatIDR(amount),
            html: emailTemplate(
              'Saldo Diterima',
              target.name || '',
              'Anda baru saja menerima saldo dari pengguna Clincoo lain. Berikut rinciannya:',
              [
                ['Pengirim', senderLabel],
                ['Jumlah', formatIDR(amount)],
                ['Saldo Saat Ini', formatIDR(recvBalance)],
                ['ID Transaksi', txIdIn]
              ],
              'Lihat Riwayat Dompet',
              'https://app.clincoo.buzz/akun/dompet/',
              'Rincian lengkap transaksi dapat dilihat di halaman Dompet pada akun Clincoo Anda.'
            )
          });
        } catch (e) {}
      }

      // Catat aktivitas kedua pihak
      try { await db.prepare('INSERT INTO activity_log (action, details, user_id) VALUES (?, ?, ?)').bind('wallet_transfer', titleOut + ' (' + formatIDR(amount) + ')', uid).run(); } catch (e) {}
      try { await db.prepare('INSERT INTO activity_log (action, details, user_id) VALUES (?, ?, ?)').bind('wallet_transfer', titleIn + ' (' + formatIDR(amount) + ')', target.id).run(); } catch (e) {}

      return j({ success: true, balance: newBalance, to: targetLabel, tx_id: txIdOut });
    }

    if (action === 'set_balance') {
      // Hanya admin: user biasa tidak boleh mengubah saldo sendiri secara bebas
      if (!isUserAdmin(user)) return j({ error: 'Aksi set_balance hanya untuk admin' }, 403);
      const balance = parseFloat(body.balance || 0);
      const conn0 = await getCpConnection(db, uid);
      if (conn0) {
        const live = await mirroredBalance(conn0);
        const mr = await mirrorDelta(conn0, Math.round(balance - (live || 0)), 'Clincoo: set saldo', 'CP-SET-' + Date.now());
        if (!mr.ok) return j({ error: mr.error }, 502);
        return j({ success: true, balance: mr.balance, mirrored: true });
      }
      await db.prepare('INSERT INTO wallet_balance (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .bind(balKey, String(balance)).run();
      return j({ success: true, balance });
    }

    if (action === 'clear_transactions') {
      // KEAMANAN SALDO: penghapusan riwayat + reset saldo kini khusus admin —
      // user biasa bisa memakainya untuk menghilangkan jejak audit saldo.
      if (!isUserAdmin(user)) return j({ error: 'Aksi clear_transactions hanya untuk admin' }, 403);
      await rowScope(db, 'wallet_transactions', user);
      await db.prepare('DELETE FROM wallet_transactions WHERE user_id = ?').bind(uid).run();
      await db.prepare('INSERT INTO wallet_balance (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .bind(balKey, '0').run();
      return j({ success: true, balance: 0 });
    }

    return j({ error: 'Unknown action' }, 400);
  } catch (err) {
    return j({ error: err.message }, 500);
  }
}

// DELETE /api/wallet?id=... — hapus satu transaksi; tanpa id — hapus semua (milik user)
export async function onRequestDelete({ request, env }) {
  const db = env.DB;
  if (!db) return j({ error: 'D1 not bound' }, 500);
  try {
    const url = new URL(request.url);
    const id = url.searchParams.get('id');
    const user = await currentUser(env, request);
    const balKey = await scopedKey(db, 'wallet_balance', user, 'balance');
    const uid = user ? user.id : null;

    // KEAMANAN SALDO (fix 21 Sep 2026): hapus transaksi kini khusus admin.
    // Dulunya user biasa bisa menghapus transaksi "out" miliknya dan saldonya
    // dikembalikan penuh — jalan pintas refund (mis. hapus riwayat bayar
    // Langganan Pro -> saldo balik -> beli lagi). Mencegah penghapusan data
    // akun lain sekaligus mencegah manipulasi saldo.
    if (!uid) return j({ error: 'Login diperlukan', need_login: true }, 401);
    if (!isUserAdmin(user)) return j({ error: 'Hanya admin yang dapat menghapus transaksi dompet' }, 403);
    await rowScope(db, 'wallet_transactions', user);

    if (id) {
      const tx = await db.prepare('SELECT * FROM wallet_transactions WHERE id = ? AND user_id = ?').bind(id, uid).first();
      if (tx) {
        const balRow = await db.prepare('SELECT value FROM wallet_balance WHERE key = ?').bind(balKey).first();
        let balance = parseFloat(balRow?.value || '0');
        if (tx.type === 'in') balance -= parseFloat(tx.amount);
        else if (tx.type === 'out') balance += parseFloat(tx.amount);
        if (balance < 0) balance = 0;

        await db.prepare('DELETE FROM wallet_transactions WHERE id = ? AND user_id = ?').bind(id, uid).run();
        await db.prepare('INSERT INTO wallet_balance (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
          .bind(balKey, String(balance)).run();
        return j({ success: true, balance });
      }
      const cur = await db.prepare('SELECT value FROM wallet_balance WHERE key = ?').bind(balKey).first();
      return j({ success: true, balance: parseFloat(cur?.value || '0') });
    }

    if (uid) await db.prepare('DELETE FROM wallet_transactions WHERE user_id = ?').bind(uid).run();
    else await db.prepare('DELETE FROM wallet_transactions').run();
    await db.prepare('INSERT INTO wallet_balance (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .bind(balKey, '0').run();
    return j({ success: true, balance: 0 });
  } catch (err) {
    return j({ error: err.message }, 500);
  }
}
