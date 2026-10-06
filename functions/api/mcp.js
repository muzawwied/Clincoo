// Cloudflare Pages Functions — Server MCP Clincoo (Clincoo SEBAGAI server MCP)
// Endpoint: https://clincoo.pages.dev/api/mcp?project_id=<pid>
// Transport: Streamable HTTP (JSON-RPC 2.0), auth Bearer token MCP per proyek.
// Tools: list_items, read_file, write_file, delete_item, get_project_info,
//        chat_ai, deploy_project, deploy_status, get_settings, update_settings, send_email,
//        db_info, db_tables, db_rows (izin database), pay_info (izin payment),
//        list_notifications, send_notification
// Data file real-time diambil dari backend utama app.clincoo.buzz (/api/project-files, D1 produksi).

import { tableFor } from './_tables.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, Mcp-Session-Id, X-Project-Id',
  'Access-Control-Expose-Headers': 'Mcp-Session-Id'
};

const BE2 = 'https://clincoo-be2.pages.dev/api';
// Domain utama deployment INI — dipakai tools baru (chat/deploy/settings/email),
// karena endpoint-nya divalidasi middleware D1 LOKAL (sesi user pemilik proyek),
// bukan backend paralel lama.
const SELF_API = 'https://app.clincoo.buzz/api';
const PROTOCOL_VERSION = '2025-06-18';
const SERVER_INFO = { name: 'clincoo-mcp', version: '1.0.0' };

async function be2Json(path, token, init = {}) {
  const res = await fetch(BE2 + path, { ...init, headers: { ...(init.headers || {}), Authorization: 'Bearer ' + token } });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

async function selfJson(path, token, init = {}) {
  const res = await fetch(SELF_API + path, { ...init, headers: { ...(init.headers || {}), Authorization: 'Bearer ' + token } });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

async function ensureTables(env) {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS mcp_tokens (
      project_id TEXT PRIMARY KEY,
      token TEXT NOT NULL,
      be2_token TEXT NOT NULL, -- kini menyimpan sesi user valid (lokal utama, era-be2 fallback); di-refresh otomatis mcp-token.js
      scopes TEXT DEFAULT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    )`
  ).run();
  try {
    await env.DB.prepare('ALTER TABLE mcp_tokens ADD COLUMN scopes TEXT DEFAULT NULL').run();
  } catch (e) { /* kolom sudah ada */ }
}

// Validasi request MCP: Bearer token cocok dengan token MCP proyek ini.
async function authMcp(request, env, projectId) {
  if (!projectId) return { res: json({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Parameter project_id wajib' } }, 401) };
  await ensureTables(env);
  const h = request.headers.get('Authorization') || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  // Token juga bisa lewat query param ?token= — untuk klien MCP yang hanya
  // menyediakan kolom nama + URL (tanpa dukungan header Authorization).
  var qtok = '';
  try { qtok = (new URL(request.url).searchParams.get('token') || '').trim(); } catch (e) {}
  const tok = m ? m[1].trim() : qtok;
  if (!tok) return { res: json({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Header Authorization Bearer wajib diisi (token MCP dari halaman Server MCP Clincoo)' } }, 401) };
  const row = await env.DB.prepare('SELECT token, be2_token, scopes FROM mcp_tokens WHERE project_id = ?').bind(projectId).first();
  if (!row || row.token !== tok) {
    return { res: json({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Token MCP tidak valid atau sudah dicabut untuk proyek ini' } }, 401) };
  }
  // UTAMA (2026-10-06): sesi tersimpan (be2_token) tadinya = sesi browser user —
  // bisa kedaluwarsa/rotasi kapanpun, dan tiap itu terjadi SEMUA tool MCP gagal
  // ("Sesi backend Clincoo kedaluwarsa") sampai user membuka halaman Server MCP lagi.
  // Pemulihan otomatis: bila sesi tersimpan mati, cetak sesi DEDIKASI berumur
  // panjang untuk PEMILIK proyek (lookup user_projects) dan simpan permanen —
  // server MCP tidak pernah lagi bergantung pada sesi browser.
  let be2 = row.be2_token || '';
  if (env.DB) {
    try {
      let alive = false;
      if (be2) {
        const sess = await env.DB.prepare('SELECT token, expires_at FROM auth_sessions WHERE token = ?').bind(be2).first();
        alive = !!(sess && new Date(sess.expires_at) >= new Date());
      }
      if (!alive) {
        const own = await env.DB.prepare('SELECT user_id FROM user_projects WHERE id = ?').bind(String(projectId)).first();
        if (own && own.user_id) {
          const b = new Uint8Array(24);
          crypto.getRandomValues(b);
          const tk = 'mcp_svc_' + Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
          await env.DB.prepare('INSERT INTO auth_sessions (token, user_id, expires_at) VALUES (?, ?, ?)')
            .bind(tk, own.user_id, new Date(Date.now() + 3650 * 24 * 60 * 60 * 1000).toISOString()).run();
          await env.DB.prepare('UPDATE mcp_tokens SET be2_token = ? WHERE project_id = ?').bind(tk, projectId).run();
          be2 = tk;
        }
      }
    } catch (e) { /* pakai nilai tersimpan */ }
  }
  let scopes = null;
  try { scopes = row.scopes ? JSON.parse(row.scopes) : null; } catch (e) {}
  // Normalisasi (2026-10-03): token lama tanpa izin baru (chat/deploy/settings/email)
  // dianggap TIDAK punya izin baru (least privilege), bukan kebetulan terbuka.
  scopes = {
    read: !scopes || scopes.read !== false,
    write: !!(scopes && scopes.write === true),
    delete: !!(scopes && scopes.delete === true),
    chat: !!(scopes && scopes.chat === true),
    deploy: !!(scopes && scopes.deploy === true),
    settings: !!(scopes && scopes.settings === true),
    email: !!(scopes && scopes.email === true),
    notif: !!(scopes && scopes.notif === true),
    database: !!(scopes && scopes.database === true),
    payment: !!(scopes && scopes.payment === true)
  };
  return { token: tok, be2Token: be2, scopes };
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...CORS, ...headers } });
}

function rpcResult(id, result) {
  return json({ jsonrpc: '2.0', id, result });
}
function rpcError(id, code, message) {
  return json({ jsonrpc: '2.0', id, error: { code, message } });
}

// ---- Operasi workspace via backend UTAMA app.clincoo.buzz (read-modify-write seluruh set file).
// 2026-10-04: pindah dari BE2 lama ke SELF_API — file proyek hidup di D1 produksi lokal,
// BE2 lama berisi salinan basi. Token dipakai = sesi user tersimpan (di-refresh otomatis
// oleh mcp-token.js tiap halaman Server MCP dibuka). ----

async function fetchFiles(userToken, projectId) {
  const r = await selfJson('/project-files?project_id=' + encodeURIComponent(projectId), userToken);
  if (!r.ok) throw new Error(r.status === 401
    ? 'Sesi backend Clincoo kedaluwarsa. Buka halaman Server MCP Clincoo lalu klik "Buat ulang token" untuk memperbarui akses.'
    : 'Gagal mengambil file proyek dari backend (' + r.status + ')');
  return (r.data && r.data.files) || [];
}

async function pushFiles(userToken, projectId, files) {
  // sinkron total via replace:true (POST tunggal, TANPA delete-all dulu):
  // konten kosong pada file besar tidak menimpa isinya, path yatim otomatis dihapus.
  // Pola delete-then-post LAMA dilarang — file besar (is_big) hidup di D1 dan
  // kehapus duluan = data hilang.
  const post = () => selfJson('/project-files', userToken, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project_id: projectId, files, replace: true })
  });
  let r = await post();
  if (!r.ok) r = await post(); // retry 1x: jangan biarkan workspace rusak cuma gara-gara 1x gagal
  if (!r.ok) throw new Error(r.status === 401
    ? 'Sesi backend Clincoo kedaluwarsa. Buka halaman Server MCP Clincoo lalu klik "Buat ulang token" untuk memperbarui akses.'
    : 'Gagal menyimpan file proyek (' + r.status + ')');
}

function safePath(p) {
  const s = String(p == null ? '' : p).trim().replace(/^\/+/, '');
  if (!s) throw new Error('Parameter path wajib');
  if (s.includes('..')) throw new Error('Path tidak boleh mengandung ".."');
  return s;
}

// Pemetaan tool -> izin yang dibutuhkan (null = selalu diizinkan)
// Log aktivitas AI eksternal ke tabel terisolasi per proyek (p_<proj>_mcp_activity).
// Best-effort: kegagalan logging tidak boleh menggagalkan eksekusi tool.
// Riwayat dibatasi 200 entri terakhir per proyek (pruning otomatis).
async function logActivity(env, projectId, tool, ok, detail) {
  try {
    const t = tableFor('mcp_activity', projectId);
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS ${t} (
      id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT, tool TEXT NOT NULL,
      ok INTEGER DEFAULT 1, detail TEXT, created_at TEXT DEFAULT (datetime('now'))
    )`).run();
    await env.DB.prepare(`INSERT INTO ${t} (project_id, tool, ok, detail) VALUES (?, ?, ?, ?)`)
      .bind(String(projectId || ''), String(tool || '?'), ok ? 1 : 0, String(detail || '').slice(0, 200)).run();
    await env.DB.prepare(`DELETE FROM ${t} WHERE id NOT IN (SELECT id FROM ${t} ORDER BY id DESC LIMIT 200)`).run();
  } catch (e) {}
}

const TOOL_SCOPES = {
  list_items: null, read_file: 'read', write_file: 'write', delete_item: 'delete', get_project_info: null,
  chat_ai: 'chat', deploy_project: 'deploy', deploy_status: 'deploy',
  get_settings: 'settings', update_settings: 'settings', send_email: 'email',
  list_notifications: 'notif', send_notification: 'notif',
  db_info: 'database', db_tables: 'database', db_rows: 'database', pay_info: 'payment'
};
function toolScope(name) {
  return TOOL_SCOPES[name] !== undefined ? TOOL_SCOPES[name] : 'unknown';
}

function allowedTools(scopes) {
  return TOOLS.filter(t => {
    const need = toolScope(t.name);
    return need === null || scopes[need] !== false;
  });
}

const TOOLS = [
  {
    name: 'list_items',
    description: 'Daftar file & folder workspace proyek Clincoo. Optional: folder (mis. "css" atau "" untuk root).',
    inputSchema: {
      type: 'object',
      properties: {
        folder: { type: 'string', description: 'Nama folder (kosongkan untuk seluruh workspace)' }
      },
      required: []
    }
  },
  {
    name: 'read_file',
    description: 'Baca isi satu file di workspace proyek secara real-time.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path file relatif, mis. "index.html" atau "css/style.css"' }
      },
      required: ['path']
    }
  },
  {
    name: 'write_file',
    description: 'Tulis/ubah isi file di workspace proyek secara real-time. File baru otomatis dibuat.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path file relatif, mis. "index.html"' },
        content: { type: 'string', description: 'Isi lengkap file (full overwrite)' }
      },
      required: ['path', 'content']
    }
  },
  {
    name: 'delete_item',
    description: 'Hapus file atau folder (beserta isinya) dari workspace proyek.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path file/folder relatif yang akan dihapus' }
      },
      required: ['path']
    }
  },
  {
    name: 'get_project_info',
    description: 'Info proyek Clincoo: nama aplikasi, pengaturan, dan jumlah file.',
    inputSchema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'chat_ai',
    description: 'Kirim prompt ke AI Clincoo (Gemini via AI Router proyek). Berguna untuk minta kompilasi, refactor, atau saran kode dengan konteks proyek. Gak memakai kuota chat harian pengguna (hop tool).',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Pertanyaan/perintah untuk AI Clincoo' }
      },
      required: ['prompt']
    }
  },
  {
    name: 'deploy_project',
    description: 'Publikasikan workspace proyek ke situs live (Cloudflare Pages). Mengembalikan status deployment.',
    inputSchema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'deploy_status',
    description: 'Status deployment situs proyek: URL publik, waktu deploy terakhir, domain kustom, log singkat.',
    inputSchema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'db_info',
    description: 'Status database bawaan aplikasi Clincoo: status aktifasi, daftar tabel beserta jumlah baris, dan status kunci API aplikasi (nilai kunci disamarkan).',
    inputSchema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'db_tables',
    description: 'Kelola tabel pada database bawaan aplikasi. action: "list" (daftar tabel), "create" (buat tabel baru — wajib name + columns), "delete" (hapus tabel — wajib name).',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'create', 'delete'], description: 'Operasi yang dilakukan (default: list)' },
        name: { type: 'string', description: 'Nama tabel (wajib untuk create/delete)' },
        columns: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, type: { type: 'string', description: 'mis. text, number, boolean, date' } }, required: ['name'] }, description: 'Definisi kolom tabel baru (wajib untuk create)' }
      },
      required: []
    }
  },
  {
    name: 'db_rows',
    description: 'Kelola baris data pada database bawaan aplikasi. action: "list" (baca baris), "create" (tambah baris — wajib data), "update" (ubah baris — wajib id + data), "delete" (hapus baris — wajib id).',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'create', 'update', 'delete'], description: 'Operasi yang dilakukan (default: list)' },
        table: { type: 'string', description: 'Nama tabel (wajib)' },
        id: { type: 'string', description: 'ID baris (wajib untuk update/delete)' },
        data: { type: 'object', description: 'Isi baris untuk create/update (pasangan kolom: nilai)' },
        limit: { type: 'number', description: 'Jumlah baris maksimum untuk list (default 50)' },
        offset: { type: 'number', description: 'Offset untuk paginasi list (default 0)' }
      },
      required: ['table']
    }
  },
  {
    name: 'pay_info',
    description: 'Informasi pembayaran ClincooPay proyek ini: status aktifasi, kredensial (pay_key disamarkan), saldo, 25 transaksi terakhir, dan 25 permintaan penarikan terakhir. Bersifat baca saja — penarikan dana tidak dapat dilakukan lewat MCP.',
    inputSchema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'get_settings',
    description: 'Baca pengaturan proyek Clincoo (panel integrasi & pengaturan umum: nama app, runtime, webhook, dll).',
    inputSchema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'update_settings',
    description: 'Ubah pengaturan proyek. Hanya key aman yang diizinkan: app_name, app_desc, webhook_url, hak_akses, visibility.',
    inputSchema: {
      type: 'object',
      properties: {
        app_name: { type: 'string', description: 'Nama aplikasi' },
        app_desc: { type: 'string', description: 'Deskripsi aplikasi' },
        webhook_url: { type: 'string', description: 'URL webhook notifikasi' },
        hak_akses: { type: 'string', description: 'Hak akses proyek' },
        visibility: { type: 'string', description: 'Visibilitas proyek' }
      },
      required: []
    }
  },
  {
    name: 'list_notifications',
    description: 'Baca notifikasi terbaru pemilik proyek di dashboard Clincoo (maks 50 terbaru).',
    inputSchema: {
      type: 'object',
      properties: {
        unread_only: { type: 'boolean', description: 'true = hanya yang belum dibaca (opsional)' }
      }
    }
  },
  {
    name: 'send_notification',
    description: 'Kirim notifikasi ke dashboard Clincoo pemilik proyek (muncul di panel notifikasi + halaman Notifikasi). Tipe: info/success/warning/error.',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Isi notifikasi (teks singkat)' },
        type: { type: 'string', description: 'Tipe notifikasi: info/success/warning/error (default info)' },
        link: { type: 'string', description: 'Link saat notifikasi diklik, mis. /proyek/ (opsional)' },
        source: { type: 'string', description: 'Nama sumber yang tampil (default "MCP Clincoo")' }
      },
      required: ['message']
    }
  },
  {
    name: 'send_email',
    description: 'Kirim email lewat email API proyek Clincoo (harus sudah diaktifkan di pengaturan Email). Mengikuti kuota bulanan proyek.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Alamat email penerima' },
        subject: { type: 'string', description: 'Subjek email' },
        html: { type: 'string', description: 'Isi email (HTML)' },
        reply_to: { type: 'string', description: 'Alamat reply-to (opsional)' }
      },
      required: ['to', 'subject', 'html']
    }
  }
];

async function callTool(name, args, ctx) {
  const { be2Token, projectId } = ctx;
  switch (name) {
    case 'list_items': {
      const files = await fetchFiles(be2Token, projectId);
      const folder = args.folder ? String(args.folder).trim().replace(/^\/+|\/+$/g, '') : '';
      let lines = [];
      const seen = new Set();
      files.forEach(f => {
        const p = String(f.path || '');
        if (!p) return;
        if (folder && !p.toLowerCase().startsWith(folder.toLowerCase() + '/')) return;
        const rel = folder ? p.slice(folder.length + 1) : p;
        seen.add(p);
        const size = new Blob([f.content || '']).size;
        lines.push('- ' + rel + ' (' + (size > 1024 ? (size / 1024).toFixed(1) + ' KB' : size + ' B') + ')');
      });
      const text = lines.length
        ? 'Workspace proyek (' + files.length + ' item):\n' + lines.join('\n')
        : 'Workspace proyek kosong.';
      return { content: [{ type: 'text', text }] };
    }
    case 'read_file': {
      const path = safePath(args.path);
      const files = await fetchFiles(be2Token, projectId);
      const f = files.find(x => String(x.path).toLowerCase() === path.toLowerCase());
      if (!f) throw new Error('File tidak ditemukan: ' + path);
      let content = String(f.content || '');
      // File besar (is_big): isi hidup di D1 (content kosong di daftar) — ambil utuh
      // via endpoint file-tunggal, lalu potong 120rb karakter utk respons tool.
      if (!content && f.is_big) {
        const r = await selfJson('/project-files?project_id=' + encodeURIComponent(projectId) + '&path=' + encodeURIComponent(path) + '&content=1', be2Token);
        if (r.ok && r.data) {
          if (r.data.content_b64) {
            try { content = atob(r.data.content_b64); } catch (e) { content = ''; }
          } else content = String(r.data.content || '');
        }
      }
      if (content.length > 120000) content = content.slice(0, 120000) + '\n...[dipotong]';
      return { content: [{ type: 'text', text: content || '(file kosong)' }] };
    }
    case 'write_file': {
      const path = safePath(args.path);
      const content = String(args.content == null ? '' : args.content);
      const files = await fetchFiles(be2Token, projectId);
      const idx = files.findIndex(x => String(x.path).toLowerCase() === path.toLowerCase());
      if (idx >= 0) files[idx].content = content; else files.push({ path, content });
      await pushFiles(be2Token, projectId, files);
      return { content: [{ type: 'text', text: 'Berhasil menulis ' + path + ' (' + new Blob([content]).size + ' B). Perubahan langsung terlihat di Clincoo.' }] };
    }
    case 'delete_item': {
      const path = safePath(args.path);
      const files = await fetchFiles(be2Token, projectId);
      const before = files.length;
      const kept = files.filter(x => {
        const p = String(x.path || '');
        const pl = p.toLowerCase();
        const dl = path.toLowerCase();
        if (pl === dl) return false;                    // file persis
        if (pl.startsWith(dl + '/')) return false;    // isi folder
        if (dl + '/' === pl && p.endsWith('/')) return false; // folder eksplisit
        return true;
      });
      if (kept.length === before) throw new Error('Tidak ditemukan: ' + path);
      await pushFiles(be2Token, projectId, kept);
      return { content: [{ type: 'text', text: 'Berhasil menghapus ' + path + '.' }] };
    }
    case 'get_project_info': {
      const [st, files] = await Promise.all([
        selfJson('/project-settings?project_id=' + encodeURIComponent(projectId), be2Token),
        fetchFiles(be2Token, projectId)
      ]);
      const settings = (st.ok && st.data && !st.data.error) ? (st.data.settings || {}) : {};
      let info = { project_id: projectId, total_files: files.filter(f => !String(f.path).endsWith('/')).length, app_name: settings.app_name || null };
      return { content: [{ type: 'text', text: JSON.stringify(info, null, 2) }] };
    }
    case 'chat_ai': {
      const prompt = String(args.prompt == null ? '' : args.prompt).trim();
      if (!prompt) throw new Error('Parameter prompt wajib diisi');
      if (prompt.length > 8000) throw new Error('Prompt terlalu panjang (maks 8000 karakter)');
      const payload = JSON.stringify({
        messages: [{ role: 'user', content: prompt }],
        project_id: projectId,
        save_user_message: false, // hop tool: gak makan kuota chat harian pengguna
        stream: false
      });
      // Rantai fallback: proxy utama (kuota per-user) -> backend AI langsung.
      // Kalau BE2 lagi tidak menerima sesi (redeploy sesi paralel), coba jalur kedua.
      let r = await selfJson('/chat', ctx.be2Token, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload });
      if (!r.ok || !(r.data && (r.data.text || r.data.reply || r.data.message))) {
        const r2 = await be2Json('/chat', ctx.be2Token, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload });
        if (r2.ok && r2.data && (r2.data.text || r2.data.reply || r2.data.message)) r = r2;
      }
      if (!r.ok) throw new Error(r.status === 429 ? 'Kuota AI harian pemilik proyek habis — coba lagi besok' : 'Chat AI sedang tidak bisa dihubungi (' + r.status + ') — backend AI Clincoo mungkin sedang diperbarui. Coba lagi sebentar lagi.');
      const text = r.data && (r.data.text || r.data.reply || r.data.message);
      if (!text) throw new Error('Chat AI tidak mengembalikan jawaban');
      return { content: [{ type: 'text', text: String(text) }] };
    }
    case 'deploy_project': {
      const r = await selfJson('/deploy', ctx.be2Token, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: projectId })
      });
      if (!r.ok) throw new Error('Deploy gagal (' + r.status + '): ' + ((r.data && (r.data.error || r.data.message)) || ''));
      return { content: [{ type: 'text', text: 'Deploy dipicu. Status:\n' + JSON.stringify(r.data, null, 2) }] };
    }
    case 'deploy_status': {
      const r = await selfJson('/deploy?project_id=' + encodeURIComponent(projectId), ctx.be2Token);
      if (!r.ok) throw new Error('Gagal mengambil status deployment (' + r.status + ')');
      return { content: [{ type: 'text', text: JSON.stringify(r.data, null, 2) }] };
    }
    case 'db_info': {
      const pid = encodeURIComponent(projectId);
      const act = await selfJson('/db/activate?project_id=' + pid, ctx.be2Token);
      const tbl = await selfJson('/db/tables?project_id=' + pid, ctx.be2Token);
      const key = await selfJson('/db/key?project_id=' + pid, ctx.be2Token);
      if (!act.ok || !tbl.ok) throw new Error('Database bawaan tidak dapat dihubungi (' + (tbl.status || act.status) + ') — coba lagi sebentar');
      const k = key.data && key.data.key ? String(key.data.key) : '';
      const out = {
        database_aktif: !!(act.data && act.data.active),
        diaktifkan_pada: (act.data && act.data.created_at) || null,
        kunci_api: k ? k.slice(0, 12) + '••• (lengkap di halaman Database)' : null,
        kunci_terakhir_dipakai: (key.data && key.data.last_used) || null,
        tabel: tbl.data && Array.isArray(tbl.data.tables) ? tbl.data.tables : (tbl.data || [])
      };
      return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] };
    }
    case 'db_tables': {
      const action = String(args.action || 'list');
      const pid = encodeURIComponent(projectId);
      if (action === 'create') {
        const name = String(args.name || '').trim();
        const cols = args.columns;
        if (!name) throw new Error('Parameter "name" wajib diisi untuk membuat tabel');
        if (!Array.isArray(cols) || !cols.length) throw new Error('Parameter "columns" wajib berisi minimal satu kolom ({ name, type })');
        const r = await selfJson('/db/tables', ctx.be2Token, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ project_id: projectId, name, columns: cols })
        });
        if (!r.ok) throw new Error((r.data && r.data.error) || 'Gagal membuat tabel (' + r.status + ')');
        return { content: [{ type: 'text', text: 'Tabel "' + name + '" berhasil dibuat.' }] };
      }
      if (action === 'delete') {
        const name = String(args.name || '').trim();
        if (!name) throw new Error('Parameter "name" wajib diisi untuk menghapus tabel');
        const r = await selfJson('/db/tables?project_id=' + pid + '&name=' + encodeURIComponent(name), ctx.be2Token, { method: 'DELETE' });
        if (!r.ok) throw new Error((r.data && r.data.error) || 'Gagal menghapus tabel (' + r.status + ')');
        return { content: [{ type: 'text', text: 'Tabel "' + name + '" berhasil dihapus.' }] };
      }
      const r = await selfJson('/db/tables?project_id=' + pid, ctx.be2Token);
      if (!r.ok) throw new Error((r.data && r.data.error) || 'Gagal membaca daftar tabel (' + r.status + ')');
      return { content: [{ type: 'text', text: JSON.stringify(r.data, null, 2) }] };
    }
    case 'db_rows': {
      const action = String(args.action || 'list');
      const table = String(args.table || '');
      if (!table) throw new Error('Parameter "table" wajib diisi');
      const pid = encodeURIComponent(projectId);
      if (action === 'list') {
        const limit = Number(args.limit) > 0 ? Math.min(Number(args.limit), 200) : 50;
        const offset = Number(args.offset) > 0 ? Number(args.offset) : 0;
        const r = await selfJson('/db/rows?project_id=' + pid + '&table=' + encodeURIComponent(table) + '&limit=' + limit + '&offset=' + offset, ctx.be2Token);
        if (!r.ok) throw new Error((r.data && r.data.error) || 'Gagal membaca baris (' + r.status + ')');
        return { content: [{ type: 'text', text: JSON.stringify(r.data, null, 2) }] };
      }
      if (action === 'create' || action === 'update') {
        const data = args.data && typeof args.data === 'object' && !Array.isArray(args.data) ? args.data : null;
        if (!data) throw new Error('Parameter "data" wajib berisi objek kolom: nilai');
        const body = { project_id: projectId, table, data };
        let method = 'POST';
        if (action === 'update') {
          if (!args.id) throw new Error('Parameter "id" wajib diisi untuk update');
          body.id = String(args.id);
          method = 'PATCH';
        }
        const r = await selfJson('/db/rows', ctx.be2Token, {
          method: method,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        if (!r.ok) throw new Error((r.data && r.data.error) || 'Gagal ' + (action === 'create' ? 'menambah' : 'memperbarui') + ' baris (' + r.status + ')');
        return { content: [{ type: 'text', text: JSON.stringify(r.data, null, 2) }] };
      }
      if (action === 'delete') {
        if (!args.id) throw new Error('Parameter "id" wajib diisi untuk delete');
        const r = await selfJson('/db/rows?project_id=' + pid + '&table=' + encodeURIComponent(table) + '&id=' + encodeURIComponent(String(args.id)), ctx.be2Token, { method: 'DELETE' });
        if (!r.ok) throw new Error((r.data && r.data.error) || 'Gagal menghapus baris (' + r.status + ')');
        return { content: [{ type: 'text', text: JSON.stringify(r.data, null, 2) }] };
      }
      throw new Error('Action tidak dikenal: ' + action + ' (gunakan list/create/update/delete)');
    }
    case 'pay_info': {
      const pid = encodeURIComponent(projectId);
      const cfg = await selfJson('/pay?action=config&project_id=' + pid, ctx.be2Token);
      const tx = await selfJson('/pay', ctx.be2Token, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'transactions', project_id: projectId })
      });
      const wd = await selfJson('/pay', ctx.be2Token, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'withdrawals', project_id: projectId })
      });
      if (!cfg.ok) throw new Error((cfg.data && cfg.data.error) || 'Gagal membaca konfigurasi pembayaran (' + cfg.status + ')');
      const pk = cfg.data && cfg.data.pay_key ? String(cfg.data.pay_key) : '';
      const out = Object.assign({}, cfg.data, {
        pay_key: pk ? pk.slice(0, 16) + '••• (lengkap di halaman Pembayaran)' : null,
        transaksi_terakhir: tx.ok && tx.data ? (tx.data.transactions || []) : [],
        penarikan_terakhir: wd.ok && wd.data ? (wd.data.withdrawals || []) : []
      });
      return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] };
    }
    case 'get_settings': {
      const r = await selfJson('/project-settings?project_id=' + encodeURIComponent(projectId), ctx.be2Token);
      if (!r.ok) throw new Error('Gagal membaca pengaturan (' + r.status + ')');
      const out = {};
      Object.keys(r.data || {}).forEach(k => {
        // Jangan bocorkan kredensial MCP internal lewat tool ini
        if (k === 'mcp_token' || k === 'mcp_created_at') return;
        out[k] = r.data[k];
      });
      return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] };
    }
    case 'update_settings': {
      const SAFE = ['app_name', 'app_desc', 'webhook_url', 'hak_akses', 'visibility'];
      const body = { project_id: projectId };
      let n = 0;
      SAFE.forEach(k => {
        if (args[k] !== undefined) { body[k] = String(args[k]); n++; }
      });
      if (!n) throw new Error('Tidak ada field yang diubah. Field aman: ' + SAFE.join(', '));
      const r = await selfJson('/project-settings', ctx.be2Token, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (!r.ok) throw new Error('Gagal menyimpan pengaturan (' + r.status + '): ' + ((r.data && r.data.error) || ''));
      const set = {};
      SAFE.forEach(k => { if (body[k] !== undefined) set[k] = body[k]; });
      return { content: [{ type: 'text', text: 'Berhasil menyimpan pengaturan:\n' + JSON.stringify(set, null, 2) }] };
    }
    case 'list_notifications': {
      const unreadOnly = args.unread_only === true;
      const r = await selfJson('/notifications' + (unreadOnly ? '?unread=true' : ''), ctx.be2Token);
      if (!r.ok) throw new Error('Gagal membaca notifikasi (' + r.status + ')');
      const list = (r.data && r.data.notifications) || [];
      const lines = list.map(n => {
        return '[' + (n.read ? 'sudah dibaca' : 'BARU') + '] ' + (n.source || '-') + ' (' + (n.type || 'info') + ', ' + (n.created_at || '') + (n.link ? ', link: ' + n.link : '') + '): ' + n.message;
      });
      return { content: [{ type: 'text', text: (r.data ? 'Belum dibaca: ' + (r.data.unreadCount || 0) + ' dari ' + list.length + ' notifikasi terbaru.\n' : '') + (lines.length ? lines.join('\n') : 'Tidak ada notifikasi.') }] };
    }
    case 'send_notification': {
      const message = String(args.message == null ? '' : args.message).trim();
      if (!message) throw new Error('Parameter "message" wajib diisi');
      if (message.length > 500) throw new Error('Parameter "message" maksimal 500 karakter');
      const type = ['info', 'success', 'warning', 'error'].includes(args.type) ? args.type : 'info';
      let link = String(args.link == null ? '' : args.link).trim();
      if (link && !link.startsWith('/') && !/^https:\/\//.test(link)) throw new Error('Parameter "link" harus mulai dengan "/" (path Clincoo) atau "https://"');
      const source = String(args.source == null ? '' : args.source).trim().slice(0, 40) || 'MCP Clincoo';
      const r = await selfJson('/notifications', ctx.be2Token, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source, message, type, link })
      });
      if (!r.ok) throw new Error('Gagal mengirim notifikasi (' + r.status + '): ' + ((r.data && r.data.error) || ''));
      return { content: [{ type: 'text', text: 'Notifikasi terkirim ke dashboard Clincoo: "' + message.slice(0, 80) + '"' }] };
    }
    case 'send_email': {
      const to = String(args.to == null ? '' : args.to).trim();
      const subject = String(args.subject == null ? '' : args.subject).trim();
      const html = String(args.html == null ? '' : args.html);
      if (!to || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) throw new Error('Parameter "to" wajib alamat email yang valid');
      if (!subject) throw new Error('Parameter "subject" wajib diisi');
      if (!html) throw new Error('Parameter "html" wajib diisi');
      const r = await selfJson('/email', ctx.be2Token, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'test', project_id: projectId, to, subject, html, reply_to: args.reply_to ? String(args.reply_to) : undefined })
      });
      if (!r.ok) throw new Error('Gagal mengirim email (' + r.status + '): ' + ((r.data && (r.data.error || r.data.message)) || ''));
      return { content: [{ type: 'text', text: 'Email terkirim ke ' + to + '. ' + JSON.stringify(r.data) }] };
    }
    default:
      throw new Error('Tool tidak dikenal: ' + name);
  }
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestGet() {
  // Streamable HTTP: server ini tidak menyediakan stream GET (cukup POST request/response)
  return json({ error: 'Method GET tidak didukung endpoint ini. Gunakan POST (JSON-RPC 2.0).' }, 405);
}

export async function onRequestDelete() {
  return json({ error: 'Method DELETE tidak didukung endpoint ini.' }, 405);
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const projectId = url.searchParams.get('project_id') || request.headers.get('X-Project-Id') || '';
  const auth = await authMcp(request, env, projectId);
  if (auth.res) return auth.res;
  const ctx = { be2Token: auth.be2Token, projectId, scopes: auth.scopes };

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Body JSON tidak valid' } }, 400);
  }

  const id = body && body.id !== undefined ? body.id : null;
  const method = body && body.method;
  const isNotification = body && body.id === undefined;

  if (isNotification) return new Response(null, { status: 202, headers: CORS });

  try {
    if (method === 'initialize') {
      const requested = (body.params && body.params.protocolVersion) || '';
      const protocolVersion = ['2024-11-05', '2025-03-26', '2025-06-18'].includes(requested) ? requested : PROTOCOL_VERSION;
      return rpcResult(id, { protocolVersion, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
    }
    if (method === 'ping') return rpcResult(id, {});
    if (method === 'tools/list') return rpcResult(id, { tools: allowedTools(ctx.scopes) });
    if (method === 'tools/call') {
      const name = body.params && body.params.name;
      const args = (body.params && body.params.arguments) || {};
      const denied = toolScope(name);
      if (denied && ctx.scopes[denied] === false) {
        await logActivity(env, projectId, name, 0, 'izin "' + denied + '" tidak aktif');
        return rpcResult(id, { content: [{ type: 'text', text: 'Error: akses ditolak. Izin "' + denied + '" tidak diaktifkan untuk server MCP proyek ini (atur di halaman Server MCP Clincoo).' }], isError: true });
      }
      try {
        const result = await callTool(name, args, ctx);
        await logActivity(env, projectId, name, 1, null);
        return rpcResult(id, result);
      } catch (e) {
        // error tool -> hasil isError (bukan error protokol)
        await logActivity(env, projectId, name, 0, e.message);
        return rpcResult(id, { content: [{ type: 'text', text: 'Error: ' + e.message }], isError: true });
      }
    }
    return rpcError(id, -32601, 'Method tidak dikenal: ' + method);
  } catch (e) {
    return rpcError(id, -32603, 'Error internal: ' + e.message);
  }
}
