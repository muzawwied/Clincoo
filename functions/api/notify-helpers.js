// Helpers notifikasi in-app & email (Resend) Clincoo — template profesional, per-akun.
// JANGAN pakai prefix "_" pada nama file (wrangler mengecualikannya dari bundle).
import { rowScope } from './user-scope.js';

export function formatIDR(n) {
  const v = Number(n);
  if (!isFinite(v)) return '0';
  return v.toLocaleString('id-ID');
}

// Ambil secret dari env Pages atau tabel env_vars D1 (key global = project_id NULL)
export async function getSecret(env, key) {
  if (env && env[key]) return env[key];
  try {
    const row = await env.DB.prepare("SELECT value FROM env_vars WHERE key = ? AND (project_id IS NULL OR project_id = '')").bind(key).first();
    if (row && row.value) return row.value;
  } catch (e) {}
  return null;
}

export async function getUserByEmail(db, email) {
  if (!db || !email) return null;
  try {
    return await db.prepare('SELECT * FROM auth_users WHERE lower(email) = ?').bind(String(email).trim().toLowerCase()).first();
  } catch (e) { return null; }
}

// Template email profesional Clincoo (logo + rincian + CTA + footer privasi)
export function emailTemplate(title, name, introText, details, ctaText, ctaLink, footerNote) {
  const sapaan = name ? ('Halo ' + name + ',') : 'Halo,';
  const tgl = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' }) + ' WIB';
  const rows = (details || [])
    .map(function (d) {
      return '<tr>' +
        '<td style="padding:10px 0;border-bottom:1px solid #eceef1;color:#6b7280;font-size:13px;white-space:nowrap">' + d[0] + '</td>' +
        '<td style="padding:10px 0 10px 16px;border-bottom:1px solid #eceef1;color:#111827;font-size:13px;font-weight:bold;text-align:right">' + d[1] + '</td>' +
      '</tr>';
    })
    .join('');
  const cta = ctaText && ctaLink
    ? '<a href="' + ctaLink + '" style="display:inline-block;background:#0a0a0a;color:#ffffff;padding:12px 28px;border-radius:8px;text-decoration:none;font-size:13px;font-weight:bold;margin-top:24px">' + ctaText + '</a>'
    : '';
  const footer = footerNote
    ? '<p style="margin:0 0 8px;color:#9ca3af;font-size:12px;line-height:1.6">' + footerNote + '</p>'
    : '';
  return '<div style="background:#f4f5f7;padding:32px 16px;font-family:Arial,Helvetica,sans-serif">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;border:1px solid #e5e7eb;border-collapse:separate;overflow:hidden">' +
      '<tr><td style="background:#0a0a0a;padding:22px 32px">' +
        '<img src="https://base44.app/api/apps/6a8bb7d04e18a36f9c03702c/files/mp/public/6a8bb7d04e18a36f9c03702c/d29b4d44e_clinqoo-logo.png" width="34" height="34" alt="Clincoo" style="display:inline-block;vertical-align:middle;border-radius:8px;margin-right:12px">' +
        '<span style="color:#ffffff;font-size:19px;font-weight:bold;letter-spacing:2px;vertical-align:middle">Clincoo</span>' +
      '</td></tr>' +
      '<tr><td style="padding:32px">' +
        '<h1 style="margin:0 0 6px;font-size:18px;color:#111827;font-weight:bold">' + title + '</h1>' +
        '<p style="margin:0 0 20px;color:#9ca3af;font-size:12px">' + tgl + '</p>' +
        '<p style="margin:0 0 12px;color:#374151;font-size:14px;line-height:1.7">' + sapaan + '</p>' +
        '<p style="margin:0 0 20px;color:#374151;font-size:14px;line-height:1.7">' + introText + '</p>' +
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">' + rows + '</table>' +
        cta +
      '</td></tr>' +
      '<tr><td style="padding:18px 32px;background:#f9fafb;border-top:1px solid #eceef1">' +
        footer +
        '<div style="border-top:1px solid #eceef1;padding-top:12px;margin-top:10px">' +
          '<p style="margin:0 0 6px;color:#6b7280;font-size:11px;line-height:1.6"><b style="color:#374151">Privasi Anda terlindungi.</b> Clincoo tidak membagikan data pribadi Anda kepada pihak ketiga. Email ini dikirim otomatis oleh sistem Clincoo — mohon jangan dibalas.</p>' +
          '<p style="margin:0;color:#9ca3af;font-size:11px">&copy; 2026 Clincoo &middot; Semua hak dilindungi</p>' +
        '</div>' +
      '</td></tr>' +
    '</table>' +
  '</div>';
}

// Template email OTP Clincoo — FLAT (tanpa card): konten langsung di latar putih,
// brand kiri atas ala halaman checkout, kode besar, detail, CTA, footer keamanan.
// opts: { name, code, purpose, email, minutes, ctaText, ctaLink }
export function otpEmail(opts) {
  const o = opts || {};
  const code = String(o.code || '000000');
  const minutes = o.minutes || 10;
  const tgl = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' }) + ' WIB';
  const rows = [
      ['Tujuan', o.email || '-'],
      ['Berlaku hingga', minutes + ' menit'],
      ['Dikirim', tgl]
    ]
    .map(function (d) {
      return '<tr>' +
        '<td style="padding:10px 0;border-bottom:1px solid #eceef1;color:#6b7280;font-size:13px">' + d[0] + '</td>' +
        '<td style="padding:10px 0 10px 16px;border-bottom:1px solid #eceef1;color:#111827;font-size:13px;font-weight:bold;text-align:right">' + d[1] + '</td>' +
      '</tr>';
    })
    .join('');
  const cta = '<a href="' + (o.ctaLink || 'https://app.clincoo.buzz/') + '" style="display:inline-block;background:#0a0a0a;color:#ffffff;padding:13px 32px;border-radius:999px;text-decoration:none;font-size:13px;font-weight:bold;margin-top:24px">' + (o.ctaText || 'Verifikasi Sekarang') + '</a>';
  return '<div style="background:#ffffff;padding:36px 24px;font-family:Arial,Helvetica,sans-serif">' +
    '<div style="max-width:520px;margin:0 auto">' +
      '<div style="padding-bottom:20px;border-bottom:1px solid #eceef1">' +
        '<img src="https://base44.app/api/apps/6a8bb7d04e18a36f9c03702c/files/mp/public/6a8bb7d04e18a36f9c03702c/d29b4d44e_clinqoo-logo.png" width="36" height="36" alt="Clincoo" style="display:inline-block;vertical-align:middle;border-radius:10px;margin-right:12px">' +
        '<span style="font-size:20px;font-weight:bold;letter-spacing:2px;color:#0a0a0a;vertical-align:middle">Clincoo</span>' +
      '</div>' +
      '<h1 style="margin:28px 0 6px;font-size:18px;color:#111827;font-weight:bold">Kode Verifikasi Akun Anda</h1>' +
      '<p style="margin:0 0 18px;color:#9ca3af;font-size:12px">' + tgl + '</p>' +
      '<p style="margin:0 0 12px;color:#374151;font-size:14px;line-height:1.7">' + (o.name ? 'Halo ' + o.name + ',' : 'Halo,') + '</p>' +
      '<p style="margin:0 0 20px;color:#374151;font-size:14px;line-height:1.7">' + (o.purpose || 'Gunakan kode berikut untuk menyelesaikan verifikasi akun Clincoo Anda.') + '</p>' +
      '<div style="margin:0 0 20px;padding:22px 0;border-top:1px solid #eceef1;border-bottom:1px solid #eceef1;text-align:center">' +
        '<span style="font-size:36px;font-weight:bold;letter-spacing:12px;color:#0a0a0a">' + code + '</span>' +
      '</div>' +
      '<p style="margin:0 0 20px;color:#374151;font-size:13px;line-height:1.7"><b style="color:#111827">Penting:</b> jangan bagikan kode ini kepada siapa pun, termasuk pihak yang mengaku dari tim Clincoo. Staf Clincoo tidak akan pernah meminta kode ini.</p>' +
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:0 0 8px">' + rows + '</table>' +
      cta +
      '<div style="margin-top:36px;border-top:1px solid #eceef1;padding-top:16px">' +
        '<p style="margin:0 0 8px;color:#9ca3af;font-size:12px;line-height:1.6">Kode ini hanya berlaku ' + minutes + ' menit dan hanya dapat digunakan sekali. Jika Anda tidak meminta kode ini, abaikan email ini — akun Anda tetap aman.</p>' +
        '<p style="margin:0 0 6px;color:#6b7280;font-size:11px;line-height:1.6"><b style="color:#374151">Privasi Anda terlindungi.</b> Clincoo tidak membagikan data pribadi Anda kepada pihak ketiga. Email ini dikirim otomatis oleh sistem Clincoo — mohon jangan dibalas.</p>' +
        '<p style="margin:0;color:#9ca3af;font-size:11px">&copy; 2026 Clincoo &middot; Semua hak dilindungi</p>' +
      '</div>' +
    '</div>' +
  '</div>';
}

// Kirim email via Resend. opts: { toEmail, toName, subject, html, attachment }. Hasil: { sent, via, reason }
// attachment format lama Resend [{name, content}] otomatis dinormalisasi ke [{filename, content}] Resend.
export async function sendEmail(env, opts) {
  const apiKey = await getSecret(env, 'RESEND_API_KEY');
  if (!apiKey || !opts || !opts.toEmail) return { sent: false, via: null, reason: 'no_api_key_or_recipient' };
  const senderEmail = (await getSecret(env, 'RESEND_SENDER_EMAIL')) || (await getSecret(env, 'BREVO_SENDER_EMAIL'));
  if (!senderEmail) return { sent: false, via: null, reason: 'no_sender' };
  const senderName = (await getSecret(env, 'RESEND_SENDER_NAME')) || (await getSecret(env, 'BREVO_SENDER_NAME')) || 'Clincoo';
  try {
    const attachments = (Array.isArray(opts.attachment) ? opts.attachment : [])
      .filter(function (a) { return a && a.content; })
      .map(function (a) { return { filename: a.filename || a.name, content: a.content }; });
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: (opts.senderName || senderName) + ' <' + senderEmail + '>',
        to: [opts.toEmail],
        subject: opts.subject,
        html: opts.html,
        ...(opts.replyTo ? { reply_to: opts.replyTo } : {}),
        ...(attachments.length ? { attachments: attachments } : {})
      })
    });
    return { sent: res.ok, via: 'resend', reason: res.ok ? null : ('HTTP ' + res.status + (res.status === 403 ? ' (pengirim belum terverifikasi di Resend)' : '')) };
  } catch (e) {
    return { sent: false, via: 'resend', reason: String(e && e.message || e) };
  }
}

// Notifikasi in-app, di-scope per akun (kolom user_id). n: { source, type, message, link }
export async function notifyEvent(db, user, n) {
  if (!db || !n || !n.message) return false;
  const source = n.source || 'Sistem';
  try {
    const uid = await rowScope(db, 'notifications', user);
    await db.prepare('INSERT INTO notifications (source, type, message, link, user_id) VALUES (?, ?, ?, ?, ?)')
      .bind(source, n.type || 'info', n.message, n.link || '', uid).run();
    return true;
  } catch (e) {
    // fallback: tabel lama tanpa kolom type/link
    try {
      const uid2 = await rowScope(db, 'notifications', user);
      await db.prepare('INSERT INTO notifications (source, message, user_id) VALUES (?, ?, ?)').bind(source, n.message, uid2).run();
      return true;
    } catch (e2) { return false; }
  }
}
