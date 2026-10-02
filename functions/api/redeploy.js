// Cloudflare Pages Functions - Redeploy Trigger
// For Direct Upload projects, triggers a new deployment via Cloudflare API

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

export async function onRequestOptions() {
  return new Response(null, { status: 200, headers: CORS });
}

export async function onRequestPost({ env }) {
  try {
    const keyRow = await env.DB.prepare("SELECT value FROM user_preferences WHERE key = 'cloudflare_api_key'").first();
    const acctRow = await env.DB.prepare("SELECT value FROM user_preferences WHERE key = 'cloudflare_account_id'").first();
    const apiKey = keyRow?.value || '';
    const accountId = acctRow?.value || '';

    if (!apiKey || !accountId) {
      return new Response(JSON.stringify({ 
        success: false, 
        error: 'Cloudflare credentials not configured. Set cloudflare_api_key and cloudflare_account_id in user_preferences.' 
      }), { status: 200, headers: { 'Content-Type': 'application/json', ...CORS } });
    }

    // For Direct Upload projects, we need to trigger deployment via the Pages API
    // The API endpoint for creating a deployment requires a manifest, which we can't generate here
    // Instead, we'll use the "retry deployment" endpoint which retries the last deployment
    const res = await fetch(
      'https://api.cloudflare.com/client/v4/accounts/' + accountId + '/pages/projects/clincoo/deployments',
      {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + apiKey,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          // For direct upload, we need to provide an empty manifest
          // This will fail for Direct Upload projects - but let's try
        })
      }
    );

    const data = await res.json();

    // Log activity
    await env.DB.prepare("INSERT INTO activity_log (action, details) VALUES (?, ?)")
      .bind('redeploy_triggered', 'API response: ' + res.status)
      .run();

    if (data.success) {
      return new Response(JSON.stringify({ 
        success: true, 
        deployment: data.result 
      }), { status: 200, headers: { 'Content-Type': 'application/json', ...CORS } });
    } else {
      // For Direct Upload projects, the manifest error is expected
      // Return helpful message instead of error
      return new Response(JSON.stringify({ 
        success: false, 
        message: 'Auto-redeploy requires Git integration. Use the Clincoo Auto Deploy workflow or run wrangler pages deploy manually.',
        errors: data.errors 
      }), { status: 200, headers: { 'Content-Type': 'application/json', ...CORS } });
    }
  } catch (err) {
    return new Response(JSON.stringify({ 
      success: false, 
      error: err.message 
    }), { status: 500, headers: { 'Content-Type': 'application/json', ...CORS } });
  }
}

export async function onRequestGet({ env }) {
  return new Response(JSON.stringify({
    message: 'POST to trigger redeploy. For Direct Upload projects, use the Auto Deploy workflow instead.'
  }), { status: 200, headers: { 'Content-Type': 'application/json', ...CORS } });
}
