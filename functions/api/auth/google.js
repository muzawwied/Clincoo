// GET  /api/auth/google -> {client_id}
// POST /api/auth/google {code, redirect_uri} -> tukar code Google jadi sesi Clincoo
import { initTables, upsertOauthUser, createSession, publicUser, getEnvVarDb, json, CORS } from './shared.js';

export async function onRequestOptions() { return new Response(null, { status: 204, headers: CORS }); }

export async function onRequestGet({ request, env }) {
  const db = env.DB;
  const clientId = db ? await getEnvVarDb(db, 'GOOGLE_CLIENT_ID') : null;
  if (!clientId) return json({ error: 'Client ID Google tidak tersedia.' }, 500);
  return json({ client_id: clientId });
}

export async function onRequestPost({ request, env }) {
  const db = env.DB;
  if (!db) return json({ error: 'D1 not bound' }, 500);
  try {
    await initTables(db);
    const clientId = await getEnvVarDb(db, 'GOOGLE_CLIENT_ID');
    const clientSecret = await getEnvVarDb(db, 'GOOGLE_CLIENT_SECRET');
    if (!clientId || !clientSecret) return json({ error: 'Google OAuth belum dikonfigurasi' }, 500);

    const body = await request.json().catch(() => ({}));
    if (!body.code) return json({ error: 'Authorization code diperlukan' }, 400);

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId, client_secret: clientSecret,
        code: body.code, grant_type: 'authorization_code',
        redirect_uri: body.redirect_uri || ''
      })
    });
    const tokenData = await tokenRes.json().catch(() => ({}));
    if (!tokenData.access_token) return json({ error: 'Kode login Google tidak valid atau sudah dipakai' }, 401);

    const infoRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { 'Authorization': 'Bearer ' + tokenData.access_token }
    });
    const info = await infoRes.json().catch(() => ({}));
    if (!info.email) return json({ error: 'Tidak bisa mendapatkan email dari Google' }, 401);

    const user = await upsertOauthUser(db, 'google', info.sub, info.email.toLowerCase(), info.name || info.given_name || '', info.picture || '');
    const token = await createSession(db, user.id);
    return json({ success: true, token, user: publicUser(user) });
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}
