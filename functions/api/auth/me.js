import { initTables, getUserByToken, getToken, publicUser, json, CORS } from './shared.js';

export async function onRequestOptions() { return new Response(null, { status: 204, headers: CORS }); }

export async function onRequestGet({ request, env }) {
  const db = env.DB;
  if (!db) return json({ error: 'D1 not bound' }, 500);
  try {
    await initTables(db);
    const user = await getUserByToken(db, getToken(request));
    return json({ authenticated: !!user, user: user ? publicUser(user) : null });
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}
