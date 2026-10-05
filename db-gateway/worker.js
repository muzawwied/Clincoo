// clinqoo-db-gateway — Worker Cloudflare (akun Vylonium a393)
// Gateway database virtual untuk aplikasi user Clincoo/Clinqoo.
// Dipanggil HANYA oleh backend produksi (clincoo-be2) pakai bearer secret DB_GATEWAY_KEY.
// Kenapa terpisah: beban query database user JANGAN menyentuh D1 produksi
// (limit harian D1 free plan 5jt row reads — pernah kena blokir 2026-10).
// Data tiap proyek = tabel fisik t_<project>_<table> di D1 clinqoo-appdb.

const JSONH = { 'Content-Type': 'application/json' };
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: JSONH });

// Batas database per paket (nama paket dikirim be2 dari subscription D1 produksi)
const PLAN_DB_LIMITS = {
  Starter: { tables: 2, rows: 500, writesDay: 200 },
  Pro: { tables: 10, rows: 10000, writesDay: 2000 },
  Bisnis: { tables: 50, rows: 100000, writesDay: 20000 }
};
const limits = (plan) => PLAN_DB_LIMITS[plan] || PLAN_DB_LIMITS.Starter;

const TYPES = { text: 'TEXT', number: 'REAL', boolean: 'INTEGER', date: 'TEXT' };
const slug = (s) => String(s || '').toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
const physical = (pid, name) => 't_' + slug(pid) + '_' + slug(name);

async function ensureCatalog(db) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS db_catalog (
    project_id TEXT NOT NULL, name TEXT NOT NULL, columns_json TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')), PRIMARY KEY (project_id, name)
  )`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS db_usage (
    project_id TEXT NOT NULL, day TEXT NOT NULL, writes INTEGER DEFAULT 0,
    PRIMARY KEY (project_id, day)
  )`).run();
}

async function bumpUsage(db, projectId) {
  const day = new Date().toISOString().slice(0, 10);
  await db.prepare(
    `INSERT INTO db_usage (project_id, day, writes) VALUES (?, ?, 1)
     ON CONFLICT (project_id, day) DO UPDATE SET writes = writes + 1`
  ).bind(projectId, day).run();
}

async function usageWrites(db, projectId) {
  const day = new Date().toISOString().slice(0, 10);
  const r = await db.prepare('SELECT writes FROM db_usage WHERE project_id = ? AND day = ?').bind(projectId, day).first();
  return (r && r.writes) || 0;
}

async function guard(env, request) {
  const h = request.headers.get('Authorization') || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  if (!m || !env.DB_GATEWAY_KEY || m[1].trim() !== env.DB_GATEWAY_KEY) return false;
  return true;
}

// ---- tabel ----
async function listTables(db, projectId) {
  const cat = await db.prepare('SELECT name, columns_json, created_at FROM db_catalog WHERE project_id = ? ORDER BY created_at').bind(projectId).all();
  const tables = [];
  for (const r of cat.results || []) {
    const t = physical(projectId, r.name);
    let rows = 0;
    try { rows = (await db.prepare(`SELECT COUNT(*) c FROM "${t}"`).first()).c; } catch (e) { rows = 0; }
    tables.push({ name: r.name, columns: JSON.parse(r.columns_json || '[]'), rows, created_at: r.created_at });
  }
  return tables;
}

async function createTable(db, body) {
  const projectId = slug(body.project_id);
  const plan = body.plan || 'Starter';
  const name = slug(body.name);
  if (!projectId) return json({ error: 'project_id wajib' }, 400);
  if (!name || name.length > 60) return json({ error: 'Nama tabel tidak valid' }, 400);
  const cols = (body.columns || []).map(c => ({ name: slug(c.name), type: TYPES[c.type] ? c.type : 'text' }))
    .filter(c => c.name);
  if (!cols.length) return json({ error: 'Minimal satu kolom' }, 400);
  const lim = limits(plan);
  const cnt = await db.prepare('SELECT COUNT(*) c FROM db_catalog WHERE project_id = ?').bind(projectId).first();
  if ((cnt.c || 0) >= lim.tables) return json({ error: 'Batas jumlah tabel paket ' + plan + ' tercapai (' + lim.tables + ')' }, 403);
  const exist = await db.prepare('SELECT 1 FROM db_catalog WHERE project_id = ? AND name = ?').bind(projectId, name).first();
  if (exist) return json({ error: 'Tabel dengan nama itu sudah ada' }, 409);
  const ddl = `CREATE TABLE "${physical(projectId, name)}" (id INTEGER PRIMARY KEY AUTOINCREMENT, ` +
    cols.map(c => `"${c.name}" ${TYPES[c.type]}`).join(', ') +
    `, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')))`;
  await db.prepare(ddl).run();
  await db.prepare('INSERT INTO db_catalog (project_id, name, columns_json) VALUES (?, ?, ?)')
    .bind(projectId, name, JSON.stringify(cols)).run();
  return json({ success: true, table: { name, columns: cols } });
}

async function dropTable(db, projectId, name) {
  name = slug(name);
  const exist = await db.prepare('SELECT 1 FROM db_catalog WHERE project_id = ? AND name = ?').bind(projectId, name).first();
  if (!exist) return json({ error: 'Tabel tidak ditemukan' }, 404);
  await db.prepare(`DROP TABLE "${physical(projectId, name)}"`).run();
  await db.prepare('DELETE FROM db_catalog WHERE project_id = ? AND name = ?').bind(projectId, name).run();
  return json({ success: true });
}

// ---- baris ----
async function insertRow(db, body) {
  const projectId = slug(body.project_id);
  const plan = body.plan || 'Starter';
  const tname = slug(body.table);
  const cat = await db.prepare('SELECT columns_json FROM db_catalog WHERE project_id = ? AND name = ?').bind(projectId, tname).first();
  if (!cat) return json({ error: 'Tabel tidak ditemukan' }, 404);
  const cols = JSON.parse(cat.columns_json || '[]');
  const data = body.data || {};
  const names = cols.map(c => c.name).filter(n => data[n] !== undefined);
  if (!names.length) return json({ error: 'Tidak ada kolom yang cocok' }, 400);
  const lim = limits(plan);
  const cnt = await db.prepare(`SELECT COUNT(*) c FROM "${physical(projectId, tname)}"`).first();
  if ((cnt.c || 0) >= lim.rows) return json({ error: 'Batas jumlah baris paket ' + plan + ' tercapai (' + lim.rows + ')' }, 403);
  if (await usageWrites(db, projectId) >= lim.writesDay) return json({ error: 'Kuota tulis harian paket ' + plan + ' habis (' + lim.writesDay + '/hari)' }, 429);
  const ph = names.map(() => '?').join(', ');
  const vals = names.map(n => data[n]);
  const r = await db.prepare(
    `INSERT INTO "${physical(projectId, tname)}" (${names.map(n => `"${n}"`).join(', ')}) VALUES (${ph})`
  ).bind(...vals).run();
  await bumpUsage(db, projectId);
  return json({ success: true, id: r.meta ? r.meta.last_row_id : null });
}

async function listRows(db, projectId, tname, limit, offset) {
  const cat = await db.prepare('SELECT columns_json FROM db_catalog WHERE project_id = ? AND name = ?').bind(projectId, tname).first();
  if (!cat) return json({ error: 'Tabel tidak ditemukan' }, 404);
  const t = physical(projectId, tname);
  const total = (await db.prepare(`SELECT COUNT(*) c FROM "${t}"`).first()).c;
  const rows = await db.prepare(`SELECT * FROM "${t}" ORDER BY id DESC LIMIT ? OFFSET ?`)
    .bind(Math.min(Math.max(1, limit || 50), 200), Math.max(0, offset || 0)).all();
  return json({ rows: rows.results || [], total });
}

async function updateRow(db, body) {
  const projectId = slug(body.project_id);
  const plan = body.plan || 'Starter';
  const tname = slug(body.table);
  const id = Number(body.id);
  const cat = await db.prepare('SELECT columns_json FROM db_catalog WHERE project_id = ? AND name = ?').bind(projectId, tname).first();
  if (!cat) return json({ error: 'Tabel tidak ditemukan' }, 404);
  const lim = limits(plan);
  if (await usageWrites(db, projectId) >= lim.writesDay) return json({ error: 'Kuota tulis harian paket ' + plan + ' habis' }, 429);
  const cols = JSON.parse(cat.columns_json || '[]');
  const data = body.data || {};
  const names = cols.map(c => c.name).filter(n => data[n] !== undefined);
  if (!names.length) return json({ error: 'Tidak ada kolom yang cocok' }, 400);
  const sets = names.map(n => `"${n}" = ?`).join(', ') + ', updated_at = datetime(\'now\')';
  await db.prepare(`UPDATE "${physical(projectId, tname)}" SET ${sets} WHERE id = ?`)
    .bind(...names.map(n => data[n]), id).run();
  await bumpUsage(db, projectId);
  return json({ success: true });
}

async function deleteRow(db, projectId, tname, id) {
  const cat = await db.prepare('SELECT 1 FROM db_catalog WHERE project_id = ? AND name = ?').bind(projectId, tname).first();
  if (!cat) return json({ error: 'Tabel tidak ditemukan' }, 404);
  await db.prepare(`DELETE FROM "${physical(projectId, tname)}" WHERE id = ?`).bind(Number(id)).run();
  await bumpUsage(db, projectId);
  return json({ success: true });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '');
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' } });
    if (!(await guard(env, request))) return json({ error: 'unauthorized' }, 401);
    if (!env.APPDB) return json({ error: 'D1 not bound' }, 500);
    const db = env.APPDB;
    await ensureCatalog(db);
    const pid = slug(url.searchParams.get('project_id') || '');
    try {
      if (path === '/tables' && request.method === 'GET') return json({ tables: await listTables(db, pid) });
      if (path === '/tables' && request.method === 'POST') return createTable(db, await request.json());
      if (path === '/tables' && request.method === 'DELETE') return dropTable(db, pid, url.searchParams.get('name'));
      if (path === '/rows' && request.method === 'GET') return listRows(db, pid, slug(url.searchParams.get('table')), Number(url.searchParams.get('limit')), Number(url.searchParams.get('offset')));
      if (path === '/rows' && request.method === 'POST') return insertRow(db, await request.json());
      if (path === '/rows' && request.method === 'PATCH') return updateRow(db, await request.json());
      if (path === '/rows' && request.method === 'DELETE') return deleteRow(db, pid, slug(url.searchParams.get('table')), url.searchParams.get('id'));
      return json({ error: 'not found' }, 404);
    } catch (e) {
      return json({ error: 'gateway error: ' + (e && e.message) }, 500);
    }
  }
};
