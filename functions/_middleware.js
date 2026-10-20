export async function onRequest(context) {
  const { request, next } = context;
  const response = await next();
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("text/html") || request.method !== "GET") return response;
  // [21 Okt] penangkap error DINI: jalan di <head> sebelum semua script lain —
  // error yang terjadi saat halaman dimuat (sebelum widget console defer jalan)
  // tidak lagi lolos. Setelah widget aktif (__ccBugActive), snippet berhenti
  // mencatat supaya tidak dobel; widget menyerap isi buffer saat mulai.
  const EARLY = '<script>(function(){window.__ccBugEarlyLogs=[];function P(l,m){try{if(window.__ccBugActive)return;window.__ccBugEarlyLogs.push({level:l,message:String(m).slice(0,600),time:new Date().toLocaleTimeString("id-ID",{hour12:false})});if(window.__ccBugEarlyLogs.length>60)window.__ccBugEarlyLogs.shift();}catch(e){}}function tx(a){try{return Array.prototype.map.call(a,function(x){return x&&(x.stack||x.message)||x;}).join(" ").slice(0,600)}catch(e){return ""}}var oe=console.error,ow=console.warn;console.error=function(){P("error",tx(arguments));return oe.apply(console,arguments)};console.warn=function(){P("warn",tx(arguments));return ow.apply(console,arguments)};window.addEventListener("error",function(e){try{if(e.target&&e.target!==window){P("error","Resource gagal: "+(e.target.src||e.target.href||e.target.tagName))}else{P("error",(e.message||"JS error")+(e.filename?" @ "+e.filename+":"+e.lineno:""))}}catch(x){}},true);window.addEventListener("unhandledrejection",function(e){try{P("error","Unhandled rejection: "+((e.reason&&(e.reason.stack||e.reason.message))||e.reason))}catch(x){}})})();</scr' + 'ipt>';
  return new HTMLRewriter()
    .on("head", {
      element(element) {
        try { element.prepend(EARLY, { html: true }); } catch (e) {}
      }
    })
    .on("body", {
      element(element) {
        element.append('<script src="/assets/ls-quota-guard.js" defer></script><script src="/assets/clincoo-bug.js?v=5" defer></script>', { html: true });
      }
    })
    .transform(response);
}
