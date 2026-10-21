// TEMP diagnostik — HAPUS setelah dipakai.
const TOKEN = '090d4fa9db7b7a1a5cd7fdc4355926f7';
export async function onRequestPost({ request, env }) {
  const url = new URL(request.url);
  if (url.searchParams.get('t') !== TOKEN) return new Response('no', { status: 401 });
  if (!env.DB) return Response.json({ error: 'no DB' });
  try {
    const logs = await env.DB.prepare('SELECT * FROM ai_router_logs ORDER BY id DESC LIMIT 4').all();
    const msgs = await env.DB.prepare("SELECT session_id, role, model, substr(content,1,35) AS c, created_at FROM chat_messages WHERE content LIKE '%PENANDA-KYQ99%' OR session_id LIKE 'ls_179255%' ORDER BY id DESC LIMIT 5").all();
    return Response.json({ logs: (logs.results || []).map(r => JSON.stringify(r).slice(0, 220)), msgs: (msgs.results || []) });
  } catch (e) { return Response.json({ error: String(e && e.message || e).slice(0, 300) }); }
}
