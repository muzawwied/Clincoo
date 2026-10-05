// Cloudflare Pages Functions - Admin Panel Backend Clincoo (/api/admin)
import { currentUser } from '../user-scope.js';
import { ADMIN_EMAILS } from '../plan-helpers.js';
import { initTables as initAuthTables } from '../auth/shared.js';
import { flatTemplate, sendEmail } from '../notify-helpers.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS }
  });
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

let isMigrated = false;

// Migrasi role & status secara lazy (try/catch tiap langkah, cache flag cold start)
async function ensureAdminMigration(db) {
  if (isMigrated) return;
  try { await initAuthTables(db); } catch (e) {}
  try { await db.prepare("ALTER TABLE auth_users ADD COLUMN role TEXT DEFAULT 'user'").run(); } catch (e) {}
  try { await db.prepare("ALTER TABLE auth_users ADD COLUMN status TEXT DEFAULT 'active'").run(); } catch (e) {}
  try { await db.prepare("ALTER TABLE auth_users ADD COLUMN suspend_reason TEXT").run(); } catch (e) {}
  try {
    for (const email of ADMIN_EMAILS) {
      const role = (email.toLowerCase() === 'muzawwied@gmail.com') ? 'owner' : 'admin';
      await db.prepare("UPDATE auth_users SET role = ? WHERE LOWER(email) = LOWER(?) AND (role IS NULL OR role != ?)")
        .bind(role, email, role).run();
    }
  } catch (e) {}
  try {
    await db.prepare(`CREATE TABLE IF NOT EXISTS admin_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT,
      target_user_id INTEGER,
      details TEXT,
      status TEXT DEFAULT 'open',
      source TEXT DEFAULT 'system',
      created_at TEXT DEFAULT (datetime('now'))
    )`).run();
  } catch (e) {}
  try {
    await db.prepare(`CREATE TABLE IF NOT EXISTS wallet_balance (
      key TEXT PRIMARY KEY,
      value TEXT
    )`).run();
  } catch (e) {}
  isMigrated = true;
}

function isUserAdmin(user) {
  if (!user) return false;
  if (user.role === 'admin' || user.role === 'owner') return true;
  if (user.email && ADMIN_EMAILS.has(user.email.toLowerCase())) return true;
  return false;
}

// Panel Admin mandiri (admin.clincoo.buzz): akses via kunci panel (env ADMIN_PANEL_KEY,
// header x-admin-key) alih-alih login akun — user sintetis role owner untuk log aktivitas.
function keyAuthUser(env, request) {
  const expected = (env.ADMIN_PANEL_KEY || '').trim();
  const given = (request.headers.get('x-admin-key') || '').trim();
  if (!expected || !given || expected.length !== given.length) return null;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ given.charCodeAt(i);
  if (diff !== 0) return null;
  return { id: 0, email: 'panel-admin@clincoo', role: 'owner' };
}

// ===================================================================
// AUTH PANEL MANDIRI (alur publik, TANPA kunci/admin guard dulu):
//   1. POST action=auth_request_otp {email}  -> kirim OTP 6 digit ke email
//   2. POST action=auth_verify_otp {email, otp}
//      - email PANEL_AUTH_EMAIL + OTP benar -> { next: 'key', otp_token }
//      - email lain + OTP benar             -> { next: 'app', redirect } (diam, tanpa petunjuk)
//   3. POST action=auth_verify_key {otp_token} + header x-admin-key -> masuk panel
// ===================================================================
const PANEL_AUTH_EMAIL = 'devconium@gmail.com';
const PANEL_APP_REDIRECT = 'https://app.clincoo.buzz';

async function sha256hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
async function hmacHex(keyStr, msg) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(keyStr),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function ensurePanelAuthTable(db) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS panel_auth_otps (
    email TEXT PRIMARY KEY,
    code_hash TEXT,
    expires_at TEXT,
    attempts INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    request_count INTEGER DEFAULT 1,
    hour_at TEXT DEFAULT (strftime('%Y-%m-%d %H', 'now'))
  )`).run();
}

async function handleAuthRequestOtp(env, db, body) {
  const email = String(body.email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return json({ success: false, error: 'Email tidak valid.' }, 400);
  await ensurePanelAuthTable(db);
  const row = await db.prepare('SELECT * FROM panel_auth_otps WHERE email = ?').bind(email).first();
  const now = Date.now();
  if (row && row.created_at) {
    const t = Date.parse(String(row.created_at).replace(' ', 'T') + 'Z');
    if (!isNaN(t) && now - t < 60 * 1000) return json({ success: false, error: 'Tunggu 1 menit sebelum minta kode OTP baru.' }, 429);
  }
  // Batas per email: maks 5 permintaan per jam (anti-spam)
  if (row && row.hour_at && row.hour_at === new Date().toISOString().slice(0, 13)) {
    if ((row.request_count || 0) >= 5) return json({ success: false, error: 'Terlalu banyak permintaan kode. Coba lagi nanti.' }, 429);
  }
  const code = String(Math.floor(100000 + Math.random() * 900000));
  const codeHash = await sha256hex(email + ':' + code);
  await db.prepare(`INSERT INTO panel_auth_otps (email, code_hash, expires_at, attempts, created_at, request_count, hour_at)
    VALUES (?, ?, datetime('now', '+10 minutes'), 0, datetime('now'), 1, strftime('%Y-%m-%d %H', 'now'))
    ON CONFLICT(email) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at,
      attempts = 0, created_at = datetime('now'),
      request_count = CASE WHEN hour_at = excluded.hour_at THEN request_count + 1 ELSE 1 END,
      hour_at = excluded.hour_at`).bind(email, codeHash).run();
  const sent = await sendEmail(env, {
    toEmail: email,
    subject: 'Kode OTP Panel — Clincoo',
    html: flatTemplate('Kode OTP Panel', null,
      '<p style="margin:0 0 20px;color:#374151;font-size:14px;line-height:1.7">Seseorang baru meminta kode akses panel Clincoo dengan email ini. Masukkan kode 6 digit di bawah untuk melanjutkan. Kode berlaku <b>10 menit</b> dan hanya bisa dipakai satu kali.</p>' +
      '<p style="margin:0 0 20px;color:#374151;font-size:14px;line-height:1.7">Kalau ini bukan Anda, abaikan email ini — tidak ada tindakan lebih lanjut yang diperlukan.</p>',
      null, null, null, null, code)
  });
  if (!sent || !sent.sent) return json({ success: false, error: 'Kode OTP gagal dikirim. Coba lagi sebentar.' }, 500);
  return json({ success: true, sent: true });
}

async function handleAuthVerifyOtp(env, db, body) {
  const email = String(body.email || '').trim().toLowerCase();
  const otp = String(body.otp || '').trim();
  if (!email || !otp) return json({ success: false, error: 'Email dan kode OTP wajib diisi.' }, 400);
  await ensurePanelAuthTable(db);
  const row = await db.prepare('SELECT * FROM panel_auth_otps WHERE email = ?').bind(email).first();
  const expired = !row || !row.expires_at || Date.parse(String(row.expires_at).replace(' ', 'T') + 'Z') <= Date.now();
  if (!row || expired || (row.attempts || 0) >= 5) {
    if (row) await db.prepare('DELETE FROM panel_auth_otps WHERE email = ?').bind(email).run();
    return json({ success: false, error: 'Kode OTP salah atau kedaluwarsa. Minta kode baru.' }, 401);
  }
  const given = await sha256hex(email + ':' + otp);
  if (given !== row.code_hash) {
    await db.prepare('UPDATE panel_auth_otps SET attempts = attempts + 1 WHERE email = ?').bind(email).run();
    return json({ success: false, error: 'Kode OTP salah atau kedaluwarsa. Minta kode baru.' }, 401);
  }
  await db.prepare('DELETE FROM panel_auth_otps WHERE email = ?').bind(email).run();
  if (email === PANEL_AUTH_EMAIL) {
    const exp = Date.now() + 10 * 60 * 1000;
    const token = exp + '.' + (await hmacHex((env.ADMIN_PANEL_KEY || '').trim(), email + '|' + exp));
    return json({ success: true, next: 'key', otp_token: token });
  }
  // Email non-panel: OTP-nya tetap benar, arahkan ke aplikasi utama — DIAM tanpa petunjuk apa pun.
  return json({ success: true, next: 'app', redirect: PANEL_APP_REDIRECT });
}

async function handleAuthVerifyKey(env, request, body) {
  const token = String(body.otp_token || '');
  const key = (request.headers.get('x-admin-key') || '').trim();
  const expected = (env.ADMIN_PANEL_KEY || '').trim();
  if (!token || !expected || !key || expected.length !== key.length) return json({ success: false, error: 'Verifikasi gagal.' }, 401);
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ key.charCodeAt(i);
  const dot = token.lastIndexOf('.');
  if (dot < 12) return json({ success: false, error: 'Verifikasi gagal.' }, 401);
  const exp = Number(token.slice(0, dot));
  const sig = token.slice(dot + 1);
  if (!exp || exp <= Date.now()) return json({ success: false, error: 'Verifikasi gagal.' }, 401);
  const want = await hmacHex(expected, PANEL_AUTH_EMAIL + '|' + exp);
  if (want.length !== sig.length) return json({ success: false, error: 'Verifikasi gagal.' }, 401);
  let diff2 = 0;
  for (let i = 0; i < want.length; i++) diff2 |= want.charCodeAt(i) ^ sig.charCodeAt(i);
  if (diff !== 0 || diff2 !== 0) return json({ success: false, error: 'Verifikasi gagal.' }, 401);
  return json({ success: true, is_admin: true });
}

async function handleGetSecurity(db, request) {
  const url = new URL(request.url);
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '100', 10) || 100, 1), 300);
  let events = [], byType = [];
  try {
    const r = await db.prepare('SELECT id, type, ip, email, detail, created_at FROM security_events ORDER BY id DESC LIMIT ?').bind(limit).all();
    events = r.results || [];
  } catch (e) {}
  try {
    const r = await db.prepare("SELECT type, COUNT(*) AS c FROM security_events WHERE created_at >= datetime('now', '-7 days') GROUP BY type ORDER BY c DESC").all();
    byType = r.results || [];
  } catch (e) {}
  return json({ success: true, events, by_type: byType });
}

function getAction(request, bodyAction = null) {
  if (bodyAction) return bodyAction;
  const url = new URL(request.url);
  const qAction = url.searchParams.get('action');
  if (qAction) return qAction;

  const path = url.pathname.replace(/\/$/, '');
  if (path.endsWith('/ping')) return 'ping';
  if (path.endsWith('/stats')) return 'stats';
  if (path.endsWith('/users')) return 'users';
  if (path.endsWith('/reports')) return 'reports';
  if (path.endsWith('/activity')) return 'activity';
  if (path.endsWith('/security')) return 'security';

  return null;
}

export async function onRequestGet({ request, env }) {
  const db = env.DB;
  if (!db) return json({ error: 'D1 not bound' }, 500);

  try {
    await ensureAdminMigration(db);
    const user = (await currentUser(env, request)) || keyAuthUser(env, request);

    const action = getAction(request);

    // 1. Ping: untuk siapa pun yang login
    if (action === 'ping') {
      if (!user) return json({ error: 'unauthorized', need_login: true }, 401);
      const isAdmin = isUserAdmin(user);
      return json({ success: true, is_admin: isAdmin });
    }

    // Guard Admin: Endpoint statistik/users/reports wajib role admin / email ADMIN_EMAILS
    if (!user) return json({ error: 'unauthorized', need_login: true }, 401);
    if (!isUserAdmin(user)) return json({ error: 'forbidden' }, 403);

    if (action === 'stats') {
      return await handleGetStats(db);
    }

    if (action === 'users') {
      return await handleGetUsers(db);
    }

    if (action === 'reports') {
      return await handleGetReports(db);
    }

    if (action === 'activity') {
      return await handleGetActivity(db, request);
    }

    if (action === 'security') {
      return await handleGetSecurity(db, request);
    }

    return json({ error: 'Aksi GET tidak valid: ' + action }, 400);
  } catch (e) {
    return json({ error: e.message || String(e) }, 500);
  }
}

export async function onRequestPost({ request, env }) {
  const db = env.DB;
  if (!db) return json({ error: 'D1 not bound' }, 500);

  try {
    await ensureAdminMigration(db);
    const body = await request.json().catch(() => ({}));
    const reqAction = getAction(request, body.action);

    // Alur auth panel mandiri: PUBLIK (pra-autentikasi) — OTP & kunci panel.
    // Middleware tetap menjaga: rate-limit per IP + Origin wajib resmi (anti-CSRF).
    const authPath = new URL(request.url).pathname.replace(/\/$/, '');
    if (authPath.endsWith('/auth/request-otp') || reqAction === 'auth_request_otp') return await handleAuthRequestOtp(env, db, body);
    if (authPath.endsWith('/auth/verify-otp') || reqAction === 'auth_verify_otp') return await handleAuthVerifyOtp(env, db, body);
    if (authPath.endsWith('/auth/verify-key') || reqAction === 'auth_verify_key') return await handleAuthVerifyKey(env, request, body);

    const user = (await currentUser(env, request)) || keyAuthUser(env, request);

    if (!user) return json({ error: 'unauthorized', need_login: true }, 401);
    if (!isUserAdmin(user)) return json({ error: 'forbidden' }, 403);

    if (['suspend', 'unsuspend', 'delete', 'set_role', 'adjust_balance'].includes(reqAction) || getAction(request) === 'users') {
      return await handlePostUsers(db, user, body, reqAction);
    }

    if (['create', 'resolve', 'dismiss', 'scan'].includes(reqAction) || getAction(request) === 'reports') {
      return await handlePostReports(db, user, body, reqAction);
    }

    return json({ error: 'Aksi POST tidak valid: ' + reqAction }, 400);
  } catch (e) {
    return json({ error: e.message || String(e) }, 500);
  }
}

async function handleGetStats(db) {
  let usersTotal = 0;
  let usersSuspended = 0;
  let newUsers7d = 0;
  try {
    const r = await db.prepare("SELECT COUNT(*) AS c FROM auth_users").first();
    usersTotal = r?.c || 0;
  } catch (e) {}
  try {
    const r = await db.prepare("SELECT COUNT(*) AS c FROM auth_users WHERE status = 'suspended'").first();
    usersSuspended = r?.c || 0;
  } catch (e) {}
  try {
    const r = await db.prepare("SELECT COUNT(*) AS c FROM auth_users WHERE created_at >= datetime('now', '-7 days')").first();
    newUsers7d = r?.c || 0;
  } catch (e) {}

  let projectsTotal = 0;
  try {
    const r = await db.prepare("SELECT COUNT(*) AS c FROM user_projects").first();
    projectsTotal = r?.c || 0;
  } catch (e) {
    try {
      const r = await db.prepare("SELECT COUNT(*) AS c FROM projects").first();
      projectsTotal = r?.c || 0;
    } catch (e2) {}
  }

  let deploysTotal = 0;
  let deploys7d = 0;
  try {
    const r = await db.prepare("SELECT COUNT(*) AS c FROM deploy_logs").first();
    deploysTotal = r?.c || 0;
  } catch (e) {}
  try {
    const r = await db.prepare("SELECT COUNT(*) AS c FROM deploy_logs WHERE created_at >= datetime('now', '-7 days')").first();
    deploys7d = r?.c || 0;
  } catch (e) {}

  let topupTotalAmount = 0;
  let topupCount = 0;
  try {
    const r = await db.prepare("SELECT SUM(amount) AS total, COUNT(*) AS count FROM topup_orders WHERE status = 'paid'").first();
    topupTotalAmount = parseFloat(r?.total || 0);
    topupCount = r?.count || 0;
  } catch (e) {}

  let walletTotal = 0;
  try {
    const r = await db.prepare("SELECT SUM(CAST(value AS REAL)) AS total FROM wallet_balance WHERE key LIKE 'u%:balance' OR key = 'balance'").first();
    walletTotal = parseFloat(r?.total || 0);
  } catch (e) {}

  let aiMessagesTotal = 0;
  try {
    const tables = await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND (name = 'chat_messages' OR name LIKE 'p_%_chat_messages')").all();
    for (const t of tables.results || []) {
      try {
        const r = await db.prepare(`SELECT COUNT(*) AS c FROM ${t.name}`).first();
        aiMessagesTotal += (r?.c || 0);
      } catch (e2) {}
    }
  } catch (e) {}

  let reportsOpen = 0;
  try {
    const r = await db.prepare("SELECT COUNT(*) AS c FROM admin_reports WHERE status = 'open'").first();
    reportsOpen = r?.c || 0;
  } catch (e) {}

  const dateList = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000);
    dateList.push(d.toISOString().slice(0, 10));
  }

  const usersDailyMap = new Map();
  try {
    const rows = await db.prepare("SELECT strftime('%Y-%m-%d', created_at) AS d, COUNT(*) AS count FROM auth_users WHERE created_at >= datetime('now', '-14 days') GROUP BY d").all();
    for (const r of rows.results || []) {
      if (r.d) usersDailyMap.set(r.d, r.count || 0);
    }
  } catch (e) {}

  const topupDailyMap = new Map();
  try {
    const rows = await db.prepare("SELECT strftime('%Y-%m-%d', created_at) AS d, SUM(amount) AS amount FROM topup_orders WHERE status = 'paid' AND created_at >= datetime('now', '-14 days') GROUP BY d").all();
    for (const r of rows.results || []) {
      if (r.d) topupDailyMap.set(r.d, parseFloat(r.amount || 0));
    }
  } catch (e) {}

  const deploysDailyMap = new Map();
  try {
    const rows = await db.prepare("SELECT strftime('%Y-%m-%d', created_at) AS d, COUNT(*) AS count FROM deploy_logs WHERE created_at >= datetime('now', '-14 days') GROUP BY d").all();
    for (const r of rows.results || []) {
      if (r.d) deploysDailyMap.set(r.d, r.count || 0);
    }
  } catch (e) {}

  const users_daily = dateList.map(d => ({ d, count: usersDailyMap.get(d) || 0 }));
  const topup_daily = dateList.map(d => ({ d, amount: topupDailyMap.get(d) || 0 }));
  const deploys_daily = dateList.map(d => ({ d, count: deploysDailyMap.get(d) || 0 }));

  return json({
    success: true,
    stats: {
      users_total: usersTotal,
      users_suspended: usersSuspended,
      new_users_7d: newUsers7d,
      projects_total: projectsTotal,
      deploys_total: deploysTotal,
      deploys_7d: deploys7d,
      topup_total_amount: topupTotalAmount,
      topup_count: topupCount,
      wallet_total: walletTotal,
      ai_messages_total: aiMessagesTotal,
      reports_open: reportsOpen
    },
    series: {
      users_daily,
      topup_daily,
      deploys_daily
    }
  });
}

async function handleGetUsers(db) {
  const usersRes = await db.prepare(
    "SELECT id, name, email, avatar_url, created_at, role, status, suspend_reason FROM auth_users ORDER BY created_at DESC"
  ).all();
  const rawUsers = usersRes.results || [];

  const planMap = new Map();
  try {
    const rows = await db.prepare("SELECT key, value FROM subscription WHERE key LIKE 'u%:plan'").all();
    for (const r of rows.results || []) {
      const m = r.key.match(/^u(\d+):plan$/);
      if (m) planMap.set(parseInt(m[1], 10), r.value);
    }
  } catch (e) {}

  const balanceMap = new Map();
  try {
    const rows = await db.prepare("SELECT key, value FROM wallet_balance WHERE key LIKE 'u%:balance'").all();
    for (const r of rows.results || []) {
      const m = r.key.match(/^u(\d+):balance$/);
      if (m) balanceMap.set(parseInt(m[1], 10), parseFloat(r.value || 0));
    }
  } catch (e) {}

  const projectsCountMap = new Map();
  try {
    const rows = await db.prepare("SELECT user_id, COUNT(*) AS c FROM user_projects WHERE user_id IS NOT NULL GROUP BY user_id").all();
    for (const r of rows.results || []) {
      projectsCountMap.set(r.user_id, r.c || 0);
    }
  } catch (e) {}

  const lastActivityMap = new Map();
  try {
    const rows = await db.prepare("SELECT user_id, MAX(created_at) AS last_act FROM activity_log WHERE user_id IS NOT NULL GROUP BY user_id").all();
    for (const r of rows.results || []) {
      lastActivityMap.set(r.user_id, r.last_act);
    }
  } catch (e) {}

  const topupTotalMap = new Map();
  try {
    const rows = await db.prepare("SELECT user_id, SUM(amount) AS total FROM topup_orders WHERE status = 'paid' AND user_id IS NOT NULL GROUP BY user_id").all();
    for (const r of rows.results || []) {
      topupTotalMap.set(r.user_id, parseFloat(r.total || 0));
    }
  } catch (e) {}

  const users = rawUsers.map(u => ({
    id: u.id,
    name: u.name || '',
    email: u.email || '',
    avatar_url: u.avatar_url || '',
    created_at: u.created_at,
    role: u.role || 'user',
    status: u.status || 'active',
    suspend_reason: u.suspend_reason || null,
    plan: planMap.get(u.id) || 'Free',
    balance: balanceMap.get(u.id) || 0,
    projects_count: projectsCountMap.get(u.id) || 0,
    last_activity: lastActivityMap.get(u.id) || null,
    topup_total: topupTotalMap.get(u.id) || 0
  }));

  return json({ success: true, users });
}

// Aktivitas sistem terbaru (dengan info user), untuk halaman Aktivitas Admin
async function handleGetActivity(db, request) {
  const url = new URL(request.url);
  const limitRaw = parseInt(url.searchParams.get('limit') || '100', 10);
  const limit = (!limitRaw || limitRaw < 1 || limitRaw > 300) ? 100 : limitRaw;
  const rows = await db.prepare(
    `SELECT a.id, a.action, a.details, a.created_at, a.user_id, u.name AS user_name, u.email AS user_email
     FROM activity_log a LEFT JOIN auth_users u ON u.id = a.user_id
     ORDER BY a.id DESC LIMIT ?`
  ).bind(limit).all();
  return json({ success: true, activities: rows.results || [] });
}

async function handlePostUsers(db, adminUser, body, reqAction) {
  const action = body.action || reqAction;
  const targetUserId = parseInt(body.user_id, 10);
  if (!targetUserId || isNaN(targetUserId)) {
    return json({ error: 'user_id wajib diisi' }, 400);
  }

  const targetUser = await db.prepare("SELECT id, email, role, status FROM auth_users WHERE id = ?").bind(targetUserId).first();
  if (!targetUser) {
    return json({ error: 'Pengguna tidak ditemukan' }, 404);
  }

  const adminEmail = adminUser.email || 'admin@clincoo';

  if (action === 'suspend') {
    if (Number(targetUserId) === Number(adminUser.id)) {
      return json({ error: 'Tidak dapat menangguhkan akun sendiri' }, 400);
    }
    const reason = String(body.reason || 'Penangguhan oleh admin');
    await db.prepare("UPDATE auth_users SET status = 'suspended', suspend_reason = ? WHERE id = ?")
      .bind(reason, targetUserId).run();
    await db.prepare("DELETE FROM auth_sessions WHERE user_id = ?").bind(targetUserId).run();

    try {
      await db.prepare("INSERT INTO activity_log (action, details, user_id) VALUES (?, ?, ?)")
        .bind('admin_suspend', `${adminEmail} -> user ${targetUserId}: ${reason}`, adminUser.id).run();
    } catch (e) {}

    return json({ success: true });
  }

  if (action === 'unsuspend') {
    await db.prepare("UPDATE auth_users SET status = 'active', suspend_reason = NULL WHERE id = ?")
      .bind(targetUserId).run();

    try {
      await db.prepare("INSERT INTO activity_log (action, details, user_id) VALUES (?, ?, ?)")
        .bind('admin_unsuspend', `${adminEmail} -> user ${targetUserId}: Aktifkan kembali`, adminUser.id).run();
    } catch (e) {}

    return json({ success: true });
  }

  if (action === 'delete') {
    if (Number(targetUserId) === Number(adminUser.id)) {
      return json({ error: 'Tidak dapat menghapus akun sendiri' }, 400);
    }
    await db.prepare("UPDATE auth_users SET status = 'deleted' WHERE id = ?")
      .bind(targetUserId).run();
    await db.prepare("DELETE FROM auth_sessions WHERE user_id = ?").bind(targetUserId).run();

    try {
      await db.prepare("INSERT INTO activity_log (action, details, user_id) VALUES (?, ?, ?)")
        .bind('admin_delete', `${adminEmail} -> user ${targetUserId}: Hapus akun (soft delete)`, adminUser.id).run();
    } catch (e) {}

    return json({ success: true, soft_deleted: true });
  }

  if (action === 'set_role') {
    if (Number(targetUserId) === Number(adminUser.id)) {
      return json({ error: 'Tidak dapat mengubah peran sendiri' }, 400);
    }
    const newRole = body.role === 'admin' ? 'admin' : 'user';
    await db.prepare("UPDATE auth_users SET role = ? WHERE id = ?")
      .bind(newRole, targetUserId).run();

    try {
      await db.prepare("INSERT INTO activity_log (action, details, user_id) VALUES (?, ?, ?)")
        .bind('admin_set_role', `${adminEmail} -> user ${targetUserId}: set role to ${newRole}`, adminUser.id).run();
    } catch (e) {}

    return json({ success: true });
  }

  if (action === 'adjust_balance') {
    const amount = parseFloat(body.amount);
    if (isNaN(amount)) {
      return json({ error: 'amount tidak valid' }, 400);
    }
    const balKey = 'u' + targetUserId + ':balance';

    let oldBal = 0;
    try {
      const row = await db.prepare("SELECT value FROM wallet_balance WHERE key = ?").bind(balKey).first();
      if (row) oldBal = parseFloat(row.value || 0);
    } catch (e) {}

    const newBal = oldBal + amount;

    await db.prepare("INSERT INTO wallet_balance (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .bind(balKey, String(newBal)).run();

    const txId = 'TX-ADM-' + Date.now() + '-' + Math.floor(Math.random() * 1000);
    const title = 'Penyesuaian Saldo Admin: ' + (body.reason || (amount >= 0 ? 'Kredit Admin' : 'Debet Admin'));
    const txType = amount >= 0 ? 'in' : 'out';
    try {
      await db.prepare("INSERT INTO wallet_transactions (id, title, amount, type, method, user_id) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(txId, title, Math.abs(amount), txType, 'admin', targetUserId).run();
    } catch (e) {}

    try {
      await db.prepare("INSERT INTO activity_log (action, details, user_id) VALUES (?, ?, ?)")
        .bind('admin_adjust_balance', `${adminEmail} -> user ${targetUserId}: adjust balance by ${amount} (new balance: ${newBal})`, adminUser.id).run();
    } catch (e) {}

    return json({ success: true, balance: newBal });
  }

  return json({ error: 'Aksi users tidak valid: ' + action }, 400);
}

function detectFlagType(action, details) {
  const text = `${action || ''} ${details || ''}`;

  if (/signature\s*invalid|signature\s*missing|\bhmac\b/i.test(text)) {
    return 'security_signature';
  }

  if (/\b(banned|illegal|judi|scam|phishing|malware|spam)\b/i.test(text)) {
    return 'abuse_keyword';
  }

  if (/login_fail|failed_login|gagal_login|invalid_password/i.test(text)) {
    return 'login_failed';
  }

  if (/amount.*-\d+|-amount|\b(1000000000|[0-9]{9,})\b/i.test(text)) {
    return 'amount_anomaly';
  }

  return null;
}

async function handleGetReports(db) {
  let reports = [];
  try {
    const rows = await db.prepare(
      `SELECT r.id, r.type, r.target_user_id, u.email AS target_email, r.details, r.status, r.source, r.created_at
       FROM admin_reports r
       LEFT JOIN auth_users u ON r.target_user_id = u.id
       ORDER BY r.created_at DESC`
    ).all();
    reports = (rows.results || []).map(r => ({
      id: r.id,
      type: r.type,
      target_user_id: r.target_user_id || null,
      target_email: r.target_email || null,
      details: r.details,
      status: r.status || 'open',
      source: r.source || 'system',
      created_at: r.created_at
    }));
  } catch (e) {}

  const autoFlags = [];
  try {
    const logs = await db.prepare(
      `SELECT a.id, a.action, a.details, a.user_id, a.created_at, u.email
       FROM activity_log a
       LEFT JOIN auth_users u ON a.user_id = u.id
       WHERE a.created_at >= datetime('now', '-30 days')
       ORDER BY a.created_at DESC LIMIT 500`
    ).all();

    for (const log of logs.results || []) {
      const flagType = detectFlagType(log.action, log.details);
      if (flagType) {
        autoFlags.push({
          id: 'auto_' + log.id,
          type: flagType,
          target_user_id: log.user_id || null,
          target_email: log.email || null,
          details: `${log.action}: ${log.details || ''}`,
          status: 'open',
          source: 'system',
          created_at: log.created_at
        });
      }
    }
  } catch (e) {}

  return json({ success: true, reports, auto_flags: autoFlags });
}

async function handlePostReports(db, adminUser, body, reqAction) {
  const action = body.action || reqAction;
  const adminEmail = adminUser.email || 'admin@clincoo';

  if (action === 'create') {
    const type = String(body.type || 'manual_report');
    const targetUserId = body.target_user_id ? parseInt(body.target_user_id, 10) : null;
    const details = String(body.details || '');
    if (!details) {
      return json({ error: 'details wajib diisi' }, 400);
    }

    await db.prepare(
      "INSERT INTO admin_reports (type, target_user_id, details, status, source) VALUES (?, ?, ?, 'open', 'admin')"
    ).bind(type, targetUserId, details).run();

    try {
      await db.prepare("INSERT INTO activity_log (action, details, user_id) VALUES (?, ?, ?)")
        .bind('admin_create_report', `${adminEmail} created report (type: ${type}) for user ${targetUserId || 'none'}`, adminUser.id).run();
    } catch (e) {}

    return json({ success: true });
  }

  if (action === 'resolve') {
    const reportId = parseInt(body.report_id, 10);
    if (!reportId || isNaN(reportId)) return json({ error: 'report_id wajib diisi' }, 400);

    await db.prepare("UPDATE admin_reports SET status = 'resolved' WHERE id = ?").bind(reportId).run();

    try {
      await db.prepare("INSERT INTO activity_log (action, details, user_id) VALUES (?, ?, ?)")
        .bind('admin_resolve_report', `${adminEmail} resolved report #${reportId}`, adminUser.id).run();
    } catch (e) {}

    return json({ success: true });
  }

  if (action === 'dismiss') {
    const reportId = parseInt(body.report_id, 10);
    if (!reportId || isNaN(reportId)) return json({ error: 'report_id wajib diisi' }, 400);

    await db.prepare("UPDATE admin_reports SET status = 'dismissed' WHERE id = ?").bind(reportId).run();

    try {
      await db.prepare("INSERT INTO activity_log (action, details, user_id) VALUES (?, ?, ?)")
        .bind('admin_dismiss_report', `${adminEmail} dismissed report #${reportId}`, adminUser.id).run();
    } catch (e) {}

    return json({ success: true });
  }

  if (action === 'scan') {
    let inserted = 0;
    try {
      const logs = await db.prepare(
        `SELECT a.id, a.action, a.details, a.user_id, a.created_at
         FROM activity_log a
         WHERE a.created_at >= datetime('now', '-30 days')
         ORDER BY a.created_at ASC LIMIT 2000`
      ).all();

      for (const log of logs.results || []) {
        const flagType = detectFlagType(log.action, log.details);
        if (!flagType) continue;

        const logDetails = `${log.action}: ${log.details || ''}`;
        const targetUserId = log.user_id || null;

        let existing = null;
        if (targetUserId !== null) {
          existing = await db.prepare(
            `SELECT id FROM admin_reports
             WHERE type = ? AND target_user_id = ? AND details = ? AND created_at >= datetime('now', '-7 days')
             LIMIT 1`
          ).bind(flagType, targetUserId, logDetails).first();
        } else {
          existing = await db.prepare(
            `SELECT id FROM admin_reports
             WHERE type = ? AND target_user_id IS NULL AND details = ? AND created_at >= datetime('now', '-7 days')
             LIMIT 1`
          ).bind(flagType, logDetails).first();
        }

        if (!existing) {
          await db.prepare(
            "INSERT INTO admin_reports (type, target_user_id, details, status, source) VALUES (?, ?, ?, 'open', 'system')"
          ).bind(flagType, targetUserId, logDetails).run();
          inserted++;
        }
      }
    } catch (e) {
      return json({ error: 'Gagal scan activity log: ' + e.message }, 500);
    }

    try {
      await db.prepare("INSERT INTO activity_log (action, details, user_id) VALUES (?, ?, ?)")
        .bind('admin_scan_reports', `${adminEmail} scanned activity_log, inserted ${inserted} reports`, adminUser.id).run();
    } catch (e) {}

    return json({ success: true, inserted });
  }

  return json({ error: 'Aksi reports tidak valid: ' + action }, 400);
}
