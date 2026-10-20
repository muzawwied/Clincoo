// Cloudflare Pages Functions - E2B API key proxy
// Reads E2B_API_KEY from D1 database and returns it for the client to use.
// Replaces the external "veda" Base44 proxy.

export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    }
  });
}

export async function onRequestGet({ env }) {
  try {
    if (!env.DB) {
      return new Response(JSON.stringify({ error: 'Database not available' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }
    const row = await env.DB.prepare('SELECT value FROM env_vars WHERE key = ?').bind('E2B_API_KEY').first();
    const apiKey = row?.value || '';
    return new Response(JSON.stringify({ apiKey }), {
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message, apiKey: '' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }
}
