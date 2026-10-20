/* ==========================================================================
   VYLONIUM — PORTFOLIO / interactions & animations
   ========================================================================== */
(function () {
  'use strict';

  /* ---------- Preloader + page fade ---------- */
  document.body.classList.add('loading');
  window.addEventListener('load', function () {
    setTimeout(function () {
      var pre = document.querySelector('.preloader');
      if (pre) pre.classList.add('done');
      document.body.classList.remove('loading');
      document.body.classList.add('ready');
    }, 400);
  });
  /* fallback in case load already fired */
  setTimeout(function () {
    document.body.classList.add('ready');
    var pre = document.querySelector('.preloader');
    if (pre) pre.classList.add('done');
  }, 2500);

  /* ---------- Sticky header ---------- */
  var header = document.querySelector('.site-header');
  var progress = document.querySelector('.scroll-progress');
  var toTop = document.querySelector('.to-top');

  function onScroll() {
    var y = window.scrollY;
    if (header) header.classList.toggle('scrolled', y > 40);
    if (progress) {
      var h = document.documentElement.scrollHeight - window.innerHeight;
      progress.style.width = (h > 0 ? (y / h) * 100 : 0) + '%';
    }
    if (toTop) toTop.classList.toggle('show', y > 600);
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  if (toTop) {
    toTop.addEventListener('click', function () {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  }

  /* ---------- Mobile drawer ---------- */
  var toggle = document.querySelector('.menu-toggle');
  var drawer = document.querySelector('.nav-drawer');
  if (toggle && drawer) {
    toggle.addEventListener('click', function () {
      var open = drawer.classList.toggle('open');
      toggle.classList.toggle('open', open);
      if (header) header.classList.toggle('nav-open', open);
      document.body.style.overflow = open ? 'hidden' : '';
    });
    drawer.querySelectorAll('a').forEach(function (a) {
      a.addEventListener('click', function () {
        drawer.classList.remove('open');
        toggle.classList.remove('open');
        document.body.style.overflow = '';
      });
    });
  }

  /* ---------- Reveal on scroll ---------- */
  var revealEls = document.querySelectorAll('[data-reveal]');
  if ('IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) {
          e.target.classList.add('revealed');
          io.unobserve(e.target);
        }
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });
    revealEls.forEach(function (el) { io.observe(el); });
  } else {
    revealEls.forEach(function (el) { el.classList.add('revealed'); });
  }

  /* ---------- Typing rotator ---------- */
  var typed = document.querySelector('.typed');
  if (typed) {
    var phrases = JSON.parse(typed.getAttribute('data-words') || '[]');
    if (!phrases.length) phrases = ['Full-Stack Developer'];
    var pi = 0, ci = 0, deleting = false;
    (function type() {
      var word = phrases[pi];
      typed.textContent = word.slice(0, ci);
      var delay = deleting ? 38 : 75;
      if (!deleting && ci === word.length) { delay = 1800; deleting = true; }
      else if (deleting && ci === 0) { deleting = false; pi = (pi + 1) % phrases.length; delay = 350; }
      else ci += deleting ? -1 : 1;
      setTimeout(type, delay);
    })();
  }

  /* ---------- Count-up stats ---------- */
  var counters = document.querySelectorAll('[data-count]');
  if (counters.length && 'IntersectionObserver' in window) {
    var co = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (!e.isIntersecting) return;
        co.unobserve(e.target);
        var el = e.target;
        var target = parseFloat(el.getAttribute('data-count'));
        var suffix = el.getAttribute('data-suffix') || '';
        var dur = 1600, start = null;
        function step(ts) {
          if (!start) start = ts;
          var p = Math.min((ts - start) / dur, 1);
          var eased = 1 - Math.pow(1 - p, 3);
          el.textContent = Math.round(target * eased) + (p === 1 ? suffix : '');
          if (p < 1) requestAnimationFrame(step);
        }
        requestAnimationFrame(step);
      });
    }, { threshold: 0.6 });
    counters.forEach(function (el) { co.observe(el); });
  }

  /* ---------- Project filters ---------- */
  var filterBtns = document.querySelectorAll('.filters button');
  var rows = document.querySelectorAll('.work-row[data-cat]');
  filterBtns.forEach(function (btn) {
    btn.addEventListener('click', function () {
      filterBtns.forEach(function (b) { b.classList.remove('active'); });
      btn.classList.add('active');
      var cat = btn.getAttribute('data-filter');
      rows.forEach(function (row, i) {
        var match = cat === 'all' || row.getAttribute('data-cat').indexOf(cat) !== -1;
        row.classList.remove('pop');
        if (match) {
          row.classList.remove('hidden-row');
          void row.offsetWidth; /* restart animation */
          row.style.animationDelay = (i * 60) + 'ms';
          row.classList.add('pop');
        } else {
          row.classList.add('hidden-row');
        }
      });
    });
  });

  /* ---------- Subtle tilt on media ---------- */
  document.querySelectorAll('.work-media').forEach(function (m) {
    m.addEventListener('mousemove', function (ev) {
      var r = m.getBoundingClientRect();
      var x = (ev.clientX - r.left) / r.width - 0.5;
      var y = (ev.clientY - r.top) / r.height - 0.5;
      m.style.transform = 'perspective(900px) rotateY(' + x * 4 + 'deg) rotateX(' + -y * 4 + 'deg)';
    });
    m.addEventListener('mouseleave', function () {
      m.style.transform = '';
    });
    m.style.transition = 'transform .5s cubic-bezier(0.22,1,0.36,1)';
  });

  /* ---------- Footer year ---------- */
  var yr = document.querySelector('[data-year]');
  if (yr) yr.textContent = new Date().getFullYear();

  /* ---------- Contact form (demo submit) ---------- */
  var form = document.querySelector('.contact-form');
  if (form) {
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var btn = form.querySelector('button[type="submit"]');
      var note = form.querySelector('.form-note');
      if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }
      setTimeout(function () {
        if (note) { note.textContent = '✔ Thank you — your message has been recorded. I will reply within 1–2 business days.'; note.style.color = '#1a7f37'; }
        if (btn) { btn.disabled = false; btn.textContent = 'Send Message'; }
        form.reset();
      }, 900);
    });
  }
})();
