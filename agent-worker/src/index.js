// Clincoo Agent Worker — Cloudflare Workflows untuk Agent Mode Clincoo
// Tugas agent beneran jalan DURABLE di latar belakang (bukan tergantung request
// HTTP yang bisa putus), dengan progres mid-task:
//   • tiap langkah ditulis ke D1 (agent_tasks + agent_events) → dibaca /api/agent
//   • jika task punya wa_number → kirim progres ke WhatsApp sebelum tugas selesai
//   • kena error pun otomatis RETRY (bawaan Workflows) dan RESUME dari langkah terakhir
//
// Cara kerja:
//   1. App Clincoo (atau gateway WA) membuat task status='queued' di D1
//   2. Cron tiap menit menjemput task 'queued' → create instance Workflow
//   3. Workflow: susun rencana → jalankan langkah satu per satu (idempotent,
//      bisa dijalankan ulang dari posisi mana pun) → rangkuman akhir
//
// Endpoint manual (workers.dev):
//   GET  /            → health check
//   POST /run {task_id} → dispatch task 'queued' sekarang (Bearer AGENT_WORKER_TOKEN jika diset)

import { WorkflowEntrypoint } from 'cloudflare:workers';

const GRAPH = 'https://graph.facebook.com/v21.0';
const WA_MAX_CHARS = 3800;
const MAX_STEPS = 12;
const MAX_TRANSCRIPT = 40;
const STALE_MS = 15 * 60 * 1000; // task 'running' tanpa kabar > 15 menit → antrekan ulang
const STEP_RETRIES = { limit: 5, delay: '30 seconds', backoff: 'exponential' };

const WORKERS_AI_MODELS = ['@cf/zai-org/glm-5.2', '@cf/deepseek-ai/deepseek-v4-flash-0731', '@cf/zai-org/glm-4.7-flash'];
const GEMINI_MODELS = ['gemini-3.6-flash', 'gemini-3-flash-preview'];

const PLANNER_SYSTEM = `Kamu adalah perencana tugas agent untuk platform Clincoo (pembuatan website dengan AI, template, editor kode, deploy Cloudflare Pages, domain kustom, paket Starter/Pro/Bisnis).
Tugasmu: pecah TUJUAN user menjadi langkah-langkah eksekusi yang terurut dan konkret.
Balas HANYA JSON valid tanpa teks lain, format:
{"steps":[{"title":"judul langkah singkat (bahasa Indonesia)","detail":"1-2 kalimat penjelasan apa yang dikerjakan di langkah ini"}]}
Aturan: maksimal 12 langkah, tiap langkah bisa diselesaikan lewat penalaran/penulisan (bukan aksi sistem eksternal), bahasa Indonesia yang jelas.`;

const AGENT_SYSTEM = `Kamu adalah "Clincoo AI Agent" — agen pelaksana mandiri di platform Clincoo (pembuatan website dengan AI: template, editor kode, deploy Cloudflare Pages, domain kustom CNAME @, SSL otomatis, paket Starter gratis/Pro Rp49.000/Bisnis Rp129.000).
Kamu sedang menjalankan SATU langkah dari rencana yang sudah disusun. Kerjakan langkah itu sampai tuntas, konkret, dan langsung pakai — kode diberikan dalam blok kode siap salin, konten diberikan final, keputusan diambil tanpa bertanya balik.
Jangan menawarkan "sebaiknya hubungi" — kamu sendiri yang mengeksekusi. Bahasa Indonesia yang hangat, profesional, dan SANGAT DETAIL. Jawaban harus PANJANG, LENGKAP, dan MENDALAM — jangan pernah menjawab terlalu singkat atau sederhana. Beri penjelasan menyeluruh dengan konteks, langkah, contoh, dan tips.`;

// ===== util =====
function nowIso() { return new Date().toISOString(); }
function safeJson(s, fb) { try { const v = JSON.parse(s); return v ?? fb; } catch (e) { return fb; } }
function json(obj, status) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
}

async function getEnvKey(env, name) {
  if (env[name]) return env[name];
  try { const row = await env.DB.prepare('SELECT value FROM env_vars WHERE key = ?').bind(name).first(); return row?.value || null; } catch (e) { return null; }
}

async function ensureColumn(env) {
  try { await env.DB.prepare('ALTER TABLE agent_tasks ADD COLUMN wa_number TEXT').run(); } catch (e) { /* kolom sudah ada */ }
}

async function loadTask(env, id) {
  try { return await env.DB.prepare('SELECT * FROM agent_tasks WHERE id = ?').bind(id).first() || null; } catch (e) { return null; }
}

async function addEvent(env, task_id, kind, text) {
  try { await env.DB.prepare('INSERT INTO agent_events (task_id, user_key, kind, text, created_at) VALUES (?,?,?,?,?)')
    .bind(task_id, null, kind, String(text || '').slice(0, 500), nowIso()).run(); } catch (e) {}
}

// ===== AI provider chain (sama filosofi /api/agent) =====
async function aiCall(env, messages) {
  const gemKey = await getEnvKey(env, 'GEMINI_API_KEY');
  if (env.AI) {
    for (const model of WORKERS_AI_MODELS) {
      for (let t = 0; t < 2; t++) {
        try {
          const result = await env.AI.run(model, { messages });
          const raw = (result && (result.response || (typeof result === 'string' ? result : ''))) || '';
          const text = raw || (result && result.choices?.[0]?.message?.content) || '';
          if (text) return { text, model };
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
        if (text) return { text, model };
      } catch (e) {}
    }
  }
  return { error: 'Semua provider AI gagal' };
}

function parsePlan(text) {
  try {
    let s = String(text).replace(/```json/gi, '```').replace(/```/g, '').trim();
    const a = s.indexOf('{'); const b = s.lastIndexOf('}');
    if (a !== -1 && b > a) s = s.slice(a, b + 1);
    const obj = JSON.parse(s);
    const steps = Array.isArray(obj.steps) ? obj.steps : (Array.isArray(obj) ? obj : []);
    return steps
      .map(st => ({ title: String(st?.title || '').slice(0, 140), detail: String(st?.detail || '').slice(0, 400) }))
      .filter(st => st.title);
  } catch (e) { return []; }
}

// ===== WhatsApp (opsional — hanya jika env_vars WA terisi) =====
async function waSend(env, to, text) {
  try {
    const token = await getEnvKey(env, 'WHATSAPP_TOKEN');
    const phoneId = await getEnvKey(env, 'WHATSAPP_PHONE_NUMBER_ID');
    if (!token || !phoneId || !to) return;
    const chunks = [];
    let s = String(text || '').trim();
    while (s.length) { chunks.push(s.slice(0, WA_MAX_CHARS)); s = s.slice(WA_MAX_CHARS); }
    for (const c of chunks) {
      await fetch(`${GRAPH}/${phoneId}/messages`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: c } })
      }).catch(() => {});
    }
  } catch (e) {}
}

// ===== Workflow: satu task agent end-to-end, durable & resumable =====
export class AGENT_FLOW extends WorkflowEntrypoint {
  async run(event, ctx) {
    const env = this.env;
    const taskId = String(event?.task_id || '');
    if (!taskId) return 'no-task';
    await ensureColumn(env);
    const t0 = await loadTask(env, taskId);
    if (!t0) return 'missing';
    if (t0.status === 'done') return 'already-done';

    // --- Tahap 1: susun rencana (lewati jika sudah ada — idempotent) ---
    await ctx.step.do('plan', { retries: STEP_RETRIES }, async () => {
      const t = await loadTask(env, taskId);
      if (!t || t.status === 'done') return;
      const plan = safeJson(t.plan, []);
      if (plan.length) return; // rencana sudah tersimpan dari run sebelumnya
      const r = await aiCall(env, [
        { role: 'system', content: PLANNER_SYSTEM },
        { role: 'user', content: 'TUJUAN: ' + t.goal }
      ]);
      if (r.error) throw new Error('provider-mati'); // workflow auto-retry
      const steps = parsePlan(r.text);
      if (!steps.length) throw new Error('rencana-kosong');
      await env.DB.prepare('UPDATE agent_tasks SET plan=?, status=?, error=NULL, updated_at=? WHERE id=?')
        .bind(JSON.stringify(steps.map(s => ({ ...s, done: false }))), 'running', nowIso(), taskId).run();
      await addEvent(env, taskId, 'progress', 'Rencana siap — ' + steps.length + ' langkah: ' + steps.map(s => s.title).join(' · ').slice(0, 400));
      if (t.wa_number) await waSend(env, t.wa_number, '🚀 Rencana siap — ' + steps.length + ' langkah. Mulai dikerjakan sekarang, progres kutulis di chat ini ya.');
    });

    // --- Tahap 2: jalankan langkah satu per satu (tiap langkah = step durable) ---
    for (let i = 0; i < MAX_STEPS; i++) {
      const idx = i;
      await ctx.step.do('run-step-' + idx, { retries: STEP_RETRIES }, async () => {
        const t = await loadTask(env, taskId);
        if (!t || t.status === 'done') return;
        const plan = safeJson(t.plan, []);
        if (idx >= plan.length) return;           // langkah tidak ada → selesai natural
        if (plan[idx].done || idx < t.current_step) return; // sudah dikerjakan (re-run)
        const step = plan[idx];
        const transcript = safeJson(t.transcript, []);
        const msgs = [
          { role: 'system', content: AGENT_SYSTEM },
          ...transcript.slice(-MAX_TRANSCRIPT),
          { role: 'user', content: 'TUJUAN UMUM: ' + t.goal + '\n\nLANGKAH SEKARANG (' + (idx + 1) + '/' + plan.length + '): ' + step.title + (step.detail ? ' — ' + step.detail : '') + '\n\nKerjakan langkah ini saja sampai tuntas dan konkret.' }
        ];
        const r = await aiCall(env, msgs);
        if (r.error) throw new Error('provider-mati'); // workflow auto-retry
        transcript.push({ role: 'user', content: step.title + (step.detail ? ' — ' + step.detail : '') });
        transcript.push({ role: 'assistant', content: r.text });
        plan[idx].done = true;
        await env.DB.prepare('UPDATE agent_tasks SET plan=?, transcript=?, current_step=?, status=?, error=NULL, updated_at=? WHERE id=?')
          .bind(JSON.stringify(plan), JSON.stringify(transcript.slice(-MAX_TRANSCRIPT)), idx + 1, 'running', nowIso(), taskId).run();
        await addEvent(env, taskId, 'progress', 'Langkah ' + (idx + 1) + '/' + plan.length + ' selesai: ' + step.title);
        if (t.wa_number) await waSend(env, t.wa_number, '✅ Langkah ' + (idx + 1) + '/' + plan.length + ' — ' + step.title);
      });
    }

    // --- Tahap 3: rangkuman akhir (idempotent) ---
    await ctx.step.do('summary', { retries: STEP_RETRIES }, async () => {
      const t = await loadTask(env, taskId);
      if (!t || t.status === 'done') return;
      const plan = safeJson(t.plan, []);
      const transcript = safeJson(t.transcript, []);
      if (!plan.length || t.current_step < plan.length) throw new Error('langkah-belum-tuntas'); // retry nanti
      const rf = await aiCall(env, [
        { role: 'system', content: AGENT_SYSTEM },
        { role: 'user', content: 'TUJUAN: ' + t.goal + '\n\nHASIL KERJA PER LANGKAH:\n' + transcript.map(m => (m.role === 'assistant' ? '[agent] ' : '[user] ') + String(m.content).slice(0, 600)).join('\n') + '\n\nRangkum hasil akhir untuk user: apa yang sudah selesai, hasil penting per langkah, dan saran tindak lanjut. Detail, lengkap, dan konkret — multi-paragraf jika perlu, bahasa Indonesia.' }
      ]);
      if (!rf.text) throw new Error('rangkuman-gagal');
      await env.DB.prepare('UPDATE agent_tasks SET status=?, result=?, error=NULL, updated_at=? WHERE id=?')
        .bind('done', rf.text, nowIso(), taskId).run();
      await addEvent(env, taskId, 'done', 'Tugas selesai. ' + String(rf.text || '').slice(0, 300));
      if (t.wa_number) await waSend(env, t.wa_number, '🏁 Tugas selesai!\n\n' + String(rf.text || '').slice(0, 3000));
    });

    return 'done';
  }
}

// ===== Claim & dispatch (atomic — hanya satu runner per task) =====
async function claimTask(env, id) {
  const r = await env.DB.prepare("UPDATE agent_tasks SET status='running', updated_at=? WHERE id=? AND status='queued'")
    .bind(nowIso(), id).run();
  return (r && r.meta && r.meta.changes > 0);
}
async function dispatchTask(env, id) {
  try {
    await env.AGENT_FLOW.create({ id: id + '-' + Date.now().toString(36), params: { task_id: id } });
    return true;
  } catch (e) {
    // instance gagal dibuat → balikin ke antrean agar dijemput menit berikutnya
    try { await env.DB.prepare("UPDATE agent_tasks SET status='queued' WHERE id=? AND status='running'").bind(id).run(); } catch (e2) {}
    return false;
  }
}

// ===== Cron tiap menit: sweep task macet + jemput antrean =====
async function dispatchLoop(env) {
  try {
    await ensureColumn(env);
    // task 'running' tanpa kabar > 15 menit → antrekan ulang (resume otomatis via idempotensi)
    const staleCut = new Date(Date.now() - STALE_MS).toISOString();
    await env.DB.prepare("UPDATE agent_tasks SET status='queued' WHERE status='running' AND updated_at < ?").bind(staleCut).run();
    // jemput maksimal 3 task 'queued' per menit
    const rows = await env.DB.prepare("SELECT id FROM agent_tasks WHERE status='queued' ORDER BY created_at ASC LIMIT 3").all();
    for (const r of (rows && rows.results) || []) {
      if (await claimTask(env, r.id)) await dispatchTask(env, r.id);
    }
  } catch (e) {}
}

// ===== Worker entry: cron + endpoint manual =====
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'GET') {
      return json({ ok: true, service: 'clincoo-agent', workflows: 'agent-flow', version: '1.0' });
    }
    if (request.method === 'POST' && url.pathname === '/run') {
      const tok = await getEnvKey(env, 'AGENT_WORKER_TOKEN');
      const auth = String(request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
      if (tok && auth !== tok) return json({ error: 'Token salah' }, 403);
      const body = await request.json().catch(() => ({}));
      const taskId = String(body?.task_id || '');
      if (!taskId) return json({ error: 'task_id wajib' }, 400);
      const t = await loadTask(env, taskId);
      if (!t) return json({ error: 'Task tidak ditemukan' }, 404);
      if (t.status === 'done') return json({ ok: true, status: 'done' });
      if (t.status !== 'queued') return json({ ok: true, status: t.status, skipped: true });
      if (await claimTask(env, taskId)) { await dispatchTask(env, taskId); return json({ ok: true, dispatched: true }); }
      return json({ ok: true, skipped: true });
    }
    return new Response('Not found', { status: 404 });
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(dispatchLoop(env));
  }
};
