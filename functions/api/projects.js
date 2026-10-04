// Cloudflare Pages Functions — Daftar proyek PER AKUN (D1, tabel user_projects)
// GET    /api/projects            -> { projects: [...] } milik user login
// POST   /api/projects            -> { action: 'upsert'|'replace_all'|'delete'|'delete_all', ... }
// DELETE /api/projects?id=<id>    -> hapus satu proyek (tanpa id = semua milik user)
// Semua aksi wajib Bearer token (per akun, terisolasi lewat user_id).
import { currentUser } from './user-scope.js';
import { getToken } from './auth/shared.js';
import { getSecret, flatTemplate, sendEmail } from './notify-helpers.js';
import { getEffectivePlan } from './plan-helpers.js';
import { tableFor } from './_tables.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

function j(data, status) {
  return new Response(JSON.stringify(data), { status: status || 200, headers: { 'Content-Type': 'application/json', ...CORS } });
}

async function ensureTable(db) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS user_projects (
    id TEXT PRIMARY KEY,
    user_id INTEGER,
    title TEXT DEFAULT '',
    prompt TEXT DEFAULT '',
    ai_name TEXT DEFAULT '',
    ai_desc TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT
  )`).run();
}

function rowToProject(r) {
  return {
    id: r.id,
    title: r.title || '',
    prompt: r.prompt || '',
    aiName: r.ai_name || '',
    aiDesc: r.ai_desc || '',
    createdAt: r.created_at,
    updatedAt: r.updated_at || r.created_at
  };
}


// ===== Konfirmasi hapus proyek =====
// 1) Ketik nama proyek persis -> tombol Hapus aktif (frontend).
// 2) Sesi baru (< 15 menit sejak login) dianggap mencurigakan -> wajib OTP email.
const DELETE_SESSION_FRESH_MIN = 15;

// Setelah OTP hapus terverifikasi 1x, pengguna boleh hapus beberapa proyek berikutnya
// tanpa OTP lagi (batas jumlah + jendela waktu, mana habis dulu).
const DELETE_OTP_WAIVER_MINUTES = 60;
const DELETE_OTP_WAIVER_DELETES = 3;

// Sesi login masih "segar" (baru dibuat)? Pola pembajakan akun: login lalu langsung hapus proyek.
async function sessionFresh(db, request) {
  try {
    const row = await db.prepare('SELECT created_at FROM auth_sessions WHERE token = ?').bind(getToken(request)).first();
    if (!row || !row.created_at) return false;
    const t = Date.parse(String(row.created_at).replace(' ', 'T') + 'Z');
    return !isNaN(t) && (Date.now() - t) < DELETE_SESSION_FRESH_MIN * 60 * 1000;
  } catch (e) { return false; }
}

async function ensureDeleteOtpTable(db) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS project_delete_otps (
    user_id INTEGER PRIMARY KEY,
    code_hash TEXT,
    expires_at TEXT,
    attempts INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  )`).run();
}

// OTP hapus sudah pernah terverifikasi dan masih berlaku? -> hapus berikutnya tanpa OTP.
async function deleteOtpWaived(db, user) {
  try {
    const row = await db.prepare('SELECT code_hash, expires_at FROM project_delete_otps WHERE user_id = ?').bind(user.id).first();
    if (!row || row.code_hash !== 'verified') return false;
    const t = Date.parse(String(row.expires_at).replace(' ', 'T') + 'Z');
    return !isNaN(t) && t > Date.now();
  } catch (e) { return false; }
}

// Pakai 1 kuota hapus bebas-OTP; kalau kuota habis, state verified dibersihkan.
async function consumeDeleteWaiver(db, user) {
  try {
    await db.prepare(`UPDATE project_delete_otps SET
      attempts = MAX(0, attempts - 1),
      code_hash = CASE WHEN attempts <= 1 THEN 'expired' ELSE 'verified' END,
      expires_at = datetime('now', '+${DELETE_OTP_WAIVER_MINUTES} minutes')
      WHERE user_id = ?`).bind(user.id).run();
  } catch (e) {}
}

async function sha256hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// Kirim kode OTP 6 digit ke email akun (rate limit 1x/menit, berlaku 10 menit, hash saja yang disimpan).
async function sendDeleteOtp(env, db, user) {
  await ensureDeleteOtpTable(db);
  const last = await db.prepare('SELECT created_at FROM project_delete_otps WHERE user_id = ?').bind(user.id).first();
  if (last && last.created_at) {
    const t = Date.parse(String(last.created_at).replace(' ', 'T') + 'Z');
    if (!isNaN(t) && Date.now() - t < 60 * 1000) return j({ success: false, error: 'Tunggu 1 menit sebelum minta kode OTP baru.' }, 429);
  }
  const code = String(Math.floor(100000 + Math.random() * 900000));
  const codeHash = await sha256hex(user.id + ':' + code);
  await db.prepare(`INSERT INTO project_delete_otps (user_id, code_hash, expires_at) VALUES (?, ?, datetime('now', '+10 minutes'))
    ON CONFLICT(user_id) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0, created_at = datetime('now')`)
    .bind(user.id, codeHash).run();
  const sent = await sendEmail(env, {
    toEmail: user.email,
    subject: 'Kode OTP Hapus Proyek — Clincoo',
    html: flatTemplate('Kode OTP Hapus Proyek', null,
      '<p style="margin:0 0 20px;color:#374151;font-size:14px;line-height:1.7">Anda baru mengonfirmasi penghapusan proyek di Clincoo dari sesi login yang masih baru. Untuk keamanan, masukkan kode 6 digit di bawah ini untuk melanjutkan penghapusan.</p>' +
      '<p style="margin:0 0 20px;color:#374151;font-size:14px;line-height:1.7">Kode ini berlaku <b>10 menit</b> dan hanya bisa dipakai satu kali. Kalau ini bukan Anda, jangan bagikan kode ini dan segera amankan akun Anda.</p>',
      null, null, null, null, code)
  });
  if (!sent || !sent.sent) return j({ success: false, error: 'Kode OTP gagal dikirim ke email. Coba lagi sebentar.' }, 500);
  return j({ success: true, sent: true });
}

// Verifikasi kode OTP hapus (maks 5 percobaan, sekali pakai, kadaluarsa 10 menit).
async function verifyDeleteOtp(db, user, otp) {
  try {
    await ensureDeleteOtpTable(db);
    const row = await db.prepare('SELECT code_hash, expires_at, attempts FROM project_delete_otps WHERE user_id = ?').bind(user.id).first();
    if (!row || !otp) return { ok: false, error: 'Kode OTP diperlukan. Minta kode baru lalu coba lagi.' };
    if (Date.parse(String(row.expires_at).replace(' ', 'T') + 'Z') < Date.now()) return { ok: false, error: 'Kode OTP sudah kadaluarsa. Minta kode baru.' };
    if ((row.attempts || 0) >= 5) return { ok: false, error: 'Terlalu banyak percobaan salah. Minta kode baru.' };
    const hash = await sha256hex(user.id + ':' + String(otp));
    if (hash !== row.code_hash) {
      await db.prepare('UPDATE project_delete_otps SET attempts = attempts + 1 WHERE user_id = ?').bind(user.id).run();
      return { ok: false, error: 'Kode OTP salah.' };
    }
    // Sukses verifikasi: jangan hapus — tandai verified agar hapus proyek berikutnya
    // (sampai batas DELETE_OTP_WAIVER_DELETES kali / jendela waktu) tidak minta OTP lagi.
    await db.prepare('UPDATE project_delete_otps SET code_hash = ?, expires_at = datetime(?), attempts = ? WHERE user_id = ?')
      .bind('verified', new Date(Date.now() + DELETE_OTP_WAIVER_MINUTES * 60 * 1000).toISOString().replace('Z', ''), DELETE_OTP_WAIVER_DELETES, user.id).run();
    return { ok: true };
  } catch (e) { return { ok: false, error: 'Verifikasi OTP gagal. Coba lagi.' }; }
}

// Guard hapus proyek: proyek dengan ClincooPay aktif yang masih punya saldo /
// penarikan sedang diproses TIDAK boleh dihapus (saldo bisa lenyap tanpa jejak).
// Kalau tabel pay belum ada (proyek tanpa ClincooPay), izinkan hapus.
async function payDeleteGuard(db, projectId) {
  try {
    const cred = await db.prepare('SELECT pay_key FROM pay_creds WHERE project_id = ?').bind(projectId).first();
    if (!cred) return { ok: true };
    const paid = await db.prepare(`SELECT COALESCE(SUM(COALESCE(credit_amount, amount)),0) AS t FROM pay_transactions WHERE project_id = ? AND status = 'paid'`).bind(projectId).first();
    const wd = await db.prepare(`SELECT COALESCE(SUM(amount + COALESCE(fee,0)),0) AS t, COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END),0) AS p FROM pay_withdrawals WHERE project_id = ? AND status != 'rejected'`).bind(projectId).first();
    const available = Math.max(0, (paid && paid.t) || 0) - Math.min((wd && wd.t) || 0, Math.max(0, (paid && paid.t) || 0));
    const pendingWd = (wd && wd.p) || 0;
    if (available > 0 || pendingWd > 0) {
      const parts = [];
      if (available > 0) parts.push('saldo ClincooPay Rp ' + available.toLocaleString('id-ID'));
      if (pendingWd > 0) parts.push(pendingWd + ' penarikan sedang diproses');
      return { ok: false, available, pending_withdrawals: pendingWd,
        reason: 'Proyek tidak bisa dihapus: masih ada ' + parts.join(' dan ') + '. Tarik/cairkan dulu sebelum menghapus proyek.' };
    }
    return { ok: true };
  } catch (e) { return { ok: true }; }
}

async function upsert(db, uid, p) {
  if (!p || !p.id) return;
  await db.prepare(`INSERT INTO user_projects (id, user_id, title, prompt, ai_name, ai_desc, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET title = excluded.title, prompt = excluded.prompt,
      ai_name = excluded.ai_name, ai_desc = excluded.ai_desc, updated_at = excluded.updated_at
    WHERE user_projects.user_id = excluded.user_id`)
    .bind(String(p.id), uid, String(p.title || ''), String(p.prompt || ''),
          String(p.aiName || p.ai_name || ''), String(p.aiDesc || p.ai_desc || ''),
          String(p.updatedAt || new Date().toISOString())).run();
}

export async function onRequestOptions() { return new Response(null, { headers: CORS }); }

export async function onRequestGet({ request, env }) {
  try {
    const db = env.DB;
    if (!db) return j({ error: 'D1 not bound' }, 500);
    await ensureTable(db);
    const user = await currentUser(env, request);
    if (!user) return j({ error: 'unauthorized' }, 401);
    // Pre-check hapus (dipakai modal konfirmasi UI): ?delete_check=<id> -> boleh hapus / blokir + alasan
    const checkId = new URL(request.url).searchParams.get('delete_check');
    if (checkId) {
      const own = await db.prepare('SELECT id FROM user_projects WHERE id = ? AND user_id = ?').bind(checkId, user.id).first();
      if (!own) return j({ blocked: true, reason: 'Proyek tidak ditemukan atau bukan milik akun ini.' }, 404);
      const g = await payDeleteGuard(db, checkId);
      const otpRequired = (await sessionFresh(db, request)) && !(await deleteOtpWaived(db, user));
      return j(g.ok ? { ok: true, otp_required: otpRequired } : { blocked: true, otp_required: otpRequired, reason: g.reason, available: g.available, pending_withdrawals: g.pending_withdrawals });
    }
    const res = await db.prepare(
      'SELECT * FROM user_projects WHERE user_id = ? ORDER BY COALESCE(updated_at, created_at) DESC'
    ).bind(user.id).all();
    return j({ projects: (res.results || []).map(rowToProject) });
  } catch (err) {
    return j({ error: err.message }, 500);
  }
}

export async function onRequestPost({ request, env }) {
  try {
    const db = env.DB;
    if (!db) return j({ error: 'D1 not bound' }, 500);
    await ensureTable(db);
    const user = await currentUser(env, request);
    if (!user) return j({ error: 'unauthorized' }, 401);
    const body = await request.json();
    const action = body.action || 'upsert';

    if (action === 'transfer') {
      if (!body.id || !body.email) return j({ error: 'id dan email wajib diisi' }, 400);
      const email = String(body.email).trim().toLowerCase();
      const target = await db.prepare('SELECT id FROM auth_users WHERE email = ?').bind(email).all();
      if (!target.results || !target.results.length) return j({ error: 'Akun dengan email tersebut tidak ditemukan' }, 404);
      const targetId = target.results[0].id;
      if (String(targetId) === String(user.id)) return j({ error: 'Proyek sudah menjadi milik akun ini' }, 400);
      const upd = await db.prepare('UPDATE user_projects SET user_id = ? WHERE id = ? AND user_id = ?')
        .bind(targetId, String(body.id), user.id).run();
      if (!upd.meta || !upd.meta.changes) return j({ error: 'Proyek tidak ditemukan pada akun Anda' }, 404);
      return j({ success: true, transferred_to: email });
    }
    if (action === 'wipe_data') {
      if (!body.id) return j({ error: 'id required' }, 400);
      const own = await db.prepare('SELECT id FROM user_projects WHERE id = ? AND user_id = ?')
        .bind(String(body.id), user.id).all();
      if (!own.results || !own.results.length) return j({ error: 'Proyek tidak ditemukan pada akun Anda' }, 404);
      // kosongkan SEMUA data proyek (chat, file, settings, env vars, log) — proyek & situs tetap ada
      for (const t of ['chat_sessions', 'chat_messages', 'project_files', 'env_vars', 'project_settings', 'security_settings', 'deploy_logs']) {
        try { await db.prepare(`DELETE FROM ${tableFor(t, String(body.id))}`).run(); } catch (e) {}
      }
      return j({ success: true });
    }
    if (action === 'delete_otp_send') return await sendDeleteOtp(env, db, user);
    if (action === 'delete') {
      if (!body.id) return j({ error: 'id required' }, 400);
      const g = await payDeleteGuard(db, String(body.id));
      if (!g.ok) return j({ success: false, guarded: true, error: g.reason, available: g.available, pending_withdrawals: g.pending_withdrawals }, 400);
      if (await sessionFresh(db, request)) {
        if (await deleteOtpWaived(db, user)) await consumeDeleteWaiver(db, user);
        else {
          const v = await verifyDeleteOtp(db, user, body.otp);
          if (!v.ok) return j({ success: false, need_otp: true, error: v.error }, 400);
        }
      }
      await db.prepare('DELETE FROM user_projects WHERE id = ? AND user_id = ?').bind(String(body.id), user.id).run();
      // Kaskade: hapus SEMUA data proyek (chat, file workspace, settings, env vars, log deploy).
      // Dijalankan paralel (bukan satu-satu berurutan) supaya tidak lama/timeout di koneksi lambat.
      try {
        await Promise.all(['chat_sessions', 'chat_messages', 'project_files', 'file_chunks', 'env_vars', 'project_settings', 'security_settings', 'deploy_logs']
          .map(t => db.prepare(`DROP TABLE IF EXISTS ${tableFor(t, String(body.id))}`).run().catch(() => {})));
      } catch (e) {}
      return j({ success: true });
    }
    if (action === 'delete_all') {
      const rows = await db.prepare('SELECT id FROM user_projects WHERE user_id = ?').bind(user.id).all();
      let blocked = 0;
      for (const r of (rows.results || [])) { const g = await payDeleteGuard(db, r.id); if (!g.ok) blocked++; }
      if (blocked > 0) return j({ success: false, guarded: true, error: blocked + ' proyek masih punya saldo ClincooPay / penarikan berjalan. Tarik/cairkan dulu sebelum menghapus.' }, 400);
      if (await sessionFresh(db, request)) {
        if (await deleteOtpWaived(db, user)) await consumeDeleteWaiver(db, user);
        else {
          const v = await verifyDeleteOtp(db, user, body.otp);
          if (!v.ok) return j({ success: false, need_otp: true, error: v.error + ' Hapus satu per satu lewat halaman proyek untuk bisa memasukkan OTP.' }, 400);
        }
      }
      await db.prepare('DELETE FROM user_projects WHERE user_id = ?').bind(user.id).run();
      return j({ success: true });
    }
    if (action === 'replace_all') {
      const list = Array.isArray(body.projects) ? body.projects.slice(0, 500) : [];
      const planInfo = await getEffectivePlan(db, user);
      if (list.length > planInfo.limits.projectLimit) {
        return j({ success: false, error: 'Batas paket ' + planInfo.plan + ' tercapai: maksimal ' + planInfo.limits.projectLimit + ' proyek. Upgrade paket di halaman Langganan untuk menambah.', plan: planInfo.plan, limit: planInfo.limits.projectLimit, upgrade_needed: true }, 402);
      }
      await db.prepare('DELETE FROM user_projects WHERE user_id = ?').bind(user.id).run();
      for (const p of list) await upsert(db, user.id, p);
      return j({ success: true, count: list.length, plan: planInfo.plan });
    }
    // default: upsert satu proyek atau daftar
    const list = Array.isArray(body.projects) ? body.projects.slice(0, 500) : (body.project ? [body.project] : []);
    if (!list.length) return j({ success: true, count: 0 });
    // Penegakan batas paket: hanya proyek BARU yang dihitung (update proyek lama selalu boleh)
    const planInfo = await getEffectivePlan(db, user);
    const existing = await db.prepare('SELECT id FROM user_projects WHERE user_id = ?').bind(user.id).all();
    const have = new Set((existing.results || []).map(r => String(r.id)));
    const newCount = list.filter(p => p && p.id && !have.has(String(p.id))).length;
    const cur = (existing.results || []).length;
    if (cur + newCount > planInfo.limits.projectLimit) {
      return j({ success: false, error: 'Batas paket ' + planInfo.plan + ' tercapai: maksimal ' + planInfo.limits.projectLimit + ' proyek (sekarang ' + cur + '). Upgrade paket di halaman Langganan untuk menambah.', plan: planInfo.plan, limit: planInfo.limits.projectLimit, current: cur, upgrade_needed: true }, 402);
    }
    for (const p of list) await upsert(db, user.id, p);
    return j({ success: true, count: list.length, plan: planInfo.plan });
  } catch (err) {
    return j({ error: err.message }, 500);
  }
}

export async function onRequestDelete({ request, env }) {
  try {
    const db = env.DB;
    if (!db) return j({ error: 'D1 not bound' }, 500);
    await ensureTable(db);
    const user = await currentUser(env, request);
    if (!user) return j({ error: 'unauthorized' }, 401);
    const id = new URL(request.url).searchParams.get('id');
    if (id) {
      const g = await payDeleteGuard(db, id);
      if (!g.ok) return j({ success: false, guarded: true, error: g.reason, available: g.available, pending_withdrawals: g.pending_withdrawals }, 400);
      if (await sessionFresh(db, request)) return j({ success: false, need_otp: true, error: 'Sesi login masih baru: hapus proyek lewat halaman proyek dengan konfirmasi OTP.' }, 400);
      await db.prepare('DELETE FROM user_projects WHERE id = ? AND user_id = ?').bind(id, user.id).run();
    } else {
      const rows = await db.prepare('SELECT id FROM user_projects WHERE user_id = ?').bind(user.id).all();
      let blocked = 0;
      for (const r of (rows.results || [])) { const g = await payDeleteGuard(db, r.id); if (!g.ok) blocked++; }
      if (blocked > 0) return j({ success: false, guarded: true, error: blocked + ' proyek masih punya saldo ClincooPay / penarikan berjalan. Tarik/cairkan dulu sebelum menghapus.' }, 400);
      if (await sessionFresh(db, request)) return j({ success: false, need_otp: true, error: 'Sesi login masih baru: hapus proyek lewat halaman proyek dengan konfirmasi OTP.' }, 400);
      await db.prepare('DELETE FROM user_projects WHERE user_id = ?').bind(user.id).run();
    }
    return j({ success: true });
  } catch (err) {
    return j({ error: err.message }, 500);
  }
}
