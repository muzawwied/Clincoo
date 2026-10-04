// ===== Sinkronisasi Workspace -> GitHub (Sync GitHub) =====
// Engine bersama antara halaman workspace & editor.
// Cara kerja:
//  - Konfigurasi per-proyek: clincoo_syncgh_cfg_<pid> = { on, owner, repo, branch }
//  - Snapshot per-proyek: clincoo_syncgh_snap_<pid> = { repo, files: { path: { sha, hash } } }
//  - schedule() dipanggil tiap workspace berubah (debounce 4 dtk) -> diff isi
//    localStorage workspace vs snapshot -> push/delete via GitHub Contents API.
//  - Token GitHub: clincoo_github_token (dipasang oleh koneksi GitHub di halaman workspace).
(function () {
  var GITHUB_TOKEN_KEY = 'clincoo_github_token';
  var CFG_PREFIX = 'clincoo_syncgh_cfg_';
  var SNAP_PREFIX = 'clincoo_syncgh_snap_';

  function pid() { try { return localStorage.getItem('clincoo_current_project_id') || ''; } catch (e) { return ''; } }
  function pkey(prefix) { return prefix + (pid() || 'global'); }

  function cfg() { try { return JSON.parse(localStorage.getItem(pkey(CFG_PREFIX)) || 'null') || null; } catch (e) { return null; } }
  function setCfg(c) { try { localStorage.setItem(pkey(CFG_PREFIX), JSON.stringify(c)); } catch (e) {} }
  // PENGAMAN: repo Wallet (situs ClincooPay) dikunci — tidak boleh jadi target sync.
  // Pernah 2x tertimpa file proyek lain karena salah sasaran konfigurasi (11 & 13 Sep 2026).
  var BLOCKED_TARGETS = {
    'muzawwied/wallet': 'Repo Wallet (situs ClincooPay) dikunci dan tidak bisa dipakai sebagai target Sync GitHub.'
  };
  function blockedReason() {
    var c = cfg();
    if (!c || !c.owner || !c.repo) return null;
    var k = String(c.owner).toLowerCase() + '/' + String(c.repo).toLowerCase();
    return BLOCKED_TARGETS[k] || null;
  }
  function enabled() {
    var why = blockedReason();
    if (why) { try { console.warn('[SyncGitHub] ' + why); } catch (e) {} return false; }
    var c = cfg(); return !!(c && c.on && c.owner && c.repo);
  }

  function token() { try { return localStorage.getItem(GITHUB_TOKEN_KEY) || ''; } catch (e) { return ''; } }

  function snap() { try { return JSON.parse(localStorage.getItem(pkey(SNAP_PREFIX)) || 'null') || null; } catch (e) { return null; } }
  function setSnap(sn) { try { localStorage.setItem(pkey(SNAP_PREFIX), JSON.stringify(sn)); } catch (e) {} }
  function clearSnap() { try { localStorage.removeItem(pkey(SNAP_PREFIX)); } catch (e) {} }

  // Hash sederhana isi file (djb2) — cukup untuk mendeteksi perubahan.
  function hash(s) {
    var h = 5381, i = 0; s = String(s || '');
    while (i < s.length) { h = ((h << 5) + h + s.charCodeAt(i++)) | 0; }
    return String(h);
  }

  // Rata-ratakan {folder:[item]} menjadi daftar {path, content} — identik dgn wsFlatten di halaman.
  function flatten(data) {
    var files = [];
    Object.keys(data || {}).forEach(function (folderKey) {
      (data[folderKey] || []).forEach(function (it) {
        if (!it || !it.path) return;
        if (it.type === 'file') files.push({ path: it.path, content: it.content || '' });
      });
    });
    return files;
  }

  function currentFiles() {
    try {
      var raw = localStorage.getItem('clincoo_workspace_files_' + (pid() || 'global'));
      if (!raw) return null;
      var d = JSON.parse(raw);
      if (!d || typeof d !== 'object') return null;
      return flatten(d);
    } catch (e) { return null; }
  }

  function b64(str) {
    try { return btoa(unescape(encodeURIComponent(String(str == null ? '' : str)))); }
    catch (e) {
      var out = '', i = 0; str = String(str == null ? '' : str);
      while (i < str.length) { out += String.fromCharCode(str.charCodeAt(i++) & 0xff); }
      return btoa(out);
    }
  }

  function gh(method, url, body) {
    return fetch(url, {
      method: method,
      headers: Object.assign({
        'Authorization': 'Bearer ' + token(),
        'Accept': 'application/vnd.github.v3+json'
      }, body ? { 'Content-Type': 'application/json' } : {}),
      body: body ? JSON.stringify(body) : undefined
    });
  }

  function apiUrl(p) {
    var c = cfg();
    return 'https://api.github.com/repos/' + c.owner + '/' + c.repo + '/contents/' + encodeURIComponent(p).replace(/%2F/g, '/') + '?ref=' + encodeURIComponent(c.branch || 'main');
  }

  function getRemoteSha(p) {
    return gh('GET', apiUrl(p)).then(function (r) {
      if (!r.ok) return null;
      return r.json().then(function (d) { return d && d.sha ? d.sha : null; }).catch(function () { return null; });
    }).catch(function () { return null; });
  }

  // PUT satu file; kalau sha salah (422) ambil sha remote lalu ulang sekali.
  function pushFile(p, content, knownSha) {
    var attempt = function (sha) {
      var body = { message: 'Clincoo sync: update ' + p, content: b64(content), branch: cfg().branch || 'main' };
      if (sha) body.sha = sha;
      return gh('PUT', apiUrl(p), body).then(function (r) {
        if (r.status === 422 && !sha) return getRemoteSha(p).then(function (s) { return s ? attempt(s) : { ok: false, error: '422 tanpa sha' }; });
        if (!r.ok) return { ok: false, error: 'HTTP ' + r.status };
        return r.json().then(function (d) { return { ok: true, sha: d && d.content && d.content.sha ? d.content.sha : null }; }).catch(function () { return { ok: true, sha: null }; });
      });
    };
    return attempt(knownSha || null);
  }

  function deleteFile(p, sha) {
    if (!sha) return Promise.resolve({ ok: false, error: 'sha tidak diketahui' });
    return gh('DELETE', apiUrl(p).split('?')[0] + '?ref=' + encodeURIComponent(cfg().branch || 'main'), { message: 'Clincoo sync: hapus ' + p, sha: sha, branch: cfg().branch || 'main' })
      .then(function (r) { return r.ok ? { ok: true } : { ok: false, error: 'HTTP ' + r.status }; })
      .catch(function (e) { return { ok: false, error: String(e) }; });
  }

  // Sinkronisasi penuh: diff workspace vs snapshot -> push perubahan.
  // onProgress(done, total, lastPath) opsional untuk UI.
  function syncNow(onProgress) {
    if (!enabled()) return Promise.resolve({ ok: true, skipped: true, changed: 0 });
    if (!token()) return Promise.resolve({ ok: false, error: 'GitHub belum terhubung', changed: 0 });

    var files = currentFiles();
    if (!files) return Promise.resolve({ ok: false, error: 'Workspace kosong / tidak terbaca', changed: 0 });

    var c = cfg();
    var sn = snap();
    var snapFiles = (sn && sn.repo === (c.owner + '/' + c.repo) && sn.files) ? sn.files : {};

    var cur = {};
    files.forEach(function (f) { cur[f.path] = { hash: hash(f.content), content: f.content }; });

    var ops = [];
    Object.keys(cur).forEach(function (p) {
      if (!snapFiles[p] || snapFiles[p].hash !== cur[p].hash) ops.push({ op: 'put', path: p, content: cur[p].content, sha: snapFiles[p] ? snapFiles[p].sha : null });
    });
    Object.keys(snapFiles).forEach(function (p) {
      if (!(p in cur)) ops.push({ op: 'del', path: p, sha: snapFiles[p].sha });
    });

    if (ops.length === 0) return Promise.resolve({ ok: true, changed: 0 });

    // Batasi batch agar tidak menghantam rate-limit GitHub (sinkronisasi lanjut di jadwal berikut).
    var MAX_OPS = 60;
    var batch = ops.slice(0, MAX_OPS);
    var done = 0, errors = 0;
    var newSnapFiles = {};
    Object.keys(snapFiles).forEach(function (p) { newSnapFiles[p] = snapFiles[p]; });

    var chain = Promise.resolve();
    batch.forEach(function (op) {
      chain = chain.then(function () {
        var work = (op.op === 'put')
          ? pushFile(op.path, op.content, op.sha)
          : deleteFile(op.path, op.sha);
        return work.then(function (r) {
          done++;
          if (onProgress) { try { onProgress(done, batch.length, op.path); } catch (e) {} }
          if (r && r.ok) {
            if (op.op === 'put') {
              newSnapFiles[op.path] = { hash: hash(op.content), sha: r.sha || (op.sha || null) };
            } else {
              delete newSnapFiles[op.path];
            }
          } else {
            errors++;
          }
        });
      });
    });

    return chain.then(function () {
      setSnap({ repo: c.owner + '/' + c.repo, files: newSnapFiles });
      var remaining = ops.length - batch.length;
      if (remaining > 0) {
        // belum semua tersinkron — jadwalkan lagi otomatis
        setTimeout(function () { run(); }, 3000);
      }
      return { ok: errors === 0, changed: batch.length - errors, errors: errors, remaining: remaining };
    });
  }

  var timer = null;
  var listeners = [];
  function schedule() {
    if (!enabled() || !token()) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(run, 4000);
  }
  function run() {
    if (!enabled() || !token()) return;
    return syncNow().then(function (r) {
      listeners.forEach(function (f) { try { f(r); } catch (e) {} });
    }).catch(function () {});
  }
  function onChange(f) { if (typeof f === 'function') listeners.push(f); }

  function disable() { setCfg(Object.assign({}, cfg() || {}, { on: false })); }
  function enable(owner, repo, branch) { setCfg({ on: true, owner: owner, repo: repo, branch: branch || 'main' }); }
  // Simpan repo hasil import (belum aktif) — toggle Sync GitHub muncul berdasarkan ini.
  function prepare(owner, repo, branch) { setCfg({ on: false, owner: owner, repo: repo, branch: branch || 'main' }); }
  function resetSnapshot() { clearSnap(); }

  window.WSGitHubSync = {
    cfg: cfg,
    enabled: enabled,
    enable: enable,
    prepare: prepare,
    disable: disable,
    resetSnapshot: resetSnapshot,
    schedule: schedule,
    syncNow: syncNow,
    onChange: onChange
  };
})();
