// Cloudflare Pages Functions — Kolaborasi PER PROYEK (D1: project_members + collab_invites)
// GET  /api/collab?token=<token>  -> info undangan (publik, token adalah rahasia)
// POST /api/collab                -> { action: 'list'|'invite'|'accept'|'decline'|'remove'|'setRole'|'removeInvite', ... }
// Semua aksi (kecuali lihat info undangan) wajib Bearer token; penerima wajib login
// dengan email yang sama dengan yang diundang. Undangan kedaluwarsa 24 jam.
import { currentUser, getUserById } from './user-scope.js';
import { getEffectivePlan, countProjectMembers, countPendingInvites } from './plan-helpers.js';
import { emailTemplate, sendEmail, notifyEvent, getUserByEmail } from './notify-helpers.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

const FRONTEND_BASE = 'https://muzawwied.github.io/Clincoo./akun/';
const INVITE_MAX_AGE_HOURS = 24;

function j(data, status) {
  return new Response(JSON.stringify(data), { status: status || 200, headers: { 'Content-Type': 'application/json', ...CORS } });
}

export async function onRequestOptions() { return new Response(null, { headers: CORS }); }

async function ensureTables(db) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS user_projects (
    id TEXT PRIMARY KEY,
    user_id INTEGER,
    title TEXT DEFAULT '',
    prompt TEXT DEFAULT '',
    ai_name TEXT DEFAULT '',
    ai_desc TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT
  )`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS project_members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL,
    owner_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    email TEXT DEFAULT '',
    role TEXT DEFAULT 'Viewer',
    joined_at TEXT DEFAULT (datetime('now')),
    UNIQUE(project_id, user_id)
  )`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS collab_invites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token TEXT UNIQUE NOT NULL,
    project_id TEXT NOT NULL,
    owner_id INTEGER NOT NULL,
    inviter_name TEXT DEFAULT '',
    invitee_email TEXT DEFAULT '',
    role TEXT DEFAULT 'Viewer',
    channel TEXT DEFAULT 'email',
    status TEXT DEFAULT 'pending',
    created_at TEXT DEFAULT (datetime('now')),
    responded_at TEXT
  )`).run();
}

async function getProject(db, projectId) {
  if (!projectId) return null;
  try {
    return await db.prepare('SELECT * FROM user_projects WHERE id = ?').bind(String(projectId)).first();
  } catch (e) { return null; }
}

function initialsOf(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return parts.slice(0, 2).map(p => p[0].toUpperCase()).join('');
}

async function logActivity(db, userId, action, details) {
  try {
    await db.prepare('INSERT INTO activity_log (action, details, user_id) VALUES (?, ?, ?)')
      .bind(action, details, userId).run();
  } catch (e) {}
}

async function expireOldInvites(db) {
  // Tandai undangan lewat 24 jam sebagai expired (pembersihan pasif)
  try {
    await db.prepare("UPDATE collab_invites SET status = 'expired' WHERE status = 'pending' AND created_at < datetime('now', '-24 hours')").run();
  } catch (e) {}
}

function inviteUrl(token) {
  return FRONTEND_BASE + 'terima-undangan.html?invite=' + encodeURIComponent(token);
}

// GET: info undangan untuk halaman terima-undangan (tanpa login, token = rahasia)
export async function onRequestGet({ env, request }) {
  try {
    const db = env.DB;
    if (!db) return j({ error: 'D1 not bound' }, 500);
    await ensureTables(db);
    const token = new URL(request.url).searchParams.get('token') || '';
    if (!token) return j({ success: false }, 404);
    await expireOldInvites(db);
    const inv = await db.prepare('SELECT * FROM collab_invites WHERE token = ?').bind(token).first();
    if (!inv) return j({ success: false }, 404);
    const proj = await getProject(db, inv.project_id);
    return j({
      success: true,
      invite: {
        project: (proj && proj.title) || 'Proyek Clincoo',
        invited_by: inv.inviter_name || 'Pemilik proyek',
        role: inv.role,
        status: inv.status,
        email: inv.invitee_email || '',
        channel: inv.channel,
        created_date: inv.created_at
      }
    });
  } catch (err) {
    return j({ error: err.message }, 500);
  }
}

export async function onRequestPost({ env, request }) {
  try {
    const db = env.DB;
    if (!db) return j({ error: 'D1 not bound' }, 500);
    await ensureTables(db);
    await expireOldInvites(db);

    const user = await currentUser(env, request);
    if (!user) return j({ error: 'unauthorized', need_login: true }, 401);

    const body = await request.json().catch(() => ({}));
    const action = body.action || '';
    const projectId = body.project_id ? String(body.project_id) : '';

    /* ---------- list: anggota + undangan tertunda satu proyek ---------- */
    if (action === 'list') {
      const proj = await getProject(db, projectId);
      if (!proj) return j({ error: 'Proyek tidak ditemukan' }, 404);
      const isOwner = Number(proj.user_id) === Number(user.id);
      const memberRow = await db.prepare('SELECT id FROM project_members WHERE project_id = ? AND user_id = ?')
        .bind(projectId, user.id).first();
      if (!isOwner && !memberRow) return j({ error: 'Bukan proyek Anda' }, 403);

      const owner = await getUserById(db, proj.user_id);
      const rows = await db.prepare('SELECT * FROM project_members WHERE project_id = ? ORDER BY joined_at ASC')
        .bind(projectId).all();
      const pending = await db.prepare("SELECT id, invitee_email, role, channel, created_at FROM collab_invites WHERE project_id = ? AND status = 'pending' ORDER BY created_at DESC").bind(projectId).all();

      const members = [];
      for (const r of (rows.results || [])) {
        const u = await getUserById(db, r.user_id);
        members.push({
          id: String(r.id),
          user_id: r.user_id,
          name: (u && u.name) || r.email || 'Anggota',
          email: r.email || (u && u.email) || '',
          role: r.role,
          initials: initialsOf((u && u.name) || r.email)
        });
      }
      const ownerCard = owner ? {
        id: 'owner_' + proj.user_id,
        user_id: proj.user_id,
        name: owner.name || 'Pemilik proyek',
        email: owner.email || '',
        role: 'Owner',
        initials: initialsOf(owner.name)
      } : null;

      return j({
        success: true,
        project: { id: proj.id, title: proj.title || 'Proyek Clincoo' },
        members: ownerCard ? [ownerCard, ...members] : members,
        pending: (pending.results || []).map(p => ({
          invite_id: p.id,
          email: p.invitee_email,
          role: p.role,
          channel: p.channel,
          created_date: p.created_at
        }))
      });
    }

    /* ---------- invite: buat undangan (email / tautan / WA / TG) ---------- */
    if (action === 'list_all') {
      // SEMUA proyek milik user — anggota + undangan dalam SATU respons (batch, cepat)
      const projs = await db.prepare('SELECT id, title FROM user_projects WHERE user_id = ? ORDER BY COALESCE(updated_at, created_at) DESC').bind(user.id).all();
      const projList = projs.results || [];

      const membersAll = await db.prepare(
        "SELECT pm.* FROM project_members pm WHERE pm.project_id IN (SELECT id FROM user_projects WHERE user_id = ?) ORDER BY pm.joined_at ASC"
      ).bind(user.id).all();
      const pendingAll = await db.prepare(
        "SELECT ci.id, ci.project_id, ci.invitee_email, ci.role, ci.channel, ci.created_at FROM collab_invites ci WHERE ci.status = 'pending' AND ci.project_id IN (SELECT id FROM user_projects WHERE user_id = ?) ORDER BY ci.created_at DESC"
      ).bind(user.id).all();

      // Profil anggota diambil SEKALI (bukan satu query per anggota)
      const uidSet = new Set((membersAll.results || []).map(r => r.user_id));
      const profileMap = {};
      if (uidSet.size) {
        const ids = Array.from(uidSet);
        const ph = ids.map(() => '?').join(',');
        const us = await db.prepare('SELECT id, name, email FROM auth_users WHERE id IN (' + ph + ')').bind(...ids).all();
        for (const u of (us.results || [])) profileMap[u.id] = u;
      }

      const byProj = {};
      for (const p of projList) byProj[p.id] = { id: p.id, title: p.title || 'Proyek Clincoo', members: [], pending: [] };
      for (const r of (membersAll.results || [])) {
        if (!byProj[r.project_id]) continue;
        const u = profileMap[r.user_id];
        byProj[r.project_id].members.push({
          id: String(r.id),
          user_id: r.user_id,
          name: (u && u.name) || r.email || 'Anggota',
          email: r.email || (u && u.email) || '',
          role: r.role,
          initials: initialsOf((u && u.name) || r.email)
        });
      }
      for (const p of (pendingAll.results || [])) {
        if (!byProj[p.project_id]) continue;
        byProj[p.project_id].pending.push({
          invite_id: p.id,
          email: p.invitee_email,
          role: p.role,
          channel: p.channel,
          created_date: p.created_at
        });
      }
      const me = await getUserById(db, user.id);
      const ownerCard = {
        id: 'owner_' + user.id,
        user_id: user.id,
        name: (me && me.name) || 'Pemilik proyek',
        email: (me && me.email) || '',
        role: 'Owner',
        initials: initialsOf((me && me.name) || (me && me.email))
      };
      const projects = projList.map(p => ({
        id: byProj[p.id].id,
        title: byProj[p.id].title,
        members: [ownerCard].concat(byProj[p.id].members),
        pending: byProj[p.id].pending
      }));
      return j({ success: true, projects: projects });
    }

    if (action === 'invite') {
      const proj = await getProject(db, projectId);
      if (!proj) return j({ error: 'Proyek tidak ditemukan' }, 404);
      if (Number(proj.user_id) !== Number(user.id)) return j({ error: 'Hanya pemilik proyek yang dapat mengundang' }, 403);

      // Penegakan batas paket: jumlah kolaborator per proyek
      const planInfo = await getEffectivePlan(db, user);
      const memberCount = await countProjectMembers(db, projectId);
      const pendingCount = await countPendingInvites(db, projectId);
      if (memberCount + pendingCount >= planInfo.limits.collaboratorLimit) {
        return j({ success: false, error: 'Batas kolaborator paket ' + planInfo.plan + ' tercapai (' + planInfo.limits.collaboratorLimit + ' anggota per proyek). Upgrade paket di halaman Langganan untuk mengundang lebih banyak.', plan: planInfo.plan, limit: planInfo.limits.collaboratorLimit, current: memberCount, pending: pendingCount, upgrade_needed: true }, 402);
      }

      const role = ['Editor', 'Viewer'].indexOf(body.role) !== -1 ? body.role : 'Viewer';
      const channel = ['email', 'link', 'whatsapp', 'telegram'].indexOf(body.channel) !== -1 ? body.channel : 'email';
      const email = String(body.email || '').trim().toLowerCase();
      if (channel === 'email' && (!email || email.indexOf('@') < 1)) {
        return j({ error: 'Email tidak valid' }, 400);
      }

      const owner = await getUserById(db, proj.user_id);
      const inviterName = (owner && owner.name) || 'Pemilik proyek';

      // Validasi duplikat: pemilik, anggota, undangan aktif
      if (email && owner && String(owner.email || '').toLowerCase() === email) {
        return j({ error: 'Anda pemilik proyek ini.' }, 400);
      }
      if (email) {
        const dupMember = await db.prepare('SELECT id FROM project_members WHERE project_id = ? AND lower(email) = ?')
          .bind(projectId, email).first();
        if (dupMember) return j({ error: 'Email ini sudah terdaftar sebagai anggota proyek.' }, 400);
        const dupInvite = await db.prepare("SELECT id FROM collab_invites WHERE project_id = ? AND lower(invitee_email) = ? AND status = 'pending'")
          .bind(projectId, email).first();
        if (dupInvite) return j({ error: 'Email ini sudah diundang sebelumnya dan masih menunggu diterima.' }, 400);
      }

      const token = crypto.randomUUID();
      await db.prepare('INSERT INTO collab_invites (token, project_id, owner_id, inviter_name, invitee_email, role, channel) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(token, projectId, proj.user_id, inviterName, email, role, channel).run();

      const url = inviteUrl(token);
      const projTitle = proj.title || 'Proyek Clincoo';

      let emailSent = false;
      let emailReason = channel === 'email' ? 'skipped' : null;
      if (channel === 'email') {
        const inviteeUser = await getUserByEmail(db, email);
        const berlakuHingga = new Date(Date.now() + INVITE_MAX_AGE_HOURS * 3600000)
          .toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' }) + ' WIB';
        const html = emailTemplate(
          'Undangan Kolaborasi Proyek',
          inviteeUser ? inviteeUser.name : '',
          inviterName + ' mengundang Anda untuk berkolaborasi di proyek <b>&quot;' + projTitle + '&quot;</b> dengan peran <b>' + role + '</b>. Klik tombol di bawah untuk melihat undangan — berlaku ' + INVITE_MAX_AGE_HOURS + ' jam.',
          [
            ['Proyek', projTitle],
            ['Peran', role],
            ['Diundang oleh', inviterName],
            ['Berlaku hingga', berlakuHingga]
          ],
          'Lihat Undangan',
          url,
          'Jika Anda tidak merasa diundang, abaikan email ini.'
        );
        const res = await sendEmail(env, {
          toEmail: email,
          toName: inviteeUser ? inviteeUser.name : '',
          subject: 'Undangan Kolaborasi Proyek "' + projTitle + '" — Clincoo',
          html: html
        });
        emailSent = !!res.sent;
        emailReason = res.reason || null;
        // Notifikasi in-app bila penerima sudah punya akun
        if (inviteeUser) {
          await notifyEvent(db, inviteeUser, {
            source: 'Kolaborasi',
            type: 'invite',
            message: inviterName + ' mengundang Anda berkolaborasi di proyek "' + projTitle + '" sebagai ' + role + '.',
            link: url
          });
        }
      }
      await logActivity(db, user.id, 'collab_invite', 'Mengundang ' + (email || ('tautan (' + channel + ')')) + ' ke proyek "' + projTitle + '"');

      return j({ success: true, invite_url: url, email_sent: emailSent, reason: emailReason });
    }

    /* ---------- accept / decline: wajib login, email harus cocok ---------- */
    if (action === 'accept' || action === 'decline') {
      const token = String(body.token || '');
      const inv = await db.prepare('SELECT * FROM collab_invites WHERE token = ?').bind(token).first();
      if (!inv) return j({ error: 'Undangan tidak ditemukan' }, 404);
      if (inv.status !== 'pending') return j({ error: 'Undangan sudah ' + inv.status }, 400);

      const myEmail = String(user.email || '').toLowerCase();
      if (!inv.invitee_email) {
        // Undangan tautan (tanpa email target): bisa diterima siapa saja yang login,
        // kecuali pemilik proyek atau yang sudah jadi anggota. Email penerima dicatat.
        if (inv.owner_id === user.id) return j({ error: 'Anda pemilik proyek ini.' }, 400);
        const alreadyMember = await db.prepare('SELECT id FROM project_members WHERE project_id = ? AND user_id = ?').bind(inv.project_id, user.id).first();
        if (alreadyMember) return j({ error: 'Anda sudah menjadi anggota proyek ini.' }, 400);
        if (action === 'decline') {
          // Menolak undangan tautan akan mematikan tautan bersama — tidak diperbolehkan, cukup abaikan.
          return j({ error: 'link_invite', message: 'Undangan tautan tidak perlu ditolak — abaikan saja tautannya.' }, 400);
        }
        await db.prepare("UPDATE collab_invites SET invitee_email = ?, responded_at = datetime('now') WHERE id = ?").bind(myEmail, inv.id).run();
      } else if (String(inv.invitee_email).toLowerCase() !== myEmail) {
        return j({ error: 'email_mismatch', message: 'Undangan ini ditujukan untuk alamat email lain.' }, 403);
      }

      if (action === 'accept') {
        const proj = await getProject(db, inv.project_id);
        const projTitle = (proj && proj.title) || 'Proyek Clincoo';
        // Penegakan batas paket pemilik proyek saat penerimaan undangan
        const projOwner = await getUserById(db, inv.owner_id);
        if (projOwner) {
          const ownerPlan = await getEffectivePlan(db, projOwner);
          const memberCount = await countProjectMembers(db, inv.project_id);
          if (memberCount >= ownerPlan.limits.collaboratorLimit) {
            return j({ success: false, error: 'Batas kolaborator paket pemilik proyek sudah tercapai (' + ownerPlan.limits.collaboratorLimit + ' anggota). Pemilik perlu upgrade paket untuk menambah anggota.', upgrade_needed: true }, 402);
          }
        }
        await db.prepare('INSERT INTO project_members (project_id, owner_id, user_id, email, role) VALUES (?, ?, ?, ?, ?) ON CONFLICT(project_id, user_id) DO UPDATE SET role = excluded.role')
          .bind(inv.project_id, inv.owner_id, user.id, myEmail, inv.role).run();
        await db.prepare("UPDATE collab_invites SET status = 'accepted', responded_at = datetime('now') WHERE id = ?")
          .bind(inv.id).run();

        // Notifikasi ke pemilik proyek + catatan aktivitas kedua pihak
        const owner = await getUserById(db, inv.owner_id);
        if (owner) {
          await notifyEvent(db, owner, {
            source: 'Kolaborasi',
            type: 'success',
            message: (user.name || myEmail) + ' menerima undangan dan bergabung di proyek "' + projTitle + '" sebagai ' + inv.role + '.',
            link: FRONTEND_BASE + 'kolaborasi.html?project=' + encodeURIComponent(inv.project_id)
          });
          await logActivity(db, owner.id, 'collab_accept', (user.name || myEmail) + ' bergabung di proyek "' + projTitle + '"');
        }
        await logActivity(db, user.id, 'collab_accept', 'Menerima undangan & bergabung di proyek "' + projTitle + '"');
        return j({ success: true, project: { id: inv.project_id, title: projTitle } });
      }

      // decline
      await db.prepare("UPDATE collab_invites SET status = 'declined', responded_at = datetime('now') WHERE id = ?")
        .bind(inv.id).run();
      await logActivity(db, user.id, 'collab_decline', 'Menolak undangan proyek');
      return j({ success: true });
    }

    /* ---------- remove: hapus anggota (pemilik saja) ---------- */
    if (action === 'remove') {
      const memberRow = await db.prepare('SELECT * FROM project_members WHERE id = ?').bind(Number(body.member_id)).first();
      if (!memberRow) return j({ error: 'Anggota tidak ditemukan' }, 404);
      if (Number(memberRow.owner_id) !== Number(user.id)) return j({ error: 'Hanya pemilik proyek yang dapat menghapus anggota' }, 403);
      await db.prepare('DELETE FROM project_members WHERE id = ?').bind(memberRow.id).run();
      const proj = await getProject(db, memberRow.project_id);
      const projTitle = (proj && proj.title) || 'Proyek Clincoo';
      const member = await getUserById(db, memberRow.user_id);
      if (member) {
        await notifyEvent(db, member, {
          source: 'Kolaborasi',
          type: 'info',
          message: 'Akses Anda ke proyek "' + projTitle + '" telah dihapus oleh pemilik proyek.',
          link: FRONTEND_BASE + 'proyek.html'
        });
      }
      await logActivity(db, user.id, 'collab_remove', 'Menghapus anggota dari proyek "' + projTitle + '"');
      return j({ success: true });
    }

    /* ---------- setRole: ubah peran anggota (pemilik saja) ---------- */
    if (action === 'setRole') {
      const role = ['Editor', 'Viewer'].indexOf(body.role) !== -1 ? body.role : null;
      if (!role) return j({ error: 'Peran tidak valid' }, 400);
      const memberRow = await db.prepare('SELECT * FROM project_members WHERE id = ?').bind(Number(body.member_id)).first();
      if (!memberRow) return j({ error: 'Anggota tidak ditemukan' }, 404);
      if (Number(memberRow.owner_id) !== Number(user.id)) return j({ error: 'Hanya pemilik proyek yang dapat mengubah peran' }, 403);
      await db.prepare('UPDATE project_members SET role = ? WHERE id = ?').bind(role, memberRow.id).run();
      const proj = await getProject(db, memberRow.project_id);
      const projTitle = (proj && proj.title) || 'Proyek Clincoo';
      const member = await getUserById(db, memberRow.user_id);
      if (member) {
        await notifyEvent(db, member, {
          source: 'Kolaborasi',
          type: 'info',
          message: 'Peran Anda di proyek "' + projTitle + '" diubah menjadi ' + role + '.',
          link: FRONTEND_BASE + 'kolaborasi.html?project=' + encodeURIComponent(memberRow.project_id)
        });
      }
      await logActivity(db, user.id, 'collab_setrole', 'Mengubah peran anggota di proyek "' + projTitle + '" menjadi ' + role);
      return j({ success: true });
    }

    /* ---------- removeInvite: batalkan undangan tertunda (pemilik saja) ---------- */
    if (action === 'removeInvite') {
      const inv = await db.prepare('SELECT * FROM collab_invites WHERE id = ?').bind(Number(body.invite_id)).first();
      if (!inv) return j({ error: 'Undangan tidak ditemukan' }, 404);
      if (Number(inv.owner_id) !== Number(user.id)) return j({ error: 'Hanya pemilik proyek yang dapat membatalkan undangan' }, 403);
      await db.prepare("UPDATE collab_invites SET status = 'cancelled', responded_at = datetime('now') WHERE id = ?")
        .bind(inv.id).run();
      return j({ success: true });
    }

    return j({ error: 'action tidak dikenal' }, 400);
  } catch (err) {
    return j({ error: err.message }, 500);
  }
}
