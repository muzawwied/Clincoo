// Cloudflare Pages Functions — Ekspor Data (PER AKUN)
// GET /api/export-data -> seluruh data milik user login saja (JSON).
// Data akun lain & key global (kredensial deploy) tidak pernah ikut.

import { currentUser, userPrefix } from './user-scope.js';
import { tableSuffix } from './_tables.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

function json(data, status) {
  return new Response(JSON.stringify(data), { status: status || 200, headers: { 'Content-Type': 'application/json', ...CORS } });
}

export async function onRequestOptions() {
  return new Response(null, { headers: CORS });
}

export async function onRequestGet({ request, env }) {
  const db = env.DB;
  if (!db) return json({ error: 'D1 not bound' }, 500);
  const user = await currentUser(env, request);
  if (!user) return json({ error: 'Login diperlukan', need_login: true }, 401);
  const uid = user.id;
  const prefix = userPrefix(user); // u<id>:

  const safe = async (sql, ...params) => {
    try { const r = await db.prepare(sql).bind(...params).all(); return r.results || []; } catch (e) { return []; }
  };
  const safeFirst = async (sql, ...params) => {
    try { return await db.prepare(sql).bind(...params).first(); } catch (e) { return null; }
  };

  try {
    // ===== Data akun (semua difilter per user) =====
    const [prefsRows, subRows, txs, balRows, acts, notifs, projects] = await Promise.all([
      safe('SELECT key, value FROM user_preferences WHERE key LIKE ?', prefix + '%'),
      safe('SELECT key, value FROM subscription WHERE key LIKE ?', prefix + '%'),
      safe('SELECT * FROM wallet_transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 200', uid),
      safe('SELECT key, value FROM wallet_balance WHERE key LIKE ?', prefix + '%'),
      safe('SELECT * FROM activity_log WHERE user_id = ? ORDER BY created_at DESC LIMIT 200', uid),
      safe('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 200', uid),
      safe('SELECT * FROM user_projects WHERE user_id = ? ORDER BY COALESCE(updated_at, created_at) DESC', uid)
    ]);

    const preferences = {};
    for (const row of prefsRows) preferences[row.key.slice(prefix.length)] = row.value;

    const subscription = {};
    for (const row of subRows) subscription[row.key.slice(prefix.length)] = row.value;

    const walletBal = {};
    for (const row of balRows) walletBal[row.key.slice(prefix.length)] = row.value;

    // ===== Data per-proyek milik akun =====
    const envVars = [];
    const chatSessions = [];
    const chatMessages = [];
    const filesMeta = [];
    for (const p of projects) {
      const s = tableSuffix(p.id);
      const t = (b) => `p_${s}_${b}`;
      const ev = await safe(`SELECT key, is_secret, created_at, updated_at FROM ${t('env_vars')} ORDER BY created_at DESC`);
      for (const row of ev) envVars.push({ project_id: p.id, ...row });
      const sess = await safe(`SELECT id, title, project_id, created_at, updated_at FROM ${t('chat_sessions')} ORDER BY updated_at DESC`);
      for (const row of sess) chatSessions.push(row);
      const msgs = await safe(`SELECT session_id, role, content, model, created_at FROM ${t('chat_messages')} ORDER BY created_at DESC LIMIT 500`);
      for (const row of msgs) chatMessages.push(row);
      const files = await safe(`SELECT path, LENGTH(content) AS size, created_at, updated_at FROM ${t('project_files')} ORDER BY path`);
      for (const row of files) filesMeta.push({ project_id: p.id, ...row });
    }

    const exportData = {
      export_date: new Date().toISOString(),
      app_name: 'Clincoo',
      app_version: '2.4.0',
      account: { id: user.id, email: user.email, name: user.name },
      preferences,
      subscription,
      wallet: {
        balance: parseFloat(walletBal.balance || '0'),
        transactions: txs
      },
      activity_log: acts,
      notifications: notifs,
      projects,
      env_vars: envVars,
      files: filesMeta,
      chat_sessions: chatSessions,
      chat_messages: chatMessages
    };

    return new Response(JSON.stringify(exportData, null, 2), {
      headers: {
        'Content-Type': 'application/json',
        'Content-Disposition': 'attachment; filename="clincoo_data_export.json"',
        ...CORS
      }
    });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
