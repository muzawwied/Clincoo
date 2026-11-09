// Cloudflare Pages Functions — KONEKTOR AI: Jina (baca web) + E2B (sandbox kode)
// Dipakai Clincoo AI supaya bisa membaca halaman web dan menjalankan kode di sandbox.
//   jinaRead(url)      -> markdown halaman (r.jina.ai)
//   jinaSearch(q)      -> hasil pencarian web (s.jina.ai) berupa markdown
//   e2bRunCode(code)   -> { ok, stdout, stderr, exit, ms }
// Kunci diambil dari env (Pages) atau tabel env_vars D1 (JINA_API_KEY, E2B_API_KEY).

const JINA_READ = 'https://r.jina.ai/';
const JINA_SEARCH = 'https://s.jina.ai/';
const E2B_API = 'https://api.e2b.dev';
const E2B_ENVD = 'https://sandbox.e2b.app';

export async function envKey(env, name) {
  if (env[name]) return env[name];
  if (!env.DB) return null;
  try {
    const row = await env.DB.prepare('SELECT value FROM env_vars WHERE key = ? ORDER BY id DESC LIMIT 1').bind(name).first();
    return (row && row.value) || null;
  } catch { return null; }
}

function clamp(text, max) {
  const s = String(text || '');
  return s.length > max ? s.slice(0, max) + '\n\n[...dipotong]' : s;
}

// ---------- JINA ----------
export async function jinaRead(env, url, opts = {}) {
  const key = await envKey(env, 'JINA_API_KEY');
  if (!key) return { ok: false, error: 'JINA_API_KEY belum diset.' };
  let target = String(url || '').trim();
  if (!/^https?:\/\//i.test(target)) target = 'https://' + target;
  try {
    const r = await fetch(JINA_READ + target, {
      headers: {
        Authorization: 'Bearer ' + key,
        'X-Return-Format': 'markdown',
        'X-Timeout': '20'
      },
      signal: AbortSignal.timeout(opts.timeout || 25000)
    });
    const text = await r.text();
    if (!r.ok) return { ok: false, error: `Jina Reader HTTP ${r.status}`, detail: clamp(text, 300) };
    return { ok: true, url: target, content: clamp(text, opts.max || 9000) };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

export async function jinaSearch(env, query, opts = {}) {
  const key = await envKey(env, 'JINA_API_KEY');
  if (!key) return { ok: false, error: 'JINA_API_KEY belum diset.' };
  try {
    const r = await fetch(JINA_SEARCH + encodeURIComponent(String(query || '').trim()), {
      headers: { Authorization: 'Bearer ' + key, 'X-Return-Format': 'markdown' },
      signal: AbortSignal.timeout(opts.timeout || 25000)
    });
    const text = await r.text();
    if (!r.ok) return { ok: false, error: `Jina Search HTTP ${r.status}`, detail: clamp(text, 300) };
    return { ok: true, query, content: clamp(text, opts.max || 8000) };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

// ---------- E2B ----------
function connectFrame(obj) {
  const payload = new TextEncoder().encode(JSON.stringify(obj));
  const out = new Uint8Array(5 + payload.length);
  out[0] = 0;
  new DataView(out.buffer).setUint32(1, payload.length);
  out.set(payload, 5);
  return out;
}

function readFrames(buf) {
  const frames = [];
  let i = 0;
  while (buf.length - i >= 5) {
    const flags = buf[i];
    const len = new DataView(buf.buffer, buf.byteOffset + i + 1, 4).getUint32(0);
    if (buf.length - i - 5 < len) break;
    const payload = buf.slice(i + 5, i + 5 + len);
    frames.push({ flags, payload: new TextDecoder().decode(payload) });
    i += 5 + len;
  }
  return { frames, rest: buf.slice(i) };
}

export async function e2bCreate(env) {
  const key = await envKey(env, 'E2B_API_KEY');
  if (!key) return { ok: false, error: 'E2B_API_KEY belum diset.' };
  const r = await fetch(E2B_API + '/sandboxes', {
    method: 'POST',
    headers: { 'X-API-Key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ templateID: 'base', timeout: 120 })
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.sandboxID) return { ok: false, error: `E2B create HTTP ${r.status}`, detail: clamp(JSON.stringify(d), 300) };
  return { ok: true, sandboxID: d.sandboxID, token: d.envdAccessToken };
}

export async function e2bDelete(env, sandboxID) {
  const key = await envKey(env, 'E2B_API_KEY');
  if (!key || !sandboxID) return;
  try {
    await fetch(`${E2B_API}/${encodeURIComponent(sandboxID)}`, { method: 'DELETE', headers: { 'X-API-Key': key } });
  } catch {}
}

// Jalankan kode Python di sandbox, kembalikan stdout/stderr + exit.
export async function e2bRunCode(env, code, opts = {}) {
  const t0 = Date.now();
  const sb = await e2bCreate(env);
  if (!sb.ok) return sb;
  try {
    const body = connectFrame({
      process: { cmd: 'python3', args: ['-c', String(code || '')], envs: {}, cwd: '/home/user' },
      stdin: false
    });
    const r = await fetch(`${E2B_ENVD}/process.Process/Start`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/connect+json',
        'Connect-Protocol-Version': '1',
        'X-Access-Token': sb.token,
        'E2b-Sandbox-Id': sb.sandboxID,
        'E2b-Sandbox-Port': '49983'
      },
      body,
      signal: AbortSignal.timeout(opts.timeout || 40000)
    });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      return { ok: false, error: `E2B run HTTP ${r.status}`, detail: clamp(t, 300) };
    }
    let raw = new Uint8Array(await r.arrayBuffer());
    let stdout = '';
    let stderr = '';
    let exit = null;
    let guard = 0;
    while (raw.length >= 5 && guard++ < 500) {
      const { frames, rest } = readFrames(raw);
      if (!frames.length) break;
      raw = rest;
      for (const f of frames) {
        if (f.flags !== 0) continue;
        let obj = null;
        try { obj = JSON.parse(f.payload); } catch { continue; }
        const ev = obj && obj.event;
        if (!ev) continue;
        if (ev.data) {
          if (ev.data.stdout) stdout += atob(ev.data.stdout);
          if (ev.data.stderr) stderr += atob(ev.data.stderr);
          if (ev.data.error) stderr += atob(ev.data.error);
        }
        if (ev.end) exit = ev.end.status || 'selesai';
      }
    }
    return {
      ok: true,
      stdout: clamp(stdout, opts.max || 6000),
      stderr: clamp(stderr, 2000),
      exit,
      ms: Date.now() - t0
    };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  } finally {
    await e2bDelete(env, sb.sandboxID);
  }
}

// Ekstrak URL publik dari teks user (maks n, buang duplikat).
export function extractUrls(text, n = 2) {
  const found = String(text || '').match(/https?:\/\/[^\s<>"')]+/gi) || [];
  const seen = new Set();
  const out = [];
  for (const u of found) {
    const clean = u.replace(/[.,;:)]+$/, '');
    if (seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
    if (out.length >= n) break;
  }
  return out;
}
