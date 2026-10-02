// Cloudflare Pages Functions — /api/mcp : Server MCP per proyek Clincoo.
// Endpoint yang dipakai AI luar (Claude, ChatGPT, Cursor, dll) untuk mengakses
// workspace proyek secara real-time via Model Context Protocol (Streamable HTTP,
// stateless: satu POST = satu JSON-RPC message, respons application/json).
//
// Autentikasi: token MCP per proyek (diterbitkan di Pengaturan > Server MCP,
// disimpan di project_settings: mcp_token). Boleh via header
// "Authorization: Bearer <token>" atau query ?token=<token>.
// Izin akses (scopes): read / write / delete — dipatuhi per tool.
//
// Path ini WAJIB masuk daftar PUBLIC di _middleware.js (klien AI luar tidak
// punya sesi login Clincoo; autentikasi dilakukan sendiri oleh handler ini).

import { getProjectTables, tableSuffix } from './_tables.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-MCP-Token, Mcp-Session-Id',
  'Access-Control-Expose-Headers': 'Mcp-Session-Id'
};
const jsonHeaders = { 'Content-Type': 'application/json', ...CORS };
function json(data, status) {
  return new Response(JSON.stringify(data), { status: status || 200, headers: jsonHeaders });
}
function rpcResult(id, result) {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), { headers: jsonHeaders });
}
function rpcError(id, code, message) {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }), { headers: jsonHeaders });
}

// ---------- validasi path file ----------
function safePath(p) {
  const s = String(p || '').trim();
  if (!s || s.length > 200) return null;
  if (s.startsWith('/') || s.includes('\\') || s.includes('..')) return null;
  if (/[\x00-\x1f]/.test(s)) return null;
  return s.replace(/^\/+/, '');
}

// ---------- baca state MCP per proyek ----------
async function readMcpState(db, projectId) {
  const T = await getProjectTables(db, projectId);
  try {
    await db.prepare(`CREATE TABLE IF NOT EXISTS ${T.projectSettings} (
      key TEXT, project_id TEXT, value TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(project_id, key)
    )`).run();
    await db.prepare(`CREATE TABLE IF NOT EXISTS ${T.files} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL,
      path TEXT NOT NULL,
      content TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(project_id, path)
    )`).run();
  } catch (e) {}
  const rows = await db.prepare(`SELECT key, value FROM ${T.projectSettings} WHERE project_id = ? AND key IN ('mcp_token','mcp_scopes','mcp_active')`)
    .bind(projectId).all();
  const m = {};
  (rows.results || []).forEach(r => { m[r.key] = r.value; });
  if (!m.mcp_token) return null;
  let scopes = { read: true, write: false, delete: false };
  try {
    const o = JSON.parse(m.mcp_scopes || '{}');
    scopes = { read: o.read !== false, write: o.write === true, delete: o.delete === true };
  } catch (e) {}
  return { token: m.mcp_token, scopes };
}

// ---------- definisi tool ----------
const TOOLS = [
  { name: 'list_items', scope: 'read', desc: 'Daftar file & folder workspace proyek. Opsi: path (prefix folder, mis. "src").',
    input: { type: 'object', properties: { path: { type: 'string', description: 'Filter prefix folder (opsional)' } } } },
  { name: 'read_file', scope: 'read', desc: 'Baca isi satu file workspace.',
    input: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'search_items', scope: 'read', desc: 'Cari file berdasarkan nama path atau isi (maks 30 hasil).',
    input: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  { name: 'write_file', scope: 'write', desc: 'Buat/timpa satu file di workspace.',
    input: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path'] } },
  { name: 'write_files', scope: 'write', desc: 'Buat/timpa banyak file sekaligus (maks 60).',
    input: { type: 'object', properties: { files: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path'] } } }, required: ['files'] } },
  { name: 'create_folder', scope: 'write', desc: 'Buat folder kosong di workspace.',
    input: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'rename_item', scope: 'write', desc: 'Ganti nama file/folder (beserta isinya bila folder).',
    input: { type: 'object', properties: { path: { type: 'string' }, new_name: { type: 'string' } }, required: ['path', 'new_name'] } },
  { name: 'delete_item', scope: 'delete', desc: 'Hapus file (beserta isi folder bila path folder).',
    input: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }
];

async function upsertFile(db, T, projectId, path, content) {
  await db.prepare(`INSERT INTO ${T.files} (project_id, path, content, updated_at) VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(project_id, path) DO UPDATE SET content = excluded.content, updated_at = datetime('now')`)
    .bind(projectId, path, content == null ? '' : String(content)).run();
}

// ---------- eksekusi tool_call ----------
async function callTool(env, projectId, scopes, name, args) {
  const db = env.DB;
  const T = await getProjectTables(db, projectId);
  const a = args || {};
  const tool = TOOLS.find(t => t.name === name);
  if (!tool) return { isError: true, content: [{ type: 'text', text: 'Tool tidak dikenal: ' + name + '. Panggil tools/list untuk daftar tool.' }] };
  if (!scopes[tool.scope]) return { isError: true, content: [{ type: 'text', text: `Izin "${tool.scope}" tidak aktif untuk token MCP ini. Aktifkan di Clincoo: Pengaturan > Server MCP.` }] };

  if (name === 'list_items') {
    const prefix = a.path ? safePath(a.path) : '';
    if (a.path && prefix === null) return err('Path tidak valid.');
    const rows = await db.prepare(`SELECT path, LENGTH(COALESCE(content,'')) AS size FROM ${T.files} WHERE project_id = ? AND path LIKE ? ORDER BY path ASC LIMIT 500`)
      .bind(projectId, prefix ? prefix.replace(/\/?$/, '/') + '%' : '%').all();
    const items = (rows.results || []).map(r => ({ path: r.path, type: String(r.path).endsWith('/') ? 'folder' : 'file', size: r.size }));
    return ok(JSON.stringify({ count: items.length, items }, null, 2));
  }
  if (name === 'read_file') {
    const p = safePath(a.path);
    if (!p) return err('Parameter path wajib dan harus valid.');
    const row = await db.prepare(`SELECT path, content, updated_at FROM ${T.files} WHERE project_id = ? AND path = ?`).bind(projectId, p).first();
    if (!row) return err('File tidak ditemukan: ' + p);
    return ok(row.content || '');
  }
  if (name === 'search_items') {
    const q = String(a.query || '').slice(0, 100);
    const like = '%' + q.replace(/[%_]/g, '') + '%';
    const rows = await db.prepare(`SELECT path, SUBSTR(COALESCE(content,''), 1, 400) AS preview FROM ${T.files}
      WHERE project_id = ? AND (path LIKE ? OR content LIKE ?) ORDER BY path ASC LIMIT 30`).bind(projectId, like, like).all();
    return ok(JSON.stringify({ query: q, count: (rows.results || []).length, results: rows.results || [] }, null, 2));
  }
  if (name === 'write_file') {
    const p = safePath(a.path);
    if (!p || p.endsWith('/')) return err('Parameter path wajib (nama file, bukan folder).');
    await upsertFile(db, T, projectId, p, a.content);
    return ok('Berhasil menulis: ' + p);
  }
  if (name === 'write_files') {
    const files = Array.isArray(a.files) ? a.files.slice(0, 60) : [];
    if (!files.length) return err('Parameter files wajib array [{path, content}].');
    let n = 0; const errs = [];
    for (const f of files) {
      const p = safePath(f && f.path);
      if (!p || p.endsWith('/')) { errs.push({ path: f && f.path, error: 'path tidak valid' }); continue; }
      await upsertFile(db, T, projectId, p, f && f.content);
      n++;
    }
    return ok(JSON.stringify({ written: n, failed: errs.length, errors: errs }));
  }
  if (name === 'create_folder') {
    let p = safePath(a.path);
    if (!p) return err('Parameter path wajib.');
    p = p.replace(/\/?$/, '/');
    await upsertFile(db, T, projectId, p, '');
    return ok('Folder dibuat: ' + p);
  }
  if (name === 'rename_item') {
    const p = safePath(a.path);
    const newName = String(a.new_name || '').trim();
    if (!p || !newName || newName.includes('/')) return err('Parameter path dan new_name wajib (new_name tanpa "/").');
    const row = await db.prepare(`SELECT content FROM ${T.files} WHERE project_id = ? AND path = ?`).bind(projectId, p).first();
    if (row) {
      const newPath = p.includes('/') ? p.slice(0, p.lastIndexOf('/') + 1) + newName : newName;
      const dupe = await db.prepare(`SELECT 1 FROM ${T.files} WHERE project_id = ? AND path = ?`).bind(projectId, newPath).first();
      if (dupe) return err('Nama "' + newName + '" sudah dipakai di folder yang sama.');
      await upsertFile(db, T, projectId, newPath, row.content);
      await db.prepare(`DELETE FROM ${T.files} WHERE project_id = ? AND path = ?`).bind(projectId, p).run();
      return ok('Renamed: ' + p + ' -> ' + newPath);
    }
    // folder? rename semua row berprefix p + '/'
    const folder = p.replace(/\/?$/, '/');
    const kids = await db.prepare(`SELECT path, content FROM ${T.files} WHERE project_id = ? AND (path = ? OR path LIKE ?)`)
      .bind(projectId, folder, folder + '%').all();
    const list = kids && kids.results ? kids.results : [];
    if (!list.length) return err('Item tidak ditemukan: ' + p);
    const newPrefix = folder.slice(0, folder.length - 1).split('/').slice(0, -1).join('/');
    const newFolder = (newPrefix ? newPrefix + '/' : '') + newName + '/';
    for (const k of list) {
      const np = newFolder + k.path.slice(folder.length);
      await upsertFile(db, T, projectId, np, k.content);
      await db.prepare(`DELETE FROM ${T.files} WHERE project_id = ? AND path = ?`).bind(projectId, k.path).run();
    }
    return ok('Folder renamed: ' + folder + ' -> ' + newFolder);
  }
  if (name === 'delete_item') {
    const p = safePath(a.path);
    if (!p) return err('Parameter path wajib.');
    const row = await db.prepare(`SELECT 1 FROM ${T.files} WHERE project_id = ? AND path = ?`).bind(projectId, p).first();
    if (row) {
      await db.prepare(`DELETE FROM ${T.files} WHERE project_id = ? AND path = ?`).bind(projectId, p).run();
      return ok('Terhapus: ' + p);
    }
    const folder = p.replace(/\/?$/, '/');
    const r2 = await db.prepare(`DELETE FROM ${T.files} WHERE project_id = ? AND (path = ? OR path LIKE ?)`)
      .bind(projectId, folder, folder + '%').run();
    if (!r2.meta || !r2.meta.changes) return err('Item tidak ditemukan: ' + p);
    return ok('Terhapus (folder + isi): ' + folder + ' (' + r2.meta.changes + ' item)');
  }
  return err('Tool belum didukung.');
}
function ok(text) { return { content: [{ type: 'text', text }] }; }
function err(text) { return { isError: true, content: [{ type: 'text', text }] }; }

// ---------- HTTP handlers ----------
export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const projectId = url.searchParams.get('project_id') || '';
  const token = url.searchParams.get('token') || bearer(request);
  let active = false;
  if (env.DB && projectId && token) {
    try {
      const st = await readMcpState(env.DB, projectId);
      active = !!(st && st.token === token);
    } catch (e) {}
  }
  return json({
    name: 'clincoo-mcp', version: '1.0.0',
    protocol: 'Streamable HTTP (stateless JSON-RPC 2.0)',
    project_id: projectId, token_valid: active,
    usage: 'POST JSON-RPC ke endpoint ini dengan header "Authorization: Bearer <token MCP>. Method: initialize, tools/list, tools/call.'
  });
}

export async function onRequestPost({ request, env }) {
  if (!env.DB) return json({ error: 'D1 not bound' }, 500);
  const url = new URL(request.url);
  const projectId = url.searchParams.get('project_id') || '';
  let body = {};
  try { body = await request.json(); } catch (e) {}
  if (!projectId) return json({ error: 'Parameter project_id wajib (mis. /api/mcp?project_id=<id>).', jsonrpc: '2.0', id: body.id ?? null, error: { code: -32602, message: 'project_id wajib' } }, 400);

  // auth: Bearer token atau ?token=
  const token = bearer(request) || url.searchParams.get('token') || '';
  if (!token) return json({ error: 'Token MCP wajib (header Authorization: Bearer <token> atau ?token=).' }, 401);
  let state;
  try { state = await readMcpState(env.DB, projectId); } catch (e) { return json({ error: 'Gagal membaca konfigurasi proyek.' }, 500); }
  if (!state || state.token !== token) return json({ error: 'Token MCP tidak valid untuk proyek ini. Buat ulang di Clincoo: Pengaturan > Server MCP.' }, 401);

  const method = String(body.method || '');
  const id = body.id ?? null;

  // notifikasi (tanpa id) -> jawab 202 tanpa body JSON-RPC
  if (id === null) return new Response(null, { status: 202, headers: { ...CORS } });

  if (method === 'initialize') {
    return rpcResult(id, {
      protocolVersion: body.params && body.params.protocolVersion === '2024-11-05' ? '2024-11-05' : '2025-06-18',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'clincoo-project', version: '1.0.0', title: 'Clincoo Project Workspace (' + tableSuffix(projectId) + ')' }
    });
  }
  if (method === 'ping') return rpcResult(id, {});
  if (method === 'tools/list') {
    return rpcResult(id, { tools: TOOLS.map(t => ({ name: t.name, description: t.desc + ' [izin: ' + t.scope + '; aktif: ' + (state.scopes[t.scope] ? 'ya' : 'tidak') + ']', inputSchema: t.input })) });
  }
  if (method === 'tools/call') {
    const name = body.params && body.params.name;
    const args = (body.params && body.params.arguments) || {};
    try {
      const result = await callTool(env, projectId, state.scopes, name, args);
      return rpcResult(id, result);
    } catch (e) {
      return rpcResult(id, { isError: true, content: [{ type: 'text', text: 'Error server: ' + (e && e.message ? e.message : String(e)) }] });
    }
  }
  return rpcError(id, -32601, 'Method tidak dikenal: ' + method + '. Didukung: initialize, notifications/initialized, ping, tools/list, tools/call.');
}

function bearer(request) {
  const h = request.headers.get('authorization') || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : '';
}
