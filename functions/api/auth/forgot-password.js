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

// EMAIL AUTH DINONAKTIFKAN PERMANEN (5 Okt 2026): masuk hanya via Google/GitHub OAuth.
// Jalur email (login, daftar, lupa/reset sandi) ditolak di server — tidak ada jalur samping.
export async function onRequestPost({ request, env }) {
  return json({ error: 'Pendaftaran & login via email telah dinonaktifkan permanen. Silakan gunakan Masuk dengan Google atau GitHub.', email_login_disabled: true }, 410);
}
