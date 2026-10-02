// Cloudflare Pages Functions - D1 Database schema initialization
// Visit /api/init-db to initialize the database tables

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

export async function onRequestOptions() {
  return new Response(null, { headers: CORS });
}

export async function onRequestGet({ request, env }) {
  const db = env.DB;
  if (!db) {
    return new Response(JSON.stringify({ error: 'D1 database not bound' }), {
      status: 500, headers: { 'Content-Type': 'application/json', ...CORS }
    });
  }

  try {
    // Notifications (account-level)
    await db.prepare(`CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, message TEXT NOT NULL,
      read INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now'))
    )`).run();

    // User preferences (account-level - theme, accent, etc)
    await db.prepare(`CREATE TABLE IF NOT EXISTS user_preferences (
      key TEXT PRIMARY KEY, value TEXT
    )`).run();

    // Account profile (per-account: name, email, avatar)
    await db.prepare(`CREATE TABLE IF NOT EXISTS account_profile (
      key TEXT PRIMARY KEY, value TEXT
    )`).run();

    // Activity log
    await db.prepare(`CREATE TABLE IF NOT EXISTS activity_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT NOT NULL, details TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )`).run();

    // Projects table
    await db.prepare(`CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT,
      status TEXT DEFAULT 'active', created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )`).run();

    // Env vars (per-project)
    await db.prepare(`CREATE TABLE IF NOT EXISTS env_vars (
      id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT, key TEXT NOT NULL, value TEXT NOT NULL,
      is_secret INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )`).run();

    // Security settings (per-project)
    await db.prepare(`CREATE TABLE IF NOT EXISTS security_settings (
      project_id TEXT, key TEXT NOT NULL, value TEXT,
      PRIMARY KEY (project_id, key)
    )`).run();

    // Project settings (per-project: domain, webhooks, collaboration, etc)
    await db.prepare(`CREATE TABLE IF NOT EXISTS project_settings (
      project_id TEXT, key TEXT NOT NULL, value TEXT,
      PRIMARY KEY (project_id, key)
    )`).run();

    // Deploy logs (per-project)
    await db.prepare(`CREATE TABLE IF NOT EXISTS project_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL,
      path TEXT NOT NULL,
      content TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(project_id, path)
    )`).run();

    await db.prepare(`CREATE TABLE IF NOT EXISTS deploy_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT, status TEXT, url TEXT, message TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )`).run();

    // Chat sessions
    await db.prepare(`CREATE TABLE IF NOT EXISTS chat_sessions (
      id TEXT PRIMARY KEY, title TEXT DEFAULT 'Percakapan Baru',
      created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
    )`).run();

    // Chat messages
    await db.prepare(`CREATE TABLE IF NOT EXISTS chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL,
      content TEXT NOT NULL, model TEXT, created_at TEXT DEFAULT (datetime('now'))
    )`).run();

    // Wallet (account-level)
    await db.prepare(`CREATE TABLE IF NOT EXISTS wallet_transactions (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, amount REAL NOT NULL,
      type TEXT NOT NULL, method TEXT, created_at TEXT DEFAULT (datetime('now'))
    )`).run();

    await db.prepare(`CREATE TABLE IF NOT EXISTS wallet_balance (
      key TEXT PRIMARY KEY, value TEXT
    )`).run();

    // Subscription (account-level)
    await db.prepare(`CREATE TABLE IF NOT EXISTS subscription (
      key TEXT PRIMARY KEY, value TEXT
    )`).run();

    // Migrate old tables: add project_id column if missing (must run before indexes)
    try {
      await db.prepare('ALTER TABLE env_vars ADD COLUMN project_id TEXT').run();
    } catch(e) {}
    try {
      await db.prepare('ALTER TABLE deploy_logs ADD COLUMN project_id TEXT').run();
    } catch(e) {}
    try {
      await db.prepare('ALTER TABLE chat_sessions ADD COLUMN project_id TEXT').run();
    } catch(e) {}

    // Migrate security_settings from old schema (key PRIMARY KEY) to new schema (project_id, key)
    try {
      const secInfo = await db.prepare('PRAGMA table_info(security_settings)').all();
      const secHasProjectId = (secInfo.results || []).some(c => c.name === 'project_id');
      if (!secHasProjectId && secInfo.results && secInfo.results.length > 0) {
        await db.prepare('ALTER TABLE security_settings RENAME TO security_settings_old').run();
        await db.prepare('CREATE TABLE security_settings (project_id TEXT, key TEXT NOT NULL, value TEXT, PRIMARY KEY (project_id, key))').run();
        await db.prepare("INSERT INTO security_settings (project_id, key, value) SELECT '', key, value FROM security_settings_old").run();
        await db.prepare('DROP TABLE security_settings_old').run();
      }
    } catch(e) {}

    // Create indexes
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_notifications_read ON notifications(read)').run();
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_activity_log_created ON activity_log(created_at)').run();
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(session_id)').run();
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_chat_messages_created ON chat_messages(created_at)').run();
    try {
      await db.prepare('CREATE INDEX IF NOT EXISTS idx_env_vars_project ON env_vars(project_id)').run();
    } catch(e) {}
    try {
      await db.prepare('CREATE INDEX IF NOT EXISTS idx_deploy_logs_project ON deploy_logs(project_id)').run();
    } catch(e) {}

    return new Response(JSON.stringify({
      success: true,
      tables: ['notifications', 'user_preferences', 'account_profile', 'activity_log', 'projects', 'env_vars', 'security_settings', 'project_settings', 'deploy_logs', 'chat_sessions', 'chat_messages', 'wallet_transactions', 'wallet_balance', 'subscription']
    }), { headers: { 'Content-Type': 'application/json', ...CORS } });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: { 'Content-Type': 'application/json', ...CORS }
    });
  }
}
