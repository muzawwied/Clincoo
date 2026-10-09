# Undangan Pernikahan — Rafael & Aurelia

Undangan pernikahan digital satu halaman: hero parallax, profil mempelai (The Groom & Bride),
love story, wedding details, groomsmen & bridesmaids, galeri momen, RSVP/konfirmasi kehadiran,
wedding gift, FAQ, dan musik latar. Dibangun dengan HTML + Tailwind CSS (CDN) + vanilla JS.

Catatan:
- Foto mempelai & galeri memuat dari Unsplash — ganti dengan foto asli di bagian <img> bila perlu.
- Data RSVP saat ini disimpan lokal di browser (tanpa backend); sambungkan ke backend/Supabase bila perlu.
- Musik latar memuat dari CDN Google Actions Sound Library.

Struktur:
- index.html            halaman utama
- assets/styles.css     gaya kustom (animasi, parallax, utilitas)
- assets/app.js         interaksi: navbar, countdown, RSVP, musik, galeri

Jalankan lokal: cukup buka index.html di browser (tanpa build step).
