/* Clincoo Bug — card bulat geser + console polos + laporkan ke WA */
(() => {
  if (window.__clincooBugInstalled) return;
  window.__clincooBugInstalled = true;
  window.__clincooBugBeetleLoaded = true;

  const MAX = 80;
  const logs = [];
  const WA = '6283849297259';
  const posKey = 'clincoo-bug-pos';

  const BEETLE =
    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M12 20v-9"/><path d="M14 7a4 4 0 0 1 4 4v3a6 6 0 0 1-12 0v-3a4 4 0 0 1 4-4z"/><path d="M14.12 3.88 16 2"/><path d="M21 21a4 4 0 0 0-3.81-4"/><path d="M21 5a4 4 0 0 1-3.55 3.97"/><path d="M22 13h-4"/><path d="M3 21a4 4 0 0 1 3.81-4"/><path d="M3 5a4 4 0 0 0 3.55 3.97"/><path d="M6 13H2"/><path d="m8 2 1.88 1.88"/><path d="M9 7.13V6a3 3 0 1 1 6 0v1.13"/>' +
    '</svg>';

  const toText = (v) => {
    if (v instanceof Error) return (v.name || 'Error') + ': ' + (v.message || '') + (v.stack ? '\n' + v.stack : '');
    if (typeof v === 'string') return v;
    try { return JSON.stringify(v); } catch { return String(v); }
  };

  function add(level, args) {
    const msg = Array.isArray(args) ? args.map(toText).join(' ') : toText(args);
    logs.push({ t: new Date().toLocaleTimeString('id-ID', { hour12: false }), level, msg });
    if (logs.length > MAX) logs.shift();
    render();
  }

  try {
    const saved = JSON.parse(localStorage.getItem('clincoo_bug_beetle_recent') || '[]');
    if (Array.isArray(saved)) {
      saved.slice(-40).forEach((l) => {
        logs.push({ t: l.time || '', level: l.level || 'error', msg: l.message || '' });
      });
    }
  } catch (_) {}

  const oldErr = console.error.bind(console);
  console.error = (...a) => { try { add('error', a); } catch (_) {} return oldErr(...a); };
  const oldWarn = console.warn.bind(console);
  console.warn = (...a) => { try { add('warn', a); } catch (_) {} return oldWarn(...a); };
  window.addEventListener('error', (e) => {
    if (e && e.target && e.target !== window) {
      const t = e.target;
      add('error', 'Resource gagal: ' + (t.src || t.href || t.tagName || '?'));
      return;
    }
    add('error', (e.message || 'JS error') + (e.filename ? ' @ ' + e.filename + (e.lineno ? ':' + e.lineno : '') : '') + (e.error && e.error.stack ? '\n' + e.error.stack : ''));
  }, true);
  window.addEventListener('unhandledrejection', (e) => add('error', 'Unhandled rejection: ' + toText(e.reason)));

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

  function applyTheme() {
    root.dataset.theme = isDarkBg() ? 'dark' : 'light';
  }

  const style = document.createElement('style');
  style.id = 'clincoo-bug-style';
  style.textContent = `
    #clincoo-bug-root{position:fixed;z-index:2147483000;right:20px;bottom:20px;isolation:isolate}
    #clincoo-bug-fab{
      width:56px;height:56px;border-radius:50%;border:2px solid var(--cb-border);
      display:grid;place-items:center;cursor:grab;touch-action:none;user-select:none;
      background:var(--cb-fab-bg);color:var(--cb-fg);box-shadow:0 8px 28px rgba(0,0,0,.16);
      padding:0;transition:transform .15s,box-shadow .15s
    }
    #clincoo-bug-fab:hover{transform:scale(1.05);box-shadow:0 12px 34px rgba(0,0,0,.2)}
    #clincoo-bug-fab:active{cursor:grabbing}
    #clincoo-bug-fab svg{width:24px;height:24px;pointer-events:none}
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
    .cb-top{display:flex;align-items:center;justify-content:flex-end;padding:8px 10px 0;flex-shrink:0}
    .cb-close{border:0;background:transparent;color:var(--cb-muted);font-size:18px;cursor:pointer;line-height:1;padding:2px 6px;border-radius:6px}
    .cb-close:hover{color:var(--cb-fg);background:rgba(127,127,127,.12)}
    .cb-logs{overflow:auto;flex:1;min-height:120px;padding:4px 14px 12px;white-space:pre-wrap;overflow-wrap:anywhere}
    .cb-row{padding:6px 0;border-bottom:1px solid var(--cb-line)}
    .cb-row:last-of-type{border-bottom:0}
    .cb-time{color:var(--cb-muted);margin-right:6px}
    .cb-lvl{font-weight:700;margin-right:6px}
    .cb-lvl.error{color:var(--cb-err)}.cb-lvl.warn{color:var(--cb-warn)}.cb-lvl.info{color:var(--cb-accent)}
    .cb-empty{color:var(--cb-muted);font:12px/1.55 Inter,ui-sans-serif,system-ui,sans-serif;padding:8px 0 4px}
    .cb-foot{flex-shrink:0;padding:10px 14px 12px;border-top:1px solid var(--cb-line);font:12px/1.5 Inter,ui-sans-serif,system-ui,sans-serif}
    .cb-report{color:var(--cb-accent);text-decoration:underline;text-underline-offset:2px;cursor:pointer;font-weight:500}
    .cb-report:hover{opacity:.85}
    @media(max-width:480px){
      #clincoo-bug-root{right:12px;bottom:12px}
      #clincoo-bug-fab{width:50px;height:50px}
      #clincoo-bug-panel{right:8px;bottom:74px;width:calc(100vw - 16px);border-radius:.75rem}
    }
  `;
  document.head.appendChild(style);

  const root = document.createElement('div');
  root.id = 'clincoo-bug-root';
  root.innerHTML =
    '<button id="clincoo-bug-fab" type="button" title="Seret · klik untuk log" aria-label="Console error" aria-expanded="false">' +
    BEETLE +
    '</button>' +
    '<section id="clincoo-bug-panel" role="dialog" aria-label="Console error">' +
    '<div class="cb-top"><button type="button" class="cb-close" aria-label="Tutup">×</button></div>' +
    '<div class="cb-logs" id="clincoo-bug-logs"></div>' +
    '<div class="cb-foot"><a class="cb-report" id="clincoo-bug-report" href="#" target="_blank" rel="noopener noreferrer">laporkan</a></div>' +
    '</section>';
  (document.body || document.documentElement).appendChild(root);
  applyTheme();

  const fab = document.getElementById('clincoo-bug-fab');
  const panel = document.getElementById('clincoo-bug-panel');
  const logsEl = document.getElementById('clincoo-bug-logs');
  const report = document.getElementById('clincoo-bug-report');

  function formatReport() {
    const lines = logs.slice(-50).map((l) => '[' + l.t + '] ' + l.level.toUpperCase() + '  ' + l.msg);
    return [
      'LAPORAN ERROR CLINCOO',
      'Waktu: ' + new Date().toLocaleString('id-ID'),
      'Halaman: ' + location.href,
      'Browser: ' + navigator.userAgent,
      '',
      lines.length ? lines.join('\n\n') : 'Belum ada error tertangkap.'
    ].join('\n');
  }

  function esc(s) {
    const d = document.createElement('div');
    d.appendChild(document.createTextNode(String(s)));
    return d.innerHTML;
  }

  function render() {
    if (!logs.length) {
      logsEl.innerHTML = '<div class="cb-empty">Belum ada error.</div>';
    } else {
      logsEl.innerHTML = logs.slice(-50).map((l) => {
        const lvl = l.level === 'error' ? 'error' : (l.level === 'warn' || l.level === 'warning' ? 'warn' : 'info');
        return '<div class="cb-row"><span class="cb-time">' + esc(l.t) + '</span><span class="cb-lvl ' + lvl + '">' + esc(lvl.toUpperCase()) + '</span><span>' + esc(l.msg) + '</span></div>';
      }).join('');
    }
    report.href = 'https://wa.me/' + WA + '?text=' + encodeURIComponent(formatReport().slice(0, 3500));
    if (panel.classList.contains('open')) logsEl.scrollTop = logsEl.scrollHeight;
  }

  function openPanel(on) {
    const open = typeof on === 'boolean' ? on : !panel.classList.contains('open');
    panel.classList.toggle('open', open);
    fab.setAttribute('aria-expanded', String(open));
    if (open) { applyTheme(); render(); }
  }

  panel.querySelector('.cb-close').addEventListener('click', () => openPanel(false));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') openPanel(false); });
  document.addEventListener('pointerdown', (e) => {
    if (panel.classList.contains('open') && !panel.contains(e.target) && !fab.contains(e.target)) openPanel(false);
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
  function endDrag() {
    if (!dragging) return;
    dragging = false;
    if (dragged) {
      const r = fab.getBoundingClientRect();
      try { localStorage.setItem(posKey, JSON.stringify({ x: r.left, y: r.top })); } catch (_) {}
    }
  }
  fab.addEventListener('pointerup', endDrag);
  fab.addEventListener('pointercancel', endDrag);
  fab.addEventListener('click', () => {
    if (dragged) { dragged = false; return; }
    openPanel();
  });

  window.addEventListener('resize', () => {
    const r = fab.getBoundingClientRect();
    fab.style.left = Math.max(4, Math.min(innerWidth - fab.offsetWidth - 4, r.left)) + 'px';
    fab.style.top = Math.max(4, Math.min(innerHeight - fab.offsetHeight - 4, r.top)) + 'px';
  });

  render();
})();
