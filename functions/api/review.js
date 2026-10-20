// Cloudflare Pages Function — /api/review "AI Code Review" (SELF-CONTAINED)
// AI membaca seluruh kode proyek (dikirim klien dari workspace), mencari error,
// bug, kelemahan keamanan & masalah logika, lalu memberi laporan perbaikan.
//   POST /api/review { files: [{path, content}], question? }  → { ok, findings }
// Provider chain: Workers AI (GLM-5.2 -> DeepSeek V4 Flash -> GLM-4.7 Flash)
//                 -> Gemini.
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};
export async function onRequestOptions() { return new Response(null, { status: 200, headers: CORS }); }

const MAX_FILES = 25;
const MAX_TOTAL = 80 * 1024;
const REVIEW_SYSTEM = `Kamu adalah "Clincoo Code Reviewer" — engineer senior yang memeriksa kode website (HTML/CSS/JS vanilla, situs statis yang di-deploy ke Cloudflare Pages).
Tugas: temukan ERROR, BUG, kelemahan keamanan, dan masalah logika di file-file berikut, lalu susun laporan terurut berdasarkan prioritas.
Format laporan (Bahasa Indonesia, markdown ringan, langsung isi tanpa basa-basi):
1. **[KRITIS/SEDANG/RINGAN] nama-file** — masalahnya apa (spesifik: baris/fungsi/selector) dan cara memperbaikinya (tunjukkan potongan kode perbaikan bila perlu).
Kalau tidak ada masalah serius, sebutkan hal itu dan beri 2-3 saran peningkatan. Fokus pada hal yang benar-benar merusak situs: JS error (variabel/typo, listener ganda, async salah), link/href rusak, CSS yang menutupi interaksi, data yang gagal load sebelum render.`;

const RATE = { max: 6, windowMs: 60_000 };
const buckets = new Map();
function rateOk(ip) {
  const now = Date.now();
  let b = buckets.get(ip);
  if (!b || now - b.start >= RATE.windowMs) b = { start: now, n: 0 };
  b.n++; buckets.set(ip, b);
  return b.n <= RATE.max;
}
async function getEnvKey(env, name) {
  if (env[name]) return env[name];
  if (!env.DB) return null;
  try { const row = await env.DB.prepare('SELECT value FROM env_vars WHERE key = ?').bind(name).first(); return row?.value || null; } catch { return null; }
}
const WORKERS_AI_MODELS = ['@cf/zai-org/glm-5.2', '@cf/deepseek-ai/deepseek-v4-flash-0731', '@cf/zai-org/glm-4.7-flash'];
const GEMINI_MODELS = ['gemini-3.6-flash'];
async function aiCall(env, messages) {
  const gemKey = await getEnvKey(env, 'GEMINI_API_KEY');
  if (env.AI) {
    for (const model of WORKERS_AI_MODELS) {
      for (let t = 0; t < 2; t++) {
        try {
          const r = await env.AI.run(model, { messages });
          const raw = (r && (r.response || (typeof r === 'string' ? r : ''))) || '';
          const text = raw || (r && r.choices?.[0]?.message?.content) || '';
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
function json(obj, status) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: { 'Content-Type': 'application/json', ...CORS } });
}

export async function onRequestPost({ request, env }) {
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  if (!rateOk(ip)) return json({ error: 'Terlalu banyak permintaan — tunggu sebentar.' }, 429);
  let body = null;
  try { body = await request.json(); } catch (e) { return json({ error: 'Body JSON tidak valid' }, 400); }
  let files = Array.isArray(body?.files) ? body.files : [];
  if (!files.length) return json({ error: 'Tidak ada file untuk direview.' }, 400);
  files = files.filter(f => f && f.path && f.content).slice(0, MAX_FILES);
  let total = 0; const parts = [];
  for (const f of files) {
    const c = String(f.content);
    if (total + c.length > MAX_TOTAL) { parts.push('===== FILE: ' + f.path + ' =====\n(dipotong — file terlalu besar untuk review)'); break; }
    total += c.length;
    parts.push('===== FILE: ' + f.path + ' =====\n' + c);
  }
  const question = String(body?.question || '').slice(0, 500);
  const messages = [
    { role: 'system', content: REVIEW_SYSTEM },
    { role: 'user', content: (question ? 'PERTANYAAN FOKUS USER: ' + question + '\n\n' : '') + 'KODE PROYEK:\n\n' + parts.join('\n\n') }
  ];
  const r = await aiCall(env, messages);
  if (r.error) return json({ error: r.error }, 502);
  return json({ ok: true, findings: r.text });
}
