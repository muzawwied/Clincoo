// Cloudflare Pages Function — /api/super-agent
// Backend-only Super Agent facade. Frontend is intentionally untouched.
// Reuses the existing /api/agent durable engine so auth, quota, retries,
// persistence and Cloudflare Worker/Workflow execution stay in one place.

import { onRequestPost as agentPost, onRequestGet as agentGet } from './agent.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...CORS } });
}

function withCors(response) {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(CORS)) headers.set(k, v);
  return new Response(response.body, { status: response.status, headers });
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

function buildSuperGoal(goal) {
  return [
    'SUPER_AGENT_V2 = TRUE',
    'MODE: autonomous multi-role orchestration',
    '',
    'TUJUAN UTAMA PENGGUNA:', goal,
    '',
    'WAJIB BUAT DAN JALANKAN TEPAT 5 FASE BERURUTAN:',
    '1) STRATEGIST — definisikan outcome, constraint, acceptance criteria, risiko, dan execution plan.',
    '2) RESEARCHER — kumpulkan fakta, dependency, opsi, dan bukti yang relevan. Jangan mengarang sumber atau fakta.',
    '3) BUILDER — ubah hasil riset menjadi deliverable konkret. Untuk software: arsitektur, struktur file, konfigurasi, dan implementasi lengkap yang diperlukan.',
    '4) REVIEWER — uji deliverable terhadap acceptance criteria; cari bug, security issue, edge case, konflik, dan kekurangan; lakukan revisi konkret.',
    '5) FINALIZER — integrasikan hasil yang telah direview menjadi output final yang koheren dan siap digunakan.',
    '',
    'KONTRAK FASE:',
    '- Fase berikutnya WAJIB menggunakan hasil fase sebelumnya.',
    '- Jangan mengulang pekerjaan tanpa alasan; lanjutkan dari artefak terakhir.',
    '- Jika pendekatan gagal, gunakan alternatif yang masuk akal dan catat keterbatasannya.',
    '- Jangan mengklaim file dibuat, deploy dilakukan, API dipanggil, atau tindakan eksternal berhasil jika backend belum melakukannya.',
    '- Jangan mengarang tool, sumber, output tool, kredensial, atau status sistem.',
    '- Semua artefak penting harus ditulis lengkap di output fase agar dapat dipakai fase berikutnya.',
    '- Finalizer wajib membedakan: SELESAI, BELUM DILAKUKAN, dan PERLU VERIFIKASI.',
    '',
    'KETERBATASAN WORKSPACE:',
    'Backend Super Agent tidak mengklaim memiliki akses langsung ke browser/editor user. Jika tindakan hanya tersedia melalui tool frontend/client, hasilkan artefak atau instruksi eksekusi paling konkret dan nyatakan tindakan tersebut masih menunggu tool client.',
    '',
    'Jalankan seluruh pipeline secara autonomous tanpa meminta user memberi instruksi di antara fase.'
  ].join('\n');
}

export async function onRequestPost({ env, request }) {
  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Body JSON tidak valid' }, 400); }

  const action = body?.action || 'start';

  if (action === 'start') {
    const goal = String(body.goal || '').trim();
    if (goal.length < 3) return json({ error: 'Tulis tujuan tugas (minimal 3 karakter).' }, 400);
    if (goal.length > 12000) return json({ error: 'Tujuan terlalu panjang (maksimal 12.000 karakter).' }, 400);

    const forwarded = new Request(request.url.replace('/api/super-agent', '/api/agent'), {
      method: 'POST',
      headers: request.headers,
      body: JSON.stringify({
        action: body.background === false ? 'start' : 'start_bg',
        goal: buildSuperGoal(goal),
        project_id: body.project_id || undefined,
        budget_seconds: body.budget_seconds || undefined,
        wa_number: body.wa_number || undefined
      })
    });
    return withCors(await agentPost({ env, request: forwarded }));
  }

  if (action === 'resume' || action === 'status') return withCors(await agentPost({ env, request }));
  return json({ error: 'action harus start, resume, atau status' }, 400);
}

export async function onRequestGet({ env, request }) {
  return withCors(await agentGet({ env, request }));
}
