import { getProjectTables, tableFor } from './_tables.js';
import { guardProject } from './user-scope.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

export async function onRequestOptions() {
  return new Response(null, { headers: CORS });
}

export async function onRequestGet({ request, env }) {
  try {
    const url = new URL(request.url);
    const projectId = url.searchParams.get('project_id') || '';
    const deny = await guardProject(env, request, projectId);
    if (deny) return deny;
    
    let rows;
    if (projectId) {
      const T = await getProjectTables(env.DB, projectId);
      rows = await env.DB.prepare(`SELECT id, project_id, key, value, is_secret, created_at, updated_at FROM ${T.envVars} WHERE project_id = ? ORDER BY created_at DESC`).bind(projectId).all();
    } else {
      // Tanpa project_id: hanya tampilkan variabel global (bukan milik proyek lain)
      rows = await env.DB.prepare("SELECT id, project_id, key, value, is_secret, created_at, updated_at FROM env_vars WHERE project_id IS NULL OR project_id = '' ORDER BY created_at DESC").all();
    }
    const vars = rows.results.map(r => ({ ...r, value: r.is_secret ? '••••••••' : r.value }));
    return new Response(JSON.stringify({ env_vars: vars }), {
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
    const body = await request.json();
    const key = body.key;
    const value = body.value;
    const is_secret = body.is_secret ? 1 : 0;
    const projectId = body.project_id || '';
    const deny = await guardProject(env, request, projectId);
    if (deny) return deny;
    
    if (!key || value === undefined) {
      return new Response(JSON.stringify({ error: 'key and value required' }), {
        status: 400, headers: { 'Content-Type': 'application/json', ...CORS }
      });
    }
    
    // Check if key already exists for this project
    const T = await getProjectTables(env.DB, projectId);
    let existing;
    if (projectId) {
      existing = await env.DB.prepare(`SELECT id FROM ${T.envVars} WHERE key = ? AND project_id = ?`).bind(key, projectId).first();
    } else {
      existing = await env.DB.prepare('SELECT id FROM env_vars WHERE key = ? AND (project_id IS NULL OR project_id = ?)').bind(key, '').first();
    }
    
    if (existing) {
      await env.DB.prepare(`UPDATE ${T.envVars} SET value = ?, is_secret = ?, updated_at = datetime(\'now\') WHERE id = ?`)
        .bind(value, is_secret, existing.id).run();
    } else {
      await env.DB.prepare(`INSERT INTO ${T.envVars} (project_id, key, value, is_secret) VALUES (?, ?, ?, ?)`)
        .bind(projectId, key, value, is_secret).run();
    }
    
    await env.DB.prepare('INSERT INTO activity_log (action, details) VALUES (?, ?)').bind('env_var_added', 'Added: ' + key + ' (project: ' + (projectId || 'global') + ')').run();
    return new Response(JSON.stringify({ success: true }), {
      headers: { 'Content-Type': 'application/json', ...CORS }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: { 'Content-Type': 'application/json', ...CORS }
    });
  }
}

export async function onRequestDelete({ request, env }) {
  try {
    const url = new URL(request.url);
    const id = url.searchParams.get('id');
    const key = url.searchParams.get('key');
    if (!id && !key) {
      return new Response(JSON.stringify({ error: 'id or key required' }), {
        status: 400, headers: { 'Content-Type': 'application/json', ...CORS }
      });
    }
    const projectId = url.searchParams.get('project_id') || '';
    const deny = await guardProject(env, request, projectId);
    if (deny) return deny;
    if (projectId) {
      // Dibatasi ke tabel proyek ini saja — tidak boleh menyentuh data proyek lain
      const T = await getProjectTables(env.DB, projectId);
      if (id) {
        await env.DB.prepare(`DELETE FROM ${T.envVars} WHERE id = ?`).bind(id).run();
      } else {
        await env.DB.prepare(`DELETE FROM ${T.envVars} WHERE key = ?`).bind(key).run();
      }
    } else if (id) {
      const r = await env.DB.prepare('DELETE FROM env_vars WHERE id = ?').bind(id).run();
      if (!r.meta || !r.meta.changes) {
        // tidak ada di tabel global: cari di tabel env_vars milik proyek
        const tbls = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name GLOB 'p_*_env_vars'").all();
        for (const row of tbls.results || []) {
          const rr = await env.DB.prepare(`DELETE FROM ${row.name} WHERE id = ?`).bind(id).run();
          if (rr.meta && rr.meta.changes) break;
        }
      }
    } else {
      await env.DB.prepare('DELETE FROM env_vars WHERE key = ?').bind(key).run();
      const tbls = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name GLOB 'p_*_env_vars'").all();
      for (const row of tbls.results || []) {
        await env.DB.prepare(`DELETE FROM ${row.name} WHERE key = ?`).bind(key).run();
      }
    }
    await env.DB.prepare('INSERT INTO activity_log (action, details) VALUES (?, ?)').bind('env_var_deleted', 'Deleted: ' + (key || 'id:' + id)).run();
    return new Response(JSON.stringify({ success: true }), {
      headers: { 'Content-Type': 'application/json', ...CORS }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: { 'Content-Type': 'application/json', ...CORS }
    });
  }
}
