import { initTables, verifyPassword, publicUser, createSession, json, CORS } from './shared.js';

export async function onRequestOptions() { return new Response(null, { status: 204, headers: CORS }); }

export async function onRequestPost({ request, env }) {
  const db = env.DB;
  if (!db) return json({ error: 'D1 not bound' }, 500);
  try {
    await initTables(db);
    const body = await request.json().catch(() => ({}));
    const email = (body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    const user = await db.prepare('SELECT * FROM auth_users WHERE email = ?').bind(email).first();
    if (!user) return json({ error: 'Email atau kata sandi salah' }, 401);
    const ok = await verifyPassword(password, user.password_hash);
    if (!ok) return json({ error: 'Email atau kata sandi salah' }, 401);
    const token = await createSession(db, user.id);
    try {
      await db.prepare('INSERT INTO activity_log (action, details, user_id) VALUES (?, ?, ?)')
        .bind('login', 'Login berhasil dari perangkat baru', user.id).run();
    } catch (e2) { /* aktivitas opsional */ }
    return json({ success: true, token, user: publicUser(user) });
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}
