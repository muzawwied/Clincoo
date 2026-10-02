// Cloudflare Pages Functions — Tugas Terjadwal AI (Scheduled AI Tasks)
// GET  /api/scheduled-tasks                      -> daftar tugas milik user login + hasil terakhir
// POST /api/scheduled-tasks {action:'create'|'update'|'toggle'|'delete'|'run_now'} -> CRUD (wajib login)
// POST /api/scheduled-tasks {action:'run_due'}   -> eksekusi semua tugas jatuh tempo (khusus cron
//    Worker; wajib header x-cron-secret yang sama dengan env/D1 CRON_SECRET)
// POST /api/scheduled-tasks {action:'mark_run'}  -> tandai tugas milik sendiri baru dijalankan
//
// Eksekusi tugas = panggil Gemini (gemini-3.6-flash, fallback gemini-3-flash-preview) dengan
// prompt tugas -> hasil disimpan ke task_results -> notifikasi in-app -> email opsional (Brevo).

import { currentUser } from './user-scope.js';
import { getSecret, emailTemplate, sendEmail, notifyEvent } from './notify-helpers.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

const PREFERRED_MODELS = ['gemini-3.6-flash', 'gemini-3-flash-preview'];

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...CORS } });
}

export async function onRequestOptions() {
  return new Response(null, { headers: CORS });
}

async function ensureTable(db) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS scheduled_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    name TEXT,
    when_description TEXT,
    schedule_type TEXT DEFAULT 'daily',
    time_wib TEXT,
    interval_minutes INTEGER,
    prompt TEXT NOT NULL,
    notify_email INTEGER DEFAULT 0,
    active INTEGER DEFAULT 1,
    last_run_at TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`).run();
  // Migrasi lembut: tabel lama belum punya kolom user_id / notify_email
  for (const col of ['user_id', 'notify_email']) {
    try { await db.prepare(`ALTER TABLE scheduled_tasks ADD COLUMN ${col} ${col === 'user_id' ? 'INTEGER' : 'INTEGER DEFAULT 0'}`).run(); } catch (e) {}
  }
  await db.prepare(`CREATE TABLE IF NOT EXISTS task_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL,
    user_id INTEGER,
    output TEXT,
    model TEXT,
    ok INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  )`).run();
}

function parseDbTime(str) {
  if (!str) return null;
  const iso = str.includes('T') ? str : str.replace(' ', 'T') + 'Z';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d.getTime();
}

// Menit sejak tengah malam, waktu WIB (UTC+7)
function wibMinutesNow() {
  const now = new Date();
  const utcMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  return (utcMinutes + 420) % 1440;
}

function isDue(task) {
  const nowMs = Date.now();
  const lastRun = parseDbTime(task.last_run_at);
  if (task.schedule_type === 'interval_minutes') {
    const intervalMs = (task.interval_minutes || 15) * 60000;
    const anchor = lastRun !== null ? lastRun : parseDbTime(task.created_at) || nowMs;
    return (nowMs - anchor) >= intervalMs;
  }
  // daily pada jam time_wib (HH:MM WIB), dengan catch-up: kalau waktunya sudah lewat
  // hari ini tapi belum dijalankan, tetap dianggap jatuh tempo.
  // Tugas baru (belum pernah jalan) di-anchor ke created_at supaya tidak
  // langsung dieksekusi begitu dibuat.
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(task.time_wib || ''));
  if (!m) return false;
  const taskMin = parseInt(m[1]) * 60 + parseInt(m[2]);
  const nowWib = wibMinutesNow();
  const minutesSinceOccurrence = (nowWib - taskMin + 1440) % 1440;
  const occurrenceMs = nowMs - minutesSinceOccurrence * 60000;
  const anchor = lastRun !== null ? lastRun : (parseDbTime(task.created_at) || nowMs);
  return anchor < occurrenceMs;
}

async function getGeminiKey(env) {
  if (env.GEMINI_API_KEY) return env.GEMINI_API_KEY;
  try {
    const row = await env.DB.prepare("SELECT value FROM env_vars WHERE key = 'GEMINI_API_KEY' AND (project_id IS NULL OR project_id = '')").first();
    return row?.value || null;
  } catch { return null; }
}

// Jaring pengaman: bersihkan sisa sintaks markdown agar aman tampil di email & notifikasi teks polos
function cleanAiText(s) {
  if (!s) return s;
  let t = String(s);
  t = t.replace(/```[a-zA-Z]*\n?([\s\S]*?)```/g, '$1');      // code fence -> isi saja
  t = t.replace(/`([^`]+)`/g, '$1');                           // `kode` -> kode
  t = t.replace(/^ {0,3}#{1,6}\s+(.*)$/gm, '$1');              // ## Judul -> Judul
  t = t.replace(/\*\*(.+?)\*\*/g, '$1');                      // **tebal** -> tebal
  t = t.replace(/__(.+?)__/g, '$1');                           // __tebal__ -> tebal
  t = t.replace(/^ {0,3}(-{3,}|\*{3,}|_{3,})\s*$/gm, '');      // garis pemisah --- *** ___
  t = t.replace(/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/gm, ''); // baris pemisah tabel md
  t = t.replace(/\|/g, '  ');                                  // sisa pipe tabel -> spasi
  t = t.replace(/^ {0,3}[-*]\s+/gm, '• ');                      // - item / * item -> • item
  t = t.replace(/\*(.+?)\*/g, '$1');                           // sisa *miring* -> miring
  t = t.replace(/(?<![a-zA-Z0-9])_(.+?)_(?![a-zA-Z0-9])/g, '$1'); // sisa _miring_ -> miring
  t = t.replace(/\n{3,}/g, '\n\n').trim();
  return t;
}

async function geminiText(apiKey, prompt) {
  for (const model of PREFERRED_MODELS) {
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({ systemInstruction: { parts: [{ text: 'Anda asisten AI Clincoo, platform deploy Indonesia. Jalankan tugas terjadwal berikut dengan jawaban ringkas, padat, dan berguna dalam Bahasa Indonesia. PENTING: jawab dalam teks polos (plain text) SAJA — jawaban ini akan tampil langsung di email dan notifikasi yang tidak merender markdown. JANGAN pakai tanda **tebal**, ## judul/heading, garis --- pemisah, backtick `kode`, atau tabel bergaris |. Kalau perlu daftar, gunakan format bernomor biasa (1. 2. 3.) atau baris teks biasa.' }] }, contents: [{ role: 'user', parts: [{ text: prompt }] }] })
      });
      if (!res.ok) continue;
      const data = await res.json();
      const text = (data?.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('').trim();
      if (text) return { text, model };
    } catch (e) {}
  }
  return { error: 'Semua model gagal merespons' };
}

function escHtml(s) {
  return String(s || '').replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
// Escape + jaga baris baru agar terbaca rapi di email HTML
function toEmailHtml(s) {
  return escHtml(s).replace(/\n/g, '<br>');
}

// ====== Eksekusi satu tugas ======
async function runTask(env, db, task) {
  let output = '', model = '', ok = 0;
  const apiKey = await getGeminiKey(env);
  if (!apiKey) {
    output = 'GEMINI_API_KEY belum dikonfigurasi — tugas tidak dapat dijalankan.';
  } else {
    const r = await geminiText(apiKey, task.prompt);
    if (r.error) output = 'Gagal: ' + r.error;
    else { output = cleanAiText(r.text); model = r.model; ok = 1; }
  }
  if (output.length > 4000) output = output.slice(0, 4000) + '…';
  try {
    await db.prepare('INSERT INTO task_results (task_id, user_id, output, model, ok) VALUES (?, ?, ?, ?, ?)')
      .bind(task.id, task.user_id || null, output, model, ok).run();
  } catch (e) {}
  await db.prepare('UPDATE scheduled_tasks SET last_run_at = datetime(\'now\') WHERE id = ?').bind(task.id).run();

  // Notifikasi in-app + email opsional ke pemilik tugas
  let user = null;
  if (task.user_id) {
    try { user = await db.prepare('SELECT id, name, email FROM auth_users WHERE id = ?').bind(task.user_id).first(); } catch (e) {}
  }
  if (user) {
    const short = output.length > 140 ? output.slice(0, 140) + '…' : output;
    await notifyEvent(db, user, {
      source: 'Tugas Terjadwal',
      type: ok ? 'info' : 'error',
      message: `“${task.name || 'Tugas'}” selesai dijalankan: ${short}`,
      link: '/akun/tugas-terjadwal.html'
    });
    if (ok && task.notify_email) {
      try {
        await sendEmail(env, {
          toEmail: user.email, toName: user.name || '',
          subject: 'Tugas Terjadwal Clincoo — ' + (task.name || 'Hasil Tugas'),
          html: emailTemplate(
            'Tugas Terjadwal Selesai',
            user.name || '',
            `Tugas “${task.name || 'Tugas'}” baru saja dijalankan otomatis oleh Clincoo. Berikut hasilnya:`,
            [['Hasil', toEmailHtml(output.length > 800 ? output.slice(0, 800) + '…' : output)], ['Jadwal', escHtml(task.when_description || (task.schedule_type === 'interval_minutes' ? 'setiap ' + (task.interval_minutes || 15) + ' menit' : 'setiap hari ' + (task.time_wib || '') + ' WIB'))]],
            'Lihat tugas', 'https://clincoo.pages.dev/akun/tugas-terjadwal.html',
            'Email ini dikirim otomatis karena Anda mengaktifkan notifikasi email pada tugas ini.'
          )
        });
      } catch (e) {}
    }
  }
  return { id: task.id, name: task.name, ok, model };
}

// ====== GET: daftar tugas milik user ======
export async function onRequestGet({ request, env }) {
  const db = env.DB;
  if (!db) return json({ error: 'D1 not bound' }, 500);
  try {
    const user = await currentUser(env, request);
    if (!user) return json({ error: 'unauthorized' }, 401);
    await ensureTable(db);
    const rows = await db.prepare('SELECT * FROM scheduled_tasks WHERE user_id = ? ORDER BY id DESC').bind(user.id).all();
    const tasks = rows.results || [];
    // hasil terakhir per tugas
    const last = await db.prepare(`SELECT r.task_id, r.output, r.model, r.ok, r.created_at
      FROM task_results r JOIN (SELECT task_id, MAX(id) mx FROM task_results WHERE user_id = ? GROUP BY task_id) m
      ON r.task_id = m.task_id AND r.id = m.mx`).bind(user.id).all();
    const lastMap = {};
    for (const l of (last.results || [])) lastMap[l.task_id] = l;
    return json({
      tasks: tasks.map(t => ({ ...t, due_now: isDue(t), last_result: lastMap[t.id] || null }))
    });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}

// ====== POST: CRUD + eksekusi ======
export async function onRequestPost({ request, env }) {
  const db = env.DB;
  if (!db) return json({ error: 'D1 not bound' }, 500);
  try {
    const body = await request.json();
    const action = body.action || '';

    // --- run_due: hanya untuk cron worker, dijaga secret ---
    if (action === 'run_due') {
      const secret = await getSecret(env, 'CRON_SECRET');
      if (!secret) return json({ error: 'cron not configured' }, 404);
      const provided = request.headers.get('x-cron-secret') || '';
      if (provided !== secret) return json({ error: 'forbidden' }, 403);
      await ensureTable(db);
      const rows = await db.prepare('SELECT * FROM scheduled_tasks WHERE active = 1').all();
      const results = [];
      for (const task of (rows.results || [])) {
        if (!isDue(task)) continue;
        try { results.push(await runTask(env, db, task)); } catch (e) { results.push({ id: task.id, ok: 0, error: e.message }); }
      }
      return json({ success: true, ran: results.length, results });
    }

    const user = await currentUser(env, request);
    if (!user) return json({ error: 'unauthorized' }, 401);
    await ensureTable(db);

    if (action === 'create') {
      const prompt = String(body.prompt || '').trim();
      if (!prompt) return json({ error: 'prompt wajib diisi' }, 400);
      const schedule_type = body.schedule_type === 'interval_minutes' ? 'interval_minutes' : 'daily';
      let time_wib = null, interval_minutes = null, when_description = '';
      if (schedule_type === 'daily') {
        const m = /^(\d{1,2}):(\d{2})$/.exec(String(body.time_wib || ''));
        if (!m) return json({ error: 'time_wib wajib format HH:MM (contoh 09:30)' }, 400);
        const h = parseInt(m[1]); if (h > 23 || parseInt(m[2]) > 59) return json({ error: 'jam tidak valid' }, 400);
        time_wib = body.time_wib;
        when_description = 'setiap hari ' + time_wib + ' WIB';
      } else {
        interval_minutes = Math.min(Math.max(parseInt(body.interval_minutes) || 15, 5), 1440);
        when_description = 'setiap ' + interval_minutes + ' menit';
      }
      const name = String(body.name || '').trim() || ('Tugas ' + new Date().toISOString().slice(0, 10));
      const r = await db.prepare(`INSERT INTO scheduled_tasks (user_id, name, when_description, schedule_type, time_wib, interval_minutes, prompt, notify_email, active)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`)
        .bind(user.id, name, when_description, schedule_type, time_wib, interval_minutes, prompt, body.notify_email ? 1 : 0).run();
      return json({ success: true, id: r.meta?.last_row_id });
    }

    if (action === 'update' || action === 'toggle' || action === 'delete' || action === 'run_now' || action === 'mark_run') {
      if (!body.id) return json({ error: 'id wajib' }, 400);
      const own = await db.prepare('SELECT * FROM scheduled_tasks WHERE id = ? AND user_id = ?').bind(body.id, user.id).first();
      if (!own) return json({ error: 'not found' }, 404);

      if (action === 'delete') {
        await db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').bind(own.id).run();
        await db.prepare('DELETE FROM task_results WHERE task_id = ?').bind(own.id).run();
        return json({ success: true });
      }
      if (action === 'toggle') {
        await db.prepare('UPDATE scheduled_tasks SET active = ? WHERE id = ?').bind(own.active ? 0 : 1, own.id).run();
        return json({ success: true, active: own.active ? 0 : 1 });
      }
      if (action === 'update') {
        const name = body.name !== undefined ? String(body.name).trim() : own.name;
        const prompt = body.prompt !== undefined ? String(body.prompt).trim() : own.prompt;
        if (!prompt) return json({ error: 'prompt wajib diisi' }, 400);
        const notify_email = body.notify_email !== undefined ? (body.notify_email ? 1 : 0) : (own.notify_email || 0);
        let { schedule_type, time_wib, interval_minutes, when_description } = own;
        if (body.schedule_type === 'interval_minutes') {
          schedule_type = 'interval_minutes';
          interval_minutes = Math.min(Math.max(parseInt(body.interval_minutes) || 15, 5), 1440);
          time_wib = null;
          when_description = 'setiap ' + interval_minutes + ' menit';
        } else if (body.schedule_type === 'daily') {
          const m = /^(\d{1,2}):(\d{2})$/.exec(String(body.time_wib || ''));
          if (!m) return json({ error: 'time_wib wajib format HH:MM' }, 400);
          schedule_type = 'daily'; time_wib = body.time_wib; interval_minutes = null;
          when_description = 'setiap hari ' + time_wib + ' WIB';
        }
        await db.prepare(`UPDATE scheduled_tasks SET name = ?, prompt = ?, notify_email = ?, schedule_type = ?, time_wib = ?, interval_minutes = ?, when_description = ? WHERE id = ?`)
          .bind(name, prompt, notify_email, schedule_type, time_wib, interval_minutes, when_description, own.id).run();
        return json({ success: true });
      }
      // run_now: jalankan sekarang juga (tes manual oleh pemilik)
      const r = await runTask(env, db, own);
      return json({ success: true, result: r });
    }

    return json({ error: 'action tidak dikenal' }, 400);
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
