-- Clinqoo D1 Database Schema
-- Run via: wrangler d1 execute clincoo-db --remote --file=schema.sql

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  message TEXT NOT NULL,
  read INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS user_preferences (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS activity_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,
  details TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT DEFAULT 'active',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS env_vars (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL UNIQUE,
  value TEXT NOT NULL,
  is_secret INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS security_settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS deploy_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  status TEXT,
  url TEXT,
  message TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS chat_sessions (
  id TEXT PRIMARY KEY,
  title TEXT DEFAULT 'Percakapan Baru',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  model TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS wallet_transactions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  amount REAL NOT NULL,
  type TEXT NOT NULL,
  method TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS wallet_balance (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE INDEX IF NOT EXISTS idx_notifications_read ON notifications(read);
CREATE INDEX IF NOT EXISTS idx_activity_log_created ON activity_log(created_at);
CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(session_id);
CREATE INDEX IF NOT EXISTS idx_chat_messages_created ON chat_messages(created_at);

CREATE TABLE IF NOT EXISTS topup_orders (
  id TEXT PRIMARY KEY,
  amount REAL NOT NULL,
  method TEXT,
  status TEXT DEFAULT 'pending',
  xendit_id TEXT,
  invoice_url TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  paid_at TEXT,
  user_id TEXT,
  qr_url TEXT,
  bill_total REAL,
  expires_at TEXT
);

-- ============================================================================
-- Clinqoo Admin Panel Schema Extensions
-- Dokumentasi kolom baru pada auth_users:
--   - role TEXT DEFAULT 'user' ('admin' | 'user')
--   - status TEXT DEFAULT 'active' ('active' | 'suspended' | 'deleted')
--   - suspend_reason TEXT (Alasan penangguhan akun)
-- ============================================================================

CREATE TABLE IF NOT EXISTS admin_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT,
  target_user_id INTEGER,
  details TEXT,
  status TEXT DEFAULT 'open',
  source TEXT DEFAULT 'system',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_admin_reports_status ON admin_reports(status);
CREATE INDEX IF NOT EXISTS idx_admin_reports_created ON admin_reports(created_at);

-- ============================================================================
-- template_submissions — pengajuan template komunitas dari halaman galeri.
--   - status: pending | approved | rejected
--   - review_token: token unik untuk CTA Setujui/Tolak di email reviewer
--   - uses / views: hitungan real-time pemakaian & kunjungan template
-- ============================================================================

CREATE TABLE IF NOT EXISTS template_submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  creator_name TEXT DEFAULT '',
  creator_email TEXT DEFAULT '',
  project_name TEXT DEFAULT '',
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  preview_url TEXT DEFAULT '',
  thumbnail TEXT DEFAULT '',
  status TEXT DEFAULT 'pending',
  review_token TEXT,
  uses INTEGER DEFAULT 0,
  views INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  reviewed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_template_submissions_status ON template_submissions(status);
