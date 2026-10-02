import { currentUser } from './user-scope.js';
import { sendEmail, emailTemplate, getUserByEmail, notifyEvent, getSecret } from './notify-helpers.js';

// Cloudflare Pages Functions — Laporan Bug
// POST /api/bug-report — simpan laporan ke D1, kirim email ke pemilik (Brevo), + notifikasi in-app.
// Body: { category, category_label, description, page_url, user_agent, attachments: [dataURL...] }

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

const CATEGORY_LABELS = {
  ui: 'Tampilan / UI',
  function: 'Fungsi / Fitur',
  performance: 'Performa',
  security: 'Keamanan',
  payment: 'Pembayaran',
  account: 'Akun & Login',
  other: 'Lainnya'
};

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export async function onRequestOptions() {
  return new Response(null, { headers: CORS });
}

export async function onRequestPost({ request, env }) {
  const db = env.DB;
  if (!db) return new Response(JSON.stringify({ error: 'D1 not bound' }), { status: 500, headers: { 'Content-Type': 'application/json', ...CORS } });

  try {
    const user = await currentUser(env, request);
    if (!user) {
      return new Response(JSON.stringify({ error: 'Login diperlukan' }), { status: 401, headers: { 'Content-Type': 'application/json', ...CORS } });
    }

    const body = await request.json().catch(() => null);
    if (!body) return new Response(JSON.stringify({ error: 'Body JSON tidak valid' }), { status: 400, headers: { 'Content-Type': 'application/json', ...CORS } });

    const description = String(body.description || '').trim().slice(0, 5000);
    if (!description) return new Response(JSON.stringify({ error: 'Deskripsi laporan wajib diisi' }), { status: 400, headers: { 'Content-Type': 'application/json', ...CORS } });

    const category = String(body.category || 'other').slice(0, 30);
    const categoryLabel = String(body.category_label || CATEGORY_LABELS[category] || category).slice(0, 60);
    const pageUrl = String(body.page_url || '').slice(0, 500);
    const userAgent = String(body.user_agent || '').slice(0, 300);

    // Lampiran: maksimal 3 gambar, masing-masing base64 maksimal 700KB
    const rawAttachments = Array.isArray(body.attachments) ? body.attachments : [];
    const attachments = [];
    for (const a of rawAttachments.slice(0, 3)) {
      if (typeof a !== 'string' || !a.startsWith('data:image/')) continue;
      if (a.length > 700 * 1024) continue;
      // base64 wajib valid (padding benar), kalau tidak Brevo akan menolak seluruh email
      const b64 = a.split(',')[1] || '';
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64) || b64.length % 4 !== 0) continue;
      attachments.push(a);
    }

    // 1. Simpan ke D1
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS bug_reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        reporter_email TEXT,
        reporter_name TEXT,
        category TEXT,
        description TEXT,
        page_url TEXT,
        user_agent TEXT,
        attachments TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `).run();

    const info = await db.prepare(
      'INSERT INTO bug_reports (user_id, reporter_email, reporter_name, category, description, page_url, user_agent, attachments) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(
      user.id,
      user.email || '',
      user.name || '',
      categoryLabel,
      description,
      pageUrl,
      userAgent,
      attachments.length ? JSON.stringify(attachments) : null
    ).run();
    const reportId = info.meta ? info.meta.last_row_id : null;

    // 2. Email ke pemilik via Brevo (+ lampiran)
    const ownerEmail = (await getSecret(env, 'BUG_REPORT_EMAIL')) || 'devconium@gmail.com';
    const details = [
      ['Kategori', esc(categoryLabel)],
      ['Pelapor', esc((user.name || '-') + ' <' + (user.email || '-') + '>')],
      ['Halaman', esc(pageUrl || '-')],
      ['Waktu', new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' }) + ' WIB']
    ];
    const emailResult = await sendEmail(env, {
      toEmail: ownerEmail,
      toName: 'Admin Clincoo',
      subject: '[Laporan Bug] ' + categoryLabel + (reportId ? ' #' + reportId : '') + ' — Clincoo',
      html: emailTemplate(
        'Laporan Bug Baru',
        'Admin',
        'Ada laporan bug baru yang masuk melalui halaman Laporkan Bug Clincoo. Rincian laporan:' +
          '<div style="margin:16px 0;padding:14px 16px;background:#f9fafb;border:1px solid #e5e7eb;border-radius:10px;color:#374151;font-size:14px;line-height:1.7">' + esc(description) + '</div>' +
          (attachments.length ? '<p style="margin:0 0 4px;color:#6b7280;font-size:12px">' + attachments.length + ' tangkapan layar dilampirkan di email ini.</p>' : ''),
        details,
        null,
        null,
        'Laporan ini juga tersimpan otomatis di database Clincoo. Email ini dikirim otomatis — mohon jangan dibalas.'
      ),
      attachment: attachments.map(function (dataUrl, i) {
        return { name: 'laporan-' + (reportId || 'x') + '-' + (i + 1) + '.jpg', content: dataUrl.split(',')[1] };
      })
    });

    // 3. Notifikasi in-app ke pemilik
    let notifOk = false;
    try {
      const owner = await getUserByEmail(db, ownerEmail);
      if (owner) {
        notifOk = await notifyEvent(db, owner, {
          source: 'Laporan Bug',
          type: 'bug_report',
          message: 'Laporan bug baru (' + categoryLabel + '): ' + description.slice(0, 140),
          link: ''
        });
      }
    } catch (e) { /* notifikasi in-app opsional */ }

    return new Response(JSON.stringify({ ok: true, id: reportId, email_sent: !!(emailResult && emailResult.sent), email_reason: emailResult && emailResult.reason, notified: notifOk }), {
      headers: { 'Content-Type': 'application/json', ...CORS }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { 'Content-Type': 'application/json', ...CORS } });
  }
}
