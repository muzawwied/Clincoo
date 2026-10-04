// Cloudflare Pages Functions - AI Image Generation (tool Clincoo AI)
// POST /api/generate-image  { project_id, prompt }
// -> { ok: true, data_url: "data:image/png;base64,..." }
// Model gambar Workers AI (flux -> SDXL fallback); guard kepemilikan proyek via guardProject.

import { guardProject } from './user-scope.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...CORS } });
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

async function bytesOf(result) {
  // Workers AI model gambar: balikin ReadableStream (bytes PNG) atau object { image: base64 }
  if (result && typeof result.pipeThrough === 'function') {
    const buf = await new Response(result).arrayBuffer();
    return new Uint8Array(buf);
  }
  if (result && typeof result === 'object' && typeof result.image === 'string' && result.image) {
    let b = result.image;
    const i = b.indexOf('base64,');
    if (i >= 0) b = b.slice(i + 7);
    const bin = atob(b);
    const u = new Uint8Array(bin.length);
    for (let j = 0; j < bin.length; j++) u[j] = bin.charCodeAt(j);
    return u;
  }
  return null;
}

export async function onRequestPost({ request, env }) {
  try {
    const body = await request.json();
    const projectId = String(body.project_id || '');
    const prompt = String(body.prompt || '').trim();
    if (!prompt) return json({ error: 'Prompt tidak boleh kosong.' }, 400);
    if (prompt.length > 900) return json({ error: 'Prompt terlalu panjang (maks 900 karakter).' }, 400);
    const deny = await guardProject(env, request, projectId);
    if (deny) return deny;
    if (!env.AI) return json({ error: 'Workers AI tidak tersedia di server ini.' }, 500);

    let out = null;
    let lastErr = '';
    for (const model of ['@cf/black-forest-labs/flux-1-schnell', '@cf/stability-ai/stable-diffusion-xl-base-1.0']) {
      try {
        const result = await env.AI.run(model, { prompt });
        const b = await bytesOf(result);
        if (b && b.length > 100) { out = b; break; }
        lastErr = model + ': respons kosong';
      } catch (e) { lastErr = model + ': ' + (e && e.message ? e.message : e); }
    }
    if (!out) return json({ error: 'Gagal membuat gambar (' + lastErr + ')' }, 502);

    let bin = '';
    for (let i = 0; i < out.length; i += 4096) bin += String.fromCharCode.apply(null, out.subarray(i, i + 4096));
    return json({ ok: true, data_url: 'data:image/png;base64,' + btoa(bin) });
  } catch (err) {
    return json({ error: err && err.message ? err.message : 'Error tak terduga' }, 500);
  }
}
