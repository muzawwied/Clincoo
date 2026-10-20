// Clincoo API Helper - Connects to Cloudflare D1 edge functions
// On GitHub Pages, API calls will fail gracefully (no server-side functions)
const API_BASE = ['clincoo-be2.pages.dev','localhost','127.0.0.1'].indexOf(location.hostname) === -1 ? 'https://clincoo-be2.pages.dev/api' : '/api';

// Helper: get current project ID from URL path or localStorage
function getCurrentProjectId() {
  if (typeof PathRouter !== 'undefined') {
    const pid = PathRouter.getProjectIdWithFallback();
    if (pid) return pid;
  }
  try {
    return localStorage.getItem('clincoo_current_project_id') || '';
  } catch(e) { return ''; }
}

const ClincooAPI = {
  // Environment Variables
  async getEnvVars() {
    const pid = getCurrentProjectId();
    const res = await fetch(API_BASE + '/env-vars?project_id=' + encodeURIComponent(pid));
    return res.json();
  },
  async addEnvVar(key, value, is_secret = false) {
    const res = await fetch(API_BASE + '/env-vars', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, value, is_secret, project_id: getCurrentProjectId() })
    });
    return res.json();
  },
  async deleteEnvVar(id) {
    const res = await fetch(API_BASE + '/env-vars?id=' + id + '&project_id=' + encodeURIComponent(getCurrentProjectId()), { method: 'DELETE' });
    return res.json();
  },

  // Activity Log
  async getActivity(limit = 50) {
    const res = await fetch(API_BASE + '/activity?limit=' + limit);
    return res.json();
  },
  async logActivity(type, description) {
    try {
      const res = await fetch(API_BASE + '/activity', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, description })
      });
      return res.json();
    } catch(e) { return { success: false }; }
  },

  // Notifications
  async getNotifications() {
    const res = await fetch(API_BASE + '/notifications');
    return res.json();
  },
  async markNotifRead(id) {
    const res = await fetch(API_BASE + '/notifications?id=' + id, { method: 'PATCH' });
    return res.json();
  },

  // Security
  async getSecuritySettings() {
    const res = await fetch(API_BASE + '/security?project_id=' + encodeURIComponent(getCurrentProjectId()));
    return res.json();
  },
  async updateSecuritySettings(data) {
    const res = await fetch(API_BASE + '/security', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...data, project_id: getCurrentProjectId() })
    });
    return res.json();
  },

  // Deploy
  async triggerDeploy() {
    const res = await fetch(API_BASE + '/deploy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project_id: getCurrentProjectId() })
    });
    return res.json();
  },
  async getDeployInfo() {
    const res = await fetch(API_BASE + '/deploy?project_id=' + encodeURIComponent(getCurrentProjectId()));
    return res.json();
  },

  // Settings
  async getSettings() {
    const res = await fetch(API_BASE + '/settings?project_id=' + encodeURIComponent(getCurrentProjectId()));
    return res.json();
  },
  async saveSettings(data) {
    const res = await fetch(API_BASE + '/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...data, project_id: getCurrentProjectId() })
    });
    return res.json();
  },

  // Wallet
  async getWallet() {
    const res = await fetch(API_BASE + '/wallet');
    return res.json();
  },
  async topUp(amount, method) {
    const res = await fetch(API_BASE + '/wallet', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'topup', amount, method })
    });
    return res.json();
  },

  // Subscription
  async getSubscription() {
    const res = await fetch(API_BASE + '/subscription');
    return res.json();
  },
  async updateSubscription(plan) {
    const res = await fetch(API_BASE + '/subscription', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'update', plan })
    });
    return res.json();
  },

  // Account Profile
  async getProfile() {
    const res = await fetch(API_BASE + '/account-profile');
    return res.json();
  },
  async updateProfile(data) {
    const res = await fetch(API_BASE + '/account-profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return res.json();
  },

  // Preferences
  async getPreferences() {
    const res = await fetch(API_BASE + '/preferences');
    return res.json();
  },
  async savePreferences(data) {
    const res = await fetch(API_BASE + '/preferences', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return res.json();
  },

  // Export Data
  async exportData() {
    const res = await fetch(API_BASE + '/export-data');
    return res.json();
  },

  // Chat
  async chat(prompt, projectId) {
    const res = await fetch(API_BASE + '/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, project_id: projectId || getCurrentProjectId() })
    });
    return res.json();
  },

  // Init DB
  async initDb() {
    const res = await fetch(API_BASE + '/init-db', { method: 'POST' });
    return res.json();
  }
};

// ---- Alias methods for pages that use the older API names ----
// (getSecurity/updateSecurity dipakai halaman keamanan-https & visibilitas-akses)
ClincooAPI.getSecurity = async function() {
  const pid = getCurrentProjectId();
  const res = await fetch(API_BASE + '/security?project_id=' + encodeURIComponent(pid));
  return res.json();
};
ClincooAPI.updateSecurity = async function(key, value) {
  const res = await fetch(API_BASE + '/security', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, value, project_id: getCurrentProjectId() })
  });
  return res.json();
};
