// Cloudflare Pages Functions - Notifications with page links (per-account)
import { currentUser, rowScope } from './user-scope.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

function j(data, status) {
  return new Response(JSON.stringify(data), { status: status || 200, headers: { 'Content-Type': 'application/json', ...CORS } });
}

async function ensureTable(db) {
  await db.prepare('CREATE TABLE IF NOT EXISTS notifications (id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, message TEXT NOT NULL, type TEXT DEFAULT "info", link TEXT, read INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime(\'now\')))').run();
}

export async function onRequestOptions() { return new Response(null, { headers: CORS }); }

export async function onRequestDelete({ request, env }) {
  try {
    const db = env.DB;
    if (!db) return j({ error: 'D1 not bound' }, 500);
    const url = new URL(request.url);
    const id = url.searchParams.get('id');
    const user = await currentUser(env, request);
    const uid = await rowScope(db, 'notifications', user);

    if (id) {
      if (uid) await db.prepare('DELETE FROM notifications WHERE id = ? AND user_id = ?').bind(id, uid).run();
      else await db.prepare('DELETE FROM notifications WHERE id = ?').bind(id).run();
    } else {
      if (uid) await db.prepare('DELETE FROM notifications WHERE read = 1 AND user_id = ?').bind(uid).run();
      else await db.prepare('DELETE FROM notifications WHERE read = 1').run();
    }
    return j({ success: true });
  } catch (err) {
    return j({ error: err.message }, 500);
  }
}

export async function onRequestPost({ request, env }) {
  try {
    const db = env.DB;
    if (!db) return j({ error: 'D1 not bound' }, 500);
    const body = await request.json();
    const action = body.action || 'create';
    const user = await currentUser(env, request);
    const uid = await rowScope(db, 'notifications', user);

    if (action === 'mark_read') {
      const id = body.id;
      if (!id) return j({ error: 'id required' }, 400);
      if (uid) await db.prepare('UPDATE notifications SET read = 1 WHERE id = ? AND user_id = ?').bind(id, uid).run();
      else await db.prepare('UPDATE notifications SET read = 1 WHERE id = ?').bind(id).run();
      return j({ success: true });
    }

    if (action === 'mark_all_read') {
      if (uid) await db.prepare('UPDATE notifications SET read = 1 WHERE read = 0 AND user_id = ?').bind(uid).run();
      else await db.prepare('UPDATE notifications SET read = 1 WHERE read = 0').run();
      return j({ success: true });
    }

    if (action === 'clear_all') {
      if (uid) await db.prepare('DELETE FROM notifications WHERE user_id = ?').bind(uid).run();
      else await db.prepare('DELETE FROM notifications').run();
      return j({ success: true });
    }

    if (action === 'clear_read') {
      if (uid) await db.prepare('DELETE FROM notifications WHERE read = 1 AND user_id = ?').bind(uid).run();
      else await db.prepare('DELETE FROM notifications WHERE read = 1').run();
      return j({ success: true });
    }

    const { source, message, link, type } = body;
    if (!source || !message) return j({ error: 'source and message required' }, 400);
    await ensureTable(db);
    await db.prepare('INSERT INTO notifications (source, message, type, link, user_id) VALUES (?, ?, ?, ?, ?)')
      .bind(source, message, type || 'info', link || '', uid).run();
    return j({ success: true });
  } catch (err) {
    return j({ error: err.message }, 500);
  }
}

export async function onRequestGet({ request, env }) {
  try {
    const db = env.DB;
    if (!db) return j({ error: 'D1 not bound' }, 500);
    await ensureTable(db);
    const url = new URL(request.url);
    const unreadOnly = url.searchParams.get('unread') === 'true';
    const user = await currentUser(env, request);
    const uid = await rowScope(db, 'notifications', user);

    let query = uid
      ? "SELECT * FROM notifications WHERE user_id = ? AND (read = 0 OR (read = 1 AND created_at > datetime('now', '-1 hour'))) ORDER BY created_at DESC LIMIT 50"
      : "SELECT * FROM notifications WHERE read = 0 OR (read = 1 AND created_at > datetime('now', '-1 hour')) ORDER BY created_at DESC LIMIT 50";
    if (unreadOnly) {
      query = uid
        ? 'SELECT * FROM notifications WHERE user_id = ? AND read = 0 ORDER BY created_at DESC LIMIT 50'
        : 'SELECT * FROM notifications WHERE read = 0 ORDER BY created_at DESC LIMIT 50';
    }
    const result = await db.prepare(query).bind(...(uid ? [uid] : [])).all();

    const unreadResult = uid
      ? await db.prepare('SELECT COUNT(*) as c FROM notifications WHERE user_id = ? AND read = 0').bind(uid).first()
      : await db.prepare('SELECT COUNT(*) as c FROM notifications WHERE read = 0').first();

    return j({ notifications: result.results, unreadCount: unreadResult?.c || 0 });
  } catch (err) {
    return j({ error: err.message }, 500);
  }
}
