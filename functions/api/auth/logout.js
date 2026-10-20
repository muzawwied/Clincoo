import { getToken, json, CORS } from './shared.js';

export async function onRequestOptions() { return new Response(null, { status: 204, headers: CORS }); }

export async function onRequestPost({ request, env }) {
  const db = env.DB;
  if (!db) return json({ error: 'D1 not bound' }, 500);
  try {
    const token = getToken(request);
    if (token) await db.prepare('DELETE FROM auth_sessions WHERE token = ?').bind(token).run();
    return json({ success: true });
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}
