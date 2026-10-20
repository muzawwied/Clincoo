// Rute publik pra-autentikasi panel: /api/admin/auth/<step> (request-otp, verify-otp, verify-key)
// — di-whitelist PUBLIC oleh _middleware.js; logika di _core.js (guard admin dilewati).
export { onRequestGet, onRequestPost } from '../_core.js';
