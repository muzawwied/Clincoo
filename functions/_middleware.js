export async function onRequest(context) {
  const { request, next } = context;
  const response = await next();
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("text/html") || request.method !== "GET") return response;
  // [21 Okt] penangkap error DINI: jalan di <head> sebelum semua script lain —
  // error yang terjadi saat halaman dimuat (sebelum widget console defer jalan)
  // tidak lagi lolos. Setelah widget aktif (__ccBugActive), snippet berhenti
  // mencatat supaya tidak dobel; widget menyerap isi buffer saat mulai.
  const EARLY = '<script>(function(){window.__ccBugEarlyLogs=[];function P(l,m){try{if(window.__ccBugActive)return;if(/tailwindcss\.com|googletagmanager\.com|google-analytics\.com|gtag\/js|doubleclick\.net|clarity\.ms|googlesyndication\.com|pagead2|adsbygoogle|adservice\.google|amazon-adsystem|taboola|outbrain|criteo|pubmatic|adnxs|quantserve|scorecardresearch|ERR_BLOCKED_BY_CLIENT|net::ERR_BLOCKED|pemblokir iklan/i.test(String(m)))return;window.__ccBugEarlyLogs.push({level:l,message:String(m).slice(0,600),time:new Date().toLocaleTimeString("id-ID",{hour12:false})});if(window.__ccBugEarlyLogs.length>60)window.__ccBugEarlyLogs.shift();}catch(e){}}function tx(a){try{return Array.prototype.map.call(a,function(x){return x&&(x.stack||x.message)||x;}).join(" ").slice(0,600)}catch(e){return ""}}var oe=console.error,ow=console.warn;console.error=function(){P("error",tx(arguments));return oe.apply(console,arguments)};console.warn=function(){P("warn",tx(arguments));return ow.apply(console,arguments)};window.addEventListener("error",function(e){try{if(e.target&&e.target!==window){P("error","Resource gagal: "+(e.target.src||e.target.href||e.target.tagName))}else{P("error",(e.message||"JS error")+(e.filename?" @ "+e.filename+":"+e.lineno:""))}}catch(x){}},true);window.addEventListener("unhandledrejection",function(e){try{P("error","Unhandled rejection: "+((e.reason&&(e.reason.stack||e.reason.message))||e.reason))}catch(x){}});/* [3 Nov] Pelindung kuota localStorage dipasang SEBELUM skrip halaman mana pun berjalan. Aset ls-quota-guard.js dimuat defer, jadi tulisan localStorage dari skrip inline lebih dulu tanpa pelindung dan halaman bisa mati saat memori browser penuh. */try{var _ls=window.localStorage;if(_ls&&_ls.setItem){var _si=_ls.setItem.bind(_ls);_ls.setItem=function(k,v){try{return _si(k,v)}catch(e){window.__clincooLsFull=true;try{console.warn("Cache lokal penuh (aman): perubahan tetap disimpan ke cloud.")}catch(x){}return null}};}}catch(e){}})();</scr' + 'ipt>';
  return new HTMLRewriter()
    .on("head", {
      element(element) {
        try { element.prepend(EARLY, { html: true }); } catch (e) {}
      }
    })
    .on("body", {
      element(element) {
        element.append('<script src="/assets/ls-quota-guard.js" defer></script><script src="/assets/clincoo-bug.js?v=7" defer></script>', { html: true });
      }
    })
    .transform(response);
}
