// Cloudflare Pages Functions - Google Drive connector OAuth
// Menukar authorization code Google (scope Drive) jadi access + refresh token.
// Kredensial OAuth Google dibaca dari D1 (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET) —
// klien yang sama dengan login Google Clincoo; redirect_uri pakai halaman /auth/
// yang SUDAH terdaftar di Google Console, jadi tidak perlu pendaftaran URI baru.
// Token konektor TIDAK disimpan di server — hanya dikembalikan ke perangkat user.
import { currentUser } from './user-scope.js';
import { getEnvVarDb } from './auth/shared.js';

export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    }
  });
}

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';

function jsonResponse(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
  });
}

export async function onRequestPost({ request, env }) {
  try {
    // Konektor bersifat per-akun: wajib login Clincoo dulu.
    const user = await currentUser(env, request);
    if (!user) {
      return jsonResponse({ error: 'Silakan login Clincoo terlebih dahulu untuk menghubungkan Google Drive.' }, 401);
    }

    const db = env.DB;
    if (!db) return jsonResponse({ error: 'Database belum terhubung.' }, 500);
    const clientId = await getEnvVarDb(db, 'GOOGLE_CLIENT_ID');
    const clientSecret = await getEnvVarDb(db, 'GOOGLE_CLIENT_SECRET');
    if (!clientId || !clientSecret) {
      return jsonResponse({ error: 'Google OAuth belum dikonfigurasi di server Clincoo.' }, 500);
    }

    const body = await request.json().catch(() => ({}));

    // ---- Alur 1: refresh token (akses kedaluwarsa, token masih hidup) ----
    if (body.refresh_token && !body.code) {
      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          refresh_token: String(body.refresh_token),
          grant_type: 'refresh_token'
        })
      });
      const tokenData = await tokenRes.json().catch(() => ({}));
      if (!tokenData.access_token) {
        return jsonResponse({ error: (tokenData.error_description || tokenData.error) || 'Gagal memperbarui token Drive.' }, 401);
      }
      return jsonResponse({
        access_token: tokenData.access_token,
        expires_in: tokenData.expires_in || 3600,
        scope: tokenData.scope || DRIVE_SCOPE
      });
    }

    // ---- Alur 2: tukar authorization code (koneksi pertama / ulang) ----
    const code = body.code;
    if (!code) return jsonResponse({ error: 'Authorization code diperlukan.' }, 400);
    const redirectUri = body.redirect_uri || '';
    if (!redirectUri) return jsonResponse({ error: 'redirect_uri diperlukan (harus persis /auth/ Clincoo).' }, 400);

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code: String(code),
        grant_type: 'authorization_code',
        redirect_uri: String(redirectUri)
      })
    });
    const tokenData = await tokenRes.json().catch(() => ({}));
    if (!tokenData.access_token) {
      const reason = tokenData.error_description || tokenData.error || 'gagal menukar code';
      return jsonResponse({ error: 'Gagal menghubungkan Google Drive: ' + reason }, 400);
    }

    // Ambil info akun Google untuk ditampilkan di kartu plugin (nama + email).
    let guser = null;
    try {
      const infoRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: { Authorization: 'Bearer ' + tokenData.access_token }
      });
      const info = await infoRes.json().catch(() => ({}));
      if (info && (info.email || info.name)) {
        guser = { name: info.name || info.email, email: info.email || '', picture: info.picture || '' };
      }
    } catch (e) {}

    return jsonResponse({
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token || '',
      expires_in: tokenData.expires_in || 3600,
      scope: tokenData.scope || DRIVE_SCOPE,
      user: guser
    });
  } catch (err) {
    return jsonResponse({ error: err.message || 'Kesalahan server.' }, 500);
  }
}
