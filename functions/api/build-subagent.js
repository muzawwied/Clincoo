// Cloudflare Pages Function — /api/build-subagent
// Subagent khusus BUILD website (HTML/CSS/JS). Backend-only MVP.
// Alur: Planner → Coder (per file) → Reviewer → output file list siap write_file.
//
// POST /api/build-subagent
//   { action: 'start', goal, project_id?, max_files? }
//   { action: 'status', task_id }
// GET  /api/build-subagent?task_id=...

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

export async function onRequestOptions() {
  return new Response(null, { status: 200, headers: CORS });
}

const ADMIN_EMAILS = new Set(['muzawwied@gmail.com']);
const DAILY_LIMIT = 25;
const ADMIN_DAILY_LIMIT = 500;
const QUOTA_MSG = 'Kuota AI Clincoo hari ini sudah habis. Kuota reset otomatis setiap hari — silakan coba lagi besok.';
const MAX_FILES = 8;
const DEFAULT_BUDGET_MS = 55_000;
const MAX_BUDGET_MS = 90_000;

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

const WORKERS_AI_MODELS = ['@cf/zai-org/glm-4.7-flash'];
const GEMINI_MODELS = ['gemini-3.6-flash', 'gemini-3-flash-preview'];
const MODELROUTER_MODELS = ['claude-haiku-5.5'];

const PLANNER_SYSTEM = `Kamu adalah subagent PLANNER build website untuk platform Clincoo.
Tugas: pecah brief user menjadi daftar file website statis (HTML/CSS/JS) yang konkret dan minimal tapi lengkap.
Balas HANYA JSON valid, tanpa markdown/fence:
{"title":"judul singkat proyek","files":[{"path":"index.html","role":"halaman utama","brief":"1-2 kalimat isi yang harus ada"},{"path":"css/style.css","role":"stylesheet","brief":"..."},{"path":"js/app.js","role":"interaksi","brief":"..."}]}
Aturan:
- Maksimal 8 file. Selalu sertakan index.html.
- Path relatif, tanpa leading slash. Boleh folder css/, js/, pages/.
- Fokus website statis siap deploy (HTML/CSS/JS vanilla atau CDN ringan).
- Bahasa Indonesia di title/brief.`;

const CODER_SYSTEM = `Kamu adalah subagent CODER build website Clincoo.
Tulis SATU file lengkap, siap pakai, tanpa penjelasan di luar kode.
Aturan WAJIB:
1) Output HANYA isi file murni (bukan markdown, bukan \`\`\` fence, bukan komentar pembuka "ini kodenya").
2) Desain BAGUS, MODERN, BERWARNA: kontras tinggi, gradien halus, shadow lembut, border-radius 12-16px, spacing lega, tipografi system-ui/Inter, tombol jelas, hindari abu-abu datar/minimalis kosong.
3) HTML: struktur semantic, meta viewport, link CSS/JS relatif benar, aksesibel.
4) CSS: mobile-first, variabel warna, hover states.
5) JS: vanilla, aman, tanpa dependency wajib (CDN ok bila perlu).
6) Jangan mengarang path file lain yang tidak ada di daftar proyek.
7) File harus utuh dan langsung jalan bila dibuka di browser (untuk HTML).`;

const REVIEWER_SYSTEM = `Kamu adalah subagent REVIEWER build website Clincoo.
Diberi daftar file + isi. Periksa konsistensi path, link CSS/JS, sekilas bug, dan kualitas desain.
Balas HANYA JSON valid:
{"ok":true|false,"notes":["catatan singkat"],"fixes":[{"path":"file","issue":"masalah","hint":"cara perbaiki singkat"}]}
Maksimal 5 notes dan 5 fixes. Bahasa Indonesia. Jangan menulis ulang seluruh file.`;

function json(obj, status) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: { 'Content-Type': 'application/json', ...CORS } });
}

function safeJson(s, fb) {
  try { const v = JSON.parse(s); return v ?? fb; } catch (e) { return fb; }
}

function stripFence(text) {
  let s = String(text || '').trim();
  s = s.replace(/^```[a-zA-Z0-9]*\s*/m, '').replace(/```$/m, '').trim();
  return s;
}

function extractJson(text) {
  const s = stripFence(text);
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a !== -1 && b > a) {
    try { return JSON.parse(s.slice(a, b + 1)); } catch (e) {}
  }
  return null;
}

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
  try {
    const row = await env.DB.prepare('SELECT value FROM env_vars WHERE key = ?').bind(name).first();
    return row?.value || null;
  } catch { return null; }
}

async function getGeminiKeys(env) {
  const keys = [];
  const seen = new Set();
  const add = v => { v = String(v || '').trim(); if (v && !seen.has(v)) { seen.add(v); keys.push(v); } };
  add(env.GEMINI_API_KEY); add(env.GEMINI_API_KEY_2); add(env.GEMINI_API_KEY_3);
  add(env.GEMINI_API_KEY_4); add(env.GEMINI_API_KEY_5); add(env.GEMINI_API_KEY_6);
  if (env.DB) {
    try {
      const rows = await env.DB.prepare("SELECT key, value FROM env_vars WHERE key IN ('GEMINI_API_KEY','GEMINI_API_KEY_2','GEMINI_API_KEY_3','GEMINI_API_KEY_4','GEMINI_API_KEY_5','GEMINI_API_KEY_6')").all();
      for (const r of rows.results || []) add(r.value);
    } catch {}
  }
  return keys;
}

async function tryModelRouter(key, messages) {
  if (!key) return { error: 'no key' };
  let lastErr = null;
  for (const model of MODELROUTER_MODELS) {
    try {
      const res = await fetch('https://modelrouter.id/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
        body: JSON.stringify({ model, messages, max_tokens: 8192 }),
        signal: AbortSignal.timeout(25000)
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { lastErr = 'MR ' + model + ' HTTP ' + res.status; continue; }
      const text = data?.choices?.[0]?.message?.content || '';
      if (text) return { text, model };
      lastErr = 'MR kosong';
    } catch (e) { lastErr = String(e && e.message); }
  }
  return { error: lastErr || 'ModelRouter gagal' };
}

async function aiCall(env, messages) {
  const mrKey = await getEnvKey(env, 'MODELROUTER_API_KEY');
  if (mrKey) {
    const mr = await tryModelRouter(mrKey, messages);
    if (mr.text) return mr;
  }
  if (env.AI) {
    for (const model of WORKERS_AI_MODELS) {
      try {
        const result = await env.AI.run(model, { messages });
        const raw = (result && (result.response || (typeof result === 'string' ? result : ''))) || '';
        const text = raw || (result && result.choices?.[0]?.message?.content) || '';
        if (text) return { text, model };
      } catch (e) {}
    }
  }
  const gKeys = await getGeminiKeys(env);
  for (const gKey of gKeys) {
    for (const model of GEMINI_MODELS) {
      try {
        const sys = messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
        const contents = messages.filter(m => m.role !== 'system').map(m => ({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: m.content }]
        }));
        const body = { contents };
        if (sys) body.systemInstruction = { parts: [{ text: sys }] };
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': gKey },
          body: JSON.stringify(body)
        });
        const data = await res.json().catch(() => ({}));
        const text = res.ok ? ((data?.candidates?.[0]?.content?.parts) || []).map(p => p.text || '').join('') : '';
        if (text) return { text, model };
      } catch (e) {}
    }
  }
  return { error: 'Semua provider AI gagal' };
}

async function ensureTable(DB) {
  await DB.prepare(`CREATE TABLE IF NOT EXISTS build_subagent_tasks (
    id TEXT PRIMARY KEY,
    user_key TEXT,
    project_id TEXT,
    goal TEXT,
    status TEXT,
    plan TEXT,
    files TEXT,
    review TEXT,
    error TEXT,
    current_step INTEGER DEFAULT 0,
    created_at TEXT,
    updated_at TEXT
  )`).run();
}

function taskPublic(t) {
  const plan = safeJson(t.plan, null);
  const files = safeJson(t.files, []);
  const review = safeJson(t.review, null);
  return {
    id: t.id,
    project_id: t.project_id,
    goal: t.goal,
    status: t.status,
    plan,
    files: files.map(f => ({
      path: f.path,
      role: f.role,
      brief: f.brief,
      size: (f.content && f.content.length) || 0,
      content: f.content || null
    })),
    review,
    error: t.error,
    current_step: t.current_step,
    created_at: t.created_at,
    updated_at: t.updated_at
  };
}

async function saveTask(DB, t) {
  await DB.prepare(
    'UPDATE build_subagent_tasks SET status=?, plan=?, files=?, review=?, error=?, current_step=?, updated_at=? WHERE id=?'
  ).bind(t.status, t.plan, t.files, t.review, t.error, t.current_step, new Date().toISOString(), t.id).run();
}

async function loadTask(DB, id) {
  return (await DB.prepare('SELECT * FROM build_subagent_tasks WHERE id = ?').bind(id).first()) || null;
}

async function runBuild(env, t, budgetMs) {
  const deadline = Date.now() + budgetMs;
  let plan = safeJson(t.plan, null);
  let files = safeJson(t.files, []);

  // Phase 1: plan
  if (!plan || !Array.isArray(plan.files) || !plan.files.length) {
    if (Date.now() > deadline) {
      t.status = 'paused'; t.error = 'Budget waktu habis saat planning';
      await saveTask(env.DB, t); return t;
    }
    const r = await aiCall(env, [
      { role: 'system', content: PLANNER_SYSTEM },
      { role: 'user', content: 'BRIEF USER:\n' + t.goal }
    ]);
    if (r.error) {
      t.status = 'paused'; t.error = 'Planner gagal: ' + r.error;
      await saveTask(env.DB, t); return t;
    }
    const obj = extractJson(r.text);
    if (!obj || !Array.isArray(obj.files) || !obj.files.length) {
      t.status = 'paused'; t.error = 'Planner tidak menghasilkan daftar file valid';
      await saveTask(env.DB, t); return t;
    }
    plan = {
      title: String(obj.title || 'Website').slice(0, 120),
      files: obj.files.slice(0, MAX_FILES).map(f => ({
        path: String(f.path || '').replace(/^\/+/, '').slice(0, 120),
        role: String(f.role || '').slice(0, 80),
        brief: String(f.brief || '').slice(0, 300)
      })).filter(f => f.path)
    };
    if (!plan.files.length) {
      t.status = 'paused'; t.error = 'Planner: path file kosong';
      await saveTask(env.DB, t); return t;
    }
    t.plan = JSON.stringify(plan);
    t.files = JSON.stringify(plan.files.map(f => ({ ...f, content: '' })));
    t.current_step = 0;
    t.status = 'running';
    t.error = null;
    await saveTask(env.DB, t);
    files = plan.files.map(f => ({ ...f, content: '' }));
  }

  // Phase 2: code each file
  const fileList = plan.files.map(f => f.path).join(', ');
  while (t.current_step < files.length) {
    if (Date.now() > deadline) {
      t.status = 'paused';
      t.error = 'Budget waktu habis — lanjutkan dengan action resume dari file ke-' + (t.current_step + 1);
      await saveTask(env.DB, t); return t;
    }
    const f = files[t.current_step];
    const r = await aiCall(env, [
      { role: 'system', content: CODER_SYSTEM },
      {
        role: 'user',
        content:
          'PROYEK: ' + (plan.title || '') + '\n' +
          'BRIEF UTAMA: ' + t.goal + '\n' +
          'DAFTAR FILE PROYEK: ' + fileList + '\n\n' +
          'TULIS FILE INI SAJA:\npath: ' + f.path + '\nrole: ' + (f.role || '') + '\nbrief: ' + (f.brief || '') + '\n\n' +
          'Output HANYA isi file murni.'
      }
    ]);
    if (r.error) {
      t.status = 'paused'; t.error = 'Coder gagal di ' + f.path + ': ' + r.error;
      t.files = JSON.stringify(files);
      await saveTask(env.DB, t); return t;
    }
    let content = stripFence(r.text);
    if (content.length > 120000) content = content.slice(0, 120000);
    files[t.current_step] = { ...f, content };
    t.current_step++;
    t.files = JSON.stringify(files);
    t.status = 'running';
    t.error = null;
    await saveTask(env.DB, t);
  }

  // Phase 3: review
  if (Date.now() < deadline) {
    const summary = files.map(f => '### ' + f.path + '\n' + String(f.content || '').slice(0, 2500)).join('\n\n');
    const rr = await aiCall(env, [
      { role: 'system', content: REVIEWER_SYSTEM },
      { role: 'user', content: 'PROYEK: ' + (plan.title || '') + '\nBRIEF: ' + t.goal + '\n\n' + summary }
    ]);
    if (!rr.error) {
      const rev = extractJson(rr.text) || { ok: true, notes: [String(rr.text || '').slice(0, 500)], fixes: [] };
      t.review = JSON.stringify(rev);
    }
  }

  t.status = 'done';
  t.error = null;
  await saveTask(env.DB, t);
  return t;
}

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
    return json({ ok: true, task: taskPublic(t) });
  } catch (e) {
    return json({ error: 'Server error: ' + (e && e.message) }, 500);
  }
}

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
      return json({ ok: true, task: taskPublic(t) });
    }

    if (action === 'resume') {
      const t = await loadTask(env.DB, body.task_id || '');
      if (!t || t.user_key !== user.key) return json({ error: 'Task tidak ditemukan' }, 404);
      if (t.status === 'done') return json({ ok: true, task: taskPublic(t), message: 'Task sudah selesai.' });
      const q = await quotaSpend(env, user, 1);
      if (q.exceeded) return json({ quota_exhausted: true, error: QUOTA_MSG }, 429);
      const budget = Math.min(parseInt(body.budget_seconds || '', 10) * 1000 || DEFAULT_BUDGET_MS, MAX_BUDGET_MS);
      const done = await runBuild(env, t, budget);
      return json({ ok: true, task: taskPublic(done) });
    }

    const goal = String(body?.goal || '').trim();
    if (goal.length < 3) return json({ error: 'goal minimal 3 karakter' }, 400);
    if (goal.length > 8000) return json({ error: 'goal terlalu panjang (maks 8000 karakter)' }, 400);

    const q = await quotaSpend(env, user, 1);
    if (q.exceeded) return json({ quota_exhausted: true, error: QUOTA_MSG }, 429);

    const id = 'bsa_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
    const now = new Date().toISOString();
    await env.DB.prepare(
      'INSERT INTO build_subagent_tasks (id, user_key, project_id, goal, status, plan, files, review, error, current_step, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)'
    ).bind(id, user.key, body?.project_id || null, goal, 'running', null, '[]', null, null, 0, now, now).run();

    const t = await loadTask(env.DB, id);
    const budget = Math.min(parseInt(body.budget_seconds || '', 10) * 1000 || DEFAULT_BUDGET_MS, MAX_BUDGET_MS);
    const done = await runBuild(env, t, budget);
    return json({ ok: true, task: taskPublic(done) });
  } catch (e) {
    return json({ error: 'Server error: ' + (e && e.message) }, 500);
  }
}
