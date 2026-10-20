// GET /api/auth/github-token — token GitHub milik user dari sesi login Clincoo
// Dipakai workspace agar import repo tidak perlu auth GitHub lagi
import { initTables, getUserByToken, getToken, json, CORS } from './shared.js';

export async function onRequestOptions() { return new Response(null, { status: 204, headers: CORS }); }

export async function onRequestGet({ request, env }) {
  const db = env.DB;
  if (!db) return json({ error: 'D1 not bound' }, 500);
  try {
    await initTables(db);
    const user = await getUserByToken(db, getToken(request));
    if (!user) return json({ error: 'Tidak terautentikasi' }, 401);
    const link = await db.prepare(
      "SELECT access_token, scope FROM auth_oauth_accounts WHERE user_id = ? AND provider = 'github' ORDER BY id DESC LIMIT 1"
    ).bind(user.id).first();
    if (!link || !link.access_token) return json({ access_token: null });
    // Token hanya berguna untuk import repo jika scope-nya menyertakan 'repo'
    const scopes = String(link.scope || '').split(/[\s,]+/);
    if (!scopes.includes('repo')) return json({ access_token: null });
    return json({ access_token: link.access_token });
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}
