/* Clincoo Bug Beetle — draggable in-page console + one-click report */
(function () {
  'use strict';
  if (window.__clincooBugBeetleLoaded) return;
  window.__clincooBugBeetleLoaded = true;

  var MAX_LOGS = 100;
  var logs = [];
  var panelOpen = false;
  var dragging = false;
  var moved = false;
  var startX = 0, startY = 0, originX = 0, originY = 0;
  var posKey = 'clincoo_bug_beetle_position_v1';
  var mailTo = 'devconium@gmail.com';

  function safeString(value) {
    if (value instanceof Error) return (value.name || 'Error') + ': ' + (value.message || '') + (value.stack ? '\n' + value.stack : '');
    if (typeof value === 'string') return value;
    try { return JSON.stringify(value); } catch (_) { return String(value); }
  }
  function addLog(level, message, extra) {
    logs.push({ time: new Date().toLocaleTimeString('id-ID', { hour12: false }), level: level, message: safeString(message) + (extra ? '\n' + safeString(extra) : '') });
    if (logs.length > MAX_LOGS) logs.shift();
    renderLogs();
    if (level === 'error' || level === 'warn') {
      try { localStorage.setItem('clincoo_bug_beetle_recent', JSON.stringify(logs.slice(-40))); } catch (_) {}
    }
  }

  try {
    var saved = JSON.parse(localStorage.getItem('clincoo_bug_beetle_recent') || '[]');
    if (Array.isArray(saved)) logs = saved.slice(-MAX_LOGS);
  } catch (_) {}

  var originalError = console.error;
  var originalWarn = console.warn;
  console.error = function () {
    try { addLog('error', Array.prototype.map.call(arguments, safeString).join(' ')); } catch (_) {}
    return originalError.apply(console, arguments);
  };
  console.warn = function () {
    try { addLog('warn', Array.prototype.map.call(arguments, safeString).join(' ')); } catch (_) {}
    return originalWarn.apply(console, arguments);
  };
  window.addEventListener('error', function (event) {
    if (event && event.target && event.target !== window) {
      var target = event.target;
      addLog('error', 'Resource gagal dimuat: ' + (target.src || target.href || target.tagName || 'unknown'));
      return;
    }
    addLog('error', event.message || 'JavaScript error', (event.filename || '') + (event.lineno ? ':' + event.lineno : '') + (event.error && event.error.stack ? '\n' + event.error.stack : ''));
  }, true);
  window.addEventListener('unhandledrejection', function (event) {
    addLog('error', 'Unhandled Promise rejection', event.reason);
  });
  window.addEventListener('online', function () { addLog('info', 'Koneksi kembali online'); });
  window.addEventListener('offline', function () { addLog('warn', 'Browser sedang offline'); });

  function contrastTheme() {
    var candidates = [document.body, document.documentElement];
    var bg = 'rgb(255, 255, 255)';
    for (var i = 0; i < candidates.length; i++) {
      if (!candidates[i]) continue;
      var c = getComputedStyle(candidates[i]).backgroundColor;
      if (c && c !== 'transparent' && c !== 'rgba(0, 0, 0, 0)') { bg = c; break; }
    }
    var nums = bg.match(/[\d.]+/g) || [255,255,255];
    var rgb = nums.slice(0,3).map(Number);
    var lum = (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255;
    return lum > 0.52 ? 'dark' : 'light';
  }

  var style = document.createElement('style');
  style.textContent = [
    '#cc-bug-root{position:fixed;z-index:2147483000;left:auto;top:auto;right:20px;bottom:20px;font:13px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:#e5e7eb;isolation:isolate}',
    '#cc-bug-fab{width:58px;height:58px;border:2px solid var(--cc-bug-border);border-radius:50%;display:flex;align-items:center;justify-content:center;cursor:grab;touch-action:none;user-select:none;box-shadow:0 8px 30px #0004;background:var(--cc-bug-bg);color:var(--cc-bug-fg);font-size:28px;transition:transform .15s,box-shadow .15s}',
    '#cc-bug-fab:hover{transform:scale(1.05);box-shadow:0 12px 34px #0005}#cc-bug-fab:active{cursor:grabbing}',
    '#cc-bug-root.cc-bug-dark{--cc-bug-bg:#111827;--cc-bug-fg:#fff;--cc-bug-border:#f9fafb;--cc-bug-panel:#0b1020;--cc-bug-line:#263244;--cc-bug-muted:#9ca3af;--cc-bug-accent:#a7f3d0}',
    '#cc-bug-root.cc-bug-light{--cc-bug-bg:#f9fafb;--cc-bug-fg:#111827;--cc-bug-border:#111827;--cc-bug-panel:#fff;--cc-bug-line:#d1d5db;--cc-bug-muted:#4b5563;--cc-bug-accent:#065f46}',
    '#cc-bug-panel{position:fixed;right:16px;bottom:92px;width:min(430px,calc(100vw - 24px));max-height:min(65vh,560px);display:none;flex-direction:column;overflow:hidden;border:1px solid var(--cc-bug-line);border-radius:14px;background:var(--cc-bug-panel);color:var(--cc-bug-fg);box-shadow:0 20px 70px #0006;font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}',
    '#cc-bug-panel.cc-open{display:flex}#cc-bug-head{display:flex;align-items:center;justify-content:space-between;padding:11px 13px;border-bottom:1px solid var(--cc-bug-line);gap:8px}',
    '#cc-bug-title{font-weight:800;font-size:13px;letter-spacing:.02em}#cc-bug-subtitle{font-size:10px;color:var(--cc-bug-muted);margin-top:2px}',
    '#cc-bug-close{border:0;background:transparent;color:var(--cc-bug-fg);font-size:20px;cursor:pointer;padding:0 4px}',
    '#cc-bug-log{overflow:auto;min-height:110px;max-height:calc(min(65vh,560px) - 120px);padding:10px 12px;white-space:pre-wrap;overflow-wrap:anywhere}',
    '.cc-bug-row{padding:6px 0;border-bottom:1px solid var(--cc-bug-line)}.cc-bug-row:last-child{border:0}.cc-bug-time{color:var(--cc-bug-muted);margin-right:7px}.cc-bug-level{font-weight:800;margin-right:7px}.cc-bug-error{color:#fb7185}.cc-bug-warn{color:#fbbf24}.cc-bug-info{color:var(--cc-bug-accent)}.cc-bug-empty{color:var(--cc-bug-muted);padding:18px 2px}',
    '#cc-bug-foot{padding:10px 12px;border-top:1px solid var(--cc-bug-line);display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
    '.cc-bug-action{border:1px solid var(--cc-bug-line);border-radius:8px;background:transparent;color:var(--cc-bug-fg);padding:7px 9px;font:inherit;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;justify-content:center}',
    '.cc-bug-report{background:var(--cc-bug-accent);border-color:var(--cc-bug-accent);color:var(--cc-bug-bg);font-weight:800;flex:1}.cc-bug-count{margin-left:auto;color:var(--cc-bug-muted);font-size:10px}',
    '@media(max-width:480px){#cc-bug-root{right:12px;bottom:12px}#cc-bug-fab{width:52px;height:52px;font-size:25px}#cc-bug-panel{right:8px;bottom:74px;width:calc(100vw - 16px)}}'
  ].join('');
  (document.head || document.documentElement).appendChild(style);

  var root = document.createElement('div');
  root.id = 'cc-bug-root';
  root.innerHTML = '<button id="cc-bug-fab" type="button" aria-label="Buka console bug Clincoo" title="Seret ke mana saja · klik untuk melihat log">🪲</button>' +
    '<section id="cc-bug-panel" role="dialog" aria-label="Console dan laporan bug" aria-live="polite">' +
    '<header id="cc-bug-head"><div><div id="cc-bug-title">🪲 CLINCOO CONSOLE</div><div id="cc-bug-subtitle">Log lokal browser · tidak dikirim otomatis</div></div><button id="cc-bug-close" type="button" aria-label="Tutup">×</button></header>' +
    '<div id="cc-bug-log"></div><footer id="cc-bug-foot"><button class="cc-bug-action" id="cc-bug-copy" type="button">Salin log</button><a class="cc-bug-action cc-bug-report" id="cc-bug-report" href="#">Laporkan error ↗</a><span class="cc-bug-count" id="cc-bug-count">0 log</span></footer></section>';
  (document.body || document.documentElement).appendChild(root);
  var fab = document.getElementById('cc-bug-fab');
  var panel = document.getElementById('cc-bug-panel');
  var logBox = document.getElementById('cc-bug-log');
  var report = document.getElementById('cc-bug-report');
  root.classList.add(contrastTheme() === 'dark' ? 'cc-bug-dark' : 'cc-bug-light');

  function formatLogs() {
    var lines = logs.slice(-60).map(function (l) { return '[' + l.time + '] ' + l.level.toUpperCase() + '  ' + l.message; });
    return [
      'LAPORAN ERROR CLINCOO',
      'Waktu: ' + new Date().toLocaleString('id-ID'),
      'Halaman: ' + location.href,
      'Browser: ' + navigator.userAgent,
      'Online: ' + navigator.onLine,
      '',
      lines.length ? lines.join('\n\n') : 'Belum ada error atau warning yang tertangkap.'
    ].join('\n');
  }
  function renderLogs() {
    if (!logBox) return;
    if (!logs.length) {
      logBox.innerHTML = '<div class="cc-bug-empty">Belum ada error tertangkap. Error JavaScript, promise gagal, resource gagal, console.warn dan console.error akan muncul di sini.</div>';
    } else {
      logBox.innerHTML = logs.slice(-60).map(function (l) {
        var cls = l.level === 'error' ? 'cc-bug-error' : (l.level === 'warn' ? 'cc-bug-warn' : 'cc-bug-info');
        var row = document.createElement('div');
        row.className = 'cc-bug-row';
        var time = document.createElement('span'); time.className = 'cc-bug-time'; time.textContent = l.time;
        var level = document.createElement('span'); level.className = 'cc-bug-level ' + cls; level.textContent = l.level.toUpperCase();
        var msg = document.createElement('span'); msg.textContent = l.message;
        row.appendChild(time); row.appendChild(level); row.appendChild(msg);
        return row.outerHTML;
      }).join('');
    }
    var count = document.getElementById('cc-bug-count');
    if (count) count.textContent = logs.length + ' log';
    if (report) report.href = 'mailto:' + mailTo + '?subject=' + encodeURIComponent('[Clincoo] Laporan error halaman') + '&body=' + encodeURIComponent(formatLogs().slice(0, 12000));
    if (panelOpen) logBox.scrollTop = logBox.scrollHeight;
  }

  function togglePanel(force) {
    panelOpen = typeof force === 'boolean' ? force : !panelOpen;
    panel.classList.toggle('cc-open', panelOpen);
    if (panelOpen) renderLogs();
  }
  document.getElementById('cc-bug-close').addEventListener('click', function () { togglePanel(false); });
  fab.addEventListener('click', function () { if (!moved) togglePanel(); });
  document.getElementById('cc-bug-copy').addEventListener('click', function () {
    var text = formatLogs();
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { addLog('info', 'Log berhasil disalin ke clipboard'); }).catch(function () { window.prompt('Salin laporan error:', text); });
    } else window.prompt('Salin laporan error:', text);
  });

  fab.addEventListener('pointerdown', function (event) {
    if (event.button !== undefined && event.button !== 0) return;
    dragging = true; moved = false; startX = event.clientX; startY = event.clientY;
    var rect = root.getBoundingClientRect(); originX = rect.left; originY = rect.top;
    try { fab.setPointerCapture(event.pointerId); } catch (_) {}
  });
  fab.addEventListener('pointermove', function (event) {
    if (!dragging) return;
    var dx = event.clientX - startX, dy = event.clientY - startY;
    if (Math.abs(dx) + Math.abs(dy) > 7) moved = true;
    if (!moved) return;
    var x = Math.max(4, Math.min(window.innerWidth - fab.offsetWidth - 4, originX + dx));
    var y = Math.max(4, Math.min(window.innerHeight - fab.offsetHeight - 4, originY + dy));
    root.style.left = x + 'px'; root.style.top = y + 'px'; root.style.right = 'auto'; root.style.bottom = 'auto';
  });
  function endDrag() {
    if (!dragging) return;
    dragging = false;
    if (moved) {
      try { localStorage.setItem(posKey, JSON.stringify({ x: parseInt(root.style.left, 10), y: parseInt(root.style.top, 10) })); } catch (_) {}
      setTimeout(function () { moved = false; }, 80);
    }
  }
  fab.addEventListener('pointerup', endDrag);
  fab.addEventListener('pointercancel', endDrag);
  window.addEventListener('resize', function () {
    if (!root.style.left || !root.style.top) return;
    var x = Math.max(4, Math.min(window.innerWidth - fab.offsetWidth - 4, parseInt(root.style.left, 10)));
    var y = Math.max(4, Math.min(window.innerHeight - fab.offsetHeight - 4, parseInt(root.style.top, 10)));
    root.style.left = x + 'px'; root.style.top = y + 'px';
  });
  try {
    var savedPos = JSON.parse(localStorage.getItem(posKey) || 'null');
    if (savedPos && Number.isFinite(savedPos.x) && Number.isFinite(savedPos.y)) {
      root.style.left = Math.max(4, Math.min(window.innerWidth - 62, savedPos.x)) + 'px';
      root.style.top = Math.max(4, Math.min(window.innerHeight - 62, savedPos.y)) + 'px';
      root.style.right = 'auto'; root.style.bottom = 'auto';
    }
  } catch (_) {}
  renderLogs();
  addLog('info', 'Bug Beetle aktif', location.pathname);
})();