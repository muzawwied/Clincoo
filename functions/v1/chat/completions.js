// Cloudflare Pages Function — /v1/chat/completions "Clinqoo Open API" (SELF-CONTAINED)
// Endpoint AI kompatibel OpenAI untuk proyek user. Secret di keluarkan per proyek
// lewat /api/ai/v1/secret (lihat functions/api/ai/v1/secret.js).
// Rantai provider (milik Clinqoo — user TIDAK membawa key sendiri):
//   Workers AI (binding "AI") -> OpenRouter (model gratis) -> Gemini (cadangan).
// Semua panggilan dicatat ke tabel ai_router_logs (dipakai halaman Integrasi AI).
// Jalur ini DI LUAR /api/* — middleware login tidak berlaku; auth pakai
// Bearer secret proyek yang divalidasi sendiri di sini.
//
//   POST /v1/chat/completions
//   { "model": "clinqoo/glm-5.2", "messages": [{ "role": "user", "content": "Halo!" }] }

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...CORS } });

export async function onRequestOptions() {
  return new Response(null, { status: 200, headers: CORS });
}

export async function onRequestGet() {
  // Dokumentasi singkat gaya OpenAI saat GET tanpa body
  return json({
    object: 'endpoint',
    id: 'clinqoo-open-api',
    endpoint: '/v1/chat/completions',
    method: 'POST',
    auth: 'Bearer <secret proyek Clinqoo>',
    docs_hint: 'Buat secret di halaman Integrasi AI pada Clinqoo workspace.'
  });
}

// --- Rate limit per-IP (isolate-local, pola ai.js) ---
const RATE_LIMIT = { max: 30, windowMs: 60_000 };
const rateBuckets = new Map();
function rateLimitOk(ip) {
  const now = Date.now();
  let b = rateBuckets.get(ip);
  if (!b || now - b.start >= RATE_LIMIT.windowMs) b = { start: now, count: 0 };
  b.count++;
  rateBuckets.set(ip, b);
  if (rateBuckets.size > 5000) for (const [k, v] of rateBuckets) if (now - v.start >= RATE_LIMIT.windowMs) rateBuckets.delete(k);
  return b.count <= RATE_LIMIT.max;
}
function clientIp(request) {
  try { return (request && request.headers && request.headers.get('cf-connecting-ip')) || 'unknown'; } catch (e) { return 'unknown'; }
}

// ===== Peta model Clinqoo -> provider =====
const WORKERS_AI = {
  'clinqoo/glm-5.2': '@cf/zai-org/glm-5.2',
  'clinqoo/deepseek-v4-flash': '@cf/deepseek-ai/deepseek-v4-flash-0731',
  'clinqoo/glm-4.7-flash': '@cf/zai-org/glm-4.7-flash'
};
const OPENROUTER = {
  'clinqoo/nemotron-super': 'nvidia/nemotron-3-super-120b-a12b:free',
  'clinqoo/nemotron-lightning': 'nvidia/nemotron-3.5-lightning:free'
};
const GEMINI = { 'clinqoo/gemini-flash': ['gemini-3.6-flash', 'gemini-3-flash-preview'] };
const AUTO_CHAIN = ['clinqoo/glm-5.2', 'clinqoo/deepseek-v4-flash', 'clinqoo/glm-4.7-flash', 'clinqoo/nemotron-super', 'clinqoo/nemotron-lightning', 'clinqoo/gemini-flash'];
const ALL_MODELS = [...Object.keys(WORKERS_AI), ...Object.keys(OPENROUTER), ...Object.keys(GEMINI), 'clinqoo/auto'];

function normalizeMessages(messages) {
  const out = [];
  for (const m of (messages || [])) {
    if (!m || !m.role) continue;
    let text = '';
    if (typeof m.content === 'string') text = m.content;
    else if (Array.isArray(m.content)) {
      const parts = [];
      for (const b of m.content) if (b && b.type === 'text' && b.text) parts.push(b.text);
      text = parts.join('\n');
    }
    if (m.role === 'system') { if (text) out.push({ role: 'system', content: text }); }
    else if (m.role === 'user' || m.role === 'assistant') { if (text) out.push({ role: m.role, content: text }); }
  }
  return out;
}

// ===== Kunci provider (env var / tabel env_vars — pola ai.js) =====
async function getEnvKey(env, name) {
  if (env[name]) return env[name];
  if (!env.DB) return null;
  try {
    const row = await env.DB.prepare('SELECT value FROM env_vars WHERE key = ?').bind(name).first();
    return row?.value || null;
  } catch { return null; }
}
async function getGeminiKeys(env) {
  const keys = [];
  const seen = new Set();
  const add = v => { v = String(v || '').trim(); if (v && !seen.has(v)) { seen.add(v); keys.push(v); } };
  add(env.GEMINI_API_KEY);
  if (env.DB) {
    try {
      const rows = await env.DB.prepare("SELECT key, value FROM env_vars WHERE key IN ('GEMINI_API_KEY','GEMINI_API_KEY_2','GEMINI_API_KEY_3')").all();
      for (const r of rows.results || []) add(r.value);
    } catch {}
  }
  return keys;
}

// ===== Provider calls (kembalikan {text, model, tokens} | {error}) =====
async function tryWorkersAI(env, messages) {
  if (!env.AI) return { error: 'Workers AI binding tidak tersedia' };
  const sysIdx = messages.findIndex(m => m.role === 'system');
  const system = sysIdx !== -1 ? messages[sysIdx].content : '';
  const chatMsgs = messages.filter(m => m.role !== 'system').map(m => ({ role: m.role, content: m.content }));
  let lastErr = null;
  for (const [publicId, model] of Object.entries(WORKERS_AI)) {
    try {
      const payload = { messages: chatMsgs };
      if (system) payload.system = system;
      const result = await env.AI.run(model, payload);
      const raw = (result && (result.response || (typeof result === 'string' ? result : ''))) || '';
      const text = raw || ((result && Array.isArray(result.choices) && result.choices[0] && result.choices[0].message && result.choices[0].message.content) || '');
      if (text) {
        const tokens = Math.ceil((chatMsgs.map(m => m.content).join(' ').length + text.length) / 4);
        return { text, model: publicId, tokens };
      }
      lastErr = `Model ${model}: respons kosong`;
    } catch (e) { lastErr = `Model ${model}: ${e && e.message}`; }
  }
  return { error: lastErr || 'Workers AI gagal' };
}

async function tryOpenRouter(env, messages) {
  const key = await getEnvKey(env, 'OPENROUTER_API_KEY');
  if (!key) return { error: 'OpenRouter key tidak tersedia' };
  let lastErr = null;
  for (const [publicId, model] of Object.entries(OPENROUTER)) {
    try {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
        body: JSON.stringify({ model, messages })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { lastErr = `Model ${model}: HTTP ${res.status}`; continue; }
      const text = data?.choices?.[0]?.message?.content || '';
      if (text) {
        const tokens = (data.usage && data.usage.total_tokens) || Math.ceil((JSON.stringify(messages).length + text.length) / 4);
        return { text, model: publicId, tokens };
      }
      lastErr = `Model ${model}: respons kosong`;
    } catch (e) { lastErr = `Model ${model}: ${e && e.message}`; }
  }
  return { error: lastErr || 'OpenRouter gagal' };
}

async function tryGemini(env, messages) {
  const keys = await getGeminiKeys(env);
  if (!keys.length) return { error: 'Gemini key tidak tersedia' };
  const sys = messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
  const contents = messages.filter(m => m.role !== 'system').map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
  const models = GEMINI['clinqoo/gemini-flash'];
  let lastErr = null;
  for (const key of keys) {
    for (const model of models) {
      try {
        const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + key, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents, ...(sys ? { systemInstruction: { parts: [{ text: sys }] } } : {}) })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) { lastErr = `Gemini ${model}: HTTP ${res.status}`; continue; }
        const parts = (data.candidates?.[0]?.content?.parts) || [];
        const text = parts.map(p => p.text || '').join('');
        if (text) {
          const tokens = (data.usageMetadata && (data.usageMetadata.totalTokenCount)) || Math.ceil((JSON.stringify(messages).length + text.length) / 4);
          return { text, model: 'clinqoo/gemini-flash', tokens };
        }
        lastErr = `Gemini ${model}: respons kosong`;
      } catch (e) { lastErr = `Gemini ${model}: ${e && e.message}`; }
    }
  }
  return { error: lastErr || 'Gemini gagal' };
}

// ===== Log ke D1 (tabel ai_router_logs) =====
async function logCall(db, projectId, model, ok, ms, tokens, err) {
  if (!db) return;
  try {
    await db.prepare('CREATE TABLE IF NOT EXISTS ai_router_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT, ts TEXT, model TEXT, ok INTEGER, ms INTEGER, tokens INTEGER, err TEXT)').run();
    await db.prepare('INSERT INTO ai_router_logs (project_id, ts, model, ok, ms, tokens, err) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(projectId, new Date().toISOString(), model, ok ? 1 : 0, ms || 0, tokens || 0, String(err || '').slice(0, 120)).run();
    // batasi 500 baris terakhir per proyek
    await db.prepare('DELETE FROM ai_router_logs WHERE project_id = ? AND id NOT IN (SELECT id FROM (SELECT id FROM ai_router_logs WHERE project_id = ? ORDER BY id DESC LIMIT 500))').bind(projectId, projectId).run();
  } catch (e) {}
}

async function initSecretTable(db) {
  await db.prepare('CREATE TABLE IF NOT EXISTS ai_router_secrets (project_id TEXT PRIMARY KEY, secret TEXT NOT NULL, created_at TEXT, last_used TEXT)').run();
}

export async function onRequestPost({ request, env }) {
  const ip = clientIp(request);
  if (!rateLimitOk(ip)) return json({ error: { message: 'Terlalu banyak permintaan. Coba lagi sebentar.', type: 'rate_limit', code: 429 } }, 429);

  // cap payload 512KB
  const cl = parseInt(request.headers.get('content-length') || '0', 10);
  if (cl > 512000) return json({ error: { message: 'Payload terlalu besar.', type: 'invalid_request', code: 413 } }, 413);

  // --- Auth: Bearer secret proyek ---
  const auth = (request.headers.get('authorization') || '').trim();
  const secret = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
  if (!secret) return json({ error: { message: 'Secret proyek diperlukan (Authorization: Bearer <secret>). Buat di halaman Integrasi AI Clincoo.', type: 'auth', code: 401 } }, 401);

  const db = env.DB;
  if (!db) return json({ error: { message: 'Backend database tidak tersedia.', type: 'server', code: 500 } }, 500);
  try { await initSecretTable(db); } catch (e) {}
  let projectId = null;
  try {
    const row = await db.prepare('SELECT project_id FROM ai_router_secrets WHERE secret = ?').bind(secret).first();
    if (row && row.project_id) {
      projectId = row.project_id;
      try { await db.prepare('UPDATE ai_router_secrets SET last_used = ? WHERE project_id = ?').bind(new Date().toISOString(), projectId).run(); } catch (e) {}
    }
  } catch (e) {}
  if (!projectId) return json({ error: { message: 'Secret tidak valid atau sudah dicabut.', type: 'auth', code: 401 } }, 401);

  // --- Body ---
  let body = null;
  try { body = await request.json(); } catch (e) { body = null; }
  if (!body || !Array.isArray(body.messages) || !body.messages.length) {
    return json({ error: { message: "Field 'messages' (array) wajib diisi.", type: 'invalid_request', code: 400 } }, 400);
  }
  const messages = normalizeMessages(body.messages);
  if (!messages.length) return json({ error: { message: "Field 'messages' kosong atau tidak valid.", type: 'invalid_request', code: 400 } }, 400);

  let model = String(body.model || 'clinqoo/auto');
  if (model === 'clinqoo/auto' || !ALL_MODELS.includes(model)) {
    if (model && model !== 'clinqoo/auto' && !ALL_MODELS.includes(model)) {
      return json({ error: { message: 'Model tidak dikenal. Model tersedia: ' + ALL_MODELS.join(', '), type: 'invalid_request', code: 400 } }, 400);
    }
    model = 'clinqoo/auto';
  }

  const t0 = Date.now();
  const chain = model === 'clinqoo/auto' ? AUTO_CHAIN : [model];
  let result = null;
  for (const step of chain) {
    if (WORKERS_AI[step]) result = await tryWorkersAI(env, messages);
    else if (OPENROUTER[step]) result = await tryOpenRouter(env, messages);
    else if (GEMINI[step]) result = await tryGemini(env, messages);
    else continue;
    if (result && result.text) break;
  }
  const ms = Date.now() - t0;

  if (!result || !result.text) {
    await logCall(db, projectId, model, 0, ms, 0, (result && result.error) || 'semua provider gagal');
    return json({ error: { message: (result && result.error) || 'Semua provider AI gagal. Coba lagi nanti.', type: 'server', code: 502 } }, 502);
  }

  await logCall(db, projectId, result.model, 1, ms, result.tokens, '');

  const completion = {
    id: 'chatcmpl-' + crypto.randomUUID(),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: model,
    choices: [{ index: 0, message: { role: 'assistant', content: result.text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: result.tokens || 0 },
    clinqoo: { served_model: result.model, latency_ms: ms }
  };
  return json(completion);
}
