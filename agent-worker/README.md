# Clincoo Agent Worker — Cloudflare Workflows

Worker terpisah yang menjalankan tugas Agent Mode Clincoo **durable di latar belakang** (bukan tergantung request HTTP yang bisa putus).

## Apa yang dilakukan
- Task dengan status `queued` di tabel `agent_tasks` (D1 bersama app) dijemput **cron tiap menit**, lalu dijalankan sebagai instance **Cloudflare Workflow**.
- Tiap langkah adalah *step* durable: kena error/rate-limit → **auto-retry**, instance mati → cron sweep (task `running` tanpa kabar >15 menit) → **resume dari langkah terakhir** (idempotent).
- Progres mid-task: ditulis ke `agent_events` (dibaca `GET /api/agent?task_id=`) dan **dikirim ke WhatsApp** jika task punya `wa_number`.
- Task `running` lama tanpa kabar otomatis di-antrekan ulang.

## Cara mulai tugas
1. **Dari app Clincoo** — `POST /api/agent { action: 'start_bg', goal, project_id?, wa_number? }` → langsung balik dengan `task_id`.
2. **Dari WhatsApp** — kirim `tugas: <tujuan>` ke nomor WA Clincoo → progres dikirim balik ke nomor itu tiap langkah. `status` untuk cek.

## Env (di D1 `env_vars` — sama dengan app, tidak perlu setup ulang)
- `OPENROUTER_API_KEY`, `GEMINI_API_KEY` — fallback provider AI.
- `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID` — kirim progres WA (opsional).
- `AGENT_WORKER_TOKEN` — guard endpoint manual `POST /run {task_id}` (opsional; tanpa ini endpoint tetap menuntut task_id valid).

## Endpoint manual
- `GET /` — health check.
- `POST /run {task_id}` — dispatch task `queued` sekarang tanpa nunggu cron.

## Deploy
Otomatis via GitHub Actions (job `deploy-agent-worker`) setiap push ke `main`. Manual:
`cd agent-worker && wrangler deploy`
