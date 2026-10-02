// ClincooPay — aktifkan pay key per proyek + transaksi QRIS (Pakasir)
import { currentUser } from './user-scope.js';
import { randomHex } from './auth/shared.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};
function json(data, status) {
  return new Response(JSON.stringify(data), { status: status || 200, headers: { 'Content-Type': 'application/json', ...CORS } });
}
export async function onRequestOptions() { return new Response(null, { headers: CORS }); }

async function ensurePayTables(db) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS pay_creds (
    project_id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    secret TEXT NOT NULL,
    pay_key TEXT NOT NULL,
    qris_method TEXT DEFAULT 'qris_two',
    fee_target TEXT DEFAULT 'merchant',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS pay_transactions (
    order_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    amount INTEGER NOT NULL,
    status TEXT DEFAULT 'pending',
    description TEXT,
    qris_url TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )`).run();
}

async function requireOwned(env, request, projectId) {
  const user = await currentUser(env, request);
  if (!user) return { error: json({ error: 'Login diperlukan', need_login: true }, 401) };
  if (!projectId) return { error: json({ error: 'project_id wajib diisi' }, 400) };
  const uid = Number(user.id);
  // Pastikan tabel ada (akun/proyek baru) — skema identik dengan projects.js
  try {
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS user_projects (
      id TEXT PRIMARY KEY,
      user_id INTEGER,
      title TEXT DEFAULT '',
      prompt TEXT DEFAULT '',
      ai_name TEXT DEFAULT '',
      ai_desc TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT
    )`).run();
  } catch (e) {}
  const row = await env.DB.prepare('SELECT user_id FROM user_projects WHERE id = ?').bind(projectId).first();
  if (row) {
    if (Number(row.user_id) === uid) return { user, projectId };
    try {
      const mem = await env.DB.prepare('SELECT id FROM project_members WHERE project_id = ? AND user_id = ?').bind(projectId, uid).first();
      if (mem) return { user, projectId };
    } catch (e) {}
    return { error: json({ error: 'Proyek tidak ditemukan atau bukan milikmu' }, 404) };
  }
  // Proyek lama yang belum tercatat di user_projects (kompatibilitas migrasi,
  // konsisten dengan guardProject di user-scope.js): klaim otomatis ke akun yang
  // meminta aktivasi — memperbaiki error 404 saat mengaktifkan Pembayaran.
  try {
    await env.DB.prepare(`INSERT OR IGNORE INTO user_projects (id, user_id, title, prompt, ai_name, ai_desc, updated_at)
      VALUES (?, ?, '', '', '', '', ?)`).bind(projectId, uid, new Date().toISOString()).run();
    const own = await env.DB.prepare('SELECT id FROM user_projects WHERE id = ? AND user_id = ?').bind(projectId, uid).first();
    if (own) return { user, projectId };
    try {
      const mem = await env.DB.prepare('SELECT id FROM project_members WHERE project_id = ? AND user_id = ?').bind(projectId, uid).first();
      if (mem) return { user, projectId };
    } catch (e) {}
  } catch (e) {}
  return { error: json({ error: 'Proyek tidak ditemukan atau bukan milikmu' }, 404) };
}

function genPayKey() { return 'cno_pk_' + randomHex(14); }
function genSecret() { return 'cno_ss_' + randomHex(15); }
function genAccountId() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = 'CPPX';
  for (let i = 0; i < 8; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
  return s;
}

export async function onRequestGet({ request, env }) {
  if (!env.DB) return json({ error: 'D1 not bound' }, 500);
  await ensurePayTables(env.DB);
  const url = new URL(request.url);
  const action = url.searchParams.get('action') || 'config';
  const projectId = url.searchParams.get('project_id') || '';

  if (action === 'status') {
    const key = url.searchParams.get('key') || '';
    const orderId = url.searchParams.get('order_id') || '';
    if (!key || !orderId) return json({ error: 'key dan order_id wajib' }, 400);
    const cred = await env.DB.prepare('SELECT project_id FROM pay_creds WHERE pay_key = ?').bind(key).first();
    if (!cred) return json({ error: 'pay key tidak valid' }, 404);
    const tx = await env.DB.prepare('SELECT order_id, amount, status, description, created_at FROM pay_transactions WHERE order_id = ? AND project_id = ?')
      .bind(orderId, cred.project_id).first();
    if (!tx) return json({ error: 'transaksi tidak ditemukan' }, 404);
    return json(tx);
  }

  const r = await requireOwned(env, request, projectId);
  if (r.error) return r.error;
  const row = await env.DB.prepare('SELECT account_id, pay_key, qris_method, fee_target FROM pay_creds WHERE project_id = ?').bind(projectId).first();
  if (!row) return json({ active: false });
  return json({ active: true, account_id: row.account_id, pay_key: row.pay_key, qris_method: row.qris_method, fee_target: row.fee_target });
}

export async function onRequestPost({ request, env }) {
  if (!env.DB) return json({ error: 'D1 not bound' }, 500);
  await ensurePayTables(env.DB);
  let body = {};
  try { body = await request.json(); } catch (e) {}
  const action = body.action || '';

  if (action === 'create') {
    const key = body.key || body.pay_key || '';
    const amount = Math.floor(Number(body.amount) || 0);
    if (!key) return json({ error: 'key wajib' }, 400);
    if (amount < 1000) return json({ error: 'nominal minimum Rp 1.000' }, 400);
    const cred = await env.DB.prepare('SELECT * FROM pay_creds WHERE pay_key = ?').bind(key).first();
    if (!cred) return json({ error: 'pay key tidak valid' }, 404);
    const orderId = 'ORD' + Date.now() + Math.floor(Math.random() * 1000);
    const desc = String(body.description || 'Pembayaran').slice(0, 200);
    let qrisUrl = null;
    try {
      if (env.PAKASIR_API_KEY && env.PAKASIR_SLUG) {
        const pr = await fetch('https://app.pakasir.com/api/transactioncreate/qris', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ project: env.PAKASIR_SLUG, amount, order_id: orderId, api_key: env.PAKASIR_API_KEY })
        });
        const pd = await pr.json().catch(() => ({}));
        qrisUrl = pd.payment_url || pd.qris_url || pd.url || null;
      }
    } catch (e) {}
    await env.DB.prepare('INSERT INTO pay_transactions (order_id, project_id, amount, status, description, qris_url) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(orderId, cred.project_id, amount, 'pending', desc, qrisUrl).run();
    return json({ order_id: orderId, amount, status: 'pending', qris_url: qrisUrl, payment_url: qrisUrl });
  }

  let projectId = body.project_id || '';
  const r = await requireOwned(env, request, projectId);
  if (r.error) return r.error;
  projectId = r.projectId;

  if (action === 'activate') {
    const existing = await env.DB.prepare('SELECT account_id, pay_key FROM pay_creds WHERE project_id = ?').bind(projectId).first();
    if (existing) {
      return json({ active: true, account_id: existing.account_id, pay_key: existing.pay_key });
    }
    const account_id = genAccountId();
    const pay_key = genPayKey();
    const secret = genSecret();
    await env.DB.prepare('INSERT INTO pay_creds (project_id, account_id, secret, pay_key) VALUES (?, ?, ?, ?)')
      .bind(projectId, account_id, secret, pay_key).run();
    return json({ active: true, account_id, pay_key, secret });
  }

  if (action === 'config' || action === 'summary') {
    const row = await env.DB.prepare('SELECT account_id, pay_key FROM pay_creds WHERE project_id = ?').bind(projectId).first();
    if (!row) return json({ active: false, available: 0, total_paid: 0, total_withdrawn: 0 });
    const paid = await env.DB.prepare("SELECT COALESCE(SUM(amount),0) s FROM pay_transactions WHERE project_id = ? AND status = 'paid'").bind(projectId).first();
    return json({
      active: true,
      account_id: row.account_id,
      pay_key: row.pay_key,
      available: Number(paid?.s || 0),
      total_paid: Number(paid?.s || 0),
      total_withdrawn: 0
    });
  }

  if (action === 'transactions') {
    const rows = await env.DB.prepare('SELECT order_id, amount, status, description, created_at FROM pay_transactions WHERE project_id = ? ORDER BY created_at DESC LIMIT 25')
      .bind(projectId).all();
    return json({ transactions: rows.results || [] });
  }

  return json({ error: 'action tidak dikenal' }, 400);
}
