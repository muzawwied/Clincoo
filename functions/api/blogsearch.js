// Cloudflare Pages Function module — pencarian pengetahuan resmi Clincoo
// (dipakai tool server search_clincoo_kb di chat.js).
// Sumber UTAMA (real-time): file data_*.js di dokumentasi resmi docs.clincoo.buzz,
// diambil langsung saat pencarian dan diparse dengan scanner JSON (tanpa eval/new
// Function, aman untuk runtime Workers), lalu di-cache 5 menit per isolate.
// Snapshot (blog-kb-data.js, digenerate tools/kb-sync.mjs) dipakai hanya sebagai
// FALLBACK kalau pengambilan live gagal. Jadi setiap artikel baru di docs langsung
// diketahui AI tanpa perlu regenerasi snapshot.

import { KB_ARTICLES } from './blog-kb-data.js';
import { PAYMENT_KB } from './payment-kb-data.js';
import { INTEGRATION_KB } from './integration-kb-data.js';

function tokenize(q) {
  return String(q || '')
    .toLowerCase()
    .split(/[^a-z0-9\u00C0-\u024F]+/i)
    .filter(t => t.length >= 2);
}

function excerptAround(text, tokens, radius) {
  radius = radius || 160;
  const lower = text.toLowerCase();
  let pos = -1;
  for (const t of tokens) {
    const idx = lower.indexOf(t);
    if (idx !== -1 && (pos === -1 || idx < pos)) pos = idx;
  }
  if (pos === -1) return text.slice(0, radius * 2);
  const start = Math.max(0, pos - radius);
  const end = Math.min(text.length, pos + radius);
  return (start > 0 ? '…' : '') + text.slice(start, end).trim() + (end < text.length ? '…' : '');
}

// ===== LAPISAN REAL-TIME: ambil artikel langsung dari docs.clincoo.buzz =====
const DOCS_BASE = 'https://docs.clincoo.buzz';
const LIVE_TTL_MS = 5 * 60 * 1000;
let liveCache = { at: 0, arts: null };

function stripHtml(h) {
  h = String(h || '').replace(/<[^>]+>/g, ' ');
  const ents = { '&nbsp;':' ', '&amp;':'&', '&lt;':'<', '&gt;':'>', '&quot;':'"', '&#39;':"'", '&#x27;':"'", '&mdash;':'-', '&ndash;':'-', '&hellip;':'...' };
  h = h.replace(/&nbsp;|&amp;|&lt;|&gt;|&quot;|&#39;|&#x27;|&mdash;|&ndash;|&hellip;/g, m => ents[m]);
  return h.replace(/\s+/g, ' ').trim();
}

// Scanner JSON sadar-string: ambil semua objek hasil assignment
// window.countryDataFiles["x"] = { ... }; tanpa eval — aman di Workers.
function extractJsonObjects(code) {
  const out = [];
  const re = /window\.countryDataFiles\["([a-z0-9_]+)"\]\s*=\s*/g;
  let m;
  while ((m = re.exec(code))) {
    let i = m.index + m[0].length;
    if (code[i] !== '{') continue;
    let depth = 0, inStr = false, esc = false;
    const start = i;
    for (; i < code.length; i++) {
      const ch = code[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          try { out.push({ cid: m[1], obj: JSON.parse(code.slice(start, i + 1)) }); } catch (e) {}
          break;
        }
      }
    }
  }
  return out;
}

async function fetchText(url, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms || 8000);
  try {
    const r = await fetch(url, { signal: ctrl.signal, cf: { cacheTtl: 300 } });
    if (!r.ok) return null;
    return await r.text();
  } finally { clearTimeout(t); }
}

async function fetchLiveArticles() {
  // daftar file data diikuti dari loader.js; kalau gagal pakai daftar tetap
  let files = null;
  const loader = await fetchText(DOCS_BASE + '/loader.js');
  if (loader) files = [...loader.matchAll(/['"]([^'"\s]*data_[a-z]+\.js[^'"\s]*)['"]/g)].map(mm => mm[1].split('?')[0]);
  if (!files || !files.length) files = ['data_clincoo.js','data_aria.js','data_console.js','data_dialog.js','data_form.js','data_keyboard.js','data_prompt.js','data_seo.js','data_semantic.js'];
  const arts = [];
  await Promise.all(files.map(async (f) => {
    const code = await fetchText(DOCS_BASE + '/' + f);
    if (!code) return;
    for (const { cid, obj } of extractJsonObjects(code)) {
      const cn = (obj.names && (obj.names.id || obj.names.en)) || cid;
      for (const a of (obj.articles || [])) {
        const ld = (a.langs && (a.langs.id || a.langs.en)) || {};
        if (!ld.title) continue;
        arts.push({ i: a.id, c: cid, cn, t: ld.title, d: ld.desc || '', x: stripHtml(ld.content) });
      }
    }
  }));
  return arts;
}

async function getKbArticles() {
  const now = Date.now();
  if (liveCache.arts && now - liveCache.at < LIVE_TTL_MS) return { arts: liveCache.arts, live: true };
  try {
    const arts = await fetchLiveArticles();
    if (arts.length >= KB_ARTICLES.length) {
      liveCache = { at: now, arts };
      return { arts, live: true };
    }
  } catch (e) {}
  return { arts: KB_ARTICLES, live: false };
}

// Ekspor utama: dipanggil dari chat.js (tool server search_clincoo_kb)
export async function searchClincooBlog(env, query) {
  const q = String(query || '').trim();
  if (!q) return { error: 'Query pencarian kosong.' };

  const tokens = tokenize(q);
  if (!tokens.length) return { error: 'Query pencarian kosong.' };

  const qLower = q.toLowerCase();
  // --- KB INTEGRASI (Integrasi AI, Email, Server MCP — docs internal) ---
  const intDocs = INTEGRATION_KB.filter(k => {
    const hay = (k.topic + ' ' + k.summary + ' ' + (k.keywords || []).join(' ') + ' ' + k.doc).toLowerCase();
    let sc = 0;
    for (const t of tokens) if (hay.includes(t)) sc += 2;
    for (const w of (k.keywords || [])) if (qLower.includes(w)) sc += 10;
    return sc >= 10;
  });
  // --- KB PAYMENT GATEWAY (docs internal, bukan artikel blog) ---
  const payDocs = PAYMENT_KB.filter(k => {
    const hay = (k.gateway + ' ' + k.summary + ' ' + (k.keywords || []).join(' ') + ' ' + k.doc).toLowerCase();
    let sc = 0;
    for (const t of tokens) if (hay.includes(t)) sc += 2;
    for (const w of (k.keywords || [])) if (qLower.includes(w)) sc += 10;
    return sc >= 10;
  });
  const { arts: KB_SOURCE, live } = await getKbArticles();
  const scored = KB_SOURCE.map(art => {
    const titleLower = (art.t || '').toLowerCase();
    const descLower = (art.d || '').toLowerCase();
    const hay = (titleLower + ' ' + descLower + ' ' + (art.x || '')).toLowerCase();
    let score = 0;
    for (const t of tokens) {
      if (titleLower.includes(t)) score += 5;
      if (descLower.includes(t)) score += 3;
      if (hay.includes(t)) score += 1;
    }
    if (titleLower.includes(qLower)) score += 8;
    return { art, score };
  }).filter(x => x.score > 0);

  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, 4);

  if (!top.length) {
    return { found: false, live, message: 'Tidak ada artikel resmi Clincoo yang cocok dengan pertanyaan ini di basis pengetahuan (dokumentasi resmi docs.clincoo.buzz). Jangan mengarang jawaban — sampaikan jujur ke user bahwa infonya belum tersedia di sumber resmi, dan sarankan memeriksa docs.clincoo.buzz atau bertanya ke admin.' };
  }

  const results = top.map(({ art }) => ({
    judul: art.t,
    kategori: art.cn,
    url: 'https://docs.clincoo.buzz/' + art.c + '/' + art.i + '/',
    ringkasan: art.d,
    kutipan_relevan: excerptAround(art.x || '', tokens)
  }));
  // docs payment gateway selalu ditampilkan paling atas bila relevan
  // (urutan tampil = urutan array PAYMENT_KB — ClincooPay duluan; unshift dibalik)
  for (const k of payDocs.slice().reverse()) {
    results.unshift({
      judul: 'Dokumentasi Internal: Integrasi ' + k.gateway,
      kategori: 'Payment Gateway',
      url: '',
      ringkasan: k.summary,
      kutipan_relevan: k.doc.slice(0, 2000)
    });
  }
  // docs integrasi (AI/email/MCP) ditampilkan paling atas bila relevan
  for (const k of intDocs.slice().reverse()) {
    results.unshift({
      judul: 'Dokumentasi Internal: ' + k.topic,
      kategori: 'Integrasi Clincoo',
      url: '',
      ringkasan: k.summary,
      kutipan_relevan: k.doc.slice(0, 2000)
    });
  }
  if (results.length) return { found: true, live, results };
}
