/* ================= Vylonium Tasks — vanilla JS, zero deps ================= */
'use strict';

/* ---------- Util ---------- */
const $=(s,c=document)=>c.querySelector(s);
const $$=(s,c=document)=>Array.from(c.querySelectorAll(s));
const esc=s=>String(s==null?'':s).replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
const uid=()=>'VYT-'+Date.now().toString(36).toUpperCase()+Math.floor(Math.random()*1296).toString(36).toUpperCase().padStart(2,'0');
const iso=d=>d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
const todayISO=()=>iso(new Date());
const dOff=n=>{const d=new Date();d.setDate(d.getDate()+n);return iso(d)};
const fmtDate=iso2=>{if(!iso2)return '—';try{return new Date(iso2+'T00:00:00').toLocaleDateString('id-ID',{day:'numeric',month:'short',year:'numeric'})}catch(e){return iso2}};
const fmtShort=iso2=>{if(!iso2)return '—';try{return new Date(iso2+'T00:00:00').toLocaleDateString('id-ID',{day:'numeric',month:'short'})}catch(e){return iso2}};
const fmtTime=ts=>new Date(ts).toLocaleTimeString('id-ID',{hour:'2-digit',minute:'2-digit'});
const num=n=>Number(n||0).toLocaleString('id-ID');
const reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;

const STATUS={todo:'To Do',doing:'Dalam Proses',done:'Selesai'};
const PRIO={high:'Tinggi',med:'Sedang',low:'Rendah'};
const PRIO_RANK={high:0,med:1,low:2};

/* ---------- Store ---------- */
const KEY='vylonium-tasks-v1';
let DB=null;
function save(){try{localStorage.setItem(KEY,JSON.stringify(DB))}catch(e){toast('Gagal menyimpan data','err')}}
function loadDB(){try{const r=JSON.parse(localStorage.getItem(KEY));if(r&&Array.isArray(r.tasks)&&Array.isArray(r.projects))return r}catch(e){}return null}
function logAct(text){DB.activity.unshift({ts:Date.now(),text});DB.activity=DB.activity.slice(0,60);save()}
function mkTask(o){return Object.assign({id:uid(),title:'',notes:'',project:'',priority:'med',status:'todo',due:'',repeat:'',createdAt:Date.now(),doneAt:null,subtasks:[]},o)}
function seed(){
  const mk=(title,project,priority,status,due,notes,subs)=>mkTask({title,project,priority,status,due:due==null?'':dOff(due),notes:notes||'',createdAt:Date.now()-Math.floor(Math.random()*8*864e5),doneAt:status==='done'?Date.now()-Math.floor(Math.random()*6*864e5):null,subtasks:subs||[]});
  return {
    profile:{name:'Vylonium'},
    projects:[
      {id:'P-DEV',name:'Development',desc:'Pengembangan produk dan rilis fitur'},
      {id:'P-DES',name:'Desain',desc:'Sistem desain, UI, dan aset brand'},
      {id:'P-MKT',name:'Marketing',desc:'Kampanye, konten, dan analitik pertumbuhan'},
      {id:'P-PRS',name:'Personal',desc:'Agenda dan target pribadi'}],
    tasks:[
      mk('Rilis dashboard v2 ke produksi','P-DEV','high','doing',1,'Koordinasi dengan tim QA sebelum deploy.',[{text:'Deploy ke staging',done:true},{text:'Smoke test jalur kritis',done:false},{text:'Pengumuman rilis',done:false}]),
      mk('Perbaiki bug filter pencarian','P-DEV','med','todo',-2),
      mk('Review pull request tim frontend','P-DEV','med','done',-1),
      mk('Audit aksesibilitas komponen inti','P-DEV','low','todo',6),
      mk('Refresh halaman harga','P-DES','med','doing',2),
      mk('Buat variasi logo sekunder','P-DES','low','todo',9),
      mk('Finalisasi design system v1.2','P-DES','high','done',-3),
      mk('Jadwalkan kampanye produk baru','P-MKT','high','todo',0),
      mk('Tulis artikel blog rilis bulan ini','P-MKT','med','todo',3),
      mk('Analitik funnel pendaftaran','P-MKT','med','doing',4),
      mk('Riset kompetitor kuartal ini','P-MKT','low','done',-4),
      mk('Olahraga 30 menit','P-PRS','low','doing',0),
      mk('Baca satu bab buku produk','P-PRS','low','todo',1),
      mk('Rapikan rencana minggu depan','P-PRS','med','done',-2)],
    activity:[{ts:Date.now(),text:'Data contoh dimuat — selamat mencoba!'}]
  };
}
DB=loadDB();
if(!DB){DB=seed();save()}

/* ---------- Data helpers ---------- */
const projName=id=>{const p=DB.projects.find(p=>p.id===id);return p?p.name:'—'};
const getTask=id=>DB.tasks.find(t=>t.id===id);
const isOverdue=t=>t.due&&t.due<todayISO()&&t.status!=='done';
function dueMeta(t){
  if(!t.due)return{cls:'ok',label:'—'};
  if(t.status==='done')return{cls:'ok',label:fmtShort(t.due)};
  if(t.due<todayISO())return{cls:'over',label:fmtShort(t.due)};
  if(t.due===todayISO())return{cls:'today',label:'Hari ini'};
  return{cls:'ok',label:fmtShort(t.due)};
}
const subCount=t=>t.subtasks.length?(' '+t.subtasks.filter(s=>s.done).length+'/'+t.subtasks.length+' sub'):'';

/* ---------- Toast ---------- */
function toast(msg,type){
  const el=document.createElement('div');
  el.className='toast '+(type==='err'?'err':'ok');
  el.textContent=msg;
  $('#toasts').appendChild(el);
  setTimeout(()=>{el.classList.add('out');setTimeout(()=>el.remove(),320)},2600);
}

/* ---------- Modal ---------- */
function openModal(id){const m=$(id);m.hidden=false;requestAnimationFrame(()=>document.body.style.overflow='hidden');const f=m.querySelector('input,textarea,select');if(f)setTimeout(()=>f.focus(),80)}
function closeModal(id){const m=$(id);m.hidden=true;document.body.style.overflow=''}
$$('.veil').forEach(v=>v.addEventListener('click',()=>closeModal('#'+v.closest('.modal').id)));
document.addEventListener('click',e=>{const b=e.target.closest('[data-close]');if(b)closeModal('#'+b.closest('.modal').id)});
document.addEventListener('keydown',e=>{
  if(e.key==='Escape'){const open=$$('.modal:not([hidden])');open.forEach(m=>closeModal('#'+m.id))}
});

/* ---------- Confirm ---------- */
let confirmRes=null;
function askConfirm(msg,okLabel){
  $('#confirmMsg').textContent=msg;
  $('#confirmOk').textContent=okLabel||'Ya, lanjutkan';
  openModal('#mConfirm');
  return new Promise(r=>{confirmRes=r});
}
$('#confirmOk').addEventListener('click',()=>{closeModal('#mConfirm');if(confirmRes)confirmRes(true);confirmRes=null});
$('#confirmCancel').addEventListener('click',()=>{closeModal('#mConfirm');if(confirmRes)confirmRes(false);confirmRes=null});

/* ---------- Counters & reveal ---------- */
function animateCount(el,to){
  if(reduced){el.textContent=num(to);return}
  const t0=performance.now(),dur=900;
  const step=n=>{const p=Math.min(1,(n-t0)/dur),e=1-Math.pow(1-p,3);el.textContent=num(Math.round(to*e));if(p<1)requestAnimationFrame(step)};
  requestAnimationFrame(step);
}
let currentRender=null;
function refresh(){if(currentRender)currentRender()}

/* ---------- Task mutations ---------- */
function toggleDone(id,origin){
  const t=getTask(id);if(!t)return;
  if(t.status==='done'){t.status='todo';t.doneAt=null;logAct('Dibuka kembali: "'+t.title+'"')}
  else{
    t.status='done';t.doneAt=Date.now();logAct('Selesai: "'+t.title+'"');
    if(origin)confettiAt(origin);
    if(t.repeat==='daily'||t.repeat==='weekly'){
      const next=mkTask({title:t.title,notes:t.notes,project:t.project,priority:t.priority,status:'todo',repeat:t.repeat,subtasks:(t.subtasks||[]).map(x=>({text:x.text,done:false}))});
      if(t.due){const d=new Date(t.due+'T00:00:00');d.setDate(d.getDate()+(t.repeat==='weekly'?7:1));next.due=iso(d)}
      DB.tasks.push(next);
      logAct('Berulang: "'+t.title+'" dijadwalkan '+fmtDate(next.due));
    }
  }
  save();refresh();toast('Tugas diperbarui');
}
function confettiAt(el){
  if(reduced)return;
  const r=el.getBoundingClientRect(),cx=r.left+r.width/2,cy=r.top+r.height/2;
  const cols=['#059669','#10B981','#FCD34D','#34D399','#F59E0B'];
  for(let i=0;i<16;i++){
    const p=document.createElement('i');p.className='confetti';
    p.style.left=cx+'px';p.style.top=cy+'px';p.style.background=cols[i%cols.length];
    const a=Math.random()*Math.PI*2,v=50+Math.random()*90;
    p.style.setProperty('--dx',Math.cos(a)*v+'px');
    p.style.setProperty('--dy',(Math.sin(a)*v-70)+'px');
    document.body.appendChild(p);setTimeout(()=>p.remove(),850);
  }
}
function setStatus(id,st){
  const t=getTask(id);if(!t||t.status===st)return;
  t.status=st;t.doneAt=st==='done'?Date.now():null;
  logAct('"'+t.title+'" → '+STATUS[st]);save();refresh();
}

/* ---------- Task modal ---------- */
let editingId=null,tempSubs=[];
function openTaskModal(task,presetStatus,presetDue){
  editingId=task?task.id:null;
  const pj=$('#tProject');
  pj.innerHTML='<option value="">Tanpa Proyek</option>'+DB.projects.map(p=>'<option value="'+p.id+'">'+esc(p.name)+'</option>').join('');
  if(!task&&presetDue)$('#tDue').value=presetDue;
  $('#tTitle').value=task?task.title:'';
  $('#tNotes').value=task?task.notes:'';
  $('#tProject').value=task?task.project:($('#tProject').options[1]?$('#tProject').options[1].value:'');
  $('#tPrio').value=task?task.priority:'med';
  $('#tStatus').value=task?task.status:(presetStatus||'todo');
  $('#tDue').value=task?task.due:'';
  $('#tRepeat').value=task?(task.repeat||''):'';
  tempSubs=task?task.subtasks.map(s=>({text:s.text,done:s.done})):[];
  renderSubs();
  $('#mTaskTitle').textContent=task?'Edit Tugas':'Tugas Baru';
  $('#tDelete').style.display=task?'':'none';
  $('#tSaveTxt').textContent=task?'Simpan Perubahan':'Buat Tugas';
  openModal('#mTask');
}
function renderSubs(){
  const box=$('#subList');
  box.innerHTML=tempSubs.length?'':'<p class="result-note" style="padding:8px 2px">Belum ada subtugas.</p>';
  tempSubs.forEach((s,i)=>{
    const d=document.createElement('div');
    d.className='sub-item'+(s.done?' checked':'');
    d.innerHTML='<input type="checkbox" class="chk" '+(s.done?'checked':'')+'><span>'+esc(s.text)+'</span><button class="sub-del" type="button" aria-label="Hapus">×</button>';
    d.querySelector('.chk').addEventListener('change',()=>{tempSubs[i].done=!tempSubs[i].done;renderSubs()});
    d.addEventListener('click',e=>{if(e.target===d){tempSubs[i].done=!tempSubs[i].done;renderSubs()}});
    d.querySelector('.sub-del').addEventListener('click',()=>{tempSubs.splice(i,1);renderSubs()});
    box.appendChild(d);
  });
}
function saveTask(){
  const title=$('#tTitle').value.trim();
  if(!title){toast('Judul tugas wajib diisi','err');$('#tTitle').focus();return}
  const data={title,notes:$('#tNotes').value.trim(),project:$('#tProject').value,priority:$('#tPrio').value,status:$('#tStatus').value,due:$('#tDue').value,repeat:$('#tRepeat').value,subtasks:tempSubs.filter(s=>s.text.trim())};
  if(editingId){
    const t=getTask(editingId);Object.assign(t,data);
    if(t.status==='done'&&!t.doneAt)t.doneAt=Date.now();
    if(t.status!=='done')t.doneAt=null;
    logAct('Diedit: "'+t.title+'"');toast('Perubahan disimpan');
  }else{
    DB.tasks.unshift(mkTask(Object.assign(data,{doneAt:data.status==='done'?Date.now():null})));
    logAct('Dibuat: "'+title+'"');toast('Tugas dibuat');
  }
  save();closeModal('#mTask');refresh();
}
$('#tSave').addEventListener('click',saveTask);
$('#tDelete').addEventListener('click',()=>{
  askConfirm('Hapus tugas ini secara permanen?','Hapus').then(yes=>{
    if(!yes)return;
    const t=getTask(editingId);if(!t)return;
    DB.tasks=DB.tasks.filter(x=>x.id!==editingId);
    logAct('Dihapus: "'+t.title+'"');save();closeModal('#mTask');refresh();toast('Tugas dihapus');
  });
});
$('#subAddBtn').addEventListener('click',()=>{
  const v=$('#subAddInput').value.trim();if(!v)return;
  tempSubs.push({text:v,done:false});$('#subAddInput').value='';renderSubs();
});
$('#subAddInput').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();$('#subAddBtn').click()}});

/* ---------- Task row builder ---------- */
function taskRow(t,opts){
  opts=opts||{};
  const d=dueMeta(t);
  const row=document.createElement(opts.clickRow?'div':'label');
  row.className='row'+(t.status==='done'?' done':'');
  row.dataset.id=t.id;
  row.innerHTML=
    '<input type="checkbox" class="chk" aria-label="Tandai selesai" '+(t.status==='done'?'checked':'')+'>'+
    '<span class="r-main"><span class="r-title">'+esc(t.title)+'</span><span class="r-meta">'+esc(projName(t.project))+' · '+STATUS[t.status]+subCount(t)+(t.repeat==='daily'?' · berulang harian':t.repeat==='weekly'?' · berulang mingguan':'')+'</span></span>'+
    '<span class="r-due '+d.cls+'">'+d.label+'</span>'+
    '<span class="prio"><i class="dot '+t.priority+'"></i>'+PRIO[t.priority]+'</span>'+
    '<select class="st-sel v-'+t.status+'" aria-label="Status">'+
      Object.keys(STATUS).map(k=>'<option value="'+k+'" '+(k===t.status?'selected':'')+'>'+STATUS[k]+'</option>').join('')+
    '</select>';
  row.querySelector('.chk').addEventListener('change',e=>toggleDone(t.id,e.target));
  const sel=row.querySelector('.st-sel');
  sel.addEventListener('change',()=>setStatus(t.id,sel.value));
  sel.addEventListener('click',e=>e.stopPropagation());
  if(opts.clickRow)row.addEventListener('click',e=>{if(e.target.closest('select,input'))return;openTaskModal(t)});
  return row;
}

/* ================= PAGE: Dashboard ================= */
function initDashboard(){
  currentRender=render;
  const dateStr=new Date().toLocaleDateString('id-ID',{weekday:'long',day:'numeric',month:'long',year:'numeric'});
  const h=new Date().getHours();
  const greet=h<11?'Selamat pagi':h<15?'Selamat siang':h<19?'Selamat sore':'Selamat malam';
  $('#dashDate').textContent=dateStr;
  $('#dashHi').textContent=greet+', '+esc(DB.profile.name);
  const td=todayISO();
  const open=DB.tasks.filter(t=>t.status!=='done').length;
  $('#dashSub').textContent=open===0?'Semua tugas selesai — waktunya istirahat.':'Ada '+open+' tugas aktif. '+(DB.tasks.filter(t=>isOverdue(t)).length)+' di antaranya melewati jatuh tempo.';
  function render(){
    const done=DB.tasks.filter(t=>t.status==='done');
    const doing=DB.tasks.filter(t=>t.status==='doing');
    const over=DB.tasks.filter(t=>isOverdue(t));
    animateCount($('#sTotal'),DB.tasks.length);
    animateCount($('#sDone'),done.length);
    animateCount($('#sDoing'),doing.length);
    animateCount($('#sOver'),over.length);

    /* tugas hari ini */
    const today=DB.tasks.filter(t=>t.due===td||t.status==='doing').sort((a,b)=>PRIO_RANK[a.priority]-PRIO_RANK[b.priority]);
    const tl=$('#todayList');tl.innerHTML='';
    if(!today.length)tl.innerHTML='<p class="empty">Tidak ada tugas untuk hari ini.</p>';
    today.slice(0,6).forEach(t=>tl.appendChild(taskRow(t,{clickRow:true})));

    /* jatuh tempo terdekat */
    const soon=DB.tasks.filter(t=>t.status!=='done'&&t.due&&t.due<=dOff(7)).sort((a,b)=>a.due.localeCompare(b.due)||PRIO_RANK[a.priority]-PRIO_RANK[b.priority]);
    const dl=$('#dueList');dl.innerHTML='';
    if(!soon.length)dl.innerHTML='<p class="empty">Tidak ada tenggat dalam 7 hari ke depan.</p>';
    soon.slice(0,6).forEach(t=>dl.appendChild(taskRow(t,{clickRow:true})));

    /* chart 7 hari */
    const days=[...Array(7)].map((_,i)=>dOff(i-6));
    const counts=days.map(d=>done.filter(t=>t.doneAt&&iso(new Date(t.doneAt))===d).length);
    const max=Math.max(1,...counts);
    $('#weekChart').innerHTML=days.map((d,i)=>{
      const lbl=new Date(d+'T00:00:00').toLocaleDateString('id-ID',{weekday:'short'});
      return '<div class="bar'+(counts[i]===0?' zero':'')+'" title="'+fmtDate(d)+': '+counts[i]+' selesai"><em>'+(counts[i]||'')+'</em><i data-h="'+Math.round(counts[i]/max*100)+'"></i><b>'+lbl+'</b></div>';
    }).join('');
    requestAnimationFrame(()=>requestAnimationFrame(()=>{
      $$('#weekChart .bar i').forEach(i=>i.style.height=(i.dataset.h)+'%');
    }));

    /* aktivitas */
    $('#actList').innerHTML=DB.activity.slice(0,7).map(a=>'<div class="act"><span>'+esc(a.text)+'</span><time>'+fmtTime(a.ts)+'</time></div>').join('')||'<p class="empty">Belum ada aktivitas.</p>';
  }
  render();
  $('#qAddBtn').addEventListener('click',()=>openTaskModal(null));
  $('#qAdd').addEventListener('submit',e=>{
    e.preventDefault();
    const v=$('#qInput').value.trim();if(!v)return;
    DB.tasks.unshift(mkTask({title:v,due:todayISO()}));
    logAct('Dibuat (cepat): "'+v+'"');save();$('#qInput').value='';render();toast('Tugas ditambahkan');
  });
}

/* ================= PAGE: Tasks ================= */
function initTasks(){
  currentRender=render;
  $('#fProj').innerHTML='<option value="all">Semua proyek</option>'+DB.projects.map(p=>'<option value="'+p.id+'">'+esc(p.name)+'</option>').join('');
  let q='',st='all',pr='all',pj='all',sort='new';
  $$('#stChips .chip').forEach(c=>c.addEventListener('click',()=>{
    $$('#stChips .chip').forEach(x=>x.classList.remove('active'));
    c.classList.add('active');st=c.dataset.st;render();
  }));
  $('#fPrio').addEventListener('change',e=>{pr=e.target.value;render()});
  $('#fProj').addEventListener('change',e=>{pj=e.target.value;render()});
  $('#fSort').addEventListener('change',e=>{sort=e.target.value;render()});
  $('#taskSearch').addEventListener('input',e=>{q=e.target.value.toLowerCase().trim();render()});
  $('#newTaskBtn').addEventListener('click',()=>openTaskModal(null));
  function render(){
    let list=DB.tasks.filter(t=>{
      if(st==='over'){if(!isOverdue(t))return false}
      else if(st==='today'){if(t.due!==todayISO())return false}
      else if(st!=='all'&&t.status!==st)return false;
      if(pr!=='all'&&t.priority!==pr)return false;
      if(pj!=='all'&&t.project!==pj)return false;
      if(q&&(t.title+' '+t.notes).toLowerCase().indexOf(q)<0)return false;
      return true;
    });
    list.sort((a,b)=>{
      if(sort==='due')return (a.due||'9999').localeCompare(b.due||'9999');
      if(sort==='az')return a.title.localeCompare(b.title);
      if(sort==='prio')return PRIO_RANK[a.priority]-PRIO_RANK[b.priority];
      return b.createdAt-a.createdAt;
    });
    const box=$('#taskList');box.innerHTML='';
    if(!list.length){box.innerHTML='<p class="empty">Tidak ada tugas yang cocok. Coba ubah filter atau cari kata lain.</p>'}
    else list.forEach(t=>box.appendChild(taskRow(t,{clickRow:true})));
    $('#taskNote').textContent='Menampilkan '+list.length+' dari '+DB.tasks.length+' tugas';
  }
  render();
}

/* ================= PAGE: Board ================= */
function initBoard(){
  currentRender=render;
  const nb=$('#newTaskBtn2');if(nb)nb.addEventListener('click',()=>openTaskModal(null));
  function render(){
    const b=$('#board');b.innerHTML='';
    ['todo','doing','done'].forEach(st=>{
      const list=DB.tasks.filter(t=>t.status===st).sort((a,b)=>PRIO_RANK[a.priority]-PRIO_RANK[b.priority]||b.createdAt-a.createdAt);
      const col=document.createElement('section');
      col.className='col';col.dataset.st=st;
      col.innerHTML='<div class="col-head"><h2>'+STATUS[st]+'</h2><span class="count-pill">'+list.length+'</span></div>';
      list.forEach((t,i)=>{
        const d=dueMeta(t);
        const card=document.createElement('article');
        card.className='kcard'+(isOverdue(t)?' over':'');
        card.draggable=true;card.dataset.id=t.id;
        card.style.animationDelay=(i*0.03)+'s';
        card.innerHTML='<p class="k-title">'+esc(t.title)+'</p><div class="k-meta">'+
          '<span class="prio"><i class="dot '+t.priority+'"></i>'+PRIO[t.priority]+'</span>'+
          '<small>'+esc(projName(t.project))+'</small>'+
          (t.due?'<small class="k-sub"><span class="r-due '+d.cls+'">'+d.label+'</span></small>':'')+
          (t.subtasks.length?'<small>'+t.subtasks.filter(s=>s.done).length+'/'+t.subtasks.length+' sub</small>':'')+
          '</div>';
        card.addEventListener('click',()=>openTaskModal(t));
        card.addEventListener('dragstart',e=>{e.dataTransfer.setData('text/plain',t.id);e.dataTransfer.effectAllowed='move'});
        col.appendChild(card);
      });
      const add=document.createElement('button');
      add.className='col-add';add.textContent='+ Tugas baru';
      add.addEventListener('click',()=>openTaskModal(null,st));
      col.appendChild(add);
      col.addEventListener('dragover',e=>{e.preventDefault();col.classList.add('drag')});
      col.addEventListener('dragleave',e=>{if(!col.contains(e.relatedTarget))col.classList.remove('drag')});
      col.addEventListener('drop',e=>{
        e.preventDefault();col.classList.remove('drag');
        const id=e.dataTransfer.getData('text/plain');
        if(id)setStatus(id,st);
      });
      b.appendChild(col);
    });
  }
  render();
}

/* ================= PAGE: Calendar ================= */
function initCalendar(){
  currentRender=render;
  let cur=new Date();
  $('#calPrev').addEventListener('click',()=>{cur=new Date(cur.getFullYear(),cur.getMonth()-1,1);render()});
  $('#calNext').addEventListener('click',()=>{cur=new Date(cur.getFullYear(),cur.getMonth()+1,1);render()});
  $('#calToday').addEventListener('click',()=>{cur=new Date();render()});
  const MONTHS=['Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember'];
  function render(){
    const y=cur.getFullYear(),m=cur.getMonth();
    $('#calTitle').textContent=MONTHS[m]+' '+y;
    const cal=$('#cal');cal.innerHTML='';
    ['Sen','Sel','Rab','Kam','Jum','Sab','Min'].forEach(d=>{
      const el=document.createElement('div');el.className='cal-dow';el.textContent=d;cal.appendChild(el);
    });
    const first=new Date(y,m,1),offset=(first.getDay()+6)%7,days=new Date(y,m+1,0).getDate(),td=todayISO();
    for(let i=0;i<offset;i++){
      const el=document.createElement('div');el.className='cal-cell dim';cal.appendChild(el);
    }
    for(let d=1;d<=days;d++){
      const dISO=y+'-'+String(m+1).padStart(2,'0')+'-'+String(d).padStart(2,'0');
      const el=document.createElement('div');
      el.className='cal-cell'+(dISO===td?' today':'');
      const dayTasks=DB.tasks.filter(t=>t.due===dISO).sort((a,b)=>PRIO_RANK[a.priority]-PRIO_RANK[b.priority]);
      el.innerHTML='<span class="cal-num">'+d+'</span>';
      const chips=document.createElement('div');chips.className='cal-chips';
      const dots=document.createElement('div');dots.className='cal-dotrow';
      dayTasks.slice(0,3).forEach(t=>{
        const c=document.createElement('span');
        c.className='cal-chip '+(t.status==='done'?'done':t.priority);
        c.textContent=t.title;chips.appendChild(c);
      });
      if(dayTasks.length>3){const more=document.createElement('span');more.className='cal-more';more.textContent='+'+(dayTasks.length-3)+' lagi';chips.appendChild(more)}
      dayTasks.slice(0,4).forEach(t=>{const dot=document.createElement('i');dot.className='cal-dot '+(t.status==='done'?'done':t.priority);dots.appendChild(dot)});
      el.appendChild(chips);el.appendChild(dots);
      el.addEventListener('click',()=>openDay(dISO,d));
      cal.appendChild(el);
    }
  }
  function openDay(dISO,d){
    $('#dayTitle').textContent='Tugas · '+fmtDate(dISO);
    const list=DB.tasks.filter(t=>t.due===dISO).sort((a,b)=>PRIO_RANK[a.priority]-PRIO_RANK[b.priority]);
    const box=$('#dayList');box.innerHTML='';
    if(!list.length)box.innerHTML='<p class="empty">Belum ada tugas untuk tanggal ini.</p>';
    list.forEach(t=>box.appendChild(taskRow(t,{clickRow:true})));
    $('#dayAdd').onclick=()=>{closeModal('#mDay');openTaskModal(null,'todo',dISO)};
    openModal('#mDay');
  }
  render();
}

/* ================= PAGE: Projects ================= */
function initProjects(){
  currentRender=render;
  let editing=null;
  $('#newProjBtn').addEventListener('click',()=>{editing=null;$('#pName').value='';$('#pDesc').value='';$('#mProjTitle').textContent='Proyek Baru';openModal('#mProj')});
  $('#pSave').addEventListener('click',()=>{
    const name=$('#pName').value.trim();
    if(!name){toast('Nama proyek wajib diisi','err');return}
    if(editing){Object.assign(editing,{name,desc:$('#pDesc').value.trim()});logAct('Proyek diedit: '+name)}
    else{DB.projects.push({id:uid(),name,desc:$('#pDesc').value.trim(),createdAt:Date.now()});logAct('Proyek dibuat: '+name)}
    save();closeModal('#mProj');render();toast('Proyek disimpan');
  });
  function render(){
    const box=$('#projList');box.innerHTML='';
    if(!DB.projects.length){box.innerHTML='<p class="empty">Belum ada proyek.</p>';return}
    DB.projects.forEach(p=>{
      const ts=DB.tasks.filter(t=>t.project===p.id);
      const done=ts.filter(t=>t.status==='done').length;
      const pct=ts.length?Math.round(done/ts.length*100):0;
      const row=document.createElement('div');
      row.className='prog-line';
      row.innerHTML='<span class="p-name">'+esc(p.name)+'<small style="display:block;font-weight:500;color:var(--soft);font-size:.74rem;margin-top:2px;white-space:normal">'+esc(p.desc||'')+'</small></span>'+
        '<span class="prog"><i></i></span><span class="p-val">'+done+'/'+ts.length+' · '+pct+'%</span>';
      const actions=document.createElement('span');
      actions.style.display='flex';actions.style.gap='6px';
      const be=document.createElement('button');be.className='btn small ghost';be.textContent='Edit';
      be.addEventListener('click',()=>{editing=p;$('#pName').value=p.name;$('#pDesc').value=p.desc||'';$('#mProjTitle').textContent='Edit Proyek';openModal('#mProj')});
      const bd=document.createElement('button');bd.className='btn small danger';bd.textContent='Hapus';
      bd.addEventListener('click',()=>askConfirm('Hapus proyek "'+p.name+'"? Tugas di dalamnya tidak ikut dihapus (jadi tanpa proyek).','Hapus').then(yes=>{
        if(!yes)return;
        DB.tasks.forEach(t=>{if(t.project===p.id)t.project=''});
        DB.projects=DB.projects.filter(x=>x.id!==p.id);
        logAct('Proyek dihapus: '+p.name);save();render();toast('Proyek dihapus');
      }));
      actions.appendChild(be);actions.appendChild(bd);
      row.appendChild(actions);
      box.appendChild(row);
      requestAnimationFrame(()=>{const bar=row.querySelector('.prog i');setTimeout(()=>bar.style.width=pct+'%',60)});
    });
  }
  render();
}

/* ================= PAGE: Reports ================= */
function initReports(){
  currentRender=render;
  function render(){
    const total=DB.tasks.length,done=DB.tasks.filter(t=>t.status==='done');
    const over=DB.tasks.filter(t=>isOverdue(t));
    const rate=total?Math.round(done.length/total*100):0;
    animateCount($('#rTotal'),total);
    animateCount($('#rDone'),done.length);
    animateCount($('#rOver'),over.length);
    animateCount($('#rStreak'),calcStreak());
    const don=$('#rDonut');don.style.setProperty('--pct',0);
    setTimeout(()=>don.style.setProperty('--pct',rate),150);
    $('#rDonutVal').textContent=rate+'%';
    /* rata-rata durasi */
    const durs=done.filter(t=>t.doneAt).map(t=>(t.doneAt-t.createdAt)/864e5);
    $('#rAvg').textContent=durs.length?(durs.reduce((a,b)=>a+b,0)/durs.length).toFixed(1).replace('.',',')+' hari':'—';
    /* prioritas */
    const dist={high:0,med:0,low:0};DB.tasks.forEach(t=>dist[t.priority]++);
    const dmax=Math.max(1,...Object.values(dist));
    $('#prioDist').innerHTML=Object.keys(PRIO).map(k=>
      '<div class="hbar"><span>'+PRIO[k]+'</span><span class="prog"><i data-w="'+Math.round(dist[k]/dmax*100)+'"></i></span><span class="p-val">'+dist[k]+'</span></div>').join('');
    $$('#prioDist .prog i').forEach(i=>setTimeout(()=>i.style.width=i.dataset.w+'%',120));
    /* chart selesai per hari */
    const days=[...Array(7)].map((_,i)=>dOff(i-6));
    const counts=days.map(d=>done.filter(t=>t.doneAt&&iso(new Date(t.doneAt))===d).length);
    const max=Math.max(1,...counts);
    $('#rWeek').innerHTML=days.map((d,i)=>{
      const lbl=new Date(d+'T00:00:00').toLocaleDateString('id-ID',{weekday:'short'});
      return '<div class="bar'+(counts[i]===0?' zero':'')+'" title="'+fmtDate(d)+': '+counts[i]+' selesai"><em>'+(counts[i]||'')+'</em><i data-h="'+Math.round(counts[i]/max*100)+'"></i><b>'+lbl+'</b></div>';
    }).join('');
    requestAnimationFrame(()=>requestAnimationFrame(()=>{$$('#rWeek .bar i').forEach(i=>i.style.height=i.dataset.h+'%')}));
    /* log */
    $('#rAct').innerHTML=DB.activity.slice(0,20).map(a=>'<div class="act"><span>'+esc(a.text)+'</span><time>'+new Date(a.ts).toLocaleDateString('id-ID',{day:'numeric',month:'short'})+' · '+fmtTime(a.ts)+'</time></div>').join('');
  }
  const pb=$('#printBtn');if(pb)pb.addEventListener('click',()=>window.print());
  function calcStreak(){
    let s=0;for(let i=0;i<30;i++){const d=dOff(-i);const has=DB.tasks.some(t=>t.doneAt&&iso(new Date(t.doneAt))===d);if(has)s++;else if(i>0)break}
    return s;
  }
  render();
}

/* ================= PAGE: Settings ================= */
function initSettings(){
  currentRender=render;
  function render(){
    $('#setName').value=DB.profile.name;
    $('#storeInfo').textContent=DB.tasks.length+' tugas · '+DB.projects.length+' proyek · '+DB.activity.length+' catatan aktivitas tersimpan di perangkat ini.';
  }
  $('#saveName').addEventListener('click',()=>{
    DB.profile.name=$('#setName').value.trim()||'Vylonium';
    save();toast('Profil disimpan');logAct('Profil diperbarui');
  });
  $('#exportBtn').addEventListener('click',()=>{
    const blob=new Blob([JSON.stringify(DB,null,2)],{type:'application/json'});
    const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='vylonium-tasks-'+todayISO()+'.json';a.click();
    setTimeout(()=>URL.revokeObjectURL(a.href),4000);toast('Data diekspor');
  });
  const trig=$('#importTrigger');if(trig)trig.addEventListener('click',()=>$('#importFile').click());
  $('#importFile').addEventListener('change',e=>{
    const f=e.target.files[0];if(!f)return;
    const r=new FileReader();
    r.onload=()=>{
      try{
        const d=JSON.parse(r.result);
        if(!Array.isArray(d.tasks)||!Array.isArray(d.projects))throw 0;
        askConfirm('Timpa data saat ini dengan file ini?','Timpa').then(yes=>{
          if(!yes)return;
          DB=d;save();toast('Data diimpor');setTimeout(()=>location.reload(),600);
        });
      }catch(err){toast('File tidak valid','err')}
    };
    r.readAsText(f);e.target.value='';
  });
  $('#resetBtn').addEventListener('click',()=>askConfirm('Hapus semua data dan muat ulang data contoh?','Reset').then(yes=>{
    if(!yes)return;
    DB=seed();save();toast('Data direset');setTimeout(()=>location.reload(),600);
  }));
  render();
}

/* ---------- Shell: nav, burger, preloader, shortcuts ---------- */
const PAGE=document.body.dataset.page;
$$('.n-link').forEach(a=>{if(a.dataset.nav===PAGE)a.classList.add('active')});
const side=$('#side'),veil=$('#sideVeil');
function closeSide(){side.classList.remove('open');veil.classList.remove('show')}
$('#burger')&&$('#burger').addEventListener('click',()=>{side.classList.toggle('open');veil.classList.toggle('show')});
veil&&veil.addEventListener('click',closeSide);
$$('.n-link').forEach(a=>a.addEventListener('click',closeSide));
if($('.t-date'))$('.t-date').textContent=new Date().toLocaleDateString('id-ID',{day:'numeric',month:'long',year:'numeric'});

/* preloader */
window.addEventListener('load',()=>{setTimeout(()=>$('#pre').classList.add('done'),reduced?0:350)});
setTimeout(()=>{const p=$('#pre');if(p&&!p.classList.contains('done'))p.classList.add('done')},2200);

/* reveal */
const io=new IntersectionObserver(es=>es.forEach(e=>{if(e.isIntersecting){e.target.classList.add('in');io.unobserve(e.target)}}),{threshold:.1});
$$('.reveal').forEach(el=>io.observe(el));

/* shortcuts */
document.addEventListener('keydown',e=>{
  const typing=/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
  if(e.key==='/'&&!typing){const s=$('#taskSearch');if(s){e.preventDefault();s.focus()}}
  if((e.key==='n'||e.key==='N')&&!typing&&$('#mTask')){e.preventDefault();openTaskModal(null)}
});

/* 3D tilt (perangkat dengan pointer halus saja) */
if(matchMedia('(hover:hover) and (pointer:fine)').matches&&!reduced){
  const initTilt=el=>{
    el.addEventListener('mousemove',e=>{
      const r=el.getBoundingClientRect(),x=(e.clientX-r.left)/r.width-.5,y=(e.clientY-r.top)/r.height-.5;
      el.style.transform='perspective(700px) rotateX('+(-y*6).toFixed(2)+'deg) rotateY('+(x*6).toFixed(2)+'deg)';
    });
    el.addEventListener('mouseleave',()=>{el.style.transform=''});
  };
  $$('.stat').forEach(initTilt);
  document.addEventListener('mouseover',e=>{const k=e.target.closest('.kcard');if(k&&!k.dataset.tilt){k.dataset.tilt='1';initTilt(k)}});
}
/* scroll progress bar */
const sprog=document.createElement('div');sprog.className='sprog';document.body.appendChild(sprog);
addEventListener('scroll',()=>{const h=document.documentElement;const m=h.scrollHeight-h.clientHeight;sprog.style.width=(m>0?h.scrollTop/m*100:0)+'%'},{passive:true});

/* page init */
const INIT={dashboard:initDashboard,tasks:initTasks,board:initBoard,calendar:initCalendar,projects:initProjects,reports:initReports,settings:initSettings};
if(INIT[PAGE])INIT[PAGE]();
