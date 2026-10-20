import { currentUser } from './user-scope.js';

// Cloudflare Pages Functions — Cloud Chat Log
// Sinkronisasi riwayat chat antar perangkat untuk 1 akun + 1 proyek.
// localStorage tetap dipakai sebagai cache lokal; cloud = sumber sinkronisasi
// (hp A kirim chat -> hp B buka proyek yang sama -> riwayat muncul).
// Guest (tanpa login) tidak disinkronkan — tetap localStorage saja.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

const MAX_MESSAGES = 120;     // hanya N pesan terakhir yang disimpan
const MAX_TEXT_CHARS = 20000; // batas per pesan (chat panjang tidak meledak)

async function ensureTable(db) {
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS chat_logs (
      user_key TEXT NOT NULL,
      project_id TEXT NOT NULL,
      data TEXT,
      updated_at INTEGER,
      PRIMARY KEY (user_key, project_id)
    )`
  ).run();
}

// Rapikan pesan sebelum disimpan (tampilan tetap rapi, payload tetap kecil)
function sanitizeMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter(m => m && (m.text || (m.toolCalls && m.toolCalls.length) || (m.pollQuestions && m.pollQuestions.length)))
    .slice(-MAX_MESSAGES)
    .map(m => ({
      id: String(m.id || '').slice(0, 64) || ('m' + Math.random().toString(36).slice(2)),
      role: m.role === 'ai' ? 'ai' : 'user',
      text: String(m.text || '').slice(0, MAX_TEXT_CHARS),
      time: m.time || null,
      completed: !!m.completed,
      stoppedByUser: !!m.stoppedByUser,
      pollQuestions: Array.isArray(m.pollQuestions) ? m.pollQuestions.slice(0, 6) : [],
      pollState: m.pollState || null,
      toolCalls: Array.isArray(m.toolCalls)
        ? m.toolCalls.slice(0, 12).map(t => ({
            name: String(t.name || '').slice(0, 64),
            args: t.args || {},
            ok: !!t.ok,
            result: String(t.result || '').slice(0, 400)
          }))
        : []
    }));
}

export async function onRequestOptions() {
  return new Response(null, { headers: CORS });
}

// GET ?project_id= -> ambil log chat user utk proyek itu
export async function onRequestGet({ request, env }) {
  const db = env.DB;
  if (!db) return new Response(JSON.stringify({ error: 'D1 not bound' }), { status: 500, headers: { 'Content-Type': 'application/json', ...CORS } });
  try {
    const projectId = String(new URL(request.url).searchParams.get('project_id') || 'global');
    const user = await currentUser(env, request);
    if (!user) return new Response(JSON.stringify({ success: true, guest: true, messages: [], updated_at: 0 }), {
      headers: { 'Content-Type': 'application/json', ...CORS }
    });
    await ensureTable(db);
    const row = await db.prepare(
      'SELECT data, updated_at FROM chat_logs WHERE user_key = ? AND project_id = ?'
    ).bind('u' + user.id, projectId).first();
    let messages = [], updatedAt = 0;
    if (row && row.data) {
      try { messages = JSON.parse(row.data); } catch (e) { messages = []; }
      updatedAt = Number(row.updated_at) || 0;
    }
    return new Response(JSON.stringify({ success: true, messages, updated_at: updatedAt }), {
      headers: { 'Content-Type': 'application/json', ...CORS }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { 'Content-Type': 'application/json', ...CORS } });
  }
}

// POST { project_id, messages, client_at } -> simpan/overwrite log chat
export async function onRequestPost({ request, env }) {
  const db = env.DB;
  if (!db) return new Response(JSON.stringify({ error: 'D1 not bound' }), { status: 500, headers: { 'Content-Type': 'application/json', ...CORS } });
  try {
    const body = await request.json();
    const projectId = String(body.project_id || 'global');
    const user = await currentUser(env, request);
    if (!user) return new Response(JSON.stringify({ success: true, guest: true }), {
      headers: { 'Content-Type': 'application/json', ...CORS }
    });
    const messages = sanitizeMessages(body.messages);
    const updatedAt = Math.max(0, Number(body.client_at) || Date.now());
    await ensureTable(db);
    await db.prepare(
      `INSERT INTO chat_logs (user_key, project_id, data, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(user_key, project_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`
    ).bind('u' + user.id, projectId, JSON.stringify(messages), updatedAt).run();
    return new Response(JSON.stringify({ success: true, saved: messages.length }), {
      headers: { 'Content-Type': 'application/json', ...CORS }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { 'Content-Type': 'application/json', ...CORS } });
  }
}

// DELETE ?project_id= -> hapus log (chat baru / clear)
export async function onRequestDelete({ request, env }) {
  const db = env.DB;
  if (!db) return new Response(JSON.stringify({ error: 'D1 not bound' }), { status: 500, headers: { 'Content-Type': 'application/json', ...CORS } });
  try {
    const projectId = String(new URL(request.url).searchParams.get('project_id') || 'global');
    const user = await currentUser(env, request);
    if (!user) return new Response(JSON.stringify({ success: true, guest: true }), {
      headers: { 'Content-Type': 'application/json', ...CORS }
    });
    await ensureTable(db);
    await db.prepare('DELETE FROM chat_logs WHERE user_key = ? AND project_id = ?').bind('u' + user.id, projectId).run();
    return new Response(JSON.stringify({ success: true }), {
      headers: { 'Content-Type': 'application/json', ...CORS }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { 'Content-Type': 'application/json', ...CORS }
    });
  }
}
