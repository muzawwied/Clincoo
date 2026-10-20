/* ================= Vylonium Properti — vanilla, zero deps ================= */
'use strict';
const $=(s,c=document)=>c.querySelector(s);
const $$=(s,c=document)=>Array.from(c.querySelectorAll(s));
const reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;

function toast(msg){
  const t=document.createElement('div');t.className='toast';t.textContent=msg;
  document.body.appendChild(t);
  setTimeout(()=>{t.classList.add('out');setTimeout(()=>t.remove(),320)},3000);
}

/* ---------- data properti ---------- */
const PROPS=[
 {id:1,tipe:'Rumah',judul:'Casa Loka — Rumah Tropis dengan Kolam',area:'Jakarta',lokasi:'Permata Hijau, Jakarta Selatan',harga:3200000000,spec:'4 KT · 3 KM · 240 m²',img:'assets/index.html/assets/demo/vylonium-properti/assets/img/rumah-tropis.jpg',tag:'Populer'},
 {id:2,tipe:'Rumah',judul:'Rumah Minimalis 2 Lantai',area:'Bandung',lokasi:'Dago, Bandung',harga:1850000000,spec:'3 KT · 2 KM · 180 m²',img:'assets/index.html/assets/demo/vylonium-properti/assets/img/rumah-minimalis.jpg',tag:'Baru'},
 {id:3,tipe:'Apartemen',judul:'Sky Garden 2BR Sudirman',area:'Jakarta',lokasi:'Sudirman, Jakarta Selatan',harga:850000000,spec:'2 KT · 1 KM · 68 m²',img:'assets/index.html/assets/demo/vylonium-properti/assets/img/apartemen.jpg',tag:''},
 {id:4,tipe:'Ruko',judul:'Ruko Premier 3 Lantai',area:'Tangerang',lokasi:'Alam Sutera, Tangerang',harga:2400000000,spec:'Luas bangunan 168 m²',img:'assets/index.html/assets/demo/vylonium-properti/assets/img/ruko.jpg',tag:'Investasi'},
 {id:5,tipe:'Rumah',judul:'Villa Anakena Ubud',area:'Bali',lokasi:'Ubud, Bali',harga:5900000000,spec:'5 KT · 5 KM · 420 m²',img:'assets/index.html/assets/demo/vylonium-properti/assets/img/villa.jpg',tag:'Premium'},
 {id:6,tipe:'Tanah',judul:'Kavling Siang Bangun 600 m²',area:'Bali',lokasi:'Kuta Utara, Badung, Bali',harga:780000000,spec:'SHM · 600 m²',img:'assets/index.html/assets/demo/vylonium-properti/assets/img/tanah.jpg',tag:''},
 {id:7,tipe:'Rumah',judul:'Rumah Skandinavia Bintaro',area:'Tangerang',lokasi:'Bintaro, Tangerang Selatan',harga:1200000000,spec:'3 KT · 2 KM · 145 m²',img:'assets/index.html/assets/demo/vylonium-properti/assets/img/rumah-minimalis.jpg',tag:''},
 {id:8,tipe:'Apartemen',judul:'1BR Riverside Gubeng',area:'Surabaya',lokasi:'Gubeng, Surabaya',harga:420000000,spec:'1 KT · 1 KM · 42 m²',img:'assets/index.html/assets/demo/vylonium-properti/assets/img/apartemen.jpg',tag:'Baru'},
 {id:9,tipe:'Tanah',judul:'Kavling Komersial 1.200 m²',area:'Bekasi',lokasi:'Summarecon, Bekasi',harga:1500000000,spec:'SHM · 1.200 m²',img:'assets/index.html/assets/demo/vylonium-properti/assets/img/tanah.jpg',tag:''}
];
const fmtRp=n=>n>=1e9?'Rp '+(Math.round(n/1e9*100)/100).toLocaleString('id-ID')+' M':'Rp '+Math.round(n/1e6).toLocaleString('id-ID')+' jt';
function card(p,i){
  return '<a class="listing fade-in" style="animation-delay:'+(i*60)+'ms" href="kontak.html?properti='+encodeURIComponent(p.judul)+'">'+
   '<div class="l-media"><img src="'+p.img+'" alt="'+p.judul+'" loading="lazy" width="800" height="600">'+
   (p.tag?'<span class="l-tag">'+p.tag+'</span>':'')+'<span class="l-type">'+p.tipe+'</span></div>'+
   '<div class="l-body"><div class="l-price">'+fmtRp(p.harga)+'</div><div class="l-title">'+p.judul+'</div>'+
   '<div class="l-loc">'+p.lokasi+'</div><div class="l-spec"><i>'+p.spec+'</i></div></div></a>';
}

/* ---------- preloader ---------- */
window.addEventListener('load',()=>setTimeout(()=>$('#pre').classList.add('done'),reduced?0:350));
setTimeout(()=>{const p=$('#pre');if(p&&!p.classList.contains('done'))p.classList.add('done')},2400);

/* scroll progress + pill */
const sprog=document.createElement('div');sprog.className='sprog';document.body.appendChild(sprog);
const pill=$('.pill');
addEventListener('scroll',()=>{
  const h=document.documentElement,m=h.scrollHeight-h.clientHeight;
  sprog.style.width=(m>0?h.scrollTop/m*100:0)+'%';
  if(pill)pill.classList.toggle('scrolled',h.scrollTop>20);
},{passive:true});

/* mobile menu */
const mm=$('.m-menu');
if($('#burger')){
  $('#burger').addEventListener('click',()=>mm.classList.toggle('open'));
  if(mm)$$('a',mm).forEach(a=>a.addEventListener('click',()=>mm.classList.remove('open')));
}

/* reveal */
const io=new IntersectionObserver(es=>es.forEach(e=>{if(e.isIntersecting){e.target.classList.add('in');io.unobserve(e.target)}}),{threshold:.1});
$$('.reveal').forEach(el=>io.observe(el));

/* counters */
function animateCount(el){
  const to=parseFloat(el.dataset.count||'0'),suf=el.dataset.suffix||'',dec=(el.dataset.dec||'0');
  const fmt=v=>Number(v.toFixed(+dec)).toLocaleString('id-ID')+suf;
  if(reduced){el.textContent=fmt(to);return}
  const t0=performance.now(),dur=1100;
  const step=n=>{const p=Math.min(1,(n-t0)/dur),e=1-Math.pow(1-p,3);el.textContent=fmt(to*e);if(p<1)requestAnimationFrame(step)};
  requestAnimationFrame(step);
}
const cio=new IntersectionObserver(es=>es.forEach(e=>{if(e.isIntersecting){animateCount(e.target);cio.unobserve(e.target)}}),{threshold:.4});
$$('[data-count]').forEach(el=>cio.observe(el));

/* typing effect */
const typed=$('.typed');
if(typed){
  const words=['rumah','apartemen','ruko','tanah'];
  if(reduced){typed.textContent=words[0]}
  else{
    let wi=0,ci=0,del=false;
    const tick=()=>{
      const w=words[wi];ci+=del?-1:1;
      typed.textContent=w.slice(0,ci);
      let d=del?30:95;
      if(!del&&ci===w.length){del=true;d=1900}
      else if(del&&ci===0){del=false;wi=(wi+1)%words.length;d=350}
      setTimeout(tick,d);
    };
    tick();
  }
}

/* hero search */
const search=$('#searchBar');
if(search){
  search.addEventListener('submit',e=>{
    e.preventDefault();
    const q=new URLSearchParams({
      tipe:$('#sTipe').value,area:$('#sArea').value,max:$('#sMax').value
    });
    location.href='properti.html?'+q.toString();
  });
}

/* ---------- katalog ---------- */
const grid=$('#pGrid');
if(grid){
  const fp=new URLSearchParams(location.search);
  let f={tipe:fp.get('tipe')||'Semua',area:fp.get('area')||'Semua',max:fp.get('max')||'',sort:'baru'};
  const pills=$$('.f-pills button');
  const selArea=$('#fArea'),selMax=$('#fMax'),selSort=$('#fSort'),cnt=$('#fCount');
  function apply(push){
    let list=PROPS.filter(p=>
      (f.tipe==='Semua'||p.tipe===f.tipe)&&
      (f.area==='Semua'||p.area===f.area)&&
      (!f.max||p.harga<=+f.max)
    );
    if(f.sort==='murah')list=list.slice().sort((a,b)=>a.harga-b.harga);
    if(f.sort==='mahal')list=list.slice().sort((a,b)=>b.harga-a.harga);
    grid.innerHTML=list.length
      ? list.map((p,i)=>card(p,i)).join('')
      : '<div class="empty"><b>Tidak ada properti yang cocok</b>Coba longgarkan filter — atau hubungi agen kami untuk permintaan khusus.</div>';
    cnt.textContent=list.length+' properti ditemukan';
    pills.forEach(b=>b.classList.toggle('on',b.dataset.tipe===f.tipe));
    if(selArea)selArea.value=f.area;
    if(selMax)selMax.value=f.max;
    if(selSort)selSort.value=f.sort;
    if(push&&history.replaceState)history.replaceState(null,'','properti.html'+(location.search?'?'+new URLSearchParams({...f,max:f.max||''}).toString():''));
  }
  pills.forEach(b=>b.addEventListener('click',()=>{f.tipe=b.dataset.tipe;apply(true)}));
  if(selArea)selArea.addEventListener('change',()=>{f.area=selArea.value;apply(true)});
  if(selMax)selMax.addEventListener('change',()=>{f.max=selMax.value;apply(true)});
  if(selSort)selSort.addEventListener('change',()=>{f.sort=selSort.value;apply(true)});
  apply(false);
}else{
  /* featured di beranda */
  const fg=$('#fGrid');
  if(fg)fg.innerHTML=PROPS.slice(0,6).map((p,i)=>card(p,i)).join('');
}

/* 3D tilt */
if(matchMedia('(hover:hover) and (pointer:fine)').matches&&!reduced){
  const initTilt=el=>{
    el.addEventListener('mousemove',e=>{
      const r=el.getBoundingClientRect(),x=(e.clientX-r.left)/r.width-.5,y=(e.clientY-r.top)/r.height-.5;
      el.style.transform='perspective(800px) rotateX('+(-y*3).toFixed(2)+'deg) rotateY('+(x*3).toFixed(2)+'deg)';
    });
    el.addEventListener('mouseleave',()=>{el.style.transform=''});
  };
  $$('.stat').forEach(initTilt);
  const hi=$('.hero-img');
  if(hi)initTilt(hi);
}

/* kontak form */
const form=$('#cForm');
if(form){
  const pre=location.search&&new URLSearchParams(location.search).get('properti');
  if(pre)$('#cPesan').value='Saya tertarik dengan "'+pre+'". Mohon info lebih lanjut.';
  form.addEventListener('submit',e=>{
    e.preventDefault();
    const d={nama:$('#cNama').value.trim(),email:$('#cEmail').value.trim(),telepon:$('#cTelp').value.trim(),pesan:$('#cPesan').value.trim()};
    if(!d.nama||!d.email||!d.pesan){toast('Lengkapi nama, email, dan pesan dulu ya.');return}
    const body=encodeURIComponent('Nama: '+d.nama+'\nEmail: '+d.email+(d.telepon?'\nTelepon: '+d.telepon:'')+'\n\n'+d.pesan);
    const a=document.createElement('a');
    a.href='mailto:halo@clincoo.buzz?subject='+encodeURIComponent('Tanya Properti — '+d.nama)+'&body='+body;
    a.click();
    toast('Terima kasih! Aplikasi email akan terbuka untuk mengirim pesanmu.');
    form.reset();
  });
}

/* year */
$$('.year').forEach(y=>y.textContent=new Date().getFullYear());
