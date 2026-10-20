import { getProjectTables } from './_tables.js';
import { guardProject } from './user-scope.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
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
    const limit = parseInt(url.searchParams.get('limit') || '20', 10);

    let rows;
    if (projectId) {
      const T = await getProjectTables(env.DB, projectId);
      rows = await env.DB.prepare(`SELECT * FROM ${T.deployLogs} WHERE project_id = ? ORDER BY created_at DESC LIMIT ?`).bind(projectId, limit).all();
    } else {
      rows = await env.DB.prepare('SELECT * FROM deploy_logs ORDER BY created_at DESC LIMIT ?').bind(limit).all();
    }

    return new Response(JSON.stringify({ logs: rows.results }), {
      headers: { 'Content-Type': 'application/json', ...CORS }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: { 'Content-Type': 'application/json', ...CORS }
    });
  }
}
