// POST /api/auth/github {code, redirect_uri} — tukar code GitHub jadi sesi Clincoo
import { initTables, upsertOauthUser, createSession, publicUser, getEnvVarDb, json, CORS } from './shared.js';

export async function onRequestOptions() { return new Response(null, { status: 204, headers: CORS }); }

export async function onRequestPost({ request, env }) {
  const db = env.DB;
  if (!db) return json({ error: 'D1 not bound' }, 500);
  try {
    await initTables(db);
    const clientId = await getEnvVarDb(db, 'GITHUB_CLIENT_ID');
    const clientSecret = await getEnvVarDb(db, 'GITHUB_CLIENT_SECRET');
    if (!clientId || !clientSecret) return json({ error: 'GitHub OAuth belum dikonfigurasi' }, 500);

    const body = await request.json().catch(() => ({}));
    if (!body.code) return json({ error: 'Authorization code diperlukan' }, 400);

    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code: body.code, redirect_uri: body.redirect_uri || '' })
    });
    const tokenData = await tokenRes.json().catch(() => ({}));
    if (!tokenData.access_token) return json({ error: 'Kode login GitHub tidak valid atau sudah dipakai' }, 401);
    const ghToken = tokenData.access_token;

    const ghHeaders = { 'Authorization': 'Bearer ' + ghToken, 'Accept': 'application/vnd.github+json', 'User-Agent': 'clincoo' };
    const ghUser = await (await fetch('https://api.github.com/user', { headers: ghHeaders })).json();
    let email = ghUser.email;
    if (!email) {
      const emails = await (await fetch('https://api.github.com/user/emails', { headers: ghHeaders })).json().catch(() => []);
      const primary = (Array.isArray(emails) ? emails : []).find(e => e.primary) || (Array.isArray(emails) ? emails[0] : null);
      if (primary) email = primary.email;
    }
    if (!email) return json({ error: 'Tidak bisa mendapatkan email dari GitHub' }, 401);

    const user = await upsertOauthUser(db, 'github', ghUser.id, email.toLowerCase(), ghUser.name || ghUser.login || '', ghUser.avatar_url || '', ghToken, tokenData.scope || '');
    const token = await createSession(db, user.id);
    return json({ success: true, token, user: publicUser(user) });
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}
