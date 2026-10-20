/* Cek pesanan: cari berdasarkan kode, render progres + riwayat (localStorage) */
(function () {
  "use strict";
  var result = document.getElementById("resultBox");
  var histWrap = document.getElementById("histWrap");

  function orders() {
    try { return JSON.parse(localStorage.getItem("vylonium_orders")) || []; }
    catch (e) { return []; }
  }

  function stageOf(o) {
    var dt = Date.now() - o.ts;
    if (dt < 10000) return 1;   // diproses
    if (dt < 25000) return 2;   // mengirim
    return 3;                   // selesai
  }
  function t(ts) {
    return new Date(ts).toLocaleString("id-ID", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
  }

  function renderOrder(o) {
    var st = stageOf(o);
    var pill = st === 3 ? '<span class="status-pill ok">Sukses</span>' : '<span class="status-pill pend">Diproses</span>';
    var labels = ["Pesanan dibuat", "Sistem memproses", "Item terkirim"];
    var times = [o.ts, o.ts + 10000, o.ts + 25000];
    var tl = labels.map(function (lb, i) {
      var cls = "tl-item" + (st > i ? " done" : st === i + 1 ? " now" : "");
      var tm = st > i ? t(times[i]) : "menunggu…";
      return '<li class="' + cls + '"><b>' + lb + "</b><small>" + tm + "</small></li>";
    }).join("");
    result.innerHTML =
      '<div style="border:1px solid var(--line);border-radius:var(--radius-lg);background:var(--surface);padding:clamp(22px,4vw,36px);min-width:0">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;gap:14px;flex-wrap:wrap;margin-bottom:20px;min-width:0">' +
      '<div style="min-width:0"><b style="font-size:1.15rem;letter-spacing:.06em">' + o.code + "</b>" +
      '<p class="muted mini" style="margin-top:2px">' + o.gameName + " · " + o.denomLabel + "</p></div>" + pill + "</div>" +
      '<div class="sum-row"><span>ID Akun</span><b>' + o.id + (o.server ? " / " + o.server : "") + "</b></div>" +
      '<div class="sum-row"><span>Pembayaran</span><b>' + o.pay + "</b></div>" +
      '<div class="sum-total"><span>Total</span><b>' + fmtIDR(o.price) + "</b></div>" +
      '<div class="timeline" style="margin-top:26px"><ul>' + tl + "</ul></div>" +
      (st < 3 ? '<p class="mini soft" style="margin-top:6px">Halaman ini memperbarui progres secara otomatis — biarkan tetap terbuka.</p>' : "") +
      "</div>";
    if (st < 3) setTimeout(function () { if (result.innerHTML.indexOf(o.code) > -1) renderOrder(o); }, 4000);
  }

  function notFound(code) {
    result.innerHTML =
      '<div class="succ"><div class="tick" style="background:var(--accent-soft);color:var(--accent)">?</div>' +
      '<h3>Pesanan tidak ditemukan</h3>' +
      '<p class="muted" style="margin-top:8px">Kode "<b>' + code + "</b>\" tidak ada di perangkat ini. Pastikan kode benar atau pesanan dibuat di perangkat yang sama.</p></div>";
  }

  function lookup(code) {
    var c = (code || "").trim().toUpperCase();
    if (!c) { gToast("Masukkan kode pesanan dulu ya."); return; }
    var o = orders().filter(function (x) { return x.code.toUpperCase() === c; })[0];
    if (o) renderOrder(o); else notFound(c);
  }

  document.getElementById("checkBtn").addEventListener("click", function () {
    lookup(document.getElementById("codeInput").value);
  });
  document.getElementById("codeInput").addEventListener("keydown", function (e) {
    if (e.key === "Enter") lookup(this.value);
  });

  /* dari URL ?code= */
  var m = /([?&])code=([^&]+)/.exec(location.search);
  if (m) {
    var code = decodeURIComponent(m[2]);
    document.getElementById("codeInput").value = code;
    lookup(code);
  }

  /* riwayat */
  function renderHist() {
    var os = orders();
    if (!os.length) {
      histWrap.innerHTML = '<p class="empty-note">Belum ada transaksi di perangkat ini. <a href="topup.html" style="color:var(--accent)">Mulai top up pertamamu →</a></p>';
      return;
    }
    histWrap.innerHTML = '<div class="game-list">' + os.map(function (o) {
      return '<div class="hist-row">' +
        '<div class="c"><b>' + o.gameName + " · " + o.denomLabel + "</b><small>" + o.code + " · " + t(o.ts) + "</small></div>" +
        '<span class="p">' + fmtIDR(o.price) + "</span>" +
        (stageOf(o) === 3 ? '<span class="status-pill ok">Sukses</span>' : '<span class="status-pill pend">Diproses</span>') +
        "</div>";
    }).join("") + "</div>";
  }
  renderHist();
})();
