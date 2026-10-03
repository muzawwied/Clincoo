// Promo fitur Clincoo — email pemberitahuan fitur baru untuk PEMILIK AKUN sendiri.
// POST { feature, email? }   [auth Bearer]
//   feature: 'email' → promo fitur Email (kirim email dari situs deploy)
//   email: false → notifikasi in-app saja (mode senyap)
// Hanya pernah mengirim ke email akun pemilik token — tidak bisa dikirim ke orang lain.
import { currentUser } from './user-scope.js';
import { sendEmail, notifyEvent } from './notify-helpers.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, statusText: status >= 400 ? 'Error' : 'OK', headers: { 'Content-Type': 'application/json', ...CORS } });
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

function promoEmailHtml(name) {
  const sapaan = name ? ('Halo ' + name + ',') : 'Halo,';
  const tgl = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' }) + ' WIB';
  const rows = [
    ['Apa itu', 'Kirim email otomatis dari situs yang kamu deploy'],
    ['Contoh', 'Form kontak, notifikasi, verifikasi akun'],
    ['Cara pakai', 'Aktifkan Email di pengaturan proyek, tempel API key ke situsmu'],
    ['Kuota', '1.000 email per bulan, gratis']
  ].map(function (d, i) {
    var border = i < rows.length ? '' : '';
    return '<tr>' +
      '<td style="padding:12px 0;color:#9ca3af;font-size:11px;font-weight:bold;letter-spacing:1px;text-transform:uppercase;vertical-align:top;white-space:nowrap;padding-right:16px">' + d[0] + '</td>' +
      '<td style="padding:12px 0;color:#111827;font-size:13px;font-weight:bold;text-align:right;word-break:break-word">' + d[1] + '</td>' +
    '</tr>';
  }).join('');
  return '<div style="background:#ffffff;padding:36px 24px;font-family:Arial,Helvetica,sans-serif">' +
    '<div style="max-width:520px;margin:0 auto">' +
      '<div style="padding-bottom:20px;border-bottom:1px solid #eceef1">' +
        '<img src="https://app.clincoo.buzz/assets/logo-clinqoo.png" width="36" height="36" alt="Clincoo" style="display:inline-block;vertical-align:middle;border-radius:10px;margin-right:12px">' +
        '<span style="font-size:20px;font-weight:bold;letter-spacing:2px;color:#0a0a0a;vertical-align:middle">Clincoo</span>' +
      '</div>' +
      '<h1 style="margin:28px 0 6px;font-size:18px;color:#111827;font-weight:bold">Fitur Baru: Email untuk Situsmu</h1>' +
      '<p style="margin:0 0 18px;color:#9ca3af;font-size:12px">' + tgl + '</p>' +
      '<p style="margin:0 0 12px;color:#374151;font-size:14px;line-height:1.7">' + sapaan + '</p>' +
      '<p style="margin:0 0 14px;color:#374151;font-size:14px;line-height:1.7">Kabar baik untuk situs yang kamu deploy lewat Clincoo: sekarang kamu bisa <b style="color:#111827">mengirim email otomatis langsung dari situsmu</b> — tanpa perlu layanan email pihak ketiga.</p>' +
      '<p style="margin:0 0 24px;color:#374151;font-size:14px;line-height:1.7">Formulir kontak yang mengirim pesan ke inbox-mu, notifikasi pendaftaran baru, kode verifikasi akun — semua tinggal aktifkan di pengaturan proyek dan situsmu siap mengirim email.</p>' +
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:0 0 12px">' + rows + '</table>' +
      '<a href="https://app.clincoo.buzz/" style="display:inline-block;background:#0a0a0a;color:#ffffff;padding:13px 32px;border-radius:999px;text-decoration:none;font-size:13px;font-weight:bold;margin-top:12px">Coba Sekarang</a>' +
      '<p style="margin:20px 0 0;color:#9ca3af;font-size:12px;line-height:1.7">Buka aplikasi Clincoo, pilih proyekmu, lalu aktifkan fitur Email. API key akan langsung terbitkan untuk dipasang di situsmu.</p>' +
      '<div style="margin-top:36px;border-top:1px solid #eceef1;padding-top:16px">' +
        '<p style="margin:0 0 10px;color:#9ca3af;font-size:12px;line-height:1.6">Catatan: pada mode terbatas saat ini, email hanya bisa dikirim ke alamat email akun Clincoo-mu sendiri.</p>' +
        '<p style="margin:0 0 10px;color:#9ca3af;font-size:11px;line-height:1.7">Butuh bantuan? Buka pusat bantuan di aplikasi Clincoo atau kunjungi blog.clincoo.buzz.</p>' +
        '<p style="margin:0 0 10px;color:#9ca3af;font-size:11px;line-height:1.7">Email ini dikirim otomatis oleh sistem Clincoo. Clincoo tidak membagikan data pribadi Anda kepada pihak ketiga &mdash; mohon jangan dibalas.</p>' +
        '<p style="margin:0;color:#d1d5db;font-size:11px">&copy; 2026 Clincoo &middot; Semua hak dilindungi</p>' +
      '</div>' +
    '</div>' +
  '</div>';
}

export async function onRequestPost({ request, env }) {
  let body = {};
  try { body = await request.json(); } catch (e) {}
  const feature = String(body.feature || '');
  if (feature !== 'email') return json({ ok: false, error: 'feature tidak dikenal' }, 400);

  const user = await currentUser(request, env);
  if (!user || !user.id) return json({ ok: false, error: 'unauthorized' }, 401);

  const message = 'Fitur baru Clincoo: kirim email otomatis dari situs deploy-mu. Aktifkan di pengaturan proyek.';
  const notified = await notifyEvent(env.DB, user, { source: 'Clincoo', type: 'promo', message: message, link: '/' });

  if (body.email === false) {
    return json({ ok: true, sent: false, notified: notified });
  }

  const result = await sendEmail(env, {
    toEmail: user.email,
    toName: user.name,
    subject: 'Fitur baru Clincoo: Email untuk situsmu',
    html: promoEmailHtml(user.name)
  });
  return json({ ok: result.sent, sent: result.sent, to: user.email, via: result.via, reason: result.reason, notified: notified });
}
