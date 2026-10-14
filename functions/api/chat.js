// Clincoo Chat API (Mode Polos / Clean untuk Pengetesan)
// Catatan: chat.js lama disimpan di functions/api/chat.old.js

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-labs-relay',
};

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestGet({ request, env }) {
  return new Response(JSON.stringify({ status: 'ok', mode: 'simple-test', message: 'Chat API (mode polos) aktif' }), {
    headers: { 'Content-Type': 'application/json', ...CORS }
  });
}

const SYSTEM_PROMPT = `Kamu adalah asisten AI Clincoo, platform pembuatan website dan aplikasi web modern.
Bantu pengguna dengan ramah, cepat, dan profesional dalam Bahasa Indonesia.

Aturan Mode:
1. Jika pengguna meminta membuat atau memodifikasi website atau file, gunakan tools yang tersedia (seperti write_file, edit_file, list_items, read_file) untuk menulis file secara langsung di workspace proyek. Jangan menulis kode panjang sebagai teks biasa jika tools tersedia; langsung panggil tool write_file.
2. Jika hanya mengobrol, bertanya konsep, atau sapaan biasa, jawab langsung secara ringkas, jelas, dan natural tanpa memanggil tool.`;

const OAI_TOOLS = [
  {
    "type": "function",
    "function": {
      "name": "list_items",
      "description": "Lihat daftar file & folder di dalam sebuah folder workspace Clincoo milik user. Gunakan ini untuk melihat isi workspace atau folder sebelum melakukan operasi lain.",
      "parameters": {
        "type": "object",
        "properties": {
          "path": {
            "type": "string",
            "description": "Path folder. Contoh: \"root\" (folder utama), \"js\", \"root/css/style\". Default: root."
          }
        }
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "read_file",
      "description": "Baca isi lengkap sebuah file di workspace. WAJIB dipakai sebelum mengedit file agar konten terbaru dan akurat.",
      "parameters": {
        "type": "object",
        "properties": {
          "path": {
            "type": "string",
            "description": "Path file. Contoh: \"index.html\", \"js/app.js\", \"root/style.css\"."
          }
        },
        "required": [
          "path"
        ]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "write_file",
      "description": "Buat file baru di workspace atau timpa seluruh isi file yang sudah ada dengan konten baru. Folder induk dibuat otomatis jika belum ada.",
      "parameters": {
        "type": "object",
        "properties": {
          "path": {
            "type": "string",
            "description": "Path file tujuan, contoh: \"pages/about.html\"."
          },
          "content": {
            "type": "string",
            "description": "Isi lengkap file yang akan ditulis (overwrite penuh)."
          }
        },
        "required": [
          "path",
          "content"
        ]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "edit_file",
      "description": "Ubah SEBAGIAN isi file yang sudah ada via search-replace persis \u2014 WAJIB untuk revisi kecil (ganti warna/teks/ikon, ubah satu section/fungsi/class, perbaiki satu error) supaya TIDAK menulis ulang seluruh file. String search HARUS persis sama dengan isi file (salin dari hasil read_file). Beberapa patch bisa dibundel lewat edits:[{search,replace}]. Gunakan untuk file yang SUDAH ada; file baru tetap write_file.",
      "parameters": {
        "type": "object",
        "properties": {
          "path": {
            "type": "string",
            "description": "Path file yang diedit, contoh: \"css/style.css\"."
          },
          "search": {
            "type": "string",
            "description": "Teks persis dari isi file yang akan diganti."
          },
          "replace": {
            "type": "string",
            "description": "Teks pengganti."
          },
          "all": {
            "type": "boolean",
            "description": "true = ganti SEMUA kemunculan search. Default hanya yang pertama."
          },
          "edits": {
            "type": "array",
            "description": "Opsional, banyak patch sekaligus: [{search:\"...\", replace:\"...\"}].",
            "items": {
              "type": "object",
              "properties": {
                "search": {
                  "type": "string"
                },
                "replace": {
                  "type": "string"
                }
              }
            }
          }
        },
        "required": [
          "path"
        ]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "append_file",
      "description": "Tambahkan potongan isi di AKHIR file (file 50KB\u2013200KB+ sampai ~1MB dalam 1 sesi): write_file bagian pertama, lalu append_file berulang (path sama, \u00b112.000\u201320.000 karakter per panggilan). done:true HANYA di potongan TERAKHIR. Jangan henti di tengah \u2014 lanjut sampai file utuh.",
      "parameters": {
        "type": "object",
        "properties": {
          "path": {
            "type": "string",
            "description": "Path file yang sama dengan write_file pertama, contoh: \"js/app.js\"."
          },
          "content": {
            "type": "string",
            "description": "Potongan isi berikutnya, TANPA mengulang isi awal."
          },
          "done": {
            "type": "boolean",
            "description": "true kalau ini potongan terakhir."
          }
        },
        "required": [
          "path",
          "content"
        ]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "create_folder",
      "description": "Buat folder baru (beserta folder induknya) di workspace.",
      "parameters": {
        "type": "object",
        "properties": {
          "path": {
            "type": "string",
            "description": "Path folder, contoh: \"assets/img\"."
          }
        },
        "required": [
          "path"
        ]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "rename_item",
      "description": "Ubah nama file atau folder di workspace.",
      "parameters": {
        "type": "object",
        "properties": {
          "path": {
            "type": "string",
            "description": "Path item yang di-rename, contoh: \"old-name.html\"."
          },
          "new_name": {
            "type": "string",
            "description": "Nama baru (tanpa path), contoh: \"new-name.html\"."
          }
        },
        "required": [
          "path",
          "new_name"
        ]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "delete_item",
      "description": "Hapus file atau folder (beserta seluruh isinya) dari workspace. PERMANEN \u2014 konfirmasi dulu ke user kecuali user sudah jelas meminta penghapusan.",
      "parameters": {
        "type": "object",
        "properties": {
          "path": {
            "type": "string",
            "description": "Path item yang akan dihapus."
          }
        },
        "required": [
          "path"
        ]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "search_items",
      "description": "Cari file atau folder di seluruh workspace berdasarkan nama.",
      "parameters": {
        "type": "object",
        "properties": {
          "query": {
            "type": "string",
            "description": "Kata kunci nama file/folder."
          }
        },
        "required": [
          "query"
        ]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "read_web_page",
      "description": "Baca konten sebuah halaman web (URL) dan ubah jadi teks markdown yang bisa dibaca. Gunakan untuk membaca dokumentasi, artikel, atau halaman apapun yang user sebutkan.",
      "parameters": {
        "type": "object",
        "properties": {
          "url": {
            "type": "string",
            "description": "URL lengkap halaman, contoh: \"https://contoh.com/docs\"."
          }
        },
        "required": [
          "url"
        ]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "web_search",
      "description": "Cari informasi terbaru di web (search engine). Gunakan untuk pertanyaan yang butuh data real-time atau terkini: harga, berita, dokumentasi versi baru, dll.",
      "parameters": {
        "type": "object",
        "properties": {
          "query": {
            "type": "string",
            "description": "Kata kunci pencarian."
          }
        },
        "required": [
          "query"
        ]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "set_project_info",
      "description": "Simpan \"Nama Aplikasi\" & \"Deskripsi\" proyek aktif ke halaman Pengaturan Umum Clincoo (identitas yang tampil di kartu & daftar proyek). WAJIB dipanggil setelah selesai membangun situs/aplikasi baru: isi dengan nama aplikasi yang tepat dari pembahasan (BUKAN potongan awal chat) + deskripsi singkat 1 kalimat.",
      "parameters": {
        "type": "object",
        "properties": {
          "app_name": {
            "type": "string",
            "description": "Nama aplikasi yang tepat, ringkas & manusiawi (mis. \"Kedai Kopi Senja\")."
          },
          "app_desc": {
            "type": "string",
            "description": "Deskripsi singkat 1 kalimat tentang aplikasinya."
          },
          "app_logo": {
            "type": "string",
            "description": "Opsional. Nama file gambar di workspace (mis. \"logo.png\") untuk dipasang sebagai logo & favicon aplikasi di Pengaturan Umum."
          }
        },
        "required": [
          "app_name"
        ]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "generate_image",
      "description": "Buat gambar AI baru (PNG) langsung di workspace proyek \u2014 logo, ilustrasi, hero, ikon. Pakai saat user minta dibuatkan gambar/logo, atau situs butuh visual yang tidak ada di web. set_as_logo: true otomatis memasangnya sebagai logo & favicon di Pengaturan Umum.",
      "parameters": {
        "type": "object",
        "properties": {
          "prompt": {
            "type": "string",
            "description": "Deskripsi gambar yang diinginkan, detail & spesifik (subjek, gaya, warna)."
          },
          "filename": {
            "type": "string",
            "description": "Opsional. Nama file tujuan, contoh: \"images/hero.png\". Default otomatis."
          },
          "set_as_logo": {
            "type": "boolean",
            "description": "true = pasang sebagai logo aplikasi di Pengaturan Umum (jadi logo & favicon situs, aktif pada deploy berikutnya)."
          }
        },
        "required": [
          "prompt"
        ]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "deploy_project",
      "description": "Publish / deploy proyek yang sedang aktif ke internet (Cloudflare Pages) sehingga situsnya live. HANYA saat user eksplisit minta atau sudah setuju publish \u2014 setelah web selesai JANGAN deploy sendiri: arahkan ke Live preview dulu dan tanya dulu apakah mau dipublish.",
      "parameters": {
        "type": "object",
        "properties": {}
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "write_files",
      "description": "Tulis BEBERAPA file sekaligus dalam SATU panggilan (bulk write): files:[{path, content}]. WAJIB dipakai saat proyek butuh banyak file kecil-sedang sekaligus (mis. css/base.css + css/components.css + js/app.js + halaman sekunder + README.md) agar struktur proyek rapi dalam SATU putaran \u2014 jangan write_file satu per satu untuk banyak file kecil (boros giliran). Batas aman per panggilan: TOTAL isi semua file \u00b120.000 karakter, tiap file \u00b18.000 karakter, maks 10 file; kalau lebih, pecah menjadi beberapa panggilan write_files. File BESAR (HTML utuh >8.000 karakter, file 50KB+) JANGAN dimasukkan ke sini: tulis SATU per satu dengan write_file (+ append_file bila perlu). Kalau gagal dengan pesan \"Parameter files wajib array\" atau parameter kosong, itu tanda argumen terpotong: ulangi dengan file lebih sedikit/lebih pendek.",
      "parameters": {
        "type": "object",
        "properties": {
          "files": {
            "type": "array",
            "description": "Array file yang mau ditulis/salin.",
            "items": {
              "type": "object",
              "properties": {
                "path": {
                  "type": "string",
                  "description": "Path file di workspace, contoh \"assets/style.css\"."
                },
                "content": {
                  "type": "string",
                  "description": "Isi lengkap file siap jalan."
                }
              },
              "required": [
                "path",
                "content"
              ]
            }
          }
        },
        "required": [
          "files"
        ]
      }
    }
  }
];

function textOf(m) {
  if (!m) return '';
  if (typeof m.content === 'string') return m.content;
  if (Array.isArray(m.content)) {
    return m.content
      .filter(b => b && (b.type === 'text' || typeof b === 'string'))
      .map(b => (typeof b === 'string' ? b : b.text || ''))
      .join('\n');
  }
  return '';
}

function toOAIChat(messages, defaultSystem) {
  let system = defaultSystem;
  const sysMsgs = messages.filter(m => m && m.role === 'system');
  if (sysMsgs.length > 0) {
    system = sysMsgs.map(textOf).join('\n\n');
  }
  const chatMsgs = [];
  let lastCallIds = [];
  for (const m of messages) {
    if (!m || m.role === 'system') continue;
    const blocks = Array.isArray(m.content) ? m.content : null;
    const t = textOf(m);
    if (blocks && blocks.some(b => b && b.type === 'function_call')) {
      const calls = blocks.filter(b => b && b.type === 'function_call');
      lastCallIds = calls.map((b, i) => 'call_' + chatMsgs.length + '_' + i);
      chatMsgs.push({
        role: 'assistant',
        content: t || null,
        tool_calls: calls.map((b, i) => ({
          id: lastCallIds[i],
          type: 'function',
          function: { name: b.name, arguments: JSON.stringify(b.args || {}) }
        }))
      });
      continue;
    }
    if (blocks && blocks.some(b => b && b.type === 'function_response')) {
      for (const b of blocks.filter(b => b && b.type === 'function_response')) {
        let rs = '';
        try { rs = (typeof b.result === 'string') ? b.result : JSON.stringify(b.result); } catch (e) { rs = ''; }
        const tid = lastCallIds.shift();
        if (tid) chatMsgs.push({ role: 'tool', tool_call_id: tid, content: rs || ' ' });
      }
      if (t) chatMsgs.push({ role: 'user', content: t });
      continue;
    }
    if (t) chatMsgs.push({ role: m.role, content: t });
  }
  return [{ role: 'system', content: system }, ...chatMsgs];
}

async function getModelRouterKeys(env) {
  const keys = [];
  const seen = new Set();
  const add = v => { v = String(v || '').trim(); if (v && !seen.has(v)) { seen.add(v); keys.push(v); } };
  add(env.MODELROUTER_API_KEY);
  if (env.DB) {
    try {
      const rows = await env.DB.prepare("SELECT value FROM env_vars WHERE key = 'MODELROUTER_API_KEY'").all();
      for (const r of rows.results || []) add(r.value);
    } catch {}
  }
  return keys;
}

async function getOpenRouterKeys(env) {
  const keys = [];
  const seen = new Set();
  const add = v => { v = String(v || '').trim(); if (v && !seen.has(v)) { seen.add(v); keys.push(v); } };
  add(env.OPENROUTER_API_KEY);
  add(env.OPENROUTER_API_KEY_4);
  add(env.OPENROUTER_API_KEY_5);
  add(env.OPENROUTER_API_KEY_6);
  if (env.DB) {
    try {
      const rows = await env.DB.prepare("SELECT value FROM env_vars WHERE key IN ('OPENROUTER_API_KEY','OPENROUTER_API_KEY_2','OPENROUTER_API_KEY_3','OPENROUTER_API_KEY_4','OPENROUTER_API_KEY_5','OPENROUTER_API_KEY_6')").all();
      for (const r of rows.results || []) add(r.value);
    } catch {}
  }
  return keys;
}

async function getGeminiKeys(env) {
  const keys = [];
  const seen = new Set();
  const add = v => { v = String(v || '').trim(); if (v && !seen.has(v)) { seen.add(v); keys.push(v); } };
  add(env.GEMINI_API_KEY);
  add(env.GEMINI_API_KEY_4);
  if (env.DB) {
    try {
      const rows = await env.DB.prepare("SELECT value FROM env_vars WHERE key IN ('GEMINI_API_KEY','GEMINI_API_KEY_2','GEMINI_API_KEY_3','GEMINI_API_KEY_4','GEMINI_API_KEY_5','GEMINI_API_KEY_6')").all();
      for (const r of rows.results || []) add(r.value);
    } catch {}
  }
  return keys;
}

async function callOpenAICompatible({ url, key, model, messages, tools, onChunk }) {
  const isStream = typeof onChunk === 'function';
  const payload = {
    model,
    messages,
    max_tokens: 4096
  };
  if (tools && tools.length > 0) {
    payload.tools = tools;
  }
  if (isStream) {
    payload.stream = true;
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + key,
      'HTTP-Referer': 'https://clincoo.buzz',
      'X-Title': 'Clincoo'
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(60000)
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}: ${errText.slice(0, 300)}`);
  }

  if (isStream) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullText = '';
    const toolCallsAcc = [];

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newlineIdx;
      while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);
        if (!line.startsWith('data:')) continue;
        const dataStr = line.slice(5).trim();
        if (dataStr === '[DONE]') continue;
        try {
          const parsed = JSON.parse(dataStr);
          const delta = parsed.choices?.[0]?.delta;
          if (!delta) continue;
          if (delta.content) {
            fullText += delta.content;
            await onChunk(delta.content);
          }
          if (Array.isArray(delta.tool_calls)) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0;
              if (!toolCallsAcc[idx]) {
                toolCallsAcc[idx] = { id: tc.id || '', name: tc.function?.name || '', argsText: '' };
              }
              if (tc.id) toolCallsAcc[idx].id = tc.id;
              if (tc.function?.name) toolCallsAcc[idx].name = tc.function.name;
              if (tc.function?.arguments) toolCallsAcc[idx].argsText += tc.function.arguments;
            }
          }
        } catch (e) {}
      }
    }

    const toolCalls = toolCallsAcc.filter(Boolean).map(tc => {
      let args = {};
      try { args = JSON.parse(tc.argsText); } catch (e) { args = { raw: tc.argsText }; }
      return { name: tc.name, args };
    });

    return { text: fullText, tool_calls: toolCalls.length ? toolCalls : undefined };
  } else {
    const data = await res.json();
    const msg = data.choices?.[0]?.message || {};
    const text = msg.content || '';
    const rawToolCalls = msg.tool_calls || [];
    const toolCalls = rawToolCalls.map(tc => {
      let args = {};
      try { args = JSON.parse(tc.function?.arguments || '{}'); } catch (e) { args = {}; }
      return { name: tc.function?.name, args };
    }).filter(tc => Boolean(tc.name));

    return { text, tool_calls: toolCalls.length ? toolCalls : undefined };
  }
}

async function callAI(env, messages, tools, onChunk) {
  let lastErr = null;

  // 1. ModelRouter
  const mrKeys = await getModelRouterKeys(env);
  if (mrKeys.length > 0) {
    for (const key of mrKeys) {
      try {
        const res = await callOpenAICompatible({
          url: 'https://modelrouter.id/v1/chat/completions',
          key,
          model: 'deepseek-v4.1-flash:free',
          messages,
          tools,
          onChunk
        });
        if (res && (res.text || (res.tool_calls && res.tool_calls.length))) {
          return { ...res, model: 'deepseek-v4.1-flash:free (ModelRouter)' };
        }
      } catch (e) {
        lastErr = e;
        console.warn('ModelRouter error:', e.message);
      }
    }
  }

  // 2. OpenRouter
  const orKeys = await getOpenRouterKeys(env);
  if (orKeys.length > 0) {
    for (const key of orKeys) {
      for (const model of ['deepseek/deepseek-v4.1-flash', 'openai/gpt-4o-mini']) {
        try {
          const res = await callOpenAICompatible({
            url: 'https://openrouter.ai/api/v1/chat/completions',
            key,
            model,
            messages,
            tools,
            onChunk
          });
          if (res && (res.text || (res.tool_calls && res.tool_calls.length))) {
            return { ...res, model: `${model} (OpenRouter)` };
          }
        } catch (e) {
          lastErr = e;
          console.warn('OpenRouter error:', model, e.message);
        }
      }
    }
  }

  // 3. Gemini OpenAI-compatible
  const geminiKeys = await getGeminiKeys(env);
  if (geminiKeys.length > 0) {
    for (const key of geminiKeys) {
      for (const model of ['gemini-2.0-flash', 'gemini-1.5-flash']) {
        try {
          const res = await callOpenAICompatible({
            url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
            key,
            model,
            messages,
            tools,
            onChunk
          });
          if (res && (res.text || (res.tool_calls && res.tool_calls.length))) {
            return { ...res, model: `${model} (Gemini)` };
          }
        } catch (e) {
          lastErr = e;
          console.warn('Gemini error:', model, e.message);
        }
      }
    }
  }

  throw new Error(lastErr ? ('AI error: ' + lastErr.message) : 'Kunci API AI belum terkonfigurasi di env atau DB.');
}

export async function onRequestPost({ request, env, waitUntil }) {
  try {
    const raw = await request.text();
    let body = {};
    try { body = JSON.parse(raw) || {}; } catch (e) { body = {}; }

    const sessionId = body.session_id || ('ls_' + Date.now());
    const action = body.action || 'send';
    if (action === 'delete_session') {
      return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json', ...CORS } });
    }
    if (action === 'new_session') {
      return new Response(JSON.stringify({ session_id: sessionId, title: body.title || 'Percakapan Baru' }), { headers: { 'Content-Type': 'application/json', ...CORS } });
    }

    let messages = Array.isArray(body.messages) ? body.messages : [];
    if (!messages.some(m => m && m.role === 'user')) {
      const fallback = typeof body.content === 'string' ? body.content : (typeof body.message === 'string' ? body.message : '');
      if (fallback) messages.push({ role: 'user', content: fallback });
    }
    if (!messages.some(m => m && m.role === 'user')) {
      return new Response(JSON.stringify({
        text: 'Halo! Ada yang bisa saya bantu hari ini?',
        model: 'clincoo-assistant',
        session_id: sessionId
      }), { headers: { 'Content-Type': 'application/json', ...CORS } });
    }

    const mode = String(body.mode || 'chat').trim().toLowerCase();
    const wantTools = mode === 'build' || body.workspace_tools === true;
    const infoTools = body.info_tools === true;

    let activeTools = null;
    if (wantTools) {
      activeTools = OAI_TOOLS;
    } else if (infoTools) {
      activeTools = OAI_TOOLS.filter(t => ['web_search', 'read_web_page'].includes(t.function.name));
    }

    const chatMsgs = toOAIChat(messages, SYSTEM_PROMPT);
    const useStream = body.stream === true;

    if (useStream) {
      const ts = new TransformStream();
      const streamWriter = ts.writable.getWriter();
      const enc = new TextEncoder();
      const sendRaw = (obj) => streamWriter.write(enc.encode(JSON.stringify(obj) + '\n')).catch(() => {});

      // Send initial thinking signal immediately
      await sendRaw({ t: 'thinking' });

      const runner = async () => {
        try {
          const res = await callAI(env, chatMsgs, activeTools, (chunk) => sendRaw({ t: 'delta', text: chunk }));
          const out = {
            t: 'final',
            text: res.text || '',
            model: res.model || 'Clincoo AI',
            session_id: sessionId
          };
          if (res.tool_calls && res.tool_calls.length) {
            out.tool_calls = res.tool_calls;
          }
          await sendRaw(out);
        } catch (err) {
          await sendRaw({ t: 'error', error: 'AI gagal merespons: ' + err.message });
        } finally {
          await streamWriter.close().catch(() => {});
        }
      };

      if (waitUntil) waitUntil(runner());
      else runner();

      return new Response(ts.readable, {
        headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-cache', ...CORS }
      });
    } else {
      const res = await callAI(env, chatMsgs, activeTools, null);
      const out = {
        text: res.text || '',
        model: res.model || 'Clincoo AI',
        session_id: sessionId
      };
      if (res.tool_calls && res.tool_calls.length) {
        out.tool_calls = res.tool_calls;
      }
      return new Response(JSON.stringify(out), {
        headers: { 'Content-Type': 'application/json', ...CORS }
      });
    }
  } catch (err) {
    return new Response(JSON.stringify({ error: 'Server error: ' + err.message }), {
      status: 500, headers: { 'Content-Type': 'application/json', ...CORS }
    });
  }
}
