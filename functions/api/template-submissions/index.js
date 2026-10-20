// Cloudflare Pages Functions — Pengajuan Template Komunitas Clincoo
//   GET  /api/template-submissions          -> daftar template komunitas yang DISETUJUI (publik)
//   POST /api/template-submissions          -> ajukan template (wajib login Bearer):
//        { title, desc, preview_url, project_name, thumbnail (data URL webp) }
//        Data langsung dikirim real-time via email ke reviewer (Resend) dengan CTA Setujui/Tolak.
//   Tabel: template_submissions (D1, dibuat otomatis).
// Sub-route: /api/template-submissions/track   (pencatatan pemakaian/kunjungan, publik)
//            /api/template-submissions/review (CTA Setujui/Tolak dari email, via token)
import { randomHex } from '../auth/shared.js';
import { currentUser } from '../user-scope.js';
import { sendEmail } from '../notify-helpers.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

const REVIEWER_EMAIL = 'muzawwied@gmail.com';

function json(data, status) {
  return new Response(JSON.stringify(data), { status: status || 200, headers: { 'Content-Type': 'application/json', ...CORS } });
}

export async function onRequestOptions() { return new Response(null, { status: 204, headers: CORS }); }

async function ensureTable(db) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS template_submissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    creator_name TEXT DEFAULT '',
    creator_email TEXT DEFAULT '',
    project_name TEXT DEFAULT '',
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    preview_url TEXT DEFAULT '',
    thumbnail TEXT DEFAULT '',
    status TEXT DEFAULT 'pending',
    review_token TEXT,
    uses INTEGER DEFAULT 0,
    views INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    reviewed_at TEXT
  )`).run();
}

// ===== GET (publik): template komunitas yang sudah disetujui =====
export async function onRequestGet({ request, env }) {
  const db = env.DB;
  if (!db) return json({ error: 'D1 not bound' }, 500);
  try {
    await ensureTable(db);
    const rows = await db.prepare(
      `SELECT id, creator_name, title, description, preview_url, thumbnail, uses, views, created_at
       FROM template_submissions WHERE status = 'approved' ORDER BY id DESC LIMIT 30`
    ).all();
    const templates = (rows.results || []).map(r => ({
      id: r.id,
      key: 'community:' + r.id,
      creator: r.creator_name || 'Pengguna Clincoo',
      name: r.title,
      desc: r.description,
      url: r.preview_url,
      thumbnail: r.thumbnail,
      uses: r.uses || 0,
      views: r.views || 0,
      created_at: r.created_at
    }));
    return json({ templates });
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}

// ===== POST (wajib login): ajukan template + kirim email review real-time =====
export async function onRequestPost({ request, env }) {
  const db = env.DB;
  if (!db) return json({ error: 'D1 not bound' }, 500);
  const user = await currentUser(env, request);
  if (!user) return json({ error: 'Login diperlukan', need_login: true }, 401);
  try {
    await ensureTable(db);
    const body = await request.json();
    const title = String(body.title || '').trim().slice(0, 80);
    const desc = String(body.desc || body.description || '').trim().slice(0, 500);
    const previewUrl = String(body.preview_url || '').trim().slice(0, 500);
    const projectName = String(body.project_name || '').trim().slice(0, 120);
    const thumbnail = String(body.thumbnail || '');
    if (!title || !desc || !previewUrl) return json({ error: 'Judul, deskripsi, dan tautan preview wajib diisi.' }, 400);
    if (!/^https?:\/\//i.test(previewUrl)) return json({ error: 'Tautan preview harus berupa URL http/https.' }, 400);
    if (thumbnail && !/^data:image\/(webp|png|jpeg|jpg);base64,/i.test(thumbnail)) return json({ error: 'Format thumbnail tidak didukung.' }, 400);
    if (thumbnail.length > 460000) return json({ error: 'Thumbnail terlalu besar (maks ~330 KB). Coba foto yang lebih kecil.' }, 413);

    const token = randomHex(24);
    const res = await db.prepare(
      `INSERT INTO template_submissions
        (user_id, creator_name, creator_email, project_name, title, description, preview_url, thumbnail, status, review_token)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
    ).bind(user.id, user.name || user.email || 'Pengguna Clincoo', user.email || '', projectName, title, desc, previewUrl, thumbnail, token).run();

    const id = res.meta ? res.meta.last_row_id : null;

    // ===== Email review real-time ke reviewer dengan CTA Setujui & Tolak =====
    const origin = new URL(request.url).origin;
    const approveUrl = origin + '/api/template-submissions/review?token=' + token + '&action=approve';
    const rejectUrl = origin + '/api/template-submissions/review?token=' + token + '&action=tolak';
    const tgl = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' }) + ' WIB';
    const escape = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    let attachment = null;
    if (thumbnail) {
      const m = thumbnail.match(/^data:(image\/([a-z+]+));base64,(.+)$/i);
      const extByMime = { 'png': 'png', 'jpeg': 'jpg', 'jpg': 'jpg' };
      const ext = m && extByMime[(m[2] || '').toLowerCase()];
      // webp tidak didukung lampiran Resend -> biarkan gagal lalu fallback kirim tanpa lampiran
      if (m && ext) attachment = [{ name: 'thumbnail-' + (id || 'baru') + '.' + ext, content: m[3] }];
    }
    const html =
      '<div style="background:#f4f5f7;padding:32px 16px;font-family:Arial,Helvetica,sans-serif">' +
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;border:1px solid #e5e7eb;border-collapse:separate;overflow:hidden">' +
          '<tr><td style="background:#0a0a0a;padding:22px 32px">' +
            '<span style="color:#ffffff;font-size:19px;font-weight:bold;letter-spacing:2px">Clincoo — Template Baru untuk Ditinjau</span>' +
          '</td></tr>' +
          '<tr><td style="padding:32px">' +
            '<p style="margin:0 0 4px;color:#9ca3af;font-size:12px">' + tgl + '</p>' +
            '<h1 style="margin:0 0 20px;font-size:20px;color:#111827;font-weight:bold">' + escape(title) + '</h1>' +
            '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">' +
              '<tr><td style="padding:10px 0;border-bottom:1px solid #eceef1;color:#6b7280;font-size:13px">Pencipta</td><td style="padding:10px 0 10px 16px;border-bottom:1px solid #eceef1;color:#111827;font-size:13px;font-weight:bold;text-align:right">' + escape(user.name || '-') + '</td></tr>' +
              '<tr><td style="padding:10px 0;border-bottom:1px solid #eceef1;color:#6b7280;font-size:13px">Email</td><td style="padding:10px 0 10px 16px;border-bottom:1px solid #eceef1;color:#111827;font-size:13px;font-weight:bold;text-align:right">' + escape(user.email || '-') + '</td></tr>' +
              '<tr><td style="padding:10px 0;border-bottom:1px solid #eceef1;color:#6b7280;font-size:13px">Proyek Clincoo</td><td style="padding:10px 0 10px 16px;border-bottom:1px solid #eceef1;color:#111827;font-size:13px;font-weight:bold;text-align:right">' + escape(projectName || '-') + '</td></tr>' +
              '<tr><td style="padding:10px 0;border-bottom:1px solid #eceef1;color:#6b7280;font-size:13px">Tautan Preview</td><td style="padding:10px 0 10px 16px;border-bottom:1px solid #eceef1;text-align:right"><a href="' + escape(previewUrl) + '" style="color:#2563eb;font-size:13px;font-weight:bold;text-decoration:none">' + escape(previewUrl.replace(/^https?:\/\//, '').slice(0, 48)) + '</a></td></tr>' +
              '<tr><td style="padding:10px 0;border-bottom:1px solid #eceef1;color:#6b7280;font-size:13px">Deskripsi</td><td style="padding:10px 0 10px 16px;border-bottom:1px solid #eceef1;color:#111827;font-size:13px;text-align:right">' + escape(desc) + '</td></tr>' +
            '</table>' +
            '<p style="margin:24px 0 8px;color:#374151;font-size:13px;line-height:1.6">Template ini dikirim secara real-time dari halaman pendaftaran template Clincoo. Tinjau datanya, lalu pilih tindakan:</p>' +
            '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse"><tr>' +
              '<td style="padding-right:8px"><a href="' + approveUrl + '" style="display:inline-block;background:#059669;color:#ffffff;padding:12px 24px;border-radius:8px;text-decoration:none;font-size:13px;font-weight:bold">&#10003; Setujui</a></td>' +
              '<td><a href="' + rejectUrl + '" style="display:inline-block;background:#dc2626;color:#ffffff;padding:12px 24px;border-radius:8px;text-decoration:none;font-size:13px;font-weight:bold">&#10007; Tolak</a></td>' +
            '</tr></table>' +
            '<p style="margin:20px 0 0;color:#9ca3af;font-size:11px;line-height:1.6">Setujui = template langsung tampil di galeri template publik Clincoo beserta hitungan pemakaian dan kunjungan real-time.</p>' +
          '</td></tr>' +
        '</table>' +
      '</div>';
    const mailOpts = {
      toEmail: REVIEWER_EMAIL,
      subject: 'Template baru untuk ditinjau: ' + title,
      html,
      ...(attachment ? { attachment } : {})
    };
    let mail = await sendEmail(env, mailOpts);

    // Fallback: kalau email dengan lampiran gagal (mis. format webp ditolak Resend),
    // kirim ulang TANPA lampiran agar review email selalu sampai.
    if (!mail.sent && attachment) {
      mail = await sendEmail(env, { toEmail: mailOpts.toEmail, subject: mailOpts.subject, html });
    }

    return json({ ok: true, id, email_sent: mail.sent, email_reason: mail.sent ? null : mail.reason });
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}
