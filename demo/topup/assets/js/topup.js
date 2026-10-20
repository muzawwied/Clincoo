/* Alur top-up 4 langkah: pilih game → nominal → data akun → pembayaran */
(function () {
  "use strict";
  var state = { game: null, denom: null, id: "", server: "", pay: null, step: 1 };
  var panel = document.getElementById("flowPanel");
  var segs = document.querySelectorAll("#flowHead .flow-seg");
  var prevBtn = document.getElementById("prevBtn"), nextBtn = document.getElementById("nextBtn");

  function q(sel, root) { return (root || document).querySelector(sel); }

  /* --- render pilihan game --- */
  var pick = q("#pickGames");
  GAMES.forEach(function (g) {
    var b = document.createElement("button");
    b.type = "button"; b.className = "pick-game"; b.setAttribute("data-slug", g.slug);
    b.innerHTML = '<span class="tile"><img src="' + g.logo + '" alt="Logo ' + g.name + '" loading="lazy"></span>' +
      '<span style="min-width:0"><b>' + g.name + '</b><small>' + g.genre + " · " + g.publisher + "</small></span>";
    b.addEventListener("click", function () {
      state.game = g; state.denom = null;
      pick.querySelectorAll(".pick-game").forEach(function (x) { x.classList.remove("sel"); });
      b.classList.add("sel");
      renderDenoms(); sync();
      setTimeout(function () { go(2); }, 260);
    });
    pick.appendChild(b);
  });

  /* --- render nominal --- */
  var dw = q("#denomWrap");
  function renderDenoms() {
    var g = state.game;
    q("#denomTitle").textContent = "Top up " + g.name;
    q("#denomSub").textContent = "Semua harga sudah termurah & bebas biaya tersembunyi.";
    dw.innerHTML = "";
    g.denoms.forEach(function (dn) {
      var r = document.createElement("button");
      r.type = "button"; r.className = "denom-row";
      r.innerHTML = '<span style="min-width:0"><b>' + dn.label + "</b><small>" + (dn.note || "") + "</small></span>" +
        '<span class="price">' + fmtIDR(dn.price) + "</span>";
      r.addEventListener("click", function () {
        state.denom = dn;
        dw.querySelectorAll(".denom-row").forEach(function (x) { x.classList.remove("sel"); });
        r.classList.add("sel");
        sync();
      });
      dw.appendChild(r);
    });
  }

  /* --- render kolom ID --- */
  var idFields = q("#idFields");
  function renderIdFields() {
    var g = state.game;
    q("#idHint").textContent = g.idHint + " Data ini dipakai untuk mengirim item ke akunmu.";
    var html = '<div class="field"><label for="idUser">' + g.idLabel + "</label>" +
      '<input type="text" id="idUser" autocomplete="off" placeholder="' + g.idLabel + '">' +
      '<p class="err-msg">Mohon isi ' + g.idLabel + " dengan benar.</p></div>";
    if (g.serverLabel) {
      html += '<div class="field"><label for="idServer">' + g.serverLabel + "</label>" +
        '<input type="text" id="idServer" autocomplete="off" placeholder="' + g.serverLabel + '">' +
        '<p class="err-msg">Mohon isi ' + g.serverLabel + ".</p>";
      if (g.serverHint) html += '<p class="hint">' + g.serverHint + "</p>";
      html += "</div>";
    }
    idFields.innerHTML = html;
    q("#idUser").addEventListener("input", function () { state.id = this.value.trim(); sync(); });
    if (g.serverLabel) q("#idServer").addEventListener("input", function () { state.server = this.value.trim(); sync(); });
  }

  /* --- render pembayaran --- */
  var pl = q("#payList");
  PAYMENTS.forEach(function (p) {
    var r = document.createElement("button");
    r.type = "button"; r.className = "pay-row";
    r.innerHTML = '<span style="min-width:0"><b>' + p.name + "</b><small>" + p.note + "</small></span>" +
      '<span class="dot" aria-hidden="true"></span>';
    r.addEventListener("click", function () {
      state.pay = p;
      pl.querySelectorAll(".pay-row").forEach(function (x) { x.classList.remove("sel"); });
      r.classList.add("sel");
      sync();
    });
    pl.appendChild(r);
  });

  /* --- langkah --- */
  function go(n) {
    state.step = n;
    panel.querySelectorAll(".fstep").forEach(function (s) {
      s.hidden = s.getAttribute("data-step") !== String(n);
    });
    segs.forEach(function (s) {
      var i = +s.getAttribute("data-seg");
      s.classList.toggle("active", i === n);
      s.classList.toggle("done", i < n);
    });
    prevBtn.hidden = n === 1;
    nextBtn.textContent = n === 4 ? "Bayar Sekarang" : "Lanjut";
    sync();
  }
  prevBtn.addEventListener("click", function () { go(state.step - 1); });
  nextBtn.addEventListener("click", function () {
    if (nextBtn.disabled) return;
    if (state.step === 1 && state.game) { renderDenoms(); go(2); }
    else if (state.step === 2 && state.denom) { renderIdFields(); go(3); }
    else if (state.step === 3 && validId()) { go(4); }
    else if (state.step === 4 && state.pay) { submitOrder(); }
  });

  function fieldOk() {
    var g = state.game;
    if (!state.id || state.id.length < 2) return false;
    if (g.serverLabel && !state.server) return false;
    return true;
  }
  function validId() {
    var g = state.game, ok = true;
    var idIn = q("#idUser");
    idIn.closest(".field").classList.toggle("err", !state.id);
    if (!state.id) ok = false;
    if (g.serverLabel) {
      q("#idServer").closest(".field").classList.toggle("err", !state.server);
      if (!state.server) ok = false;
    }
    if (!ok) gToast("Lengkapi data akun kamu dulu ya.");
    return ok;
  }

  /* --- ringkasan --- */
  function sync() {
    q("#sumGame").textContent = state.game ? state.game.name : "—";
    q("#sumDenom").textContent = state.denom ? state.denom.label : "—";
    q("#sumId").textContent = state.game && state.id ? state.id + (state.game.serverLabel && state.server ? " / " + state.server : "") : "—";
    q("#sumPay").textContent = state.pay ? state.pay.name : "—";
    q("#sumTotal").textContent = fmtIDR(state.denom ? state.denom.price : 0);
    nextBtn.disabled = !(state.step === 1 ? state.game : state.step === 2 ? state.denom : state.step === 3 ? fieldOk() : state.pay);
  }

  /* --- buat pesanan --- */
  function submitOrder() {
    var code = "VY-" + Date.now().toString(36).toUpperCase() + Math.floor(Math.random() * 90 + 10);
    var order = {
      code: code, gameSlug: state.game.slug, gameName: state.game.name,
      denomLabel: state.denom.label, price: state.denom.price,
      id: state.id, server: state.server || "", pay: state.pay.name,
      logo: state.game.logo, ts: Date.now()
    };
    try {
      var orders = [];
      try { orders = JSON.parse(localStorage.getItem("vylonium_orders")) || []; } catch (e) {}
      orders.unshift(order);
      localStorage.setItem("vylonium_orders", JSON.stringify(orders));
    } catch (e) {}
    panel.innerHTML =
      '<div class="succ">' +
      '<div class="tick">✓</div>' +
      "<h3>Pesanan Berhasil Dibuat!</h3>" +
      '<p class="muted" style="margin-top:8px">Simpan kode pesanan di bawah ini untuk mengecek status transaksi.</p>' +
      '<div class="code-pill">' + order.code + "</div>" +
      '<p class="mini soft">Total dibayar: ' + fmtIDR(order.price) + " · via " + order.pay + "</p>" +
      '<div style="display:flex;gap:14px;justify-content:center;flex-wrap:wrap;margin-top:26px">' +
      '<a class="btn btn-primary btn-sm" href="status.html?code=' + order.code + '">Cek Status Pesanan</a>' +
      '<button class="btn btn-ghost btn-sm" id="copyCode">Salin Kode</button>' +
      '<button class="btn btn-ghost btn-sm" id="newOrder">Top Up Lagi</button>' +
      "</div></div>";
    var summary = q("#summaryBox");
    if (summary) summary.style.display = "none";
    var cp = q("#copyCode");
    if (cp) cp.addEventListener("click", function () {
      try {
        navigator.clipboard.writeText(order.code);
        gToast("Kode pesanan disalin!");
      } catch (e) { gToast("Kode: " + order.code); }
    });
    var no = q("#newOrder");
    if (no) no.addEventListener("click", function () { location.href = "topup.html"; });
    gToast("Pesanan " + code + " dibuat — item dikirim otomatis.");
  }

  /* --- preselect via URL ?game=slug --- */
  var m = /([?&])game=([\w-]+)/.exec(location.search);
  if (m) {
    var g = GAMES.filter(function (x) { return x.slug === m[2]; })[0];
    if (g) {
      var target = pick.querySelector('[data-slug="' + g.slug + '"]');
      if (target) target.click();
    }
  }
})();
