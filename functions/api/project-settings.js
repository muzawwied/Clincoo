// Cloudflare Pages Functions - Per-Project Settings Backend
// Stores project-scoped settings (domain, webhooks, collaboration, visibility, etc) in D1

import { getProjectTables } from './_tables.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

export async function onRequestOptions() {
  return new Response(null, { headers: CORS });
}

// GET /api/project-settings?project_id=xxx — get all settings for a project
// GET /api/project-settings?project_id=xxx&key=domain — get specific key
export async function onRequestGet({ request, env }) {
  const db = env.DB;
  if (!db) return new Response(JSON.stringify({ error: 'D1 not bound' }), { status: 500, headers: { 'Content-Type': 'application/json', ...CORS } });

  try {
    await db.prepare('CREATE TABLE IF NOT EXISTS project_settings (project_id TEXT, key TEXT NOT NULL, value TEXT, PRIMARY KEY (project_id, key))').run();
    
    const url = new URL(request.url);
    const projectId = url.searchParams.get('project_id') || '';
    const key = url.searchParams.get('key');

    if (!projectId) {
      return new Response(JSON.stringify({ error: 'project_id required' }), { status: 400, headers: { 'Content-Type': 'application/json', ...CORS } });
    }

    if (key) {
      const T = await getProjectTables(db, projectId);
      const row = await db.prepare(`SELECT value FROM ${T.projectSettings} WHERE project_id = ? AND key = ?`).bind(projectId, key).first();
      return new Response(JSON.stringify({ key, value: row?.value || null }), {
        headers: { 'Content-Type': 'application/json', ...CORS }
      });
    }

    const T = await getProjectTables(db, projectId);
    const rows = await db.prepare(`SELECT key, value FROM ${T.projectSettings} WHERE project_id = ?`).bind(projectId).all();
    const data = {};
    for (const row of rows.results || []) {
      data[row.key] = row.value;
    }
    return new Response(JSON.stringify(data), {
      headers: { 'Content-Type': 'application/json', ...CORS }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { 'Content-Type': 'application/json', ...CORS } });
  }
}

// POST /api/project-settings — update settings
// Body: { project_id: 'xxx', domain: 'example.com', webhook_url: '...', ... }
export async function onRequestPost({ request, env }) {
  const db = env.DB;
  if (!db) return new Response(JSON.stringify({ error: 'D1 not bound' }), { status: 500, headers: { 'Content-Type': 'application/json', ...CORS } });

  try {
    await db.prepare('CREATE TABLE IF NOT EXISTS project_settings (project_id TEXT, key TEXT NOT NULL, value TEXT, PRIMARY KEY (project_id, key))').run();
    
    const body = await request.json();
    const projectId = body.project_id || '';
    if (!projectId) {
      return new Response(JSON.stringify({ error: 'project_id required' }), { status: 400, headers: { 'Content-Type': 'application/json', ...CORS } });
    }

    const updates = {};
    for (const [key, value] of Object.entries(body)) {
      if (key === 'project_id') continue;
      updates[key] = String(value);
      const T = await getProjectTables(db, projectId);
      await db.prepare(`INSERT OR REPLACE INTO ${T.projectSettings} (project_id, key, value) VALUES (?, ?, ?)`).bind(projectId, key, String(value)).run();
    }

    const changedKeys = Object.keys(updates);
    if (changedKeys.length > 0) {
      try {
        await db.prepare("INSERT INTO activity_log (action, details) VALUES (?, ?)").bind('project_settings_update', 'Project ' + projectId + ': ' + JSON.stringify(updates)).run();
      } catch(e) {}
    }

    return new Response(JSON.stringify({ success: true, updated: updates }), {
      headers: { 'Content-Type': 'application/json', ...CORS }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { 'Content-Type': 'application/json', ...CORS } });
  }
}
