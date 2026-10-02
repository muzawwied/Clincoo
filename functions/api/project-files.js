// Cloudflare Pages Functions - Project Files (D1-backed)
// Stores file content per project_id, used by workspace.html CodeMirror editor

import { getProjectTables } from './_tables.js';
import { guardProject } from './user-scope.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

export async function onRequestOptions() {
  return new Response(null, { headers: CORS });
}

// GET /api/project-files?project_id=xxx — list all files for a project
export async function onRequestGet({ request, env }) {
  const db = env.DB;
  if (!db) return new Response(JSON.stringify({ error: 'D1 not bound' }), { status: 500, headers: { 'Content-Type': 'application/json', ...CORS } });
  try {
    await db.prepare(`CREATE TABLE IF NOT EXISTS project_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL,
      path TEXT NOT NULL,
      content TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(project_id, path)
    )`).run();

    const url = new URL(request.url);
    const projectId = url.searchParams.get('project_id');
    const deny = await guardProject(env, request, projectId);
    if (deny) return deny;
    if (!projectId) return new Response(JSON.stringify({ error: 'project_id required' }), { status: 400, headers: { 'Content-Type': 'application/json', ...CORS } });

    const T = await getProjectTables(db, projectId);
    const rows = await db.prepare(`SELECT path, content, updated_at FROM ${T.files} WHERE project_id = ? ORDER BY path ASC`).bind(projectId).all();
    return new Response(JSON.stringify({ files: rows.results || [] }), { headers: { 'Content-Type': 'application/json', ...CORS } });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { 'Content-Type': 'application/json', ...CORS } });
  }
}

// POST /api/project-files — { project_id, path, content } upsert a single file
// or { project_id, files: [{path, content}, ...] } bulk upsert
export async function onRequestPost({ request, env }) {
  const db = env.DB;
  if (!db) return new Response(JSON.stringify({ error: 'D1 not bound' }), { status: 500, headers: { 'Content-Type': 'application/json', ...CORS } });
  try {
    await db.prepare(`CREATE TABLE IF NOT EXISTS project_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL,
      path TEXT NOT NULL,
      content TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(project_id, path)
    )`).run();

    const body = await request.json();
    const projectId = body.project_id;
    const deny = await guardProject(env, request, projectId);
    if (deny) return deny;
    if (!projectId) return new Response(JSON.stringify({ error: 'project_id required' }), { status: 400, headers: { 'Content-Type': 'application/json', ...CORS } });

    const filesToSave = body.files && Array.isArray(body.files) ? body.files : (body.path !== undefined ? [{ path: body.path, content: body.content }] : []);
    if (filesToSave.length === 0) return new Response(JSON.stringify({ error: 'path/content or files[] required' }), { status: 400, headers: { 'Content-Type': 'application/json', ...CORS } });

    const T = await getProjectTables(db, projectId);
    for (const f of filesToSave) {
      if (!f.path) continue;
      await db.prepare(
        `INSERT INTO ${T.files} (project_id, path, content, updated_at) VALUES (?, ?, ?, datetime('now'))
         ON CONFLICT(project_id, path) DO UPDATE SET content = excluded.content, updated_at = datetime('now')`
      ).bind(projectId, f.path, f.content || '').run();
    }

    // Update project's updated_at in projects table if exists
    try { await db.prepare("UPDATE projects SET updated_at = datetime('now') WHERE id = ?").bind(projectId).run(); } catch(e) {}

    return new Response(JSON.stringify({ success: true, saved: filesToSave.length }), { headers: { 'Content-Type': 'application/json', ...CORS } });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { 'Content-Type': 'application/json', ...CORS } });
  }
}

// DELETE /api/project-files?project_id=xxx&path=yyy — delete one file, or all files for project if path omitted
export async function onRequestDelete({ request, env }) {
  const db = env.DB;
  if (!db) return new Response(JSON.stringify({ error: 'D1 not bound' }), { status: 500, headers: { 'Content-Type': 'application/json', ...CORS } });
  try {
    const url = new URL(request.url);
    const projectId = url.searchParams.get('project_id');
    const deny = await guardProject(env, request, projectId);
    if (deny) return deny;
    const path = url.searchParams.get('path');
    if (!projectId) return new Response(JSON.stringify({ error: 'project_id required' }), { status: 400, headers: { 'Content-Type': 'application/json', ...CORS } });

    const T = await getProjectTables(db, projectId);
    if (path) {
      await db.prepare(`DELETE FROM ${T.files} WHERE project_id = ? AND path = ?`).bind(projectId, path).run();
    } else {
      await db.prepare(`DELETE FROM ${T.files} WHERE project_id = ?`).bind(projectId).run();
    }
    try { await db.prepare('DELETE FROM project_files WHERE project_id = ?').bind(projectId).run(); } catch(e) {}
    return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json', ...CORS } });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { 'Content-Type': 'application/json', ...CORS } });
  }
}
