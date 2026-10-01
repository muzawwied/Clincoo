// Cloudflare Pages Function — /v1/models "Clincoo Open API"
// Daftar model yang tersedia di /v1/chat/completions (gaya OpenAI).
// Jalur publik (tanpa auth) — nama provider TIDAK diumumkan (white-label Clincoo).

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

const MODELS = [
  { id: 'clincoo/auto', note: 'Rantai otomatis: pilih model tercepat yang tersedia' },
  { id: 'clincoo/glm-5.2', note: 'Flagship — reasoning & kode' },
  { id: 'clincoo/deepseek-v4-flash', note: 'Cepat — konteks besar' },
  { id: 'clincoo/glm-4.7-flash', note: 'Multilingual — ramah Bahasa Indonesia' },
  { id: 'clincoo/reasoning-120b', note: 'Model besar — reasoning umum' },
  { id: 'clincoo/reasoning-550b', note: 'Model terbesar — konteks 1M token' },
  { id: 'clincoo/lightning', note: 'Ringan & cepat — konteks 1M token' },
  { id: 'clincoo/omni-nano', note: 'Multimodal — teks, gambar, audio' },
  { id: 'clincoo/vision-31b', note: 'Serba guna — teks & gambar' },
  { id: 'clincoo/vision-26b', note: 'Ringan — teks & gambar' },
  { id: 'clincoo/multimodal-27b', note: 'Multimodal — teks, gambar, video' },
  { id: 'clincoo/reasoning-mini', note: 'Reasoning — riset & analisis panjang' },
  { id: 'clincoo/ling-flash', note: 'Cepat & ringan' },
  { id: 'clincoo/dots-note', note: 'Multimodal — teks & gambar' },
  { id: 'clincoo/lfm-mini', note: 'Mini — super ringan & cepat' },
  { id: 'clincoo/inkling', note: 'Multimodal — teks, gambar, audio' },
  { id: 'clincoo/inkling-small', note: 'Multimodal ringan' },
  { id: 'clincoo/laguna-s', note: 'Serba guna' },
  { id: 'clincoo/laguna-xs', note: 'Mini — super ringan' },
  { id: 'clincoo/north-code', note: 'Fokus kode' },
  { id: 'clincoo/space-bunny', note: 'Eksperimental — multimodal, konteks besar' },
  { id: 'clincoo/acak', note: 'Pilih otomatis dari jaringan mitra gratis' }
];

export async function onRequestOptions() {
  return new Response(null, { status: 200, headers: CORS });
}

export async function onRequestGet() {
  return new Response(JSON.stringify({
    object: 'list',
    data: MODELS.map(m => ({ id: m.id, object: 'model', created: 0, owned_by: 'clincoo', note: m.note }))
  }), { headers: { 'Content-Type': 'application/json', ...CORS } });
}
