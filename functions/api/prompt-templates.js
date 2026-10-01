// ===== Kapsul Template Prompt (dibuat AI sesuai pembahasan, bukan hardcode) =====
// POST /api/prompt-templates  { messages: [{role, content}] }
// -> { templates: ["...", "..."] }
// Guest boleh (tanpa login) — ringan & rate-limited.
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

const RL = { limit: 12, window: 60_000 };
const _b = new Map();
function rlOk(ip) {
  const now = Date.now();
  let a = (_b.get(ip) || []).filter(t => now - t < RL.window);
  if (a.length >= RL.limit) { _b.set(ip, a); return false; }
  a.push(now); _b.set(ip, a);
  return true;
}

// ===== Kunci AI (OpenRouter utama, Workers AI fallback) =====
async function getOpenRouterKeys(env) {
  const keys = [];
  const seen = new Set();
  const add = v => { v = String(v || '').trim(); if (v && !seen.has(v)) { seen.add(v); keys.push(v); } };
  add(env.OPENROUTER_API_KEY);
  add(env.OPENROUTER_API_KEY_4); add(env.OPENROUTER_API_KEY_5); add(env.OPENROUTER_API_KEY_6);
  if (!env.DB) return keys;
  try {
    const rows = await env.DB.prepare("SELECT key, value FROM env_vars WHERE key IN ('OPENROUTER_API_KEY','OPENROUTER_API_KEY_2','OPENROUTER_API_KEY_3','OPENROUTER_API_KEY_4','OPENROUTER_API_KEY_5','OPENROUTER_API_KEY_6')").all();
    for (const r of rows.results || []) add(r.value);
  } catch {}
  return keys;
}

const SYSTEM_PROMPT = [
  'Kamu generator template prompt untuk aplikasi Clincoo.',
  'Berdasarkan percakapan yang diberikan, buat 4 template prompt singkat yang paling relevan untuk dilanjutkan oleh user.',
  'Aturan:',
  '- Setiap template MAKSIMAL 90 karakter, satu kalimat, bahasa Indonesia (atau bahasa percakapan).',
  '- Template harus spesifik mengikuti topik/pembahasan terakhir — JANGAN generik ("ceritakan lebih banyak").',
  '- Sebut langsung objek topiknya (mis. nama fitur, subjek, atau tugas yang sedang dibahas).',
  '- Boleh berupa instruksi lanjutan, permintaan variasi, atau tindak lanjut logis.',
  '- Jawab HANYA array JSON berisi 4 string. Tanpa penjelasan, tanpa format lain.',
  'Contoh keluaran: ["Buatkan halaman pricing 3 kolom","Tambahkan dark mode ke dashboard","Ringkas hasilnya jadi tabel","Bandingkan dengan solusi alternatif"]'
].join('\n');

function extractContext(messages) {
  const out = [];
  for (const m of (Array.isArray(messages) ? messages : [])) {
    if (!m || typeof m !== 'object') continue;
    const role = m.role === 'assistant' || m.role === 'ai' ? 'assistant' : (m.role === 'user' ? 'user' : null);
    const content = typeof m.content === 'string' ? m.content : (typeof m.text === 'string' ? m.text : '');
    if (!role || !content.trim()) continue;
    out.push({ role, content: content.slice(0, 1200) });
  }
  return out.slice(-8); // 8 pesan terakhir cukup
}

async function aiGenerate(env, ctx) {
  if (!ctx.length) return { text: '' };
  // 1) OpenRouter (GLM 5.3 Flash) — utama
  const orKeys = await getOpenRouterKeys(env);
  if (orKeys.length) {
    try {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + orKeys[0], 'HTTP-Referer': 'https://clincoo.pages.dev', 'X-Title': 'Clincoo' },
        body: JSON.stringify({ model: 'z-ai/glm-5.3-flash', max_tokens: 500, messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: JSON.stringify(ctx) }] })
      });
      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        const text = data?.choices?.[0]?.message?.content || '';
        if (text) return { text };
      }
    } catch (e) {}
  }
  // 2) Workers AI — fallback
  if (env.AI) {
    try {
      const result = await env.AI.run('@cf/zai-org/glm-4.7-flash', {
        messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: JSON.stringify(ctx) }]
      });
      const text = (result && (result.response || (typeof result === 'string' ? result : ''))) || '';
      if (text) return { text };
    } catch (e) {}
  }
  return { text: '' };
}

// Parse keluaran AI -> array string (tahan banting: code fence, teks di depan/belakang)
function parseTemplates(text) {
  if (!text) return [];
  let t = String(text).trim();
  const m = t.match(/\[[\s\S]*\]/); // array JSON pertama
  if (!m) return [];
  try {
    let arr = JSON.parse(m[0]);
    if (!Array.isArray(arr)) return [];
    arr = arr.filter(x => typeof x === 'string' && x.trim()).map(x => x.trim().slice(0, 120));
    return arr.slice(0, 6);
  } catch (e) { return []; }
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestPost({ request, env }) {
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  if (!rlOk(ip)) {
    return new Response(JSON.stringify({ error: 'Terlalu banyak permintaan.' }), { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': '60', ...CORS } });
  }
  let body = {};
  try { body = await request.json(); } catch (e) {}
  const ctx = extractContext(body.messages);
  if (!ctx.length) {
    return new Response(JSON.stringify({ templates: [] }), { headers: { 'Content-Type': 'application/json', ...CORS } });
  }
  const { text } = await aiGenerate(env, ctx);
  const templates = parseTemplates(text);
  return new Response(JSON.stringify({ templates }), { headers: { 'Content-Type': 'application/json', ...CORS } });
}
