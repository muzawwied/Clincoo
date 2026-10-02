// POST /api/auth/reset-password — set kata sandi baru dengan token dari email
import { initTables, json, makePasswordHash } from './shared.js';

export async function onRequestOptions() {
  return new Response(null, { headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' } });
}

async function sha256Hex(str) {
  const bits = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(bits)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function onRequestPost({ request, env }) {
  const db = env.DB;
  if (!db) return json({ error: 'D1 not bound' }, 500);
  try {
    await initTables(db);
    const body = await request.json().catch(() => ({}));
    const token = String(body.token || '').trim();
    const password = String(body.password || '');
    if (!token) return json({ error: 'Token tidak valid' }, 400);
    if (password.length < 8) return json({ error: 'Kata sandi minimal 8 karakter' }, 400);

    const tokenHash = await sha256Hex(token);
    const row = await db.prepare('SELECT * FROM password_resets WHERE token_hash = ? AND used = 0').bind(tokenHash).first();
    if (!row) return json({ error: 'Tautan tidak valid atau sudah dipakai' }, 400);
    if (new Date(row.expires_at) < new Date()) return json({ error: 'Tautan sudah kedaluwarsa — minta yang baru' }, 400);

    const user = await db.prepare('SELECT * FROM auth_users WHERE id = ?').bind(row.user_id).first();
    if (!user) return json({ error: 'Akun tidak ditemukan' }, 400);

    const newHash = await makePasswordHash(password);
    await db.prepare('UPDATE auth_users SET password_hash = ? WHERE id = ?').bind(newHash, user.id).run();
    await db.prepare('UPDATE password_resets SET used = 1 WHERE id = ?').bind(row.id).run();
    // Paksa login ulang: hapus semua sesi lama
    await db.prepare('DELETE FROM auth_sessions WHERE user_id = ?').bind(user.id).run();
    return json({ success: true, message: 'Kata sandi berhasil diubah. Silakan masuk kembali.' });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
