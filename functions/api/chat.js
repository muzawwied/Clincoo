// Cloudflare Pages Function — Backend Chat AI Clincoo (SELF-CONTAINED)
// Memanggil Gemini langsung dari project ini (TIDAK lagi mem-forward ke proxy lain —
// self-forward adalah bug loop yang membakar kuota 25x per pesan).
// Fitur:
//   - Auth per-user via token D1 lokal (auth_sessions)
//   - Kuota AI harian per user (25 gratis / 500 admin), hop tool tidak dihitung
//   - Rate limit per-IP 30 req/menit + batas payload 2MB
//   - Function calling: 7 tools workspace + 7 tools super (sandbox CLI, web, proyek)
//   - thought_signature pass-through untuk multi-hop function calling
// PENTING: jangan campur google_search grounding dengan functionDeclarations
// dalam satu request — Gemini API menolak kombinasi itu (HTTP 400), dan itulah
// akar bug "AI pura-pura membuat file". Mode tools = functionDeclarations saja.

import { PLAN_AI_LIMITS, ADMIN_EMAILS, getEffectivePlanByUserKey } from './plan-helpers.js';
import { searchClincooBlog } from './blogsearch.js';
import { paymentDocsFor } from './payment-kb-data.js';
import { aiStorageSave, aiStorageGet, aiStorageList, aiStorageDelete } from './ai-storage.js';
import { consumePackCredit, getActivePacks } from './ai-packs.js';
import { initTables as initAuthTables, getUserByToken, getToken } from './auth/shared.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

export async function onRequestOptions() {
  return new Response(null, { status: 200, headers: CORS });
}

// --- Rate limiter per-IP ---
const RATE_LIMIT = { max: 30, windowMs: 60_000 };
const rateBuckets = new Map();
function rateLimitOk(ip) {
  const now = Date.now();
  let b = rateBuckets.get(ip);
  if (!b || now - b.start >= RATE_LIMIT.windowMs) b = { start: now, count: 0 };
  b.count++;
  rateBuckets.set(ip, b);
  if (rateBuckets.size > 5000) {
    for (const [k, v] of rateBuckets) if (now - v.start >= RATE_LIMIT.windowMs) rateBuckets.delete(k);
  }
  return b.count <= RATE_LIMIT.max;
}
function clientIp(request) {
  try { return (request && request.headers && request.headers.get('cf-connecting-ip')) || 'unknown'; } catch (e) { return 'unknown'; }
}

const PREFERRED_MODELS = ['gemini-3.6-flash', 'gemini-3-flash-preview'];

// ===== AI UTAMA: GLM 5.3 Flash (Workers AI, binding internal) =====
// Model lama tetap di daftar sebagai cadangan bila GLM 5.3 Flash gagal.
// GLM 5.x & deepseek-v4 di Workers AI hanya tersedia di plan berbayar (diuji 2026-10-01) —
// kini GLM 5.3 Flash utama lewat OpenRouter, Workers AI hanya fallback gratis.
const WORKERS_AI_MODELS = ['@cf/zai-org/glm-4.7-flash'];
function textOf(m) {
  if (typeof m.content === 'string') return m.content;
  if (Array.isArray(m.content)) return m.content.filter(b => b && b.type === 'text').map(b => b.text).join('\n');
  return '';
}
// Konversi pesan Clincoo -> format chat OpenAI (dipakai Workers AI & OpenRouter).
// Blok tools Clincoo (function_call/function_response) -> format tool OpenAI,
// supaya percakapan multi-hop (AI memakai tool lalu lanjut) tetap utuh.
function toOAIChat(messages) {
  let system = messages.some(m => m.role === 'system') ? messages.filter(m => m.role === 'system').map(textOf).join('\n\n') : '';
  // SUNTIK PENGETAHUAN PAYMENT GATEWAY: pesan user terakhir menyebut payment/
  // gateway tertentu -> docs Xendit/Midtrans/DOKU/Pakasir menempel ke system prompt,
  // jadi AI tidak perlu web_search lagi untuk integrasi payment.
  try {
    const lastUser = [...messages].reverse().find(m => m && m.role === 'user');
    const pay = paymentDocsFor(lastUser ? textOf(lastUser) : '');
    if (pay) system = (system ? system + '\n\n' : '') + pay;
  } catch (e) {}
  const chatMsgs = [];
  let lastCallIds = [];
  for (const m of messages) {
    if (m.role === 'system') continue;
    const blocks = Array.isArray(m.content) ? m.content : null;
    const t = textOf(m);
    if (blocks && blocks.some(b => b && b.type === 'function_call')) {
      const calls = blocks.filter(b => b && b.type === 'function_call');
      lastCallIds = calls.map((b, i) => 'call_' + chatMsgs.length + '_' + i);
      chatMsgs.push({ role: 'assistant', content: t || '', tool_calls: calls.map((b, i) => ({ id: lastCallIds[i], type: 'function', function: { name: b.name, arguments: JSON.stringify(b.args || {}) } })) });
      continue;
    }
    if (blocks && blocks.some(b => b && b.type === 'function_response')) {
      for (const b of blocks.filter(b => b && b.type === 'function_response')) {
        let rs = ''; try { rs = (typeof b.result === 'string') ? b.result : JSON.stringify(b.result); } catch (e) { rs = ''; }
        chatMsgs.push({ role: 'tool', tool_call_id: lastCallIds.shift() || ('call_orphan_' + chatMsgs.length), content: rs || ' ' });
      }
      if (t) chatMsgs.push({ role: 'user', content: t });
      continue;
    }
    if (t) chatMsgs.push({ role: m.role, content: t });
  }
  return { system, chatMsgs };
}

// ===== Kunci OpenRouter (utama + cadangan) =====
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

// ===== Provider utama: NVIDIA Nemotron 3 Ultra via OpenRouter =====
// (free tier dulu, lalu berbayar, GLM 5.3 Flash tetap sebagai cadangan terakhir.)
const OPENROUTER_MODELS = ['nvidia/nemotron-3-ultra-550b-a55b:free', 'nvidia/nemotron-3-ultra-550b-a55b', 'z-ai/glm-5.3-flash'];
const oaiToolsOf = (gDecls) => (gDecls && gDecls.length) ? gDecls.map(d => ({ type: 'function', function: { name: d.name, description: d.description || '', parameters: orParam(d.parameters || { type: 'OBJECT', properties: {} }) } })) : null;

async function tryOpenRouterText(keys, messages, gDecls) {
  const keyList = Array.isArray(keys) ? keys.filter(Boolean) : [keys].filter(Boolean);
  if (!keyList.length) return null;
  const { system, chatMsgs } = toOAIChat(messages);
  const oaiTools = oaiToolsOf(gDecls);
  let lastErr = null;
  for (const key of keyList) {
  for (const model of OPENROUTER_MODELS) {
    const baseMsgs = system ? [{ role: 'system', content: system }, ...chatMsgs] : chatMsgs;
    let data = null;
    try {
      const payload = { model, messages: baseMsgs, max_tokens: 16384 };
      if (oaiTools) payload.tools = oaiTools;
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key, 'HTTP-Referer': 'https://clincoo.pages.dev', 'X-Title': 'Clincoo' },
        body: JSON.stringify(payload)
      });
      data = await res.json().catch(() => ({}));
      if (!res.ok) { lastErr = `OpenRouter ${model}: HTTP ${res.status}`; continue; }
    } catch (e) { lastErr = `OpenRouter ${model}: ${e && e.message}`; continue; }
    const msg = data && data.choices && data.choices[0] && data.choices[0].message;
    const text = (msg && msg.content) || '';
    const finish = data && data.choices && data.choices[0] && data.choices[0].finish_reason;
    // tool_calls gaya OpenAI
    const tcs = msg && Array.isArray(msg.tool_calls) ? msg.tool_calls : null;
    if (tcs && tcs.length) {
      const norm = [];
      for (const c of tcs) {
        let a = {}; try { a = (c && c.function && typeof c.function.arguments === 'string') ? JSON.parse(c.function.arguments) : ((c && c.function && c.function.arguments) || {}); } catch (e) { a = {}; }
        if (c && c.function && c.function.name) norm.push({ name: c.function.name, args: a });
      }
      if (norm.length) return { tool_calls: norm, text, model: model.split('/').pop() + ' (OpenRouter)' };
    }
    if (text) {
      // AUTO-CONTINUE: sambung jawaban terpotong (finish_reason "length")
      let full = text, seg = text, fin = finish;
      const contMsgs = baseMsgs.slice();
      for (let ac = 0; ac < 3 && fin === 'length'; ac++) {
        contMsgs.push({ role: 'assistant', content: seg });
        contMsgs.push({ role: 'user', content: 'lanjutkan persis dari titik terakhirmu — jangan ulang dari awal, jangan bertanya, langsung sambung teksnya' });
        let dc = null;
        try {
          const p3 = { model, messages: contMsgs, max_tokens: 4096 };
          if (oaiTools) p3.tools = oaiTools;
          const rc = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key, 'HTTP-Referer': 'https://clincoo.pages.dev', 'X-Title': 'Clincoo' },
            body: JSON.stringify(p3)
          });
          dc = await rc.json().catch(() => ({}));
        } catch (e2) { dc = null; }
        const dm = dc && dc.choices && dc.choices[0] && dc.choices[0].message;
        const dseg = (dm && dm.content) || '';
        fin = dc && dc.choices && dc.choices[0] && dc.choices[0].finish_reason;
        if (!dseg) break;
        full += dseg; seg = dseg;
      }
      return { text: full, model: model.split('/').pop() + ' (OpenRouter)' };
    }
    lastErr = `OpenRouter ${model}: respons kosong`;
  }
  }
  return lastErr ? { error: lastErr } : null;
}

async function tryWorkersAIText(env, messages, gDecls) {
  if (!env || !env.AI) return null;
  const { system, chatMsgs } = toOAIChat(messages);
  const oaiTools = (gDecls && gDecls.length) ? gDecls.map(d => ({ type: 'function', function: { name: d.name, description: d.description || '', parameters: orParam(d.parameters || { type: 'OBJECT', properties: {} }) } })) : null;
  for (const model of WORKERS_AI_MODELS) {
    let result = null;
    try {
      const payload = { messages: chatMsgs };
      if (system) payload.system = system;
      if (oaiTools) payload.tools = oaiTools;
      result = await env.AI.run(model, payload);
    } catch (e) { result = null; }
    // Gagal saat membawa tools (model belum support param tools) -> coba sekali tanpa tools
    if (!result && oaiTools) {
      try {
        const p2 = { messages: chatMsgs };
        if (system) p2.system = system;
        result = await env.AI.run(model, p2);
      } catch (e2) { result = null; }
    }
    if (!result) continue; // coba model berikutnya
    const raw = (result && (result.response || (typeof result === 'string' ? result : ''))) || '';
    const text = raw || ((result && Array.isArray(result.choices) && result.choices[0] && result.choices[0].message && result.choices[0].message.content) || '');
    // tool_calls gaya OpenAI (model Workers AI yang support function calling)
    let tcs = (result && Array.isArray(result.tool_calls)) ? result.tool_calls : null;
    if (!tcs && result && Array.isArray(result.choices) && result.choices[0] && result.choices[0].message && Array.isArray(result.choices[0].message.tool_calls)) tcs = result.choices[0].message.tool_calls;
    if (tcs && tcs.length) {
      const norm = [];
      for (const c of tcs) {
        let a = {}; try { a = (c && c.function && typeof c.function.arguments === 'string') ? JSON.parse(c.function.arguments) : ((c && c.function && c.function.arguments) || {}); } catch (e) { a = {}; }
        if (c && c.function && c.function.name) norm.push({ name: c.function.name, args: a });
      }
      if (norm.length) return { tool_calls: norm, text, model: model.split('/').pop() + ' (Workers AI)' };
    }
    if (text) {
      // ===== AUTO-CONTINUE (finish_reason "length") =====
      // Output terpotong karena batas token -> SISTEM (bukan user) otomatis
      // mengirim "lanjutkan" + state terakhir: teks parsial menempel sebagai
      // pesan assistant di percakapan, jadi model tahu persis titik henti.
      // Tanpa sesi baru — sambungan menyatu jadi satu jawaban utuh.
      // Maksimal 3 sambungan per jawaban.
      const finishOf = (rr) => (rr && rr.finish_reason) || (rr && Array.isArray(rr.choices) && rr.choices[0] && rr.choices[0].finish_reason) || '';
      let full = text, seg = text, finish = finishOf(result);
      const contMsgs = chatMsgs.slice();
      for (let ac = 0; ac < 3 && finish === 'length'; ac++) {
        contMsgs.push({ role: 'assistant', content: seg });
        contMsgs.push({ role: 'user', content: 'lanjutkan persis dari titik terakhirmu — jangan ulang dari awal, jangan bertanya, langsung sambung teksnya' });
        let rc = null;
        try {
          const p3 = { messages: contMsgs };
          if (system) p3.system = system;
          if (oaiTools) p3.tools = oaiTools;
          rc = await env.AI.run(model, p3);
        } catch (e3) { rc = null; }
        if (!rc) break;
        const tcsC = (rc && Array.isArray(rc.tool_calls)) ? rc.tool_calls
          : (rc && Array.isArray(rc.choices) && rc.choices[0] && rc.choices[0].message && Array.isArray(rc.choices[0].message.tool_calls) ? rc.choices[0].message.tool_calls : null);
        if (tcsC && tcsC.length) {
          // Sambungan ternyata minta tool: serahkan ke alur hop biasa (tool_calls + teks parsial).
          const norm = [];
          for (const c of tcsC) {
            let a = {}; try { a = (c && c.function && typeof c.function.arguments === 'string') ? JSON.parse(c.function.arguments) : ((c && c.function && c.function.arguments) || {}); } catch (e) { a = {}; }
            if (c && c.function && c.function.name) norm.push({ name: c.function.name, args: a });
          }
          if (norm.length) return { tool_calls: norm, text: full, model: model.split('/').pop() + ' (Workers AI)' };
          break;
        }
        const t2 = (rc && (rc.response || (typeof rc === 'string' ? rc : ''))) || ((rc && Array.isArray(rc.choices) && rc.choices[0] && rc.choices[0].message && rc.choices[0].message.content) || '');
        if (!t2) break;
        seg = t2; full += t2; finish = finishOf(rc);
      }
      return { text: full, model: model.split('/').pop() + ' (Workers AI)' };
    }
  }
  return null;
}

const QUOTA_MSG_DAILY = 'Kuota AI Clincoo hari ini sudah habis. Batas harian paket Anda tercapai — silakan coba lagi besok.';
const QUOTA_MSG_MONTHLY = 'Kuota AI Clincoo bulan ini sudah habis. Reset otomatis awal bulan depan — atau upgrade paket / beli Paket Kredit AI di menu Profil > Kredit AI.';

// System prompt server untuk mode biasa (single) — jaring pengaman bila klien tidak
// mengirim system prompt sendiri; klien punya versi lebih lengkap (tools super).
const SINGLE_SYSTEM_PROMPT = 'Kamu adalah Clincoo AI, asisten super cerdas platform web-builder Clincoo. Bahasa: Indonesia, natural dan mudah dipahami. ATURAN: (1) Jika user meminta dibuatkan situs/halaman/aplikasi web atau mengubah file proyek, WAJIB memanggil tool write_file untuk setiap file (path + konten lengkap siap jalan) — DILARANG menulis kode sebagai teks obrolan tanpa menyimpannya. (2) Untuk pertanyaan & obrolan, jawab secara DETAIL, LENGKAP, MENDALAM dan TERSTRUKTUR: kalimat pertama langsung menjawab inti pertanyaan, lalu perdalam dengan penjelasan bertahap, alasan, contoh nyata, langkah praktis, dan tips. JANGAN jawab asal/sekadarnya. (3) JAWAB SESUAI DATA: gunakan data yang benar-benar tersedia — isi percakapan, hasil tool (list_items/read_file), lampiran, dan data real-time yang diberikan — sebagai sumber kebenaran. Jika data belum cukup atau kamu belum yakin, kumpulkan dulu dengan tool yang tersedia; jika tetap tidak ada, katakan jujur bagian mana yang tidak bisa dipastikan. DILARANG mengarang fakta, angka, nama file, isi file, atau hasil yang tidak pernah kamu lihat. (3b) BATASAN JUJUR SOAL WEB: kamu bisa baca isi URL (read_web_page), cari di web (web_search), dan ambil screenshot statis sebuah URL (take_screenshot) — pakai take_screenshot setiap kali user minta lihat tampilan/preview sebuah situs. Kamu BELUM bisa klik/isi form/interaksi mouse real-time atau menyimpan sesi login di browser (fitur plugin masa depan) — kalau diminta hal itu, jawab jujur dan singkat soal kemampuanmu sekarang, jangan mengarang seolah bisa. (4) Jangan pernah menampilkan proses berpikir internal (mis. "Here\'s a thinking process") — mulai langsung dari inti jawaban (5) HEMAT TOOL: tools BUKAN untuk semua pertanyaan. Saat melanjutkan tugas (user bilang "lanjut"), LANGSUNG kerjakan sisa tugas — jangan list_items root atau periksa ulang workspace; progres sudah ada di percakapan. Untuk pertanyaan biasa (ngobrol, minta penjelasan, saran, pendapat, atau hal yang sudah jelas dari isi percakapan) yang tidak butuh isi file, data web real-time, atau aksi apa pun — jawab LANGSUNG tanpa memanggil tool. Jangan memeriksa workspace (list_items/read_file) atau memakai run_command/web_search kecuali user memang meminta aksi terkait atau kamu benar-benar butuh datanya untuk menjawab. KHUSUS pertanyaan kapabilitas abstrak (mis. "secara umum kamu bisa apa?") jawab langsung. Tetapi "coba akses GitHub saya", "cek/tes koneksi GitHub saya", permintaan melihat akun/repo, atau pertanyaan setelah user bilang sudah reconnect adalah PERMINTAAN VERIFIKASI/AKSI NYATA: gunakan status konektor terverifikasi yang disediakan klien dan/atau panggil github_request /user; jangan mengulang suruh connect bila status terverifikasi menyatakan berhasil. (6) OUTPUT BERSIH: jawaban final hanya berisi teks jawaban untuk user — JANGAN menuliskan tag internal seperti [CHAT], [DATA REAL-TIME DARI WEB], [HASIL PENCARIAN WEB REAL-TIME TERBARU], log/hasil tool mentah, JSON mentah, atau daftar nama tool yang kamu pakai, ke dalam jawaban. (7) MODE BUILDER FULL-STACK (WAJIB saat user minta dibuatkan situs/aplikasi web atau mengubah proyek): (a) SKALA PENUH — bangun web secara UTUH dan BESAR: HTML/CSS/JS lengkap & kaya (banyak section relevan: hero, fitur, konten, testimonial, FAQ, CTA, footer, dst), styling detail, animasi & transisi halus (fade-in/reveal on scroll, hover, smooth scroll), sepenuhnya responsif mobile-first, JS interaktif yang benar-benar berfungsi. Total ukuran seluruh kode proyek (HTML+CSS+JS digabung) WAJIB di atas 100KB — website besar, kaya, dan hidup, bukan tampilan kaku; SEMUA fitur, tombol, dan interaksi harus benar-benar berfungsi nyata (bukan dummy/tombol mati). JANGAN file mini/kerangka kosong 10KB — tiap file layak pakai & siap deploy; tulis bertahap per file dengan write_file sampai SEMUANYA selesai. (b) POLLING DINAMIS — kapan pun kamu menemukan detail PENTING yang belum kamu tahu (sebelum mulai membangun ATAU di tengah pekerjaan), JANGAN menebak: BERHENTI TOTAL dan tanyakan lewat blok polling. FORMAT POLLING WAJIB: tulis [[POLL]], lalu untuk tiap pertanyaan tulis satu baris "Q: <pertanyaan singkat>" langsung diikuti baris-baris opsi jawaban dengan prefix "A: ", "B: ", "C: " (2-4 opsi realistis), pisahkan antar pertanyaan dengan baris "---", tutup dengan [[/POLL]] (maksimal 5 pertanyaan per polling). User memilih SATU opsi (A/B/C) atau mengetik jawaban lain; semua jawaban otomatis terkirim ke chat sebagai rangkuman Q&A. ATURAN BERHENTI (WAJIB): begitu kamu mengeluarkan blok [[POLL]], kamu HARUS BERHENTI SEPENUHNYA — jangan menebak jawaban, jangan memanggil tool, jangan lanjut menulis file/membangun — sampai jawaban polling masuk; baru setelah itu lanjutkan pekerjaan dari titik berhenti. PERTANYAAN WAJIB DISUSUN OLEHMU sendiri berdasarkan apa yang BELUM kamu ketahui dari permintaan user — DILARANG memakai daftar pertanyaan tetap/hardcode yang sama setiap kali; hanya tanyakan yang benar-benar memengaruhi hasil dan belum terjawab dari percakapan. Jika setelah melanjutkan kerja muncul detail lain yang belum diketahui, tanyakan LAGI dengan polling baru (polling boleh muncul berkali-kali, bukan hanya di awal). Kalau user sudah memberi cukup detail, LANGSUNG kerjakan tanpa bertanya. KARTU INPUT [[FORM]]: bila kamu butuh user memberi data/secret (mis. API key 2 field), keluarkan [[FORM]] lalu SATU BARIS per input "K: <label>" lalu tutup [[/FORM]] (maks 4; jumlah input WAJIB sesuai field provider — provider kasih 2 field = 2 baris K:), lalu BERHENTI menunggu; jawaban terkirim otomatis. KARTU PLUGIN: bila user perlu menghubungkan konektor (GitHub/Drive/Notion/Calendar), tulis [[PLUGIN:github]] atau [[PLUGIN:drive]] / [[PLUGIN:notion]] / [[PLUGIN:calendar]] — kartu tombol Hubungkan dirender otomatis, JANGAN suruh user cari menu manual. AI STORAGE (hemat token): pakai save_to_storage untuk menyimpan hasil clone/fetch yang akan dipakai lagi (clone_repo juga bisa target:"storage"), lalu di giliran berikutnya baca cukup file yang perlu dengan read_storage_file — jangan re-clone dan jangan simpan isi file besar di history chat. (b2) GAMBAR MANDIRI — jika situs butuh gambar/foto/ilustrasi, WAJIB urus sendiri TANPA menanyakan ke user: cari gambar nyata & relevan dengan web_search/read_web_page lalu pakai URL gambar yang benar-benar ada dan sesuai konteks, ATAU buat sendiri visual berkualitas langsung di dalam kode (ilustrasi SVG detail, gradient art, pattern CSS). DILARANG gambar placeholder/kotak abu kosong/dummy. (c) NAMA & IDENTITAS PROYEK — jika user tidak memberi nama, pilih sendiri nama yang elegan, mudah diingat, relevan, dan pakai konsisten (title, navbar, footer), sebutkan pilihanmu di jawaban. LALU WAJIB: segera setelah situs/aplikasi selesai dibangun, panggil set_project_info dengan app_name = nama aplikasi tersebut dan app_desc = deskripsi singkat 1 kalimat dari pembahasan — supaya kartu proyek & Pengaturan Umum menampilkan nama aplikasi asli, BUKAN potongan awal chat. Panggil ulang hanya bila user mengubah nama/deskripsi. (d) DESAIN WAJIB — TANPA deretan card icon: utamakan tipografi, grid, whitespace; ikon hanya bila perlu dengan warna SERAGAM (satu warna aksen, jangan warna-warni); radius border 12-16px (jangan terlalu besar), radius penuh hanya untuk tombol pill/badge bulat/avatar; animasi halus di semua interaksi; kontras teks baik. (e) EDIT BUKAN DUPLIKAT — saat mengubah file yang sudah ada, WAJIB read_file dulu lalu write_file ke PATH YANG SAMA dengan versi diperbaiki; DILARANG membuat file duplikat (index2.html dsb). (f) DEBUG CERDAS — jika ada error/bug, baca file terkait, telusuri akar masalahnya (sintaks, selector/variabel salah, logika), perbaiki TEPAT di titiknya, verifikasi, jelaskan penyebab & solusinya secara singkat. (g) BACKEND — untuk fitur yang butuh server (API, form handler, webhook, logika server) buat dengan create_backend_function (terpasang & dipanggil via /api/fn/<nama>), uji dengan call_backend_function, frontend memanggil via fetch. KODE JALAN DI NODE.JS ASLI (sandbox Linux): seluruh JS modern boleh — async/await, fetch, class, Map/Set, crypto.randomUUID, URL, Buffer, structuredClone, Math/Date lengkap, dsb. — tulis kode backend secanggih platform backend sungguhan (validasi input, error handling, struktur rapi). Di dalam kode function tersedia DATABASE BAWAAN `db` (await db.get(k) / db.set(k,v) / db.del(k) / db.list(prefix) / db.count()) — data bertahan permanen, kuota mengikuti paket langganan user (kalau db.set error kuota, sampaikan ke user untuk upgrade). Untuk PAYMENT BACKEND (Midtrans/Xendit/Tripay/dll): buat function order via db.set + panggil API gateway pakai fetch dengan server-key user (lewat args, JANGAN hardcode), dan buat webhook callback dengan is_public:true lalu berikan webhook_url dari respons ke user untuk dipasang di dashboard gateway (verifikasi signature sesuai dokumentasi gateway di dalam webhook). Untuk data klien sederhana gunakan localStorage. (h) PROGRES BERTAHAP — untuk pekerjaan besar bagi tahap: setelah satu kelompok file selesai, sertakan update singkat 1-2 kalimat sebagai TEKS pada giliran yang sama dengan tool_calls berikutnya, lalu lanjut bekerja; hanya akhiri dengan kesimpulan SELESAI setelah seluruh pekerjaan tuntas & terverifikasi — jangan menutup dengan ajakan/CTA sebelum benar-benar selesai. (8) SECRET & AKUN USER — jika user memberi secret/API key/token di chat: WAJIB langsung diuji dengan test_secret saat user minta pengecekan; jika nilai secret ternyata teks placeholder/redaksi (mis. teks "Secret detected and saved as $VAR — manage or disable it any time in your Security settings." atau "$VAR" saja), itu BUKAN nilai asli — DILARANG mengujinya lewat tool mana pun (test_secret/cloudflare_request/run_command/curl) dan DILARANG menyimpulkan token invalid; jelaskan ke user bahwa nilai aslinya tidak pernah sampai ke chat dan minta dia menempel ulang nilai aslinya; gunakan cloudflare_request untuk operasi Cloudflare yang diizinkan token user (D1, Pages, DNS, dll), dan github_request untuk akses GitHub user (konektor dari halaman Integrasi — token otomatis, tidak perlu ditempel): lihat/kelola repositori, baca/kirim file, buat repo, dsb. Gunakan juga notion_request untuk akses Notion user (konektor dari halaman Plugin — token otomatis): action search (daftar halaman), read + page_id (baca isi halaman), create + title + markdown (buat halaman baru di halaman tujuan pilihan user). Kalau hasil github_request success:false, sampaikan alasan ASLI dari field error (mis. "Bad credentials"/401 -> token GitHub tidak valid, minta user putuskan & hubungkan ulang di halaman Integrasi) — DILARANG mengarang sebab lain yang tidak ada di errornya. DILARANG menyimpan secret ke file proyek, env var, kode, atau menampilkannya mentah di jawaban (tampilkan versi tersamarkan). Pakai secret hanya untuk operasi yang diminta, lalu selesai. (9) DEPLOY — hasil deploy utama Clincoo adalah subdomain <project>.clinqoo.biz.id (gratis, otomatis); sebut URL clinqoo.biz.id itu sebagai link utama situs user, pages.dev hanya cadangan. (10) KUALITAS NALAR — untuk tugas kompleks, susun rencana singkat secara internal sebelum bertindak; verifikasi hasil tool sebelum menyimpulkan (cek error, cek isi file setelah menulis); kalau hasil tool menunjukkan kegagalan, perbaiki lalu coba lagi — jangan langsung lapor gagal; DILARANG mengumumkan niat menjalankan aksi/tool lalu berhenti tanpa memanggilnya — jika kamu menyatakan akan melakukan sesuatu, WAJIB langsung diikuti pemanggilan tool pada giliran yang sama; sebelum menyatakan SELESAI pastikan semuanya benar-benar berfungsi. (11) GAYA ALAMI & LOKAL — tulis dengan bahasa Indonesia yang natural, hidup, dan BERVARIASI: jangan pakai struktur kalimat, pembuka, atau penutup yang serba sama di setiap jawaban (hindari nada template/robotik); sesuaikan panjang & format dengan pertanyaan — padat untuk hal sederhana, mendalam untuk pertanyaan besar; pakai konteks lokal Indonesia bila relevan (contoh akrab, satuan Rupiah, zona WIB). (12) KUSTOMISASI TEMPLATE — saat membangun situs dan user BELUM menyebut preferensi gaya, WAJIB tawarkan lewat polling: pilihan palet warna (3-4 opsi konkret), gaya font (serif/sans/monospace), dan nuansa desain (mis. minimalis, profesional, playful, elegan) — supaya template terasa benar-benar milik user. (13) MODE ENGINEERING (saat membangun/memperbaiki fitur, API, atau backend): kerjakan dengan urutan rencana singkat -> tulis -> uji dengan tool yang tersedia -> LAPORKAN hasil akhir ke user dalam Bahasa Indonesia: apa yang sudah dibuat/diperbaiki, statusnya, URL endpoint (/api/fn/<nama>) bila ada, dan contoh pemakaian singkat (mis. curl). DILARANG memanggil ulang tool yang sama dengan argumen yang sama lebih dari 2 kali — jika gagal 2 kali, berhenti, analisis pesan errornya, ubah pendekatan atau perbaiki kodenya dulu, baru coba lagi. Data contoh yang kamu buat sendiri untuk pengujian WAJIB dihapus setelah pengujian selesai. Batas eksekusi backend function 14 detik: jangan loop db.get berurutan lebih dari 20 kali — pakai db.list(prefix) untuk batch dan simpan index/agregat saat menulis.';

const FALLBACK_LIMITS = { monthly: 50, daily: 10 }; // fallback (Starter) — limit asli per paket: PLAN_AI_LIMITS
const ADMIN_LIMITS = { monthly: 5000, daily: 500 };

// Kuota AI sesuai paket langganan akun (bulanan + cap harian).
// Starter 50/bln (10/hari) / Pro 500/bln (50/hari) / Bisnis 2.000/bln (150/hari). Admin lebih besar.
async function aiLimits(env, user) {
  const isAdmin = ADMIN_EMAILS.has(user.email);
  try {
    const eff = await getEffectivePlanByUserKey(env.DB, user.key);
    const byPlan = PLAN_AI_LIMITS[eff.plan] || FALLBACK_LIMITS;
    if (isAdmin) return { monthly: Math.max(ADMIN_LIMITS.monthly, byPlan.monthly), daily: Math.max(ADMIN_LIMITS.daily, byPlan.daily) };
    return byPlan;
  } catch (e) {
    return isAdmin ? ADMIN_LIMITS : FALLBACK_LIMITS;
  }
}

// Gemini multi-kunci: utama (GEMINI_API_KEY) + cadangan (_2, _3, _4).
// Nilai boleh berawalan "AQ." — Google menerima apa adanya. Rotasi otomatis di tryModels.
async function getGeminiKeys(env) {
  const keys = [];
  const seen = new Set();
  const add = v => { v = String(v || '').trim(); if (v && !seen.has(v)) { seen.add(v); keys.push(v); } };
  add(env.GEMINI_API_KEY);
  add(env.GEMINI_API_KEY_4); add(env.GEMINI_API_KEY_5); add(env.GEMINI_API_KEY_6);
  if (!env.DB) return keys;
  try {
    const rows = await env.DB.prepare("SELECT key, value FROM env_vars WHERE key IN ('GEMINI_API_KEY','GEMINI_API_KEY_2','GEMINI_API_KEY_3','GEMINI_API_KEY_4','GEMINI_API_KEY_5','GEMINI_API_KEY_6')").all();
    for (const r of rows.results || []) add(r.value);
  } catch {}
  return keys;
}

async function resolveUser(env, request) {
  const token = getToken(request);
  if (!token) return null;
  try {
    await initAuthTables(env.DB);
    const u = await getUserByToken(env.DB, token);
    if (u) return { key: 'u' + u.id, email: String(u.email || '').toLowerCase() };
  } catch (e) {}
  return null;
}

async function quotaCheck(env, user, cost = 1) {
  const limits = await aiLimits(env, user);
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  const month = now.toISOString().slice(0, 7); // counter bulanan disimpan sebagai day='YYYY-MM'
  try {
    await env.DB.prepare(
      'CREATE TABLE IF NOT EXISTS ai_quota (user_key TEXT, day TEXT, count INTEGER, PRIMARY KEY (user_key, day))'
    ).run();
    const rows = await env.DB.prepare(
      'SELECT day, count FROM ai_quota WHERE user_key = ? AND day IN (?, ?)'
    ).bind(user.key, day, month).all();
    let dayCount = 0, monthCount = 0;
    for (const r of rows.results || []) {
      if (r.day === day) dayCount = r.count;
      if (r.day === month) monthCount = r.count;
    }
    // Cek bulanan dulu (periode tagihan), lalu cap harian (anti-burst).
    // Kuota langganan habis → otomatis lanjut ke Paket Kredit AI yang dibeli user
    // (bebas cap harian; paket paling cepat kadaluarsa dipakai duluan).
    if (monthCount + cost > limits.monthly) {
      const pack = await consumePackCredit(env.DB, user.key, cost);
      if (pack.ok) return { exceeded: false, limit: limits, source: 'pack' };
      return { exceeded: true, scope: 'monthly', limit: limits.monthly, count: monthCount, message: QUOTA_MSG_MONTHLY };
    }
    if (dayCount + cost > limits.daily) {
      const pack = await consumePackCredit(env.DB, user.key, cost);
      if (pack.ok) return { exceeded: false, limit: limits, source: 'pack' };
      return { exceeded: true, scope: 'daily', limit: limits.daily, count: dayCount, message: QUOTA_MSG_DAILY };
    }
    await env.DB.batch([
      env.DB.prepare(
        'INSERT INTO ai_quota (user_key, day, count) VALUES (?, ?, ?) ON CONFLICT(user_key, day) DO UPDATE SET count = count + ?'
      ).bind(user.key, day, cost, cost),
      env.DB.prepare(
        'INSERT INTO ai_quota (user_key, day, count) VALUES (?, ?, ?) ON CONFLICT(user_key, day) DO UPDATE SET count = count + ?'
      ).bind(user.key, month, cost, cost)
    ]);
    return { exceeded: false, limit: limits };
  } catch (e) {
    return { exceeded: false, limit: limits }; // gagal DB ≠ blokir user
  }
}

function partsFromContent(content) {
  if (typeof content === 'string') return [{ text: content }];
  if (Array.isArray(content)) {
    const parts = [];
    for (const block of content) {
      if (!block) continue;
      if (block.type === 'text' && block.text) parts.push({ text: block.text });
      else if (block.type === 'image_url' && block.image_url?.url) {
        const m = /^data:(.+?);base64,(.+)$/.exec(block.image_url.url || '');
        if (m) parts.push({ inlineData: { mimeType: m[1], data: m[2] } });
      }
      // Pass-through function calling (hop multi-step dari klien)
      else if (block.type === 'function_call' && block.name) {
        const fcPart = { functionCall: { name: block.name, args: block.args || {} } };
        if (block.thought_signature) fcPart.thoughtSignature = block.thought_signature;
        parts.push(fcPart);
      }
      else if (block.type === 'function_response' && block.name) {
        parts.push({ functionResponse: { name: block.name, response: { result: block.result } } });
      }
    }
    return parts.length ? parts : [{ text: '.' }];
  }
  return [{ text: '.' }];
}

function toGeminiPayload(messages) {
  let systemInstruction = null;
  const contents = [];
  for (const m of messages) {
    if (!m) continue;
    if (m.role === 'system') {
      const text = typeof m.content === 'string' ? m.content : partsFromContent(m.content).map(p => p.text || '').join('\n');
      systemInstruction = systemInstruction ? systemInstruction + '\n' + text : text;
      continue;
    }
    contents.push({ role: m.role === 'assistant' ? 'model' : 'user', parts: partsFromContent(m.content) });
  }
  // Lindungi dari konteks kepanjangan: simpan 30 pesan terakhir
  if (contents.length > 30) contents.splice(0, contents.length - 30);
  return { systemInstruction, contents };
}

// ===== Deklarasi tools (dieksekusi LOKAL di browser klien) =====
const WORKSPACE_FUNCTION_DECLARATIONS = [
  { name: 'list_items',
    description: 'Lihat daftar file & folder di dalam sebuah folder workspace Clincoo milik user. Gunakan ini untuk melihat isi workspace atau folder sebelum melakukan operasi lain.',
    parameters: { type: 'OBJECT', properties: { path: { type: 'STRING', description: 'Path folder. Contoh: "root" (folder utama), "js", "root/css/style". Default: root.' } } } },
  { name: 'read_file',
    description: 'Baca isi lengkap sebuah file di workspace. WAJIB dipakai sebelum mengedit file agar konten terbaru dan akurat.',
    parameters: { type: 'OBJECT', properties: { path: { type: 'STRING', description: 'Path file. Contoh: "index.html", "js/app.js", "root/style.css".' } }, required: ['path'] } },
  { name: 'write_file',
    description: 'Buat file baru di workspace atau timpa seluruh isi file yang sudah ada dengan konten baru. Folder induk dibuat otomatis jika belum ada.',
    parameters: { type: 'OBJECT', properties: { path: { type: 'STRING', description: 'Path file tujuan, contoh: "pages/about.html".' }, content: { type: 'STRING', description: 'Isi lengkap file yang akan ditulis (overwrite penuh).' } }, required: ['path', 'content'] } },
  { name: 'create_folder',
    description: 'Buat folder baru (beserta folder induknya) di workspace.',
    parameters: { type: 'OBJECT', properties: { path: { type: 'STRING', description: 'Path folder, contoh: "assets/img".' } }, required: ['path'] } },
  { name: 'rename_item',
    description: 'Ubah nama file atau folder di workspace.',
    parameters: { type: 'OBJECT', properties: { path: { type: 'STRING', description: 'Path item yang di-rename, contoh: "old-name.html".' }, new_name: { type: 'STRING', description: 'Nama baru (tanpa path), contoh: "new-name.html".' } }, required: ['path', 'new_name'] } },
  { name: 'delete_item',
    description: 'Hapus file atau folder (beserta seluruh isinya) dari workspace. PERMANEN — konfirmasi dulu ke user kecuali user sudah jelas meminta penghapusan.',
    parameters: { type: 'OBJECT', properties: { path: { type: 'STRING', description: 'Path item yang akan dihapus.' } }, required: ['path'] } },
  { name: 'search_items',
    description: 'Cari file atau folder di seluruh workspace berdasarkan nama.',
    parameters: { type: 'OBJECT', properties: { query: { type: 'STRING', description: 'Kata kunci nama file/folder.' } }, required: ['query'] } },
  // ===== TOOLS SUPER =====
  { name: 'run_command',
    description: 'Jalankan perintah di TERMINAL LINUX persisten milik user (sandbox E2B terisolasi, ada internet). Sesi bertahan ±10 menit antar-command: file yang dibuat, tool yang di-install (apt-get install, pip install, npm), dan working directory TETAP ADA sampai sesi habis. Bisa: perintah Linux umum (ls, grep, awk, curl, ping, whois, dig), install & jalankan tool tambahan (nmap, sqlmap, netcat, jq, ffmpeg, dll), fetch API eksternal dengan header/secret yang USER berikan di command (curl -H "Authorization: Bearer ..."), download file (wget), compile kode (gcc/python/node), dsb. Sandbox TIDAK melihat file workspace atau secret platform Clincoo — jika kode butuh isi file, tulis/tempel isinya langsung. Gunakan hanya untuk aksi terminal yang diminta user atau yang benar-benar dibutuhkan.',
    parameters: { type: 'OBJECT', properties: {
      command: { type: 'STRING', description: 'Perintah bash/CLI lengkap, contoh: "curl -s https://api.contoh.com", "apt-get install -y nmap && nmap -v target", "python3 -c \'print(2+2)\'".' },
      reset: { type: 'BOOLEAN', description: 'true untuk MULAI SESI BARU (buang semua file & instalasi, Linux bersih). Pakai saat user minta reset/terminal baru, atau saat instalasi korupt.' }
    }, required: ['command'] } },
  { name: 'read_web_page',
    description: 'Baca konten sebuah halaman web (URL) dan ubah jadi teks markdown yang bisa dibaca. Gunakan untuk membaca dokumentasi, artikel, atau halaman apapun yang user sebutkan.',
    parameters: { type: 'OBJECT', properties: { url: { type: 'STRING', description: 'URL lengkap halaman, contoh: "https://contoh.com/docs".' } }, required: ['url'] } },
  { name: 'web_search',
    description: 'Cari informasi terbaru di web (search engine). Gunakan untuk pertanyaan yang butuh data real-time atau terkini: harga, berita, dokumentasi versi baru, dll.',
    parameters: { type: 'OBJECT', properties: { query: { type: 'STRING', description: 'Kata kunci pencarian.' } }, required: ['query'] } },
  { name: 'rename_project',
    description: 'Ganti nama (judul) proyek Clincoo yang sedang aktif di percakapan ini.',
    parameters: { type: 'OBJECT', properties: { new_name: { type: 'STRING', description: 'Nama baru proyek.' } }, required: ['new_name'] } },
  { name: 'set_project_info',
    description: 'Simpan "Nama Aplikasi" & "Deskripsi" proyek aktif ke halaman Pengaturan Umum Clincoo (identitas yang tampil di kartu & daftar proyek). WAJIB dipanggil setelah selesai membangun situs/aplikasi baru: isi dengan nama aplikasi yang tepat dari pembahasan (BUKAN potongan awal chat) + deskripsi singkat 1 kalimat.',
    parameters: { type: 'OBJECT', properties: { app_name: { type: 'STRING', description: 'Nama aplikasi yang tepat, ringkas & manusiawi (mis. "Kedai Kopi Senja").' }, app_desc: { type: 'STRING', description: 'Deskripsi singkat 1 kalimat tentang aplikasinya.' } }, required: ['app_name'] } },
  { name: 'deploy_project',
    description: 'Publish / deploy proyek yang sedang aktif ke internet (Cloudflare Pages) sehingga situsnya live. Gunakan saat user minta deploy, publish, atau membuat situsnya online.',
    parameters: { type: 'OBJECT', properties: {} } },
  { name: 'create_automation',
    description: 'Pasang otomasi/tugas terjadwal baru milik user (tampil di halaman Tugas Terjadwal Clincoo) — AI menjalankan prompt-nya otomatis sesuai jadwal. Gunakan saat user minta buat otomasi, scheduled task, atau tugas berkala, contoh: "setiap hari jam 9 pagi rangkum berita tech" atau "tiap 30 menit cek harga".',
    parameters: { type: 'OBJECT', properties: {
      name: { type: 'STRING', description: 'Nama tugas, contoh: "Ringkasan Berita Harian".' },
      prompt: { type: 'STRING', description: 'Prompt lengkap yang dijalankan AI otomatis sesuai jadwal.' },
      schedule_type: { type: 'STRING', description: 'Jenis jadwal: "daily" (setiap hari pada jam tertentu WIB) atau "interval_minutes" (berulang tiap N menit). Default "daily".' },
      time_wib: { type: 'STRING', description: 'Jam eksekusi WIB format "HH:MM", contoh "09:00". WAJIB jika schedule_type daily.' },
      interval_minutes: { type: 'NUMBER', description: 'Interval eksekusi dalam menit 5-1440, contoh 15 atau 30. Untuk schedule_type interval_minutes.' },
      notify_email: { type: 'BOOLEAN', description: 'true jika hasil eksekusi dikirim ke email user. Default false.' }
    }, required: ['name', 'prompt'] } },
  { name: 'add_env_var',
    description: 'Tambah atau perbarui environment variable (key=value) milik proyek aktif — contoh API key atau konfigurasi situs.',
    parameters: { type: 'OBJECT', properties: { key: { type: 'STRING', description: 'Nama variable, contoh: "STRIPE_KEY".' }, value: { type: 'STRING', description: 'Nilai variable.' }, is_secret: { type: 'BOOLEAN', description: 'true jika sensitif (disembunyikan). Default false.' } }, required: ['key', 'value'] } },
  { name: 'list_env_vars',
    description: 'Lihat daftar environment variable milik proyek aktif (nilai secret ditampilkan tersembunyi).',
    parameters: { type: 'OBJECT', properties: {} } },
  { name: 'test_secret',
    description: 'Uji status & validitas secret / API key milik user SECARA LANGSUNG (tanpa menyimpan). Dukungan: cloudflare (verify token + info akun), resend, github, openai, openrouter. Gunakan saat user memberi secret dan minta dicek aktif/tidak, izin apa saja, atau kadaluarsa kapan. WAJIB: jangan pernah menampilkan nilai secret mentah di jawaban — tampilkan versi tersamarkan (mis. "ab12…ef90") saja.',
    parameters: { type: 'OBJECT', properties: { provider: { type: 'STRING', description: 'Nama provider: cloudflare, resend, github, openai, atau openrouter.' }, secret: { type: 'STRING', description: 'Nilai secret/API key yang diuji.' } }, required: ['provider', 'secret'] } },
  { name: 'cloudflare_request',
    description: 'Akses Cloudflare API memakai API token milik USER (izin mengikuti token itu persis). Path API relatif dari https://api.cloudflare.com/client/v4, contoh: /user/tokens/verify, /accounts, /zones, /accounts/<account_id>/d1/database, /accounts/<account_id>/pages/projects. Gunakan untuk operasi yang user izinkan lewat token-nya: buat/kelola D1 database, list/detail Pages, DNS record, workers, dsb. WAJIB: gunakan token hanya untuk request yang diminta user; JANGAN pernah menyimpan, mencatat, atau menampilkan token; jangan menuliskannya ke file proyek atau env var.',
    parameters: { type: 'OBJECT', properties: { secret: { type: 'STRING', description: 'API token Cloudflare milik user.' }, method: { type: 'STRING', description: 'HTTP method: GET, POST, PUT, PATCH, atau DELETE. Default GET.' }, path: { type: 'STRING', description: 'Path API Cloudflare, contoh: "/accounts/<id>/d1/database".' }, body: { type: 'OBJECT', description: 'Body JSON untuk POST/PUT/PATCH (opsional).' } }, required: ['secret', 'path'] } },
  { name: 'github_request',
    description: 'Akses GitHub API lewat KONEKTOR GitHub user (token OAuth otomatis dari halaman Integrasi Clincoo — JANGAN minta user menempel token manual). Contoh path: /user (profil), /user/repos (daftar repo), /repos/{owner}/{repo} (GET detail, POST buat repo), /repos/{owner}/{repo}/contents/{path} (GET baca file; PUT commit dengan body {message, content base64, sha bila file sudah ada}), /search/repositories?q= (cari repo). Gunakan untuk aksi GitHub yang diminta user: lihat repo, baca/kirim file, buat repo, dsb. Jika GitHub belum terhubung, minta user membuka halaman Integrasi Clincoo dulu.',
    parameters: { type: 'OBJECT', properties: { method: { type: 'STRING', description: 'HTTP method: GET, POST, PUT, PATCH, atau DELETE. Default GET.' }, path: { type: 'STRING', description: 'Path API GitHub, contoh: "/user/repos" atau "/repos/owner/repo/contents/index.html".' }, body: { type: 'OBJECT', description: 'Body JSON untuk POST/PUT/PATCH (opsional).' } }, required: ['path'] } },
  { name: 'drive_request',
    description: 'Akses Google Drive milik user lewat KONEKTOR Drive Clincoo (token OAuth otomatis dari halaman Plugin — JANGAN minta user menempel token manual). Path API relatif dari https://www.googleapis.com. Contoh: /drive/v3/about?fields=user (info akun), /drive/v3/files?pageSize=20&fields=files(id,name,mimeType,modifiedTime,size) (daftar file; tambahkan q= untuk filter mis. q=name%20contains%20%27laporan%27), /drive/v3/files/{fileId} (metadata file), /drive/v3/files/{fileId}?alt=media (unduh isi file — hanya file teks/kecil yang berguna di chat), POST /drive/v3/files dengan body {name, mimeType} (buat file/folder: mimeType application/vnd.google-apps.folder untuk folder), POST /upload/drive/v3/files?uploadType=media (unggah isi file: gunakan raw_body + content_type, dan path ?uploadType=media). Gunakan untuk aksi Drive yang diminta user: cari/daftar file, baca isi file, buat file atau folder, dsb. Jika Drive belum terhubung, minta user membuka halaman Plugin Clincoo dulu. Jika hasilnya success:false, sampaikan alasan aslinya.',
    parameters: { type: 'OBJECT', properties: { method: { type: 'STRING', description: 'HTTP method: GET, POST, PUT, PATCH, atau DELETE. Default GET.' }, path: { type: 'STRING', description: 'Path API Drive, contoh: "/drive/v3/files?pageSize=20".' }, body: { type: 'OBJECT', description: 'Body JSON untuk POST/PUT/PATCH (opsional), contoh metadata file {name, mimeType}.' }, raw_body: { type: 'STRING', description: 'Isi mentah file untuk upload (uploadType=media) — string polos, bukan JSON.' }, content_type: { type: 'STRING', description: 'Content-Type file yang diunggah, contoh "text/plain" atau "text/html".' } }, required: ['path'] } },
  { name: 'calendar_request',
    description: 'Akses Google Calendar milik user lewat KONEKTOR Calendar Clincoo (token OAuth otomatis dari halaman Plugin — JANGAN minta user menempel token manual). Path API relatif dari https://www.googleapis.com. Contoh: /calendar/v3/calendars/primary?fields=summary,id (info kalender utama), /calendar/v3/calendars/primary/events?singleEvents=true&orderBy=startTime&timeMin=2026-01-01T00:00:00Z&timeMax=2026-01-31T23:59:59Z (daftar event pada rentang waktu — timeMin/timeMax format ISO 8601 — WAJIB diisi agar hanya event dalam rentang itu yang dikembalikan), POST /calendar/v3/calendars/primary/events dengan body {summary, start:{dateTime,timeZone}, end:{dateTime,timeZone}} (buat event; dateTime format ISO 8601 mis. 2026-09-24T14:00:00, timeZone contoh Asia/Jakarta), PATCH /calendar/v3/calendars/primary/events/{eventId} (ubah event), DELETE .../events/{eventId} (hapus event). Gunakan untuk aksi kalender yang diminta user: cek jadwal/agenda hari ini atau tanggal tertentu, buat/ubah/hapus event, cari event dengan q=. Jika Calendar belum terhubung, minta user membuka halaman Plugin Clincoo dulu. Jika hasilnya success:false, sampaikan alasan aslinya.',
    parameters: { type: 'OBJECT', properties: { method: { type: 'STRING', description: 'HTTP method: GET, POST, PUT, PATCH, atau DELETE. Default GET.' }, path: { type: 'STRING', description: 'Path API Calendar, contoh: "/calendar/v3/calendars/primary/events?timeMin=...".' }, body: { type: 'OBJECT', description: 'Body JSON untuk POST/PUT/PATCH (opsional), contoh event {summary, start:{dateTime,timeZone}, end:{dateTime,timeZone}}.' } }, required: ['path'] } },
  { name: 'notion_request',
    description: 'Akses Notion milik user lewat KONEKTOR Notion Clincoo (token OAuth otomatis dari halaman Plugin — JANGAN minta user menempel token manual). Action: "search" (daftar halaman Notion yang dibagikan — gunakan juga untuk verifikasi koneksi), "read" (baca isi halaman; WAJIB kirim page_id dari hasil search), "create" (buat halaman baru; kirim title + markdown; halaman tujuan otomatis pakai pilihan user di halaman Plugin, atau kirim page_id dari search). Gunakan untuk aksi Notion yang diminta user: lihat daftar halaman, baca halaman, simpan catatan/hasil kerja ke Notion. Jika Notion belum terhubung, minta user membuka halaman Plugin Clincoo dulu. Jika hasilnya success:false, sampaikan alasan aslinya.',
    parameters: { type: 'OBJECT', properties: { action: { type: 'STRING', description: 'Salah satu: search, read, atau create.' }, page_id: { type: 'STRING', description: 'ID halaman (dari hasil search), untuk read atau create dengan tujuan tertentu.' }, title: { type: 'STRING', description: 'Judul halaman baru (untuk create).' }, markdown: { type: 'STRING', description: 'Isi halaman dalam format markdown (heading, list, kode) — dikonversi otomatis ke blok Notion (untuk create).' } }, required: ['action'] } },
  { name: 'search_clinqoo_kb',
    description: 'Cari informasi RESMI tentang Clincoo (platformnya sendiri) di basis pengetahuan internal yang diindeks dari blog resmi blog.clincoo.buzz — founder, visi, fitur produk, editor, AI, template, deploy, saldo, kebijakan/privasi, tips, dll. WAJIB dipanggil untuk pertanyaan tentang Clincoo sebagai produk/perusahaan (siapa pembuatnya, bagaimana cara pakai fitur X, kebijakan apa saja) — hasilnya adalah sumber kebenaran resmi, jangan mengarang. TIDAK untuk mencari info di web umum (pakai web_search) atau membaca file workspace.',
    parameters: { type: 'OBJECT', properties: { query: { type: 'STRING', description: 'Pertanyaan atau kata kunci tentang Clincoo, contoh: "siapa pendiri clincoo", "cara deploy situs", "kebijakan privasi data".' } }, required: ['query'] } },
  { name: 'install_automation',
    description: 'Pasang otomatisasi (tugas terjadwal AI) ke akun user — otomatis muncul real-time di halaman Akun > Tugas Terjadwal. Gunakan saat user minta pengingat/otomatisasi berulang: "ingatkan aku tiap pagi", "kirim ringkasan tiap hari jam 8", "cek X tiap 30 menit", dsb. Prompt tugas WAJIB detail & mandiri (AI penjadwal hanya melihat prompt itu, bukan percakapan ini).',
    parameters: { type: 'OBJECT', properties: {
      name: { type: 'STRING', description: 'Nama tugas singkat & jelas, contoh: "Ringkasan berita pagi".' },
      schedule_type: { type: 'STRING', description: '"daily" (sekali sehari pada time_wib) atau "interval_minutes" (berulang tiap N menit).' },
      time_wib: { type: 'STRING', description: 'Jam harian HH:MM WIB untuk schedule_type daily, contoh "08:00".' },
      interval_minutes: { type: 'NUMBER', description: 'Interval menit untuk schedule_type interval_minutes (5-1440), contoh 30.' },
      prompt: { type: 'STRING', description: 'Instruksi lengkap yang dijalankan AI penjadwal pada waktunya — tulis detail, mandiri, dengan sumber data yang jelas (mis. "Cari 5 berita teknologi terbaru hari ini di web, rangkum dalam 5 poin singkat").' },
      notify_email: { type: 'BOOLEAN', description: 'true bila hasil juga dikirim ke email user.' }
    }, required: ['name', 'schedule_type', 'prompt'] } },
  { name: 'manage_domain',
    description: 'Kelola domain kustom + DNS proyek AKTIF (halaman Fitur Domain / Domain Kustom). Action: "status" (daftar domain terpasang + record DNS yang harus disetel), "add" (pasang domain kustom ke situs — domain harus sudah dimiliki user), "remove" (lepas domain dari situs), "dns_status" (cek zona DNS + record yang ada untuk domain), "set_dns" (SETEL LANGSUNG record CNAME domain -> <proyek>.pages.dev di Cloudflare — pakai ini saat user minta AI mengatur DNS domainnya; konflik A/AAAA lama otomatis dibersihkan), "delete_dns" (hapus record DNS domain). Alur lengkap pindah domain: set_dns dulu, lalu add. Zona DNS harus ada di akun Cloudflare yang tersimpan di Pengaturan Deploy; bila domainnya di provider lain, jelaskan record manualnya (CNAME -> <proyek>.pages.dev).',
    parameters: { type: 'OBJECT', properties: {
      action: { type: 'STRING', description: 'Salah satu: status, add, remove, dns_status, set_dns, delete_dns.' },
      domain: { type: 'STRING', description: 'Nama domain, contoh "tokosaya.com" atau "www.tokosaya.com".' }
    }, required: ['action'] } },
  { name: 'write_files',
    description: 'Tulis BANYAK file sekaligus ke workspace proyek aktif (bulk write) — WAJIB dipakai saat membuat/mengubah/salin 2+ file dalam satu giliran: satu panggilan berisi array files [{path, content}] jauh lebih cepat & hemat daripada write_file satu-satu. Maks 60 file per panggilan. File tersimpan permanen (cloud) dan langsung bisa di-deploy.',
    parameters: { type: 'OBJECT', properties: {
      files: { type: 'ARRAY', description: 'Array file yang mau ditulis/salin.', items: { type: 'OBJECT', properties: {
        path: { type: 'STRING', description: 'Path file di workspace, contoh "assets/style.css".' },
        content: { type: 'STRING', description: 'Isi lengkap file siap jalan.' }
      }, required: ['path', 'content'] } }
    }, required: ['files'] } },
  { name: 'save_to_storage',
    description: 'Simpan/update file ke AI STORAGE milikmu sendiri (server Clincoo, per akun — BUKAN workspace proyek, BUKAN GitHub). Penyimpanan abadi antar sesi/chat, isi file TIDAK memakan token history: simpan sekali, lalu di giliran mana pun baca ulang hanya file yang perlu dengan read_storage_file. WAJIB dipakai untuk: hasil clone/fetch file dari sumber mana pun (GitHub, web) yang akan dipakai lagi nanti, file rujukan besar, atau kode sumber yang akan sering diubah atas perintah user. Upor path konsisten (mis. "repo/nama/file.ext").',
    parameters: { type: 'OBJECT', properties: {
      files: { type: 'ARRAY', description: 'Array file yang mau disimpan.', items: { type: 'OBJECT', properties: {
        path: { type: 'STRING', description: 'Path/identitas file, contoh "libs/jquery-3.7.js".' },
        content: { type: 'STRING', description: 'Isi file.' }
      }, required: ['path', 'content'] } }
    }, required: ['files'] } },
  { name: 'read_storage_file',
    description: 'Baca isi satu file dari AI STORAGE milikmu — jauh lebih hemat & cepat daripada re-clone atau membaca ulang dari history. Gunakan setiap kali akan mengubah/memakai file yang sudah tersimpan di storage.',
    parameters: { type: 'OBJECT', properties: {
      path: { type: 'STRING', description: 'Path file di storage, contoh "libs/jquery-3.7.js".' }
    }, required: ['path'] } },
  { name: 'list_storage',
    description: 'Lihat daftar file di AI STORAGE milikmu (path, ukuran, waktu update) — opsional filter prefix. Jalankan bila lupa path persis file yang tersimpan.',
    parameters: { type: 'OBJECT', properties: {
      prefix: { type: 'STRING', description: 'Filter path awalan (opsional).' }
    }, required: [] } },
  { name: 'delete_from_storage',
    description: 'Hapus satu file dari AI STORAGE milikmu. Batas: 500 file / 8MB total.',
    parameters: { type: 'OBJECT', properties: {
      path: { type: 'STRING', description: 'Path file yang dihapus.' }
    }, required: ['path'] } },
  { name: 'clone_repo',
    description: 'Salin (clone) seluruh isi repo GitHub ke folder workspace proyek aktif — data tersimpan permanen di workspace, lalu bisa diubah, dicari, di-deploy, atau di-push. Mendukung repo publik (tanpa perlu login GitHub) dan repo privat milik user (lewat konektor GitHub yang sudah terhubung di menu Integrasi). Batas: ±300 file teks per clone, file ≤256KB, binary besar dilewati otomatis. Pakai saat user minta "ambil/clone/copy repo X" atau "masukin kode dari repo X".',
    parameters: { type: 'OBJECT', properties: {
      repo: { type: 'STRING', description: 'Repo dalam bentuk "owner/nama" atau URL GitHub lengkap, contoh "tailwindlabs/heroicons".' },
      folder: { type: 'STRING', description: 'Folder tujuan di workspace (opsional, default: nama repo).' },
      ref: { type: 'STRING', description: 'Branch/tag/commit (opsional, default: branch utama repo).' },
      target: { type: 'STRING', description: '"workspace" (default: folder proyek aktif) atau "storage" (AI Storage milik AI, per akun — hemat token, tidak memakan kuota workspace).' }
    }, required: ['repo'] } },
  { name: 'push_to_github',
    description: 'Push SEMUA file workspace proyek aktif ke repo GitHub user lewat konektor GitHub (commit file demi file via contents API, update otomatis bila file sudah ada). Repo bisa dibuat dulu lewat github_request (POST /user/repos body {name}) bila belum ada. Gunakan saat user minta "push/simpan/kirim kode ke GitHub saya".',
    parameters: { type: 'OBJECT', properties: {
      repo: { type: 'STRING', description: 'Repo tujuan "owner/nama" atau URL GitHub lengkap.' },
      branch: { type: 'STRING', description: 'Branch tujuan (opsional, default "main"). Repo harus sudah punya branch ini.' },
      commit_message: { type: 'STRING', description: 'Pesan commit (opsional).' }
    }, required: ['repo'] } },
  // ===== TOOLS BACKEND FUNCTION (dieksekusi otomatis di server) =====
  { name: 'create_backend_function',
    description: 'Buat backend function baru milik user (ala platform builder): tulis kode -> terpasang -> bisa dipanggil via URL /api/fn/<nama>. Kode adalah badan fungsi async dengan parameter `args` (objek), boleh pakai `fetch`, `JSON`, dan `db` (DATABASE BAWAAN: await db.get(k), db.set(k,v), db.del(k), db.list(prefix), db.count() — data bertahan permanen, kuota mengikuti paket langganan). WAJIB return nilai. Contoh kode: "await db.set(args.id, args); return { ok: true }". BATAS RUNTIME: eksekusi maksimal 14 detik per panggilan (lebih dari itu = timeout). Tiap db.get/db.set adalah network call yang lambat: DILARANG loop berurutan lebih dari 20 get dalam satu function — gunakan db.list(prefix) untuk membaca banyak data sekaligus, dan simpan index/agregat saat menulis data agar laporan cukup membaca 1-2 kunci saja. Untuk WEBHOOK PUBLIK (callback payment gateway Midtrans/Xendit/Tripay, layanan eksternal): set is_public true — respons berisi webhook_url berisi key rahasia yang WAJIB diberikan ke user untuk dipasang di dashboard gateway. Gunakan saat user minta API endpoint, webhook, payment backend, integrasi data, atau logika backend.',
    parameters: { type: 'OBJECT', properties: {
      name: { type: 'STRING', description: 'Nama function: huruf kecil/angka/garis tengah, 2-40 karakter, contoh: "payment-webhook".' },
      description: { type: 'STRING', description: 'Deskripsi singkat kegunaan function (bahasa Indonesia).' },
      code: { type: 'STRING', description: 'Badan fungsi async JavaScript (bukan deklarasi function). Parameter `args` objek input. Tersedia fetch, JSON, db. Wajib return nilai.' },
      is_public: { type: 'BOOLEAN', description: 'true jika function harus bisa dipanggil TANPA login sebagai webhook publik (callback gateway, integrasi eksternal). Respons berisi webhook_url + key rahasia.' }
    }, required: ['name', 'code'] } },
  { name: 'list_backend_functions',
    description: 'Lihat semua backend function milik user beserta URL pemanggilannya.',
    parameters: { type: 'OBJECT', properties: {} } },
  { name: 'delete_backend_function',
    description: 'Hapus backend function milik user. Konfirmasi dulu ke user sebelum menghapus.',
    parameters: { type: 'OBJECT', properties: { name: { type: 'STRING', description: 'Nama function yang dihapus.' } }, required: ['name'] } },
  { name: 'call_backend_function',
    description: 'Jalankan backend function milik user dengan args tertentu dan kembalikan hasilnya. Gunakan untuk menguji function yang baru dibuat.',
    parameters: { type: 'OBJECT', properties: {
      name: { type: 'STRING', description: 'Nama function.' },
      args: { type: 'OBJECT', description: 'Objek argumen input untuk function, contoh: {"url": "https://contoh.com"}.' }
    }, required: ['name'] } },
  // ===== TOOLS BROWSER/SCREENSHOT (dieksekusi otomatis di server) =====
  { name: 'review_code',
    description: 'Periksa SEMUA kode proyek di workspace untuk menemukan error, bug, kelemahan keamanan, dan masalah logika — laporan per file dengan saran perbaikan. Gunakan saat user minta cek/review/debug/cari bug kode proyek.',
    parameters: { type: 'OBJECT', properties: { question: { type: 'STRING', description: 'Fokus review khusus (opsional), contoh: "kenapa tombol simpan tidak berfungsi".' } } } },
  { name: 'take_screenshot',
    description: 'Ambil screenshot halaman web dari sebuah URL dan kembalikan LINK gambar pratinjau yang bisa dibagikan ke user. Gunakan saat user minta screenshot/preview situs, baik situs user maupun situs lain.',
    parameters: { type: 'OBJECT', properties: {
      url: { type: 'STRING', description: 'URL lengkap halaman, contoh: "https://contoh.com".' },
      width: { type: 'NUMBER', description: 'Lebar gambar 400-1600 px. Default 1200.' }
    }, required: ['url'] } }
];

async function fetchGemini(apiKey, model, systemInstruction, contents, tools) {
  const payload = { contents };
  if (tools) payload.tools = tools;
  if (systemInstruction) payload.systemInstruction = { parts: [{ text: systemInstruction }] };
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    await res.text().catch(() => ''); // buang body error mentah, jangan pernah diteruskan ke user
    const reason = res.status === 429 ? 'limit tercapai' : (res.status >= 500 ? 'server bermasalah' : 'gagal (' + res.status + ')');
    // jangan sertakan nama model di teks error: ini yang bocor ke UI chat.
    return { error: `AI sedang ${reason}`, status: res.status };
  }
  return { data: await res.json() };
}

// STREAMING SSE: jawaban dikirim ke klien per potongan (delta) begitu keluar dari
// model — user melihat teks tumbuh live, tidak menunggu jawaban utuh selesai.
// Bagian parts dari semua chunk SSE digabung jadi satu respons berbentuk sama
// dengan fetchGemini, jadi logika tryModels (tool_calls dsb.) tak berubah.
async function fetchGeminiStream(apiKey, model, systemInstruction, contents, tools, onDelta) {
  const payload = { contents };
  if (tools) payload.tools = tools;
  if (systemInstruction) payload.systemInstruction = { parts: [{ text: systemInstruction }] };
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    await res.text().catch(() => {});
    const reason = res.status === 429 ? 'limit tercapai' : (res.status >= 500 ? 'server bermasalah' : 'gagal (' + res.status + ')');
    // jangan sertakan nama model di teks error: ini yang bocor ke UI chat.
    return { error: `AI sedang ${reason}`, status: res.status };
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const parts = [];
  let finishReason = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      let j; try { j = JSON.parse(line.slice(5).trim()); } catch (e) { continue; }
      if (j.candidates && j.candidates[0] && j.candidates[0].finishReason) finishReason = j.candidates[0].finishReason;
      const cps = (j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts) || [];
      for (const pt of cps) {
        parts.push(pt);
        if (pt.text && onDelta) { try { onDelta(pt.text); } catch (eD) {} }
      }
    }
  }
  return { data: { candidates: [{ content: { parts }, finishReason }] } };
}

async function tryModels(apiKeys, systemInstruction, contents, tools, onDelta) {
  const keys = Array.isArray(apiKeys) ? apiKeys.filter(Boolean) : [apiKeys].filter(Boolean);
  let lastError = null;
  const statuses = [];
  for (const apiKey of keys) {
  for (const model of PREFERRED_MODELS) {
    try {
      const r = onDelta ? await fetchGeminiStream(apiKey, model, systemInstruction, contents, tools, onDelta) : await fetchGemini(apiKey, model, systemInstruction, contents, tools);
      if (r.error) {
        lastError = r.error; statuses.push(r.status || 0);
        if (r.status === 400 || r.status === 403) break; // kunci invalid/denied -> coba kunci berikutnya
        continue;
      }
      const parts = r.data?.candidates?.[0]?.content?.parts || [];
      let text = parts.map(p => p.text || '').join('');
      const toolCalls = parts
        .filter(p => p.functionCall)
        .map(p => ({ name: p.functionCall.name, args: p.functionCall.args || {}, thought_signature: p.thoughtSignature || undefined }));
      // ===== AUTO-CONTINUE (finishReason MAX_TOKENS / LENGTH) =====
      // Konsep sama dengan jalur GLM: output terpotong batas token -> sistem
      // otomatis kirim "lanjutkan" + state terakhir (teks parsial menempel
      // sebagai pesan model), tanpa sesi baru, model menyambung dari titik henti.
      // Maksimal 3 sambungan per jawaban. Delta sambungan ikut ter-stream.
      if (!toolCalls.length && text) {
        let finish = r.data?.candidates?.[0]?.finishReason || '';
        let seg = text;
        const contContents = contents.slice();
        for (let ac = 0; ac < 3 && (finish === 'MAX_TOKENS' || finish === 'LENGTH'); ac++) {
          contContents.push({ role: 'model', parts: [{ text: seg }] });
          contContents.push({ role: 'user', parts: [{ text: 'lanjutkan persis dari titik terakhirmu — jangan ulang dari awal, jangan bertanya, langsung sambung teksnya' }] });
          const rc = onDelta ? await fetchGeminiStream(apiKey, model, systemInstruction, contContents, tools, onDelta) : await fetchGemini(apiKey, model, systemInstruction, contContents, tools);
          if (rc.error) break;
          const pc = rc.data?.candidates?.[0]?.content?.parts || [];
          const tc2 = pc.filter(p => p.functionCall).map(p => ({ name: p.functionCall.name, args: p.functionCall.args || {}, thought_signature: p.thoughtSignature || undefined }));
          if (tc2.length) break; // sambungan minta tool -> serahkan ke alur hop biasa
          const t2 = pc.map(p => p.text || '').join('');
          if (!t2) break;
          seg = t2; text += t2;
          finish = rc.data?.candidates?.[0]?.finishReason || '';
        }
      }
      if (toolCalls.length > 0) return { tool_calls: toolCalls, text, model };
      if (text) return { text, model };
      lastError = 'Jawaban AI kosong — coba kirim ulang';
      statuses.push(0);
    } catch (err) {
      lastError = err.message;
      statuses.push(0);
    }
  }
  }
  const quotaExhausted = statuses.length > 0 && statuses.every(st => st === 429);
  // providerBusy: SEMUA model/kunci provider menolak 429 -> sibuknya SERVER AI,
  // BUKAN kuota user. Dikirim sebagai provider_busy agar klien TIDAK menampilkan
  // pesan "kuota habis/upgrade paket" yang menyesatkan (kasus: kirim gambar ->
  // kunci Gemini kena 429 -> user dikira kehabisan kuota).
  // Konteks percakapan ke-limiter (chat panjang + kode file besar): model menolak
  // karena token melebihi jendela context. Ditandai supaya klien bisa menampilkan
  // checkpoint "lanjut?" + memangkas riwayat besar secara otomatis sebelum kirim ulang.
  const RE_CTX = /(exceeds?.{0,40}(context|token)|context.{0,40}(length|window|size)|too many (input )?tokens|maximum.{0,30}tokens|token count|input too large|payload too large|request entity too large)/i;
  const contextOverflow = !!lastError && RE_CTX.test(String(lastError));
  return { error: lastError || 'All models failed', quotaExhausted, providerBusy: quotaExhausted, contextOverflow, statuses };
}

// --- Kuota guest (tanpa login): per-IP per-hari, tabel sama dengan kuota user ---
const GUEST_DAILY_LIMIT = 25;
async function guestQuotaCheck(env, guestKey) {
  const day = new Date().toISOString().slice(0, 10);
  try {
    await env.DB.prepare('CREATE TABLE IF NOT EXISTS ai_quota (user_key TEXT, day TEXT, count INTEGER, PRIMARY KEY (user_key, day))').run();
    const r = await env.DB.prepare('SELECT count FROM ai_quota WHERE user_key = ? AND day = ?').bind(guestKey, day).first();
    const used = (r && r.count) || 0;
    if (used + 1 > GUEST_DAILY_LIMIT) {
      return { exceeded: true, scope: 'daily', count: used, message: 'Kuota AI Clincoo tanpa login untuk hari ini sudah habis. Masuk atau daftar gratis untuk kuota penuh — atau coba lagi besok.' };
    }
    await env.DB.prepare('INSERT INTO ai_quota (user_key, day, count) VALUES (?, ?, 1) ON CONFLICT(user_key, day) DO UPDATE SET count = count + 1').bind(guestKey, day).run();
    return { exceeded: false, count: used + 1 };
  } catch (e) {
    return { exceeded: false, count: 0 }; // DB gangguan -> jangan blokir chat
  }
}

// ===== TOOLS SERVER-SIDE (backend function & screenshot) =====
// Tool ini dieksekusi DI SERVER (bukan di browser user): hasil langsung
// ditempel ke percakapan dan provider dipanggil lagi — user/frontend tidak berubah.
const SERVER_TOOLS = new Set(['create_backend_function', 'list_backend_functions', 'delete_backend_function', 'call_backend_function', 'take_screenshot', 'search_clinqoo_kb', 'create_automation', 'install_automation', 'save_to_storage', 'read_storage_file', 'list_storage', 'delete_from_storage']);
async function executeServerTool(env, user, tc, origin) {
  // create_automation = nama lama/alias dari install_automation (deklarasi duplikat
  // di TOOLS) — satukan di sini supaya tidak jatuh ke klien sebagai tool tak dikenal.
  if (tc && tc.name === 'create_automation') tc = Object.assign({}, tc, { name: 'install_automation' });
  const a = tc.args || {};
  // Tool yang menempel ke akun: guest (tanpa login) tidak bisa memakainya.
  if (!user && ['create_backend_function', 'list_backend_functions', 'delete_backend_function', 'call_backend_function', 'install_automation', 'save_to_storage', 'read_storage_file', 'list_storage', 'delete_from_storage'].indexOf(tc.name) !== -1) {
    return { error: 'Fitur ini memerlukan login Clincoo (gratis).' };
  }
  try {
    if (tc.name === 'search_clinqoo_kb') {
      return await searchClincooBlog(env, a.query || '');
    }
    if (tc.name === 'install_automation') {
      const st = await import('./scheduled-tasks.js');
      return await st.createScheduledTask(env.DB, user, a);
    }
    if (tc.name === 'save_to_storage') return await aiStorageSave(env.DB, user, a.files || []);
    if (tc.name === 'read_storage_file') return await aiStorageGet(env.DB, user, a.path || '');
    if (tc.name === 'list_storage') return await aiStorageList(env.DB, user, a.prefix || '');
    if (tc.name === 'delete_from_storage') return await aiStorageDelete(env.DB, user, a.path || '');
    if (tc.name === 'take_screenshot') {
      const m = await import('./screenshot.js');
      return await m.takeScreenshot(a.url, a.width);
    }
    const m = await import('./fns.js');
    if (tc.name === 'create_backend_function') return await m.createFunction(env.DB, user.key, a.name, a.description, a.code, { is_public: !!a.is_public, origin: origin || '' });
    if (tc.name === 'list_backend_functions') return await m.listFunctions(env.DB, user.key, origin || '');
    if (tc.name === 'delete_backend_function') return await m.deleteFunction(env.DB, user.key, a.name);
    if (tc.name === 'call_backend_function') return await m.invokeFunction(env.DB, user.key, a.name, a.args, { origin: origin || '' });
    return { error: 'Tool server tidak dikenal: ' + tc.name };
  } catch (e) {
    return { error: 'Gagal mengeksekusi tool server: ' + (e && e.message) };
  }
}

// Skema Gemini (OBJECT/STRING uppercase) -> JSON Schema OpenAI (lowercase)
function orParam(schema) {
  const t = String((schema && schema.type) || '').toLowerCase();
  const out = { type: t === 'array' ? 'array' : t === 'boolean' ? 'boolean' : t === 'number' ? 'number' : t === 'object' ? 'object' : 'string' };
  if (schema && schema.description) out.description = schema.description;
  if (schema && schema.properties) {
    out.properties = {};
    for (const [k, v] of Object.entries(schema.properties)) out.properties[k] = orParam(v);
  }
  if (schema && Array.isArray(schema.required)) out.required = schema.required;
  if (schema && schema.items) out.items = orParam(schema.items); // ARRAY of objects (write_files)
  return out;
}
// Tools tahap membangun: menulis + MEMBACA workspace (list/read dijalankan server-side
// dari D1) agar programmer bisa melihat & mengedit file lama secara akurat.
const BUILD_FUNCTION_DECLARATIONS = WORKSPACE_FUNCTION_DECLARATIONS.filter(d => ['write_file', 'create_folder', 'read_file', 'list_items'].includes(d.name));
function orBuildTools() {
  return BUILD_FUNCTION_DECLARATIONS.map(d => ({
    type: 'function',
    function: { name: d.name, description: d.description || '', parameters: orParam(d.parameters || { type: 'OBJECT', properties: {} }) }
  }));
}
// Tools yang diekspos ke model = tools workspace saja (fitur Mode Kolaborasi/Tim AI dihapus).
function workspaceDecls(_body) {
  return WORKSPACE_FUNCTION_DECLARATIONS;
}
// messages klien (format blok Clincoo) -> pesan OpenAI-compatible

// GET /api/chat — status kredit AI akun ini (dipakai UI: ClincooPay top-up + banner kredit habis)
// read-only, TIDAK memakai/mengurangi kuota atau kredit paket (beda dari quotaCheck yg dipanggil saat kirim pesan).
export async function onRequestGet({ request, env }) {
  try {
    const user = await resolveUser(env, request);
    if (!user) {
      return new Response(JSON.stringify({ error: 'Login diperlukan', need_login: true }), {
        status: 401, headers: { 'Content-Type': 'application/json', ...CORS }
      });
    }
    const limits = await aiLimits(env, user);
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    const month = now.toISOString().slice(0, 7);
    let dayUsed = 0, monthUsed = 0;
    try {
      await env.DB.prepare(
        'CREATE TABLE IF NOT EXISTS ai_quota (user_key TEXT, day TEXT, count INTEGER, PRIMARY KEY (user_key, day))'
      ).run();
      const rows = await env.DB.prepare('SELECT day, count FROM ai_quota WHERE user_key = ? AND day IN (?, ?)').bind(user.key, day, month).all();
      for (const r of rows.results || []) {
        if (r.day === day) dayUsed = r.count;
        if (r.day === month) monthUsed = r.count;
      }
    } catch (e) {}
    let creditsLeftTotal = 0;
    try {
      const active = await getActivePacks(env.DB, user.key);
      creditsLeftTotal = active.reduce((s, p) => s + (p.credits_left || 0), 0);
    } catch (e) {}
    const subscriptionExhausted = monthUsed >= limits.monthly || dayUsed >= limits.daily;
    const exhausted = subscriptionExhausted && creditsLeftTotal <= 0;
    return new Response(JSON.stringify({
      success: true,
      limit: limits.daily, used: dayUsed, remaining: Math.max(0, limits.daily - dayUsed), day,
      monthly_limit: limits.monthly, monthly_used: monthUsed,
      credits_left_total: creditsLeftTotal,
      exhausted,
      scope: exhausted ? (monthUsed >= limits.monthly ? 'monthly' : 'daily') : null,
      message: exhausted ? (monthUsed >= limits.monthly ? QUOTA_MSG_MONTHLY : QUOTA_MSG_DAILY) : null
    }), {
      headers: { 'Content-Type': 'application/json', ...CORS }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500, headers: { 'Content-Type': 'application/json', ...CORS }
    });
  }
}

// Teks progres real-time — diturunkan dari aksi tool yang DIPILIH AI SENDIRI
// (nama tool + argumennya), bukan daftar status palsu yang berputar.
// Server-side progress text (English -- professional, consistent with client side)
function serverProgressText(tc) {
  const a = tc.args || {};
  if (tc.name === 'search_clinqoo_kb') return 'Searching Clincoo knowledge base: ' + String(a.query || '').slice(0, 60) + '…';
  if (tc.name === 'install_automation') return 'Memasang otomatisasi: ' + String(a.name || '') + '…';
  if (tc.name === 'manage_domain') return 'Mengatur domain: ' + String(a.action || '') + (a.domain ? ' ' + a.domain : '') + '…';
  if (tc.name === 'write_files') return 'Menulis ' + (Array.isArray(a.files) ? a.files.length : '?') + ' file sekaligus…';
  if (tc.name === 'clone_repo') return 'Menyalin repo: ' + String(a.repo || '') + '…';
  if (tc.name === 'push_to_github') return 'Push ke GitHub: ' + String(a.repo || '') + '…';
  if (tc.name === 'save_to_storage') return 'Menyimpan ' + (Array.isArray(a.files) ? a.files.length : '?') + ' file ke AI Storage…';
  if (tc.name === 'read_storage_file') return 'Membaca dari storage: ' + String(a.path || '') + '…';
  if (tc.name === 'list_storage') return 'Melihat isi AI Storage…';
  if (tc.name === 'delete_from_storage') return 'Menghapus dari storage: ' + String(a.path || '') + '…';
  if (tc.name === 'take_screenshot') return 'Taking a screenshot of the site…';
  if (tc.name === 'create_backend_function') return 'Creating backend function: ' + String(a.name || '') + '…';
  if (tc.name === 'call_backend_function') return 'Running backend function: ' + String(a.name || '') + '…';
  if (tc.name === 'list_backend_functions') return 'Listing backend functions…';
  if (tc.name === 'delete_backend_function') return 'Deleting backend function: ' + String(a.name || '') + '…';
  return 'Processing: ' + tc.name + '…';
}

export async function onRequestPost({ request, env, waitUntil }) {
  try {
    if (!rateLimitOk(clientIp(request))) {
      return new Response(JSON.stringify({ error: 'Terlalu banyak permintaan. Coba lagi dalam 1 menit.' }), {
        status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': '60', ...CORS }
      });
    }

    // Batasi ukuran body maksimal 2 MB (anti abuse attachment base64 raksasa)
    const raw = await request.text();
    if (raw.length > 2_000_000) {
      return new Response(JSON.stringify({ error: 'Payload terlalu besar (maks 2MB).' }), {
        status: 413, headers: { 'Content-Type': 'application/json', ...CORS }
      });
    }
    const body = JSON.parse(raw);

    // Aksi manajemen sesi — stateless (riwayat di localStorage klien), cukup ACK
    const action = body.action || 'send';
    if (action === 'delete_session') {
      return new Response(JSON.stringify({ success: true }), {
        headers: { 'Content-Type': 'application/json', ...CORS }
      });
    }
    if (action === 'new_session') {
      return new Response(JSON.stringify({ session_id: body.session_id || ('ls_' + Date.now()), title: body.title || 'Percakapan Baru' }), {
        headers: { 'Content-Type': 'application/json', ...CORS }
      });
    }

    // --- Auth per-user ---
    // MODE TANPA LOGIN (guest): chat tetap jalan tanpa akun (auth frontend memang
    // sudah dilepas). Identitas guest = IP; kuota harian per-IP (tabel ai_quota,
    // kunci 'g:'+IP, sama seperti kuota user). Login tetap dapat kuota paket penuh.
    const user = await resolveUser(env, request);
    const isGuest = !user;
    const guestKey = 'g:' + clientIp(request);

    let messages = Array.isArray(body.messages) ? body.messages : [];
    // Mode biasa: pastikan selalu ada system prompt (klien biasanya mengirim sendiri)
    if (!messages.some(m => m && m.role === 'system')) {
      messages = [{ role: 'system', content: SINGLE_SYSTEM_PROMPT }, ...messages];
    }
    // Mode fallback (body.message tanpa array messages): pesan user WAJIB ikut
    // masuk. Bug lama: pesan user dibuang (request hanya berisi system prompt,
    // model menjawab ngawur karena tidak tahu pertanyaannya).
    if (!messages.some(m => m && m.role === 'user')) {
      const fallback = typeof body.content === 'string' ? body.content
        : (typeof body.message === 'string' ? body.message : '');
      if (fallback) messages.push({ role: 'user', content: fallback });
    }
    if (messages.length === 0) {
      return new Response(JSON.stringify({ error: 'Pesan kosong' }), {
        status: 400, headers: { 'Content-Type': 'application/json', ...CORS }
      });
    }

    // --- Kuota: hanya pesan asli (hop 0). Hop tool lanjutan tidak dihitung ---
    // Hop tool lanjutan tidak dihitung.
    const isFirstHop = body.save_user_message !== false;
    if (isFirstHop) {
      const q = isGuest ? await guestQuotaCheck(env, guestKey) : await quotaCheck(env, user, 1);
      if (q.exceeded) {
        return new Response(JSON.stringify({ quota_exhausted: true, error: q.message || QUOTA_MSG_MONTHLY, scope: q.scope, limit: q.limit, used: q.count }), {
          status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': '3600', ...CORS }
        });
      }
    }

    const apiKey = await getGeminiKeys(env); // array kunci Gemini (cadangan + jalur vision)
    const orKeysEarly = await getOpenRouterKeys(env); // kunci OpenRouter (GLM 5.3 — utama)

    if (!orKeysEarly.length && !apiKey.length && !env.AI) {
      return new Response(JSON.stringify({ error: 'Kunci AI belum dikonfigurasi. Tambahkan lewat Pengaturan → Environment (global).' }), {
        status: 500, headers: { 'Content-Type': 'application/json', ...CORS }
      });
    }

    // Mode streaming progres (NDJSON): klien minta status real-time.
    // Urutan baris: {"t":"thinking"} -> {"t":"progress","text":...} -> {"t":"final",...}
    // atau {"t":"error",...}. Klien lama (tanpa stream:true) tetap dapat JSON biasa.
    // PENTING (runtime Workers): JANGAN menunggu write/close stream sebelum
    // Response dikembalikan — worker akan hang (error 1101). Response stream
    // dikirim SEKARANG, pemrosesan chat berjalan di belakang (waitUntil).
    const useStream = body.stream === true;
    let streamWriter = null, streamSend = null, streamReadable = null;
    if (useStream) {
      const ts = new TransformStream();
      streamReadable = ts.readable;
      streamWriter = ts.writable.getWriter();
      const enc = new TextEncoder();
      streamSend = (obj) => streamWriter.write(enc.encode(JSON.stringify(obj) + '\n')).catch(() => {});
    }

    const processChat = async () => {
    if (streamSend) streamSend({ t: 'thinking' });
    // Mode workspace tools.
    // Jalur Gemini: HANYA functionDeclarations (tanpa google_search — kombinasi
    // keduanya ditolak Gemini API dan memicu bug JSON palsu).
    const decls = workspaceDecls(body);
    const gTools = body.workspace_tools === true
      ? [{ functionDeclarations: decls }]
      : null;

    // Payload bergambar -> hanya Gemini (Workers AI tidak support vision).
    const hasImages = messages.some(m => Array.isArray(m?.content) && m.content.some(b => b && b.type === 'image_url' && b.image_url?.url));

    // AI UTAMA: GLM 5.3 Flash (Workers AI, binding internal — tanpa kunci/kuota Google).
    // Gemini menjadi CADANGAN (jalur vision + fallback klasik). Chat bergambar tetap
    // langsung Gemini karena Workers AI tidak support vision.
    // TOOLS SERVER (backend function & screenshot) dieksekusi di sini: hasil
    // ditempel ke pesan lalu provider dipanggil lagi (max 4 hop server) —
    // jalur klien (frontend) tidak berubah sama sekali.
    let r = null;
    const workMessages = messages; // array sama — kita append blok function_call/response
    const orKeys = orKeysEarly; // GLM 5.3 Flash (OpenRouter) — UTAMA
    const aiMain = !!(env.AI && !hasImages);
    const toolDecls = (gTools && gTools[0] && gTools[0].functionDeclarations) || null;
    for (let sHop = 0; sHop <= 4; sHop++) {
      r = null;
      if (orKeys.length && !hasImages) {
        const o = await tryOpenRouterText(orKeys, workMessages, toolDecls);
        if (o) r = o;
      }
      if ((!r || r.error) && aiMain) {
        const w = await tryWorkersAIText(env, workMessages, toolDecls);
        if (w) r = w;
      }
      if ((!r || r.error) && apiKey.length) {
        const { systemInstruction, contents } = toGeminiPayload(workMessages);
        r = await tryModels(apiKey, systemInstruction, contents, gTools, streamSend ? (chunkText) => streamSend({ t: 'delta', text: chunkText }) : null);
      }
      // Fallback terakhir (dipakai bila GLM utama dilewati, mis. chat bergambar): teks saja
      if ((!r || r.error) && env.AI && !hasImages && !aiMain) {
        const w = await tryWorkersAIText(env, workMessages, toolDecls);
        if (w) r = w;
      }
      if (!r || r.error) break; // error/kutipan ditangani di bawah seperti biasa
      const stCalls = (r.tool_calls || []).filter(tc => SERVER_TOOLS.has(tc.name));
      if (!stCalls.length) break; // jawaban final ATAU tools klien -> keluar, kirim ke klien
      const clientCalls = (r.tool_calls || []).filter(tc => !SERVER_TOOLS.has(tc.name));
      const results = [];
      for (const tc of stCalls) {
        if (streamSend) streamSend({ t: 'progress', text: serverProgressText(tc) });
        results.push(await executeServerTool(env, user, tc, new URL(request.url).origin));
      }
      // catat pemanggilan & hasil ke percakapan (format blok sama seperti klien)
      workMessages.push({ role: 'assistant', content: (r.tool_calls || []).map(tc => ({ type: 'function_call', name: tc.name, args: tc.args || {}, thought_signature: tc.thought_signature || undefined })) });
      workMessages.push({ role: 'user', content: stCalls.map((tc, i) => ({ type: 'function_response', name: tc.name, result: results[i] })) });
      // SELALU tempel result ke r.tool_calls (bukan hanya saat campuran dgn tool klien) —
      // supaya kalau loop hop-server ini kehabisan budget (sHop sampai batas) dan
      // r.tool_calls dikirim ke klien apa adanya, klien tidak coba eksekusi ULANG
      // tool server (yang klien tidak punya case-nya) dan gagal "Tool tidak dikenal".
      r.tool_calls = r.tool_calls.map(tc => {
        const i = stCalls.indexOf(tc);
        return i !== -1 ? Object.assign({}, tc, { result: results[i] }) : tc;
      });
      if (clientCalls.length) break; // tool klien tetap dieksekusi klien seperti biasa
      // semua tool server -> minta giliran model berikutnya (lanjut loop)
    }
    if (r && !r.error && !String(r.text || '').trim() && !(r.tool_calls && r.tool_calls.length)) {
      const sumMsgs = workMessages.concat([{ role: 'user', content: 'Semua tool sudah selesai dieksekusi dan seluruh hasilnya tercatat di percakapan. Sekarang tulis RINGKASAN FINAL untuk user dalam Bahasa Indonesia: apa yang sudah dikerjakan, status/hasilnya, URL endpoint bila ada, dan contoh pemakaian singkat. Jangan memanggil tool apa pun — langsung tulis jawabannya sekarang.' }]);
      if (orKeys.length && !hasImages) {
        const sm = await tryOpenRouterText(orKeys, sumMsgs, null);
        if (sm && !sm.error && String(sm.text || '').trim()) r = { text: sm.text, model: sm.model };
      }
      if (!String(r.text || '').trim() && aiMain) {
        const sw = await tryWorkersAIText(env, sumMsgs, null);
        if (sw && !sw.error && String(sw.text || '').trim()) r = { text: sw.text, model: sw.model };
      }
    }
    if (!r || (r.error && !apiKey.length && !env.AI)) {
      if (!r) r = { error: 'Tidak ada provider AI tersedia' };
    }

    if (streamSend) {
      if (r && !r.error) streamSend({ t: 'progress', text: 'Composing answer…' });
      if (r && r.error) {
        // quota_exhausted di jalur stream = SEMUA model provider 429 (bukan kuota user):
        // kirim pesan bersih tanpa nama model — sama seperti jalur non-stream di bawah.
        const busy = !!r.quotaExhausted; // 429 semua model -> sibuk provider
        const errText = busy
          ? 'Server AI sedang sibuk (limit provider). Coba lagi sebentar lagi.'
          : r.error;
        streamSend({ t: 'error', error: errText, provider_busy: busy ? true : undefined, quota_exhausted: busy ? undefined : !!r.quotaExhausted, context_overflow: !!r.contextOverflow });
      } else {
        const outS = {
          text: r.text || '',
          model: r.model,
          session_id: body.session_id || ('ls_' + Date.now())
        };
        if (r.tool_calls) outS.tool_calls = r.tool_calls;
        streamSend({ t: 'final', ...outS });
      }
      streamWriter.close().catch(() => {}); // TANPA await: antrean writer sudah berurutan
      return; // mode stream: respons sudah terkirim sejak awal
    }

    if (r.error && r.quotaExhausted) {
      // sibuknya provider, bukan kuota user: 503 + provider_busy supaya klien
      // tidak mengunci komposer / menawarkan upgrade paket.
      // 429 TANPA quota_exhausted: frontend tidak retry (bukan transient baginya)
      // dan tidak mengunci komposer — langsung fallback /api/ai lalu bubble error jujur.
      return new Response(JSON.stringify({ provider_busy: true, error: 'Server AI sedang sibuk (limit provider). Coba lagi sebentar lagi.' }), {
        status: 429, headers: { 'Content-Type': 'application/json', ...CORS }
      });
    }
    if (r.error && r.contextOverflow) {
      return new Response(JSON.stringify({ context_overflow: true, error: 'Konteks percakapan penuh (terlalu banyak kode besar dalam satu chat). Balas "lanjut" untuk meneruskan tugas dengan riwayat yang dipangkas otomatis.' }), {
        status: 429, headers: { 'Content-Type': 'application/json', ...CORS }
      });
    }
    if (r.error) {
      return new Response(JSON.stringify({ error: r.error }), {
        status: 502, headers: { 'Content-Type': 'application/json', ...CORS }
      });
    }

    const out = {
      text: r.text || '',
      model: r.model,
      session_id: body.session_id || ('ls_' + Date.now())
    };
    if (r.tool_calls) out.tool_calls = r.tool_calls;
    return new Response(JSON.stringify(out), {
      headers: { 'Content-Type': 'application/json', ...CORS }
    });
    }; // akhir processChat

    if (useStream) {
      const p = processChat().catch((e) => {
        if (streamSend) streamSend({ t: 'error', error: 'Server error: ' + ((e && e.message) || e) });
        if (streamWriter) streamWriter.close().catch(() => {});
      });
      if (waitUntil) waitUntil(p);
      return new Response(streamReadable, {
        headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-cache', ...CORS }
      });
    }
    return await processChat();
  } catch (err) {
    return new Response(JSON.stringify({ error: 'Server error: ' + err.message }), {
      status: 500, headers: { 'Content-Type': 'application/json', ...CORS }
    });
  }
}
