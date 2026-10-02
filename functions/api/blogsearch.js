// Cloudflare Pages Function module — pencarian pengetahuan resmi Clincoo
// (dipakai tool server search_clinqoo_kb di chat.js).
// Sumber: snapshot artikel blog resmi blog.clincoo.buzz (blog-kb-data.js),
// digenerate otomatis oleh tools/kb-sync.mjs. Snapshot dipakai karena runtime
// Workers TIDAK mengizinkan eval/new Function (tanpa flag eval_and_new_function),
// jadi file data_*.js milik blog tidak bisa diparse langsung saat runtime.
// Update snapshot: jalankan `node tools/kb-sync.mjs` lalu commit hasilnya.

import { KB_ARTICLES } from './blog-kb-data.js';
import { PAYMENT_KB } from './payment-kb-data.js';

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

// Ekspor utama: dipanggil dari chat.js (tool server search_clinqoo_kb)
export async function searchClincooBlog(env, query) {
  const q = String(query || '').trim();
  if (!q) return { error: 'Query pencarian kosong.' };

  const tokens = tokenize(q);
  if (!tokens.length) return { error: 'Query pencarian kosong.' };

  const qLower = q.toLowerCase();
  // --- KB PAYMENT GATEWAY (docs internal, bukan artikel blog) ---
  const payDocs = PAYMENT_KB.filter(k => {
    const hay = (k.gateway + ' ' + k.summary + ' ' + (k.keywords || []).join(' ') + ' ' + k.doc).toLowerCase();
    let sc = 0;
    for (const t of tokens) if (hay.includes(t)) sc += 2;
    for (const w of (k.keywords || [])) if (qLower.includes(w)) sc += 10;
    return sc >= 10;
  });
  const scored = KB_ARTICLES.map(art => {
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
    return { found: false, message: 'Tidak ada artikel resmi Clincoo yang cocok dengan pertanyaan ini di basis pengetahuan (snapshot blog resmi blog.clincoo.buzz). Jangan mengarang jawaban — sampaikan jujur ke user bahwa infonya belum tersedia di sumber resmi, dan sarankan memeriksa blog.clincoo.buzz atau bertanya ke admin.' };
  }

  const results = top.map(({ art }) => ({
    judul: art.t,
    kategori: art.cn,
    url: 'https://blog.clincoo.buzz/#/' + art.c + '/' + art.i,
    ringkasan: art.d,
    kutipan_relevan: excerptAround(art.x || '', tokens)
  }));
  // docs payment gateway selalu ditampilkan paling atas bila relevan
  for (const k of payDocs) {
    results.unshift({
      judul: 'Dokumentasi Internal: Integrasi ' + k.gateway,
      kategori: 'Payment Gateway',
      url: '',
      ringkasan: k.summary,
      kutipan_relevan: k.doc.slice(0, 2000)
    });
  }
  if (results.length) return { found: true, results };
}
