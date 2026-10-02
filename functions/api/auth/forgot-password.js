// POST /api/auth/forgot-password — kirim link atur ulang kata sandi via email (Brevo)
// Selalu balas success agar tidak membocorkan keberadaan akun.
import { initTables, json, validEmail, randomHex } from './shared.js';
import { emailTemplate, sendEmail } from '../notify-helpers.js';

export async function onRequestOptions() {
  return new Response(null, { headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' } });
}

async function sha256Hex(str) {
  const bits = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(bits)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function onRequestPost({ request, env }) {
  const db = env.DB;
  if (!db) return json({ error: 'D1 not bound' }, 500);
  try {
    await initTables(db);
    await db.prepare(`CREATE TABLE IF NOT EXISTS password_resets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      token_hash TEXT NOT NULL,
      used INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL
    )`).run();

    const body = await request.json().catch(() => ({}));
    const email = String(body.email || '').trim().toLowerCase();
    if (!validEmail(email)) return json({ error: 'Email tidak valid' }, 400);

    const user = await db.prepare('SELECT * FROM auth_users WHERE lower(email) = ?').bind(email).first();
    if (user) {
      const token = randomHex(32);
      const tokenHash = await sha256Hex(token);
      const expires = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      // Satu token aktif per user: hapus yang lama belum terpakai
      await db.prepare('DELETE FROM password_resets WHERE user_id = ? AND used = 0').bind(user.id).run();
      await db.prepare('INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES (?, ?, ?)')
        .bind(user.id, tokenHash, expires).run();

      const origin = new URL(request.url).origin;
      const resetLink = origin + '/akun/reset-sandi.html?token=' + token;
      try {
        await sendEmail(env, {
          toEmail: user.email, toName: user.name || '',
          subject: 'Atur Ulang Kata Sandi Clincoo',
          html: emailTemplate(
            'Atur Ulang Kata Sandi',
            user.name || '',
            'Kami menerima permintaan untuk mengatur ulang kata sandi akun Clincoo Anda. Klik tombol di bawah untuk membuat kata sandi baru — tautan ini hanya berlaku 1 jam.',
            [['Email akun', user.email], ['Berlaku hingga', '1 jam sejak email ini dikirim']],
            'Atur Kata Sandi Baru', resetLink,
            'Jika Anda tidak meminta perubahan ini, abaikan email ini — kata sandi Anda tetap aman.'
          )
        });
      } catch (e) {
        // Email gagal (mis. layanan sedang bermasalah) — tetap jangan bocorkan status akun
      }
    }
    return json({ success: true, message: 'Jika email terdaftar, tautan atur ulang telah dikirim.' });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
