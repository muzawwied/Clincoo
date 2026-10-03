// Notifikasi email domain Clincoo — dipanggil server-ke-server oleh backend domain
// (project Pages clincoo-domain) memakai Bearer token MILIK USER yang bersangkutan.
// Karena token yang divalidasi adalah token user itu sendiri, email HANYA pernah
// terkirim ke pemilik akun — tidak bisa dipakai pihak mana pun untuk mengirim email
// ke alamat orang lain.
//
// POST { type, domain, code?, email? }   [auth Bearer]
//   type  : domain_otp | domain_added | domain_verified | domain_deleted | domain_ns_lost
//   domain: nama domain (divalidasi + di-escape)
//   code  : kode OTP 6 digit (khusus type domain_otp)
//   email : false -> kirim notifikasi in-app saja, TANPA email (mode senyap)
import { currentUser } from './user-scope.js';
import { sendEmail, notifyEvent } from './notify-helpers.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...CORS } });
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function isValidDomain(s) {
  if (!s || typeof s !== 'string') return false;
  s = s.trim().toLowerCase();
  if (s.length > 253 || /\s/.test(s)) return false;
  if (!/^[a-z0-9.-]+$/.test(s)) return false;
  const parts = s.split('.');
  if (parts.length < 2) return false;
  if (!/^[a-z]{2,}$/.test(parts[parts.length - 1])) return false;
  return parts.every(p => p && p.length <= 63 && /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(p));
}

function isValidCode(s) {
  return typeof s === 'string' && /^\d{6}$/.test(s.trim());
}

// Template email FLAT (tanpa kartu/box): sapaan personal, judul, penjelasan detail
// yang rapi, baris rincian, CTA, dan footer.
function flatEmail(o) {
  const tgl = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' }) + ' WIB';
  const rows = (o.details || []).map(d =>
    '<tr>' +
      '<td style="padding:9px 0;border-bottom:1px solid #eceef1;color:#6b7280;font-size:13px;white-space:nowrap">' + esc(d[0]) + '</td>' +
      '<td style="padding:9px 0 9px 16px;border-bottom:1px solid #eceef1;color:#111827;font-size:13px;font-weight:bold;text-align:right">' + esc(d[1]) + '</td>' +
    '</tr>').join('');
  const codeBlock = o.code
    ? '<div style="margin:22px 0;padding:16px 0;border-top:2px solid #111827;border-bottom:2px solid #111827;text-align:center">' +
        '<span style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:34px;font-weight:bold;letter-spacing:10px;color:#111827">' + esc(o.code) + '</span>' +
      '</div>'
    : '';
  const cta = o.ctaText && o.ctaLink
    ? '<a href="' + esc(o.ctaLink) + '" style="display:inline-block;background:#0a0a0a;color:#ffffff;padding:12px 28px;border-radius:8px;text-decoration:none;font-size:13px;font-weight:bold;margin-top:24px">' + esc(o.ctaText) + '</a>'
    : '';
  return '' +
  '<div style="background:#ffffff;padding:36px 20px;font-family:Arial,Helvetica,sans-serif">' +
    '<div style="max-width:560px;margin:0 auto">' +
      '<div style="padding:0 0 18px;margin-bottom:24px;border-bottom:2px solid #0a0a0a">' +
        '<span style="color:#0a0a0a;font-size:20px;font-weight:bold;letter-spacing:2px">Clincoo</span>' +
      '</div>' +
      '<p style="margin:0 0 10px;color:#111827;font-size:15px;line-height:1.7;font-weight:bold">' + esc(o.greeting) + '</p>' +
      '<h2 style="margin:0 0 6px;color:#111827;font-size:20px;font-weight:bold">' + esc(o.title) + '</h2>' +
      '<p style="margin:0 0 22px;color:#9ca3af;font-size:12px">' + tgl + '</p>' +
      '<p style="margin:0 0 14px;color:#374151;font-size:14px;line-height:1.8">' + o.intro + '</p>' +
      codeBlock +
      '<p style="margin:0 0 22px;color:#374151;font-size:14px;line-height:1.8">' + o.body + '</p>' +
      (rows ? '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:0 0 8px">' + rows + '</table><div style="height:16px"></div>' : '') +
      cta +
      '<div style="margin-top:36px;padding-top:18px;border-top:1px solid #eceef1">' +
        '<p style="margin:0 0 8px;color:#6b7280;font-size:12px;line-height:1.7">' + (o.footerNote || '') + '</p>' +
        '<p style="margin:0 0 6px;color:#9ca3af;font-size:11px;line-height:1.6"><b style="color:#374151">Email ini dikirim otomatis oleh sistem Clincoo</b> sebagai bagian dari pemberitahuan keamanan dan aktivitas domain akunmu. Mohon jangan dibalas.</p>' +
        '<p style="margin:0;color:#9ca3af;font-size:11px">&copy; 2026 Clincoo &middot; Semua hak dilindungi</p>' +
      '</div>' +
    '</div>' +
  '</div>';
}

const DOMAIN_HOME = 'https://app.clincoo.buzz/domain/';
function domainDetail(d) { return DOMAIN_HOME + 'detail/?domain=' + encodeURIComponent(d); }

// Konfigurasi isi pesan per tipe — bahasa Indonesia, jelas & detail.
function buildMessage(type, domain, code, user, email) {
  const name = (user && user.name && String(user.name).trim()) || (user && user.email ? String(user.email).split('@')[0] : '');
  const greeting = name ? ('Halo ' + name + ',') : 'Halo,';
  const dEsc = esc(domain);
  const t = {};
  t.domain_otp = {
    subject: 'Kode Verifikasi Tambah Domain — ' + domain,
    email: true,
    title: 'Kode Verifikasi Tambah Domain',
    intro: 'Kami mendeteksi aktivitas penambahan domain yang <b>tidak biasa</b> di akun Clincoo-mu. Untuk keamanan, kami meminta konfirmasi lewat email ini sebelum domain <b>' + dEsc + '</b> ditambahkan ke akunmu.',
    code: isValidCode(code) ? code : null,
    body: 'Masukkan kode di atas di halaman verifikasi domain untuk melanjutkan. Kode ini berlaku <b>10 menit</b> dan hanya bisa dipakai sekali.',
    details: [['Domain', domain], ['Diminta oleh', (user && user.email) || 'akunmu']],
    footerNote: 'Jika kamu tidak merasa menambahkan domain ini, abaikan email ini — tanpa kode di atas, domain tidak akan pernah ditambahkan ke akunmu. Tidak ada tindakan lebih lanjut yang diperlukan.'
  };
  t.domain_added = {
    subject: 'Domain Baru Ditambahkan — ' + domain,
    email: true,
    title: 'Domain Berhasil Ditambahkan',
    intro: 'Domain <b>' + dEsc + '</b> baru saja ditambahkan ke akun Clincoo-mu' + (email === 'otp' ? ' setelah melewati verifikasi kode email (aktivitas dianggap tidak biasa)' : '') + '.',
    body: 'Selanjutnya, verifikasi kepemilikan domain dengan mengarahkan nameserver-nya ke Cloudflare. Domain baru akan aktif setelah nameservernya terdeteksi benar. Kamu bisa mengelola record DNS, SSL, dan pengaturan zone lewat halaman detail domain.',
    details: [['Domain', domain], ['Status awal', 'Menunggu verifikasi'], ['Langkah berikutnya', 'Atur nameserver di registrar']],
    ctaText: 'Buka Halaman Verifikasi',
    ctaLink: DOMAIN_HOME + 'verifikasi/?domain=' + encodeURIComponent(domain),
    footerNote: 'Jika kamu tidak merasa menambahkan domain ini, segera amankan akunmu dengan mengganti kata sandi, lalu hapus domain yang tidak dikenal dari halaman Domain.'
  };
  t.domain_verified = {
    subject: 'Domain Aktif — ' + domain,
    email: true,
    title: 'Domain Kamu Sudah Aktif',
    intro: 'Kabar baik. Verifikasi kepemilikan domain <b>' + dEsc + '</b> berhasil. Nameserver domain-mu sudah mengarah ke Cloudflare, dan domain sekarang berstatus <b>Aktif</b>.',
    body: 'Mulai sekarang kamu bisa mengelola record DNS (A, CNAME, TXT, dan lainnya), memantau status SSL, serta mengatur pengaturan zone domain ini dari dashboard Domain Clincoo. Tidak ada langkah lain yang diperlukan.',
    details: [['Domain', domain], ['Status', 'Aktif'], ['Metode verifikasi', 'Nameserver Cloudflare']],
    ctaText: 'Kelola Domain',
    ctaLink: domainDetail(domain),
    footerNote: 'Catatan: jika di kemudian hari nameserver domain ini diubah dari Cloudflare ke penyedia lain, sistem kami akan mendeteksinya dan status domain akan kembali menjadi menunggu verifikasi.'
  };
  t.domain_deleted = {
    subject: 'Domain Dihapus — ' + domain,
    email: true,
    title: 'Domain Telah Dihapus',
    intro: 'Domain <b>' + dEsc + '</b> telah dihapus dari akun Clincoo-mu. Seluruh pengaturan DNS, catatan verifikasi, dan data terkait domain ini juga ikut terhapus.',
    body: 'Tindakan ini bersifat permanen dan tidak dapat dibatalkan. Kalau kamu berubah pikiran, kamu bisa menambahkan domain ini kembali kapan saja dari halaman Domain — proses verifikasi akan diulang dari awal.',
    details: [['Domain', domain], ['Status', 'Terhapus'], ['Waktu penghapusan', new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' }) + ' WIB']],
    ctaText: 'Buka Halaman Domain',
    ctaLink: DOMAIN_HOME,
    footerNote: 'PENTING: jika kamu tidak merasa menghapus domain ini, kemungkinan akunmu sedang digunakan pihak lain. Segera ganti kata sandi akun Clincoo-mu dan periksa daftar domain untuk aktivitas lain yang tidak dikenal.'
  };
  t.domain_ns_lost = {
    subject: 'Domain Terlepas dari Nameserver — ' + domain,
    email: true,
    title: 'Domain Terlepas dari Nameserver Cloudflare',
    intro: 'Pemeriksaan otomatis kami menemukan bahwa nameserver domain <b>' + dEsc + '</b> tidak lagi mengarah ke Cloudflare. Status domain ini dikembalikan menjadi <b>Menunggu Verifikasi</b>.',
    body: 'Ini biasanya terjadi karena nameserver diubah di registrar domain (IDWebhost, Namecheap, dan lainnya), atau karena ada pihak lain yang mengendalikan domain-mu. Untuk mengembalikan status domain menjadi aktif: buka panel registrar domain-mu, arahkan kembali nameserver-nya ke pasangan Cloudflare yang tertera di halaman verifikasi, tunggu propagasi (beberapa menit hingga 24 jam), lalu ketuk Periksa Verifikasi.',
    details: [['Domain', domain], ['Status sekarang', 'Menunggu Verifikasi'], ['Penyebab umum', 'Nameserver diganti di registrar']],
    ctaText: 'Buka Halaman Verifikasi',
    ctaLink: DOMAIN_HOME + 'verifikasi/?domain=' + encodeURIComponent(domain),
    footerNote: 'Jika kamu sengaja mengubah nameserver domain ini ke penyedia lain, kamu bisa mengabaikan email ini — atau hapus domain-nya dari daftar bila sudah tidak dipakai.'
  };
  const m = t[type];
  if (!m) return null;
  return Object.assign({ greeting, type, domain }, m);
}

const IN_APP_TEXT = {
  domain_added: d => 'Domain ' + d + ' ditambahkan ke akunmu. Selesaikan verifikasi nameserver untuk mengaktifkannya.',
  domain_verified: d => 'Domain ' + d + ' sekarang aktif. Verifikasi nameserver berhasil.',
  domain_deleted: d => 'Domain ' + d + ' telah dihapus dari akunmu.',
  domain_ns_lost: d => 'Domain ' + d + ' terlepas dari nameserver Cloudflare. Status kembali ke menunggu verifikasi.'
};

export async function onRequestPost({ request, env, waitUntil }) {
  let body;
  try { body = await request.json(); } catch (e) { return json({ ok: false, error: 'bad_json' }, 400); }
  const type = String(body.type || '');
  const domain = String(body.domain || '').trim().toLowerCase();
  if (!['domain_otp', 'domain_added', 'domain_verified', 'domain_deleted', 'domain_ns_lost'].includes(type)) return json({ ok: false, error: 'unknown_type' }, 400);
  if (!isValidDomain(domain)) return json({ ok: false, error: 'invalid_domain' }, 400);

  const user = await currentUser(env, request);
  if (!user || !user.email) return json({ ok: false, error: 'login_required' }, 401);

  const m = buildMessage(type, domain, body.code, user, body.otp_used ? 'otp' : null);
  if (!m) return json({ ok: false, error: 'unknown_type' }, 400);

  // In-app notification (bell) — selain untuk OTP.
  let inApp = false;
  if (IN_APP_TEXT[type]) {
    try { inApp = await notifyEvent(env.DB, user, { source: 'Domain', type: type === 'domain_ns_lost' ? 'warning' : 'info', message: IN_APP_TEXT[type](domain), link: type === 'domain_deleted' ? DOMAIN_HOME : (type === 'domain_added' ? DOMAIN_HOME + 'verifikasi/?domain=' + encodeURIComponent(domain) : domainDetail(domain)) }); } catch (e) {}
  }

  // Email — mode senyap (email:false) hanya in-app. OTP selalu dikirim via email.
  if (body.email === false && type !== 'domain_otp') {
    return json({ ok: true, email: false, in_app: inApp });
  }

  const html = flatEmail(m);
  const res = await sendEmail(env, {
    toEmail: user.email,
    subject: m.subject,
    html
  });

  return json({ ok: !!res.sent, email: !!res.sent, via: res.via, reason: res.reason || null, in_app: inApp });
}
