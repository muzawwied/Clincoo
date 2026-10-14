(() => {
  // Remove any stale copies, then install exactly one widget instance.
  document.querySelectorAll('#clincoo-bug-fab, #clincoo-bug-panel, #clincoo-bug-style').forEach(node => node.remove());
  if (window.__clincooBugInstalled) return;
  window.__clincooBugInstalled = true;

  const logs = [];
  const MAX_LOGS = 80;
  const addLog = (type, args) => {
    const message = Array.from(args).map(value => {
      if (value instanceof Error) return value.stack || value.message;
      if (typeof value === 'string') return value;
      try { return JSON.stringify(value); } catch { return String(value); }
    }).join(' ').slice(0, 1800);
    logs.push({ type, message, time: new Date().toLocaleTimeString() });
    if (logs.length > MAX_LOGS) logs.shift();
  };

  window.addEventListener('error', event => addLog('error', [event.message, event.filename, event.lineno ? ':' + event.lineno : '']));
  window.addEventListener('unhandledrejection', event => addLog('error', ['Unhandled promise rejection:', event.reason]));

  const style = document.createElement('style');
  style.id = 'clincoo-bug-style';
  style.textContent = `
    #clincoo-bug-fab{position:fixed;z-index:2147483000;width:54px;height:54px;border:1px solid rgba(127,127,127,.35);border-radius:50%;display:grid;place-items:center;cursor:grab;touch-action:none;user-select:none;background:Canvas;color:CanvasText;box-shadow:0 5px 24px #0003;transition:box-shadow .15s,transform .15s}
    #clincoo-bug-fab:hover{box-shadow:0 8px 28px #0004;transform:scale(1.04)}
    #clincoo-bug-fab svg{width:29px;height:29px}
    #clincoo-bug-panel{position:fixed;z-index:2147483001;right:20px;bottom:86px;width:min(430px,calc(100vw - 28px));max-height:min(520px,72vh);display:none;flex-direction:column;background:#111318;color:#e6e8ee;border:1px solid #393d49;border-radius:16px;box-shadow:0 16px 60px #0006;font:13px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;overflow:hidden}
    #clincoo-bug-panel.open{display:flex}
    #clincoo-bug-panel *{box-sizing:border-box}
    .clb-head{display:none}
    .clb-status{display:none}
    .clb-close{background:transparent;color:#ddd;border:0;font-size:22px;cursor:pointer}
    .clb-logs{overflow:auto;padding:10px;min-height:100px;flex:1}
    .clb-entry{padding:8px 9px;margin-bottom:7px;border-radius:7px;background:#1a1d25;white-space:pre-wrap;overflow-wrap:anywhere}
    .clb-entry.error{border-left:3px solid #ff646e}.clb-entry.warn{border-left:3px solid #f4c66a}
    .clb-time{color:#9299a9;font-size:10px;margin-right:8px}.clb-empty{display:none}
    .clb-foot{padding:8px 10px;display:flex;align-items:center;gap:8px;justify-content:flex-end;font:12px system-ui,sans-serif}
    .clb-report{border:0;border-radius:8px;background:#d9f99d;color:#17220b;padding:9px 12px;font-weight:700;cursor:pointer}
    .clb-clear{border:1px solid #454a58;border-radius:8px;background:transparent;color:#d1d5df;padding:8px 10px;cursor:pointer}
    @media(prefers-reduced-motion:reduce){#clincoo-bug-fab{transition:none}}
  `;
  (document.head || document.documentElement).appendChild(style);

  const fab = document.createElement('button');
  fab.id = 'clincoo-bug-fab';
  fab.type = 'button';
  fab.title = 'Clincoo Debug Console — geser atau klik';
  fab.setAttribute('aria-label', 'Buka console error Clincoo');
  fab.innerHTML = '<svg viewBox="0 0 32 32" fill="none" aria-hidden="true"><path d="M16 5.5c-5.8 0-10 4.2-10 10.2 0 5.7 4.4 10.5 10 10.5s10-4.8 10-10.5C26 9.7 21.8 5.5 16 5.5Z" fill="currentColor" opacity=".12"/><path d="M16 5.5c-5.8 0-10 4.2-10 10.2 0 5.7 4.4 10.5 10 10.5s10-4.8 10-10.5C26 9.7 21.8 5.5 16 5.5Z" stroke="currentColor" stroke-width="1.8"/><path d="M16 6v20M8.5 11.5l-3-2M23.5 11.5l3-2M7 17H3.5m21.5 0h3.5M9 22l-2.5 2M23 22l2.5 2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M16 6c-4 0-6.5 3.5-6.5 8.5S12 23 16 23s6.5-3.5 6.5-8.5S20 6 16 6Z" stroke="currentColor" stroke-width="1.2"/></svg>';
  const panel = document.createElement('section');
  panel.id = 'clincoo-bug-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Clincoo console log');
  panel.innerHTML = '<div class="clb-logs"></div><div class="clb-foot"><button class="clb-clear" type="button">Bersihkan</button><button class="clb-report" type="button">Laporkan ↗</button></div>';
  (document.body || document.documentElement).append(fab, panel);
  const logBox = panel.querySelector('.clb-logs');

  function render() {
    logBox.replaceChildren();
    if (!logs.length) {
      const empty = document.createElement('div');
      empty.className = 'clb-empty';
      return;
    }
    logs.slice().reverse().forEach(item => {
      const row = document.createElement('div');
      row.className = 'clb-entry ' + item.type;
      const time = document.createElement('span');
      time.className = 'clb-time';
      time.textContent = item.time + ' [' + item.type.toUpperCase() + ']';
      const msg = document.createElement('span');
      msg.textContent = item.message;
      row.append(time, msg);
      logBox.appendChild(row);
    });
  }
  const originalAddLog = addLog;
  // Keep the console view fresh whenever a log arrives.
  const observer = new MutationObserver(() => {});
  const oldConsoleError = console.error;
  console.error = (...args) => { originalAddLog('error', args); oldConsoleError(...args); if (panel.classList.contains('open')) render(); };
  const oldConsoleWarn = console.warn;
  console.warn = (...args) => { originalAddLog('warn', args); oldConsoleWarn(...args); if (panel.classList.contains('open')) render(); };
  window.addEventListener('error', () => { if (panel.classList.contains('open')) render(); });
  window.addEventListener('unhandledrejection', () => { if (panel.classList.contains('open')) render(); });

  fab.addEventListener('click', () => {
    if (dragged) { dragged = false; return; }
    panel.classList.toggle('open');
    if (panel.classList.contains('open')) render();
  });
  panel.querySelector('.clb-clear').addEventListener('click', () => { logs.length = 0; render(); });
  panel.querySelector('.clb-report').addEventListener('click', () => {
    const report = [
      'Laporan error Clincoo',
      'Halaman: ' + location.href,
      'Waktu: ' + new Date().toLocaleString(),
      '',
      ...(logs.length ? logs.map(x => '[' + x.time + '] ' + x.type.toUpperCase() + ': ' + x.message) : ['Tidak ada error/warning tertangkap.'])
    ].join('\n').slice(0, 12000);
    const url = 'https://wa.me/?text=' + encodeURIComponent(report);
    window.open(url, '_blank', 'noopener,noreferrer');
  });

  let dragging = false, dragged = false, startX = 0, startY = 0, originX = 0, originY = 0;
  function clamp(v, min, max) { return Math.min(Math.max(v, min), max); }
  fab.style.right = '22px'; fab.style.bottom = '22px';
  fab.addEventListener('pointerdown', event => {
    dragging = true; dragged = false;
    startX = event.clientX; startY = event.clientY;
    const rect = fab.getBoundingClientRect();
    originX = rect.left; originY = rect.top;
    fab.setPointerCapture(event.pointerId);
  });
  fab.addEventListener('pointermove', event => {
    if (!dragging) return;
    const dx = event.clientX - startX, dy = event.clientY - startY;
    if (Math.abs(dx) + Math.abs(dy) > 5) dragged = true;
    if (!dragged) return;
    fab.style.left = clamp(originX + dx, 4, innerWidth - fab.offsetWidth - 4) + 'px';
    fab.style.top = clamp(originY + dy, 4, innerHeight - fab.offsetHeight - 4) + 'px';
    fab.style.right = 'auto'; fab.style.bottom = 'auto';
  });
  fab.addEventListener('pointerup', () => { dragging = false; });
  fab.addEventListener('pointercancel', () => { dragging = false; });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') panel.classList.remove('open'); });
})();