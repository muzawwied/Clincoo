// Cloudflare Pages Functions — Klaim Beta Pro Gratis 30 Hari (kuota 25 akun)
// Alur: user isi email di /klaim-pro/ -> server kirim link klaim ke email
// (membuktikan email NYATA — link hanya sampai ke inbox asli) -> user buka
// link -> Pro 30 hari diaktifkan. Maksimal 25 klaim, 1 email = 1 klaim.
// Paket diterapkan langsung bila akun dengan email itu sudah ada; bila belum,
// klaim dicatat dan otomatis diterapkan saat user pertama login (hook di me.js).
import { currentUser } from './user-scope.js';
import { emailTemplate, sendEmail, notifyEvent } from './notify-helpers.js';
import { ADMIN_EMAILS } from './plan-helpers.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

const BETA_QUOTA = 25;          // maksimal klaim (sesuai keputusan owner)
const TRIAL_DAYS = 30;

function j(data, status) {
  return new Response(JSON.stringify(data), { status: status || 200, headers: { 'Content-Type': 'application/json', ...CORS } });
}

async function ensureTable(db) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS beta_claims (
    email TEXT PRIMARY KEY,
    token TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL,
    claimed_at TEXT
  )`).run();
}

function validEmail(e) {
  return typeof e === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e.trim());
}

function makeToken() {
  const b = crypto.getRandomValues(new Uint8Array(24));
  return Array.from(b).map(x => x.toString(16).padStart(2, '0')).join('');
}

async function claimedCount(db) {
  const row = await db.prepare(`SELECT COUNT(*) AS c FROM beta_claims WHERE status IN ('claimed_unapplied','applied')`).first();
  return (row && row.c) || 0;
}

// Terapkan Pro trial ke akun (per-email). Batal bila user sudah punya paket
// berbayar aktif yang berakhir lebih lambat — tidak boleh memperpendek masa aktif.
export async function applyProTrial(db, email) {
  try {
    const user = await db.prepare('SELECT * FROM auth_users WHERE lower(email) = ?').bind(String(email).trim().toLowerCase()).first();
    if (!user) return { applied: false, reason: 'no_account' };
    const pfx = 'u' + user.id + ':';
    const rows = await db.prepare('SELECT key, value FROM subscription WHERE key IN (?, ?, ?)')
      .bind(pfx + 'plan', pfx + 'start_date', pfx + 'billing_cycle').all();
    const m = {};
    for (const r of rows.results || []) m[r.key.slice(pfx.length)] = r.value;
    const cur = m.plan || 'Starter';
    if (cur === 'Pro' || cur === 'Bisnis') {
      const days = (m.billing_cycle === 'Tahunan') ? 365 : 30;
      const start = m.start_date ? new Date(String(m.start_date).replace(' ', 'T')) : null;
      if (start && !isNaN(start.getTime())) {
        const expiry = new Date(start.getTime() + days * 86400000);
        if (expiry > new Date()) return { applied: true, reason: 'already_paid' };
      }
    }
    await db.prepare("INSERT INTO subscription (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(pfx + 'plan', 'Pro').run();
    await db.prepare("INSERT INTO subscription (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(pfx + 'start_date', new Date().toISOString()).run();
    await db.prepare("INSERT INTO subscription (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(pfx + 'billing_cycle', 'Bulanan').run();
    return { applied: true, reason: 'granted' };
  } catch (e) {
    return { applied: false, reason: String(e && e.message || e) };
  }
}

// Hook login (dipanggil dari auth/me.js): klaim 'claimed_unapplied' milik email
// yang baru saja login -> terapkan sekarang.
export async function applyPendingClaim(db, email) {
  if (!db || !email) return;
  try {
    await ensureTable(db);
    const row = await db.prepare(`SELECT * FROM beta_claims WHERE lower(email) = ? AND status = 'claimed_unapplied'`)
      .bind(String(email).trim().toLowerCase()).first();
    if (!row) return;
    const res = await applyProTrial(db, row.email);
    await db.prepare(`UPDATE beta_claims SET status = 'applied' WHERE email = ? AND status = 'claimed_unapplied'`)
      .bind(row.email).run();
    if (res.applied && res.reason === 'granted') {
      try {
        const user = await db.prepare('SELECT * FROM auth_users WHERE lower(email) = ?').bind(String(row.email).trim().toLowerCase()).first();
        if (user) await notifyEvent(db, user, {
          source: 'Clincoo',
          type: 'success',
          message: 'Paket Pro beta 30 hari kamu sudah AKTIF. Selamat mencoba semua fitur Pro!'
        });
      } catch (eN) {}
    }
  } catch (e) {}
}

export async function onRequestOptions() { return new Response(null, { status: 204, headers: CORS }); }

export async function onRequestPost({ request, env }) {
  const db = env.DB;
  if (!db) return j({ success: false, error: 'D1 not bound' }, 500);
  let body = {};
  try { body = await request.json(); } catch (e) {}
  try {
  const action = body.action || '';

  // === 1. Minta link klaim (publik) ===
  if (action === 'request') {
    const email = String(body.email || '').trim().toLowerCase();
    if (!validEmail(email)) return j({ success: false, error: 'Format email tidak valid.' }, 400);
    await ensureTable(db);

    const existing = await db.prepare('SELECT * FROM beta_claims WHERE email = ?').bind(email).first();
    if (existing && (existing.status === 'claimed_unapplied' || existing.status === 'applied')) {
      return j({ success: false, error: 'Email ini sudah pernah klaim. Satu email hanya boleh klaim satu kali.' }, 409);
    }
    const token = existing ? existing.token : makeToken();
    if (existing) {
      await db.prepare('UPDATE beta_claims SET token = ?, created_at = ? WHERE email = ?').bind(token, new Date().toISOString(), email).run();
    } else {
      await db.prepare('INSERT INTO beta_claims (email, token, status, created_at) VALUES (?, ?, ?, ?)')
        .bind(email, token, 'pending', new Date().toISOString()).run();
    }

    const link = 'https://app.clincoo.buzz/klaim-pro/?token=' + token;
    const html = emailTemplate(
      'Klaim Pro Clincoo Gratis 30 Hari',
      null,
      'Kamu terpilih sebagai <b>beta tester Clincoo</b> dan mendapat akses paket <b>Pro gratis selama 30 hari</b> — AI chat penuh, editor kode + publish, domain kustom, dan kuota deploy 25x per bulan.',
      [['Kuota', '25 orang (klik sekarang, jangan sampai kehabisan)'], ['Masa aktif', TRIAL_DAYS + ' hari sejak diaktifkan'], ['Syarat', '1 email = 1 klaim, tidak bisa dipindahtangankan']],
      'Aktifkan Pro 30 Hari',
      link,
      'Tombol di atas khusus untuk email ini. Kalau kamu belum punya akun Clincoo, daftar dulu memakai email yang sama — Pro akan otomatis aktif saat login pertama.'
    );
    const res = await sendEmail(env, { toEmail: email, subject: 'Klaim Pro Clincoo Gratis 30 Hari — untuk ' + email, html });
    if (!res.sent) return j({ success: false, error: 'Gagal mengirim email: ' + (res.reason || 'coba lagi nanti.') }, 500);
    return j({ success: true, message: 'Link klaim sudah dikirim ke ' + email + '. Cek inbox (dan folder spam).' });
  }

  // === 2. Aktifkan klaim dari token (publik, dikirim ke email asli) ===
  if (action === 'claim') {
    const token = String(body.token || '').trim();
    if (!token || token.length < 16) return j({ success: false, error: 'Token klaim tidak valid.' }, 400);
    await ensureTable(db);
    const row = await db.prepare('SELECT * FROM beta_claims WHERE token = ?').bind(token).first();
    if (!row) return j({ success: false, error: 'Token klaim tidak dikenal. Minta link baru dari halaman klaim.' }, 404);
    if (row.status === 'claimed_unapplied' || row.status === 'applied') {
      return j({ success: true, already: true, message: 'Klaim ini sudah pernah diaktifkan.' });
    }

    // cek kuota lalu tandai klaim (race-safe: hitung ulang setelah update)
    if (await claimedCount(db) >= BETA_QUOTA) {
      return j({ success: false, quotaFull: true, error: 'Maaf, kuota 25 beta tester sudah penuh.' }, 409);
    }
    await db.prepare(`UPDATE beta_claims SET status = 'claimed_unapplied', claimed_at = ? WHERE email = ? AND status = 'pending'`)
      .bind(new Date().toISOString(), row.email).run();
    if (await claimedCount(db) > BETA_QUOTA) {
      // kalah race dengan orang lain -> batalkan, slot penuh
      await db.prepare(`UPDATE beta_claims SET status = 'pending', claimed_at = NULL WHERE email = ? AND status = 'claimed_unapplied'`)
        .bind(row.email).run();
      return j({ success: false, quotaFull: true, error: 'Maaf, kuota 25 beta tester sudah penuh.' }, 409);
    }

    const res = await applyProTrial(db, row.email);
    if (res.applied && res.reason === 'granted') {
      await db.prepare(`UPDATE beta_claims SET status = 'applied' WHERE email = ?`).bind(row.email).run();
      return j({ success: true, message: 'Pro 30 hari AKTIF untuk ' + row.email + '! Login ke Clincoo dan nikmati semua fitur Pro.' });
    }
    if (res.applied && res.reason === 'already_paid') {
      await db.prepare(`UPDATE beta_claims SET status = 'applied' WHERE email = ?`).bind(row.email).run();
      return j({ success: true, message: 'Akun ' + row.email + ' sudah memiliki paket berbayar aktif. Terima kasih sudah ikut beta!' });
    }
    return j({ success: true, needsAccount: true, message: 'Klaim tercatat! Kamu belum punya akun Clincoo — daftar memakai email ' + row.email + ', dan Pro 30 hari otomatis aktif saat login pertama.' });
  }

  // === 2b. Cek kelayakan beta untuk halaman checkout ===
  if (action === 'eligibility') {
    const user = await currentUser(env, request);
    if (!user || !user.email) return j({ success: false, loggedIn: false });
    await ensureTable(db);
    const email = String(user.email).trim().toLowerCase();
    const existing = await db.prepare('SELECT * FROM beta_claims WHERE email = ?').bind(email).first();
    const alreadyClaimed = !!(existing && (existing.status === 'claimed_unapplied' || existing.status === 'applied'));
    const count = await claimedCount(db);
    return j({ success: true, loggedIn: true, eligible: !alreadyClaimed && count < BETA_QUOTA, alreadyClaimed, quotaFull: count >= BETA_QUOTA, quotaLeft: Math.max(0, BETA_QUOTA - count) });
  }

  // === 3. Aktivasi langsung dari checkout Rp 0 (WAJIB login) ===
  if (action === 'activate') {
    const user = await currentUser(env, request);
    if (!user || !user.email) return j({ success: false, needLogin: true, error: 'Login dulu untuk mengaktifkan paket.' }, 401);
    await ensureTable(db);
    const email = String(user.email).trim().toLowerCase();

    const existing = await db.prepare('SELECT * FROM beta_claims WHERE email = ?').bind(email).first();
    if (existing && (existing.status === 'claimed_unapplied' || existing.status === 'applied')) {
      return j({ success: true, already: true, message: 'Email ini sudah pernah klaim Pro beta. Satu email satu kali.' });
    }
    if (await claimedCount(db) >= BETA_QUOTA) {
      return j({ success: false, quotaFull: true, error: 'Maaf, kuota 25 beta tester sudah penuh.' }, 409);
    }

    const res = await applyProTrial(db, email);
    if (!res.applied) return j({ success: false, error: 'Gagal mengaktifkan: ' + (res.reason || 'coba lagi.'), detail: res.reason }, 500);
    if (res.reason === 'already_paid') {
      if (existing) {
        await db.prepare(`UPDATE beta_claims SET status = 'applied', claimed_at = ? WHERE email = ? AND status = 'pending'`)
          .bind(new Date().toISOString(), email).run();
      } else {
        await db.prepare(`INSERT INTO beta_claims (email, token, status, created_at, claimed_at) VALUES (?, ?, 'applied', ?, ?)`)
          .bind(email, makeToken(), new Date().toISOString(), new Date().toISOString()).run();
      }
      return j({ success: true, already: true, message: 'Akun kamu sudah memiliki paket berbayar aktif. Terima kasih sudah ikut program beta!' });
    }

    // catat klaim (race-safe: hitung ulang setelah catat)
    if (existing) {
      await db.prepare(`UPDATE beta_claims SET status = 'applied', claimed_at = ? WHERE email = ? AND status = 'pending'`)
        .bind(new Date().toISOString(), email).run();
    } else {
      await db.prepare(`INSERT INTO beta_claims (email, token, status, created_at, claimed_at) VALUES (?, ?, 'applied', ?, ?)`)
        .bind(email, makeToken(), new Date().toISOString(), new Date().toISOString()).run();
    }
    if (await claimedCount(db) > BETA_QUOTA) {
      // kalah race -> akun ini yang paling terakhir, tarik kembali
      await db.prepare(`DELETE FROM beta_claims WHERE email = ? AND claimed_at = ?`).bind(email, new Date().toISOString()).run();
      // turunkan kembali paket (beta saja, aman: baru saja diaktifkan)
      const pfx = 'u' + user.id + ':';
      await db.prepare(`DELETE FROM subscription WHERE key IN (?, ?, ?)`).bind(pfx + 'plan', pfx + 'start_date', pfx + 'billing_cycle').run();
      return j({ success: false, quotaFull: true, error: 'Maaf, kuota 25 beta tester sudah penuh.' }, 409);
    }
    return j({ success: true, message: 'Pro 30 hari AKTIF untuk ' + email + '! Selamat mencoba semua fitur Pro Clincoo.' });
  }

  // === 4. Status token (untuk halaman) ===
  if (action === 'status') {
    const token = String(body.token || '').trim();
    if (!token) return j({ success: false, error: 'no_token' }, 400);
    await ensureTable(db);
    const row = await db.prepare('SELECT email, status FROM beta_claims WHERE token = ?').bind(token).first();
    if (!row) return j({ success: false, error: 'not_found' }, 404);
    return j({ success: true, email: row.email, status: row.status, quotaLeft: Math.max(0, BETA_QUOTA - await claimedCount(db)) });
  }

  // === 5. Daftar klaim (admin/owner saja) ===
  if (action === 'list') {
    const user = await currentUser(env, request);
    const isAdmin = user && (user.role === 'admin' || user.role === 'owner' || (user.email && ADMIN_EMAILS.has(user.email.toLowerCase())));
    if (!isAdmin) return j({ success: false, error: 'Hanya admin.' }, 403);
    await ensureTable(db);
    const rows = await db.prepare('SELECT email, status, created_at, claimed_at FROM beta_claims ORDER BY created_at DESC').all();
    return j({ success: true, quota: BETA_QUOTA, claimed: await claimedCount(db), claims: rows.results || [] });
  }

  return j({ success: false, error: 'Aksi tidak dikenal.' }, 400);
  } catch (e) {
    return j({ success: false, error: 'err: ' + String(e && e.message || e) }, 500);
  }
}
