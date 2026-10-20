/* ============================================================
   [19 Okt, arahan pemilik] CTA loading otomatis untuk SEMUA app.
   Prinsip: tombol yang onclick-nya memanggil fungsi async global
   dianggap CTA "perlu loading" — begitu diklik, isinya langsung
   berganti ikon loading berputar (SVG inline, lebar tombol
   dikunci biar layout tidak loncat) sampai promise selesai.

   Cara kerja (aman, tanpa menabrak logika halaman):
   1. Capture-phase click: catat tombol terakhir yang diklik.
   2. Semua fungsi async global yang dirujuk atribut onclick
      dibungkus: saat dipanggil, tombol terakhir dikunci
      visualnya (spinner) selama promise berjalan.
   3. Tombol TIDAK di-disable lewat atribut (banyak handler
      punya guard `if (btn.disabled) return`); klik berulang
      saat terkunci di-swap oleh stopImmediatePropagation.
   4. Hanya fungsi `async function` asli (constructor AsyncFunction)
      yang dibungkus — handler sinkron (buka popover dsb.) tidak.
   ============================================================ */
(function () {
    'use strict';
    var style = document.createElement('style');
    style.textContent = '.cta-spin{animation:ctaSpin .8s linear infinite;display:inline-block;vertical-align:middle}'
        + '@keyframes ctaSpin{to{transform:rotate(360deg)}}';
    document.head.appendChild(style);

    var lastClick = null; // { btn, t }
    document.addEventListener('click', function (e) {
        var b = e.target && e.target.closest ? e.target.closest('button') : null;
        if (b && !b.__ctaLocked) lastClick = { btn: b, t: Date.now() };
        // klik berulang saat terkunci: matikan total supaya handler tidak jalan dobel
        if (b && b.__ctaLocked) { e.preventDefault(); e.stopImmediatePropagation(); }
    }, true);

    function lock(btn) {
        if (!btn || btn.__ctaLocked) return;
        btn.__ctaLocked = true;
        btn.__ctaLabel = btn.innerHTML;
        btn.__ctaW = btn.offsetWidth;
        if (btn.__ctaW > 0) btn.style.minWidth = btn.__ctaW + 'px';
        btn.innerHTML = '<svg class="cta-spin" width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2.5" opacity=".18"/><path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/></svg>';
    }
    function unlock(btn) {
        if (!btn || !btn.__ctaLocked) return;
        btn.__ctaLocked = false;
        btn.style.minWidth = '';
        btn.innerHTML = btn.__ctaLabel;
    }

    var KEYWORDS = { if: 1, for: 1, while: 1, switch: 1, catch: 1, return: 1, function: 1, typeof: 1, void: 1, new: 1, delete: 1, do: 1, else: 1, try: 1 };

    function wrapIfAsync(name) {
        var fn;
        try { fn = window[name]; } catch (e) { return; }
        if (typeof fn !== 'function' || fn.__ctaWrapped) return;
        if (fn.constructor.name !== 'AsyncFunction') return; // hanya async asli
        var orig = fn;
        var wrapped = function () {
            var ctx = lastClick;
            var r = orig.apply(this, arguments);
            if (ctx && (Date.now() - ctx.t) < 150 && r && typeof r.then === 'function') {
                lock(ctx.btn);
                var done = function () { unlock(ctx.btn); };
                r.then(done, done);
                setTimeout(done, 25000); // pengaman: maks 25 detik pasti terbuka
            }
            return r;
        };
        wrapped.__ctaWrapped = true;
        try { window[name] = wrapped; } catch (e) {}
    }

    function scanAndWrap() {
        var names = {};
        try {
            document.querySelectorAll('button[onclick]').forEach(function (b) {
                var code = b.getAttribute('onclick') || '';
                (code.match(/[A-Za-z_$][\w$]*\s*\(/g) || []).forEach(function (tok) {
                    var n = tok.replace(/\s*\($/, '');
                    if (!KEYWORDS[n]) names[n] = 1;
                });
            });
        } catch (e) {}
        Object.keys(names).forEach(wrapIfAsync);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', scanAndWrap);
    else scanAndWrap();
    window.addEventListener('load', scanAndWrap); // tombol/handler yang muncul belakangan
})();
