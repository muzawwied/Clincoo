import { currentUser, scopedKey, rowScope } from './user-scope.js';
import { getCpConnection, mirroredBalance, mirrorDelta } from './clincoopay-helpers.js';
import { emailTemplate, formatIDR, sendEmail, notifyEvent } from './notify-helpers.js';

// Cloudflare Pages Functions - Subscription Backend
// Stores subscription plan data in D1 (real-time, interconnected between pages)

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

export async function onRequestOptions() {
  return new Response(null, { headers: CORS });
}

const PLANS = {
  'Starter': { price: 0, projectLimit: 3, storageLimit: 5, bandwidthLimit: 10, collaboratorLimit: 1 },
  'Pro': { price: 49000, projectLimit: 10, storageLimit: 50, bandwidthLimit: 100, collaboratorLimit: 5 },
  'Bisnis': { price: 129000, projectLimit: 50, storageLimit: 200, bandwidthLimit: 500, collaboratorLimit: 20 }
};

export async function onRequestGet({ request, env }) {
  const db = env.DB;
  if (!db) return new Response(JSON.stringify({ error: 'D1 not bound' }), { status: 500, headers: { 'Content-Type': 'application/json', ...CORS } });

  try {
    const url = new URL(request.url);
    const action = url.searchParams.get('action');

    if (action === 'init') {
      await db.prepare('CREATE TABLE IF NOT EXISTS subscription (key TEXT PRIMARY KEY, value TEXT)').run();
      await db.prepare("INSERT OR IGNORE INTO subscription (key, value) VALUES ('plan', 'Starter')").run();
      await db.prepare("INSERT OR IGNORE INTO subscription (key, value) VALUES ('billing_cycle', 'Bulanan')").run();
      await db.prepare("INSERT OR IGNORE INTO subscription (key, value) VALUES ('start_date', ?)").bind(new Date().toISOString()).run();
      await db.prepare("INSERT OR IGNORE INTO subscription (key, value) VALUES ('payment_method', '')").run();
      return new Response(JSON.stringify({ success: true, message: 'Subscription table initialized' }), {
        headers: { 'Content-Type': 'application/json', ...CORS }
      });
    }

    const user = await currentUser(env, request);
    await scopedKey(db, 'subscription', user, 'plan'); // klaim data legacy sekali
    const rows = await db.prepare('SELECT key, value FROM subscription').all();
    const pfx = user ? 'u' + user.id + ':' : '';
    const data = {};
    for (const row of rows.results || []) {
      if (user ? row.key.startsWith(pfx) : !row.key.includes(':')) data[row.key.slice(pfx.length)] = row.value;
    }

    const plan = data.plan || 'Starter';
    const planInfo = PLANS[plan] || PLANS['Starter'];
    const startDate = data.start_date || new Date().toISOString();
    const billingCycle = data.billing_cycle || 'Bulanan';

    // Calculate next billing date
    const nextDate = new Date(startDate);
    if (billingCycle === 'Tahunan') {
      nextDate.setFullYear(nextDate.getFullYear() + 1);
    } else {
      nextDate.setMonth(nextDate.getMonth() + 1);
    }
    while (nextDate < new Date()) {
      if (billingCycle === 'Tahunan') {
        nextDate.setFullYear(nextDate.getFullYear() + 1);
      } else {
        nextDate.setMonth(nextDate.getMonth() + 1);
      }
    }

    let projectCount = 0;
    try {
      const projResult = await db.prepare('SELECT COUNT(*) as c FROM projects').first();
      projectCount = projResult?.c || 0;
    } catch(e) {}

    return new Response(JSON.stringify({
      plan,
      billingCycle,
      startDate,
      nextBillingDate: nextDate.toISOString(),
      paymentMethod: data.payment_method || '',
      price: planInfo.price,
      projectLimit: planInfo.projectLimit,
      storageLimit: planInfo.storageLimit,
      bandwidthLimit: planInfo.bandwidthLimit,
      collaboratorLimit: planInfo.collaboratorLimit,
      projectCount,
      storageUsed: parseFloat(data.storage_used || '0'),
      bandwidthUsed: parseFloat(data.bandwidth_used || '0'),
      collaboratorCount: parseInt(data.collaborator_count || '0')
    }), {
      headers: { 'Content-Type': 'application/json', ...CORS }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { 'Content-Type': 'application/json', ...CORS } });
  }
}

export async function onRequestPost({ request, env }) {
  const db = env.DB;
  if (!db) return new Response(JSON.stringify({ error: 'D1 not bound' }), { status: 500, headers: { 'Content-Type': 'application/json', ...CORS } });

  try {
    const body = await request.json();
    const { plan, billingCycle, paymentMethod, projects: projectList } = body;
    const user = await currentUser(env, request);
    const subPfx = user ? 'u' + user.id + ':' : '';

    // Sync projects from frontend to D1 (real-time per-project data)
    if (projectList && Array.isArray(projectList)) {
      try {
        await db.prepare("CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, status TEXT DEFAULT 'active', created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')))").run();
        // Get existing project IDs
        const existing = await db.prepare('SELECT id FROM projects').all();
        const existingIds = new Set((existing.results || []).map(r => r.id));
        for (const proj of projectList) {
          if (!existingIds.has(proj.id)) {
            await db.prepare("INSERT OR IGNORE INTO projects (id, name, description, status) VALUES (?, ?, ?, ?)").bind(proj.id, proj.name || 'Untitled', proj.description || '', proj.status || 'active').run();
          } else {
            await db.prepare("UPDATE projects SET name = ?, description = ?, updated_at = datetime('now') WHERE id = ?").bind(proj.name || 'Untitled', proj.description || '', proj.id).run();
          }
        }
      } catch(e) {}
    }

    await db.prepare('CREATE TABLE IF NOT EXISTS subscription (key TEXT PRIMARY KEY, value TEXT)').run();

    if (plan) {
      const validPlan = PLANS[plan] ? plan : 'Starter';
      const planPrice = PLANS[validPlan].price;
      const billing = billingCycle || 'Bulanan';
      const totalPrice = billing === 'Tahunan' ? planPrice * 12 : planPrice;

      // Check wallet balance for paid plans
      if (planPrice > 0) {
        try {
          const balKey = await scopedKey(db, 'wallet_balance', user, 'balance');
          const balRow = await db.prepare('SELECT value FROM wallet_balance WHERE key = ?').bind(balKey).first();
          let balance = parseFloat(balRow?.value || '0');
          // ClincooPay: dompet terhubung → saldo live web Wallet
          const subConn = await getCpConnection(db, user.id);
          if (subConn) {
            const wb = await mirroredBalance(subConn);
            if (wb !== null) balance = wb;
          }
          if (balance < totalPrice) {
            return new Response(JSON.stringify({ 
              success: false, 
              error: 'Saldo tidak cukup',
              balance: balance,
              required: totalPrice
            }), { status: 402, headers: { 'Content-Type': 'application/json', ...CORS } });
          }
          // Deduct from wallet
          const subUid = await rowScope(db, 'wallet_transactions', user);
          const subTxId = 'TX-' + Math.floor(100000 + Math.random() * 900000);
          await db.prepare('INSERT INTO wallet_transactions (id, title, amount, type, method, user_id) VALUES (?, ?, ?, ?, ?, ?)')
            .bind(subTxId, 'Langganan ' + validPlan + ' (' + billing + ')', totalPrice, 'out', 'Saldo Dompet', subUid).run();
          let newBalance = balance - totalPrice;
          // ClincooPay: dompet terhubung → potong saldo di web Wallet (mirroring 2 arah)
          if (subConn) {
            const mr = await mirrorDelta(subConn, -totalPrice, 'Clincoo: Langganan ' + validPlan + ' (' + billing + ')', subTxId);
            if (!mr.ok) {
              const kurang = String(mr.error).indexOf('tidak cukup') >= 0;
              return new Response(JSON.stringify({ success: false, error: kurang ? 'Saldo ClincooPay tidak cukup.' : mr.error }), { status: kurang ? 402 : 502, headers: { 'Content-Type': 'application/json' } });
            }
            newBalance = mr.balance;
          } else {
            await db.prepare('INSERT INTO wallet_balance (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
              .bind(balKey, String(newBalance)).run();
          }

          // Notifikasi in-app + email konfirmasi aktivasi langganan
          try {
            await notifyEvent(db, user, {
              source: 'Langganan', type: 'subscription',
              message: 'Langganan ' + validPlan + ' (' + billing + ') berhasil diaktifkan. Total ' + formatIDR(totalPrice) + ' dipotong dari Saldo Dompet. Saldo sekarang ' + formatIDR(newBalance) + '.',
              link: 'https://muzawwied.github.io/Clincoo./akun/langganan/'
            });
          } catch (e2) {}
          // Catat aktivitas langganan di halaman Aktivitas (per-akun)
          try {
            await db.prepare('INSERT INTO activity_log (action, details, user_id) VALUES (?, ?, ?)')
              .bind('subscription', 'Langganan ' + validPlan + ' (' + billing + ') aktif — ' + formatIDR(totalPrice) + ' dari Saldo Dompet', subUid).run();
          } catch (eSub) {}
          if (user && user.email) {
            try {
              await sendEmail(env, {
                toEmail: user.email, toName: user.name || '',
                subject: 'Langganan Clincoo Aktif — ' + validPlan,
                html: emailTemplate(
                  'Langganan Aktif',
                  user.name || '',
                  'Langganan ' + validPlan + ' Anda telah berhasil diaktifkan. Total pembayaran telah dipotong dari Saldo Dompet Anda. Berikut rinciannya:',
                  [
                    ['Paket', validPlan],
                    ['Siklus Tagihan', billing],
                    ['Total Pembayaran', formatIDR(totalPrice) + ' (Saldo Dompet)'],
                    ['Tanggal Aktif', new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' }) + ' WIB'],
                    ['Saldo Dompet Tersisa', formatIDR(newBalance)]
                  ],
                  'Lihat Detail Langganan',
                  'https://muzawwied.github.io/Clincoo./akun/langganan/',
                  'Rincian langganan dapat dilihat di halaman Langganan pada akun Clincoo Anda.'
                )
              });
            } catch (e3) {}
          }
        } catch(e) {
          // If wallet tables don't exist, still allow free plans but block paid
          return new Response(JSON.stringify({ 
            success: false, 
            error: 'Gagal memverifikasi saldo dompet'
          }), { status: 500, headers: { 'Content-Type': 'application/json', ...CORS } });
        }
      }

      await db.prepare("INSERT INTO subscription (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(subPfx + 'plan', validPlan).run();
      const now = new Date().toISOString();
      await db.prepare("INSERT INTO subscription (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(subPfx + 'start_date', now).run();
    }

    if (billingCycle) {
      const validCycle = ['Bulanan', 'Tahunan'].includes(billingCycle) ? billingCycle : 'Bulanan';
      await db.prepare("INSERT INTO subscription (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(subPfx + 'billing_cycle', validCycle).run();
    }

    if (paymentMethod !== undefined) {
      await db.prepare("INSERT INTO subscription (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(subPfx + 'payment_method', paymentMethod).run();
    }

    await scopedKey(db, 'subscription', user, 'plan');
    const rows = await db.prepare('SELECT key, value FROM subscription').all();
    const endPfx = user ? 'u' + user.id + ':' : '';
    const data = {};
    for (const row of rows.results || []) {
      if (user ? row.key.startsWith(endPfx) : !row.key.includes(':')) data[row.key.slice(endPfx.length)] = row.value;
    }

    const currentPlan = data.plan || 'Starter';
    const planInfo = PLANS[currentPlan] || PLANS['Starter'];

    return new Response(JSON.stringify({
      success: true,
      plan: currentPlan,
      billingCycle: data.billing_cycle || 'Bulanan',
      startDate: data.start_date,
      paymentMethod: data.payment_method || '',
      price: planInfo.price
    }), {
      headers: { 'Content-Type': 'application/json', ...CORS }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { 'Content-Type': 'application/json', ...CORS } });
  }
}
