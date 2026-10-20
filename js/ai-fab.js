/* FAB Asisten AI Clincoo — v4: tanpa header, sheet iframe penuh, scroll mulus */
(function () {
  if (window.top !== window) return;
  if (/\/proyek\/chat\//.test(location.pathname)) return;

  var fab = document.createElement('button');
  fab.id = 'ai-fab';
  fab.type = 'button';
  fab.setAttribute('aria-label', 'Asisten AI Clincoo');
  fab.innerHTML = '<i class="ph ph-sparkle"></i>';
  var fs = document.createElement('style');
  fs.textContent =
    '#ai-fab{position:fixed;right:20px;bottom:84px;width:52px;height:52px;border-radius:9999px;' +
    'background:#000000;border:1.5px solid rgba(255,255,255,0.4);color:#ffffff;display:flex;align-items:center;' +
    'justify-content:center;cursor:pointer;z-index:2147482500;font-size:24px;box-shadow:0 6px 20px rgba(0,0,0,.35);transition:transform .15s}' +
    '#ai-fab:hover{background:#1a1a1a;border-color:rgba(255,255,255,.7);transform:translateY(-2px)}' +
    '#ai-fab-sheet{position:fixed;inset:0;z-index:2147483001;display:none}' +
    '#ai-fab-sheet.open{display:block}' +
    '#ai-fab-back{position:absolute;inset:0;background:rgba(0,0,0,.45)}' +
    '#ai-fab-card{position:absolute;left:0;right:0;bottom:0;top:2vh;border-radius:18px 18px 0 0;' +
    'overflow:hidden;background:#121212;box-shadow:0 -8px 40px rgba(0,0,0,.5)}' +
    '#ai-fab-panel{position:absolute;inset:0;overflow-y:auto;-webkit-overflow-scrolling:touch;overscroll-behavior:contain;background:#121212}' +
    '#ai-fab-panel iframe{display:block;width:100%;height:100%;min-height:100%;border:0}';
  document.head.appendChild(fs);

  var sheet = document.createElement('div');
  sheet.id = 'ai-fab-sheet';
  sheet.innerHTML =
    '<div id="ai-fab-back"></div>' +
    '<div id="ai-fab-card">' +
      '<div id="ai-fab-panel"><iframe title="Asisten AI Clincoo" allow="clipboard-read; clipboard-write"></iframe></div>' +
    '</div>';
  document.body.appendChild(sheet);
  document.body.appendChild(fab);

  var frame = sheet.querySelector('iframe');
  function open() {
    if (!frame.getAttribute('src')) {
      var pid = '';
      try { pid = new URLSearchParams(location.search).get('id') || localStorage.getItem('clincoo_current_project_id') || ''; } catch (e) {}
      frame.setAttribute('src', '/proyek/chat/?embed=1' + (pid ? '&id=' + encodeURIComponent(pid) : ''));
    }
    sheet.classList.add('open');
    document.documentElement.style.overflow = 'hidden';
    document.body.style.overflow = 'hidden';
  }
  function close() {
    sheet.classList.remove('open');
    document.documentElement.style.overflow = '';
    document.body.style.overflow = '';
  }
  fab.addEventListener('click', open);
  sheet.querySelector('#ai-fab-back').addEventListener('click', close);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && sheet.classList.contains('open')) close(); });
})();
