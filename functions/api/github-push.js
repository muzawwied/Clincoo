// Cloudflare Pages Functions - Push project files to GitHub + trigger Cloudflare Pages deploy
import { getUserByToken, getToken } from './auth/shared.js';
// POST /api/github-push { project_id, repo (owner/name), branch, commit_message }

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

export async function onRequestOptions() {
  return new Response(null, { headers: CORS });
}

async function getGithubToken(env) {
  if (env.GITHUB_TOKEN) return env.GITHUB_TOKEN;
  const row = await env.DB.prepare('SELECT value FROM env_vars WHERE key = ?').bind('GITHUB_TOKEN').first();
  return row?.value || '';
}

function b64EncodeUnicode(str) {
  return btoa(unescape(encodeURIComponent(str || '')));
}

export async function onRequestPost({ request, env }) {
  const db = env.DB;
  if (!db) return new Response(JSON.stringify({ error: 'D1 not bound' }), { status: 500, headers: { 'Content-Type': 'application/json', ...CORS } });

  try {
    const body = await request.json();
    const projectId = body.project_id;
    if (!projectId) return new Response(JSON.stringify({ success: false, error: 'project_id required' }), { status: 400, headers: { 'Content-Type': 'application/json', ...CORS } });

    // Resolve repo/branch: from request body, or fall back to project_settings
    let repo = body.repo;
    let branch = body.branch || 'main';
    if (!repo) {
      const repoRow = await db.prepare('SELECT value FROM project_settings WHERE project_id = ? AND key = ?').bind(projectId, 'github_repo').first();
      repo = repoRow?.value || '';
    }
    if (!repo) {
      return new Response(JSON.stringify({ success: false, error: 'Repo GitHub belum diatur untuk proyek ini. Hubungkan repo dulu di pengaturan.' }), { status: 400, headers: { 'Content-Type': 'application/json', ...CORS } });
    }

    const token = await getGithubToken(env);
    if (!token) {
      return new Response(JSON.stringify({ success: false, error: 'GITHUB_TOKEN belum diatur' }), { status: 400, headers: { 'Content-Type': 'application/json', ...CORS } });
    }

    // Load project files from D1
    const filesRes = await db.prepare('SELECT path, content FROM project_files WHERE project_id = ?').bind(projectId).all();
    const files = filesRes.results || [];
    if (files.length === 0) {
      return new Response(JSON.stringify({ success: false, error: 'Tidak ada file untuk di-deploy. Simpan file terlebih dahulu.' }), { status: 400, headers: { 'Content-Type': 'application/json', ...CORS } });
    }

    const ghHeaders = {
      'Authorization': 'Bearer ' + token,
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'Clincoo',
      'Content-Type': 'application/json'
    };

    const results = [];
    for (const f of files) {
      const path = f.path.replace(/^\/+/, '');
      const getUrl = `https://api.github.com/repos/${repo}/contents/${encodeURIComponent(path).replace(/%2F/g, '/')}?ref=${branch}`;
      let sha = undefined;
      try {
        const getRes = await fetch(getUrl, { headers: ghHeaders });
        if (getRes.ok) {
          const getData = await getRes.json();
          sha = getData.sha;
        }
      } catch (e) {}

      const putUrl = `https://api.github.com/repos/${repo}/contents/${encodeURIComponent(path).replace(/%2F/g, '/')}`;
      const putBody = {
        message: body.commit_message || `Update ${path} via Clincoo workspace`,
        content: b64EncodeUnicode(f.content || ''),
        branch: branch
      };
      if (sha) putBody.sha = sha;

      const putRes = await fetch(putUrl, { method: 'PUT', headers: ghHeaders, body: JSON.stringify(putBody) });
      const putData = await putRes.json();
      results.push({ path, ok: putRes.ok, error: putRes.ok ? undefined : (putData.message || 'unknown error') });
    }

    const failedFiles = results.filter(r => !r.ok);
    const ghUser = await getUserByToken(env.DB, getToken(request)).catch(() => null);
    await db.prepare('INSERT INTO activity_log (action, details, user_id) VALUES (?, ?, ?)')
      .bind('deploy_triggered', `Push ke ${repo}@${branch}: ${results.length - failedFiles.length}/${results.length} file berhasil`, ghUser ? ghUser.id : null).run();
    await db.prepare('INSERT INTO deploy_logs (project_id, status, url, message) VALUES (?, ?, ?, ?)')
      .bind(projectId, failedFiles.length === 0 ? 'success' : 'partial', `https://github.com/${repo}`, `Push ${results.length - failedFiles.length}/${results.length} file`).run();

    return new Response(JSON.stringify({
      success: failedFiles.length === 0,
      pushed: results.length - failedFiles.length,
      total: results.length,
      failed: failedFiles,
      repo, branch
    }), { headers: { 'Content-Type': 'application/json', ...CORS } });
  } catch (err) {
    return new Response(JSON.stringify({ success: false, error: err.message }), { status: 500, headers: { 'Content-Type': 'application/json', ...CORS } });
  }
}
