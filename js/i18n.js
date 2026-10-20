// Clincoo i18n — penerjemah UI otomatis berbasis kamus.
// Bahasa tersimpan di localStorage 'clincoo_language' ('id' default, 'en', 'es').
// Saat bahasa != id, semua node teks DOM diterjemahkan lewat kamus
// (window.ClincooI18nDict), atribut placeholder/title/aria-label juga, lalu
// MutationObserver menerjemahkan konten yang dirender belakangan (JS/toast).
(function () {
  'use strict';
  var LANG_KEY = 'clincoo_language';
  var LANGS = { id: 'Bahasa Indonesia', en: 'English', es: 'Español' };

  function getLang() {
    try {
      var v = localStorage.getItem(LANG_KEY);
      if (v === 'en' || v === 'es' || v === 'id') return v;
    } catch (e) {}
    return 'id';
  }

  var api = {
    getLang: getLang,
    getLangName: function () { return LANGS[getLang()] || LANGS.id; },
    setLang: function (l) {
      try { localStorage.setItem(LANG_KEY, (l === 'en' || l === 'es') ? l : 'id'); } catch (e) {}
    },
    t: function (s) { return s; }
  };
  window.ClincooI18n = api;

  var DICT = (window.ClincooI18nDict || {})[getLang()];
  if (!DICT || getLang() === 'id') return; // Indonesia: tidak ada yang diubah

  // ---------- normalisasi & pencarian ----------
  function norm(s) { return ('' + s).replace(/\s+/g, ' ').trim(); }

  var NORM = {};
  var PREFIXES = []; // kunci berakhiran ':' -> cocokkan awalan teks ("Label: nilai")
  (function () {
    for (var k in DICT) {
      if (!Object.prototype.hasOwnProperty.call(DICT, k)) continue;
      var nk = norm(k);
      if (!nk) continue;
      NORM[nk] = DICT[k];
      if (nk.charAt(nk.length - 1) === ':') PREFIXES.push(nk);
    }
    PREFIXES.sort(function (a, b) { return b.length - a.length; });
  })();

  function translateStr(s) {
    var n = norm(s);
    if (!n) return null;
    if (Object.prototype.hasOwnProperty.call(NORM, n)) return NORM[n];
    for (var i = 0; i < PREFIXES.length; i++) {
      if (n.lastIndexOf(PREFIXES[i], 0) === 0) return NORM[PREFIXES[i]] + n.slice(PREFIXES[i].length);
    }
    return null;
  }
  api.t = function (s) { var r = translateStr(s); return r === null ? s : r; };

  // ---------- DOM ----------
  var SKIP_TAGS = { SCRIPT: 1, STYLE: 1, CODE: 1, PRE: 1, NOSCRIPT: 1, TEXTAREA: 1 };
  var ATTRS = ['placeholder', 'title', 'aria-label'];

  function translateTextNode(node) {
    var raw = node.nodeValue;
    if (!raw || raw.length < 2 || !/[a-zA-Z\u00C0-\u024F]/.test(raw)) return;
    var m = raw.match(/^(\s*)([\s\S]*?)(\s*)$/);
    var tr = translateStr(m[2]);
    if (tr !== null && tr !== m[2]) node.nodeValue = m[1] + tr + m[3];
  }

  function translateAttrs(el) {
    for (var i = 0; i < ATTRS.length; i++) {
      var v = el.getAttribute && el.getAttribute(ATTRS[i]);
      if (v) {
        var tr = translateStr(v);
        if (tr !== null && tr !== v) el.setAttribute(ATTRS[i], tr);
      }
    }
  }

  function translateTree(root) {
    if (!root) return;
    if (root.nodeType === 3) { translateTextNode(root); return; }
    if (root.nodeType !== 1 && root.nodeType !== 9 && root.nodeType !== 11) return;
    if (root.nodeType === 1 && (SKIP_TAGS[root.tagName] || root.isContentEditable)) return;
    var scope = (root.nodeType === 1) ? root : (document.body || root);
    try {
      var w = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT, {
        acceptNode: function (n) {
          var p = n.parentNode;
          if (p && SKIP_TAGS[p.tagName]) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
      });
      var list = [], n;
      while ((n = w.nextNode())) list.push(n);
      for (var i = 0; i < list.length; i++) translateTextNode(list[i]);
      var we = document.createTreeWalker(scope, NodeFilter.SHOW_ELEMENT, null);
      var els = [];
      while ((n = we.nextNode())) els.push(n);
      for (var j = 0; j < els.length; j++) translateAttrs(els[j]);
    } catch (e) { /* tree-walker tidak didukung: abaikan */ }
  }

  // ---------- konten dinamis ----------
  var pending = [];
  var scheduled = false;
  function flush() {
    scheduled = false;
    var nodes = pending;
    pending = [];
    for (var i = 0; i < nodes.length; i++) translateTree(nodes[i]);
  }
  if (window.MutationObserver) {
    new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        var m = muts[i];
        if (m.type === 'childList') {
          for (var j = 0; j < m.addedNodes.length; j++) {
            var nd = m.addedNodes[j];
            if (nd.nodeType === 3 || nd.nodeType === 1) pending.push(nd);
          }
        } else if (m.type === 'characterData' && m.target) {
          pending.push(m.target);
        }
      }
      if (pending.length && !scheduled) { scheduled = true; setTimeout(flush, 0); }
    }).observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  }

  // alert/confirm yang memakai string UI ikut diterjemahkan
  try {
    var _alert = window.alert;
    window.alert = function (m) { var r = translateStr(m); return _alert(r !== null ? r : m); };
    var _confirm = window.confirm;
    window.confirm = function (m) { var r = translateStr(m); return _confirm(r !== null ? r : m); };
  } catch (e) {}

  // ---------- eksekusi ----------
  function applyAll() {
    try { document.documentElement.setAttribute('lang', getLang()); } catch (e) {}
    try {
      var tt = translateStr(document.title);
      if (tt !== null) document.title = tt;
    } catch (e) {}
    translateTree(document.body || document.documentElement);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', applyAll);
  } else {
    applyAll();
  }
})();
