// Cloudflare Pages Function — /api/agent "Agent Mode Clincoo" (SELF-CONTAINED)
// Agent AI mandiri: satu tujuan besar dieksekusi jadi langkah-langkah kecil
// SECARA OTOMATIS tanpa konfirmasi per langkah — seperti agen di platform builder:
//   1. AI menyusun rencana terstruktur (JSON langkah-langkah)
//   2. Loop server-side menjalankan langkah satu per satu dengan auto-retry
//      dan failover provider (ModelRouter nemotron-3-ultra -> DeepSeek free -> GLM-5.2 -> DeepSeek V4 -> GLM-4.7 Flash -> Gemini)
//   3. State tersimpan di D1 SETIAP langkah — kena limit/error pun, task di-RESUME
//      otomatis dari posisi terakhir, bukan mulai dari nol
// Endpoint (murni backend — frontend belum perlu berubah):
//   POST /api/agent { action: 'start', goal, project_id?, budget_seconds? }
//   POST /api/agent { action: 'resume', task_id }   // lanjut dari langkah terakhir
//   POST /api/agent { action: 'status', task_id }   // atau pakai GET ?task_id=
// Catatan kapabilitas: agent v1 bekerja pada level pengetahuan/teks/kode (analisis,
// rencana kerja, menulis kode & konten) — aksi berdampak nyata ke workspace/deploy
// tetap lewat /api/chat yang punya akses tools klien.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

export async function onRequestOptions() {
  return new Response(null, { status: 200, headers: CORS });
}

// --- Rate limiter per-IP ---
const RATE_LIMIT = { max: 10, windowMs: 60_000 };
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

const ADMIN_EMAILS = new Set(['muzawwied@gmail.com', 'muzawwied@gmail.com']);
const DAILY_LIMIT = 25;
const ADMIN_DAILY_LIMIT = 500;
const QUOTA_MSG = 'Kuota AI Clincoo hari ini sudah habis. Kuota reset otomatis setiap hari — silakan coba lagi besok.';

const MAX_PLAN_STEPS = 12;
const MAX_TRANSCRIPT = 40;
const DEFAULT_BUDGET_MS = 50_000;
const MAX_BUDGET_MS = 90_000;

// ===== Provider chain (sama filosofi /api/ai, model 2026 non-Llama) =====
const WORKERS_AI_MODELS = ['@cf/zai-org/glm-5.2', '@cf/deepseek-ai/deepseek-v4-flash-0731', '@cf/zai-org/glm-4.7-flash'];
const GEMINI_MODELS = ['gemini-3.6-flash', 'gemini-3-flash-preview'];

// ===== Provider 0: ModelRouter (modelrouter.id) — orkestrator utama =====
// nemotron-3-ultra (diuji OK 2026-10-07) + deepseek-v4.1-flash:free sebagai cadangan gratis.
// Urutan default: nemotron (reasoning, untuk planning) -> deepseek free.
// Urutan FAST: deepseek free duluan (tanpa reasoning ~2x lebih cepat) -> nemotron cadangan.
const MODELROUTER_MODELS = ['claude-haiku-5.5']; // fokus HANYA haiku 5.5
const MODELROUTER_FAST = ['claude-haiku-5.5']; // fokus HANYA haiku 5.5
async function tryModelRouter(key, messages, models) {
  if (!key) return { error: 'Kunci ModelRouter tidak tersedia' };
  const list = Array.isArray(models) && models.length ? models : MODELROUTER_MODELS;
  let lastErr = null;
  for (const model of list) {
    try {
      const res = await fetch('https://modelrouter.id/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
        body: JSON.stringify({ model, messages, max_tokens: 16384 }),
        signal: AbortSignal.timeout(25000)
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { lastErr = 'ModelRouter ' + model + ': HTTP ' + res.status; continue; }
      const text = data?.choices?.[0]?.message?.content || '';
      if (text) return { text, model };
      lastErr = 'ModelRouter ' + model + ': respons kosong';
    } catch (e) { lastErr = 'ModelRouter ' + model + ': ' + (e && e.message); }
  }
  return { error: lastErr || 'ModelRouter gagal' };
}

const PLANNER_SYSTEM = `Kamu adalah perencana tugas agent untuk platform Clincoo (pembuatan website dengan AI, template, editor kode, deploy Cloudflare Pages, domain kustom, paket Starter/Pro/Bisnis).
Tugasmu: pecah TUJUAN user menjadi langkah-langkah eksekusi yang terurut dan konkret.
Balas HANYA JSON valid tanpa teks lain, format:
{"steps":[{"title":"judul langkah singkat (bahasa Indonesia)","detail":"1-2 kalimat penjelasan apa yang dikerjakan di langkah ini"}]}
Aturan: maksimal 12 langkah, tiap langkah bisa diselesaikan lewat penalaran/penulisan (bukan aksi sistem eksternal), bahasa Indonesia yang jelas.`;

const AGENT_SYSTEM = `Kamu adalah "Clincoo AI Agent" — agen pelaksana mandiri di platform Clincoo (pembuatan website dengan AI: template, editor kode, deploy Cloudflare Pages, domain kustom CNAME @, SSL otomatis, paket Starter gratis/Pro Rp49.000/Bisnis Rp129.000).
Kamu sedang menjalankan SATU langkah dari rencana yang sudah disusun. Kerjakan langkah itu sampai tuntas, konkret, dan langsung pakai — kode diberikan dalam blok kode siap salin, konten diberikan final, keputusan diambil tanpa bertanya balik.
Jangan menawarkan "sebaiknya hubungi" — kamu sendiri yang mengeksekusi. Bahasa Indonesia yang hangat, profesional, dan SANGAT DETAIL. Jawaban harus PANJANG, LENGKAP, dan MENDALAM — jangan pernah menjawab terlalu singkat atau sederhana. Beri penjelasan menyeluruh dengan konteks, langkah, contoh, dan tips.
ATURAN ANTI-MENTOK: jika langkah melibatkan update/ubah file web, langsung hasilkan kode/file final; jangan berputar di analisis/reading saja. Setelah gangguan koneksi, lanjut dari state terakhir tanpa mengulang reading yang sudah ada.`;

// ===== D1 =====
async function ensureTable(DB) {
  try { await DB.prepare('ALTER TABLE agent_tasks ADD COLUMN wa_number TEXT').run(); } catch (e) { /* kolom sudah ada */ }
  await DB.prepare(`CREATE TABLE IF NOT EXISTS agent_tasks (
    id TEXT PRIMARY KEY,
    user_key TEXT,
    project_id TEXT,
    goal TEXT,
    status TEXT,
    plan TEXT,
    transcript TEXT,
    current_step INTEGER DEFAULT 0,
    result TEXT,
    error TEXT,
    created_at TEXT,
    updated_at TEXT
  )`).run();
  await DB.prepare('CREATE TABLE IF NOT EXISTS agent_events (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT, user_key TEXT, kind TEXT, text TEXT, created_at TEXT)').run();
}
async function addEvent(DB, task_id, user_key, kind, text) {
  try { await DB.prepare('INSERT INTO agent_events (task_id, user_key, kind, text, created_at) VALUES (?,?,?,?,?)')
    .bind(task_id, user_key, kind, String(text || '').slice(0, 500), new Date().toISOString()).run(); } catch (e) {}
}
async function loadTask(DB, id) {
  const row = await DB.prepare('SELECT * FROM agent_tasks WHERE id = ?').bind(id).first();
  return row || null;
}
async function saveTask(DB, t) {
  await DB.prepare('UPDATE agent_tasks SET status=?, plan=?, transcript=?, current_step=?, result=?, error=?, updated_at=? WHERE id=?')
    .bind(t.status, t.plan, t.transcript, t.current_step, t.result, t.error, new Date().toISOString(), t.id).run();
}
function taskJson(t) {
  return {
    id: t.id, project_id: t.project_id, goal: t.goal, status: t.status,
    plan: safeJson(t.plan, []), transcript_len: safeJson(t.transcript, []).length,
    current_step: t.current_step, result: t.result, error: t.error,
    created_at: t.created_at, updated_at: t.updated_at
  };
}
function safeJson(s, fb) { try { const v = JSON.parse(s); return v ?? fb; } catch (e) { return fb; } }

// ===== Auth & kuota (pola /api/chat — tabel ai_quota bersama) =====
async function resolveUser(env, request) {
  try {
    const { initTables, getUserByToken, getToken } = await import('./auth/shared.js');
    await initTables(env.DB);
    const token = getToken(request);
    if (!token) return null;
    const u = await getUserByToken(env.DB, token);
    if (u) return { key: 'u' + u.id, email: String(u.email || '').toLowerCase() };
  } catch (e) {}
  return null;
}
async function quotaSpend(env, user, cost) {
  const day = new Date().toISOString().slice(0, 10);
  const limit = ADMIN_EMAILS.has(user.email) ? ADMIN_DAILY_LIMIT : DAILY_LIMIT;
  try {
    await env.DB.prepare('CREATE TABLE IF NOT EXISTS ai_quota (user_key TEXT, day TEXT, count INTEGER, PRIMARY KEY (user_key, day))').run();
    const row = await env.DB.prepare('SELECT count FROM ai_quota WHERE user_key = ? AND day = ?').bind(user.key, day).first();
    if (((row ? row.count : 0) + cost) > limit) return { exceeded: true };
    await env.DB.prepare('INSERT INTO ai_quota (user_key, day, count) VALUES (?, ?, ?) ON CONFLICT(user_key, day) DO UPDATE SET count = count + ?').bind(user.key, day, cost, cost).run();
    return { exceeded: false };
  } catch (e) { return { exceeded: false }; }
}
async function getEnvKey(env, name) {
  if (env[name]) return env[name];
  if (!env.DB) return null;
  try { const row = await env.DB.prepare('SELECT value FROM env_vars WHERE key = ?').bind(name).first(); return row?.value || null; } catch { return null; }
}

// Gemini multi-kunci: utama (GEMINI_API_KEY) + cadangan (_2, _3, _4) — sama dengan chat.js.
async function getGeminiKeys(env) {
  const keys = []; const seen = new Set();
  const add = v => { v = String(v || '').trim(); if (v && !seen.has(v)) { seen.add(v); keys.push(v); } };
  add(env.GEMINI_API_KEY); add(env.GEMINI_API_KEY_2); add(env.GEMINI_API_KEY_3); add(env.GEMINI_API_KEY_4); add(env.GEMINI_API_KEY_5); add(env.GEMINI_API_KEY_6);
  if (env.DB) {
    try {
      const rows = await env.DB.prepare("SELECT key, value FROM env_vars WHERE key IN ('GEMINI_API_KEY','GEMINI_API_KEY_2','GEMINI_API_KEY_3','GEMINI_API_KEY_4','GEMINI_API_KEY_5','GEMINI_API_KEY_6')").all();
      for (const r of rows.results || []) add(r.value);
    } catch {}
  }
  return keys;
}

// ===== AI call: rantai provider + auto-retry per provider =====
async function aiCall(env, messages, gemKey, opts) {
  // 0) ModelRouter — default nemotron (reasoning) / fast: deepseek free duluan
  const mrKey = await getEnvKey(env, 'MODELROUTER_API_KEY');
  if (mrKey) {
    const mr = await tryModelRouter(mrKey, messages, opts && opts.fast ? MODELROUTER_FAST : MODELROUTER_MODELS);
    if (mr.text) return mr;
  }
  // 1) Workers AI — retry 2x per model (transient rate-limit edge)
  if (env.AI) {
    for (const model of WORKERS_AI_MODELS) {
      for (let tryN = 1; tryN <= 2; tryN++) {
        try {
          const result = await env.AI.run(model, { messages });
          const raw = (result && (result.response || (typeof result === 'string' ? result : ''))) || '';
          const text = raw || (result && result.choices?.[0]?.message?.content) || '';
          if (text) return { text, model };
        } catch (e) { /* coba ulang / model berikutnya */ }
      }
    }
  }
  // 2) Gemini (multi-kunci: utama + cadangan)
  const gKeys = Array.isArray(gemKey) ? gemKey.filter(Boolean) : (gemKey ? [gemKey] : []);
  for (const gKey of gKeys) {
   for (const model of GEMINI_MODELS) {
      try {
        const sys = messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
        const contents = messages.filter(m => m.role !== 'system').map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
        const body = { contents }; if (sys) body.systemInstruction = { parts: [{ text: sys }] };
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': gKey }, body: JSON.stringify(body)
        });
        const data = await res.json().catch(() => ({}));
        const text = res.ok ? ((data?.candidates?.[0]?.content?.parts) || []).map(p => p.text || '').join('') : '';
        if (text) return { text, model };
      } catch (e) {}
    }
  }
  return { error: 'Semua provider AI gagal' };
}

// ===== Parse rencana JSON dari output model (tahan fence/komentar) =====
function parsePlan(text) {
  try {
    let s = String(text).replace(/```json/gi, '```').replace(/```/g, '').trim();
    const a = s.indexOf('{'); const b = s.lastIndexOf('}');
    if (a !== -1 && b > a) s = s.slice(a, b + 1);
    const obj = JSON.parse(s);
    const steps = Array.isArray(obj.steps) ? obj.steps : (Array.isArray(obj) ? obj : []);
    const clean = steps.filter(x => x && x.title).slice(0, MAX_PLAN_STEPS)
      .map(x => ({ title: String(x.title), detail: String(x.detail || ''), done: false }));
    if (clean.length) return clean;
  } catch (e) {}
  return null;
}

// ===== Loop agent — jalan sampai selesai ATAU budget habis (resume-able) =====
async function agentTick(env, t, budgetMs, gemKey) {
  const deadline = Date.now() + budgetMs;
  let plan = safeJson(t.plan, []);
  let transcript = safeJson(t.transcript, []);

  // Tahap 1: susun rencana
  if (!plan.length) {
    const r = await aiCall(env, [
      { role: 'system', content: PLANNER_SYSTEM },
      { role: 'user', content: 'TUJUAN: ' + t.goal }
    ], gemKey);
    if (r.error) { t.status = 'paused'; t.error = 'Gagal menyusun rencana: ' + r.error; await saveTask(env.DB, t); return t; }
    plan = parsePlan(r.text) || [{ title: 'Kerjakan tujuan langsung', detail: t.goal, done: false }];
    t.plan = JSON.stringify(plan);
    t.status = 'running'; t.error = null;
    await saveTask(env.DB, t);
    addEvent(env.DB, t.id, t.user_key, 'start', 'Tugas dimulai — ' + plan.length + ' langkah direncanakan.');
  }

  // Tahap 2: eksekusi langkah satu per satu — TANPA konfirmasi
  while (t.current_step < plan.length) {
    if (Date.now() > deadline) {
      t.status = 'paused'; t.error = 'Budget waktu tercapai — task siap di-resume otomatis dari langkah ' + (t.current_step + 1) + '.';
      await saveTask(env.DB, t); addEvent(env.DB, t.id, t.user_key, 'paused', t.error); return t;
    }
    const step = plan[t.current_step];
    const msgs = [
      { role: 'system', content: AGENT_SYSTEM },
      { role: 'user', content: 'TUJUAN: ' + t.goal + '\n\nRENCANA:\n' + plan.map((p, i) => (i + 1) + '. ' + p.title + (p.done ? ' (selesai)' : '')).join('\n') + '\n\nLANGKAH SEKARANG (' + (t.current_step + 1) + '/' + plan.length + '): ' + step.title + (step.detail ? '\n' + step.detail : '') + (transcript.length ? '\n\nKERJA SEBELUMNYA (ringkas):\n' + transcript.slice(-6).map(m => (m.role === 'user' ? '[user] ' : '[agent] ') + String(m.content).slice(0, 400)).join('\n') : '') }
    ];
    const r = await aiCall(env, msgs, gemKey, { fast: true });
    if (r.error) {
      // provider mati total -> pause (resume nanti), JANGAN gagalkan progres
      t.status = 'paused'; t.error = 'Provider AI tidak tersedia: ' + r.error;
      await saveTask(env.DB, t); addEvent(env.DB, t.id, t.user_key, 'paused', t.error); return t;
    }
    transcript.push({ role: 'user', content: step.title + (step.detail ? ' — ' + step.detail : '') });
    transcript.push({ role: 'assistant', content: r.text });
    if (transcript.length > MAX_TRANSCRIPT) transcript = transcript.slice(-MAX_TRANSCRIPT);
    plan[t.current_step].done = true;
    t.current_step++;
    t.plan = JSON.stringify(plan);
    t.transcript = JSON.stringify(transcript);
    t.status = 'running'; t.error = null;
    await saveTask(env.DB, t); // persist TIAP langkah — kena limit pun aman
    addEvent(env.DB, t.id, t.user_key, 'progress', 'Langkah ' + t.current_step + '/' + plan.length + ' selesai: ' + step.title);
  }

  // Tahap 3: rangkum hasil akhir
  const doneMsgs = [
    { role: 'system', content: AGENT_SYSTEM },
    { role: 'user', content: 'TUJUAN: ' + t.goal + '\n\nHASIL KERJA PER LANGKAH:\n' + transcript.map(m => (m.role === 'assistant' ? '[agent] ' : '[user] ') + String(m.content).slice(0, 600)).join('\n') + '\n\nRangkum hasil akhir untuk user: apa yang sudah selesai, hasil penting per langkah, dan saran tindak lanjut. Detail, lengkap, dan konkret — multi-paragraf jika perlu, bahasa Indonesia.' }
  ];
  const rf = await aiCall(env, doneMsgs, gemKey, { fast: true });
  t.result = rf.text || rf.error || '(rangkuman dilewati)';
  t.status = 'done'; t.error = null;
  await saveTask(env.DB, t);
  addEvent(env.DB, t.id, t.user_key, 'done', 'Tugas selesai. ' + String(t.result || '').slice(0, 300));
  return t;
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: { 'Content-Type': 'application/json', ...CORS } });
}

// ===== GET /api/agent?task_id=... — status task =====
export async function onRequestGet({ request, env }) {
  if (!rateLimitOk(clientIp(request))) return json({ error: 'Terlalu banyak permintaan.' }, 429);
  const user = await resolveUser(env, request);
  if (!user) return json({ error: 'Login diperlukan', need_login: true }, 401);
  const id = new URL(request.url).searchParams.get('task_id') || '';
  if (!id) return json({ error: 'task_id wajib' }, 400);
  try {
    await ensureTable(env.DB);
    const t = await loadTask(env.DB, id);
    if (!t || t.user_key !== user.key) return json({ error: 'Task tidak ditemukan' }, 404);
    const ev = await env.DB.prepare('SELECT kind, text, created_at FROM agent_events WHERE task_id = ? AND user_key = ? ORDER BY id ASC LIMIT 100').bind(id, user.key).all();
    return json({ ok: true, task: taskJson(t), events: ev.results || [] });
  } catch (e) { return json({ error: 'Server error: ' + e.message }, 500); }
}

// ===== POST /api/agent — start / resume / status =====
export async function onRequestPost({ request, env }) {
  if (!rateLimitOk(clientIp(request))) return json({ error: 'Terlalu banyak permintaan.' }, 429);
  const user = await resolveUser(env, request);
  if (!user) return json({ error: 'Login diperlukan', need_login: true }, 401);

  let body = null;
  try { body = await request.json(); } catch (e) { return json({ error: 'Body JSON tidak valid' }, 400); }
  const action = body?.action || 'start';

  try {
    await ensureTable(env.DB);

    if (action === 'status') {
      const t = await loadTask(env.DB, body.task_id || '');
      if (!t || t.user_key !== user.key) return json({ error: 'Task tidak ditemukan' }, 404);
      return json({ ok: true, task: taskJson(t) });
    }

    if (action === 'resume') {
      const t = await loadTask(env.DB, body.task_id || '');
      if (!t || t.user_key !== user.key) return json({ error: 'Task tidak ditemukan' }, 404);
      if (t.status === 'done') return json({ ok: true, task: taskJson(t), message: 'Task sudah selesai.' });
      const q = await quotaSpend(env, user, 1);
      if (q.exceeded) return json({ quota_exhausted: true, error: QUOTA_MSG }, 429);
      const gemKey = await getGeminiKeys(env);
      const budget = Math.min(parseInt(body.budget_seconds || '', 10) * 1000 || DEFAULT_BUDGET_MS, MAX_BUDGET_MS);
      const done = await agentTick(env, t, budget, gemKey);
      return json({ ok: true, task: taskJson(done) });
    }

    // action === 'start_bg' — tugas masuk antrean, dijalankan Clincoo Agent Worker
    // (Cloudflare Workflows) di latar belakang. Request balik LANGSUNG; progres
    // dipantau lewat GET /api/agent?task_id=... (events) atau dikirim ke WhatsApp
    // bila wa_number diisi.
    if (action === 'start_bg') {
      const goal = String(body?.goal || '').trim();
      if (goal.length < 3) return json({ error: 'Tulis tujuan tugas (minimal 3 karakter).' }, 400);
      const q = await quotaSpend(env, user, 1);
      if (q.exceeded) return json({ quota_exhausted: true, error: QUOTA_MSG }, 429);
      const now = new Date().toISOString();
      const t = {
        id: 'agt_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
        user_key: user.key,
        project_id: String(body?.project_id || '') || null,
        goal, status: 'queued',
        plan: '[]', transcript: '[]',
        current_step: 0, result: null, error: null,
        wa_number: String(body?.wa_number || '').replace(/[^0-9+]/g, '') || null,
        created_at: now, updated_at: now
      };
      await env.DB.prepare('INSERT INTO agent_tasks (id, user_key, project_id, goal, status, plan, transcript, current_step, result, error, wa_number, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .bind(t.id, t.user_key, t.project_id, t.goal, t.status, t.plan, t.transcript, t.current_step, t.result, t.error, t.wa_number, t.created_at, t.updated_at).run();
      addEvent(env.DB, t.id, t.user_key, 'queued', 'Tugas masuk antrean — Clincoo Agent Worker menjalankannya di latar belakang.');
      return json({ ok: true, task: taskJson(t), background: true, message: 'Tugas masuk antrean. Pantau progres via GET /api/agent?task_id=' + t.id });
    }

    // action === 'start'
    const goal = String(body?.goal || '').trim();
    if (goal.length < 3) return json({ error: 'Tulis tujuan tugas (minimal 3 karakter).' }, 400);
    const q = await quotaSpend(env, user, 1);
    if (q.exceeded) return json({ quota_exhausted: true, error: QUOTA_MSG }, 429);

    const now = new Date().toISOString();
    const t = {
      id: 'agt_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
      user_key: user.key,
      project_id: String(body?.project_id || '') || null,
      goal, status: 'running',
      plan: '[]', transcript: '[]',
      current_step: 0, result: null, error: null,
      created_at: now, updated_at: now
    };
    await env.DB.prepare('INSERT INTO agent_tasks (id, user_key, project_id, goal, status, plan, transcript, current_step, result, error, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
      .bind(t.id, t.user_key, t.project_id, t.goal, t.status, t.plan, t.transcript, t.current_step, t.result, t.error, t.created_at, t.updated_at).run();
    addEvent(env.DB, t.id, t.user_key, 'start', 'Tugas dimulai.');
    const gemKey = await getGeminiKeys(env);
    const budget = Math.min(parseInt(body.budget_seconds || '', 10) * 1000 || DEFAULT_BUDGET_MS, MAX_BUDGET_MS);
    const done = await agentTick(env, t, budget, gemKey);
    return json({ ok: true, task: taskJson(done) });
  } catch (e) {
    return json({ error: 'Server error: ' + (e && e.message) }, 500);
  }
}
