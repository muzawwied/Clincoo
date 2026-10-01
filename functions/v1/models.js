// Cloudflare Pages Function — /v1/models "Clinqoo Open API"
// Daftar model yang tersedia di /v1/chat/completions (gaya OpenAI).
// Jalur publik (tanpa auth) — hanya daftar nama model, tidak ada data sensitif.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

const MODELS = [
  { id: 'clinqoo/auto', note: 'Rantai otomatis: pilih model tercepat yang tersedia' },
  { id: 'clinqoo/glm-5.2', note: 'Workers AI — flagship, reasoning & kode' },
  { id: 'clinqoo/deepseek-v4-flash', note: 'Workers AI — cepat, konteks besar' },
  { id: 'clinqoo/glm-4.7-flash', note: 'Workers AI — multilingual' },
  { id: 'clinqoo/nemotron-super', note: 'OpenRouter — model gratis' },
  { id: 'clinqoo/nemotron-lightning', note: 'OpenRouter — model gratis' },
  { id: 'clinqoo/gemini-flash', note: 'Gemini — cadangan' }
];

export async function onRequestOptions() {
  return new Response(null, { status: 200, headers: CORS });
}

export async function onRequestGet() {
  return new Response(JSON.stringify({
    object: 'list',
    data: MODELS.map(m => ({ id: m.id, object: 'model', created: 0, owned_by: 'clinqoo', note: m.note }))
  }), { headers: { 'Content-Type': 'application/json', ...CORS } });
}
