// Cloudflare Pages Functions - Security Events Feed
// Sumber data notifikasi keamanan halaman Pengaturan > Keamanan.
// Membaca tabel security_events (diisi _middleware: pemblokiran scanner,
// rate-limit, origin jahat, dsb.). Semua request wajib login + guard
// kepemilikan proyek. Kolom email tidak disajikan (bisa berisi data akun).
import { guardProject } from './user-scope.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

function j(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', ...CORS }
  });
}

export async function onRequestOptions() {
  return new Response(null, { headers: CORS });
}

export async function onRequestGet({ request, env }) {
  try {
    const db = env.DB;
    if (!db) return j({ error: 'D1 database not bound' }, 500);
    const url = new URL(request.url);
    const projectId = url.searchParams.get('project_id') || '';
    const deny = await guardProject(env, request, projectId);
    if (deny) return deny;

    await db.prepare(`CREATE TABLE IF NOT EXISTS security_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      ip TEXT,
      email TEXT,
      detail TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )`).run();

    const res = await db.prepare(
      'SELECT id, type, ip, detail, created_at FROM security_events ORDER BY id DESC LIMIT 50'
    ).all();

    const events = (res.results || []).map(r => ({
      id: r.id,
      title: r.type ? String(r.type).replace(/_/g, ' ').toUpperCase() : 'Notifikasi Keamanan',
      detail: r.detail || '',
      created_at: r.created_at,
      ip: r.ip || ''
    }));
    return j({ events });
  } catch (err) {
    return j({ error: err.message }, 500);
  }
}
