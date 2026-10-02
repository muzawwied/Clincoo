// Cloudflare Pages Functions - Jina AI proxy (web reader & search)
// Reads JINA_API_KEY from D1 database. Replaces the external "veda" Base44 proxy.

export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    }
  });
}

async function getApiKey(env) {
  if (!env.DB) return null;
  try {
    const row = await env.DB.prepare('SELECT value FROM env_vars WHERE key = ?').bind('JINA_API_KEY').first();
    return row?.value || null;
  } catch {
    return null;
  }
}

export async function onRequestPost({ request, env }) {
  try {
    const JINA_API_KEY = await getApiKey(env);
    if (!JINA_API_KEY) {
      return new Response(JSON.stringify({ error: 'JINA_API_KEY not configured in database' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    const body = await request.json();
    const mode = body.mode || 'read';
    const query = body.query || '';

    if (mode === 'read') {
      // Read a URL and return markdown content
      const res = await fetch(`https://r.jina.ai/${query}`, {
        headers: {
          'Authorization': `Bearer ${JINA_API_KEY}`,
          'Accept': 'text/markdown',
          'X-Return-Format': 'markdown'
        }
      });
      const text = await res.text();
      return new Response(JSON.stringify({ text }), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    } else {
      // Search mode
      const res = await fetch(`https://s.jina.ai/${encodeURIComponent(query)}`, {
        headers: {
          'Authorization': `Bearer ${JINA_API_KEY}`,
          'Accept': 'application/json',
          'X-Respond-With': 'no-content'
        }
      });
      const data = await res.json();
      return new Response(JSON.stringify({ data }), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }
}
