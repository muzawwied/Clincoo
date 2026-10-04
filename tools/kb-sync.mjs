// Regenerasi snapshot basis pengetahuan Clincoo dari dokumentasi resmi (docs.clincoo.buzz).
// Jalankan di lokal / CI (Node 18+):  node kb-sync.mjs
// Hasil: functions/api/blog-kb-data.js — commit & deploy (jangan commit file ini ke situs).
import { writeFileSync } from 'node:fs';

const BLOG = 'https://docs.clincoo.buzz';

async function fetchWithTimeout(url, ms = 10000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { const r = await fetch(url, { signal: ctrl.signal }); return await r.text(); }
  finally { clearTimeout(t); }
}

function stripHtml(h) {
  h = String(h || '').replace(/<[^>]+>/g, ' ');
  const ents = { '&nbsp;':' ', '&amp;':'&', '&lt;':'<', '&gt;':'>', '&quot;':'"', '&#39;':"'", '&#x27;':"'", '&mdash;':'-', '&ndash;':'-', '&hellip;':'...' };
  h = h.replace(/&nbsp;|&amp;|&lt;|&gt;|&quot;|&#39;|&#x27;|&mdash;|&ndash;|&hellip;/g, m => ents[m]);
  return h.replace(/\s+/g, ' ').trim();
}

// ambil daftar file data dari loader.js (dukung format lama: var files=[], dan baru: src='data_clincoo.js?v=N')
const loaderCode = await fetchWithTimeout(BLOG + '/loader.js');
let files = [];
const m = loaderCode.match(/var files\s*=\s*(\[[^\]]*\])/);
if (m) files = JSON.parse(m[1]);
for (const mm of loaderCode.matchAll(/['"]([^'"\s]*data_[a-z]+\.js[^'"\s]*)['"]/g)) {
  const f = mm[1].split('?')[0];
  if (!files.includes(f)) files.push(f);
}
if (!files.length) files = ['data_clincoo.js'];
console.log('file data blog:', files.length);

// fetch paralel + parse (di Node, new Function aman dipakai)
const codes = await Promise.all(files.map(f => fetchWithTimeout(BLOG + '/' + f).catch(() => null)));
const merged = {};
for (const code of codes) {
  if (!code) continue;
  let res; try { res = new Function('window', code + '\n;return window.countryDataFiles;')({}); } catch { continue; }
  for (const [id, cat] of Object.entries(res || {})) {
    if (!merged[id]) merged[id] = { names: cat.names, articles: [] };
    merged[id].articles.push(...(cat.articles || []));
  }
}

const arts = [];
for (const [cid, cat] of Object.entries(merged)) {
  const cn = (cat.names && (cat.names.id || cat.names.en)) || cid;
  for (const a of cat.articles) {
    const ld = (a.langs && (a.langs.id || a.langs.en)) || {};
    arts.push({ i: a.id, c: cid, cn, t: ld.title || '', d: ld.desc || '', x: stripHtml(ld.content) });
  }
}
const now = new Date(Date.now() + 7 * 3600e3).toISOString().replace('T', ' ').slice(0, 16) + ' WIB';
const js = '// SNAPSHOT basis pengetahuan Clincoo — digenerate otomatis dari docs.clincoo.buzz\n'
  + `// Dibuat: ${now} | ${arts.length} artikel | JANGAN edit manual — regenerasi via tools/kb-sync.mjs.\n`
  + 'export const KB_ARTICLES = ' + JSON.stringify(arts) + ';\n';
writeFileSync('functions/api/blog-kb-data.js', js);
console.log('OK:', arts.length, 'artikel ->', 'functions/api/blog-kb-data.js');
