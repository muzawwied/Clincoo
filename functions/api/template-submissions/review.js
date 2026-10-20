// Cloudflare Pages Function — /api/template-submissions/review (publik via token)
// CTA dari email reviewer: Setujui / Tolak pengajuan template komunitas.
//   GET ?token=...&action=approve|tolak  → halaman HTML konfirmasi sederhana.
// Token unik per pengajuan (randomHex) — tanpa token tidak ada yang bisa diubah.
const CORS = { 'Access-Control-Allow-Origin': '*' };

function htmlPage(title, msg, color) {
  return new Response(
    '<!DOCTYPE html><html lang="id"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">' +
    '<title>' + title + ' — Clincoo</title>' +
    '<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;800&display=swap" rel="stylesheet">' +
    '<style>body{font-family:Inter,Arial,sans-serif;background:#fafafa;margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;color:#111}' +
    '.box{max-width:420px;text-align:center;padding:40px 28px}h1{font-size:20px;margin:18px 0 8px}p{font-size:14px;color:#6b7280;line-height:1.6;margin:0}' +
    '.badge{width:64px;height:64px;border-radius:50%;margin:0 auto;display:flex;align-items:center;justify-content:center;font-size:28px;color:#fff}</style></head><body>' +
    '<div class="box"><div class="badge" style="background:' + color + '">' + (color === '#059669' ? '&#10003;' : '&#10007;') + '</div>' +
    '<h1>' + title + '</h1><p>' + msg + '</p></div></body></html>',
    { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...CORS } }
  );
}

export async function onRequestGet({ request, env }) {
  const db = env.DB;
  if (!db) return htmlPage('Kesalahan', 'Database tidak tersedia.', '#dc2626');
  try {
    const url = new URL(request.url);
    const token = (url.searchParams.get('token') || '').trim();
    const action = url.searchParams.get('action') === 'tolak' ? 'tolak' : 'approve';
    if (!token) return htmlPage('Tautan tidak valid', 'Token tinjauan tidak ditemukan.', '#dc2626');
    const row = await db.prepare('SELECT * FROM template_submissions WHERE review_token = ?').bind(token).first();
    if (!row) return htmlPage('Tidak ditemukan', 'Pengajuan template untuk token ini tidak ditemukan.', '#dc2626');
    if (row.status !== 'pending') {
      const label = row.status === 'approved' ? 'sudah DISETUJUI' : 'sudah DITOLAK';
      return htmlPage('Sudah diproses', 'Pengajuan template "' + (row.title || '') + '" ' + label + ' sebelumnya. Tidak ada perubahan.', '#6b7280');
    }
    const status = action === 'approve' ? 'approved' : 'rejected';
    await db.prepare("UPDATE template_submissions SET status = ?, reviewed_at = datetime('now') WHERE id = ? AND review_token = ?")
      .bind(status, row.id, token).run();
    if (action === 'approve') {
      return htmlPage('Template disetujui', 'Template "' + row.title + '" kini tampil di galeri template Clincoo beserta hitungan pemakaian dan kunjungan real-time.', '#059669');
    }
    return htmlPage('Template ditolak', 'Pengajuan template "' + row.title + '" ditolak dan tidak akan tampil di galeri Clincoo.', '#dc2626');
  } catch (e) {
    return htmlPage('Kesalahan', 'Terjadi kesalahan saat memproses: ' + e.message, '#dc2626');
  }
}
