import { currentUser, scopedKey, rowScope } from './user-scope.js';

// Cloudflare Pages Functions - Account Profile Backend
// Stores per-account profile data (name, email, avatar) in D1

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

export async function onRequestOptions() {
  return new Response(null, { headers: CORS });
}

// GET /api/account-profile — get profile data
export async function onRequestGet({ request, env }) {
  const db = env.DB;
  if (!db) return new Response(JSON.stringify({ error: 'D1 not bound' }), { status: 500, headers: { 'Content-Type': 'application/json', ...CORS } });

  try {
    await db.prepare('CREATE TABLE IF NOT EXISTS account_profile (key TEXT PRIMARY KEY, value TEXT)').run();
    
    const user = await currentUser(env, request);

    const key = new URL(request.url).searchParams.get('key');
    if (key) {
      const row = await db.prepare('SELECT value FROM account_profile WHERE key = ?').bind(await scopedKey(db, 'account_profile', user, key)).first();
      return new Response(JSON.stringify({ key, value: row?.value || null }), {
        headers: { 'Content-Type': 'application/json', ...CORS }
      });
    }

    await scopedKey(db, 'account_profile', user, 'name'); // klaim data legacy sekali
    const rows = await db.prepare('SELECT key, value FROM account_profile').all();
    const pfx = user ? 'u' + user.id + ':' : '';
    const data = {};
    for (const row of rows.results || []) {
      if (user ? row.key.startsWith(pfx) : !row.key.includes(':')) data[row.key.slice(pfx.length)] = row.value;
    }
    

    
    return new Response(JSON.stringify(data), {
      headers: { 'Content-Type': 'application/json', ...CORS }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { 'Content-Type': 'application/json', ...CORS } });
  }
}

// POST /api/account-profile — update profile
// Body: { name: 'xxx', email: 'xxx', avatar: 'data:...' }
export async function onRequestPost({ request, env }) {
  const db = env.DB;
  if (!db) return new Response(JSON.stringify({ error: 'D1 not bound' }), { status: 500, headers: { 'Content-Type': 'application/json', ...CORS } });

  try {
    await db.prepare('CREATE TABLE IF NOT EXISTS account_profile (key TEXT PRIMARY KEY, value TEXT)').run();
    
    const body = await request.json();
    const user = await currentUser(env, request);
    const updates = {};
    
    for (const [key, value] of Object.entries(body)) {
      if (key === 'key' || key === 'value') continue;
      updates[key] = String(value);
      const sk = await scopedKey(db, 'account_profile', user, key);
      await db.prepare("INSERT INTO account_profile (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(sk, String(value)).run();
    }

    const changedKeys = Object.keys(updates);
    if (changedKeys.length > 0) {
      try {
        const puUser = await currentUser(env, request);
        const puUid = await rowScope(db, 'activity_log', puUser);
        await db.prepare("INSERT INTO activity_log (action, details, user_id) VALUES (?, ?, ?)").bind('profile_updated', JSON.stringify(updates), puUid).run();
      } catch(e) {}
    }

    return new Response(JSON.stringify({ success: true, updated: updates }), {
      headers: { 'Content-Type': 'application/json', ...CORS }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { 'Content-Type': 'application/json', ...CORS } });
  }
}
