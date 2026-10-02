// Helper bersama untuk /api/auth/* — JANGAN pakai prefix "_" (wrangler mengecualikannya dari bundle)
// Skema mengikuti tabel production yang sudah ada: auth_users(name, email, password_hash, avatar_url)
// Format hash: "pbkdf2:<iterations>:<salthex>:<hashhex>"
export const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};
export const JSON_HEADERS = { 'Content-Type': 'application/json', ...CORS };

export function json(data, status) {
  return new Response(JSON.stringify(data), { status: status || 200, headers: JSON_HEADERS });
}

export async function initTables(db) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS auth_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT UNIQUE,
    password_hash TEXT,
    avatar_url TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS auth_sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL
  )`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS auth_oauth_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    provider TEXT NOT NULL,
    provider_account_id TEXT NOT NULL,
    access_token TEXT,
    scope TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(provider, provider_account_id)
  )`).run();
  // Migrasi aman untuk DB yang sudah ada sebelumnya
  try { await db.prepare('ALTER TABLE auth_oauth_accounts ADD COLUMN access_token TEXT').run(); } catch (e) {}
  try { await db.prepare('ALTER TABLE auth_oauth_accounts ADD COLUMN scope TEXT').run(); } catch (e) {}
}

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}
function bytesToHex(bytes) {
  return Array.from(bytes).map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
}
export function randomHex(nBytes) {
  const b = new Uint8Array(nBytes);
  crypto.getRandomValues(b);
  return bytesToHex(b);
}
async function pbkdf2(password, saltHex, iterations) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: hexToBytes(saltHex), iterations }, key, 256);
  return bytesToHex(new Uint8Array(bits));
}
export async function makePasswordHash(password) {
  const iterations = 100000;
  const salt = randomHex(16);
  const hash = await pbkdf2(password, salt, iterations);
  return 'pbkdf2:' + iterations + ':' + salt + ':' + hash;
}
export async function verifyPassword(password, stored) {
  try {
    const parts = String(stored || '').split(':');
    if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
    const iterations = parseInt(parts[1], 10) || 100000;
    const hash = await pbkdf2(password, parts[2], iterations);
    return hash === parts[3];
  } catch (e) { return false; }
}
export function validEmail(e) { return typeof e === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim()); }

export function publicUser(u) {
  return { id: u.id, email: u.email, name: u.name || '', avatar_url: u.avatar_url || '' };
}

export function getToken(request) {
  const h = request.headers.get('Authorization') || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

export async function createSession(db, userId) {
  const token = randomHex(32);
  const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  await db.prepare('INSERT INTO auth_sessions (token, user_id, expires_at) VALUES (?, ?, ?)').bind(token, userId, expires).run();
  return token;
}

export async function getUserByToken(db, token) {
  if (!token) return null;
  const sess = await db.prepare('SELECT * FROM auth_sessions WHERE token = ?').bind(token).first();
  if (!sess) return null;
  if (new Date(sess.expires_at) < new Date()) {
    try { await db.prepare('DELETE FROM auth_sessions WHERE token = ?').bind(token).run(); } catch (e) {}
    return null;
  }
  return await db.prepare('SELECT * FROM auth_users WHERE id = ?').bind(sess.user_id).first();
}

// Login/daftar via OAuth: pakai auth_oauth_accounts, email sebagai fallback identitas
export async function upsertOauthUser(db, provider, providerAccountId, email, name, avatarUrl, accessToken, scope) {
  let link = await db.prepare('SELECT user_id FROM auth_oauth_accounts WHERE provider = ? AND provider_account_id = ?')
    .bind(provider, String(providerAccountId)).first();
  let user;
  if (link) {
    user = await db.prepare('SELECT * FROM auth_users WHERE id = ?').bind(link.user_id).first();
  } else {
    user = email ? await db.prepare('SELECT * FROM auth_users WHERE email = ?').bind(email.toLowerCase()).first() : null;
    if (!user) {
      await db.prepare('INSERT INTO auth_users (name, email, password_hash, avatar_url) VALUES (?, ?, \'\', ?)')
        .bind(name || '', email ? email.toLowerCase() : null, avatarUrl || '').run();
      user = await db.prepare('SELECT * FROM auth_users WHERE email = ?').bind(email.toLowerCase()).first();
    }
    await db.prepare('INSERT OR IGNORE INTO auth_oauth_accounts (user_id, provider, provider_account_id) VALUES (?, ?, ?)')
      .bind(user.id, provider, String(providerAccountId)).run();
  }
  // Simpan/perbarui token provider (dipakai untuk akses API provider, mis. import repo GitHub)
  if (accessToken) {
    await db.prepare('UPDATE auth_oauth_accounts SET access_token = ?, scope = ? WHERE provider = ? AND provider_account_id = ?')
      .bind(accessToken, scope || null, provider, String(providerAccountId)).run();
  }
  if (user && (avatarUrl && !user.avatar_url)) {
    await db.prepare('UPDATE auth_users SET avatar_url = ? WHERE id = ?').bind(avatarUrl, user.id).run();
    user.avatar_url = avatarUrl;
  }
  return user;
}

export async function getEnvVarDb(db, key) {
  try {
    const row = await db.prepare('SELECT value FROM env_vars WHERE key = ?').bind(key).first();
    return row ? row.value : null;
  } catch (e) { return null; }
}
