// PENGETAHUAN INTEGRASI CLINQOO — disuntik langsung ke AI Clincoo.
// Dipakai blogsearch.js (tool search_clinqoo_kb) dan bisa disuntik otomatis
// oleh chat.js saat user bicara soal integrasi. Sumber: kode nyata platform
// (functions/api/email, functions/v1, functions/api/mcp). Ringkas & padat —
// hanya fakta yang stabil.

export const INTEGRATION_KB = [
  {
    id: 'integrasi-ai-open-api',
    topic: 'Integrasi AI (Clincoo Open API)',
    keywords: ['integrasi ai', 'open api', 'chat/completions', 'api ai', 'secret ai', 'v1/models', 'sdk openai'],
    summary: 'Clincoo Open API: endpoint chat AI OpenAI-compatible per proyek — /v1/chat/completions + secret per proyek.',
    doc: `CLINQOO OPEN API — API AI per proyek (kompatibel format OpenAI):
- BASE URL: https://app.clincoo.buzz/v1 — endpoint: POST /v1/chat/completions (chat), GET /v1/models (daftar model).
- AUTENTIKASI: header "Authorization: Bearer <SECRET>" — secret per proyek, BUKAN key provider (Clincoo yang mengelola & menagih kredit). User TIDAK membawa key sendiri.
- KELOLA SECRET (Pengaturan > Integrasi AI, perlu login Clincoo): GET /api/ai/v1/secret?project_id=<id> (lihat status + secret), POST /api/ai/v1/secret {project_id} (buat/ganti), DELETE ?project_id=<id> (cabut).
- BODY /v1/chat/completions (OpenAI-compatible): {"model": "<model>", "messages": [{"role":"system","content":"..."},{"role":"user","content":"..."}], "temperature": 0.7}. Respons format choices[0].message.content seperti OpenAI.
- KOMPATIBEL SDK OpenAI: client = new OpenAI({ baseURL: "https://app.clincoo.buzz/v1", apiKey: "<SECRET>" }) — tanpa perubahan kode lain. Contoh curl:
  curl https://app.clincoo.buzz/v1/chat/completions -H "Authorization: Bearer <SECRET>" -H "Content-Type: application/json" -d '{"model":"<model>","messages":[{"role":"user","content":"Halo"}]}'
- DIPAKAI UNTUK: situs deploy yang butuh chat AI, backend function, automation — kuota/kredit dipantau di halaman Integrasi AI (log & analitik pemakaian per proyek: /api/ai/v1/logs?project_id=<id>, perlu login).
- Pastikan secret TIDAK dicetak/dibagikan di jawaban chat; sarankan user menyimpannya sebagai env var proyek (Pengaturan > Environment Variables).`
  },
  {
    id: 'integrasi-email',
    topic: 'Email',
    keywords: ['email', 'integrasi email', 'kirim email', 'api key email', 'form kontak', 'smtp'],
    summary: 'Integrasi Email Clincoo: kirim email dari situs deploy via /api/email dengan API key per proyek (tanpa SMTP).',
    doc: `EMAIL CLINQOO — kirim email dari situs deploy (endpoint: https://app.clincoo.buzz/api/email):
- AKTIVASI (Pengaturan > Email, perlu login Clincoo): POST /api/email body {"action":"activate","project_id":"<id>"} -> terbitkan API key per proyek. Pengaturan pengirim: {"action":"sender","project_id","from_name","sender_email","contact_to"} (kosongkan = default noreply@clincoo.buzz). Ganti key: action "regenerate"; matikan: action "revoke".
- KIRIM DARI SITUS DEPLOY (TANPA login — publik, kuota bulanan per proyek): POST https://app.clincoo.buzz/api/email body {"action":"send","api_key":"<API KEY>","to":"alamat@email.com","subject":"Judul","html":"<p>Isi pesan</p>","reply_to":"opsional"} -> {"sent":true} atau {"sent":false,"reason":"..."} (sampaikan reason apa adanya). to/subject/html wajib. Header Authorization: Bearer <API KEY> juga diterima sebagai pengganti field api_key.
- CONTOH FORM KONTAK DI SITUS: fetch('https://app.clincoo.buzz/api/email', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({action:'send', api_key:'<KEY>', to:'email@tujuan.com', subject:'Pesan dari ' + name, html:'<p>'+pesan+'</p><p>Dari: '+email+'</p>'})});
- HISTORY & TEST (perlu login): GET /api/email?action=history&project_id=... , test kirim {"action":"test","project_id","to","subject","html"}. Kuota bulanan dibatasi — cek config: GET /api/email?action=config&project_id=....
- API key aman untuk frontend (bisa disimpan di localStorage situs), tapi beri tahu user bahwa key bisa dikirim ulang dari Pengaturan > Email bila bocor.`
  },
  {
    id: 'integrasi-mcp-server',
    topic: 'Server MCP',
    keywords: ['mcp', 'server mcp', 'integrasi mcp', 'model context protocol', 'ai luar', 'cursor', 'claude', 'tools/call'],
    summary: 'Server MCP Clincoo: AI luar mengakses workspace proyek real-time via /api/mcp — token per proyek + izin read/write/delete.',
    doc: `SERVER MCP CLINQOO — akses workspace proyek oleh AI luar (Claude, ChatGPT, Cursor, dsb):
- AKTIVASI (Pengaturan > Server MCP, perlu login Clincoo): aktifkan -> terbitkan token MCP per proyek + atur izin: read (lihat file), write (buat/ubah file & folder), delete (hapus). Token bisa dibuat ulang (rotate) & akses diputus kapan pun. State tersimpan per proyek.
- ENDPOINT (publik, tanpa login Clincoo): https://app.clincoo.buzz/api/mcp?project_id=<ID PROYEK>. Protokol: Streamable HTTP — POST JSON-RPC 2.0 per pesan, respons application/json.
- AUTENTIKASI: header "Authorization: Bearer <TOKEN MCP>" atau query ?token=<TOKEN>.
- METHOD JSON-RPC: initialize (handshake; kirim param protocolVersion "2025-06-18" atau "2024-11-05" -> server balas protocolVersion, capabilities, serverInfo), notifications/initialized (202 tanpa body), ping, tools/list, tools/call {"name":"<tool>","arguments":{...}}.
- TOOL (mengikuti izin token; tools/list menandai [izin: X; aktif: ya/tidak]):
  list_items {path?} [read] — daftar file/folder workspace (opsi prefix folder).
  read_file {path} [read] — isi satu file.
  search_items {query} [read] — cari nama/isi file (maks 30).
  write_file {path, content} [write] — buat/timpa file.
  write_files {files:[{path,content}]} [write] — banyak sekaligus (maks 60).
  create_folder {path} [write] — buat folder.
  rename_item {path, new_name} [write] — ganti nama file/folder.
  delete_item {path} [delete] — hapus file/folder.
- PERUBAHAN LANGSUNG tersimpan di workspace proyek Clincoo (real-time, cloud) — user melihatnya di editor Clincoo. Sarankan izin read-only dulu, tulis/delete setelah yakin.
- CONTOH tools/call:
  POST /api/mcp?project_id=<id> header Authorization: Bearer <TOKEN>
  body: {"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"read_file","arguments":{"path":"index.html"}}}
  respons: {"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"<isi file>"}]}}
- Bila token invalid / izin tidak aktif: sampaikan pesan error server apa adanya; solusinya di UI Pengaturan > Server MCP (aktifkan izin / buat ulang token).`
  }
];

// Fuzzy kecil dipakai chat.js (opsional) — kembalikan entri yang relevan.
export function integrationKbFor(text) {
  const t = String(text || '').toLowerCase();
  const hits = INTEGRATION_KB.filter(k => (k.keywords || []).some(w => t.includes(w)));
  if (!hits.length) return '';
  return '=== PENGETAHUAN INTEGRASI CLINQOO (suntikan otomatis — anggap ini sumber resmi) ===\n' +
    hits.map(h => `[${h.topic} — ${h.summary}]\n${h.doc}`).join('\n\n') +
    '\n=== AKHIR PENGETAHUAN INTEGRASI CLINQOO ===';
}
