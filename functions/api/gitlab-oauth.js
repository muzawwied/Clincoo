import { currentUser } from './user-scope.js';
import { getEffectivePlan, featureAllowed, featureGateResponse } from './plan-helpers.js';

// Cloudflare Pages Functions - GitLab OAuth token exchange (proxy server-side).
// Client secret GitLab TIDAK PERNAH dikirim ke browser — tukar code dan refresh
// token selalu lewat endpoint ini. Kredensial dibaca dari:
// 1) env Cloudflare Pages (GITLAB_CLIENT_ID / GITLAB_CLIENT_SECRET) — prioritas tertinggi
// 2) tabel env_vars global D1
// 3) tabel env_vars per-proyek (p_%_env_vars) — pola sama dengan github-oauth.js.
// Token hasil tukar dikembalikan ke perangkat user, tidak disimpan di server.

export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    }
  });
}

async function getSecrets(env) {
  // 1) Cloudflare Pages environment variables
  if (env.GITLAB_CLIENT_ID && env.GITLAB_CLIENT_SECRET) {
    return { clientId: env.GITLAB_CLIENT_ID, clientSecret: env.GITLAB_CLIENT_SECRET };
  }
  if (!env.DB) return { clientId: '', clientSecret: '' };
  try {
    let clientId = '';
    let clientSecret = '';
    // 2) Global env_vars table
    const idRow = await env.DB.prepare('SELECT value FROM env_vars WHERE key = ?').bind('GITLAB_CLIENT_ID').first();
    const secretRow = await env.DB.prepare('SELECT value FROM env_vars WHERE key = ?').bind('GITLAB_CLIENT_SECRET').first();
    if (idRow?.value) clientId = idRow.value;
    if (secretRow?.value) clientSecret = secretRow.value;
    // 3) Fallback: any per-project env_vars table (set via the app's Environment page)
    if (!clientId || !clientSecret) {
      const tables = await env.DB.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'p\\_%\\_env\\_vars'"
      ).all();
      for (const t of tables.results || []) {
        if (clientId && clientSecret) break;
        if (!clientId) {
          const r = await env.DB.prepare('SELECT value FROM ' + t.name + ' WHERE key = ?').bind('GITLAB_CLIENT_ID').first();
          if (r?.value) clientId = r.value;
        }
        if (!clientSecret) {
          const r = await env.DB.prepare('SELECT value FROM ' + t.name + ' WHERE key = ?').bind('GITLAB_CLIENT_SECRET').first();
          if (r?.value) clientSecret = r.value;
        }
      }
    }
    return { clientId, clientSecret };
  } catch {
    return { clientId: '', clientSecret: '' };
  }
}

function jsonResponse(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store'
    }
  });
}

async function tokenRequest(params) {
  const body = Object.keys(params).map(function (k) {
    return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]);
  }).join('&');
  const res = await fetch('https://gitlab.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body
  });
  const data = await res.json().catch(function () { return {}; });
  if (!res.ok || !data.access_token) {
    const err = new Error(data.error_description || data.error || ('HTTP ' + res.status));
    err.status = res.status;
    throw err;
  }
  return data;
}

export async function onRequestPost({ request, env }) {
  try {
    const { clientId, clientSecret } = await getSecrets(env);
    if (!clientId || !clientSecret) {
      const missing = !clientId && !clientSecret ? 'Client ID dan Client Secret'
        : (!clientId ? 'Client ID' : 'Client Secret');
      return jsonResponse({ error: 'Kredensial GitLab OAuth belum lengkap: ' + missing + ' belum diatur' }, 500);
    }

    const body = await request.json().catch(function () { return {}; });

    // Integrasi Git = fitur paket Pro — ditegakkan di server untuk user yang
    // teridentifikasi lewat token login (pola sama dengan github-oauth.js).
    const user = await currentUser(env, request);
    if (user) {
      const eff = await getEffectivePlan(env.DB, user);
      if (!featureAllowed(eff.plan, 'gitIntegration')) return featureGateResponse('gitIntegration', eff.plan);
    }

    const redirectUri = String(body.redirect_uri || '');

    // ---- Alur 1: refresh token (akses kedaluwarsa, refresh token masih hidup) ----
    if (body.refresh_token && !body.code) {
      const params = {
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: String(body.refresh_token),
        grant_type: 'refresh_token'
      };
      if (redirectUri) params.redirect_uri = redirectUri;
      const data = await tokenRequest(params);
      return jsonResponse({
        access_token: data.access_token,
        refresh_token: data.refresh_token || String(body.refresh_token),
        expires_in: data.expires_in || 7200,
        scope: data.scope || 'api'
      });
    }

    // ---- Alur 2: tukar authorization code (koneksi pertama / ulang) ----
    const code = body.code;
    if (!code) return jsonResponse({ error: 'Authorization code diperlukan.' }, 400);
    if (!redirectUri) return jsonResponse({ error: 'redirect_uri diperlukan.' }, 400);

    const params = {
      client_id: clientId,
      client_secret: clientSecret,
      code: String(code),
      grant_type: 'authorization_code',
      redirect_uri: redirectUri
    };
    // PKCE: verifier dikirim klien (challenge dikirim saat authorize).
    if (body.code_verifier) params.code_verifier = String(body.code_verifier);

    const data = await tokenRequest(params);
    return jsonResponse({
      access_token: data.access_token,
      refresh_token: data.refresh_token || '',
      expires_in: data.expires_in || 7200,
      scope: data.scope || 'api'
    });
  } catch (err) {
    return jsonResponse({ error: err.message || 'Gagal menukar token GitLab.' }, err.status || 500);
  }
}
