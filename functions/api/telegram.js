// Bot AI Telegram internal Clincoo — asisten admin pribadi.
// POST /api/telegram  : webhook update dari Telegram (divalidasi secret header)
// GET  /api/telegram  : cek endpoint aktif
//
// Keamanan:
//   1. Header rahasia X-Telegram-Bot-Api-Secret-Token (diatur saat setWebhook).
//   2. Gate admin: hanya chat id admin (env TELEGRAM_ADMIN_CHAT_ID di server,
//      atau tabel env_vars key TELEGRAM_ADMIN_CHAT_ID).
//   3. Tool AI dibatasi: db_query hanya SELECT tunggal, db_run satu pernyataan
//      tulis, set_env_var upsert ke tabel env_vars.
//
// Catatan: jawaban bot tidak menyebut nama provider infrastruktur/model —
// semua istilah memakai bahasa netral ("server deployment", "basis data").

const GEMINI_MODELS = ['gemini-3.6-flash', 'gemini-3-flash-preview'];

function jsonb(obj, status) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
}

export async function onRequestOptions() { return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*' } }); }
export async function onRequestGet() { return jsonb({ ok: true }); }

// ---------- helper Telegram ----------
async function tg(env, method, body) {
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token) return null;
  const r = await fetch('https://api.telegram.org/bot' + token + '/' + method, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return r.json().catch(() => null);
}
function sendText(env, chatId, text) {
  return tg(env, 'sendMessage', { chat_id: chatId, text: String(text || '').slice(0, 3900) });
}

// ---------- helper DB ----------
function sqlOne(sql) { return sql.trim().replace(/;+\s*$/, ''); }

// ---------- AI: Gemini + function calling ----------
const SYSTEM_PROMPT = [
  'Kamu adalah "Clincoo Assistant", asisten admin pribadi untuk platform Clincoo (pembuat website).',
  'Pemilik akun: Vylonium. Kamu menerima perintah darinya lewat Telegram.',
  'Tugasmu: menjawab pertanyaan dan MENJALANKAN aksi pada Clincoo lewat tool yang tersedia.',
  'ATURAN PENTING:',
  '- JANGAN PERNAH menyebut nama provider infrastruktur, AI, atau model (server, DNS, basis data) di jawabanmu. Gunakan istilah netral: "server deployment", "basis data".',
  '- Gunakan tool db_query untuk membaca data (jumlah pengguna, proyek, transaksi, dsb.) sebelum menjawab pertanyaan faktual tentang Clincoo.',
  '- Gunakan db_run untuk perubahan data, dan set_env_var untuk menyimpan kunci/pengaturan. Jangan pernah menulis kunci rahasia sebagai teks placeholder file.',
  '- Jika sebuah aksi berisiko (menghapus/mengubah banyak baris), konfirmasi dulu secara ringkas sebelum menjalankan.',
  '- Jawab dalam Bahasa Indonesia, ringkas dan jelas. Kalau tool error, sampaikan dengan netral ("basis data sedang tidak dapat diakses, coba lagi nanti") tanpa detail teknis.'
].join('\n');

function toolDefs() {
  return [{
    functionDeclarations: [
      {
        name: 'health',
        description: 'Cek status kesehatan server dan basis data Clincoo saat ini.',
        parameters: { type: 'object', properties: {} }
      },
      {
        name: 'db_query',
        description: 'Baca data dari basis data Clincoo. Hanya satu pernyataan SELECT.',
        parameters: {
          type: 'object',
          properties: { sql: { type: 'string', description: 'Pernyataan SQL SELECT tunggal, tanpa titik koma.' } },
          required: ['sql']
        }
      },
      {
        name: 'db_run',
        description: 'Jalankan satu pernyataan tulis (INSERT/UPDATE/DELETE/CREATE) pada basis data Clincoo. Gunakan hati-hati.',
        parameters: {
          type: 'object',
          properties: { sql: { type: 'string', description: 'Satu pernyataan SQL tulis, tanpa titik koma.' } },
          required: ['sql']
        }
      },
      {
        name: 'set_env_var',
        description: 'Simpan/ubah kunci konfigurasi Clincoo (termasuk kunci rahasia) di penyimpanan env yang aman.',
        parameters: {
          type: 'object',
          properties: {
            key: { type: 'string' },
            value: { type: 'string' },
            is_secret: { type: 'boolean', description: 'true bila nilainya rahasia (token/kunci).' }
          },
          required: ['key', 'value']
        }
      }
    ]
  }];
}

async function execTool(env, db, name, args) {
  try {
    if (name === 'health') {
      const row = await db.prepare("SELECT value FROM env_vars WHERE key = 'GOOGLE_CLIENT_ID'").first();
      return { ok: !!(row && row.value), note: row && row.value ? 'basis data terbaca normal' : 'basis data tidak dapat diakses' };
    }
    if (name === 'db_query') {
      const sql = sqlOne(String(args.sql || ''));
      if (!/^select/i.test(sql) || /;/.test(sql)) return { error: 'Hanya satu pernyataan SELECT yang diizinkan.' };
      const rs = await db.prepare(sql).all();
      const rows = (rs && rs.results) || [];
      return { rows: rows.slice(0, 40), count: rows.length };
    }
    if (name === 'db_run') {
      const sql = sqlOne(String(args.sql || ''));
      if (!/^(insert|update|delete|create)\b/i.test(sql) || /;/.test(sql)) return { error: 'Hanya satu pernyataan INSERT/UPDATE/DELETE/CREATE yang diizinkan.' };
      const r = await db.prepare(sql).run();
      return { success: true, meta: r && r.meta };
    }
    if (name === 'set_env_var') {
      const k = String(args.key || '').trim();
      if (!k) return { error: 'key wajib.' };
      const secret = args.is_secret ? 1 : 0;
      const v = String(args.value ?? '');
      const cur = await db.prepare('SELECT id FROM env_vars WHERE key = ?').bind(k).first();
      if (cur) await db.prepare('UPDATE env_vars SET value = ?, is_secret = ?, updated_at = datetime(\'now\') WHERE key = ?').bind(v, secret, k).run();
      else await db.prepare('INSERT INTO env_vars (key, value, is_secret) VALUES (?, ?, ?)').bind(k, v, secret).run();
      return { success: true, key: k };
    }
    return { error: 'Tool tidak dikenal.' };
  } catch (e) {
    return { error: 'Aksi gagal: ' + (e && e.message ? String(e.message).slice(0, 120) : 'tidak diketahui') };
  }
}

async function askAI(env, db, text, fromName) {
  const key = env.GEMINI_API_KEY;
  if (!key) return 'Asisten belum siap. Coba lagi beberapa saat.';
  const contents = [{ role: 'user', parts: [{ text: (fromName ? '(' + fromName + ') ' : '') + text }] }];
  for (let round = 0; round < 3; round++) {
    let data = null;
    for (const model of GEMINI_MODELS) {
      try {
        const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
            contents,
            tools: toolDefs(),
            generationConfig: { temperature: 0.4, maxOutputTokens: 1024 }
          })
        });
        if (!res.ok) continue;
        data = await res.json();
        break;
      } catch (e) { /* coba model berikutnya */ }
    }
    if (!data || !data.candidates || !data.candidates[0]) return 'Asisten sedang sibuk. Coba lagi sebentar.';
    const parts = data.candidates[0].content.parts || [];
    const fnCalls = parts.filter(p => p.functionCall).map(p => p.functionCall);
    if (fnCalls.length) {
      contents.push({ role: 'model', parts: fnCalls.map(fc => ({ functionCall: fc })) });
      for (const fc of fnCalls) {
        const out = await execTool(env, db, fc.name, fc.args || {});
        contents.push({ role: 'user', parts: [{ functionResponse: { name: fc.name, response: out } }] });
      }
      continue; // putaran berikutnya: model merespons hasil tool
    }
    const answer = parts.map(p => p.text || '').join('').trim();
    if (answer) return answer;
    return 'Maaf, aku belum paham. Coba tulis dengan cara lain.';
  }
  return 'Perintahnya terlalu panjang untuk diproses sekaligus. Coba pecah jadi beberapa langkah.';
}

// ---------- webhook utama ----------
export async function onRequestPost({ request, env }) {
  const secret = env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret || request.headers.get('x-telegram-bot-api-secret-token') !== secret) {
    return new Response('Not found', { status: 404 });
  }
  const db = env.DB;
  let upd = null;
  try { upd = await request.json(); } catch (e) { return jsonb({ ok: true }); }
  const msg = upd && (upd.message || upd.edited_message);
  if (!msg || !msg.chat || !msg.text) return jsonb({ ok: true });

  const chatId = String(msg.chat.id);
  const text = String(msg.text || '').trim();

  // gate admin: env server (utama) -> tabel env_vars (klaim /start)
  // Admin tetap: akun pemilik Clincoo (ID chat bukan rahasia; token bot yang rahasia).
  let adminId = env.TELEGRAM_ADMIN_CHAT_ID || '8226478162';
  if (!adminId && db) {
    try {
      const row = await db.prepare("SELECT value FROM env_vars WHERE key = 'TELEGRAM_ADMIN_CHAT_ID'").first();
      if (row && row.value) adminId = String(row.value);
    } catch (e) { /* basis data tidak terbaca -> admin belum terpasang */ }
  }

  if (text === '/id' || text === '/start') {
    if (!adminId && db) {
      try {
        await db.prepare("INSERT INTO env_vars (key, value, is_secret) VALUES ('TELEGRAM_ADMIN_CHAT_ID', ?, 1) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')").bind(chatId).run();
        return sendText(env, chatId, 'Halo! Kamu sekarang admin Clincoo. Kirim pertanyaan atau perintah apa saja, atau /help untuk daftar kemampuan.');
      } catch (e) {
        return sendText(env, chatId, 'Halo! Untuk aktivasi, kirim angka ini ke asisten Clincoo: ' + chatId);
      }
    }
    if (adminId && chatId !== adminId) return jsonb({ ok: true }); // bukan admin: diam saja
    return sendText(env, chatId, 'Halo Admin! Aku asisten Clincoo. /help untuk daftar kemampuan.');
  }

  if (!adminId) return jsonb({ ok: true });            // belum ada admin terpasang
  if (chatId !== adminId) return jsonb({ ok: true });  // bukan admin: abaikan senyap

  if (text === '/help') {
    return sendText(env, chatId,
      'Aku bisa mengendalikan Clincoo langsung dari chat ini. Contoh:\n' +
      '1. "berapa pengguna aktif sekarang?"\n' +
      '2. "cek status server"\n' +
      '3. "simpan kunci API baru: NAMA_KUNCI = abc123"\n' +
      '4. "ubah saldo pengguna X jadi 50000"\n' +
      '5. "hapus akun uji bernama test1"\n' +
      'Tulis saja natural, aku yang menjalankannya.');
  }

  const reply = await askAI(env, db, text, msg.from && msg.from.first_name);
  return sendText(env, chatId, reply);
}
