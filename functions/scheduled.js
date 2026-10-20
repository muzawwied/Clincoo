// Cloudflare Pages — Cron Trigger: sinkron laporan user ke GitHub tiap 15 menit.
// Jadwal didaftarkan di wrangler.toml ([triggers] crons).
// Menangkap perubahan di luar pendaftaran baru: upgrade/downgrade paket,
// topup saldo, dsb. (pendaftaran baru sudah real-time via hook di auth).

import { syncUserReport } from './api/user-report-sync.js';

export async function scheduled(event, env, ctx) {
  ctx.waitUntil((async () => {
    try {
      const r = await syncUserReport(env);
      console.log('[user-report-sync]', JSON.stringify(r));
    } catch (e) {
      console.error('[user-report-sync] gagal:', e.message);
    }
  })());
}
