// SEMENTARA — uji konektor Jina & E2B di preview. Dihapus sebelum merge ke main.
import { jinaRead, e2bRunCode } from './api/_ai-connectors.js';

export async function onRequestGet({ request, env }) {
  const k = new URL(request.url).searchParams.get('k');
  if (k !== '54ed8c3cad8ddbc9') return new Response('no', { status: 404 });
  const out = {};
  const j = await jinaRead(env, 'https://example.com', { max: 500 });
  out.jina = { ok: j.ok, error: j.error || null, head: (j.content || '').slice(0, 160) };
  const x = await e2bRunCode(env, 'print("halo dari e2b"); print(6*7)', { max: 500 });
  out.e2b = { ok: x.ok, error: x.error || null, stdout: x.stdout || null, stderr: x.stderr || null, exit: x.exit || null, ms: x.ms || null };
  return new Response(JSON.stringify(out), { headers: { 'Content-Type': 'application/json' } });
}
