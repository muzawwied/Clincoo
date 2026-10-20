import fs from 'node:fs';
import assert from 'node:assert/strict';

// ---------- 1. drive-oauth.js: tukar code (mock fetch ke googleapis) ----------
let oauthCode = fs.readFileSync('functions/api/drive-oauth.js','utf8');
// data: URL tidak mendukung import relatif -> stub dua import sebelum evaluasi.
oauthCode = oauthCode
  .replace("import { currentUser } from './user-scope.js';", "const currentUser = async (env, req) => { const h = req.headers.get('authorization')||''; return h.includes('stub-user') ? { id: 96, email: 'u@example.com' } : null; };")
  .replace("import { getEnvVarDb } from './auth/shared.js';", "const getEnvVarDb = async (db, key) => { const r = await db.prepare('SELECT value FROM env_vars WHERE key = ' + key).first(); return r ? r.value : null; };");
const oauthMod = await import('data:text/javascript,'+encodeURIComponent(oauthCode));

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  url = String(url);
  if (url.startsWith('https://oauth2.googleapis.com/token')) {
    const body = String(opts.body || '');
    if (body.includes('grant_type=authorization_code')) {
      if (!body.includes('code=CODE123')) return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400, headers: {'content-type':'application/json'} });
      return new Response(JSON.stringify({ access_token: 'AT1', refresh_token: 'RT1', expires_in: 3600, scope: 'drive' }), { status: 200, headers: {'content-type':'application/json'} });
    }
    if (body.includes('grant_type=refresh_token')) {
      if (!body.includes('refresh_token=RT1')) return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400, headers: {'content-type':'application/json'} });
      return new Response(JSON.stringify({ access_token: 'AT2', expires_in: 3600 }), { status: 200, headers: {'content-type':'application/json'} });
    }
  }
  if (url.startsWith('https://www.googleapis.com/oauth2/v2/userinfo')) {
    if ((opts.headers||{}).Authorization !== 'Bearer AT1') return new Response(JSON.stringify({ error: 'x' }), { status: 401, headers: {'content-type':'application/json'} });
    return new Response(JSON.stringify({ name: 'Vylonium', email: 'v@example.com', picture: 'p.png' }), { status: 200, headers: {'content-type':'application/json'} });
  }
  throw new Error('unexpected fetch: ' + url);
};
const mkEnv = () => ({ DB: { prepare(q){ const sql=String(q); const first = async () => (sql.includes('GOOGLE_CLIENT_ID') ? {value:'gcid'} : sql.includes('GOOGLE_CLIENT_SECRET') ? {value:'gsecret'} : null); return { first, bind(){ return { first }; } }; } } });
const mkReq = (body) => new Request('https://app.clincoo.buzz/api/drive-oauth', { method:'POST', headers:{'content-type':'application/json','authorization':'Bearer fake'}, body: JSON.stringify(body) });

const mkAuthReq = (body) => new Request('https://app.clincoo.buzz/api/drive-oauth', { method:'POST', headers:{'content-type':'application/json','authorization':'Bearer stub-user'}, body: JSON.stringify(body) });

let r401 = await oauthMod.onRequestPost({ request: mkReq({ code:'X' }), env: { DB: undefined } });
assert.equal(r401.status, 401);
assert.match((await r401.json()).error, /login Clincoo/);

let r = await oauthMod.onRequestPost({ request: mkAuthReq({ code:'CODE123', redirect_uri:'https://app.clincoo.buzz/auth/' }), env: mkEnv() });
let d = await r.json();
assert.equal(r.status, 200);
assert.equal(d.access_token, 'AT1');
assert.equal(d.refresh_token, 'RT1');
assert.equal(d.user.email, 'v@example.com');

r = await oauthMod.onRequestPost({ request: mkAuthReq({ code:'BAD', redirect_uri:'https://app.clincoo.buzz/auth/' }), env: mkEnv() });
assert.equal(r.status, 400);

r = await oauthMod.onRequestPost({ request: mkAuthReq({ refresh_token:'RT1' }), env: mkEnv() });
d = await r.json();
assert.equal(d.access_token, 'AT2');

// ---------- 2. ai-tools drive_request ----------
let tool = await import('data:text/javascript,'+encodeURIComponent(fs.readFileSync('functions/api/ai-tools.js','utf8')));
globalThis.fetch = async (url, opts) => {
  url = String(url);
  if (url === 'https://www.googleapis.com/drive/v3/files?pageSize=5') {
    if ((opts.headers||{}).Authorization !== 'Bearer AT2') return new Response(JSON.stringify({ error: { code: 401, message: 'Invalid Credentials' } }), { status: 401, headers: {'content-type':'application/json'} });
    return new Response(JSON.stringify({ files: [{ id:'f1', name:'laporan.txt' }] }), { status: 200, headers: {'content-type':'application/json'} });
  }
  throw new Error('unexpected fetch: ' + url);
};
let middleware = fs.readFileSync('functions/api/_middleware.js','utf8')
  .replace("import { initTables as initAuthTables, getUserByToken, getToken } from './auth/shared.js';", "const initAuthTables = async()=>{}; const getUserByToken = async()=>({id:96}); const getToken = ()=> 'fake-test';");
const mw = await import('data:text/javascript,'+encodeURIComponent(middleware));
const callTool = async (payload) => {
  const request = new Request('https://clincoo-be2.pages.dev/api/ai-tools', {method:'POST', headers:{'origin':'https://app.clincoo.buzz','authorization':'Bearer fake-test','content-type':'application/json'}, body:JSON.stringify(payload)});
  return mw.onRequest({request, env:{DB:{}}, next:()=>tool.onRequestPost({request, env:{}})});
};
r = await callTool({ action:'drive_request', token:'AT2', path:'/drive/v3/files?pageSize=5' });
d = await r.json();
assert.equal(d.success, true);
assert.equal(d.result.files[0].name, 'laporan.txt');
assert.equal(r.headers.get('access-control-allow-origin'), 'https://app.clincoo.buzz');

r = await callTool({ action:'drive_request', token:'WRONG', path:'/drive/v3/files?pageSize=5' });
d = await r.json();
assert.equal(d.success, false);
assert.match(d.error, /401/);

r = await callTool({ action:'drive_request', token:'AT2', path:'/gmail/v1/users/x/messages' });
assert.equal(r.status, 400);

r = await callTool({ action:'drive_request', path:'/drive/v3/about' });
d = await r.json();
assert.match(d.error, /belum terhubung/i);
globalThis.fetch = realFetch;
console.log('PASS: Drive OAuth exchange, refresh, proxy drive_request, CORS, and scope guard');
