/* FAB Asisten — buka UI chat Clincoo sebagai overlay sheet.
   Hanya aktif di halaman workspace: /proyek/code/ dan /proyek/dashboard/. */
(function () {
  var path = location.pathname;
  var okPage = path.indexOf('/proyek/code/') === 0 || path.indexOf('/proyek/dashboard/') === 0;
  if (!okPage) return;

  function ready(fn) {
    if (document.readyState !== 'loading') fn();
    else document.addEventListener('DOMContentLoaded', fn);
  }

  ready(function () {
    if (document.getElementById('ai-fab')) return;

    var css = ''
      + '#ai-fab{position:fixed;right:18px;bottom:26px;z-index:2147483600;width:56px;height:56px;border-radius:9999px;border:none;cursor:pointer;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;font-size:24px;line-height:1;display:flex;align-items:center;justify-content:center;box-shadow:0 8px 24px rgba(99,102,241,.45);transition:transform .15s ease,box-shadow .15s ease;}'
      + '#ai-fab:hover{transform:translateY(-2px);box-shadow:0 12px 28px rgba(99,102,241,.55);}'
      + '#ai-fab:active{transform:scale(.9);}'
      + '#ai-fab-sheet{position:fixed;inset:0;z-index:2147483601;display:none;}'
      + '#ai-fab-sheet.open{display:block;}'
      + '#ai-fab-back{position:absolute;inset:0;background:rgba(0,0,0,.5);}'
      + '#ai-fab-panel{position:absolute;left:0;right:0;bottom:0;top:4vh;background:#ffffff;border-radius:20px 20px 0 0;overflow:hidden;box-shadow:0 -12px 48px rgba(0,0,0,.35);animation:aiFabUp .22s cubic-bezier(.2,.8,.3,1) both;}'
      + 'body.dark-mode #ai-fab-panel{background:#0e0e10;}'
      + '@keyframes aiFabUp{from{transform:translateY(40px);opacity:.35;}to{transform:none;opacity:1;}}'
      + '#ai-fab-frame{width:100%;height:100%;border:0;}'
      + '#ai-fab-close{position:absolute;top:10px;right:14px;z-index:3;width:38px;height:38px;border-radius:9999px;border:none;cursor:pointer;background:#111111;color:#ffffff;font-size:16px;font-weight:700;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 10px rgba(0,0,0,.35);transition:transform .12s ease;}'
      + '#ai-fab-close:active{transform:scale(.88);}';

    var st = document.createElement('style');
    st.textContent = css;
    (document.head || document.documentElement).appendChild(st);

    var fab = document.createElement('button');
    fab.id = 'ai-fab';
    fab.type = 'button';
    fab.title = 'Asisten AI Clincoo';
    fab.setAttribute('aria-label', 'Buka Asisten AI Clincoo');
    fab.innerHTML = '&#10024;';

    var sheet = document.createElement('div');
    sheet.id = 'ai-fab-sheet';
    sheet.innerHTML = '<div id="ai-fab-back"></div>'
      + '<div id="ai-fab-panel">'
      + '<iframe id="ai-fab-frame" title="Chat AI Clincoo"></iframe>'
      + '<button id="ai-fab-close" type="button" aria-label="Tutup asisten">&#10005;</button>'
      + '</div>';

    document.body.appendChild(fab);
    document.body.appendChild(sheet);

    var frame = sheet.querySelector('#ai-fab-frame');
    var prevOverflow = { html: '', body: '' };

    function lockScroll() {
      prevOverflow.html = document.documentElement.style.overflow || '';
      prevOverflow.body = document.body.style.overflow || '';
      document.documentElement.style.overflow = 'hidden';
      document.body.style.overflow = 'hidden';
    }
    function unlockScroll() {
      document.documentElement.style.overflow = prevOverflow.html;
      document.body.style.overflow = prevOverflow.body;
    }

    function open() {
      var src = '/proyek/chat/' + (location.search || '');
      frame.setAttribute('src', src);
      sheet.classList.add('open');
      lockScroll();
    }
    function close() {
      sheet.classList.remove('open');
      frame.setAttribute('src', 'about:blank');
      unlockScroll();
    }

    fab.addEventListener('click', function (e) { e.stopPropagation(); open(); });
    sheet.querySelector('#ai-fab-back').addEventListener('click', close);
    sheet.querySelector('#ai-fab-close').addEventListener('click', close);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && sheet.classList.contains('open')) close();
    });
  });
})();
