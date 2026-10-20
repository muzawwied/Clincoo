/* Clincoo Bug — console error: tangkap dini + persist + badge + fetch-fail + iframe forward */
(() => {
  const inFrame = (() => { try { return window.top && window.top !== window.self; } catch (e) { return true; } })();
  if (window.__clincooBugInstalled || window.__clincooBugBeetleLoaded) return;
  window.__clincooBugInstalled = true;
  window.__clincooBugBeetleLoaded = true;

  const MAX = 80;
  const logs = [];
  const WA = '6283849297259';
  const posKey = 'clincoo-bug-pos';
  const storeKey = 'clincoo_bug_beetle_recent';
  let saveT = null, unseen = 0;

  const BEETLE =
    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M12 20v-9"/><path d="M14 7a4 4 0 0 1 4 4v3a6 6 0 0 1-12 0v-3a4 4 0 0 1 4-4z"/><path d="M14.12 3.88 16 2"/><path d="M21 21a4 4 0 0 0-3.81-4"/><path d="M21 5a4 4 0 0 1-3.55 3.97"/><path d="M22 13h-4"/><path d="M3 21a4 4 0 0 1 3.81-4"/><path d="M3 5a4 4 0 0 0 3.55 3.97"/><path d="M6 13H2"/><path d="m8 2 1.88 1.88"/><path d="M9 7.13V6a3 3 0 1 1 6 0v1.13"/>' +
    '</svg>';

  const toText = (v) => {
    if (v instanceof Error) return (v.name || 'Error') + ': ' + (v.message || '') + (v.stack ? '\n' + v.stack : '');
    if (typeof v === 'string') return v;
    try { return JSON.stringify(v); } catch { return String(v); }
  };

  // ---- MODE IFRAME: tanpa widget visual — pasang hook, teruskan log ke halaman induk ----
  if (inFrame) {
    const fwd = (level, msg) => { try { window.parent.postMessage({ type: 'ccbug', level, msg }, '*'); } catch (_) {} };
    const fe = console.error.bind(console);
    console.error = (...a) => { try { fwd('error', a.map(toText).join(' ').slice(0, 800)); } catch (_) {} return fe(...a); };
    const fw = console.warn.bind(console);
    console.warn = (...a) => { try { fwd('warn', a.map(toText).join(' ').slice(0, 800)); } catch (_) {} return fw(...a); };
    window.addEventListener('error', (e) => {
      if (e && e.target && e.target !== window) fwd('error', 'Resource gagal: ' + (e.target.src || e.target.href || e.target.tagName || '?'));
      else fwd('error', (e.message || 'JS error') + (e.filename ? ' @ ' + e.filename + (e.lineno ? ':' + e.lineno : '') : ''));
    }, true);
    window.addEventListener('unhandledrejection', (e) => fwd('error', 'Unhandled rejection: ' + toText(e.reason).slice(0, 800)));
    try {
      const of = window.fetch;
      if (typeof of === 'function') window.fetch = (input, init) => {
        let u = ''; try { u = typeof input === 'string' ? input : (input && input.url) || ''; if (u.length > 160) u = u.slice(0, 157) + '...'; } catch (_) {}
        return of.call(window, input, init).then(
          (res) => { try { if (res && res.status >= 400) fwd('warn', 'Fetch ' + res.status + ' · ' + u); } catch (_) {} return res; },
          (err) => { fwd('error', 'Fetch gagal · ' + u + ' · ' + toText(err).slice(0, 300)); throw err; }
        );
      };
    } catch (_) {}
    return;
  }

  // ---- MODE UTAMA (halaman induk) ----
  const add = (level, msgRaw) => {
    let msg = String(msgRaw == null ? '' : msgRaw);
    if (msg.length > 1500) msg = msg.slice(0, 1497) + '...';
    const last = logs[logs.length - 1];
    if (last && last.level === level && last.msg === msg) { last.n = (last.n || 1) + 1; last.t = new Date().toLocaleTimeString('id-ID', { hour12: false }); render(); return; }
    logs.push({ t: new Date().toLocaleTimeString('id-ID', { hour12: false }), level, msg });
    if (logs.length > MAX) logs.shift();
    persistSoon();
    if (level === 'error' && panelEl && !panelEl.classList.contains('open')) bumpBadge();
    render();
  };
  const persistSoon = () => {
    if (saveT) clearTimeout(saveT);
    saveT = setTimeout(() => {
      try { localStorage.setItem(storeKey, JSON.stringify(logs.slice(-40).map((l) => ({ time: l.t, level: l.level, message: l.msg + (l.n ? ' ×' + l.n : '') })))); } catch (_) {}
    }, 400);
  };

  // [21 Okt] muat log tersimpan (bertahan lintas reload)
  try {
    const saved = JSON.parse(localStorage.getItem(storeKey) || '[]');
    if (Array.isArray(saved)) saved.slice(-40).forEach((l) => logs.push({ t: l.time || '', level: l.level || 'error', msg: l.message || '' }));
  } catch (_) {}
  // [21 Okt] serap log yang tertangkap SEBELUM widget jalan (snippet head via middleware)
  try {
    (window.__ccBugEarlyLogs || []).forEach((l) => logs.push({ t: l.time || '', level: l.level || 'error', msg: (l.early ? '[awal] ' : '') + (l.message || '') }));
  } catch (_) {}

  const oldErr = console.error.bind(console);
  console.error = (...a) => { try { add('error', a.map(toText).join(' ')); } catch (_) {} return oldErr(...a); };
  const oldWarn = console.warn.bind(console);
  console.warn = (...a) => { try { add('warn', a.map(toText).join(' ')); } catch (_) {} return oldWarn(...a); };
  window.addEventListener('error', (e) => {
    if (e && e.target && e.target !== window) {
      const t = e.target;
      add('error', 'Resource gagal: ' + (t.src || t.href || t.tagName || '?'));
      return;
    }
    add('error', (e.message || 'JS error') + (e.filename ? ' @ ' + e.filename + (e.lineno ? ':' + e.lineno : '') : '') + (e.error && e.error.stack ? '\n' + e.error.stack : ''));
  }, true);
  window.addEventListener('unhandledrejection', (e) => add('error', 'Unhandled rejection: ' + toText(e.reason)));
  // [21 Okt] terima log dari halaman/frame yang di-embed (mis. chat di workspace)
  window.addEventListener('message', (e) => {
    const d = e && e.data;
    if (d && d.type === 'ccbug' && d.level) add(d.level, '[frame] ' + String(d.msg || ''));
  });
  // setelah widget aktif: snippet awal berhenti mencatat (anti dobel)
  window.__ccBugActive = true;

  function isDarkBg() {
    const nodes = [document.body, document.documentElement];
    let bg = 'rgb(255,255,255)';
    for (const n of nodes) {
      if (!n) continue;
      const c = getComputedStyle(n).backgroundColor;
      if (c && c !== 'transparent' && c !== 'rgba(0, 0, 0, 0)') { bg = c; break; }
    }
    const m = (bg.match(/[\d.]+/g) || [255, 255, 255]).slice(0, 3).map(Number);
    const lum = (0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2]) / 255;
    return lum > 0.52;
  }

  const style = document.createElement('style');
  style.id = 'clincoo-bug-style';
  style.textContent = `
    #clincoo-bug-root{position:fixed;z-index:2147483000;right:20px;bottom:20px;isolation:isolate}
    #clincoo-bug-fab{
      width:56px;height:56px;border-radius:50%;border:0;position:relative;
      display:grid;place-items:center;cursor:grab;touch-action:none;user-select:none;
      background:var(--cb-fab-bg);color:var(--cb-fg);box-shadow:0 8px 28px rgba(0,0,0,.16);
      padding:0;transition:transform .15s,box-shadow .15s
    }
    #clincoo-bug-fab:hover{transform:scale(1.05);box-shadow:0 12px 34px rgba(0,0,0,.2)}
    #clincoo-bug-fab:active{cursor:grabbing}
    #clincoo-bug-fab svg{width:24px;height:24px;pointer-events:none}
    #clincoo-bug-badge{
      position:absolute;top:-5px;right:-5px;min-width:19px;height:19px;border-radius:10px;
      background:#ef4444;color:#fff;font:700 11px/19px Inter,ui-sans-serif,system-ui,sans-serif;
      display:none;place-items:center;padding:0 5px;box-shadow:0 2px 8px rgba(0,0,0,.35);pointer-events:none
    }
    #clincoo-bug-root.cb-new #clincoo-bug-fab{animation:cbPulse .55s ease 2}
    @keyframes cbPulse{0%{transform:scale(1)}35%{transform:scale(1.18)}100%{transform:scale(1)}}
    #clincoo-bug-root[data-theme="dark"]{
      --cb-fab-bg:#111827;--cb-fg:#f9fafb;--cb-border:#e5e7eb;
      --cb-panel:#111827;--cb-line:#374151;--cb-muted:#9ca3af;--cb-accent:#6ee7b7;--cb-err:#fb7185;--cb-warn:#fbbf24
    }
    #clincoo-bug-root[data-theme="light"]{
      --cb-fab-bg:#f9fafb;--cb-fg:#111827;--cb-border:#111827;
      --cb-panel:#ffffff;--cb-line:#e5e7eb;--cb-muted:#6b7280;--cb-accent:#047857;--cb-err:#dc2626;--cb-warn:#d97706
    }
    #clincoo-bug-panel{
      position:fixed;right:16px;bottom:88px;width:min(380px,calc(100vw - 24px));
      max-height:min(58vh,480px);display:none;flex-direction:column;overflow:hidden;
      background:var(--cb-panel);color:var(--cb-fg);
      border:1px solid var(--cb-line);border-radius:1rem;
      box-shadow:0 18px 50px rgba(0,0,0,.2);
      font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace
    }
    #clincoo-bug-panel.open{display:flex}
    #clincoo-bug-panel *{box-sizing:border-box}
    .cb-top{display:flex;align-items:center;justify-content:space-between;padding:8px 10px 0 14px;flex-shrink:0;font:600 11px/1.4 Inter,ui-sans-serif,system-ui,sans-serif;color:var(--cb-muted)}
    .cb-close{border:0;background:transparent;color:var(--cb-muted);font-size:18px;cursor:pointer;line-height:1;padding:2px 6px;border-radius:6px}
    .cb-close:hover{color:var(--cb-fg);background:rgba(127,127,127,.12)}
    .cb-logs{overflow:auto;flex:1;min-height:120px;padding:4px 14px 12px;white-space:pre-wrap;overflow-wrap:anywhere}
    .cb-row{padding:6px 0;border-bottom:1px solid var(--cb-line)}
    .cb-row:last-of-type{border-bottom:0}
    .cb-time{color:var(--cb-muted);margin-right:6px}
    .cb-lvl{font-weight:700;margin-right:6px}
    .cb-lvl.error{color:var(--cb-err)}.cb-lvl.warn{color:var(--cb-warn)}.cb-lvl.info{color:var(--cb-accent)}
    .cb-n{color:var(--cb-muted);font-weight:700;margin-left:5px}
    .cb-empty{color:var(--cb-muted);font:12px/1.55 Inter,ui-sans-serif,system-ui,sans-serif;padding:8px 0 4px}
    .cb-foot{flex-shrink:0;padding:10px 14px 12px;border-top:1px solid var(--cb-line);font:12px/1.5 Inter,ui-sans-serif,system-ui,sans-serif}
    .cb-report{color:var(--cb-accent);text-decoration:underline;text-underline-offset:2px;cursor:pointer;font-weight:500}
    .cb-report:hover{opacity:.85}
    .cb-clear{float:right;color:var(--cb-muted);cursor:pointer;text-decoration:underline;text-underline-offset:2px}
    .cb-clear:hover{color:var(--cb-fg)}
    @media(max-width:480px){
      #clincoo-bug-root{right:12px;bottom:12px}
      #clincoo-bug-fab{width:50px;height:50px}
      #clincoo-bug-panel{right:8px;bottom:74px;width:calc(100vw - 16px);border-radius:.75rem}
    }
  `;
  document.head.appendChild(style);

  const stale = document.getElementById('clincoo-bug-root');
  if (stale && stale.parentNode) stale.parentNode.removeChild(stale);
  const root = document.createElement('div');
  root.id = 'clincoo-bug-root';
  root.innerHTML =
    '<button id="clincoo-bug-fab" type="button" title="Seret · klik untuk log" aria-label="Console error" aria-expanded="false">' +
    BEETLE + '<span id="clincoo-bug-badge"></span>' +
    '</button>' +
    '<section id="clincoo-bug-panel" role="dialog" aria-label="Console error">' +
    '<div class="cb-top"><span id="clincoo-bug-count">0 kejadian</span><button type="button" class="cb-close" aria-label="Tutup">×</button></div>' +
    '<div class="cb-logs" id="clincoo-bug-logs"></div>' +
    '<div class="cb-foot"><a class="cb-report" id="clincoo-bug-report" href="#" target="_blank" rel="noopener noreferrer">laporkan</a><span class="cb-clear" id="clincoo-bug-clear">bersihkan</span></div>' +
    '</section>';
  (document.body || document.documentElement).appendChild(root);
  const applyTheme = () => { root.dataset.theme = isDarkBg() ? 'dark' : 'light'; };
  applyTheme();

  const fab = document.getElementById('clincoo-bug-fab');
  const panelEl = document.getElementById('clincoo-bug-panel');
  const logsEl = document.getElementById('clincoo-bug-logs');
  const report = document.getElementById('clincoo-bug-report');
  const badge = document.getElementById('clincoo-bug-badge');
  const countEl = document.getElementById('clincoo-bug-count');

  const bumpBadge = () => {
    unseen++;
    badge.textContent = unseen > 99 ? '99+' : String(unseen);
    badge.style.display = 'grid';
    root.classList.remove('cb-new');
    try { void root.offsetWidth; } catch (_) {}
    root.classList.add('cb-new');
  };

  function formatReport() {
    const lines = logs.slice(-50).map((l) => '[' + l.t + '] ' + l.level.toUpperCase() + '  ' + l.msg + (l.n ? ' (×' + l.n + ')' : ''));
    return [
      'LAPORAN ERROR CLINCOO',
      'Waktu: ' + new Date().toLocaleString('id-ID'),
      'Halaman: ' + location.href,
      'Browser: ' + navigator.userAgent,
      '',
      lines.length ? lines.join('\n\n') : 'Belum ada error tertangkap.'
    ].join('\n');
  }

  const esc = (s) => { const d = document.createElement('div'); d.appendChild(document.createTextNode(String(s))); return d.innerHTML; };

  function render() {
    if (!logs.length) {
      logsEl.innerHTML = '<div class="cb-empty">Belum ada error tertangkap.</div>';
    } else {
      logsEl.innerHTML = logs.slice(-60).map((l) => {
        const lvl = l.level === 'error' ? 'error' : (l.level === 'warn' || l.level === 'warning' ? 'warn' : 'info');
        return '<div class="cb-row"><span class="cb-time">' + esc(l.t) + '</span><span class="cb-lvl ' + lvl + '">' + esc(lvl.toUpperCase()) + '</span><span>' + esc(l.msg) + '</span>' + (l.n ? '<span class="cb-n">×' + esc(l.n) + '</span>' : '') + '</div>';
      }).join('');
    }
    countEl.textContent = logs.length + ' kejadian';
    report.href = 'https://wa.me/' + WA + '?text=' + encodeURIComponent(formatReport().slice(0, 3500));
    if (panelEl.classList.contains('open')) logsEl.scrollTop = logsEl.scrollHeight;
  }

  function openPanel(on) {
    const open = typeof on === 'boolean' ? on : !panelEl.classList.contains('open');
    panelEl.classList.toggle('open', open);
    fab.setAttribute('aria-expanded', String(open));
    if (open) { applyTheme(); unseen = 0; badge.style.display = 'none'; root.classList.remove('cb-new'); render(); }
  }

  panelEl.querySelector('.cb-close').addEventListener('click', () => openPanel(false));
  document.getElementById('clincoo-bug-clear').addEventListener('click', () => {
    logs.length = 0; persistSoon(); render();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') openPanel(false); });
  document.addEventListener('pointerdown', (e) => {
    if (panelEl.classList.contains('open') && !panelEl.contains(e.target) && !fab.contains(e.target)) openPanel(false);
  });

  let dragging = false, dragged = false, sx = 0, sy = 0, ox = 0, oy = 0;
  try {
    const p = JSON.parse(localStorage.getItem(posKey) || 'null');
    if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) {
      fab.style.left = Math.max(4, Math.min(innerWidth - 56, p.x)) + 'px';
      fab.style.top = Math.max(4, Math.min(innerHeight - 56, p.y)) + 'px';
      fab.style.right = 'auto'; fab.style.bottom = 'auto';
      root.style.right = 'auto'; root.style.bottom = 'auto';
      root.style.left = fab.style.left; root.style.top = fab.style.top;
    }
  } catch (_) {}

  fab.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    dragging = true; dragged = false;
    sx = e.clientX; sy = e.clientY;
    const r = fab.getBoundingClientRect(); ox = r.left; oy = r.top;
    try { fab.setPointerCapture(e.pointerId); } catch (_) {}
  });
  fab.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const dx = e.clientX - sx, dy = e.clientY - sy;
    if (Math.abs(dx) + Math.abs(dy) > 5) dragged = true;
    if (!dragged) return;
    const x = Math.max(4, Math.min(innerWidth - fab.offsetWidth - 4, ox + dx));
    const y = Math.max(4, Math.min(innerHeight - fab.offsetHeight - 4, oy + dy));
    fab.style.left = x + 'px'; fab.style.top = y + 'px'; fab.style.right = 'auto'; fab.style.bottom = 'auto';
    root.style.left = x + 'px'; root.style.top = y + 'px'; root.style.right = 'auto'; root.style.bottom = 'auto';
  });
  const endDrag = () => {
    if (!dragging) return;
    dragging = false;
    if (dragged) {
      const r = fab.getBoundingClientRect();
      try { localStorage.setItem(posKey, JSON.stringify({ x: r.left, y: r.top })); } catch (_) {}
    }
  };
  fab.addEventListener('pointerup', endDrag);
  fab.addEventListener('pointercancel', endDrag);
  fab.addEventListener('click', () => { if (dragged) { dragged = false; return; } openPanel(); });

  window.addEventListener('resize', () => {
    const r = fab.getBoundingClientRect();
    fab.style.left = Math.max(4, Math.min(innerWidth - fab.offsetWidth - 4, r.left)) + 'px';
    fab.style.top = Math.max(4, Math.min(innerHeight - fab.offsetHeight - 4, r.top)) + 'px';
  });

  // [21 Okt] kegagalan fetch/API dicatat juga (401/500/network) — sumber masalah paling umum
  try {
    const of = window.fetch;
    if (typeof of === 'function') {
      window.fetch = function (input, init) {
        let u = '';
        try { u = typeof input === 'string' ? input : (input && input.url) || ''; if (u.length > 160) u = u.slice(0, 157) + '...'; } catch (_) {}
        return of.call(window, input, init).then(
          (res) => { try { if (res && res.status >= 400) add('warn', 'Fetch ' + res.status + ' · ' + (res.statusText || '') + ' · ' + u); } catch (_) {} return res; },
          (err) => { add('error', 'Fetch gagal (network) · ' + u + ' · ' + toText(err).slice(0, 300)); throw err; }
        );
      };
    }
  } catch (_) {}

  render();
})();
