import { PLAN_AI_LIMITS, ADMIN_EMAILS, getEffectivePlanByUserKey, featureAllowed } from './plan-helpers.js';
import { searchClincooBlog } from './blogsearch.js';
import { paymentDocsFor } from './payment-kb-data.js';
import { aiStorageSave, aiStorageGet, aiStorageList, aiStorageDelete } from './ai-storage.js';
import { consumePackCredit, getActivePacks } from './ai-packs.js';
import { initTables as initAuthTables, getUserByToken, getToken } from './auth/shared.js';
import { wsToolExec, WS_TOOL_NAMES } from './_ws-tools.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

export async function onRequestOptions() {
  return new Response(null, { status: 200, headers: CORS });
}

const RATE_LIMIT = { max: 30, windowMs: 60_000 };
const rateBuckets = new Map();
function rateLimitOk(ip) {
  const now = Date.now();
  let b = rateBuckets.get(ip);
  if (!b || now - b.start >= RATE_LIMIT.windowMs) b = { start: now, count: 0 };
  b.count++;
  rateBuckets.set(ip, b);
  if (rateBuckets.size > 5000) {
    for (const [k, v] of rateBuckets) if (now - v.start >= RATE_LIMIT.windowMs) rateBuckets.delete(k);
  }
  return b.count <= RATE_LIMIT.max;
