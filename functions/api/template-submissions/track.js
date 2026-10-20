// Cloudflare Pages Function — /api/template-submissions/track (publik)
// Pencatatan real-time pemakaian & kunjungan template komunitas di galeri:
//   POST { id, action: 'use' | 'view' }  → { ok, uses, views }
import { CORS as SHARED_CORS } from '../auth/shared.js';

const CORS = { ...SHARED_CORS, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' };

function json(data, status) {
  return new Response(JSON.stringify(data), { status: status || 200, headers: { 'Content-Type': 'application/json', ...CORS } });
}

export async function onRequestOptions() { return new Response(null, { status: 204, headers: CORS }); }

export async function onRequestPost({ request, env }) {
  const db = env.DB;
  if (!db) return json({ error: 'D1 not bound' }, 500);
  try {
    const body = await request.json();
    const id = parseInt(body.id, 10);
    const action = body.action === 'view' ? 'view' : 'use';
    if (!id) return json({ error: 'id wajib' }, 400);
    const col = action === 'view' ? 'views' : 'uses';
    await db.prepare(
      `UPDATE template_submissions SET ${col} = COALESCE(${col}, 0) + 1
       WHERE id = ? AND status = 'approved'`
    ).bind(id).run();
    const row = await db.prepare('SELECT uses, views FROM template_submissions WHERE id = ?').bind(id).first();
    return json({ ok: true, uses: (row && row.uses) || 0, views: (row && row.views) || 0 });
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}
