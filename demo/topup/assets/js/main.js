/* Vylonium — perilaku bersama (tema, preloader, reveal, counter, tilt, typing, akordeon, toast) */
(function () {
  "use strict";
  var d = document, root = d.documentElement;

  /* ---------- Preloader ---------- */
  function killPreloader() {
    var p = d.getElementById("preloader");
    if (p && !p.classList.contains("done")) p.classList.add("done");
  }
  var pct = 0, bar = d.querySelector(".pre-bar"), pctEl = d.querySelector(".pre-pct");
  var iv = setInterval(function () {
    pct = Math.min(pct + Math.random() * 7, 88);
    if (bar) bar.style.width = pct + "%";
    if (pctEl) pctEl.textContent = Math.round(pct) + "%";
  }, 90);
  function finish() {
    clearInterval(iv);
    if (bar) bar.style.width = "100%";
    if (pctEl) pctEl.textContent = "100%";
    setTimeout(killPreloader, 180);
  }
  if (d.readyState === "complete") finish();
  else {
    window.addEventListener("load", finish);
    setTimeout(finish, 2400); /* jaring penuh: jangan pernah nyangkut */
  }
  d.body.classList.remove("no-js");

  /* ---------- Tema ---------- */
  var tBtn = d.getElementById("themeToggle");
  if (tBtn) tBtn.addEventListener("click", function () {
    var next = root.getAttribute("data-theme") === "dark" ? "light" : "dark";
    root.setAttribute("data-theme", next);
    try { localStorage.setItem("vylonium-theme", next); } catch (e) {}
  });

  /* ---------- Header + progress ---------- */
  var head = d.getElementById("siteHead"), prog = d.getElementById("scrollProgress");
  function onScroll() {
    if (head) head.classList.toggle("scrolled", window.scrollY > 8);
    if (prog) {
      var h = root.scrollHeight - root.clientHeight;
      prog.style.width = (h > 0 ? (window.scrollY / h) * 100 : 0) + "%";
    }
  }
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  /* ---------- Menu mobile ---------- */
  var burger = d.querySelector(".burger"), menu = d.getElementById("mobileMenu");
  if (burger && menu) {
    burger.addEventListener("click", function () {
      burger.classList.toggle("open");
      menu.classList.toggle("open");
    });
    menu.querySelectorAll("a").forEach(function (a) {
      a.addEventListener("click", function () {
        burger.classList.remove("open");
        menu.classList.remove("open");
      });
    });
  }

  /* ---------- Reveal ---------- */
  var revealed = d.querySelectorAll(".reveal");
  if ("IntersectionObserver" in window && revealed.length) {
    var io = new IntersectionObserver(function (es) {
      es.forEach(function (e) {
        if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); }
      });
    }, { threshold: 0.12 });
    revealed.forEach(function (el) { io.observe(el); });
  } else {
    revealed.forEach(function (el) { el.classList.add("in"); });
  }

  /* ---------- Counter ---------- */
  function animCount(el) {
    var target = parseFloat(el.getAttribute("data-count")) || 0;
    var dec = parseInt(el.getAttribute("data-decimals") || "0", 10);
    var suf = el.getAttribute("data-suffix") || "";
    var t0 = performance.now(), dur = 1600;
    function tick(t) {
      var p = Math.min((t - t0) / dur, 1), e = 1 - Math.pow(1 - p, 3);
      var v = (target * e).toLocaleString("id-ID", {
        minimumFractionDigits: dec, maximumFractionDigits: dec
      });
      el.textContent = v + suf;
      if (p < 1) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }
  var counters = d.querySelectorAll("[data-count]");
  if ("IntersectionObserver" in window && counters.length) {
    var co = new IntersectionObserver(function (es) {
      es.forEach(function (e) {
        if (e.isIntersecting) { animCount(e.target); co.unobserve(e.target); }
      });
    }, { threshold: 0.4 });
    counters.forEach(function (el) { co.observe(el); });
  } else counters.forEach(animCount);

  /* ---------- Tilt 3D ---------- */
  var reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!reduce && matchMedia("(pointer:fine)").matches) {
    d.querySelectorAll("[data-tilt]").forEach(function (el) {
      el.addEventListener("mousemove", function (ev) {
        var r = el.getBoundingClientRect();
        var x = (ev.clientX - r.left) / r.width - 0.5;
        var y = (ev.clientY - r.top) / r.height - 0.5;
        el.style.transform = "rotateX(" + (-y * 9).toFixed(2) + "deg) rotateY(" + (x * 11).toFixed(2) + "deg)";
      });
      el.addEventListener("mouseleave", function () { el.style.transform = ""; });
    });
  }

  /* ---------- Typing ---------- */
  var typed = d.getElementById("typed");
  if (typed && !reduce) {
    var words = JSON.parse(typed.getAttribute("data-words"));
    var wi = 0, ci = 0, del = false;
    (function step() {
      var w = words[wi];
      ci += del ? -1 : 1;
      typed.textContent = w.slice(0, ci);
      var wait = del ? 38 : 74;
      if (!del && ci === w.length) { wait = 1700; del = true; }
      else if (del && ci === 0) { del = false; wi = (wi + 1) % words.length; wait = 320; }
      setTimeout(step, wait);
    })();
  }

  /* ---------- Akordeon ---------- */
  d.querySelectorAll(".acc-item .acc-btn").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var item = btn.parentElement, body = item.querySelector(".acc-body");
      var open = item.classList.contains("open");
      item.parentElement.querySelectorAll(".acc-item.open").forEach(function (o) {
        if (o !== item) { o.classList.remove("open"); o.querySelector(".acc-body").style.maxHeight = null; }
      });
      item.classList.toggle("open", !open);
      body.style.maxHeight = open ? null : body.scrollHeight + "px";
    });
  });

  /* ---------- Toast ---------- */
  var toastEl = d.getElementById("toast"), toastT;
  window.gToast = function (msg) {
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.classList.add("show");
    clearTimeout(toastT);
    toastT = setTimeout(function () { toastEl.classList.remove("show"); }, 2600);
  };

  /* ---------- Util ---------- */
  window.fmtIDR = function (n) { return "Rp " + n.toLocaleString("id-ID"); };
  var y = d.getElementById("year"); if (y) y.textContent = new Date().getFullYear();
})();
