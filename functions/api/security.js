import { getProjectTables } from './_tables.js';
import { guardProject } from './user-scope.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};


async function migrateSecurityTable(db) {
  try {
    // Check if table has project_id column
    const info = await db.prepare("PRAGMA table_info(security_settings)").all();
    const hasProjectId = (info.results || []).some(c => c.name === 'project_id');
    if (!hasProjectId) {
      // Old schema: migrate to new schema
      await db.prepare("ALTER TABLE security_settings RENAME TO security_settings_old").run();
      await db.prepare("CREATE TABLE security_settings (project_id TEXT, key TEXT NOT NULL, value TEXT, PRIMARY KEY (project_id, key))").run();
      await db.prepare("INSERT INTO security_settings (project_id, key, value) SELECT '', key, value FROM security_settings_old").run();
      await db.prepare("DROP TABLE security_settings_old").run();
    }
  } catch(e) {
    // Table might not exist yet, that's fine
    try {
      await db.prepare("CREATE TABLE IF NOT EXISTS security_settings (project_id TEXT, key TEXT NOT NULL, value TEXT, PRIMARY KEY (project_id, key))").run();
    } catch(e2) {}
  }
}

export async function onRequestOptions() {
  return new Response(null, { headers: CORS });
}

export async function onRequestGet({ request, env }) {
  try {
    await migrateSecurityTable(env.DB);
    const url = new URL(request.url);
    const projectId = url.searchParams.get('project_id') || '';
    const deny = await guardProject(env, request, projectId);
    if (deny) return deny;
    
    // Try per-project security settings first
    await env.DB.prepare('CREATE TABLE IF NOT EXISTS security_settings (project_id TEXT, key TEXT NOT NULL, value TEXT, PRIMARY KEY (project_id, key))').run();
    
    let rows;
    if (projectId) {
      const T = await getProjectTables(env.DB, projectId);
      rows = await env.DB.prepare(`SELECT key, value FROM ${T.securitySettings} WHERE project_id = ?`).bind(projectId).all();
    } else {
      // Fallback: try old schema (no project_id) or use default project
      try {
        rows = await env.DB.prepare('SELECT key, value FROM security_settings WHERE project_id = ? OR project_id IS NULL').bind('').all();
      } catch(e) {
        rows = await env.DB.prepare('SELECT key, value FROM security_settings').all();
      }
    }
    
    const settings = {};
    (rows.results || []).forEach(r => settings[r.key] = r.value);
    return new Response(JSON.stringify({ settings, ssl_mode: 'auto' }), {
      headers: { 'Content-Type': 'application/json', ...CORS }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: { 'Content-Type': 'application/json', ...CORS }
    });
  }
}

export async function onRequestPost({ request, env }) {
  try {
    await migrateSecurityTable(env.DB);
    const body = await request.json();
    const { key, value, project_id } = body;
    const projectId = project_id || '';
    const deny = await guardProject(env, request, projectId);
    if (deny) return deny;
    
    if (!key) return new Response(JSON.stringify({ error: 'key required' }), {
      status: 400, headers: { 'Content-Type': 'application/json', ...CORS }
    });
    
    await env.DB.prepare('CREATE TABLE IF NOT EXISTS security_settings (project_id TEXT, key TEXT NOT NULL, value TEXT, PRIMARY KEY (project_id, key))').run();
    const T = await getProjectTables(env.DB, projectId);
    await env.DB.prepare(`INSERT OR REPLACE INTO ${T.securitySettings} (project_id, key, value) VALUES (?, ?, ?)`).bind(projectId, key, String(value)).run();
    await env.DB.prepare('INSERT INTO activity_log (action, details) VALUES (?, ?)').bind('security_updated', key + ' = ' + value + ' (project: ' + (projectId || 'global') + ')').run();
    return new Response(JSON.stringify({ success: true }), {
      headers: { 'Content-Type': 'application/json', ...CORS }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: { 'Content-Type': 'application/json', ...CORS }
    });
  }
}
