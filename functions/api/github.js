const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

// Cloudflare Pages Functions - GitHub API proxy
// Allows Clincoo to import/read repo code files securely

export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    }
  });
}

export async function onRequestGet({ request, env }) {
  try {
    let GITHUB_TOKEN = env.GITHUB_TOKEN;
    if (!GITHUB_TOKEN && env.DB) {
      try {
        const row = await env.DB.prepare('SELECT value FROM env_vars WHERE key = ?').bind('GITHUB_TOKEN').first();
        GITHUB_TOKEN = row?.value || '';
      } catch {}
    }
    if (!GITHUB_TOKEN) {
      return new Response(JSON.stringify({ error: 'GITHUB_TOKEN not configured' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...CORS }
      });
    }

    const url = new URL(request.url);
    const action = url.searchParams.get('action') || 'repos';

    if (action === 'repos') {
      // List user's repositories
      const res = await fetch('https://api.github.com/user/repos?sort=updated&per_page=30', {
        headers: {
          'Authorization': 'Bearer ' + GITHUB_TOKEN,
          'Accept': 'application/vnd.github.v3+json',
          'User-Agent': 'Clincoo'
        }
      });
      const data = await res.json();
      const repos = data.map(r => ({
        id: r.id,
        name: r.full_name,
        private: r.private,
        language: r.language,
        url: r.html_url,
        description: r.description,
        updated: r.updated_at,
        default_branch: r.default_branch
      }));
      return new Response(JSON.stringify({ repos }), {
        headers: { 'Content-Type': 'application/json', ...CORS }
      });
    }

    if (action === 'tree') {
      // Get repo file tree
      const repo = url.searchParams.get('repo');
      const branch = url.searchParams.get('branch') || 'main';
      if (!repo) {
        return new Response(JSON.stringify({ error: 'repo parameter required' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', ...CORS }
        });
      }
      const res = await fetch(`https://api.github.com/repos/${repo}/git/trees/${branch}?recursive=1`, {
        headers: {
          'Authorization': 'Bearer ' + GITHUB_TOKEN,
          'Accept': 'application/vnd.github.v3+json',
          'User-Agent': 'Clincoo'
        }
      });
      const data = await res.json();
      const files = (data.tree || []).filter(f => f.type === 'blob').map(f => ({
        path: f.path,
        size: f.size
      }));
      return new Response(JSON.stringify({ files }), {
        headers: { 'Content-Type': 'application/json', ...CORS }
      });
    }

    if (action === 'file') {
      // Get file content
      const repo = url.searchParams.get('repo');
      const path = url.searchParams.get('path');
      const branch = url.searchParams.get('branch') || 'main';
      if (!repo || !path) {
        return new Response(JSON.stringify({ error: 'repo and path parameters required' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', ...CORS }
        });
      }
      const res = await fetch(`https://api.github.com/repos/${repo}/contents/${path}?ref=${branch}`, {
        headers: {
          'Authorization': 'Bearer ' + GITHUB_TOKEN,
          'Accept': 'application/vnd.github.v3+json',
          'User-Agent': 'Clincoo'
        }
      });
      const data = await res.json();
      let content = '';
      if (data.content && data.encoding === 'base64') {
        content = atob(data.content.replace(/\n/g, ''));
      }
      return new Response(JSON.stringify({
        name: data.name,
        path: data.path,
        size: data.size,
        content: content,
        language: data.name.split('.').pop()
      }), {
        headers: { 'Content-Type': 'application/json', ...CORS }
      });
    }

    if (action === 'commits') {
      // Get recent commits
      const repo = url.searchParams.get('repo');
      if (!repo) {
        return new Response(JSON.stringify({ error: 'repo parameter required' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', ...CORS }
        });
      }
      const res = await fetch(`https://api.github.com/repos/${repo}/commits?per_page=10`, {
        headers: {
          'Authorization': 'Bearer ' + GITHUB_TOKEN,
          'Accept': 'application/vnd.github.v3+json',
          'User-Agent': 'Clincoo'
        }
      });
      const data = await res.json();
      const commits = data.map(c => ({
        sha: c.sha.substring(0, 7),
        message: c.commit.message.substring(0, 100),
        author: c.commit.author.name,
        date: c.commit.author.date
      }));
      return new Response(JSON.stringify({ commits }), {
        headers: { 'Content-Type': 'application/json', ...CORS }
      });
    }

    return new Response(JSON.stringify({ error: 'Unknown action' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', ...CORS }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...CORS }
    });
  }
}
