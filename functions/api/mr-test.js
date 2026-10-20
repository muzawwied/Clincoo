// Cloudflare Pages Function — /api/mr-test
// [21 Okt, laporan pemilik: "di histori ModelRouter tidak ada GLM"]
// Tes koneksi ke ModelRouter dengan kunci aplikasi (MODELROUTER_API_KEY),
// model utama chat glm-5.3-flash:mr. Hanya admin/owner. Tes yang berhasil
// juga muncul di Usage Logs dashboard ModelRouter milik pemilik, jadi ini
// sekaligus alat verifikasi "apakah permintaan chat benar-benar lewat MR".

import { currentUser } from './user-scope.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};
const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status,
  headers: { 'Content-Type': 'application/json', ...CORS }
});

async function guardAdmin(env, request) {
  try {
    const user = await currentUser(env, request);
    if (!user) return { deny: json({ error: 'Login diperlukan', need_login: true }, 401) };
    if (user.role !== 'admin' && user.role !== 'owner') return { deny: json({ error: 'Hanya admin.' }, 403) };
    return { user };
  } catch (e) {
    return { deny: json({ error: 'Gagal memeriksa sesi: ' + String((e && e.message) || e) }, 500) };
  }
}

async function pickKeys(env) {
  const keys = [];
  const seen = new Set();
  const add = (v, src) => { v = String(v || '').trim(); if (v && !seen.has(v)) { seen.add(v); keys.push({ value: v, src }); } };
  add(env.MODELROUTER_API_KEY, 'env Pages');
  try {
    if (env.DB) {
      const rows = await env.DB.prepare("SELECT value FROM env_vars WHERE key = 'MODELROUTER_API_KEY'").all();
      for (const r of rows.results || []) add(r.value, 'tabel env_vars');
    }
  } catch (e) {}
  return keys;
}
const tail4 = k => { k = String(k || ''); return k.length > 8 ? '…' + k.slice(-4) : '(pendek)'; };

export async function onRequestOptions() {
  return new Response(null, { headers: CORS });
}

export async function onRequestGet({ request, env }) {
  const a = await guardAdmin(env, request);
  if (a.deny) return a.deny;
  const keys = await pickKeys(env);
  return json({ configured: keys.length > 0, key_count: keys.length, key_tail: keys.length ? tail4(keys[0].value) : '', model: 'glm-5.3-flash:mr' });
}

export async function onRequestPost({ request, env }) {
  const a = await guardAdmin(env, request);
  if (a.deny) return a.deny;
  const keys = await pickKeys(env);
  if (!keys.length) return json({ ok: false, error: 'Key MODELROUTER_API_KEY belum diatur di backend ini (env Pages maupun tabel env_vars). Chat di domain ini TIDAK memakai ModelRouter — semua jawaban jalan lewat cadangan (Gemini/OpenRouter).' });
  const key = keys[0].value;
  const keySrc = keys[0].src, keyTail = tail4(key);
  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch('https://modelrouter.id/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + key,
        'HTTP-Referer': 'https://clincoo.buzz',
        'X-Title': 'Clincoo'
      },
      body: JSON.stringify({
        model: 'glm-5.3-flash:mr',
        messages: [{ role: 'user', content: 'Tes koneksi. Balas dengan satu kata: OK' }],
        max_tokens: 16
      }),
      signal: ctrl.signal
    });
    clearTimeout(timer);
    const data = await res.json().catch(() => ({}));
    const ms = Date.now() - t0;
    if (!res.ok) {
      const msg = (data && data.error && (data.error.message || data.error)) || ('HTTP ' + res.status);
      return json({ ok: false, status: res.status, ms, key_src: keySrc, key_tail: keyTail, error: String(msg).slice(0, 300) });
    }
    const text = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
    return json({
      ok: true,
      status: res.status,
      ms,
      model: (data.model || 'glm-5.3-flash:mr'),
      reply: String(text).slice(0, 120),
      key_src: keySrc,
      key_tail: keyTail
    });
  } catch (e) {
    clearTimeout(timer);
    return json({ ok: false, error: 'Gagal menghubungi modelrouter.id: ' + String((e && e.message) || e).slice(0, 200) });
  }
}
