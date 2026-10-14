(() => {
  if (window.__clincooBugInstalled) return;
  window.__clincooBugInstalled = true;
  const logs = [];
  const MAX = 60;
  const toText = v => { if (v instanceof Error) return v.stack || v.message; if (typeof v === 'string') return v; try { return JSON.stringify(v); } catch { return String(v); } };
  const style = document.createElement('style');
  style.id = 'clincoo-bug-style';
  style.textContent = `
    #clincoo-bug-fab{position:fixed;z-index:2147483000;width:52px;height:52px;border:1px solid var(--cb-border,#ddd);border-radius:50%;display:grid;place-items:center;cursor:grab;touch-action:none;user-select:none;background:var(--cb-bg,#fff);color:var(--cb-fg,#171717);box-shadow:0 5px 22px #0002;transition:box-shadow .16s; padding:0}
    #clincoo-bug-fab:hover{box-shadow:0 8px 28px #0003}#clincoo-bug-fab:active{cursor:grabbing}#clincoo-bug-fab svg{width:23px;height:23px}
    #clincoo-bug-panel{position:fixed;z-index:2147483001;right:20px;bottom:84px;width:min(390px,calc(100vw - 24px));max-height:min(520px,calc(100dvh - 100px));display:none;flex-direction:column;background:var(--cb-bg,#fff);color:var(--cb-fg,#171717);border:1px solid var(--cb-border,#e5e5e5);border-radius:16px;box-shadow:0 16px 48px #0002;overflow:hidden;font-family:Inter,ui-sans-serif,system-ui,-apple-system,sans-serif}
    #clincoo-bug-panel.open{display:flex;animation:cb-enter .14s ease-out}@keyframes cb-enter{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:translateY(0)}}#clincoo-bug-panel *{box-sizing:border-box}
    .clb-head{display:flex;align-items:center;justify-content:space-between;padding:16px 18px;border-bottom:1px solid var(--cb-border)}.clb-title{font-size:13px;font-weight:650}.clb-route{font-size:11px;color:var(--cb-muted);margin-top:3px;max-width:290px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.clb-close{background:transparent;color:inherit;border:0;font-size:20px;cursor:pointer;padding:0 4px}
    .clb-status{padding:10px 16px 2px;display:flex;gap:7px;align-items:center;font-size:11px;color:var(--cb-muted)}.clb-dot{width:6px;height:6px;border-radius:50%;background:#ef4444}
    .clb-logs{overflow:auto;padding:10px 18px 14px;min-height:90px;font:11px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;overflow-wrap:anywhere}.clb-entry{padding:7px 0;border-bottom:1px solid var(--cb-border)}.clb-entry:last-child{border-bottom:0}.clb-time{color:var(--cb-muted);margin-right:8px}.clb-msg{color:#dc2626}.clb-empty{font:12px/1.6 Inter,ui-sans-serif,system-ui,sans-serif;color:var(--cb-muted);padding:6px 0 14px}
    .clb-foot{padding:0 18px 16px;font:12px/1.5 Inter,ui-sans-serif,system-ui,sans-serif}.clb-report{color:var(--cb-fg);font-weight:600;text-decoration:underline;text-underline-offset:3px}.clb-note{font-size:10px;color:var(--cb-muted);margin-top:5px}
    @media(max-width:520px){#clincoo-bug-fab{width:48px;height:48px}#clincoo-bug-panel{right:12px;bottom:74px;width:calc(100vw - 24px)}}@media(prefers-reduced-motion:reduce){#clincoo-bug-panel.open{animation:none}}
  `;
  document.head.appendChild(style);
  const fab = document.createElement('button');
  fab.id = 'clincoo-bug-fab'; fab.type = 'button'; fab.title = 'Clincoo error console'; fab.setAttribute('aria-label','Buka console error Clincoo'); fab.setAttribute('aria-expanded','false');
  fab.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20v-9"/><path d="M14 7a4 4 0 0 1 4 4v3a6 6 0 0 1-12 0v-3a4 4 0 0 1 4-4z"/><path d="M14.12 3.88 16 2"/><path d="M21 21a4 4 0 0 0-3.81-4"/><path d="M21 5a4 4 0 0 1-3.55 3.97"/><path d="M22 13h-4"/><path d="M3 21a4 4 0 0 1 3.81-4"/><path d="M3 5a4 4 0 0 0 3.55 3.97"/><path d="M6 13H2"/><path d="m8 2 1.88 1.88"/><path d="M9 7.13V6a3 3 0 1 1 6 0v1.13"/></svg>';
  const panel = document.createElement('section');
  panel.id='clincoo-bug-panel'; panel.setAttribute('role','dialog'); panel.setAttribute('aria-label','Clincoo error console');
  panel.innerHTML='<header class="clb-head"><div><div class="clb-title">Clincoo · Error console</div><div class="clb-route"></div></div><button class="clb-close" type="button" aria-label="Tutup">×</button></header><div class="clb-status"><span class="clb-dot"></span><span class="clb-count">Memantau error</span></div><div class="clb-logs" aria-live="polite"></div><footer class="clb-foot"><a class="clb-report" target="_blank" rel="noopener noreferrer">Laporkan via WhatsApp ↗</a><div class="clb-note">Log terakhir disertakan di pesan laporan.</div></footer>';
  (document.body||document.documentElement).append(fab,panel);
  const box=panel.querySelector('.clb-logs'), count=panel.querySelector('.clb-count'), route=panel.querySelector('.clb-route'), report=panel.querySelector('.clb-report');
  route.textContent=location.pathname+location.search;
  function contrast(){
    let bg='rgb(255,255,255)';
    for(const el of [document.querySelector('main'),document.body,document.documentElement]){if(!el)continue;const c=getComputedStyle(el).backgroundColor;if(c&&c!=='transparent'&&c!=='rgba(0, 0, 0, 0)'){bg=c;break;}}
    const n=bg.match(/[\\d.]+/g);let light=true;
    if(n&&n.length>=3){const rgb=n.slice(0,3).map(Number).map(v=>{v/=255;return v<=.04045?v/12.92:Math.pow((v+.055)/1.055,2.4)});light=.2126*rgb[0]+.7152*rgb[1]+.0722*rgb[2]>.42;}
    panel.style.setProperty('--cb-bg',light?'#fff':'#171717');panel.style.setProperty('--cb-fg',light?'#171717':'#fff');panel.style.setProperty('--cb-border',light?'#e5e5e5':'#383838');panel.style.setProperty('--cb-muted',light?'#737373':'#a3a3a3');
    fab.style.setProperty('--cb-bg',light?'#171717':'#fff');fab.style.setProperty('--cb-fg',light?'#fff':'#171717');fab.style.setProperty('--cb-border',light?'#171717':'#fff');
  }
  contrast();window.addEventListener('load',contrast,{once:true});
  function refreshReport(){
    const latest=logs.slice(-12).map(x=>'['+x.time+'] '+x.type.toUpperCase()+': '+x.message).join('\n');
    const msg='Halo Clincoo, saya ingin melaporkan error.\nHalaman: '+location.href+'\nWaktu: '+new Date().toLocaleString('id-ID')+'\n\nLog error:\n'+(latest||'(Belum ada error tertangkap)');
    report.href='https://wa.me/6283849297259?text='+encodeURIComponent(msg);
  }
  function render(){
    count.textContent=logs.length?logs.length+' log tertangkap':'Memantau error';box.replaceChildren();
    if(!logs.length){const e=document.createElement('div');e.className='clb-empty';e.textContent='Belum ada error yang tertangkap. Error baru akan muncul otomatis di sini.';box.appendChild(e);}
    logs.forEach(x=>{const row=document.createElement('div');row.className='clb-entry';const time=document.createElement('span');time.className='clb-time';time.textContent=x.time;const msg=document.createElement('span');msg.className='clb-msg';msg.textContent=x.type.toUpperCase()+'  '+x.message;row.append(time,msg);box.appendChild(row);});
    box.scrollTop=box.scrollHeight;refreshReport();
  }
  function add(type,args){logs.push({type,message:Array.from(args).map(toText).join(' ').slice(0,2000),time:new Date().toLocaleTimeString('id-ID',{hour12:false})});if(logs.length>MAX)logs.shift();if(panel.classList.contains('open'))render();else refreshReport();}
  window.addEventListener('error',e=>{if(e.target&&e.target!==window)add('resource',['Gagal memuat',e.target.src||e.target.href||e.target.tagName]);else add('error',[e.message||'JavaScript error',e.filename?e.filename.split('/').pop()+':'+e.lineno:'']);},true);
  window.addEventListener('unhandledrejection',e=>add('promise',[e.reason]));
  const oldError=console.error.bind(console);console.error=(...a)=>{add('console',a);oldError(...a);};
  const oldWarn=console.warn.bind(console);console.warn=(...a)=>{add('warning',a);oldWarn(...a);};
  let dragging=false,dragged=false,sx=0,sy=0,ox=0,oy=0;
  try{const p=JSON.parse(localStorage.getItem('clincoo-bug-pos')||'null');if(p&&Number.isFinite(p.x)&&Number.isFinite(p.y)){fab.style.left=Math.max(4,Math.min(innerWidth-56,p.x))+'px';fab.style.top=Math.max(4,Math.min(innerHeight-56,p.y))+'px';fab.style.right='auto';fab.style.bottom='auto';}else{fab.style.right='22px';fab.style.bottom='22px';}}catch(_){fab.style.right='22px';fab.style.bottom='22px';}
  fab.addEventListener('pointerdown',e=>{if(e.button!==0&&e.pointerType==='mouse')return;dragging=true;dragged=false;sx=e.clientX;sy=e.clientY;const r=fab.getBoundingClientRect();ox=r.left;oy=r.top;fab.setPointerCapture(e.pointerId);});
  fab.addEventListener('pointermove',e=>{if(!dragging)return;const dx=e.clientX-sx,dy=e.clientY-sy;if(Math.abs(dx)+Math.abs(dy)>5)dragged=true;if(!dragged)return;fab.style.left=Math.max(4,Math.min(innerWidth-fab.offsetWidth-4,ox+dx))+'px';fab.style.top=Math.max(4,Math.min(innerHeight-fab.offsetHeight-4,oy+dy))+'px';fab.style.right='auto';fab.style.bottom='auto';});
  function endDrag(){if(!dragging)return;dragging=false;if(dragged){const r=fab.getBoundingClientRect();try{localStorage.setItem('clincoo-bug-pos',JSON.stringify({x:r.left,y:r.top}));}catch(_){}}}
  fab.addEventListener('pointerup',endDrag);fab.addEventListener('pointercancel',endDrag);
  fab.addEventListener('click',()=>{if(dragged){dragged=false;return;}const open=!panel.classList.contains('open');panel.classList.toggle('open',open);fab.setAttribute('aria-expanded',String(open));if(open){contrast();render();}});
  panel.querySelector('.clb-close').addEventListener('click',()=>{panel.classList.remove('open');fab.setAttribute('aria-expanded','false');});
  document.addEventListener('keydown',e=>{if(e.key==='Escape'){panel.classList.remove('open');fab.setAttribute('aria-expanded','false');}});
  document.addEventListener('pointerdown',e=>{if(panel.classList.contains('open')&&!panel.contains(e.target)&&!fab.contains(e.target)){panel.classList.remove('open');fab.setAttribute('aria-expanded','false');}});
  window.addEventListener('resize',()=>{const r=fab.getBoundingClientRect();fab.style.left=Math.max(4,Math.min(innerWidth-fab.offsetWidth-4,r.left))+'px';fab.style.top=Math.max(4,Math.min(innerHeight-fab.offsetHeight-4,r.top))+'px';fab.style.right='auto';fab.style.bottom='auto';});
  refreshReport();
})();