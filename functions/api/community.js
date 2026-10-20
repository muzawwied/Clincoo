// Cloudflare Pages Functions — Komunitas Clincoo (feed sosial)
// Endpoint (wajib login — dijaga _middleware.js /api/*):
//   GET  /api/community            -> feed postingan (limit 30)
//   POST /api/community           -> buat postingan  { text }
//   POST /api/community/react      -> like/unlike    { post_id }
//   POST /api/community/comment    -> komentar       { post_id, text }
// Tabel global (shared antar user): community_posts, community_likes, community_comments.

import { currentUser } from './user-scope.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

const MAX_POST = 500;
const MAX_COMMENT = 300;

async function ensureTables(db) {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS community_posts (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, author_name TEXT NOT NULL,
      text TEXT NOT NULL, created_at TEXT NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS community_likes (
      post_id TEXT NOT NULL, user_id TEXT NOT NULL, created_at TEXT NOT NULL,
      PRIMARY KEY (post_id, user_id)
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS community_comments (
      id TEXT PRIMARY KEY, post_id TEXT NOT NULL, user_id TEXT NOT NULL,
      author_name TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL
    )`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_community_posts_time ON community_posts(created_at DESC)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_community_comments_post ON community_comments(post_id, created_at)`)
  ]);
  // Migrasi ringan: kolom foto (data-URL terkompresi klien, maks ~90KB)
  try { await db.prepare(`ALTER TABLE community_posts ADD COLUMN image TEXT`).run(); } catch (e) { /* kolom sudah ada */ }
}

function j(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', ...CORS }
  });
}

// Nama tampilan: prioritas nama profil yang diedit user di halaman akun Clincoo
// (account_profile, key 'u<id>:name'), fallback ke nama pendaftaran / awalan email.
async function authorLabel(db, user) {
  try {
    const row = await db.prepare('SELECT value FROM account_profile WHERE key = ?').bind('u' + user.id + ':name').first();
    if (row && row.value && String(row.value).trim()) return String(row.value).trim().slice(0, 40);
  } catch (e) { /* tabel/kolom belum ada -> fallback */ }
  return (user.name || (user.email || 'pengguna').split('@')[0]).slice(0, 40);
}

function nowIso() { return new Date().toISOString(); }

function randId() {
  return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

export async function onRequestOptions() {
  return new Response(null, { headers: CORS });
}

export async function onRequestGet({ env, request }) {
  try {
    const user = await currentUser(env, request);
    if (!user) return j({ error: 'Login diperlukan', need_login: true }, 401);
    await ensureTables(env.DB);

    const url = new URL(request.url);
    const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '30', 10) || 30, 1), 50);

    const posts = await env.DB.prepare(
      `SELECT p.id, p.user_id, p.author_name, p.text, p.created_at, p.image,
              (SELECT COUNT(*) FROM community_likes l WHERE l.post_id = p.id) AS likes,
              (SELECT COUNT(*) FROM community_comments c WHERE c.post_id = p.id) AS comment_count,
              (SELECT COUNT(*) FROM community_likes l2 WHERE l2.post_id = p.id AND l2.user_id = ?) AS liked_by_me
       FROM community_posts p
       ORDER BY p.created_at DESC
       LIMIT ?`
    ).bind(user.id, limit).all();

    // 2 komentar terakhir tiap postingan (untuk pratinjau)
    const ids = (posts.results || []).map(p => p.id);
    let commentsByPost = {};
    if (ids.length) {
      const marks = ids.map(() => '?').join(',');
      const cs = await env.DB.prepare(
        `SELECT id, post_id, author_name, text, created_at FROM community_comments
         WHERE post_id IN (${marks}) ORDER BY created_at DESC LIMIT 60`
      ).bind(...ids).all();
      (cs.results || []).forEach(c => {
        if (!commentsByPost[c.post_id]) commentsByPost[c.post_id] = [];
        if (commentsByPost[c.post_id].length < 2) commentsByPost[c.post_id].push(c);
      });
    }

    const feed = (posts.results || []).map(p => ({
      id: p.id,
      author: p.author_name,
      user_id: p.user_id,
      mine: p.user_id === user.id,
      text: p.text,
      image: p.image || '',
      created_at: p.created_at,
      likes: p.likes || 0,
      liked_by_me: p.liked_by_me > 0,
      comment_count: p.comment_count || 0,
      comments: (commentsByPost[p.id] || []).reverse()
    }));

    return j({ feed, me: { name: await authorLabel(env.DB, user), id: user.id } });
  } catch (err) {
    return j({ error: err.message }, 500);
  }
}

export async function onRequestPost({ env, request }) {
  try {
    const user = await currentUser(env, request);
    if (!user) return j({ error: 'Login diperlukan', need_login: true }, 401);
    await ensureTables(env.DB);

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '');
    const action = path.endsWith('/react') ? 'react' : (path.endsWith('/comment') ? 'comment' : 'post');
    const body = await request.json().catch(() => ({}));

    if (action === 'post') {
      const text = String(body.text || '').trim();
      if (text.length > MAX_POST) return j({ error: 'Maksimal ' + MAX_POST + ' karakter' }, 400);
      let image = '';
      if (body.image != null && body.image !== '') {
        image = String(body.image);
        if (!image.startsWith('data:image/')) return j({ error: 'Format gambar tidak didukung' }, 400);
        if (image.length > 120000) return j({ error: 'Gambar kegedean — coba pilih yang lebih kecil' }, 400);
      }
      if (!text && !image) return j({ error: 'Postingan tidak boleh kosong' }, 400);

      // Anti-spam sederhana: maks 1 postingan per 15 detik per user
      const recent = await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM community_posts WHERE user_id = ? AND created_at > ?`
      ).bind(user.id, new Date(Date.now() - 15000).toISOString()).first();
      if (recent && recent.n > 0) return j({ error: 'Sabar sedikit — posting lagi 15 detik ke depan ya' }, 429);

      const id = randId();
      const label = await authorLabel(env.DB, user);
      await env.DB.prepare(
        `INSERT INTO community_posts (id, user_id, author_name, text, image, created_at) VALUES (?, ?, ?, ?, ?, ?)`
      ).bind(id, user.id, label, text, image, nowIso()).run();
      return j({ success: true, post: { id, author: label, user_id: user.id, mine: true, text, image, created_at: nowIso(), likes: 0, liked_by_me: false, comment_count: 0, comments: [] } });
    }

    if (action === 'react') {
      const postId = String(body.post_id || '');
      if (!postId) return j({ error: 'post_id wajib' }, 400);
      const exists = await env.DB.prepare(`SELECT id FROM community_posts WHERE id = ?`).bind(postId).first();
      if (!exists) return j({ error: 'Postingan tidak ditemukan' }, 404);
      const liked = await env.DB.prepare(
        `SELECT post_id FROM community_likes WHERE post_id = ? AND user_id = ?`
      ).bind(postId, user.id).first();
      if (liked) {
        await env.DB.prepare(`DELETE FROM community_likes WHERE post_id = ? AND user_id = ?`).bind(postId, user.id).run();
        return j({ success: true, liked: false });
      }
      await env.DB.prepare(
        `INSERT INTO community_likes (post_id, user_id, created_at) VALUES (?, ?, ?)`
      ).bind(postId, user.id, nowIso()).run();
      return j({ success: true, liked: true });
    }

    if (action === 'comment') {
      const postId = String(body.post_id || '');
      const text = String(body.text || '').trim();
      if (!postId) return j({ error: 'post_id wajib' }, 400);
      if (!text) return j({ error: 'Komentar tidak boleh kosong' }, 400);
      if (text.length > MAX_COMMENT) return j({ error: 'Maksimal ' + MAX_COMMENT + ' karakter' }, 400);
      const exists = await env.DB.prepare(`SELECT id FROM community_posts WHERE id = ?`).bind(postId).first();
      if (!exists) return j({ error: 'Postingan tidak ditemukan' }, 404);
      const id = randId();
      const label = await authorLabel(env.DB, user);
      await env.DB.prepare(
        `INSERT INTO community_comments (id, post_id, user_id, author_name, text, created_at) VALUES (?, ?, ?, ?, ?, ?)`
      ).bind(id, postId, user.id, label, text, nowIso()).run();
      return j({ success: true, comment: { id, post_id: postId, author: label, text, created_at: nowIso() } });
    }

    return j({ error: 'Aksi tidak dikenal' }, 400);
  } catch (err) {
    return j({ error: err.message }, 500);
  }
}
