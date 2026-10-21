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

// Panel admin: handler sama dengan yang dipakai panel web (/api/admin) — diimpor langsung
// supaya aksi bot identik dengan panel, tanpa duplikasi logika.
import {
  handleGetStats, handleGetUsers, handleGetReports, handleGetActivity,
  handleGetSecurity, handlePostUsers, handlePostReports
} from './admin/_core.js';

const GEMINI_MODELS = ['gemini-3.6-flash', 'gemini-3-flash-preview'];

// Subjek admin untuk log aktivitas (id 0 = tidak bisa self-target guard)
const ADMIN_BOT_USER = { id: 0, email: 'telegram-bot@clincoo', role: 'owner' };
const _hapusPending = new Map(); // chatId -> {id, ts} konfirmasi dua langkah

async function rj(res) { try { return await res.json(); } catch (e) { return { error: 'respons tidak terbaca' }; } }
function rp(n) { return 'Rp' + (Math.round(Number(n) || 0)).toLocaleString('id-ID'); }
async function getUserById(db, id) {
  try { return await db.prepare('SELECT id, name, email, status, role FROM auth_users WHERE id = ?').bind(id).first(); } catch (e) { return null; }
}
function fmtUserLine(u) {
  const st = u.status === 'suspended' ? '⛔' : '✅';
  const role = (u.role === 'admin' || u.role === 'owner') ? ' ·' + u.role : '';
  return '[' + u.id + '] ' + (u.name || u.email) + role + ' · ' + (u.plan || 'Free') + ' · ' + st + ' · ' + rp(u.balance) + ' · ' + (u.projects_count || 0) + ' proyek';
}

function jsonb(obj, status) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
}

export async function onRequestOptions() { return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*' } }); }
export async function onRequestGet({ env }) {
  // Self-heal: pastikan webhook aktif & mengarah ke endpoint ini.
  // Aman: URL & secret diambil dari env server, tidak ada parameter eksternal.
  let wh = null;
  try {
    const origin = env.TELEGRAM_WEBHOOK_ORIGIN || 'https://app.clincoo.buzz';
    const info = await tg(env, 'getWebhookInfo', {});
    wh = info && info.result;
    // Bot ini MILIK panel admin: paksa re-point bila webhook nggak ngarah ke sini
    if (!wh || !wh.url || !String(wh.url).startsWith(origin)) {
      if (env.TELEGRAM_WEBHOOK_SECRET) {
        await tg(env, 'setWebhook', { url: origin + '/api/telegram', secret_token: env.TELEGRAM_WEBHOOK_SECRET });
        const info2 = await tg(env, 'getWebhookInfo', {});
        wh = info2 && info2.result;
      }
    }
    // Menu perintah bot (dipasang ulang tiap self-heal — idempoten)
    await tg(env, 'setMyCommands', { commands: [
      { command: 'stats', description: 'Statistik dashboard' },
      { command: 'users', description: 'Daftar user' },
      { command: 'cari', description: 'Cari user (nama/email/id)' },
      { command: 'suspend', description: 'Tangguhkan akun' },
      { command: 'unsuspend', description: 'Buka tangguhan akun' },
      { command: 'hapus', description: 'Hapus akun (konfirmasi 2x)' },
      { command: 'role', description: 'Ubah peran user' },
      { command: 'laporan', description: 'Laporan & flag keamanan' },
      { command: 'selesai', description: 'Selesaikan laporan' },
      { command: 'abaikan', description: 'Abaikan laporan' },
      { command: 'scan', description: 'Pindai aktivitas mencurigakan' },
      { command: 'keamanan', description: 'Event keamanan terbaru' },
      { command: 'aktivitas', description: 'Log aktivitas terbaru' },
      { command: 'help', description: 'Bantuan semua perintah' }
    ] }).catch(() => {});
  } catch (e) {}
  let me = null;
  try { const m = await tg(env, 'getMe', {}); me = m && m.result ? { username: m.result.username, name: m.result.first_name } : null; } catch (e) {}
  return jsonb({ ok: true, bot: me, webhook: wh ? { url: wh.url || null, pending: wh.pending_update_count || 0, last_error: wh.last_error_message || null } : null });
}

// ---------- helper Telegram ----------
async function tg(env, method, body) {
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token) return null;
  const base = (env && env.TELEGRAM_API_BASE) || 'https://api.telegram.org';
  const r = await fetch(base + '/bot' + token + '/' + method, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return r.json().catch(() => null);
}
async function sendText(env, chatId, text) {
  // Selalu kembalikan Response valid ke Pages (bukan hasil JSON Telegram).
  try { await tg(env, 'sendMessage', { chat_id: chatId, text: String(text || '').slice(0, 3900) }); } catch (e) {}
  return jsonb({ ok: true });
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
  '- Gunakan tool admin_stats, admin_users, admin_user_action, dan admin_reports untuk mengendalikan PANEL ADMIN Clincoo (persis seperti panel web): statistik, cari user, suspend/unsuspend/hapus akun, ubah peran, dan kelola laporan keamanan.',
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
        name: 'admin_stats',
        description: 'Statistik dashboard admin Clincoo: total user, user baru 7 hari, proyek, deploy, top-up, saldo, kredit AI, laporan terbuka.',
        parameters: { type: 'object', properties: {} }
      },
      {
        name: 'admin_users',
        description: 'Daftar user Clincoo lengkap (plan, peran, status, saldo, jumlah proyek). by_text opsional untuk filter nama/email/id.',
        parameters: { type: 'object', properties: { by_text: { type: 'string' } } }
      },
      {
        name: 'admin_user_action',
        description: 'Aksi panel admin pada user: suspend, unsuspend, delete (soft), set_role.',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', description: 'suspend | unsuspend | delete | set_role' },
            user_id: { type: 'number' },
            reason: { type: 'string' },
            role: { type: 'string', description: 'user atau admin — wajib untuk set_role' },
          },
          required: ['action', 'user_id']
        }
      },
      {
        name: 'admin_reports',
        description: 'Laporan admin Clincoo: list (daftar laporan + flag keamanan), resolve, dismiss, atau scan (pindai aktivitas mencurigakan).',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', description: 'list | resolve | dismiss | scan' },
            report_id: { type: 'number', description: 'wajib untuk resolve/dismiss' }
          },
          required: ['action']
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
    if (name === 'admin_stats') return await rj(await handleGetStats(db));
    if (name === 'admin_users') {
      const d = await rj(await handleGetUsers(db));
      let users = d.users || [];
      const q = String((args && args.by_text) || '').toLowerCase();
      if (q) users = users.filter(u => (u.email || '').toLowerCase().includes(q) || (u.name || '').toLowerCase().includes(q) || String(u.id) === q);
      return { total: users.length, users: users.slice(0, 12).map(u => ({ id: u.id, name: u.name, email: u.email, plan: u.plan, role: u.role, status: u.status, balance: u.balance, projects: u.projects_count })) };
    }
    if (name === 'admin_user_action') return await rj(await handlePostUsers(db, ADMIN_BOT_USER, args || {}));
    if (name === 'admin_reports') {
      const a = (args && args.action) || 'list';
      if (a === 'list') return await rj(await handleGetReports(db));
      return await rj(await handlePostReports(db, ADMIN_BOT_USER, args || {}));
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
export async function onRequestPost(ctx) {
  try { return await handleUpdate(ctx); } catch (e) { return jsonb({ ok: true }); }
}

async function handleUpdate({ request, env }) {
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
    return sendText(env, chatId, 'Halo Admin! Aku asisten Clincoo. Ketik /help — panel admin Clincoo bisa kamu kontrol semua dari chat ini.');
  }

  if (!adminId) return jsonb({ ok: true });            // belum ada admin terpasang
  if (chatId !== adminId) return jsonb({ ok: true });  // bukan admin: abaikan senyap

  // ==== PANEL ADMIN VIA BOT: perintah langsung (deterministik, tanpa AI) ====
  const parts = text.trim().split(/\s+/);
  let cmd = (parts[0] || '').toLowerCase();
  if (cmd.indexOf('@') > -1) cmd = cmd.split('@')[0]; // abaikan mention username bot
  const a1 = parts[1], a2 = parts[2];
  const aRest = parts.slice(1).join(' ');
  const aReasonAfter2 = parts.slice(3).join(' ');

  if (cmd === '/help' || cmd === '/bantuan') {
    return sendText(env, chatId,
      '🎛 Panel Admin Clincoo — perintah cepat:\n' +
      '/stats — statistik dashboard\n' +
      '/users [hal] — daftar user\n' +
      '/cari <teks> — cari user (nama/email/id)\n' +
      '/suspend <id> [alasan] — tangguhkan akun\n' +
      '/unsuspend <id> — aktifkan kembali\n' +
      '/hapus <id> — hapus akun (kirim 2x utk konfirmasi)\n' +
      '/role <id> <user|admin> — ubah peran\n' +
      '/laporan — laporan & flag keamanan\n' +
      '/selesai <id> — selesaikan laporan\n' +
      '/abaikan <id> — abaikan laporan\n' +
      '/scan — pindai aktivitas mencurigakan\n' +
      '/keamanan — event keamanan terbaru\n' +
      '/notif <pesan> — kirim notifikasi ke SEMUA user (tampil di app)\n/notif <email> <pesan> — kirim ke satu user\n/aktivitas [n] — log aktivitas terbaru\n\n' +
      'Atau tulis natural, aku yang menjalankan:\n' +
      '"berapa pengguna baru minggu ini?"\n' +
      '"suspend akun 42 karena spam"\n' +
      '"suspend akun 42 karena spam"');
  }

  if (cmd === '/notif' || cmd === '/notify' || cmd === '/notifikasi') {
    let target = 'all';
    let rest = aRest;
    if (a1 && a1.indexOf('@') > 0) { target = a1.toLowerCase(); rest = parts.slice(2).join(' '); }
    if (!rest) return sendText(env, chatId, 'Format: /notif <pesan> (semua user) atau /notif <email> <pesan> (satu user).\nAwali pesan dengan "warning:", "error:", "sukses:" untuk mengubah gaya ikon.');
    let type = 'info';
    const mType = rest.match(/^(info|warning|error|sukses|berhasil)\s*:\s*/i);
    if (mType) {
      const t = mType[1].toLowerCase();
      type = (t === 'sukses' || t === 'berhasil') ? 'success' : t;
      rest = rest.slice(mType[0].length);
    }
    try {
      await db.prepare('CREATE TABLE IF NOT EXISTS notifications (id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, message TEXT NOT NULL, type TEXT DEFAULT \'info\', link TEXT, read INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime(\'now\')), user_id INTEGER)').run();
      let ids = [];
      if (target === 'all') {
        const rows = await db.prepare('SELECT id FROM auth_users ORDER BY id ASC LIMIT 5000').all();
        ids = (rows.results || []).map(r => r.id);
      } else {
        const u = await db.prepare('SELECT id FROM auth_users WHERE lower(email) = ?').bind(target).first();
        if (!u) return sendText(env, chatId, '❌ User tidak ditemukan: ' + target);
        ids = [u.id];
      }
      if (!ids.length) return sendText(env, chatId, '❌ Tidak ada user.');
      const stmts = ids.map(id => db.prepare(
        'INSERT INTO notifications (source, message, type, link, user_id) VALUES (?, ?, ?, ?, ?)'
      ).bind('Bot Clincoo', rest.slice(0, 500), type, '', id));
      for (let i = 0; i < stmts.length; i += 40) await db.batch(stmts.slice(i, i + 40));
      return sendText(env, chatId, '✅ Notifikasi terkirim ke ' + ids.length + (ids.length === 1 ? ' user.' : ' user (semua).'));
    } catch (e) {
      return sendText(env, chatId, '❌ Gagal: ' + (e && e.message ? e.message : 'error DB'));
    }
  }

  if (cmd === '/stats' || cmd === '/statistik') {
    const d = await rj(await handleGetStats(db));
    if (d.error) return sendText(env, chatId, '❌ ' + d.error);
    const s = d.stats || {};
    return sendText(env, chatId,
      '📊 Dashboard Clincoo\n' +
      'User: ' + s.users_total + ' total • ' + s.new_users_7d + ' baru (7h) • ' + s.users_suspended + ' ditangguh\n' +
      'Proyek: ' + s.projects_total + ' • Deploy: ' + s.deploys_total + ' total (' + s.deploys_7d + ' / 7h)\n' +
      'Top-up: ' + rp(s.topup_total_amount) + ' (' + s.topup_count + ' transaksi)\n' +
      'Kredit AI aktif: ' + s.ai_credits_total + ' • Pesan AI: ' + s.ai_messages_total + '\n' +
      'Laporan terbuka: ' + s.reports_open);
  }

  if (cmd === '/users' || cmd === '/pengguna') {
    const page = Math.max(1, parseInt(a1, 10) || 1);
    const d = await rj(await handleGetUsers(db));
    if (d.error) return sendText(env, chatId, '❌ ' + d.error);
    const all = (d.users || []).filter(u => u.status !== 'deleted');
    const per = 10, maxp = Math.max(1, Math.ceil(all.length / per));
    const slice = all.slice((page - 1) * per, page * per);
    if (!slice.length) return sendText(env, chatId, 'Tidak ada user di halaman ' + page + '. Total: ' + all.length + ' user.');
    return sendText(env, chatId,
      '👥 User (' + all.length + ') — hal ' + page + '/' + maxp + ':\n' +
      slice.map(u => fmtUserLine(u)).join('\n') +
      '\n\n/users <hal> utk lanjut • /cari <teks> utk mencari');
  }

  if (cmd === '/cari' || cmd === '/search') {
    if (!aRest) return sendText(env, chatId, 'Format: /cari <nama atau email>');
    const d = await rj(await handleGetUsers(db));
    const q = aRest.toLowerCase();
    const found = (d.users || []).filter(u => (u.email || '').toLowerCase().includes(q) || (u.name || '').toLowerCase().includes(q) || String(u.id) === q);
    if (!found.length) return sendText(env, chatId, 'Tidak ada user yang cocok dengan "' + aRest + '".');
    return sendText(env, chatId, '🔎 Ketemu ' + found.length + ' user:\n' + found.slice(0, 10).map(u => fmtUserLine(u)).join('\n'));
  }

  if (cmd === '/suspend' || cmd === '/tangguh') {
    const id = parseInt(a1, 10);
    if (!id) return sendText(env, chatId, 'Format: /suspend <id_user> [alasan]');
    const u = await getUserById(db, id);
    if (!u) return sendText(env, chatId, 'User id ' + id + ' tidak ditemukan.');
    const reason = parts.slice(2).join(' ') || 'Penangguhan via bot';
    const d = await rj(await handlePostUsers(db, ADMIN_BOT_USER, { action: 'suspend', user_id: id, reason: reason }));
    return sendText(env, chatId, d.success ? '⛔ Akun ' + u.email + ' ditangguhkan. Alasan: ' + reason : '❌ ' + (d.error || 'gagal'));
  }

  if (cmd === '/unsuspend' || cmd === '/aktifkan') {
    const id = parseInt(a1, 10);
    if (!id) return sendText(env, chatId, 'Format: /unsuspend <id_user>');
    const d = await rj(await handlePostUsers(db, ADMIN_BOT_USER, { action: 'unsuspend', user_id: id }));
    return sendText(env, chatId, d.success ? '✅ Akun id ' + id + ' diaktifkan kembali.' : '❌ ' + (d.error || 'gagal'));
  }

  if (cmd === '/hapus') {
    const id = parseInt(a1, 10);
    if (!id) return sendText(env, chatId, 'Format: /hapus <id_user>');
    const u = await getUserById(db, id);
    if (!u) return sendText(env, chatId, 'User id ' + id + ' tidak ditemukan.');
    const pend = _hapusPending.get(chatId);
    if (pend && pend.id === id && Date.now() - pend.ts < 120000) {
      _hapusPending.delete(chatId);
      const d = await rj(await handlePostUsers(db, ADMIN_BOT_USER, { action: 'delete', user_id: id }));
      return sendText(env, chatId, d.success ? '🗑 Akun ' + u.email + ' dihapus (soft delete — data masih tersimpan).' : '❌ ' + (d.error || 'gagal'));
    }
    _hapusPending.set(chatId, { id: id, ts: Date.now() });
    return sendText(env, chatId, '⚠️ Konfirmasi: hapus akun ' + u.email + ' (id ' + id + ')?\nKirim ulang perintah yang sama dalam 2 menit untuk mengeksekusi.');
  }

  if (cmd === '/role' || cmd === '/peran') {
    const id = parseInt(a1, 10);
    const role = (a2 || '').toLowerCase();
    if (!id || (role !== 'user' && role !== 'admin')) return sendText(env, chatId, 'Format: /role <id_user> <user|admin>');
    const d = await rj(await handlePostUsers(db, ADMIN_BOT_USER, { action: 'set_role', user_id: id, role: role }));
    return sendText(env, chatId, d.success ? '✅ Peran user id ' + id + ' → ' + role : '❌ ' + (d.error || 'gagal'));
  }

  if (cmd === '/laporan' || cmd === '/reports') {
    const d = await rj(await handleGetReports(db));
    const open = (d.reports || []).filter(r => r.status === 'open');
    const flags = d.auto_flags || [];
    let out = '🗂 Laporan terbuka: ' + open.length + ' • Flag keamanan: ' + flags.length;
    if (open.length) out += '\n\n' + open.slice(0, 8).map(r => '#' + r.id + ' [' + r.type + ']' + (r.target_email ? ' → ' + r.target_email : '') + ' — ' + String(r.details || '').slice(0, 80)).join('\n');
    else out += '\nTidak ada laporan terbuka. 👍';
    if (flags.length) out += '\n\nFlag:\n' + flags.slice(0, 5).map(f => '• ' + JSON.stringify(f).slice(0, 100)).join('\n');
    return sendText(env, chatId, out);
  }

  if (cmd === '/selesai') {
    const id = parseInt(a1, 10);
    if (!id) return sendText(env, chatId, 'Format: /selesai <id_laporan>');
    const d = await rj(await handlePostReports(db, ADMIN_BOT_USER, { action: 'resolve', report_id: id }));
    return sendText(env, chatId, d.success ? '✅ Laporan #' + id + ' diselesaikan.' : '❌ ' + (d.error || 'gagal'));
  }

  if (cmd === '/abaikan') {
    const id = parseInt(a1, 10);
    if (!id) return sendText(env, chatId, 'Format: /abaikan <id_laporan>');
    const d = await rj(await handlePostReports(db, ADMIN_BOT_USER, { action: 'dismiss', report_id: id }));
    return sendText(env, chatId, d.success ? '✅ Laporan #' + id + ' diabaikan.' : '❌ ' + (d.error || 'gagal'));
  }

  if (cmd === '/scan') {
    const d = await rj(await handlePostReports(db, ADMIN_BOT_USER, { action: 'scan' }));
    return sendText(env, chatId, d.success ? '🔎 Scan selesai: ' + (d.inserted || 0) + ' aktivitas mencurigakan baru dilaporkan.' : '❌ ' + (d.error || 'gagal'));
  }

  if (cmd === '/keamanan' || cmd === '/security') {
    const d = await rj(await handleGetSecurity(db, new Request('https://app.clincoo.buzz/api/admin/security?limit=10')));
    const ev = d.events || [];
    const by = d.by_type || [];
    let out = '🔐 Event keamanan 7 hari: ' + (by.length ? by.map(t => t.type + ' (' + t.c + ')').join(', ') : 'bersih');
    if (ev.length) out += '\n\nTerbaru:\n' + ev.slice(0, 8).map(e => '• [' + e.type + '] ' + String(e.detail || '').slice(0, 70)).join('\n');
    return sendText(env, chatId, out);
  }

  if (cmd === '/aktivitas' || cmd === '/activity') {
    const n = Math.min(20, Math.max(1, parseInt(a1, 10) || 10));
    const d = await rj(await handleGetActivity(db, new Request('https://app.clincoo.buzz/api/admin/activity?limit=' + n)));
    const acts = d.activities || [];
    if (!acts.length) return sendText(env, chatId, 'Belum ada aktivitas.');
    return sendText(env, chatId, '🕒 Aktivitas terbaru:\n' + acts.map(a =>
      '• ' + a.action + ' — ' + String(a.details || '').slice(0, 70) + ((a.user_email || a.user_name) ? ' (' + (a.user_email || a.user_name) + ')' : '')
    ).join('\n'));
  }

  const reply = await askAI(env, db, text, msg.from && msg.from.first_name);
  return sendText(env, chatId, reply);
}
