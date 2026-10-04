// Cloudflare Pages Function — /api/wa "Gateway WhatsApp untuk Clincoo AI" (SELF-CONTAINED)
// Chat Clincoo AI lewat WhatsApp (Cloud API Meta), ala superagent:
//   GET  /api/wa?hub.mode=subscribe&hub.verify_token=...&hub.challenge=...  → verifikasi webhook Meta
//   POST /api/wa  → event masuk dari Meta: pesan user dibalas Clincoo AI OTOMATIS (wajib X-Hub-Signature-256 bila WHATSAPP_APP_SECRET di-set)
//   POST /api/wa  body { action: 'send', to, text } (Bearer admin) → kirim manual
// Konfigurasi (env_vars / env): WHATSAPP_TOKEN (access token Cloud API),
// WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_VERIFY_TOKEN (string bebas untuk verifikasi webhook).
// Sesi per nomor WA tersimpan di D1 (wa_sessions) + kuota harian per nomor (wa_quota, 30/hari).
// Webhook WAJIB dipasang di dashboard Meta → URL: https://clincoo-be2.pages.dev/api/wa

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};
export async function onRequestOptions() { return new Response(null, { status: 200, headers: CORS }); }

const GRAPH = 'https://graph.facebook.com/v21.0';
const MAX_CHARS = 3800;          // batas aman satu pesan WA sebelum dipecah
const SESSION_MSGS = 10;         // konteks yang diingat per nomor
const DAILY_LIMIT = 30;          // balasan AI per nomor per hari

const WA_SYSTEM = `Kamu adalah "Clincoo AI" — asisten resmi Clincoo, platform pembuatan website dengan AI Indonesia (template, editor kode, deploy Cloudflare Pages, domain kustom, SSL otomatis; paket Starter gratis, Pro Rp49.000/bln, Bisnis Rp129.000/bln).
Sekarang kamu mengobrol lewat WhatsApp. Jawab dalam Bahasa Indonesia yang hangat, profesional, dan SINGKAT (ideal 2-6 kalimat — ini chat WA, bukan dokumen). Tanpa markdown; teks polos + emoji secukupnya.
Kalau user minta hal yang butuh akun Clincoo (deploy, workspace, dll), arahkan membuka app.clincoo.buzz dan login. Kalau pertanyaan di luar produk Clincoo, tetap bantu secukupnya secara umum.`;

// ===== env vars (DB env_vars / env asli) =====
async function getEnvKey(env, name) {
  if (env[name]) return env[name];
  if (!env.DB) return null;
  try { const row = await env.DB.prepare('SELECT value FROM env_vars WHERE key = ?').bind(name).first(); return row?.value || null; } catch { return null; }
}


// ===== verifikasi signature webhook Meta (X-Hub-Signature-256, HMAC SHA-256) =====
async function hmacSha256(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// ===== AI provider chain (Workers AI -> Gemini) =====
const WORKERS_AI_MODELS = ['@cf/zai-org/glm-5.2', '@cf/deepseek-ai/deepseek-v4-flash-0731', '@cf/zai-org/glm-4.7-flash'];
const GEMINI_MODELS = ['gemini-3.6-flash', 'gemini-3-flash-preview'];
async function aiCall(env, messages) {
  const gemKey = await getEnvKey(env, 'GEMINI_API_KEY');
  if (env.AI) {
    for (const model of WORKERS_AI_MODELS) {
      for (let t = 0; t < 2; t++) {
        try {
          const result = await env.AI.run(model, { messages });
          const raw = (result && (result.response || (typeof result === 'string' ? result : ''))) || '';
          const text = raw || (result && result.choices?.[0]?.message?.content) || '';
          if (text) return { text };
        } catch (e) {}
      }
    }
  }
  if (gemKey) {
    for (const model of GEMINI_MODELS) {
      try {
        const sys = messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
        const contents = messages.filter(m => m.role !== 'system').map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
        const body = { contents }; if (sys) body.systemInstruction = { parts: [{ text: sys }] };
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': gemKey }, body: JSON.stringify(body)
        });
        const d = await res.json().catch(() => ({}));
        const text = res.ok ? ((d?.candidates?.[0]?.content?.parts) || []).map(p => p.text || '').join('') : '';
        if (text) return { text };
      } catch (e) {}
    }
  }
  return { error: 'Semua provider AI gagal' };
}

// ===== Agent Mode via WA — tugas background (Cloudflare Workflows) =====
async function ensureAgentTables(DB) {
  await DB.prepare(`CREATE TABLE IF NOT EXISTS agent_tasks (
    id TEXT PRIMARY KEY, user_key TEXT, project_id TEXT, goal TEXT, status TEXT,
    plan TEXT, transcript TEXT, current_step INTEGER DEFAULT 0,
    result TEXT, error TEXT, created_at TEXT, updated_at TEXT
  )`).run();
  try { await DB.prepare('ALTER TABLE agent_tasks ADD COLUMN wa_number TEXT').run(); } catch (e) {}
  await DB.prepare('CREATE TABLE IF NOT EXISTS agent_events (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT, user_key TEXT, kind TEXT, text TEXT, created_at TEXT)').run();
}
async function waAgentStart(env, phone, goal) {
  await ensureAgentTables(env.DB);
  const now = new Date().toISOString();
  const id = 'agt_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  await env.DB.prepare('INSERT INTO agent_tasks (id, user_key, project_id, goal, status, plan, transcript, current_step, result, error, wa_number, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .bind(id, 'wa:' + phone, null, goal, 'queued', '[]', '[]', 0, null, null, phone, now, now).run();
  await env.DB.prepare('INSERT INTO agent_events (task_id, user_key, kind, text, created_at) VALUES (?,?,?,?,?)')
    .bind(id, 'wa:' + phone, 'queued', 'Tugas diterima via WhatsApp, masuk antrean.', now).run();
  return id;
}
async function waAgentStatus(env, phone) {
  await ensureAgentTables(env.DB);
  const t = await env.DB.prepare('SELECT * FROM agent_tasks WHERE user_key = ? ORDER BY updated_at DESC LIMIT 1').bind('wa:' + phone).first();
  if (!t) return null;
  let planLen = 0; try { planLen = (JSON.parse(t.plan) || []).length; } catch (e) {}
  const ev = await env.DB.prepare('SELECT kind, text FROM agent_events WHERE task_id = ? ORDER BY id DESC LIMIT 1').bind(t.id).first();
  return { goal: t.goal, status: t.status, step: t.current_step, planLen, lastEvent: ev?.text || '', error: t.error };
}
const WA_TUGAS_HELP = 'Kirim "tugas: <tujuan>" — contoh: tugas: buatkan rencana konten IG 30 hari untuk brand kopi.\nAku kerjakan di latar belakang dan kirim progresnya ke chat ini tiap langkah. Cek progres dengan "status". (Clincoo AI)';

// ===== D1: sesi + kuota =====
async function ensureTables(DB) {
  await DB.prepare('CREATE TABLE IF NOT EXISTS wa_sessions (phone TEXT PRIMARY KEY, messages TEXT, updated_at TEXT)').run();
  await DB.prepare('CREATE TABLE IF NOT EXISTS wa_quota (phone TEXT, day TEXT, count INTEGER, PRIMARY KEY (phone, day))').run();
}
async function loadSession(DB, phone) {
  const row = await DB.prepare('SELECT messages FROM wa_sessions WHERE phone = ?').bind(phone).first();
  try { return JSON.parse(row?.messages || '[]') || []; } catch (e) { return []; }
}
async function saveSession(DB, phone, msgs) {
  const cut = msgs.slice(-SESSION_MSGS * 2);
  await DB.prepare('INSERT INTO wa_sessions (phone, messages, updated_at) VALUES (?, ?, ?) ON CONFLICT(phone) DO UPDATE SET messages = excluded.messages, updated_at = excluded.updated_at')
    .bind(phone, JSON.stringify(cut), new Date().toISOString()).run();
}
async function quotaOk(DB, phone) {
  const day = new Date().toISOString().slice(0, 10);
  try {
    const row = await DB.prepare('SELECT count FROM wa_quota WHERE phone = ? AND day = ?').bind(phone, day).first();
    if ((row ? row.count : 0) + 1 > DAILY_LIMIT) return false;
    await DB.prepare('INSERT INTO wa_quota (phone, day, count) VALUES (?, ?, 1) ON CONFLICT(phone, day) DO UPDATE SET count = count + 1').bind(phone, day).run();
    return true;
  } catch (e) { return true; }
}

// ===== kirim pesan WA =====
async function waSend(env, phoneId, token, to, text) {
  const chunks = [];
  let s = String(text || '').trim();
  while (s.length) { chunks.push(s.slice(0, MAX_CHARS)); s = s.slice(MAX_CHARS); }
  for (const c of chunks) {
    await fetch(`${GRAPH}/${phoneId}/messages`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: c } })
    }).catch(() => {});
  }
}

async function handleIncoming(env, msg) {
  const token = await getEnvKey(env, 'WHATSAPP_TOKEN');
  const phoneId = await getEnvKey(env, 'WHATSAPP_PHONE_NUMBER_ID');
  const verify = await getEnvKey(env, 'WHATSAPP_VERIFY_TOKEN');
  if (!token || !phoneId || !verify) return; // gateway belum dikonfigurasi — abaikan
  const from = String(msg.from || '');
  if (!from) return;
  await ensureTables(env.DB);

  let userText = '';
  if (msg.type === 'text' && msg.text?.body) userText = String(msg.text.body).slice(0, 3000);
  else if (msg.type === 'interactive' && msg.interactive?.button_reply?.title) userText = String(msg.interactive.button_reply.title).slice(0, 1000);
  else if (msg.type === 'interactive' && msg.interactive?.list_reply?.title) userText = String(msg.interactive.list_reply.title).slice(0, 1000);

  if (!userText) {
    await waSend(env, phoneId, token, from, 'Maaf, untuk saat ini aku baru bisa membaca pesan teks ya 🙂 — kirim pertanyaanmu dalam bentuk teks. (Clincoo AI)');
    return;
  }
  // ==== Perintah "tugas ..." — lempar ke Agent Mode background (Workflows) ====
  const mTugas = userText.match(/^tugas\s*[:\-]?\s+(.{3,2000})$/i);
  if (mTugas) {
    const goal = mTugas[1].trim();
    try {
      await waAgentStart(env, from, goal);
      await waSend(env, phoneId, token, from, '✅ Tugas dicatat: "' + goal.slice(0, 120) + '"\n\nAku susun rencana dan kerjakan di latar belakang — progres kutulis ke chat ini tiap langkah. Ketik "status" kapan pun untuk cek. (Clincoo AI)');
    } catch (e) {
      await waSend(env, phoneId, token, from, 'Maaf, gagal mencatat tugas — coba kirim ulang ya. (Clincoo AI)');
    }
    return;
  }
  // ==== Perintah "status" — progres tugas terakhir via WhatsApp ====
  if (/^(status|cek)( tugas)?$/i.test(userText.trim())) {
    const st = await waAgentStatus(env, from);
    if (!st) { await waSend(env, phoneId, token, from, WA_TUGAS_HELP); return; }
    let msg = '📋 Tugas terakharmu:\n"' + String(st.goal).slice(0, 150) + '"\n';
    msg += 'Status: ' + st.status + (st.planLen ? ' — langkah ' + st.step + '/' + st.planLen : '') + '\n';
    if (st.lastEvent) msg += 'Kabar terakhir: ' + String(st.lastEvent).slice(0, 250);
    await waSend(env, phoneId, token, from, msg);
    return;
  }

  if (!(await quotaOk(env.DB, from))) {
    await waSend(env, phoneId, token, from, 'Kamu sudah mencapai batas chat 30 pesan hari ini lewat WhatsApp. Lanjut lagi besok ya! (Clincoo AI)');
    return;
  }

  const history = await loadSession(env.DB, from);
  const messages = [{ role: 'system', content: WA_SYSTEM }, ...history, { role: 'user', content: userText }];
  const r = await aiCall(env, messages);
  if (r.error) {
    await waSend(env, phoneId, token, from, 'Maaf, server AI sedang sibuk — coba kirim ulang sebentar lagi ya. (Clincoo AI)');
    return;
  }
  history.push({ role: 'user', content: userText });
  history.push({ role: 'assistant', content: r.text });
  await saveSession(env.DB, from, history);
  await waSend(env, phoneId, token, from, r.text);
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: { 'Content-Type': 'application/json', ...CORS } });
}

// ===== GET: verifikasi webhook Meta =====
export async function onRequestGet({ request, env }) {
  const q = new URL(request.url).searchParams;
  if (q.get('hub.mode') === 'subscribe') {
    const verify = await getEnvKey(env, 'WHATSAPP_VERIFY_TOKEN');
    if (verify && q.get('hub.verify_token') === verify) {
      return new Response(q.get('hub.challenge') || '', { status: 200, headers: { 'Content-Type': 'text/plain' } });
    }
    return new Response('Forbidden', { status: 403 });
  }
  return json({ ok: true, service: 'Clincoo AI WhatsApp Gateway', webhook: 'https://clincoo-be2.pages.dev/api/wa' });
}

// ===== POST: event Meta (masuk otomatis) / kirim manual (admin) =====
export async function onRequestPost({ request, env }) {
  // jalur 1: kirim manual dari dashboard Clincoo (wajib Bearer admin)
  const auth = request.headers.get('Authorization') || '';
  const raw = await request.text();
  let body = null; try { body = JSON.parse(raw); } catch (e) { body = null; }
  if (body && body.action === 'send') {
    if (!auth.startsWith('Bearer ')) return json({ error: 'Login diperlukan', need_login: true }, 401);
    try {
      const { initTables, getUserByToken } = await import('./auth/shared.js');
      await initTables(env.DB);
      const u = await getUserByToken(env.DB, auth.slice(7));
      const ADMIN = new Set(['muzawwied@gmail.com', 'muzawwied@gmail.com']);
      if (!u || !ADMIN.has(String(u.email || '').toLowerCase())) return json({ error: 'Hanya admin' }, 403);
    } catch (e) { return json({ error: 'Auth gagal' }, 403); }
    const token = await getEnvKey(env, 'WHATSAPP_TOKEN');
    const phoneId = await getEnvKey(env, 'WHATSAPP_PHONE_NUMBER_ID');
    if (!token || !phoneId) return json({ error: 'Gateway WA belum dikonfigurasi (WHATSAPP_TOKEN / WHATSAPP_PHONE_NUMBER_ID)' }, 500);
    if (!body.to || !body.text) return json({ error: 'to & text wajib' }, 400);
    await waSend(env, phoneId, token, String(body.to).replace(/[^0-9+]/g, ''), body.text);
    return json({ ok: true, sent: true });
  }

  // jalur 2: event webhook Meta — wajib signature valid bila App Secret dikonfigurasi
  const appSecret = await getEnvKey(env, 'WHATSAPP_APP_SECRET') || await getEnvKey(env, 'META_APP_SECRET');
  if (appSecret) {
    const sig = request.headers.get('x-hub-signature-256') || '';
    const expected = 'sha256=' + await hmacSha256(appSecret, raw);
    if (sig !== expected) return json({ error: 'invalid signature' }, 403);
  }
  try {
    const entries = body?.entry || [];
    let handled = 0;
    for (const e of entries) {
      for (const ch of (e.changes || [])) {
        const msgs = ch?.value?.messages || [];
        for (const m of msgs) { if (m && m.from) { await handleIncoming(env, m); handled++; } }
      }
    }
    // Meta wajib menerima 200 cepat — selalu oke
    return json({ ok: true, handled });
  } catch (err) {
    return json({ ok: true }); // jangan pernah error ke Meta
  }
}
