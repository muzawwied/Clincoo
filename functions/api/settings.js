// Cloudflare Pages Functions - General App Settings Backend
// Pengaturan umum: per-proyek (tabel p_*) jika ada project_id, global jika tidak.

import { getProjectTables } from './_tables.js';
import { guardProject } from './user-scope.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

export async function onRequestOptions() {
  return new Response(null, { headers: CORS });
}

// GET /api/settings — get all general settings + live stats
export async function onRequestGet({ request, env }) {
  const db = env.DB;
  if (!db) return new Response(JSON.stringify({ error: 'D1 not bound' }), { status: 500, headers: { 'Content-Type': 'application/json', ...CORS } });

  try {
    await db.prepare('CREATE TABLE IF NOT EXISTS user_preferences (key TEXT PRIMARY KEY, value TEXT)').run();

    const defaults = {
      app_name: '',
      app_description: '',
      runtime: 'Static HTML/JS/CSS',
      maintenance_mode: 'false',
      default_branch: 'main',
      auto_deploy: 'true',
      framework_preset: 'Static'
    };

    const settingKeys = Object.keys(defaults);
    const rows = await db.prepare(`SELECT key, value FROM user_preferences WHERE key IN (${settingKeys.map(() => '?').join(',')})`).bind(...settingKeys).all();
    
    const data = { ...defaults };
    for (const row of rows.results || []) {
      data[row.key] = row.value;
    }

    // If project_id provided, load project name/description from projects table
    const url = new URL(request.url);
    const projectId = url.searchParams.get('project_id') || '';
    const deny = await guardProject(env, request, projectId);
    if (deny) return deny;
    if (projectId) {
      // Kunci umum per-proyek menimpa nilai global
      try {
        const T = await getProjectTables(db, projectId);
        const pRows = await db.prepare(`SELECT key, value FROM ${T.projectSettings} WHERE project_id = ? AND key IN (${settingKeys.map(() => '?').join(',')})`).bind(projectId, ...settingKeys).all();
        for (const row of pRows.results || []) {
          if (row.key !== 'app_name' && row.key !== 'app_description') data[row.key] = row.value;
        }
      } catch (e) {}
      try {
        const proj = await db.prepare('SELECT name, description FROM projects WHERE id = ?').bind(projectId).first();
        if (proj) {
          data.app_name = proj.name || '';
          data.app_description = proj.description || '';
        } else {
          data.app_name = '';
          data.app_description = '';
        }
      } catch(e) {
        data.app_name = '';
        data.app_description = '';
      }
    }

    let stats = { projects: 1, deploys: 0, chatSessions: 0, envVars: 0 };
    if (projectId) {
      // Statistik dari tabel milik proyek ini (bukan tabel bersama)
      try {
        const T = await getProjectTables(db, projectId);
        stats.deploys = (await db.prepare(`SELECT COUNT(*) as c FROM ${T.deployLogs}`).first())?.c || 0;
        stats.envVars = (await db.prepare(`SELECT COUNT(*) as c FROM ${T.envVars}`).first())?.c || 0;
        stats.chatSessions = (await db.prepare(`SELECT COUNT(*) as c FROM ${T.sessions}`).first())?.c || 0;
      } catch (e) {}
    } else {
      try { const r = await db.prepare('SELECT COUNT(*) as c FROM projects').first(); stats.projects = r?.c || 0; } catch(e) {}
      try { const r = await db.prepare('SELECT COUNT(*) as c FROM deploy_logs').first(); stats.deploys = r?.c || 0; } catch(e) {}
      try { const r = await db.prepare('SELECT COUNT(*) as c FROM chat_sessions').first(); stats.chatSessions = r?.c || 0; } catch(e) {}
      try { const r = await db.prepare('SELECT COUNT(*) as c FROM env_vars').first(); stats.envVars = r?.c || 0; } catch(e) {}
    }
    return new Response(JSON.stringify({ settings: data, stats }), {
      headers: { 'Content-Type': 'application/json', ...CORS }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { 'Content-Type': 'application/json', ...CORS } });
  }
}

// POST /api/settings — update settings
export async function onRequestPost({ request, env }) {
  const db = env.DB;
  if (!db) return new Response(JSON.stringify({ error: 'D1 not bound' }), { status: 500, headers: { 'Content-Type': 'application/json', ...CORS } });

  try {
    await db.prepare('CREATE TABLE IF NOT EXISTS user_preferences (key TEXT PRIMARY KEY, value TEXT)').run();
    
    const body = await request.json();
    const allowedKeys = ['app_name', 'app_description', 'runtime', 'maintenance_mode', 'default_branch', 'auto_deploy', 'framework_preset'];
    
    const updates = {};
    for (const [key, value] of Object.entries(body)) {
      if (allowedKeys.includes(key)) {
        updates[key] = String(value);
      }
    }

    const projectId = body.project_id || '';
    const deny = await guardProject(env, request, projectId);
    if (deny) return deny;
    if (projectId && (updates.app_name || updates.app_description)) {
      try {
        const existing = await db.prepare('SELECT id FROM projects WHERE id = ?').bind(projectId).first();
        if (existing) {
          if (updates.app_name) await db.prepare('UPDATE projects SET name = ?, updated_at = datetime(\'now\') WHERE id = ?').bind(updates.app_name, projectId).run();
          if (updates.app_description) await db.prepare('UPDATE projects SET description = ?, updated_at = datetime(\'now\') WHERE id = ?').bind(updates.app_description, projectId).run();
        } else {
          await db.prepare('INSERT INTO projects (id, name, description) VALUES (?, ?, ?)').bind(projectId, updates.app_name || '', updates.app_description || '').run();
        }
      } catch(e) {}
    }

    if (projectId) {
      // Simpan per-proyek — tidak menulis ke tabel global
      try {
        const T = await getProjectTables(db, projectId);
        for (const [key, value] of Object.entries(updates)) {
          await db.prepare(`INSERT INTO ${T.projectSettings} (project_id, key, value) VALUES (?, ?, ?) ON CONFLICT(project_id, key) DO UPDATE SET value = excluded.value`).bind(projectId, key, value).run();
        }
      } catch (e) {}
    } else {
      for (const [key, value] of Object.entries(updates)) {
        await db.prepare("INSERT INTO user_preferences (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(key, value).run();
      }
    }

    // Log activity
    const changedKeys = Object.keys(updates);
    if (changedKeys.length > 0) {
      try {
        await db.prepare("INSERT INTO activity_log (action, details) VALUES (?, ?)").bind('settings_update', JSON.stringify(updates)).run();
      } catch(e) {}

      // Create notifications for important changes
      if ('maintenance_mode' in updates) {
        const msg = updates.maintenance_mode === 'true' 
          ? 'Mode pemeliharaan diaktifkan — akses publik ditutup sementara'
          : 'Mode pemeliharaan dinonaktifkan — aplikasi kembali online';
        try {
          await db.prepare("INSERT INTO notifications (source, message) VALUES (?, ?)").bind('Sistem', msg).run();
        } catch(e) {}
      }
      if ('app_name' in updates) {
        try {
          await db.prepare("INSERT INTO notifications (source, message) VALUES (?, ?)").bind('Sistem', `Nama aplikasi diubah ke "${updates.app_name}"`).run();
        } catch(e) {}
      }
    }

    return new Response(JSON.stringify({ success: true, updated: updates }), {
      headers: { 'Content-Type': 'application/json', ...CORS }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { 'Content-Type': 'application/json', ...CORS } });
  }
}
