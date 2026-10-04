# Clincoo Agent Wiki & Collaboration Board

Halaman ini berfungsi sebagai **wiki ringan** dan papan komunikasi antar agent (Grok, AI lain, human operator) yang bekerja di ekosistem Clincoo.

> **Aturan**: Setiap agent **wajib** membaca file ini di awal sesi dan meng-update status setelah bekerja.

---

## Cara Interaksi Antar Agent

1. **Baca** file ini dulu sebelum mulai kerja.
2. **Tulis** status / temuan / rekomendasi di bagian yang sesuai.
3. Gunakan format tanggal + nama agent.
4. Jika ada bug kritis, sebutkan file + fungsi + impact.
5. Setelah fix, centang item dan catat commit SHA jika memungkinkan.

### Channel lain yang tersedia
- GitHub Issues di repo `muzawwied/Clincoo.`
- Automation hourly audit (taskId: `d0562740-c5bd-4743-b98d-8c2d3dcf4077`)
- Email laporan: **muzawwied@gmail.com** (satu-satunya alamat resmi; gmaio.com adalah typo)
- MCP / Clincoo connector tools (list_repos, read_file, write_file, dll)
- Automation Report to AGENTS.md (taskId: `db0bb063-107c-4fb5-92be-fdb29e0e5ba6`)
- Automation Tingkatkan Kualitas AI Clincoo (setiap 60 menit WIB) — aktif `168d5135`; duplikat `850559af` di-pause

---

## Status Saat Ini (update terakhir: 2026-09-22 10:07 WIB)

**INSIDEN SELESAI (21 Sep ~10.05 WIB):** app.clincoo.buzz sempat dialihkan ke project `clincoo` (a393, D1 kosong 887e6ab6) sejak ~09.20 WIB → user tidak bisa login. Sudah dipulihkan: domain kembali ke project `clincoo` (akun Vylonium0, clincoo-be2.pages.dev, DB asli 49b6fed3). **JANGAN pasang domain app.clincoo.buzz ke project clincoo** dan JANGAN tambahkan D1 binding ke project clincoo. Job `deploy-production` di deploy.yml DIHAPUS (dialah yang men-deploy salinan app dengan D1 kosong 887e6ab6 ke project clincoo tiap push).

## ATURAN WAJIB: Deploy ke Cloudflare Pages project `clincoo` (clincoo.pages.dev)

Project `clincoo` (akun Vylonium a393, clincoo.pages.dev) **WAJIB di-deploy BERSAMA functions MCP**. Endpoint `/mcp` hidup dari `functions/mcp.js`.

**JANGAN deploy statis murni dari root repo** — gejala: POST /mcp → 405.

Prosedur benar (Superagent, terverifikasi 2026-09-17):
1. Build dari `origin/main`: `git archive origin/main | tar -x -C build-dir`
2. Hapus dari build-dir: `functions/api/`, `functions/scheduled.js`, `wrangler.toml`, `wrangler-proxy.toml`, `.github/`, `agent-worker/`, `docs/`, `landing/`, `legal/`, `mcp-server/`, `schema.sql`, `.gitignore`
3. Tempel `functions/mcp.js` (backup privat Superagent — berisi KUNCI, JANGAN commit publik)
4. Deploy: `wrangler pages deploy . --project-name clincoo` (token Vylonium a393). **PENTING (pelajaran 2026-09-21): jalankan dari folder terisolasi DI LUAR repo** — wrangler menemukan `wrangler.toml` repo lewat parent directory, lalu menulis ulang binding D1 basi (DB 49b6fed3 + WALLET_DB 59e17832 lintas akun) ke config project dan deploy gagal "database not found". Salin build-dir ke folder terpisah (mis. workspace root) sebelum deploy.
5. Jika error D1 binding: bersihkan binding basi via API — `PATCH /pages/projects/clincoo` dengan `deployment_configs.production.d1_databases = {"DB": null, "WALLET_DB": null}` (nilai `null` per-binding menghapus; `{}` atau config kosong TIDAK bisa). JANGAN tambah binding D1 ke project ini.
6. Verifikasi: `POST https://clincoo.pages.dev/mcp` harus JSON-RPC. Tanpa key → 401 Unauthorized (function hidup). Bukan 405/404.

**Email resmi tampilan web = `halo@clincoo.buzz`**. Backend notifikasi tetap ke muzawwied@gmail.com.

**Rebrand UI:** teks `Clincoo` / `ClincooPay`. JANGAN rename domain/URL `clincoo*`, nama repo, path `muzawwied.github.io/Clincoo./`, identifier kode. Pelajaran: `GH_REPO` sempat salah jadi Clincoo-Data — sync users-live mati sampai `100c2f50`.

---

| Area | Status | Catatan |
|------|--------|--------|
| Auth OAuth (`upsertOauthUser`) | OK — FIXED | emailNorm + INSERT + last_row_id. File `functions/api/auth/shared.js` blob `ebf23dd5`. Tidak disentuh. |
| OAuth redirect_uri | Bug | github.io path `/Clincoo./` 404 (benar `/Clincoo./`) di `auth/index.html`. Domain aktif: `location.origin + '/auth/'`. Daftarkan `https://app.clincoo.buzz/auth/` dan `https://clincoo.pages.dev/auth/`. |
| Probe Gemini tanpa auth (`kbdiag.js`) | TERATASI | Dihapus di `e4ec785`. |
| Probe admin Gemini | Sementara | `functions/api/diag-gemini.js` masih di HEAD — gate ADMIN_EMAILS / qa.*@clincoo.dev. Hapus setelah diagnosa. |
| Probe streaming (`streamtest.js`) | TERATASI | Dihapus di `9b8f4564`. |
| CORS / middleware | OK | ORIGIN_ALLOW sudah `*.clincoo.buzz`. |
| Deploy MCP | REGRESI — HTTP 405 | POST clincoo.pages.dev/mcp dan app.clincoo.buzz/mcp = 405 body kosong. Redeploy project clincoo BERSAMA functions/mcp.js. |
| CI deploy production | Dihapus | job `deploy-production` dihapus di `76792d3b`. CI tersisa: deploy project `clincoo` + agent-worker. |
| Rantai AI | Update | `834bad05` hapus OpenRouter; Gemini multi-kunci (KEY..KEY_6) utama, Workers AI cadangan. Pastikan secret KEY_4..6 di production. |
| Chat project info | Update | `12c90d80` tool `set_project_info` — AI isi app_name/app_desc. |
| User report | Update | Gate x-cron-secret (POST tanpa secret = 403). Sync Clincoo-Data `7672eb2f`. |
| Wallet / langganan / schema | PATCHED | e638daf: resolveOwner fail-closed; kredit in hanya callback/ClincooPay; clear/DELETE admin-only. |
| Sync users-live | OK — jalan | Clincoo-Data `7672eb2f` (~10:00 WIB). |
| Blog | Update | Clincoo-Blog `af15e0bc` artikel warna ~10:07 WIB. |
| Komunitas | Update UI | Clincoo-Komunitas `a93f3683` restore header (13:42 WIB). |
| Issue GitHub | OK | 0 open, 0 PR |
| Hourly audit | Laporan masuk | 10:07 WIB ke muzawwied@gmail.com — **bukan All clear** |
| Email transactional | Resend | cek RESEND_API_KEY |

Bukan All clear. HEAD Clincoo. docs audit ini / app `12c90d80`. `upsertOauthUser` tetap FIXED. Live MCP product 405. Bug terbuka lama: oauthRedirectUri github.io `/Clincoo./`; diag-gemini.js.

---

### 2026-09-22 10:07 WIB — Grok (xAI) hourly audit
- Scope: sejak 09:11 WIB (HEAD docs `ecac5e5a` / app `12c90d80`).
- Commit baru app: tidak ada.
- Live: app GET 200; auth 200; POST /mcp = 405; user-report-sync tanpa secret = 403; diag-gemini tanpa auth = 401.
- Related: Clincoo-Data `7672eb2f`; Clincoo-Blog `af15e0bc`; Komunitas tidak berubah.
- Email: `[Clincoo Hourly Audit] 2026-09-22 10:07 WIB` ke muzawwied@gmail.com.

### 2026-09-22 09:11 WIB — Grok (xAI) hourly audit
- Scope: sejak 08:34 WIB (HEAD docs `3800aff8` / app `12c90d80`).
- Commit baru app: tidak ada.
- Live: app GET 200; auth 200; POST /mcp = 405; user-report-sync tanpa secret = 403; diag-gemini tanpa auth = 401.
- Related: Clincoo-Data `aa0d86a1`; Clincoo-Blog `5ea37f00`; Komunitas tidak berubah.
- Email: `[Clincoo Hourly Audit] 2026-09-22 09:11 WIB` ke muzawwied@gmail.com.

Log lebih lama dipotong agar wiki ringan.

---

### 2026-09-21 08:20 WIB — Superagent (Base44): PATCH KEAMANAN dompet
- Fix (commit e638daf): resolveOwner fail-closed; kredit 'in' tanpa callback token WAJIB ClincooPay; clear/DELETE admin-only.

## Log Interaksi Agent
### 2026-10-02 04:5x WIB — Superagent (Base44): 6 perbaikan Clincoo (disetujui owner)
- `functions/api/security-events.js` BARU: endpoint yang hilang (akar error "Gagal memuat notifikasi keamanan"); `proyek/pengaturan/keamanan/index.html` kini pakai base URL dinamis + header Bearer. Live: `/api/security-events` balas 401 JSON, bukan 404 HTML.
- FIX "failed to fetch" pasca-deploy di `proyek/build-deployment/{config,dashboard}/index.html`: koneksi putus saat deploy panjang tidak lagi langsung dianggap gagal — halaman cek log sukses baru di status deploy; bila deploy ternyata sukses, user diarahkan ke dashboard link.
- Bagian "Domain kustom" + "Wajibkan HTTPS" dihapus dari `proyek/build-deployment/dashboard/index.html` (JS lama null-guarded, aman).
- `proyek/build-deployment/domain-kustom/index.html`: hidrasi instan — input tidak terkunci walau belum ada domain, URL default (subdomain publik) tampil instan dari cache/sesi deploy, `publicUrl` di-cache sehingga section DNS tidak menunggu API Cloudflare tiap buka.
- Tool AI baru `create_automation` (`functions/api/chat.js` + `proyek/chat/index.html`): AI bisa memasang tugas terjadwal (daily/interval) dari chat; `akun/tugas-terjadwal/index.html` refresh real-time (focus/visibility/storage/BroadcastChannel/poll 10 dtk).
- Commit `153a7ac` + follow-up `851409a` (fix config sempat hilang saat baseline pull, dipasang ulang); deploy GitHub Actions keduanya `success`. Verifikasi live: semua perubahan terkonfirmasi di app.clincoo.buzz (grep live masing-masing ketemu, "Domain kustom" 0 kemunculan).
### 2026-09-23 08:xx WIB — Superagent (Base44): audit ringan GitHub (read-only)
- `integrasi/index.html:584` menetapkan `WORKER_URL = ""`; token OAuth hanya disimpan sebagai `clincoo_gh_token` di localStorage origin saat itu (`:693`, `:729`). `proyek/chat/index.html:2992` membaca key yang sama tetapi hanya dari origin tempat chat dibuka. Pada dua host berbeda (`app.clincoo.buzz` vs `clincoo.pages.dev`), localStorage tidak dibagi; status terhubung di A tidak membuktikan token tersedia di B.
- `proyek/chat/index.html:2318` mengarahkan proxy ke `clincoo-be2.pages.dev`; `functions/api/ai-tools.js:173-182` membaca bearer Clincoo tetapi tidak memvalidasinya sebelum `github_request` memakai token dari body. Perlu audit keamanan/auth dan pengujian E2E dengan akun user sebelum mengklaim akar masalah pasti. Tidak ada perubahan kode GitHub kali ini.
### 2026-09-23 07:47 WIB — Superagent (Base44): penyegaran landing Clincoo
- Target hanya landing `clincoo.buzz` (Pages project `clincoo-landing` akun Vylonium0). Sumber deploy mandiri: `../deploy-landing2/index.html`, bukan project app `clincoo` atau `clincoo`.
- Header: nama/logo diperbesar, Masuk dipisah dari Daftar Gratis dengan CTA jelas; navigasi Harga. Bagian harga menampilkan Starter gratis, Pro Rp49.000/bulan, Bisnis Rp129.000/bulan, batas paket dari `functions/api/subscription.js` dan `akun/langganan/upgrade/index.html`; tautan paket menuju alur akun/upgrade.
- Salinan fitur/hero/langkah disesuaikan dengan editor Monaco, template, workspace, dan deploy dashboard; klaim AI membangun/mendeploy situs secara otonom dihapus. Harga promo tidak diklaim sebagai harga permanen.
- Deploy langsung Vylonium0 project `clincoo-landing`: `54dd1f07.clincoo-landing.pages.dev`. Stylesheet Tailwind dibangun ulang dan dilayani lokal dari `../deploy-landing2/tailwind.css` (stylesheet sebelumnya tidak memuat kelas baru, sempat membuat logo/header membengkak). Browser live `www.clincoo.buzz` kini menampilkan header rapi, Masuk/Daftar Gratis, dan ketiga kartu harga; CTA paket berbayar mengarah ke halaman upgrade lalu login bagi tamu.
### 2026-09-22 16:49 WIB — Superagent (Base44): Perbesar logo Plugin
- `integrasi/index.html`: logo GitHub pada daftar Plugin diperbesar dari 20px (`w-5 h-5`) menjadi 32px (`w-8 h-8`), tetap tanpa card pembungkus.
- Commit `5bc8494`; deploy GitHub Actions `success`. Terverifikasi live via browser: logo GitHub tampil 32px, lebih besar, dan tetap tanpa card pembungkus.
### 2026-09-22 16:43 WIB — Superagent (Base44): UI halaman Plugin
- `integrasi/index.html`: seluruh teks UI utama "Integrasi" diganti "Plugin" (title, heading, pencarian, empty state, pesan login).
- Card/dekorasi pembungkus logo konektor dihapus; logo GitHub kini tampil langsung tanpa background, border, radius, atau shadow.
- Commit `884fe96`; deploy GitHub Actions `success`. Terverifikasi live via browser di `https://app.clincoo.buzz/integrasi/`: heading dan pencarian memakai "Plugin", logo GitHub tampil langsung tanpa card pembungkus.
### 2026-09-22 16:31 WIB — Superagent (Base44): FIX konektor GitHub chat
- Temuan: badge Integrasi hanya mengecek keberadaan `clincoo_gh_token` di localStorage, bukan validitasnya; pertanyaan akses GitHub juga tidak membawa status konektor terverifikasi ke AI sehingga AI tetap bisa menjawab "tidak bisa" setelah reconnect.
- Fix: `integrasi/index.html` memvalidasi token ke GitHub `/user` sebelum badge hijau; `proyek/chat/index.html` melakukan health-check `/user` untuk pesan akses/cek/tes GitHub dan menyuntikkan hasil terverifikasi tanpa token ke prompt; `functions/api/chat.js` membedakan pertanyaan kapabilitas abstrak dari permintaan verifikasi nyata.
- Fix app commit `3647f43`; GitHub Actions selesai `success`. Verifikasi live browser: `https://app.clincoo.buzz/integrasi/` HTTP 200 dan halaman Integrasi termuat normal; source live memuat health-check token dan preflight chat baru.
### 2026-09-22 10:07 WIB — Grok (xAI) hourly audit
- Status: **bukan All clear**. HEAD app `12c90d80`. upsertOauthUser TETAP FIXED (blob ebf23dd5).
- MCP 405 masih. Sync Clincoo-Data `7672eb2f`. Blog `af15e0bc`.

### 2026-09-22 09:11 WIB — Grok (xAI) hourly audit
- Status: **bukan All clear**. HEAD app `12c90d80`. upsertOauthUser TETAP FIXED (blob ebf23dd5).
- MCP 405 masih. Sync Clincoo-Data `aa0d86a1`. Blog `5ea37f00`.

Log lebih lama dipotong agar wiki ringan.

---

## Rekomendasi untuk Agent Berikutnya

1. **PRIORITAS:** Redeploy Pages project `clincoo` BERSAMA `functions/mcp.js` dari folder terisolasi. Verifikasi POST `/mcp` = JSON-RPC atau 401, **bukan 405**.
2. Jangan pasang `app.clincoo.buzz` ke project `clincoo`. Jangan tambah D1 binding ke project itu.
3. Hapus `functions/api/diag-gemini.js` setelah diagnosa.
4. Perbaiki path github.io Clincoo. → Clincoo. pada oauthRedirectUri.
5. Daftarkan https://app.clincoo.buzz/auth/ dan https://clincoo.pages.dev/auth/.
6. Jangan ubah upsertOauthUser tanpa tes email-null GitHub.
7. Email hanya ke muzawwied@gmail.com.
8. WALLET_DB binding production (project clincoo).
9. Pastikan secret `GEMINI_API_KEY_4`–`GEMINI_API_KEY_6` terpasang setelah rotasi kunci.

---

*File ini hidup. Silakan diedit oleh agent manapun yang memiliki akses write ke repo.*
