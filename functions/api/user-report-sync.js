// Cloudflare Pages Functions — Sinkronisasi Laporan User ke GitHub (real-time)
// POST /api/user-report-sync  {action:'sync'}  — wajib header x-cron-secret (CRON_SECRET)
//
// File tujuan: muzawwied/Clincoo-Data/users-live.md (repo PRIVAT) — daftar user
// yang SELALU ter-update otomatis:
//   1. Real-time: hook di pendaftaran akun baru (register email + OAuth Google/GitHub)
//   2. Cron: functions/scheduled.js tiap 15 menit (menangkap perubahan lain:
//      upgrade paket, topup saldo, dsb.)
//   3. Manual: panggil endpoint ini dengan x-cron-secret
//
// Kolom per user: status akun, terakhir aktif, kunjungan (jumlah login),
// project aktif, situs terpublikasi, indikasi pelanggaran S&K/hukum, deteksi
// bot, dan CTA kelola akun (tangguhkan/aktifkan/hapus) menuju panel admin.
//
// Sengiku disimpan di env_vars D1: GITHUB_DATA_TOKEN (akses push repo Clincoo-Data).

import { getSecret, sendEmail, flatTemplate, formatIDR, notifyEvent } from './notify-helpers.js';
import { getUserById } from './user-scope.js';

const GH_REPO = 'muzawwied/Clincoo-Data';
const GH_PATH = 'users-live.md';
const GH_BRANCH = 'main';

// Panel admin tujuan CTA (anchor per-baris: #suspend-<id> / #unsuspend-<id> / #delete-<id>)
const ADMIN_USERS_URL = 'https://app.clincoo.buzz/akun/profile/admin/users/';

// Domain email sekali pakai untuk heuristik deteksi bot
const DISPOSABLE_DOMAINS = [
  'mailinator.com', 'tempmail.com', 'temp-mail.org', '10minutemail.com',
  'guerrillamail.com', 'yopmail.com', 'sharklasers.com', 'grr.la',
  'trashmail.com', 'throwawaymail.com', 'dispostable.com', 'maildrop.cc'
];

function b64utf8(s) {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return btoa(bin);
}

function rp(n) {
  const v = Number(n) || 0;
  return 'Rp' + v.toLocaleString('id-ID');
}

function esc(v) {
  return String(v == null || v === '' ? '(tanpa data)' : v).replace(/\|/g, '/');
}

function botVerdict(u, hasOauth, projCount, visitCount) {
  if (u.role === 'admin' || u.role === 'owner') return 'Tidak';
  if (hasOauth) return 'Tidak';
  const dom = String(u.email || '').split('@')[1] || '';
  if (DISPOSABLE_DOMAINS.includes(dom.toLowerCase())) return 'Curiga (email sekali pakai)';
  if (!u.password_hash && projCount === 0 && visitCount === 0) return 'Curiga (akun kosong)';
  return 'Tidak';
}

export async function syncUserReport(env, opts) {
  const db = env.DB;
  if (!db) return { ok: 0, error: 'D1 not bound' };
  const token = await getSecret(env, 'GITHUB_DATA_TOKEN');
  if (!token) return { ok: 0, error: 'GITHUB_DATA_TOKEN tidak tersedia di env_vars' };

  const timeoutMs = (opts && opts.timeoutMs) || 25000;
  const signal = AbortSignal.timeout(timeoutMs);

  const [
    usersR, oauthR, subsR, balR, sessR, actR, projR, repR, abuseR, dlTablesR, projOwnerR
  ] = await Promise.all([
    db.prepare('SELECT id, name, email, password_hash, created_at, role, status FROM auth_users ORDER BY id').all(),
    db.prepare('SELECT user_id, provider FROM auth_oauth_accounts').all(),
    db.prepare("SELECT key, value FROM subscription WHERE key LIKE '%:plan'").all(),
    db.prepare("SELECT key, value FROM wallet_balance WHERE key LIKE '%:balance'").all(),
    db.prepare('SELECT user_id, COUNT(*) c, MAX(created_at) t FROM auth_sessions GROUP BY user_id').all(),
    db.prepare('SELECT user_id, MAX(created_at) t FROM activity_log WHERE user_id IS NOT NULL GROUP BY user_id').all(),
    db.prepare('SELECT user_id, COUNT(*) c FROM user_projects GROUP BY user_id').all(),
    db.prepare('SELECT target_user_id, COUNT(*) c FROM admin_reports WHERE target_user_id IS NOT NULL GROUP BY target_user_id').all(),
    db.prepare("SELECT user_id, COUNT(*) c FROM activity_log WHERE user_id IS NOT NULL AND (action LIKE '%abuse%' OR details LIKE '%judi%' OR details LIKE '%phishing%' OR details LIKE '%malware%' OR details LIKE '%scam%' OR details LIKE '%spam%' OR details LIKE '%illegal%' OR details LIKE '%banned%') GROUP BY user_id").all(),
    db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'p|_proj%' ESCAPE '|' AND name LIKE '%deploy_logs'").all(),
    db.prepare('SELECT id, user_id FROM user_projects').all()
  ]);

  const users = usersR.results || [];
  const provMap = {};
  (oauthR.results || []).forEach(o => {
    const k = String(o.user_id);
    (provMap[k] = provMap[k] || []).push(o.provider);
  });
  const planMap = {};
  (subsR.results || []).forEach(s => {
    const m = /^u(\d+):plan$/.exec(s.key || '');
    if (m) planMap[m[1]] = s.value;
  });
  const balMap = {};
  (balR.results || []).forEach(b => {
    const m = /^u(\d+):balance$/.exec(b.key || '');
    if (m) balMap[m[1]] = Number(b.value) || 0;
  });
  const visitMap = {}; // user_id -> { c: jumlah login, t: login terakhir }
  (sessR.results || []).forEach(s => { visitMap[s.user_id] = { c: s.c || 0, t: s.t || null }; });
  const lastActMap = {};
  (actR.results || []).forEach(a => { lastActMap[a.user_id] = a.t; });
  const projCountMap = {};
  (projR.results || []).forEach(p => { projCountMap[p.user_id] = p.c || 0; });
  const reportMap = {};
  (repR.results || []).forEach(r => { reportMap[r.target_user_id] = r.c || 0; });
  const abuseMap = {};
  (abuseR.results || []).forEach(a => { abuseMap[a.user_id] = a.c || 0; });
  const ownerMap = {}; // project_id -> user_id
  (projOwnerR.results || []).forEach(p => { ownerMap[p.id] = p.user_id; });

  // Situs terpublikasi: status deploy TERAKHIR per project = 'success'
  const pubSiteMap = {}; // user_id -> jumlah situs live
  const dlTables = (dlTablesR.results || [])
    .map(r => r.name)
    .filter(n => /^p_proj\d+_deploy_logs$/.test(n));
  await Promise.all(dlTables.map(async tn => {
    try {
      const projId = tn.slice(2, -12); // buang prefix 'p_' dan suffix '_deploy_logs'
      // user_projects.id = 'proj_<ts>' (dengan underscore), nama tabel = 'p_proj<ts>_...' (tanpa)
      const owner = ownerMap[projId] || ownerMap['proj_' + projId.slice(4)] || ownerMap[projId.replace('proj', 'proj_')];
      if (!owner) return;
      const r = await db.prepare('SELECT status FROM ' + tn + ' ORDER BY id DESC LIMIT 1').first();
      if (r && r.status === 'success') {
        pubSiteMap[owner] = (pubSiteMap[owner] || 0) + 1;
      }
    } catch (e) { /* tabel project bisa jadi kosong / belum ada */ }
  }));

  // ---- susun laporan markdown ----
  let oauthCount = 0, paidCount = 0, totalBal = 0, suspCount = 0, totalPub = 0, botCount = 0, violCount = 0;
  const rows = users.map(u => {
    const id = String(u.id);
    const provs = provMap[id] || [];
    const login = provs.length ? provs.join(', ') : 'Email';
    if (provs.length) oauthCount++;
    const plan = planMap[id] || 'Gratis';
    if (planMap[id] && planMap[id] !== 'Gratis') paidCount++;
    const bal = balMap[id] || 0;
    totalBal += bal;
    const tgl = (u.created_at || '').slice(0, 10) || 'Tidak ada data';

    // status akun
    const status = u.status === 'active' ? 'Aktif'
      : u.status === 'suspended' ? 'Ditangguhkan'
      : u.status === 'deleted' ? 'Terhapus'
      : (u.status || 'Tidak diketahui');
    if (u.status === 'suspended') suspCount++;

    // terakhir aktif: max(aktivitas, login)
    const v = visitMap[id] || {};
    const la = [lastActMap[id], v.t].filter(Boolean).sort().pop();
    const lastActive = la ? String(la).slice(0, 10) : 'Belum pernah';

    const visits = v.c || 0;
    const projCount = projCountMap[id] || 0;
    const pubSites = pubSiteMap[u.id] || 0;
    if (pubSites) totalPub += pubSites;

    // pelanggaran S&K / hukum: laporan admin + indikasi otomatis dari activity log
    const viol = (reportMap[id] || 0) + (abuseMap[id] || 0);
    const violLabel = viol > 0 ? ('⚠️ ' + viol) : 'Bersih';
    if (viol > 0) violCount++;

    // heuristik deteksi bot
    const bot = botVerdict(u, provs.length > 0, projCount, visits);
    if (bot !== 'Tidak' && bot !== 'Tidak terdeteksi') botCount++;

    // CTA kelola akun (admin/owner tidak bisa di-suspend/hapus dari UI)
    const isAdminAcct = u.role === 'admin' || u.role === 'owner';
    let aksi = isAdminAcct ? ((u.role === 'owner' ? 'Owner' : 'Admin') + ' (dilindungi)') : '(terhapus)';
    if (!isAdminAcct && u.status !== 'deleted') {
      aksi = u.status === 'suspended'
        ? `[Aktifkan](${ADMIN_USERS_URL}#unsuspend-${u.id}) · [Hapus](${ADMIN_USERS_URL}#delete-${u.id})`
        : `[Tangguhkan](${ADMIN_USERS_URL}#suspend-${u.id}) · [Hapus](${ADMIN_USERS_URL}#delete-${u.id})`;
    }

    return `| ${u.id} | ${esc(u.name)} | ${esc(u.email)} | ${login} | ${plan} | ${rp(bal)} | ${status} | ${lastActive} | ${visits} | ${projCount} | ${pubSites} | ${violLabel} | ${bot} | ${aksi} | ${tgl} |`;
  });

  const now = new Date();
  const tglNow = now.toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', dateStyle: 'full', timeStyle: 'long' });
  let md = '# Data User Clincoo (Live)\n\n';
  md += `> Tersinkron otomatis dari database: langsung saat ada pendaftaran baru, plus tiap 15 menit (paket, saldo, dsb.).\n`;
  md += `> Terakhir diperbarui: ${tglNow}\n\n`;
  md += `**Total user: ${users.length}** | Login Google/GitHub: ${oauthCount} | Paket berbayar: ${paidCount} | Total saldo dompet: ${rp(totalBal)} | Ditangguhkan: ${suspCount} | Situs terpublikasi: ${totalPub} | Pelanggaran S&K: ${violCount} | Curiga bot: ${botCount}\n\n`;
  md += '| ID | Nama | Email | Login | Paket | Saldo | Status | Terakhir Aktif | Kunjungan | Project Aktif | Situs Publik | Pelanggaran | Bot | Aksi | Terdaftar |\n';
  md += '|----|------|-------|-------|-------|-------|-------|-------|-------|-------|-------|-------|-------|-------|-----------|\n';
  md += rows.join('\n') + '\n\n';
  md += '### Keterangan\n\n';
  md += '- **Status**: Aktif / Ditangguhkan / Terhapus (soft-delete) sesuai `auth_users.status`.\n';
  md += '- **Terakhir Aktif**: tanggal aktivitas atau login terakhir yang tercatat.\n';
  md += '- **Kunjungan**: jumlah login (sesi) yang pernah dibuat.\n';
  md += '- **Project Aktif**: jumlah proyek milik user di workspace.\n';
  md += '- **Situs Publik**: jumlah proyek dengan deploy terakhir sukses (masih live di Pages).\n';
  md += '- **Pelanggaran**: ⚠️ n = ada laporan admin / indikasi pelanggaran S&K & hukum (spam, phishing, judi, malware, dsb.). "Bersih" = tidak ada.\n';
  md += '- **Login**: metode daftar/masuk akun — Google/GitHub = OAuth; Email = email & sandi (bukan OAuth).\n';
  md += '- **Bot**: heuristik — akun tanpa OAuth dengan email sekali pakai / pola akun kosong ditandai "Curiga". "Tidak" = tidak terdeteksi bot.\n';
  md += `- **Aksi**: tautan langsung ke panel admin (\`akun/profile/admin/users\`) — Tangguhkan / Aktifkan / Hapus (butuh login admin). Admin/Owner dilindungi (tidak bisa di-suspend/hapus dari UI).\n`;

  // ---- push ke GitHub ----
  const ghHeaders = { 'Authorization': 'Bearer ' + token, 'User-Agent': 'clincoo-sync', 'Accept': 'application/vnd.github+json' };
  // CATATAN: JANGAN pakai '?ref=' di sini — runtime Cloudflare dapat 404 dari GitHub
  // padahal request sama dari luar 200 (diverifikasi 5 Okt 2026). Tanpa param, default branch.
  // GitHub kadang balas 404 flaky dari runtime Cloudflare (intermiten, diverifikasi
  // 5 Okt 2026: request identik bisa 200 lalu 404 menit berikutnya) — retry sampai 3x.
  let getRes = null;
  for (let i = 0; i < 3; i++) {
    getRes = await fetch('https://api.github.com/repos/' + GH_REPO + '/contents/' + GH_PATH, { headers: ghHeaders, signal });
    if (getRes.ok) break;
    if (getRes.status !== 404 || i === 2) break;
    await new Promise(r => setTimeout(r, 800));
  }
  let sha = null;
  if (getRes.ok) {
    const j = await getRes.json();
    sha = j.sha || null;
  }
  const putBody = {
    message: 'sync: data user live (' + now.toISOString() + ')',
    content: b64utf8(md),
    branch: GH_BRANCH
  };
  if (sha) putBody.sha = sha;
  let putRes = null;
  for (let i = 0; i < 3; i++) {
    putRes = await fetch('https://api.github.com/repos/' + GH_REPO + '/contents/' + GH_PATH, {
      method: 'PUT', headers: { ...ghHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify(putBody), signal
    });
    if (putRes.status !== 404 || i === 2) break;
    await new Promise(r => setTimeout(r, 800));
  }
  if (!putRes.ok) {
    const t = await putRes.text().catch(() => '');
    return { ok: 0, error: 'GitHub ' + putRes.status + ': ' + t.slice(0, 200) };
  }
  return { ok: 1, users: users.length, sha: sha ? 'updated' : 'created' };
}


// ===== Email pengingat order QRIS pending (sekali per order) =====
// Digerakkan cron user-sync (tiap 15 menit): order pending berusia 1-24 jam
// dikirim satu email pengingat + notifikasi in-app. Order lama (>24 jam)
// dianggap kedaluwarsa dan tidak diingatkan lagi.
async function paymentReminderSweep(env) {
  const db = env.DB;
  try { await db.prepare('ALTER TABLE topup_orders ADD COLUMN reminder_sent_at TEXT').run(); } catch (e) {}
  const old = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');
  const cutoff = new Date(Date.now() - 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');
  const rows = await db.prepare(
    "SELECT id, user_id, amount, bill_total FROM topup_orders WHERE status = 'pending' AND reminder_sent_at IS NULL AND created_at > ? AND created_at <= ? ORDER BY created_at ASC LIMIT 10"
  ).bind(old, cutoff).all();
  let sent = 0;
  for (const o of (rows && rows.results) || []) {
    const user = await getUserById(db, o.user_id);
    // tandai dulu supaya cron berikutnya tidak dobel kirim
    await db.prepare("UPDATE topup_orders SET reminder_sent_at = datetime('now') WHERE id = ?").bind(o.id).run();
    if (!user || !user.email) continue;
    // Nominal = tagihan asli dari penyedia QRIS (harga + biaya layanan), bukan harga paket saja
    const billAmt = parseFloat(o.bill_total) > 0 ? parseFloat(o.bill_total) : (parseFloat(o.amount) || 0);
    const amt = formatIDR(billAmt);
    try {
      await sendEmail(env, {
        toEmail: user.email, toName: user.name || '',
        subject: 'Pesanan pembayaran ' + amt + ' belum selesai',
        html: flatTemplate(
          'Selesaikan Pembayaran',
          user.name || '',
          '<p style="margin:0 0 20px;color:#374151;font-size:14px;line-height:1.7">Pesanan QRIS Anda sebesar <b>' + amt + '</b> belum kami terima. Kode QRIS kedaluwarsa beberapa menit setelah dibuat — jika ingin melanjutkan, cukup buat ulang transaksinya.</p>' +
          '<p style="margin:0 0 20px;color:#374151;font-size:14px;line-height:1.7">Jika Anda sudah membayar, abaikan email ini — saldo masuk otomatis begitu pembayaran terkonfirmasi.</p>',
          [['Nomor Pesanan', o.id], ['Jumlah', amt], ['Metode', 'QRIS'], ['Status', 'Menunggu pembayaran']],
          'Lanjutkan Pembayaran',
          'https://app.clincoo.buzz/akun/langganan/checkout/qris/' + encodeURIComponent(o.id) + '/',
          'Ini pesan pengingat otomatis dari Clincoo.'
        )
      });
      await notifyEvent(db, user, {
        source: 'Dompet', type: 'payment_reminder',
        message: 'Pesanan QRIS ' + amt + ' belum selesai. Buka halaman pembayaran untuk melanjutkan atau membuat ulang.',
        link: 'https://app.clincoo.buzz/akun/langganan/checkout/qris/' + encodeURIComponent(o.id) + '/'
      });
      sent++;
    } catch (e) {}
  }
  return sent;
}

export async function onRequestPost({ request, env }) {
  try {
    const secret = await getSecret(env, 'CRON_SECRET');
    if (!secret) return new Response(JSON.stringify({ error: 'cron not configured' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    const provided = request.headers.get('x-cron-secret') || '';
    if (provided !== secret) return new Response(JSON.stringify({ error: 'forbidden' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
    const r = await syncUserReport(env);
    let reminders = 0;
    try { reminders = await paymentReminderSweep(env); } catch (e) {}
    return new Response(JSON.stringify({ ...r, payment_reminders: reminders }), { status: r.ok ? 200 : 500, headers: { 'Content-Type': 'application/json' } });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
}
