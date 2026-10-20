/* Clincoo Onboarding v2 (produksi) — panduan first-run multi-halaman.
   Jalur Buat Proyek: Home -> Semua Proyek -> + Buat Proyek Baru -> nama -> Konfirmasi -> workspace.
   Jalur Template: Home -> titik tiga kartu template -> Gunakan Template -> workspace -> Build & Deployment -> Jalankan Deploy.
   Muncul sekali per perangkat (user baru & lama). Testing: tambah ?ob-replay=1 di URL. */
(function () {
  var KEY_DONE = 'clincoo_ob_done';
  var KEY_ST = 'clincoo_ob_state';

  if (location.search.indexOf('ob-replay=1') !== -1) {
    try { localStorage.removeItem(KEY_DONE); localStorage.removeItem(KEY_ST); } catch (e) {}
    try { history.replaceState(null, '', location.pathname); } catch (e) {}
  }

  var p = location.pathname;
  var PAGE = null;
  if (p.indexOf('akun/proyek') !== -1) PAGE = 'proyek';
  else if (p.indexOf('proyek/baru') !== -1) PAGE = 'baru';
  else if (p.indexOf('build-deployment/config') !== -1) PAGE = 'deploy';
  else if (p.indexOf('proyek/code') !== -1 || p.indexOf('proyek/chat') !== -1 || p.indexOf('proyek/workspace') !== -1) PAGE = 'code';
  else if (p === '/' || p === '' || /(^|\/)index\.html$/.test(p)) PAGE = 'home';
  if (!PAGE) return;

  var state = null;
  try { state = JSON.parse(localStorage.getItem(KEY_ST) || 'null'); } catch (e) { state = null; }
  var done = false;
  try { done = !!localStorage.getItem(KEY_DONE); } catch (e) {}

  function saveState(s, path) {
    try { localStorage.setItem(KEY_ST, JSON.stringify({ s: s, p: path })); } catch (e) {}
  }
  function clearState() { try { localStorage.removeItem(KEY_ST); } catch (e) {} }
  function markDone() { try { localStorage.setItem(KEY_DONE, '1'); } catch (e) {} }
  function currentPid() {
    try { return localStorage.getItem('clincoo_current_project_id') || ''; } catch (e) { return ''; }
  }

  var startStep = null, path = null;
  if (state && !done) { startStep = state.s; path = state.p; }
  else if (!done && PAGE === 'home') { startStep = 0; path = 'buat'; }

  // kartu template gratis pilihan tour (dipilih saat langkah 6)
  var tplCard = null;
  function pickFreeTplCard() {
    if (tplCard) return tplCard;
    var cards = document.querySelectorAll('#home-tpl-grid > div');
    var fallback = null;
    for (var i = 0; i < cards.length; i++) {
      var lbl = cards[i].querySelector('[data-tpl-label]');
      if (!lbl) continue;
      var t = (lbl.textContent || '').toLowerCase();
      if (t.indexOf('pro') === -1 && t.indexOf('kredit') === -1 && t.indexOf('credit') === -1) { tplCard = cards[i]; return tplCard; }
      if (!fallback) fallback = cards[i];
    }
    tplCard = fallback;
    return tplCard;
  }

  var STEPS = {
    0: { page: 'home', type: 'center', kicker: 'Clincoo', title: 'Bikin proyek pertamamu, yuk!', desc: 'Mulai dari ide kamu sendiri, atau pakai template — dibimbing klik sampai situsmu tayang online.', choices: [{ label: 'Buat Proyek Baru', go: 1 }, { label: 'Pilih Template', go: 6 }] },
    // ===== jalur buat proyek =====
    1: { page: 'home', type: 'click', target: '#ob-sb-proyek', kicker: 'Langkah 1', title: 'Buka daftar proyek', desc: 'Klik menu Semua Proyek — semua proyek kamu ada di halaman ini.', nav: true, next: 2, prepare: function () { if (window.innerWidth < 1024 && window.toggleSidebar) { try { window.toggleSidebar(true); } catch (e) {} } } },
    2: { page: 'proyek', type: 'click', target: '#ob-cta-buat-baru', kicker: 'Langkah 2', title: 'Klik Buat Proyek Baru', desc: 'Tombol ini membuka halaman pembuatan proyek baru.', nav: true, next: 3 },
    3: { page: 'baru', type: 'point', target: '#inp-name', kicker: 'Langkah 3', title: 'Kasih nama proyekmu', desc: 'Cukup nama proyeknya — deskripsi dan logo opsional.' },
    4: { page: 'baru', type: 'click', target: '#ob-btn-konfirmasi', kicker: 'Langkah 4', title: 'Konfirmasi', desc: 'Kalau nama sudah pas, klik Konfirmasi dan proyekmu langsung dibuat.', nav: true, next: 5 },
    5: { page: 'code', type: 'center', kicker: 'Selesai', title: 'Proyek pertamamu jadi!', desc: 'Proyek baru masuk ke daftar. Lanjut membangun di workspace ya — panduan ini cuma muncul sekali.', next: 'Selesai', final: true },
    // ===== jalur template (sampai deploy) =====
    6: { page: 'home', type: 'click', refFn: function () { var c = pickFreeTplCard(); return c ? c.querySelector('.cc-dots') : null; }, kicker: 'Template 1', title: 'Buka menu template', desc: 'Klik tombol titik tiga di kartu template yang ditandai.' },
    7: { page: 'home', type: 'click', refFn: function () { var c = pickFreeTplCard(); return c ? c.querySelector('button[onclick*="useTemplate"]') : null; }, kicker: 'Template 2', title: 'Gunakan Template', desc: 'Klik Gunakan Template — proyekmu dibuat otomatis dari template ini.', nav: true, next: 8 },
    8: { page: 'code', type: 'center', kicker: 'Template 3', title: 'Proyek template siap!', desc: 'Situs dari template sudah terpasang di workspace. Sekarang kita terbitkan ke internet.', next: 'Lanjut ke Deploy', go: 9, href: function () { var pid = currentPid(); return '/proyek/build-deployment/config/' + (pid ? '?id=' + encodeURIComponent(pid) : ''); } },
    9: { page: 'deploy', type: 'point', target: '#input-subdomain', kicker: 'Template 4', title: 'Pilih alamat situsmu', desc: 'Subdomain = alamat web kamu: nama.clincoo.biz.id. Sudah terisi otomatis — boleh ganti, atau langsung lanjut.' },
    10: { page: 'deploy', type: 'click', target: '#btn-process-deploy', kicker: 'Template 5', title: 'Jalankan Deploy', desc: 'Terakhir: klik Jalankan Deploy dan tunggu prosesnya — situsmu langsung tayang online.', end: true }
  };

  if (startStep === null) return;
  var s0 = STEPS[startStep];
  if (!s0 || s0.page !== PAGE) return;

  var thm = 'Sistem (Default)';
  try { thm = localStorage.getItem('clincoo_theme') || 'Sistem (Default)'; } catch (e) {}
  var dark = thm === 'Gelap' || (thm !== 'Terang' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);

  var glassBg = dark ? 'rgba(26,26,30,.72)' : 'rgba(255,255,255,.86)';
  var glassBd = dark ? 'rgba(255,255,255,.14)' : 'rgba(0,0,0,.08)';
  var txt = dark ? '#f2f2f2' : '#16161a';
  var mut = dark ? '#b6b6bd' : '#6b6b74';
  var line = dark ? 'rgba(255,255,255,.1)' : 'rgba(0,0,0,.08)';
  var accent = dark ? '#f2f2f2' : '#0a0a0a';
  var accentTx = dark ? '#0a0a0a' : '#ffffff';
  var ringC = dark ? 'rgba(255,255,255,.9)' : 'rgba(10,10,10,.85)';
  var dimBg = dark ? 'rgba(10,10,12,.5)' : 'rgba(230,230,235,.42)';

  var css =
    '.ob-p{position:fixed;z-index:99996;background:' + dimBg + ';backdrop-filter:blur(6px) saturate(.75);-webkit-backdrop-filter:blur(6px) saturate(.75);transition:all .5s cubic-bezier(.4,0,.2,1);pointer-events:auto;}' +
    '.ob-p.hid{opacity:0}' +
    '.ob-live{position:relative !important;z-index:99999 !important;}' +
    '.ob-ring{position:fixed;z-index:99997;border:2px solid ' + ringC + ';border-radius:14px;pointer-events:none;transition:all .5s cubic-bezier(.4,0,.2,1);opacity:0;}' +
    '.ob-ring.on{opacity:1;}' +
    '.ob-bub{position:fixed;z-index:100000;width:290px;background:' + glassBg + ';backdrop-filter:blur(16px) saturate(1.3);-webkit-backdrop-filter:blur(16px) saturate(1.3);border:1px solid ' + glassBd + ';color:' + txt + ';border-radius:10px;padding:15px 17px 13px;opacity:0;transform:translateY(10px) scale(.97);transition:opacity .38s,transform .38s cubic-bezier(.34,1.3,.5,1);}' +
    '.ob-bub.on{opacity:1;transform:translateY(0) scale(1)}' +
    '.ob-kicker{font-size:10.5px;font-weight:700;letter-spacing:.9px;color:' + mut + ';text-transform:uppercase;margin-bottom:5px}' +
    '.ob-title{font-size:15.5px;font-weight:700;margin:0 0 5px}' +
    '.ob-desc{font-size:13px;line-height:1.55;color:' + mut + ';margin:0 0 12px}' +
    '.ob-bbar{position:fixed;z-index:100001;bottom:20px;left:0;right:0;display:flex;align-items:center;justify-content:space-between;padding:0 28px;opacity:0;transform:translateY(14px);transition:opacity .38s,transform .38s cubic-bezier(.34,1.3,.5,1);pointer-events:none}' +
    '.ob-bbar.on{opacity:1;transform:translateY(0);pointer-events:auto}' +
    '.ob-dots{display:flex;gap:5px;flex:1;justify-content:center}' +
    '.ob-dot{width:6px;height:6px;border-radius:99px;background:' + line + ';transition:all .3s}' +
    '.ob-dot.on{background:' + accent + ';width:16px}' +
    '.ob-skip{background:none;border:none;font-size:13px;color:' + mut + ';cursor:pointer;padding:6px 4px;border-radius:9px;font-family:inherit}' +
    '.ob-skip:hover{color:' + txt + '}' +
    '.ob-next{background:' + accent + ';color:' + accentTx + ';border:none;font-size:13px;font-weight:600;padding:9px 20px;border-radius:99px;cursor:pointer;font-family:inherit;transition:opacity .2s,transform .15s;}' +
    '.ob-next:hover{opacity:.88}' +
    '.ob-next:active{transform:scale(.96)}' +
    '.ob-opts{display:flex;flex-direction:column;gap:2px;margin:0 0 12px}' +
    '.ob-opt{display:flex;align-items:center;gap:11px;padding:8px 7px;border-radius:8px;cursor:pointer;font-size:13.5px;font-weight:600;color:' + mut + ';transition:color .15s}' +
    '.ob-opt:hover{color:' + txt + '}' +
    '.ob-opt.sel{color:' + txt + '}' +
    '.ob-radio{width:14px;height:14px;border-radius:99px;border:1.5px solid ' + mut + ';flex:none;transition:all .18s}' +
    '.ob-opt.sel .ob-radio{background:' + accent + ';border-color:' + accent + '}' +
    '.ob-next.ob-dis{opacity:.35;cursor:default}' +
    '.ob-next.ob-dis:hover{opacity:.35}' +
    '.ob-hint{font-size:12.5px;color:' + mut + ';padding:0 4px;animation:obBlink 1.8s ease-in-out infinite}' +
    '@keyframes obBlink{0%,100%{opacity:.55}50%{opacity:1}}';

  function start() {
    var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
    var pt = document.createElement('div'), pb = document.createElement('div'),
        pl = document.createElement('div'), pr = document.createElement('div');
    [pt, pb, pl, pr].forEach(function (p) { p.className = 'ob-p hid'; document.body.appendChild(p); });
    var ring = document.createElement('div'); ring.className = 'ob-ring'; document.body.appendChild(ring);
    var bub = document.createElement('div'); bub.className = 'ob-bub'; document.body.appendChild(bub);
    var bar = document.createElement('div'); bar.className = 'ob-bbar'; document.body.appendChild(bar);
    var cur = -1, curRef = null, live = null, done = false;
    var docEl = document.documentElement;

    function seqNow() { return path === 'tpl' ? [0, 6, 7, 8, 9, 10] : [0, 1, 2, 3, 4, 5]; }

    function positionPanels() {
      var W = window.innerWidth, H = window.innerHeight;
      if (!curRef) {
        pt.style.top = '0'; pt.style.height = H + 'px'; pt.style.left = '0'; pt.style.right = '0';
        pb.style.height = '0'; pl.style.width = '0'; pr.style.width = '0';
        return;
      }
      var r = curRef.getBoundingClientRect();
      pt.style.top = '0'; pt.style.height = Math.max(0, r.top) + 'px'; pt.style.left = '0'; pt.style.right = '0';
      pb.style.top = r.bottom + 'px'; pb.style.height = Math.max(0, H - r.bottom) + 'px'; pb.style.left = '0'; pb.style.right = '0';
      pl.style.top = r.top + 'px'; pl.style.height = r.height + 'px'; pl.style.left = '0'; pl.style.width = Math.max(0, r.left) + 'px';
      pr.style.top = r.top + 'px'; pr.style.height = r.height + 'px'; pr.style.left = r.right + 'px'; pr.style.width = Math.max(0, W - r.right) + 'px';
    }

    function finish(silent) {
      if (done) return; done = true;
      docEl.style.overflow = ''; curRef = null;
      clearState(); markDone();
      pt.classList.add('hid'); pb.classList.add('hid'); pl.classList.add('hid'); pr.classList.add('hid');
      ring.classList.remove('on'); bub.classList.remove('on'); bar.classList.remove('on');
      if (live) live.classList.remove('ob-live');
      setTimeout(function () { [pt, pb, pl, pr, ring, bub, bar].forEach(function (n) { n.remove(); }); }, 550);
    }

    function refOf(s) {
      if (s.refFn) return s.refFn();
      var ref = s.target ? document.querySelector(s.target) : null;
      if (ref && s.delegate) { var d = ref.querySelector(s.delegate); if (d) ref = d; }
      return ref;
    }

    function place(i) {
      var s = STEPS[i]; cur = i;
      if (live) live.classList.remove('ob-live');
      live = null;
      var ref = refOf(s);
      curRef = ref;
      positionPanels();

      if (ref) {
        ref.classList.add('ob-live'); live = ref;
        docEl.style.overflow = '';
        ref.scrollIntoView({ block: 'center', behavior: 'smooth' });
        setTimeout(function () { docEl.style.overflow = 'hidden'; positionPanels(); positionRing(); positionBub(); }, 480);
        ring.classList.add('on');
      } else { ring.classList.remove('on'); docEl.style.overflow = 'hidden'; }

      var SEQ = seqNow();
      var seqIdx = SEQ.indexOf(i);
      var dots = seqIdx === -1 ? '' : SEQ.map(function (_, j) { return '<span class="ob-dot' + (j === seqIdx ? ' on' : '') + '"></span>'; }).join('');

      var right = '';
      if (s.type === 'click') right = '<span class="ob-hint">Klik yang ditandai</span>';
      else right = '<button class="ob-next" type="button">' + (s.next || 'Lanjut') + '</button>';
      var choiceBtns = s.choices
        ? '<div class="ob-opts">' + s.choices.map(function (c) {
            return '<div class="ob-opt" data-go="' + c.go + '" role="button"><span class="ob-radio"></span><span>' + c.label + '</span></div>';
          }).join('') + '</div>'
        : '';
      bub.innerHTML =
        (s.kicker ? '<div class="ob-kicker">' + s.kicker + '</div>' : '') +
        '<h3 class="ob-title">' + s.title + '</h3>' +
        '<p class="ob-desc">' + s.desc + '</p>' +
        choiceBtns;
      bar.innerHTML = '<button class="ob-skip" type="button">Lewati</button><div class="ob-dots">' + dots + '</div>' + right;
      bar.querySelector('.ob-skip').onclick = function () { finish(); };
      var nx = bar.querySelector('.ob-next');
      if (nx) {
        if (s.choices) nx.classList.add('ob-dis');
        nx.onclick = function () {
          if (s.choices) return;
          if (s.go) { saveState(s.go, path); location.href = s.href(); return; }
          if (s.final) { finish(); return; }
          go(i + 1);
        };
      }
      if (s.choices) {
        var selGo = null;
        Array.prototype.forEach.call(bub.querySelectorAll('.ob-opt'), function (o) {
          o.onclick = function () {
            Array.prototype.forEach.call(bub.querySelectorAll('.ob-opt'), function (x) { x.classList.remove('sel'); });
            o.classList.add('sel');
            selGo = parseInt(o.getAttribute('data-go'), 10);
            path = selGo === 6 ? 'tpl' : 'buat';
            if (nx) nx.classList.remove('ob-dis');
          };
        });
        if (nx) nx.onclick = function () {
          if (selGo !== null) { saveState(selGo, path); go(selGo); }
        };
      }

      if (s.type === 'click' && ref) {
        ref.addEventListener('click', function () {
          if (s.nav) { saveState(s.next, path); return; } // navigasi antar halaman oleh aplikasi
          if (s.end) { finish(); return; }                // langkah terakhir: selesai saat tombol diklik
          setTimeout(function () { go(i + 1); }, 150);    // klik terarah satu halaman (mis. menu titik tiga)
        }, { once: true, capture: true });
      }

      requestAnimationFrame(function () { positionBub(); });
      setTimeout(function () {
        [pt, pb, pl, pr].forEach(function (p) { p.classList.remove('hid'); });
        bub.classList.add('on'); bar.classList.add('on');
      }, 20);
    }

    function positionRing() {
      if (!live) return;
      var r = live.getBoundingClientRect(), pad = 5;
      ring.style.left = (r.left - pad) + 'px';
      ring.style.top = (r.top - pad) + 'px';
      ring.style.width = (r.width + pad * 2) + 'px';
      ring.style.height = (r.height + pad * 2) + 'px';
    }

    function positionBub() {
      var s = STEPS[cur];
      if (!s) return;
      var ref = refOf(s);
      var bw = 290, bh = bub.offsetHeight || 150;
      if (!ref) {
        bub.style.left = Math.max(20, (window.innerWidth - bw) / 2) + 'px';
        bub.style.top = Math.max(20, (window.innerHeight - bh) / 2 - 40) + 'px';
        return;
      }
      var r = ref.getBoundingClientRect();
      var left = Math.max(16, Math.min(window.innerWidth - bw - 16, r.left + r.width / 2 - bw / 2));
      var top;
      if (window.innerHeight - r.bottom > bh + 40) { top = r.bottom + 14; }
      else { top = Math.max(16, r.top - bh - 14); }
      bub.style.left = left + 'px'; bub.style.top = top + 'px';
    }

    function go(i) {
      if (!STEPS[i]) { finish(); return; }
      bub.classList.remove('on'); bar.classList.remove('on');
      var s = STEPS[i];
      if (s.prepare) s.prepare();
      if (!s.nav) saveState(i, path);
      setTimeout(function () { place(i); }, 180);
    }

    var raf = null;
    function onMove() {
      if (raf) return;
      raf = requestAnimationFrame(function () { raf = null; positionPanels(); positionRing(); positionBub(); });
    }
    window.addEventListener('scroll', onMove, true);
    window.addEventListener('resize', onMove);

    setTimeout(function () { place(startStep); }, 900);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { setTimeout(start, 700); });
  else start();
})();
