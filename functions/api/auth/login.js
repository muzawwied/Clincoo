import { initTables, verifyPassword, publicUser, createSession, json, CORS } from './shared.js';

export async function onRequestOptions() { return new Response(null, { status: 204, headers: CORS }); }

// EMAIL AUTH DINONAKTIFKAN PERMANEN (5 Okt 2026): masuk hanya via Google/GitHub OAuth.
// Jalur email (login, daftar, lupa/reset sandi) ditolak di server — tidak ada jalur samping.
export async function onRequestPost({ request, env }) {
  return json({ error: 'Pendaftaran & login via email telah dinonaktifkan permanen. Silakan gunakan Masuk dengan Google atau GitHub.', email_login_disabled: true }, 410);
}
