// Cloudflare Pages Function — Notion Public Integration connector (OAuth)
// Alur sama dengan konektor Google Drive: user klik "Hubungkan Notion" di halaman
// Integrasi -> diarahkan ke notion.com/v1/oauth/authorize -> Notion balik ke
// /integrasi/?code=... -> halaman kirim code ke endpoint ini -> ditukar jadi
// access token (bearer) -> token dikembalikan ke BROWSER user, TIDAK disimpan
// di server Clincoo. Kredensial OAuth (Client ID/Secret) dibaca dari D1 env_vars.
import { currentUser } from './user-scope.js';
import { getEnvVarDb } from './auth/shared.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

const REDIRECT_URI = 'https://app.clincoo.buzz/integrasi/';

function jsonResponse(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', ...CORS }
  });
}

async function notionCredentials(db) {
  const clientId = await getEnvVarDb(db, 'NOTION_CLIENT_ID');
  const clientSecret = await getEnvVarDb(db, 'NOTION_CLIENT_SECRET');
  return { clientId, clientSecret };
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

// GET -> info yang dibutuhkan frontend untuk memulai OAuth (client_id publik by design)
export async function onRequestGet({ request, env }) {
  const user = await currentUser(env, request);
  if (!user) return jsonResponse({ error: 'Silakan login Clincoo terlebih dahulu.' }, 401);
  if (!env.DB) return jsonResponse({ error: 'Database belum terhubung.' }, 500);
  const { clientId } = await notionCredentials(env.DB);
  if (!clientId) return jsonResponse({ error: 'Notion belum dikonfigurasi di server Clincoo.' }, 503);
  return jsonResponse({ client_id: clientId, redirect_uri: REDIRECT_URI });
}

export async function onRequestPost({ request, env }) {
  const user = await currentUser(env, request);
  if (!user) return jsonResponse({ error: 'Silakan login Clincoo terlebih dahulu untuk menghubungkan Notion.' }, 401);
  const db = env.DB;
  if (!db) return jsonResponse({ error: 'Database belum terhubung.' }, 500);

  const { clientId, clientSecret } = await notionCredentials(db);
  if (!clientId || !clientSecret) {
    return jsonResponse({ error: 'Konektor Notion belum dikonfigurasi di server Clincoo.' }, 503);
  }

  const body = await request.json().catch(() => ({}));

  // ---- Alur 1: refresh access token (access token OAuth Notion berumur pendek) ----
  if (body.refresh_token && !body.code) {
    try {
      const basic = btoa(clientId + ':' + clientSecret);
      const tokenRes = await fetch('https://api.notion.com/v1/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Basic ' + basic },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          refresh_token: String(body.refresh_token)
        })
      });
      const tokenData = await tokenRes.json().catch(() => ({}));
      if (!tokenData.access_token) {
        return jsonResponse({ error: (tokenData.error && tokenData.message) ? (tokenData.error + ': ' + tokenData.message) : 'Refresh token Notion tidak valid.' }, 401);
      }
      return jsonResponse({ access_token: tokenData.access_token });
    } catch (e) {
      return jsonResponse({ error: 'Gagal menghubungi Notion: ' + (e && e.message || e) }, 502);
    }
  }

  // ---- Alur 2: tukar authorization code jadi access token ----
  if (!body.code) return jsonResponse({ error: 'Kode otorisasi tidak ditemukan.' }, 400);
  try {
    const basic = btoa(clientId + ':' + clientSecret);
    const tokenRes = await fetch('https://api.notion.com/v1/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Basic ' + basic },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code: String(body.code),
        redirect_uri: REDIRECT_URI
      })
    });
    const tokenData = await tokenRes.json().catch(() => ({}));
    if (!tokenData.access_token) {
      const d = tokenData.error ? (tokenData.error + (tokenData.message ? ': ' + tokenData.message : '')) : ('HTTP ' + tokenRes.status);
      return jsonResponse({ error: 'Gagal menghubungkan Notion (' + d + ').' }, 400);
    }
    return jsonResponse({
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token || undefined,
      workspace_name: (tokenData.workspace_name || '') || '',
      workspace_id: tokenData.workspace_id || '',
      owner_name: (tokenData.owner && tokenData.owner.name) || '',
      bot_id: tokenData.bot_id || ''
    });
  } catch (e) {
    return jsonResponse({ error: 'Gagal menghubungi Notion: ' + (e && e.message || e) }, 502);
  }
}
