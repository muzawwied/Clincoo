// Cloudflare Pages Function — /api/e2b-run (PROXY eksekusi kode E2B di server)
// MENGGANTIKAN /api/e2b yang dulu mengembalikan E2B_API_KEY mentah ke browser
// (celah: key bisa dicopas user dan dipakai di luar platform).
// Alur: login wajib (middleware) → baca E2B_API_KEY dari D1 (tidak pernah
// dikirim ke klien) → buat sandbox via REST api.e2b.app → eksekusi lewat
// endpoint NDJSON /execute (X-Access-Token, token sesi sandbox) → hapus sandbox.
// Referensi protokol: e2b REST (create POST /sandboxes, execute di
// https://49999-<sandboxID>.<domain>/execute, delete DELETE /sandboxes/<id>).
//
// Bahasa: python dieksekusi langsung; javascript/java/c/cpp/php/ruby/go/rust
// dibungkus subprocess di dalam sandbox (tetap jalan, tanpa SDK klien).

import { initTables as initAuthTables, getUserByToken, getToken } from './auth/shared.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};
const E2B_API_BASE = 'https://api.e2b.app';
const E2B_TEMPLATE = 'code-interpreter-v1';
const SANDBOX_TIMEOUT_S = 120;   // umur sandbox (mode code, sekali pakai)
const EXEC_TIMEOUT_S = 45;      // batas per eksekusi (subprocess, mode code)
const MAX_CODE_BYTES = 100_000; // 100 KB

// ==== TERMINAL PERSISTEN (mode command) ====
// Sandbox DIPERTAHANKAN antar-command per user (instalasi & file bertahan),
// di-reuse selama sesi masih hidup. Sandbox mati sendiri lewat timeout E2B.
const SESSION_SANDBOX_TIMEOUT_S = 900;       // umur sandbox sesi (15 menit)
const SESSION_IDLE_MS = 10 * 60 * 1000;      // reuse hanya jika < 10 menit terakhir dipakai
const COMMAND_EXEC_TIMEOUT_S = 110;         // per command (biar cukup utk apt-get install)
const COMMAND_REQ_TIMEOUT_MS = 120_000;     // batas total request mode command

const LANG_CMD = {
  javascript: { filename: 'main.js', run: 'node main.js' },
  js: { filename: 'main.js', run: 'node main.js' },
  java: { filename: 'Main.java', run: 'javac Main.java && java Main' },
  c: { filename: 'main.c', run: 'gcc main.c -o main && ./main' },
  cpp: { filename: 'main.cpp', run: 'g++ main.cpp -o main && ./main' },
  php: { filename: 'main.php', run: 'php main.php' },
  ruby: { filename: 'main.rb', run: 'ruby main.rb' },
  go: { filename: 'main.go', run: 'go run main.go' },
  rust: { filename: 'main.rs', run: 'rustc main.rs && ./main.rs' }
};

function json(obj, status) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: { 'Content-Type': 'application/json', ...CORS } });
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

async function resolveUser(env, request) {
  try {
    await initAuthTables(env.DB);
    const token = getToken(request);
    if (!token) return null;
    return await getUserByToken(env.DB, token);
  } catch (e) { return null; }
}

// Rate limit per user (D1, tahan lintas-isolate): 20 eksekusi / 5 menit
async function rateLimitUser(DB, userKey) {
  try {
    const window = Math.floor(Date.now() / (5 * 60 * 1000));
    await DB.prepare('CREATE TABLE IF NOT EXISTS rl_e2b (k TEXT PRIMARY KEY, c INTEGER DEFAULT 0)').run();
    const row = await DB.prepare('SELECT c FROM rl_e2b WHERE k = ?').bind(userKey + '|' + window).first();
    const count = (row?.c || 0) + 1;
    if (!row) await DB.prepare('INSERT INTO rl_e2b (k, c) VALUES (?, 1)').bind(userKey + '|' + window).run();
    else await DB.prepare('UPDATE rl_e2b SET c = ? WHERE k = ?').bind(count, userKey + '|' + window).run();
    if (count > 20) return false;
    if (count === 1) { // bersihkan jendela lama sesekali
      try { await DB.prepare("DELETE FROM rl_e2b WHERE k LIKE ?").bind(userKey + '|' + (window - 1) + '%').run(); } catch (e) {}
    }
  } catch (e) { /* jangan blokir karena DB gangguan */ }
  return true;
}

export async function getE2bKey(DB) {
  try {
    const row = await DB.prepare('SELECT value FROM env_vars WHERE key = ?').bind('E2B_API_KEY').first();
    return row?.value || '';
  } catch (e) { return ''; }
}

// Baca seluruh NDJSON dan gabungkan stdout/stderr/error
function parseExecute(raw) {
  const out = { stdout: '', stderr: '', error: null, results: [] };
  for (const line of String(raw || '').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let m; try { m = JSON.parse(t); } catch (e) { continue; }
    if (m.type === 'stdout') out.stdout += m.text || '';
    else if (m.type === 'stderr') out.stderr += m.text || '';
    else if (m.type === 'error') out.error = { name: m.name || 'Error', value: m.value || '', traceback: m.traceback || '' };
    else if (m.type === 'result') out.results.push({ text: m.text || '', data: m.data ? '<binary>' : undefined });
  }
  return out;
}

function wrapAsSubprocess(code, lang) {
  const info = LANG_CMD[lang] || { filename: 'main.txt', run: 'cat main.txt' };
  // kode user disandikan base64 supaya tidak bisa menyuntik skrip python pembungkus
  const b64 = btoa(unescape(encodeURIComponent(code)));
  return [
    "import base64, subprocess, sys",
    `code = base64.b64decode("${b64}").decode("utf-8")`,
    `open(${JSON.stringify(info.filename)}, "w").write(code)`,
    `p = subprocess.run(${JSON.stringify(info.run)}, shell=True, capture_output=True, text=True, timeout=${EXEC_TIMEOUT_S})`,
    "sys.stdout.write(p.stdout or '')",
    "sys.stderr.write(p.stderr or '')",
    "sys.exit(p.returncode)"
  ].join('\n');
}

function wrapCommand(cmd, execTimeoutS) {
  const b64 = btoa(unescape(encodeURIComponent(cmd)));
  return [
    "import base64, subprocess, sys",
    `cmd = base64.b64decode("${b64}").decode("utf-8")`,
    `p = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=${execTimeoutS || EXEC_TIMEOUT_S})`,
    "sys.stdout.write(p.stdout or '')",
    "sys.stderr.write(p.stderr or '')",
    "sys.exit(p.returncode)"
  ].join('\n');
}

// ==== Sesi terminal persisten per user (D1) ====
async function ensureSessionTable(DB) {
  await DB.prepare(`CREATE TABLE IF NOT EXISTS e2b_sessions (
    user_id TEXT PRIMARY KEY, sandbox_id TEXT NOT NULL, domain TEXT NOT NULL,
    token TEXT NOT NULL, traffic TEXT, updated_at TEXT NOT NULL
  )`).run();
}
async function getSession(DB, userId) {
  try {
    await ensureSessionTable(DB);
    const row = await DB.prepare('SELECT * FROM e2b_sessions WHERE user_id = ?').bind(String(userId)).first();
    if (!row || !row.sandbox_id || !row.token) return null;
    const t = new Date(String(row.updated_at).replace(' ', 'T')).getTime();
    if (isNaN(t) || Date.now() - t > SESSION_IDLE_MS) return null;
    return row;
  } catch (e) { return null; }
}
async function saveSession(DB, userId, sb) {
  try {
    await ensureSessionTable(DB);
    await DB.prepare(`INSERT INTO e2b_sessions (user_id, sandbox_id, domain, token, traffic, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET sandbox_id = excluded.sandbox_id, domain = excluded.domain,
        token = excluded.token, traffic = excluded.traffic, updated_at = excluded.updated_at`)
      .bind(String(userId), sb.sandboxId, sb.domain, sb.accessToken, sb.trafficToken || '', new Date().toISOString()).run();
  } catch (e) {}
}
async function clearSession(DB, userId) {
  try { await DB.prepare('DELETE FROM e2b_sessions WHERE user_id = ?').bind(String(userId)).run(); } catch (e) {}
}

// Eksekusi di sandbox yang sudah ada (token sesi). Return null kalau sandbox sudah mati.
async function runOnSandbox(row, code) {
  const execHeaders = { 'Content-Type': 'application/json', 'X-Access-Token': row.token };
  if (row.traffic) execHeaders['E2B-Traffic-Access-Token'] = row.traffic;
  let execRes;
  try {
    execRes = await fetch(`https://49999-${row.sandbox_id}.${row.domain}/execute`, {
      method: 'POST', headers: execHeaders,
      body: JSON.stringify({ code, context_id: null })
    });
  } catch (e) { return null; }
  if (!execRes.ok) return null;
  try { return parseExecute(await execRes.text()); } catch (e) { return null; }
}

// Buat sandbox baru; return objek sesi atau {error}
export async function createSandbox(apiKey, timeoutS) {
  const createRes = await fetch(E2B_API_BASE + '/sandboxes', {
    method: 'POST',
    headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ templateID: E2B_TEMPLATE, timeout: timeoutS || SANDBOX_TIMEOUT_S, secure: true, allow_internet_access: true })
  });
  if (!createRes.ok) {
    const t = await createRes.text().catch(() => '');
    return { error: 'Gagal membuat sandbox E2B (HTTP ' + createRes.status + '): ' + t.slice(0, 300) };
  }
  const sb = await createRes.json();
  const sandboxId = sb.sandboxID;
  if (!sandboxId || !sb.envdAccessToken) return { error: 'Respons sandbox E2B tidak valid.' };
  return { sandboxId, domain: sb.domain || 'e2b.app', accessToken: sb.envdAccessToken, trafficToken: sb.trafficAccessToken || '' };
}

async function execInSandbox(apiKey, code) {
  // mode code: sandbox sekali pakai, hapus setelah selesai
  const sb = await createSandbox(apiKey, SANDBOX_TIMEOUT_S);
  if (sb.error) return sb;
  try {
    const parsed = await runOnSandbox({ sandbox_id: sb.sandboxId, domain: sb.domain, token: sb.accessToken, traffic: sb.trafficToken }, code);
    if (!parsed) return { error: 'Eksekusi gagal di sandbox E2B.' };
    return parsed;
  } finally {
    try { await fetch(E2B_API_BASE + '/sandboxes/' + sb.sandboxId, { method: 'DELETE', headers: { 'X-API-Key': apiKey } }); } catch (e) {}
  }
}

// mode command: pakai sesi terminal persisten; kalau mati -> buat baru & ulangi sekali
export async function execInSession(env, apiKey, userId, code) {
  let sess = await getSession(env.DB, userId);
  if (sess) {
    const parsed = await runOnSandbox(sess, code);
    if (parsed) {
      try { await env.DB.prepare('UPDATE e2b_sessions SET updated_at = ? WHERE user_id = ?').bind(new Date().toISOString(), String(userId)).run(); } catch (e) {}
      return parsed;
    }
    // sandbox mati -> jatuh ke pembuatan baru
    clearSession(env.DB, userId);
  }
  const sb = await createSandbox(apiKey, SESSION_SANDBOX_TIMEOUT_S);
  if (sb.error) return sb;
  await saveSession(env.DB, userId, sb);
  const parsed = await runOnSandbox({ sandbox_id: sb.sandboxId, domain: sb.domain, token: sb.accessToken, traffic: sb.trafficToken }, code);
  if (!parsed) {
    clearSession(env.DB, userId);
    return { error: 'Eksekusi gagal di sandbox E2B (sesi baru). Coba lagi.' };
  }
  return parsed;
}

export async function onRequestPost({ request, env }) {
  const user = await resolveUser(env, request);
  if (!user) return json({ error: 'Login diperlukan', need_login: true }, 401);
  if (!env.DB) return json({ error: 'Database tidak tersedia' }, 500);

  let body = {};
  try { body = await request.json(); } catch (e) {}
  const mode = String(body.mode || 'code');
  const language = String(body.language || 'python').toLowerCase();
  let code = String(body.code || '');

  // Reset terminal persisten user (buat sesi baru pada command berikutnya)
  if (mode === 'reset_session') {
    const old = await getSession(env.DB, user.id);
    const apiKeyNow = await getE2bKey(env.DB);
    if (old && apiKeyNow) {
      try { await fetch(E2B_API_BASE + '/sandboxes/' + old.sandbox_id, { method: 'DELETE', headers: { 'X-API-Key': apiKeyNow } }); } catch (e) {}
    }
    await clearSession(env.DB, user.id);
    return json({ ok: true, message: 'Sesi terminal di-reset. Command berikutnya jalan di Linux baru.' });
  }

  if (mode === 'command') {
    const cmd = String(body.command || '');
    if (!cmd) return json({ error: 'Parameter command wajib.' }, 400);
    if (cmd.length > MAX_CODE_BYTES) return json({ error: 'Command terlalu panjang.' }, 400);
    code = wrapCommand(cmd, COMMAND_EXEC_TIMEOUT_S);
  } else {
    if (!code) return json({ error: 'Parameter code wajib.' }, 400);
    if (code.length > MAX_CODE_BYTES) return json({ error: 'Kode terlalu panjang (maks 100KB).' }, 400);
    if (language !== 'python') code = wrapAsSubprocess(code, language);
  }

  if (!(await rateLimitUser(env.DB, 'u' + user.id))) {
    return json({ error: 'Terlalu banyak eksekusi. Coba lagi dalam beberapa menit.' }, 429);
  }

  const apiKey = await getE2bKey(env.DB);
  if (!apiKey) return json({ error: 'Eksekusi sandbox belum dikonfigurasi.' }, 503);

  // batas total waktu supaya request tidak menggantung
  const reqTimeoutMs = (mode === 'command') ? COMMAND_REQ_TIMEOUT_MS : 90_000;
  const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('Eksekusi melebihi batas waktu (timeout).')), reqTimeoutMs));
  let result;
  try {
    result = await Promise.race([
      (mode === 'command') ? execInSession(env, apiKey, user.id, code) : execInSandbox(apiKey, code),
      timeout
    ]);
  } catch (e) {
    return json({ error: e && e.message ? e.message : 'Eksekusi gagal.' }, 504);
  }

  const cleanExit = result.error && result.error.name === 'SystemExit' && String(result.error.value || '') === '0';
  if (result.error && !cleanExit && !('stdout' in result)) return json({ error: result.error }, 502);
  return json({
    session: mode === 'command',
    ok: !result.error || cleanExit,
    stdout: String(result.stdout || '').slice(0, 50000),
    stderr: String(result.stderr || '').slice(0, 20000),
    error: (result.error && !cleanExit) ? { name: result.error.name, value: String(result.error.value || '').slice(0, 2000) } : null,
    results: (result.results || []).slice(0, 5).map(r => ({ text: String(r.text || '').slice(0, 5000) }))
  });
}
