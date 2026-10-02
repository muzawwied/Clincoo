// PENGETAHUAN PAYMENT GATEWAY — disuntik langsung ke AI Clincoo.
// Dipakai chat.js (auto-inject saat user bicara soal payment) dan blogsearch.js
// (tool search_clinqoo_kb). Sumber: dokumentasi resmi masing-masing gateway +
// integrasi nyata Clincoo sendiri (functions/api/topup-qris.js).
// Sengaja ringkas & padat supaya hemat token: hanya fakta yang stabil.

export const PAYMENT_KB = [
  {
    id: 'clinqoopay-internal',
    gateway: 'ClincooPay',
    keywords: ['clincoo pay', 'clinqoo pay', 'clinqoopay', 'payment clincoo', 'pembayaran clincoo', 'qris clincoo', 'pembayaran', 'qris', 'bayar', 'pay', 'checkout', 'pay_key', 'cno_pk_', 'clc_pk_', 'api/pay'],
    summary: 'ClincooPay: pembayaran QRIS bawaan Clincoo — aktivasi per proyek, buat QRIS dari situs deploy via /api/pay, cek status order.',
    doc: `CLINQOOPAY (pembayaran bawaan Clincoo, endpoint: https://app.clincoo.buzz/api/pay):
- AKTIVASI (pemilik proyek, perlu login Clincoo): UI Pengaturan > Pembayaran > tombol Aktifkan, atau POST /api/pay body {"action":"activate","project_id":"<id>"} dengan header Authorization: Bearer <token akun Clincoo>. Respons: {"active":true,"account_id":"CPPX....","pay_key":"cno_pk_....","secret":"cno_ss_...."}.
- PAY_KEY: kunci publik per proyek (cno_pk_ + hex; proyek lama masih memakai clc_pk_ — keduanya valid). Dipakai situs deploy untuk membuat QRIS — aman diletakkan di frontend. SECRET (cno_ss_..., lama cps_...) JANGAN dipublikasikan.
- BUAT QRIS DARI SITUS DEPLOY (TANPA login — publik): POST https://app.clincoo.buzz/api/pay body {"action":"create","key":"cno_pk_....","amount":25000,"description":"Paket A"}. amount minimum Rp 1.000 (integer rupiah). Respons: {"order_id":"ORD....","amount":25000,"status":"pending","qris_url":"<url>"}. Arahkan pembeli ke qris_url (QRIS). qris_url bernilai null bila QRIS gateway server belum terkonfigurasi — sampaikan itu ke user, jangan mengarang URL.
- CEK STATUS (TANPA login): GET https://app.clincoo.buzz/api/pay?action=status&key=cno_pk_....&order_id=ORD.... -> {"order_id","amount","status","description","created_at"}. status: "pending" lalu "paid" setelah pembayaran dikonfirmasi. Pola situs: polling tiap 3-5 detik sampai status "paid", lalu tampilkan halaman sukses.
- DASHBOARD PEMILIK (perlu login): GET /api/pay?action=config&project_id=... (saldo tersedia = total paid), POST body {"action":"transactions","project_id":...} (25 transaksi terakhir), GET ?action=history juga tersedia.
- KODE SITUS CONTOH:
  async function buatBayaran(amount) {
    const r = await fetch('https://app.clincoo.buzz/api/pay', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({action:'create', key:'cno_pk_....', amount, description:'Pembayaran'}) });
    const d = await r.json(); if (d.qris_url) window.location.href = d.qris_url;
  }
- Catatan: pesan error dari server (mis. "nominal minimum Rp 1.000", "pay key tidak valid") sampaikan apa adanya. Untuk gateway eksternal (Xendit/Midtrans), lihat entri dokumentasi terpisah di KB ini.`
  },

  {
    id: 'xendit-integration',
    gateway: 'Xendit',
    keywords: ['xendit'],
    summary: 'Integrasi Xendit: Invoice API + webhook callback token.',
    doc: `XENDIT (docs.xendit.co):
- BASE URL: https://api.xendit.co (secret key berawalan xnd_development_ untuk sandbox/test, xnd_production_ untuk live).
- AUTENTIKASI: HTTP Basic — username = secret API key, password kosong. Header: "Authorization: Basic " + base64(SECRET + ":").
- INVOICE (paling cepat jalan): POST /v2/invoices body { external_id, amount, payer_email, description, success_redirect_url, failure_redirect_url, currency: "IDR" } -> respons { id, invoice_url, status: "PENDING" }. Arahkan user ke invoice_url untuk bayar (VA, QRIS, e-wallet, kartu — semua muncul otomatis satu halaman).
- CEK STATUS: GET /v2/invoices/{invoice_id} (field status: PENDING/PAID/EXPIRED).
- WEBHOOK: Xendit POST JSON ke callback URL yang diatur di dashboard (Settings > Webhooks). Header penting: "x-callback-token" — WAJIB diverifikasi: bandingkan dengan "Callbacks verification token" di dashboard. Event utama: invoice.paid (lunas), invoice.expired. Body berisi field status, paid_at, paid_amount, external_id.
- POLA INTEGRASI CEPAT: 1) simpan order di db (create_backend_function, await db.set(order_id, {...status:'pending'})); 2) panggil Invoice API dengan fetch + secret key user (JANGAN hardcode); 3) buat webhook function is_public:true yang verifikasi x-callback-token lalu db.set(order_id, {...status:'paid'}); 4) berikan webhook_url ke user untuk dipasang di dashboard Xendit.
- Catatan: tidak ada signature HMAC — verifikasi cukup compare token callback. Idempotensi: cek dulu status order di db sebelum update (webhook bisa terkirim 2x).`
  },
  {
    id: 'midtrans-integration',
    gateway: 'Midtrans',
    keywords: ['midtrans', 'snap'],
    summary: 'Integrasi Midtrans Snap + verifikasi signature sha512.',
    doc: `MIDTRANS SNAP (docs.midtrans.com):
- BASE URL SANDBOX: https://app.sandbox.midtrans.com (prod: https://app.midtrans.com, API status: https://api.sandbox.midtrans.com / https://api.midtrans.com).
- KREDENSIAL: Server Key (SB-Mid-server-... sandbox) — RAHASIA, hanya di backend. Client Key untuk frontend Snap.
- AUTENTIKASI API: HTTP Basic — "Authorization: Basic " + base64(SERVER_KEY + ":").
- BUAT TRANSAKSI: POST /snap/v1/transactions body { transaction_details: { order_id, gross_amount }, item_details?, customer_details? } -> respons { token, redirect_url }. Arahkan user ke redirect_url (Snap popup/full page: QRIS, VA, e-wallet, kartu, gerai).
- WEBHOOK NOTIFICATION: Midtrans POST JSON ke "Notification URL" (dashboard Settings > Configuration). Body: { order_id, status_code, transaction_status, gross_amount, signature_key, payment_type }. transaction_status utama: pending, capture, settlement (lunas), deny, cancel, expire.
- VERIFIKASI SIGNATURE (WAJIB): signature_key = SHA512 dari string order_id + status_code + gross_amount + SERVER_KEY. Contoh: crypto.createHash('sha512').update(order_id + status_code + gross_amount + serverKey).digest('hex') lalu bandingkan dengan signature_key.
- CEK STATUS: GET /v2/{order_id}/status (Basic auth sama) — untuk rekonsiliasi/manual check.
- POLA INTEGRASI CEPAT: sama seperti Xendit (order di db -> Snap transaction -> redirect user -> webhook is_public:true verifikasi signature -> update status).`
  },
  {
    id: 'doku-integration',
    gateway: 'DOKU',
    keywords: ['doku', 'doku'],
    summary: 'Integrasi DOKU: payment request + signature HMAC-SHA256.',
    doc: `DOKU (docs.doku.com):
- BASE URL SANDBOX: https://api-sandbox.doku.com (prod: https://api.doku.com).
- KREDENSIAL: Client-Id + Secret Key dari dashboard DOKU (Sandbox/Production terpisah).
- HEADER WAJIB SETIAP REQUEST: "Client-Id", "Request-Id" (uuid unik per request), "Request-Timestamp" (ISO 8601 UTC, contoh 2026-01-01T10:00:00Z), "Signature".
- SIGNATURE (HMAC-SHA256): komponen string berisi baris Client-Id, Request-Id, Request-Timestamp, Request-Target (path+query), dan Digest (SHA-256 hex lowercase dari raw body JSON; untuk request tanpa body ikuti pola docs). Hitung HMAC-SHA256 dari komponen itu memakai Secret Key, lalu header: "Signature: HMACSHA256=" + base64(hmac). Detail string komponen persisnya selalu cocokkan dengan docs.doku.com (bagian "Generate Signature") karena format bisa diperbarui — kalau 401, cek ulang komponen/digest.
- PAYMENT REQUEST: POST ke endpoint payment-request (checkout) dengan body { payment: { payment_amount, payment_method, ... }, customer, order: { invoice_number, amount }, ... } -> respons berisi payment URL/token untuk halaman pembayaran DOKU.
- WEBHOOK NOTIFICATION: DOKU POST ke Notification URL yang diatur di dashboard. Verifikasi: hitung ulang signature dari header Client-Id/Request-Id/Request-Timestamp + raw body memakai Secret Key, bandingkan dengan header Signature.
- POLA INTEGRASI: sama seperti gateway lain — order di db, request payment, redirect user, webhook is_public:true dengan verifikasi signature, update status order.
- TIPS: mulai dari sandbox, aktifkan metode pembayaran di dashboard dulu (QRIS/VA/DS dsb.), dan simpan Request-Id tiap request untuk debugging dengan tim DOKU.`
  },
  {
    id: 'pakasir-buatqris-integration',
    gateway: 'Pakasir / BuatQRIS',
    keywords: ['pakasir', 'buatqris', 'buat qris'],
    summary: 'Integrasi Pakasir/BuatQRIS untuk QRIS + contoh nyata Clincoo.',
    doc: `PAKASIR (app.pakasir.com) & BUAATQRIS — QRIS Indonesia:
- Clincoo sendiri memakai layanan QRIS ini untuk top-up saldo (lihat functions/api/topup-qris.js sebagai contoh implementasi nyata yang production-ready).
- PAKASIR: base https://app.pakasir.com, kredensial API key per project (slug project, contoh: clincoo). Mode sandbox tersedia untuk uji coba. Endpoint utama: POST /api/transactioncreate/qris (buat transaksi QRIS: nominal, deskripsi -> QR string/url), GET /api/transactiondetail (status transaksi), POST /api/transactioncancel, POST /api/paymentsimulation (khusus sandbox untuk simulasi pembayaran).
- BUAATQRIS (dipakai Clincoo saat ini): endpoint transaksi via form-encoded; webhook masuk dengan header signature khusus (x-buatqris-signature) ke URL callback — verifikasi signature sebelum memproses.
- WEBHOOK: daftarkan URL callback di dashboard project; gateway mengirim POST saat status transaksi berubah (pending -> paid/expired). WAJIB verifikasi signature dari header sebelum update status order.
- POLA INTEGRASI: order di db -> panggil transactioncreate dengan API key user -> simpan qr_url + nominal + expired -> tampilkan QR ke user (img src qr_url) -> webhook is_public:true verifikasi signature -> update status. Polling transactiondetail sebagai fallback bila webhook lambat.
- CATATAN: bedakan mode sandbox (simulasi, tidak ada uang nyata) dan production (aktifkan di dashboard project — untuk Pakasir cukup toggle status project, tanpa perubahan kode).`
  },
  {
    id: 'payment-pattern-clinqoo',
    gateway: 'Pola Umum',
    keywords: ['payment gateway', 'payment', 'pembayaran', 'payout', 'qris', 'va', 'virtual account'],
    summary: 'Pola umum backend payment di Clincoo (berlaku semua gateway).',
    doc: `POLA UMUM BACKEND PAYMENT DI CLINCOO (berlaku untuk SEMUA gateway: Xendit, Midtrans, DOKU, Pakasir/BuatQRIS, Tripay, dll.):
1) FUNGSI ORDER: create_backend_function — simpan order via db.set(order_id, { status: 'pending', amount, created_at, items, user_id }), lalu panggil API gateway dengan fetch memakai secret key USER (kirim lewat args, JANGAN hardcode). Return URL pembayaran/QR ke frontend.
2) FUNGSI WEBHOOK: create_backend_function dengan is_public: true -> respons berisi webhook_url (berisi key rahasia). Webhook WAJIB: verifikasi signature/callback token gateway, cek idempotensi (baca status order dulu di db), baru update status ke 'paid'. Berikan webhook_url ke user untuk dipasang di dashboard gateway.
3) REDIRECT/POLLING: frontend redirect user ke payment_url ATAU tampilkan QR + polling status tiap 3-5 detik ke fungsi cek-status (jangan pernah trust redirect sukses sebagai bukti bayar — status lunas HANYA dari webhook/cek status API).
4) KEAMANAN: secret key hanya di sisi server (function), jangan pernah dikirim ke frontend. Amount diverifikasi ulang dari API gateway (jangan pakai amount dari client). Order id unik dan unpredictable.
5) UJI: mulai dari sandbox masing-masing gateway (Xendit: xnd_development_, Midtrans: SB-Mid-server-, DOKU: api-sandbox, Pakasir: mode sandbox + paymentsimulation).`
  }
];

// Ambil docs yang relevan berdasar teks user. Return string siap suntik, atau ''.
export function paymentDocsFor(text) {
  const t = String(text || '').toLowerCase();
  if (!t) return '';
  const hits = [];
  for (const k of PAYMENT_KB) {
    const gw = (k.keywords || []).some(w => t.indexOf(w) !== -1);
    if (gw) hits.push(k);
  }
  // pertanyaan payment umum tanpa sebut gateway -> pola umum saja
  if (!hits.length) {
    const umum = PAYMENT_KB.find(k => k.id === 'payment-pattern-clinqoo');
    const mentions = /payment|bayar|pembayaran|checkout|qris|top.?up|invoice|transaksi/.test(t);
    if (mentions && /(buat|bikin|integrasi|backend|tambah|pasang|set up|setup|implement)/.test(t)) hits.push(umum);
  }
  if (!hits.length) return '';
  return '=== PENGETAHUAN PAYMENT GATEWAY (sudah disuntik otomatis — JANGAN cari ke web lagi untuk hal ini; anggap ini sumber resmi) ===\n' +
    hits.map(h => `[${h.gateway.toUpperCase()} — ${h.summary}]\n${h.doc}`).join('\n\n') +
    '\n=== AKHIR PENGETAHUAN PAYMENT GATEWAY ===';
}
