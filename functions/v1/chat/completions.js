import { PLAN_AI_API_CREDITS, ADMIN_EMAILS, getEffectivePlanByUserKey } from '../../api/plan-helpers.js';

// Cloudflare Pages Function — /v1/chat/completions "Clincoo Open API" (SELF-CONTAINED)
// Endpoint AI kompatibel OpenAI untuk proyek user. Secret di keluarkan per proyek
// lewat /api/ai/v1/secret. Model: infrastruktur AI Clincoo (white-label — nama
// provider TIDAK diumumkan di mana pun, termasuk di pesan error; model
// ditampilkan sebagai clincoo/*).
// Semua panggilan dicatat ke tabel ai_router_logs (dipakai halaman Integrasi AI).
// Jalur ini DI LUAR /api/* — middleware login tidak berlaku; auth pakai
// Bearer secret proyek yang divalidasi sendiri di sini.
//
//   POST /v1/chat/completions
//   { "model": "clincoo/glm-5.2", "messages": [{ "role": "user", "content": "Halo!" }] }

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
  return json({
    object: 'endpoint',
    id: 'clincoo-open-api',
    endpoint: '/v1/chat/completions',
    method: 'POST',
    auth: 'Bearer <secret proyek Clincoo>',
    docs_hint: 'Buat secret di halaman Integrasi AI pada Clincoo workspace.'
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

// ===== Peta model publik Clincoo (white-label — nama provider TIDAK pernah
// ditampilkan ke user, baik di daftar model, cURL, maupun pesan error) =====
// provider: 'cf' = infrastruktur internal Clincoo (binding AI) — tanpa biaya tambahan.
// provider: 'ext' = jaringan mitra model gratis Clincoo — alokasi gratis juga.
// provider: 'gemini' = Google AI Studio (kunci milik Clincoo) — alokasi gratis.
const AI_MODELS = {
  // --- infrastruktur internal Clincoo ---
  'clincoo/glm-5.2': { provider: 'cf', internal: '@cf/zai-org/glm-5.2', note: 'Flagship — reasoning & kode', free: true },
  'clincoo/deepseek-v4-flash': { provider: 'cf', internal: '@cf/deepseek-ai/deepseek-v4-flash-0731', note: 'Cepat — konteks besar', free: true },
  'clincoo/glm-4.7-flash': { provider: 'cf', internal: '@cf/zai-org/glm-4.7-flash', note: 'Multilingual — ramah Bahasa Indonesia', free: true },
  // --- jaringan mitra model gratis Clincoo ---
  'clincoo/reasoning-120b': { provider: 'ext', internal: 'nvidia/nemotron-3-super-120b-a12b:free', note: 'Model besar — reasoning umum', free: true },
  'clincoo/reasoning-550b': { provider: 'ext', internal: 'nvidia/nemotron-3-ultra-550b-a55b:free', note: 'Model terbesar — konteks 1M token', free: true },
  'clincoo/lightning': { provider: 'ext', internal: 'nvidia/nemotron-3.5-lightning:free', note: 'Ringan & cepat — konteks 1M token', free: true },
  'clincoo/omni-nano': { provider: 'ext', internal: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free', note: 'Multimodal — teks, gambar, audio', free: true },
  'clincoo/multimodal-27b': { provider: 'ext', internal: 'qwen/qwen3.8-27b:free', note: 'Multimodal — teks, gambar, video', free: true },
  'clincoo/reasoning-mini': { provider: 'ext', internal: 'apodex/apodex-1.1-mini:free', note: 'Reasoning — riset & analisis panjang', free: true },
  'clincoo/ling-flash': { provider: 'ext', internal: 'inclusionai/ling-3.0-flash-sante:free', note: 'Cepat & ringan', free: true },
  'clincoo/dots-note': { provider: 'ext', internal: 'dots-studio/dots-3-note-preview:free', note: 'Multimodal — teks & gambar', free: true },
  'clincoo/lfm-mini': { provider: 'ext', internal: 'liquid/lfm-2.5-2.6b:free', note: 'Mini — super ringan & cepat', free: true },
  'clincoo/laguna-s': { provider: 'ext', internal: 'poolside/laguna-s-2.1:free', note: 'Serba guna', free: true },
  'clincoo/north-code': { provider: 'ext', internal: 'cohere/north-mini-code:free', note: 'Fokus kode', free: true },
  // --- Google AI Studio (Gemini) — kunci milik Clincoo, teruji per 3 Okt 2026 ---
  'clincoo/gemini-3.8-flash': { provider: 'gemini', internal: 'gemini-3.8-flash', note: 'Cepat — reasoning & multimodal', free: true },
  'clincoo/gemini-3.6-flash': { provider: 'gemini', internal: 'gemini-3.6-flash', note: 'Seimbang — tugas umum', free: true },
  'clincoo/gemini-3.5-flash': { provider: 'gemini', internal: 'gemini-3.5-flash', note: 'Multimodal — teks & gambar', free: true },
  'clincoo/gemini-3.1-flash-lite': { provider: 'gemini', internal: 'gemini-3.1-flash-lite', note: 'Super ringan & cepat', free: true },
  // ===== Model generasi baru (dropdown Integrasi AI) — semua di infrastruktur internal, tetap gratis =====
  'clincoo/deepseek-v4-pro': { provider: 'cf', internal: '@cf/deepseek-ai/deepseek-v4-pro-0813', note: 'Reasoning — konteks 1M token', free: true },
  'clincoo/glm-5.3': { provider: 'cf', internal: '@cf/zai-org/glm-5.3', note: 'Coding & agentic (otomasi multi-langkah)', free: true },
  'clincoo/glm-5.3-flash': { provider: 'cf', internal: '@cf/zai-org/glm-5.3-flash', note: 'Cepat — multimodal', free: true },
  'clincoo/gpt-oss-120b': { provider: 'cf', internal: '@cf/openai/gpt-oss-120b', note: 'Reasoning terbuka — performa tinggi', free: true },
  'clincoo/gpt-oss-20b': { provider: 'cf', internal: '@cf/openai/gpt-oss-20b', note: 'Ringan & cepat — tugas harian', free: true },
  'clincoo/kimi-k2.6': { provider: 'cf', internal: '@cf/moonshotai/kimi-k2.6', note: 'Frontier 1T — tugas kompleks', free: true },
  'clincoo/kimi-k2.7-code': { provider: 'cf', internal: '@cf/moonshotai/kimi-k2.7-code', note: 'Fokus kode & debugging', free: true },
  'clincoo/llama-4-scout': { provider: 'cf', internal: '@cf/meta/llama-4-scout-17b-16e-instruct', note: 'Multimodal — teks & gambar', free: true },
  'clincoo/llama-3.3-70b': { provider: 'cf', internal: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', note: 'Serba guna — performa seimbang', free: true },
  'clincoo/mistral-small-3.1': { provider: 'cf', internal: '@cf/mistralai/mistral-small-3.1-24b-instruct', note: 'Cepat — konteks besar', free: true },
  'clincoo/qwq-32b': { provider: 'cf', internal: '@cf/qwen/qwq-32b', note: 'Reasoning langkah demi langkah', free: true },
  'clincoo/qwen-coder-32b': { provider: 'cf', internal: '@cf/qwen/qwen2.5-coder-32b-instruct', note: 'Fokus kode', free: true },
  'clincoo/granite-4-micro': { provider: 'cf', internal: '@cf/ibm-granite/granite-4.0-h-micro', note: 'Super ringan & hemat', free: true },
  'clincoo/sea-lion-27b': { provider: 'cf', internal: '@cf/aisingapore/gemma-sea-lion-v4-27b-it', note: 'Bahasa Asia Tenggara', free: true },
  'clincoo/acak': { provider: 'ext', internal: 'openrouter/free', note: 'Pilih otomatis dari jaringan mitra gratis', free: true }
};
// Rantai clincoo/auto: infrastruktur internal dulu (3x), lalu mitra gratis
// paling stabil sebagai cadangan.
const AUTO_CHAIN = [
  'clincoo/glm-5.2', 'clincoo/deepseek-v4-flash', 'clincoo/glm-4.7-flash',
  'clincoo/reasoning-550b', 'clincoo/gemini-3.8-flash', 'clincoo/acak'
];
const ALL_MODELS = [...Object.keys(AI_MODELS), 'clincoo/auto'];

// ===== Harga per model (kredit Open API) — mikro-dolar per PANGGILAN =====
// 1 unit = $0.000001 ($1 = 1.000.000 unit). Harga flat per request: mudah
// dipahami user & prediktabel. Tier: super ringan 10, ringan 15, standar 25,
// pro 50, ultra 80. clincoo/auto = 25 (harga tetap, apa pun model internal
// yang merespons — billing prediktabel, biaya internal bukan urusan user).
const MODEL_PRICES = {
  'clincoo/auto': 25,
  // super ringan ($0.000010)
  'clincoo/lightning': 10, 'clincoo/ling-flash': 10, 'clincoo/lfm-mini': 10,
  'clincoo/granite-4-micro': 10, 'clincoo/gemini-3.1-flash-lite': 10,
  // ringan ($0.000015)
  'clincoo/glm-4.7-flash': 15, 'clincoo/deepseek-v4-flash': 15, 'clincoo/gpt-oss-20b': 15,
  'clincoo/dots-note': 15, 'clincoo/north-code': 15, 'clincoo/laguna-s': 15,
  'clincoo/reasoning-mini': 15,
  // standar ($0.000025)
  'clincoo/glm-5.2': 25, 'clincoo/gemini-3.8-flash': 25, 'clincoo/gemini-3.6-flash': 25,
  'clincoo/gemini-3.5-flash': 25, 'clincoo/llama-4-scout': 25, 'clincoo/llama-3.3-70b': 25,
  'clincoo/mistral-small-3.1': 25, 'clincoo/multimodal-27b': 25, 'clincoo/sea-lion-27b': 25,
  'clincoo/qwq-32b': 25, 'clincoo/qwen-coder-32b': 25, 'clincoo/omni-nano': 25,
  'clincoo/acak': 20,
  // pro ($0.000050)
  'clincoo/glm-5.3': 50, 'clincoo/glm-5.3-flash': 50, 'clincoo/deepseek-v4-pro': 50,
  'clincoo/gpt-oss-120b': 50, 'clincoo/kimi-k2.6': 50, 'clincoo/kimi-k2.7-code': 50,
  'clincoo/reasoning-120b': 50,
  // ultra ($0.000080)
  'clincoo/reasoning-550b': 80
};
const DEFAULT_PRICE = 25;
// Harga model yang DIMINTA (bukan model internal yang merespons) — prediktabel.
function estimateCost(modelId) { return MODEL_PRICES[modelId] || DEFAULT_PRICE; }

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

// ===== Kunci jaringan mitra gratis (utama + cadangan) — sumber sama dengan
// yang sudah dipakai /api/ai & /api/chat, supaya tidak ada secret baru. =====
async function getExtKeys(env) {
  const keys = [];
  const seen = new Set();
  const add = v => { v = String(v || '').trim(); if (v && !seen.has(v)) { seen.add(v); keys.push(v); } };
  add(env.OPENROUTER_API_KEY);
  add(env.OPENROUTER_API_KEY_4); add(env.OPENROUTER_API_KEY_5); add(env.OPENROUTER_API_KEY_6);
  if (env.DB) {
    try {
      const rows = await env.DB.prepare("SELECT key, value FROM env_vars WHERE key IN ('OPENROUTER_API_KEY','OPENROUTER_API_KEY_2','OPENROUTER_API_KEY_3','OPENROUTER_API_KEY_4','OPENROUTER_API_KEY_5','OPENROUTER_API_KEY_6')").all();
      for (const r of rows.results || []) add(r.value);
    } catch (e) {}
  }
  return keys;
}

// ===== Jalankan model di infrastruktur internal Clincoo (binding AI) =====
async function tryCfModel(env, publicId, internal, messages) {
  if (!env.AI) return { error: `Model ${publicId} sedang tidak tersedia` };
  const sysIdx = messages.findIndex(m => m.role === 'system');
  const system = sysIdx !== -1 ? messages[sysIdx].content : '';
  const chatMsgs = messages.filter(m => m.role !== 'system').map(m => ({ role: m.role, content: m.content }));
  try {
    const payload = { messages: chatMsgs };
    if (system) payload.system = system;
    const result = await env.AI.run(internal, payload);
    const raw = (result && (result.response || (typeof result === 'string' ? result : ''))) || '';
    const text = raw || ((result && Array.isArray(result.choices) && result.choices[0] && result.choices[0].message && result.choices[0].message.content) || '');
    if (!text) return { error: `Model ${publicId}: respons kosong` };
    const tokens = Math.ceil((chatMsgs.map(m => m.content).join(' ').length + text.length) / 4);
    return { text, model: publicId, tokens };
  } catch (e) {
    return { error: `Model ${publicId} sedang tidak tersedia` };
  }
}

// ===== Jalankan model lewat jaringan mitra gratis Clincoo =====
async function tryExtModel(env, publicId, internal, messages) {
  const keys = await getExtKeys(env);
  if (!keys.length) return { error: `Model ${publicId} sedang tidak tersedia` };
  const sys = messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
  const chatMsgs = messages.filter(m => m.role !== 'system').map(m => ({ role: m.role, content: m.content }));
  const payload = { model: internal, messages: sys ? [{ role: 'system', content: sys }, ...chatMsgs] : chatMsgs, max_tokens: 4096 };
  for (const key of keys) {
    try {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key, 'HTTP-Referer': 'https://app.clincoo.buzz', 'X-Title': 'Clincoo Open API' },
        body: JSON.stringify(payload)
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) continue;
      const text = (data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
      if (!text) continue;
      const tokens = (data && data.usage && data.usage.total_tokens) || Math.ceil((chatMsgs.map(m => m.content).join(' ').length + text.length) / 4);
      return { text, model: publicId, tokens };
    } catch (e) { /* coba key berikutnya */ }
  }
  return { error: `Model ${publicId} sedang tidak tersedia` };
}

// ===== Gemini (Google AI Studio) — kunci utama + cadangan, sumber sama dgn /api/ai =====
async function getGeminiKeys(env) {
  const keys = [];
  const seen = new Set();
  const add = v => { v = String(v || '').trim(); if (v && !seen.has(v)) { seen.add(v); keys.push(v); } };
  add(env.GEMINI_API_KEY);
  if (env.DB) {
    try {
      const rows = await env.DB.prepare("SELECT key, value FROM env_vars WHERE key IN ('GEMINI_API_KEY','GEMINI_API_KEY_2','GEMINI_API_KEY_3','GEMINI_API_KEY_4','GEMINI_API_KEY_5','GEMINI_API_KEY_6')").all();
      for (const r of rows.results || []) add(r.value);
    } catch (e) {}
  }
  return keys;
}

async function tryGeminiModel(env, publicId, internal, messages) {
  const keys = await getGeminiKeys(env);
  if (!keys.length) return { error: `Model ${publicId} sedang tidak tersedia` };
  const sys = messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
  const contents = messages.filter(m => m.role !== 'system').map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
  if (!contents.length) return { error: `Model ${publicId} sedang tidak tersedia` };
  for (const key of keys) {
    try {
      const payload = { contents };
      if (sys) payload.systemInstruction = { parts: [{ text: sys }] };
      const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(internal) + ':generateContent?key=' + encodeURIComponent(key), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) continue;
      let text = '';
      for (const c of (data && data.candidates) || []) {
        for (const p of (c && c.content && c.content.parts) || []) if (p && p.text) text += p.text;
      }
      if (!text) continue;
      const tokens = (data && data.usageMetadata && data.usageMetadata.totalTokenCount) || Math.ceil((messages.map(m => m.content).join(' ').length + text.length) / 4);
      return { text, model: publicId, tokens };
    } catch (e) { /* coba kunci berikutnya */ }
  }
  return { error: `Model ${publicId} sedang tidak tersedia` };
}

async function tryModel(env, publicId, messages) {
  const cfg = AI_MODELS[publicId];
  if (!cfg) return { error: `Model ${publicId} tidak dikenal` };
  if (cfg.provider === 'cf') return tryCfModel(env, publicId, cfg.internal, messages);
  if (cfg.provider === 'gemini') return tryGeminiModel(env, publicId, cfg.internal, messages);
  return tryExtModel(env, publicId, cfg.internal, messages);
}

// ===== Log ke D1 (tabel ai_router_logs) =====
async function initLogTable(db) {
  await db.prepare('CREATE TABLE IF NOT EXISTS ai_router_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT, ts TEXT, model TEXT, ok INTEGER, ms INTEGER, tokens INTEGER, err TEXT)').run();
  // kolom baru (aman dipanggil berulang — error duplikat diabaikan)
  try { await db.prepare('ALTER TABLE ai_router_logs ADD COLUMN src TEXT').run(); } catch (e) {}
  try { await db.prepare('ALTER TABLE ai_router_logs ADD COLUMN cost REAL').run(); } catch (e) {}
}
function originOf(request) {
  try {
    const o = request.headers.get('origin');
    if (o) return new URL(o).hostname;
    const r = request.headers.get('referer');
    if (r) return new URL(r).hostname;
  } catch (e) {}
  return 'langsung';
}
async function logCall(db, projectId, model, ok, ms, tokens, cost, src, err) {
  if (!db) return;
  try {
    await initLogTable(db);
    await db.prepare('INSERT INTO ai_router_logs (project_id, ts, model, ok, ms, tokens, cost, src, err) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(projectId, new Date().toISOString(), model, ok ? 1 : 0, ms || 0, tokens || 0, cost || 0, String(src || 'langsung').slice(0, 100), String(err || '').slice(0, 120)).run();
    await db.prepare('DELETE FROM ai_router_logs WHERE project_id = ? AND id NOT IN (SELECT id FROM (SELECT id FROM ai_router_logs WHERE project_id = ? ORDER BY id DESC LIMIT 500))').bind(projectId, projectId).run();
  } catch (e) {}
}

async function initSecretTable(db) {
  await db.prepare('CREATE TABLE IF NOT EXISTS ai_router_secrets (project_id TEXT PRIMARY KEY, secret TEXT NOT NULL, created_at TEXT, last_used TEXT)').run();
}

// ===== Kredit API per pemilik proyek (harga per model, sesuai paket) =====
// Tabel terpisah dari ai_quota (chat app) supaya satuan tidak tercampur:
// satuan di sini = mikro-dolar ($0.000001) per panggilan.
let _creditsTableReady = false;
async function initCreditsTable(db) {
  if (_creditsTableReady) return;
  await db.prepare('CREATE TABLE IF NOT EXISTS ai_api_credits (user_key TEXT, day TEXT, spent INTEGER, PRIMARY KEY (user_key, day))').run();
  _creditsTableReady = true;
}
// Potong kredit pemilik proyek SEBELUM model dipanggil (pre-check + deduct sekali jalan).
// Fail-open: gagal DB tidak memblokir user (kebijakan sama dengan /api/chat).
async function chargeCredits(db, projectId, model) {
  const cost = estimateCost(model);
  try {
    const pRow = await db.prepare('SELECT user_id FROM user_projects WHERE id = ?').bind(projectId).first();
    if (!pRow) return { ok: true, cost }; // proyek tanpa pemilik terdaftar -> jangan blokir
    const uid = Number(pRow.user_id);
    const uRow = await db.prepare('SELECT email FROM auth_users WHERE id = ?').bind(uid).first();
    if (uRow && ADMIN_EMAILS.has(String(uRow.email || '').toLowerCase())) return { ok: true, cost: 0 };
    const userKey = 'u' + uid;
    const eff = await getEffectivePlanByUserKey(db, userKey);
    const limits = PLAN_AI_API_CREDITS[eff.plan] || PLAN_AI_API_CREDITS.Starter;
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    const month = now.toISOString().slice(0, 7);
    await initCreditsTable(db);
    const rows = await db.prepare('SELECT day, spent FROM ai_api_credits WHERE user_key = ? AND day IN (?, ?)').bind(userKey, day, month).all();
    let d = 0, m = 0;
    for (const r of rows.results || []) { if (r.day === day) d = r.spent || 0; if (r.day === month) m = r.spent || 0; }
    if (m + cost > limits.monthly) return { ok: false, scope: 'monthly', used: m, limit: limits.monthly, plan: eff.plan };
    if (d + cost > limits.daily) return { ok: false, scope: 'daily', used: d, limit: limits.daily, plan: eff.plan };
    await db.batch([
      db.prepare('INSERT INTO ai_api_credits (user_key, day, spent) VALUES (?, ?, ?) ON CONFLICT(user_key, day) DO UPDATE SET spent = spent + ?').bind(userKey, day, cost, cost),
      db.prepare('INSERT INTO ai_api_credits (user_key, day, spent) VALUES (?, ?, ?) ON CONFLICT(user_key, day) DO UPDATE SET spent = spent + ?').bind(userKey, month, cost, cost)
    ]);
    return { ok: true, cost };
  } catch (e) { return { ok: true, cost }; }
}
// Kalau SEMUA model gagal merespons, kredit dikembalikan (user tidak bayar percuma).
async function refundCredits(db, projectId, model) {
  const cost = estimateCost(model);
  if (!cost) return;
  try {
    const pRow = await db.prepare('SELECT user_id FROM user_projects WHERE id = ?').bind(projectId).first();
    if (!pRow) return;
    const userKey = 'u' + Number(pRow.user_id);
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    const month = now.toISOString().slice(0, 7);
    await initCreditsTable(db);
    await db.batch([
      db.prepare('INSERT INTO ai_api_credits (user_key, day, spent) VALUES (?, ?, ?) ON CONFLICT(user_key, day) DO UPDATE SET spent = MAX(0, spent - ?)').bind(userKey, day, 0, cost),
      db.prepare('INSERT INTO ai_api_credits (user_key, day, spent) VALUES (?, ?, ?) ON CONFLICT(user_key, day) DO UPDATE SET spent = MAX(0, spent - ?)').bind(userKey, month, 0, cost)
    ]);
  } catch (e) {}
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

  let model = String(body.model || 'clincoo/auto');
  if (model && !ALL_MODELS.includes(model)) {
    return json({ error: { message: 'Model tidak dikenal. Lihat daftar model di /v1/models.', type: 'invalid_request', code: 400 } }, 400);
  }

  // --- Kredit API pemilik proyek (harga per model, sesuai paket langganan) ---
  const credit = await chargeCredits(db, projectId, model);
  if (!credit.ok) {
    const pesan = credit.scope === 'daily'
      ? 'Kredit API Clincoo hari ini sudah habis (paket ' + credit.plan + '). Reset otomatis besok — upgrade paket di menu Profil untuk jatah lebih besar.'
      : 'Kredit API Clincoo bulan ini sudah habis (paket ' + credit.plan + '). Reset otomatis awal bulan depan — upgrade paket di menu Profil untuk jatah lebih besar.';
    return json({ error: { message: pesan, type: 'insufficient_credits', code: 429, plan: credit.plan, scope: credit.scope, used: credit.used, limit: credit.limit } }, 429);
  }

  const src = originOf(request);
  const t0 = Date.now();
  const chain = model === 'clincoo/auto' ? AUTO_CHAIN : [model];
  let result = null;
  for (const step of chain) {
    result = await tryModel(env, step, messages);
    if (result && result.text) break;
  }
  const ms = Date.now() - t0;

  if (!result || !result.text) {
    await refundCredits(db, projectId, model); // gagal total -> kredit dikembalikan
    await logCall(db, projectId, model, 0, ms, 0, 0, src, 'semua model pada rantai gagal merespons');
    // Catatan: pakai 503 (bukan 502) — Cloudflare mengganti body setiap respons
    // berstatus 502/504/52x dengan halaman generik, menutupi pesan JSON ini.
    return json({ error: { message: 'Model sedang penuh/tidak tersedia sementara. Coba model lain atau ulangi beberapa saat lagi.', type: 'server', code: 503 } }, 503);
  }

  const cost = credit.cost; // harga model yang diminta (billing prediktabel)
  await logCall(db, projectId, result.model, 1, ms, result.tokens, cost, src, '');

  const completion = {
    id: 'chatcmpl-' + crypto.randomUUID(),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: model,
    choices: [{ index: 0, message: { role: 'assistant', content: result.text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: result.tokens || 0 },
    clincoo: { served_model: result.model, latency_ms: ms, cost: cost }
  };
  return json(completion);
}
