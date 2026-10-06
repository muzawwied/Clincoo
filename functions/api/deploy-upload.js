// ==== Proxy upload aset Pages untuk deploy orkestrasi browser ====
// Worker paket gratis hanya punya ~10ms CPU per request — hash & upload file
// besar dikerjakan BROWSER (dashboard), bukan Worker. Browser tidak bisa
// memanggil api.cloudflare.com langsung (tanpa header CORS), jadi request
// uploadnya diarahkan ke sini dan BODY DITERUSKAN SEBAGAI STREAM TANPA
// DI-PARSE (fetch subrequest streaming) — CPU Worker tetap ~0 berapa pun
// ukuran payloadnya.
// Endpoint: POST /api/deploy-upload?project_id=...&sub=check-missing|upsert-hashes|upload
// Auth: sama seperti semua API proyek (login + pemilik proyek), token upload
// Cloudflare dikirim browser lewat header x-upload-jwt (diperoleh dari action
// 'prepare' pada /api/deploy, berumur pendek, khusus upload aset).

import { guardProject } from './user-scope.js';

const API_BASE = 'https://api.cloudflare.com/client/v4';

// Endpoint aset Pages diautentikasi oleh JWT upload itu sendiri
// (sama seperti jalur legacy): /client/v4/pages/assets/* — tanpa account id.
const SUBS = {
  'check-missing': '/pages/assets/check-missing',
  'upsert-hashes': '/pages/assets/upsert-hashes',
  'upload': '/pages/assets/upload'
};

function jerr(msg, status) {
  return new Response(JSON.stringify({ error: msg }), {
    status: status || 400,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
  });
}

export async function onRequestPost({ request, env }) {
  const url = new URL(request.url);
  const projectId = url.searchParams.get('project_id') || '';
  const deny = await guardProject(env, request, projectId);
  if (deny) return deny;
  if (!projectId) return jerr('project_id required', 400);

  const sub = url.searchParams.get('sub') || '';
  const jwt = request.headers.get('x-upload-jwt') || '';
  if (!SUBS[sub]) return jerr('sub tidak dikenal: ' + sub, 400);
  if (!jwt) return jerr('token upload (x-upload-jwt) kosong — jalankan action prepare dulu.', 400);

  const target = SUBS[sub];

  try {
    // Streaming passthrough: request.body (stream dari browser) diteruskan
    // langsung ke API Cloudflare — tanpa json(), tanpa buffer di memori.
    const res = await fetch(API_BASE + target, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + jwt, 'Content-Type': 'application/json' },
      body: request.body,
      signal: AbortSignal.timeout(300000)
    });
    return new Response(res.body, {
      status: res.status,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' }
    });
  } catch (e) {
    // request.body hanya bisa dibaca SEKALI — kalau fetch streaming gagal,
    // body sudah hangus dan tidak bisa diulang; laporkan ke klien untuk retry.
    return jerr('Upload ke Cloudflare gagal: ' + (e && e.message ? e.message : 'kesalahan jaringan') + ' — coba lagi.', 502);
  }
}
