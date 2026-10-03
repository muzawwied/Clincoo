# Clincoo

## ⛔ ATURAN DEPLOYMENT — WAJIB DIBACA SEBELUM DEPLOY

Produksi *app.clincoo.buzz* (Cloudflare Pages, project `clincoo`) **sudah
terhubung otomatis dengan repo ini** (GitHub-connected, branch `main`).
Setiap push ke `main` otomatis memicu build & deploy produksi.

1. Deploy produksi **SATU-SATUNYA lewat git**: `git pull` → ubah kode →
   `git commit` → `git push origin main`. Cloudflare membangun ulang otomatis.
2. **JANGAN `wrangler pages deploy . --project-name=clincoo`.** Upload langsung
   menimpa build dari git tanpa jejak commit. Kalau folder lokalnya basi
   (belum `git pull` terbaru), produksi tertimpa versi lama dan pembaruan
   terbaru **hilang / halaman rusak**. Ini sudah terjadi berkali-kali.
3. Sebelum mengubah kode apa pun, **selalu `git pull origin main` dulu** —
   jangan kerja dari salinan folder lama.
4. `wrangler pages deploy` hanya untuk project **preview/mirror** (bukan
   produksi), atau deploy dengan `--branch` sebagai preview.
5. Kalau produksi tiba-tiba tampil versi lama: cek daftar deployment
   (deployment tanpa kolom *Source* = upload langsung basi). Perbaikannya:
   push commit kosong ke `main` supaya git membangun ulang produksi.

> Agent lain: kalau kamu memegang salinan kode lama, **jangan deploy ke
> produksi**. Ambil kode terbaru dari repo ini, atau cukup push commit —
> produksi dikelola git, bukan upload manual.
