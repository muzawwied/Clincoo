import { initTables, makePasswordHash, validEmail, publicUser, createSession, json, CORS } from './shared.js';

export async function onRequestOptions() { return new Response(null, { status: 204, headers: CORS }); }

export async function onRequestPost({ request, env }) {
  const db = env.DB;
  if (!db) return json({ error: 'D1 not bound' }, 500);
  try {
    await initTables(db);
    const body = await request.json().catch(() => ({}));
    const email = (body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    const name = String(body.name || '').trim();
    if (!validEmail(email)) return json({ error: 'Format email tidak valid' }, 400);
    if (password.length < 6) return json({ error: 'Kata sandi minimal 6 karakter' }, 400);
    if (!name) return json({ error: 'Nama wajib diisi' }, 400);

    const existing = await db.prepare('SELECT id FROM auth_users WHERE email = ?').bind(email).first();
    if (existing) return json({ error: 'Email sudah terdaftar. Silakan masuk.' }, 400);

    const passwordHash = await makePasswordHash(password);
    await db.prepare('INSERT INTO auth_users (name, email, password_hash, avatar_url) VALUES (?, ?, ?, \'\')')
      .bind(name, email, passwordHash).run();
    const user = await db.prepare('SELECT * FROM auth_users WHERE email = ?').bind(email).first();
    const token = await createSession(db, user.id);
    return json({ success: true, token, user: publicUser(user) });
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}
