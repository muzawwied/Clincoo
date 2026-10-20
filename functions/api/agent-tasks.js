// Cloudflare Pages Functions — EVENT STORE "AI MODE BUILD" (arsitektur dua agen)
// [Rancangan pemilik, 14 Okt 2026] Satu sumber kebenaran status tugas build.
// Front Agent (komunikasi) & Execution Agent (pekerjaan teknis) tidak bicara
// langsung: semua progres lewat event append-only di sini. Fondasi tabel lama
// dipakai ulang agar kompatibel (tanpa migrasi):
//   agent_tasks  (id, user_key, project_id, goal, status, plan, transcript,
//                 current_step, result, error, wa_number, created_at, updated_at)
//     - plan    -> menyimpan task brief (JSON) dari Front Agent
//     - result  -> laporan akhir task_done
//   agent_events (id AUTOINCREMENT, task_id, user_key, kind, text, created_at)
//     - append-only: event TIDAK PERNAH diubah/dihapus lewat API ini
//
// ENDPOINTS
//   GET  /api/agent-tasks?project_id=xxx              -> daftar tugas (terbaru dulu, maks 50)
//   GET  /api/agent-tasks?project_id=xxx&active=1     -> tugas aktif terakhir + 50 event terakhirnya
//   GET  /api/agent-tasks?task_id=xxx                 -> detail tugas + maks 200 event (urut naik)
//   POST /api/agent-tasks {action:'create',    project_id, goal, brief?}
//   POST /api/agent-tasks {action:'update',    task_id, status?, current_step?, result?, error?}
//   POST /api/agent-tasks {action:'add_event', task_id, type, payload?}
//
// STATUS: queued | planning | running | waiting_user | verifying | done | failed | cancelled
// JENIS EVENT (rancangan): task_created, plan_ready, step_started, tool_called,
//   tool_result, file_changed, step_done, error, retry, need_user, user_update,
//   verify_result, task_done, task_failed
//
// ATURAN KEAMANAN
//   - wajib login (token Bearer, pola user-scope.js); kepemilikan proyek dicek
//     guardProject (anti-IDOR); tugas hanya bisa dibaca/ubah pemiliknya
//   - payload dipotong 8.000 karakter sebelum disimpan
//   - DILARANG mengirim rahasia (API key/token) dalam payload — tidak disimpan di sini
//   - hemat D1: maks 1.000 event per tugas (terlama dipangkas otomatis)

import { currentUser, guardProject } from './user-scope.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};
function j(obj, status) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: { 'Content-Type': 'application/json', ...CORS } });
}

const ACTIVE_STATUSES = "('queued','planning','running','waiting_user','verifying')";
const ALL_STATUSES = ['queued', 'planning', 'running', 'waiting_user', 'verifying', 'done', 'failed', 'cancelled'];
const EVENT_TYPES = ['task_created', 'plan_ready', 'step_started', 'tool_called', 'tool_result', 'file_changed', 'step_done', 'error', 'retry', 'need_user', 'user_update', 'verify_result', 'task_done', 'task_failed'];
const MAX_EVENTS_PER_TASK = 1000;

async function initTables(db) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS agent_tasks (
    id TEXT PRIMARY KEY, user_key TEXT, project_id TEXT, goal TEXT, status TEXT,
    plan TEXT, transcript TEXT, current_step INTEGER DEFAULT 0, result TEXT,
    error TEXT, wa_number TEXT, created_at TEXT, updated_at TEXT
  )`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS agent_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT, user_key TEXT, kind TEXT, text TEXT, created_at TEXT
  )`).run();
}

function userKeyOf(user) { return 'u' + (user && user.id != null ? user.id : ''); }
function nowIso() { return new Date().toISOString(); }

async function getTaskOwned(db, user, taskId) {
  if (!taskId) return null;
  const row = await db.prepare('SELECT * FROM agent_tasks WHERE id = ?').bind(String(taskId)).first();
  if (!row) return null;
  // kepemilikan: user_key cocok, ATAU baris lama yang belum ada pemilik (kompatibel migrasi)
  if (row.user_key && row.user_key !== userKeyOf(user)) return { forbidden: true, row };
  return { row };
}

async function addEvent(db, taskId, user, kind, payload) {
  const text = (() => { try { return JSON.stringify(payload === undefined ? null : payload).slice(0, 8000); } catch (e) { return 'null'; } })();
  await db.prepare('INSERT INTO agent_events (task_id, user_key, kind, text, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(String(taskId), userKeyOf(user), String(kind), text, nowIso()).run();
  // hemat D1: pangkas event terlama melewati batas
  await db.prepare('DELETE FROM agent_events WHERE task_id = ? AND id NOT IN (SELECT id FROM (SELECT id FROM agent_events WHERE task_id = ? ORDER BY id DESC LIMIT ?))')
    .bind(String(taskId), String(taskId), MAX_EVENTS_PER_TASK).run();
  await db.prepare('UPDATE agent_tasks SET updated_at = ? WHERE id = ?').bind(nowIso(), String(taskId)).run();
}

function taskOut(row) {
  if (!row) return null;
  let plan = null; try { plan = row.plan ? JSON.parse(row.plan) : null; } catch (e) { plan = null; }
  return {
    id: row.id, project_id: row.project_id, goal: row.goal, status: row.status,
    brief: plan, current_step: row.current_step || 0, result: row.result || null,
    error: row.error || null, created_at: row.created_at, updated_at: row.updated_at
  };
}
function eventOut(row) {
  let payload = null;
  try { payload = row.text ? JSON.parse(row.text) : null; } catch (e) { payload = row.text; }
  return { id: row.id, task_id: row.task_id, type: row.kind, payload: payload, created_at: row.created_at };
}

export async function onRequestOptions() { return new Response(null, { headers: CORS }); }

// ================= GET =================
export async function onRequestGet({ request, env }) {
  const db = env.DB;
  if (!db) return j({ error: 'D1 not bound' }, 500);
  try {
    await initTables(db);
    const user = await currentUser(env, request);
    if (!user) return j({ error: 'Login diperlukan.', need_login: true }, 401);

    const url = new URL(request.url);
    const taskId = url.searchParams.get('task_id');
    const projectId = url.searchParams.get('project_id');
    const activeOnly = url.searchParams.get('active') === '1';

    if (taskId) {
      const t = await getTaskOwned(db, user, taskId);
      if (!t) return j({ error: 'Tugas tidak ditemukan.' }, 404);
      if (t.forbidden) return j({ error: 'Bukan tugas Anda.' }, 403);
      const evs = await db.prepare('SELECT * FROM agent_events WHERE task_id = ? ORDER BY id ASC LIMIT 200').bind(String(taskId)).all();
      return j({ task: taskOut(t.row), events: (evs.results || []).map(eventOut) });
    }

    if (projectId) {
      const guard = await guardProject(env, request, projectId);
      if (guard) return guard; // proyek milik user lain -> tolak
      let sql = "SELECT * FROM agent_tasks WHERE project_id = ? AND user_key = ?";
      const binds = [String(projectId), userKeyOf(user)];
      if (activeOnly) sql += ' AND status IN ' + ACTIVE_STATUSES;
      sql += ' ORDER BY updated_at DESC LIMIT 50';
      const rows = await db.prepare(sql).bind(...binds).all();
      const tasks = (rows.results || []).map(taskOut);
      if (!activeOnly) return j({ tasks: tasks });
      // panel progres butuh: tugas aktif terakhir + event terakhirnya (satu panggilan)
      if (!tasks.length) return j({ task: null, events: [] });
      const evs = await db.prepare('SELECT * FROM agent_events WHERE task_id = ? ORDER BY id DESC LIMIT 50').bind(tasks[0].id).all();
      return j({ task: tasks[0], events: (evs.results || []).reverse().map(eventOut) });
    }

    return j({ error: 'task_id atau project_id wajib diisi.' }, 400);
  } catch (e) {
    return j({ error: 'Gagal membaca tugas: ' + (e && e.message) }, 500);
  }
}

// ================= POST =================
export async function onRequestPost({ request, env }) {
  const db = env.DB;
  if (!db) return j({ error: 'D1 not bound' }, 500);
  try {
    await initTables(db);
    const user = await currentUser(env, request);
    if (!user) return j({ error: 'Login diperlukan.', need_login: true }, 401);
    const body = await request.json();
    const action = String(body.action || '');

    if (action === 'create') {
      const projectId = String(body.project_id || '');
      const goal = String(body.goal || '').slice(0, 500);
      if (!projectId || !goal) return j({ error: 'project_id dan goal wajib diisi.' }, 400);
      const guard = await guardProject(env, request, projectId);
      if (guard) return guard;
      const brief = body.brief === undefined ? null : JSON.stringify(body.brief).slice(0, 8000);
      const id = 'agt_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      const ts = nowIso();
      await db.prepare('INSERT INTO agent_tasks (id, user_key, project_id, goal, status, plan, transcript, current_step, result, error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL, ?, ?)')
        .bind(id, userKeyOf(user), projectId, goal, 'queued', brief, '', ts, ts).run();
      await addEvent(db, id, user, 'task_created', { goal: goal, brief: body.brief || null });
      return j({ ok: true, task: { id: id, project_id: projectId, goal: goal, status: 'queued' } });
    }

    if (action === 'update') {
      const t = await getTaskOwned(db, user, body.task_id);
      if (!t) return j({ error: 'Tugas tidak ditemukan.' }, 404);
      if (t.forbidden) return j({ error: 'Bukan tugas Anda.' }, 403);
      const sets = [], binds = [];
      if (body.status !== undefined) {
        if (ALL_STATUSES.indexOf(String(body.status)) === -1) return j({ error: 'Status tidak dikenal. Pilihan: ' + ALL_STATUSES.join(', ') }, 400);
        sets.push('status = ?'); binds.push(String(body.status));
      }
      if (body.current_step !== undefined) { sets.push('current_step = ?'); binds.push(Number(body.current_step) || 0); }
      if (body.result !== undefined) { sets.push('result = ?'); binds.push(String(body.result || '').slice(0, 8000)); }
      if (body.error !== undefined) { sets.push('error = ?'); binds.push(String(body.error || '').slice(0, 2000)); }
      if (!sets.length) return j({ error: 'Tidak ada field yang diubah.' }, 400);
      sets.push('updated_at = ?'); binds.push(nowIso());
      binds.push(String(body.task_id));
      await db.prepare('UPDATE agent_tasks SET ' + sets.join(', ') + ' WHERE id = ?').bind(...binds).run();
      return j({ ok: true });
    }

    if (action === 'add_event') {
      const t = await getTaskOwned(db, user, body.task_id);
      if (!t) return j({ error: 'Tugas tidak ditemukan.' }, 404);
      if (t.forbidden) return j({ error: 'Bukan tugas Anda.' }, 403);
      const type = String(body.type || '');
      if (EVENT_TYPES.indexOf(type) === -1) return j({ error: 'Jenis event tidak dikenal: ' + type }, 400);
      await addEvent(db, String(body.task_id), user, type, body.payload);
      return j({ ok: true });
    }

    return j({ error: 'action tidak dikenal (create | update | add_event).' }, 400);
  } catch (e) {
    return j({ error: 'Gagal memproses: ' + (e && e.message) }, 500);
  }
}
