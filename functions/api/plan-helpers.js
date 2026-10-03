// Cloudflare Pages Functions — Helper Batas Paket Langganan
// Dipakai bersama oleh projects.js (batas jumlah proyek) dan collab.js (batas kolaborator).
// Paket & start_date dibaca real-time dari tabel `subscription` (per-akun, prefix "u<id>:").
// Langganan berbayar yang kedaluwarsa (Bulanan 30 hari / Tahunan 365 hari dari start_date)
// otomatis turun ke Starter supaya limit tidak bisa "numpang" selamanya.

export const PLAN_LIMITS = {
  // deployLimit = deploy web per bulan per akun; null = tanpa batas
  Starter: { projectLimit: 3, collaboratorLimit: 1, deployLimit: 5 },
  Pro: { projectLimit: 10, collaboratorLimit: 5, deployLimit: 25 },
  Bisnis: { projectLimit: 50, collaboratorLimit: 20, deployLimit: null }
};

// Kuota chat AI per paket: bulanan (selaras periode tagihan) + cap harian (anti-burst).
// Benar-benar diterapkan di /api/chat (dua-duanya dicek server-side).
export const PLAN_AI_LIMITS = {
  Starter: { monthly: 50, daily: 10 },
  Pro: { monthly: 500, daily: 50 },
  Bisnis: { monthly: 2000, daily: 150 }
};

// Kredit Open API Clincoo (Integrasi AI, /v1/chat/completions) per paket —
// disimpan dalam mikro-dolar (1.000.000 unit = $1) supaya bebas float.
// Harian = anti-burst; bulanan = anggaran per periode tagihan (YYYY-MM).
// Harga per model ada di functions/v1/chat/completions.js (MODEL_PRICES).
export const PLAN_AI_API_CREDITS = {
  Starter: { daily: 50000, monthly: 1000000 },    // $0.05/hari, $1/bulan
  Pro:     { daily: 250000, monthly: 5000000 },   // $0.25/hari, $5/bulan
  Bisnis:  { daily: 1000000, monthly: 20000000 }  // $1/hari, $20/bulan
};

// Email admin: bypass semua gate paket (kebijakan internal).
export const ADMIN_EMAILS = new Set(['muzawwied@gmail.com']);

// Rencana efektif dari key user ('u<id>') — dipakai lintas endpoint tanpa bentuk objek user penuh.
export async function getEffectivePlanByUserKey(db, userKey) {
  const fallback = { plan: 'Starter', limits: PLAN_LIMITS.Starter, expiredFrom: null };
  try {
    if (!db || !userKey) return fallback;
    const pfx = String(userKey).replace(/:$/, '') + ':';
    const rows = await db.prepare(
      'SELECT key, value FROM subscription WHERE key IN (?, ?, ?)'
    ).bind(pfx + 'plan', pfx + 'start_date', pfx + 'billing_cycle').all();
    const m = {};
    for (const r of rows.results || []) m[r.key.slice(pfx.length)] = r.value;
    let plan = (m.plan && PLAN_LIMITS[m.plan]) ? m.plan : 'Starter';
    let expiredFrom = null;
    if (plan !== 'Starter') {
      const start = m.start_date ? new Date(String(m.start_date).replace(' ', 'T')) : null;
      const days = (m.billing_cycle === 'Tahunan') ? 365 : 30;
      if (start && !isNaN(start.getTime()) && (Date.now() - start.getTime()) > days * 86400000) {
        expiredFrom = plan;
        plan = 'Starter';
      }
    }
    return { plan, limits: PLAN_LIMITS[plan], expiredFrom };
  } catch (e) {
    return fallback;
  }
}

// Kuota deploy bulanan disimpan di tabel `subscription` (key per-akun per-bulan)
export async function getMonthlyDeployCount(db, userId) {
  try {
    if (!db || !userId) return 0;
    const key = 'u' + userId + ':deploys_' + new Date().toISOString().slice(0, 7);
    const row = await db.prepare('SELECT value FROM subscription WHERE key = ?').bind(key).first();
    return parseInt(row && row.value, 10) || 0;
  } catch (e) {
    return 0;
  }
}

export async function bumpMonthlyDeployCount(db, userId) {
  try {
    if (!db || !userId) return;
    const key = 'u' + userId + ':deploys_' + new Date().toISOString().slice(0, 7);
    await db.prepare('INSERT INTO subscription (key, value) VALUES (?, 1) ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1')
      .bind(key).run();
  } catch (e) {}
}

export async function getEffectivePlan(db, user) {
  const fallback = { plan: 'Starter', limits: PLAN_LIMITS.Starter, expiredFrom: null };
  try {
    if (!db || !user || !user.id) return fallback;
    const pfx = 'u' + user.id + ':';
    const rows = await db.prepare(
      'SELECT key, value FROM subscription WHERE key IN (?, ?, ?)'
    ).bind(pfx + 'plan', pfx + 'start_date', pfx + 'billing_cycle').all();
    const m = {};
    for (const r of rows.results || []) m[r.key.slice(pfx.length)] = r.value;
    let plan = (m.plan && PLAN_LIMITS[m.plan]) ? m.plan : 'Starter';
    let expiredFrom = null;
    if (plan !== 'Starter') {
      const start = m.start_date ? new Date(String(m.start_date).replace(' ', 'T')) : null;
      const days = (m.billing_cycle === 'Tahunan') ? 365 : 30;
      if (start && !isNaN(start.getTime()) && (Date.now() - start.getTime()) > days * 86400000) {
        expiredFrom = plan;
        plan = 'Starter';
      }
    }
    return { plan, limits: PLAN_LIMITS[plan], expiredFrom };
  } catch (e) {
    return fallback;
  }
}

export async function countProjects(db, userId) {
  try {
    const r = await db.prepare('SELECT COUNT(*) AS c FROM user_projects WHERE user_id = ?').bind(userId).first();
    return r?.c || 0;
  } catch (e) { return 0; }
}

export async function countProjectMembers(db, projectId) {
  try {
    const r = await db.prepare('SELECT COUNT(*) AS c FROM project_members WHERE project_id = ?').bind(projectId).first();
    return r?.c || 0;
  } catch (e) { return 0; }
}

export async function countPendingInvites(db, projectId) {
  try {
    const r = await db.prepare("SELECT COUNT(*) AS c FROM collab_invites WHERE project_id = ? AND status = 'pending'").bind(projectId).first();
    return r?.c || 0;
  } catch (e) { return 0; }
}
