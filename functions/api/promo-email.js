// Email promosi: pemberitahuan fitur Email Clincoo (Broadcast / Otomasi / Template / Kunci API).
// Template dipisah di buildPromoEmail() supaya bisa dipakai ulang untuk kirim massal nanti.
//
// Cara pakai:
//  - Uji ke akun sendiri: POST /api/promo-email dengan header Authorization: Bearer <token akun>
//    -> kirim ke email akun yang login (alamat tidak diungkap di respons, alasan privasi).
//  - Kirim manual satu alamat (pemilik): POST dengan header x-cron-secret: <CRON_SECRET>
//    dan body {"to":"nama@email.com","name":"Nama"}.
import { getSecret, sendEmail, flatTemplate, getUserByEmail } from './notify-helpers.js';
import { currentUser } from './user-scope.js';
import { getEffectivePlanByUserKey } from './plan-helpers.js';

// Kuota email bulanan per paket — identik dengan functions/api/email/index.js
const PLAN_EMAIL_LIMITS = { Starter: 100, Pro: 500, Bisnis: 1000 };

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

// Template email promosi fitur Email. name = nama penerima, plan = nama paket penerima.
export function buildPromoEmail(name, plan) {
  const planName = plan || 'Starter';
  const quota = (PLAN_EMAIL_LIMITS[planName] || 100).toLocaleString('id-ID');
  return {
    subject: 'Baru di Clincoo: Kirim Email dari Proyekmu',
    html: flatTemplate(
      'Fitur Email Kini Hadir di Clincoo',
      name || '',
      '<p style="margin:0 0 20px;color:#374151;font-size:14px;line-height:1.7">Sekarang kamu bisa mengirim email langsung dari proyek Clincoo. Cukup buka salah satu proyek, masuk ke tab <b>Pengaturan &rarr; Email</b> — tanpa setup SMTP, tanpa ribet.</p>' +
      '<p style="margin:0 0 20px;color:#374151;font-size:14px;line-height:1.7">Broadcast massal ke audiens, email terjadwal otomatis, template siap pakai, hingga pengiriman via API secret key — semuanya terpusat di satu halaman.</p>',
      [
        ['Broadcast & Audiens', 'Kirim ke banyak penerima sekaligus'],
        ['Otomasi & Template', 'Email terjadwal otomatis, template siap pakai'],
        ['Kunci API', 'Kirim via API secret key, tanpa SMTP'],
        ['Metrik & Log', 'Pantau terkirim, dibuka, dan sisa kuota'],
        ['Kuota Paket ' + planName, quota + ' kredit email/bulan']
      ],
      'Buka Fitur Email',
      'https://app.clincoo.buzz/proyek/pengaturan/email/',
      'Email ini dikirim untuk memberi tahu fitur baru di Clincoo.'
    )
  };
}

async function sendPromo(env, toEmail, name, plan) {
  const tpl = buildPromoEmail(name, plan);
  return await sendEmail(env, { toEmail: toEmail, toName: name || '', subject: tpl.subject, html: tpl.html });
}

// Paket efektif pemilik alamat (jika terdaftar) — untuk baris kuota yang personal.
async function planForEmail(env, email) {
  try {
    const u = await getUserByEmail(env.DB, email);
    if (u && u.id != null) {
      const eff = await getEffectivePlanByUserKey(env.DB, 'u' + u.id);
      if (eff && eff.plan) return { plan: eff.plan, user: u };
    }
  } catch (e) {}
  return { plan: null, user: null };
}

export async function onRequestPost({ request, env }) {
  try {
    const body = await request.json().catch(() => ({})) || {};

    // Jalur pemilik: satu alamat manual (x-cron-secret)
    const cronSecret = await getSecret(env, 'CRON_SECRET');
    const providedCron = request.headers.get('x-cron-secret') || '';
    if (cronSecret && providedCron && providedCron === cronSecret) {
      const to = String(body.to || '').trim();
      if (!to || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return json({ success: false, error: 'alamat email tidak valid' }, 400);
      const pl = await planForEmail(env, to);
      const r = await sendPromo(env, to, body.name || (pl.user && pl.user.name) || '', pl.plan);
      if (r && r.sent) return json({ success: true, sent: 'manual' });
      return json({ success: false, error: 'gagal kirim: ' + (r && r.reason) || 'tidak diketahui' }, 502);
    }

    // Jalur uji: kirim ke email akun sendiri (Bearer token)
    const user = await currentUser(env, request);
    if (!user || !user.email) return json({ success: false, need_login: true }, 401);
    const eff = await getEffectivePlanByUserKey(env.DB, 'u' + user.id).catch(() => null);
    const r = await sendPromo(env, user.email, user.name || '', (eff && eff.plan) || user.plan || null);
    if (r && r.sent) return json({ success: true, sent: 'akun kamu' });
    return json({ success: false, error: 'gagal kirim: ' + ((r && r.reason) || 'tidak diketahui') }, 502);
  } catch (e) {
    return json({ success: false, error: e.message }, 500);
  }
}
