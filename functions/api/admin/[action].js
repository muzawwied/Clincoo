// Rute /api/admin/<action> (stats, users, ping, reports, activity) — Cloudflare Pages
// TIDAK merutekan subpath ke file tunggal functions/api/admin.js; subpath wajib
// lewat file param seperti ini. Logika tetap satu di _core.js.
export { onRequestGet, onRequestPost } from './_core.js';
