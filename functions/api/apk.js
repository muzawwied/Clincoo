// Cloudflare Pages Functions - APK Builder (sistem PressForge, port ke Clincoo)
// Kemas situs proyek jadi aplikasi Android (WebView) lewat GitHub Actions di
// repo pressforge-builds. Alur: POST mulai build, GET pantau progres, GET
// action=download ambil APK jadi. Semua operasi wajib lolos guard kepemilikan.
//
// POST /api/apk  { project_id, build_id, url, app_name, package_id, orientation, fullscreen, icon_base64 }
// GET  /api/apk?project_id=&build_id=          -> status build (found, run_id, status, conclusion, steps)
// GET  /api/apk?project_id=&action=download&run_id=&name=  -> file APK siap install

import { getProjectTables } from './_tables.js';
import { guardProject } from './user-scope.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

// ===== Sistem PressForge: workflow + generator proyek Android =====
const REPO_NAME = 'pressforge-builds';
const WORKFLOW_PATH = '.github/workflows/build.yml';
const GENERATOR_PATH = '.forge/generate.py';

const WORKFLOW = `name: build
run-name: forge-\${{ inputs.build_id }}
on:
  workflow_dispatch:
    inputs:
      build_id: { required: true }
      url: { required: true }
      app_name: { required: true }
      package_id: { required: true }
      orientation: { required: true, default: portrait }
      fullscreen: { required: true, default: "true" }
      keystore_b64: { required: false, default: "" }
permissions:
  contents: read
jobs:
  apk:
    runs-on: ubuntu-latest
    env:
      BUILD_ID: \${{ inputs.build_id }}
      APP_URL: \${{ inputs.url }}
      APP_NAME: \${{ inputs.app_name }}
      PKG: \${{ inputs.package_id }}
      ORIENT: \${{ inputs.orientation }}
      FULLSCREEN: \${{ inputs.fullscreen }}
      KEYSTORE_B64: \${{ inputs.keystore_b64 }}
    steps:
      - uses: actions/checkout@v4
      - name: Siapkan Java
        uses: actions/setup-java@v4
        with: { distribution: temurin, java-version: "17" }
      - name: Siapkan Gradle
        uses: gradle/actions/setup-gradle@v4
        with: { gradle-version: "8.7" }
      - name: Susun proyek Android
        run: python3 .forge/generate.py
      - name: Compile APK
        run: gradle -p app-src assembleRelease --no-daemon
      - name: Signing APK
        run: |
          BT=$ANDROID_HOME/build-tools/$(ls $ANDROID_HOME/build-tools | sort -V | tail -1)
          if [ -n "$KEYSTORE_B64" ]; then
            printf '%s' "$KEYSTORE_B64" | base64 --decode > forge.jks
          else
            keytool -genkeypair -keystore forge.jks -storepass forgepass -keypass forgepass -alias forge -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=PressForge"
          fi
          $BT/zipalign -p -f 4 app-src/app/build/outputs/apk/release/app-release-unsigned.apk aligned.apk
          mkdir -p out
          $BT/apksigner sign --ks forge.jks --ks-pass pass:forgepass --key-pass pass:forgepass --out out/app.apk aligned.apk
      - name: Upload APK
        uses: actions/upload-artifact@v4
        with: { name: apk, path: out/app.apk, retention-days: 7 }
      - name: Upload keystore
        uses: actions/upload-artifact@v4
        with: { name: keystore, path: forge.jks, retention-days: 7 }
`;

const GENERATOR = `import os, json, shutil, html
from pathlib import Path
e = os.environ
pkg = e["PKG"]; url = e["APP_URL"]; name = e["APP_NAME"]; bid = e["BUILD_ID"]
orient = "landscape" if e["ORIENT"] == "landscape" else "portrait"
full = e["FULLSCREEN"] == "true"
root = Path("app-src"); src = root / "app/src/main"
java = src / "java" / Path(*pkg.split("."))
for d in [java, src / "res/drawable-nodpi", src / "res/values"]:
    d.mkdir(parents=True, exist_ok=True)
(root / "settings.gradle").write_text("""pluginManagement { repositories { google(); mavenCentral(); gradlePluginPortal() } }
dependencyResolutionManagement { repositories { google(); mavenCentral() } }
rootProject.name = "forgeapp"
include ':app'
""")
(root / "build.gradle").write_text("plugins { id 'com.android.application' version '8.5.2' apply false }\\n")
(root / "gradle.properties").write_text("org.gradle.jvmargs=-Xmx2g\\nandroid.useAndroidX=true\\n")
(root / "app/build.gradle").write_text("""plugins { id 'com.android.application' }
android {
  namespace '__PKG__'
  compileSdk 34
  defaultConfig { applicationId '__PKG__'; minSdk 21; targetSdk 34; versionCode 1; versionName '1.0' }
  buildTypes { release { minifyEnabled false } }
  compileOptions { sourceCompatibility JavaVersion.VERSION_17; targetCompatibility JavaVersion.VERSION_17 }
  lint { checkReleaseBuilds false; abortOnError false }
}
""".replace("__PKG__", pkg))
theme = "@android:style/Theme.Material.NoActionBar.Fullscreen" if full else "@android:style/Theme.Material.Light.NoActionBar"
(src / "AndroidManifest.xml").write_text("""<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
  <uses-permission android:name="android.permission.INTERNET" />
  <application android:label="@string/app_name" android:icon="@drawable/ic_launcher" android:theme="__THEME__" android:usesCleartextTraffic="true">
    <activity android:name=".MainActivity" android:exported="true" android:screenOrientation="__ORIENT__" android:configChanges="orientation|screenSize|keyboardHidden">
      <intent-filter>
        <action android:name="android.intent.action.MAIN" />
        <category android:name="android.intent.category.LAUNCHER" />
      </intent-filter>
    </activity>
  </application>
</manifest>
""".replace("__THEME__", theme).replace("__ORIENT__", orient))
safe = html.escape(name).replace("'", chr(92) + "'")
(src / "res/values/strings.xml").write_text('<resources><string name="app_name">' + safe + '</string></resources>')
(java / "MainActivity.java").write_text("""package __PKG__;
import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.*;
public class MainActivity extends Activity {
  private WebView web;
  @Override protected void onCreate(Bundle b) {
    super.onCreate(b);
    web = new WebView(this);
    WebSettings s = web.getSettings();
    s.setJavaScriptEnabled(true);
    s.setDomStorageEnabled(true);
    s.setLoadWithOverviewMode(true);
    s.setUseWideViewPort(true);
    web.setWebViewClient(new WebViewClient() {
      @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
        String u = r.getUrl().toString();
        if (u.startsWith("http://") || u.startsWith("https://")) return false;
        try { startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(u))); } catch (Exception ex) {}
        return true;
      }
    });
    web.setWebChromeClient(new WebChromeClient());
    setContentView(web);
    if (b != null) web.restoreState(b); else web.loadUrl(__URL__);
  }
  @Override protected void onSaveInstanceState(Bundle o) { super.onSaveInstanceState(o); web.saveState(o); }
  @Override public void onBackPressed() { if (web.canGoBack()) web.goBack(); else super.onBackPressed(); }
}
""".replace("__PKG__", pkg).replace("__URL__", json.dumps(url)))
shutil.copy("icons/" + bid + ".png", src / "res/drawable-nodpi/ic_launcher.png")
print("proyek siap untuk", pkg)
`;

// ===== Koneksi GitHub (token utama dari env_vars D1, cadangan dari env) =====
async function getToken(env) {
  const t = String(env.GITHUB_TOKEN || '').trim();
  if (t) return t;
  if (!env.DB) return null;
  try {
    const row = await env.DB.prepare("SELECT value FROM env_vars WHERE key IN ('GITHUB_DATA_TOKEN','GITHUB_TOKEN')").first();
    return row ? String(row.value || '').trim() : null;
  } catch (e) { return null; }
}

async function gh(env, path, init = {}) {
  const token = await getToken(env);
  if (!token) throw new Error('Token GitHub belum terpasang');
  return fetch('https://api.github.com' + path, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: 'Bearer ' + token,
      'User-Agent': 'clincoo-apk',
      'Content-Type': 'application/json',
      ...(init.headers || {})
    }
  });
}

async function ghJson(env, path, init = {}) {
  const res = await gh(env, path, init);
  if (!res.ok) {
    const body = await res.text();
    throw new Error('GitHub error ' + res.status + ': ' + body.slice(0, 200));
  }
  return res.status === 204 ? null : res.json();
}

async function getOwner(env) {
  const u = await ghJson(env, '/user');
  return u.login;
}

const b64 = (str) => btoa(unescape(encodeURIComponent(String(str))));

async function putFile(env, repo, path, content, message) {
  const res = await gh(env, '/repos/' + repo + '/contents/' + path);
  let sha;
  if (res.ok) {
    const cur = await res.json();
    if (atob(cur.content) === content) return; // sudah sama, skip
    sha = cur.sha;
  }
  await ghJson(env, '/repos/' + repo + '/contents/' + path, {
    method: 'PUT',
    body: JSON.stringify({ message, content: b64(content), sha })
  });
}

// Pastikan repo builds + workflow + generator siap (idempoten)
async function ensureRepo(env) {
  const owner = await getOwner(env);
  const repo = owner + '/' + REPO_NAME;
  const res = await gh(env, '/repos/' + repo);
  if (res.status === 404) {
    await ghJson(env, '/user/repos', {
      method: 'POST',
      body: JSON.stringify({ name: REPO_NAME, private: true, auto_init: true, description: 'Clincoo APK builds (sistem PressForge)' })
    });
    await new Promise(r => setTimeout(r, 2000));
  }
  await putFile(env, repo, WORKFLOW_PATH, WORKFLOW, 'workflow build APK');
  await putFile(env, repo, GENERATOR_PATH, GENERATOR, 'generator proyek Android');
  return repo;
}

// ===== Zip: ambil satu file dari arsip artifact tanpa dependensi =====
async function unzipOne(buf, want) {
  const u = new Uint8Array(buf);
  const dv = (o) => (u[o] | (u[o + 1] << 8) | (u[o + 2] << 16) | (u[o + 3] << 24)) >>> 0;
  // cari End of Central Directory dari ekor arsip
  let eocd = -1;
  const stop = Math.max(0, u.length - 66000);
  for (let i = u.length - 22; i >= stop; i--) {
    if (u[i] === 0x50 && u[i + 1] === 0x4b && u[i + 2] === 0x05 && u[i + 3] === 0x06) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('format zip tidak dikenal');
  const count = u[eocd + 10] | (u[eocd + 11] << 8);
  let p = dv(eocd + 16);
  for (let i = 0; i < count; i++) {
    if (dv(p) !== 0x02014b50) break;
    const method = u[p + 10] | (u[p + 11] << 8);
    const csize = dv(p + 20);
    const nameLen = u[p + 28] | (u[p + 29] << 8);
    const extraLen = u[p + 30] | (u[p + 31] << 8);
    const commentLen = u[p + 32] | (u[p + 33] << 8);
    const lho = dv(p + 42);
    let fname = '';
    for (let j = 0; j < nameLen; j++) fname += String.fromCharCode(u[p + 46 + j]);
    if (fname === want) {
      if (dv(lho) !== 0x04034b50) throw new Error('header zip rusak');
      const lnameLen = u[lho + 26] | (u[lho + 27] << 8);
      const lextraLen = u[lho + 28] | (u[lho + 29] << 8);
      const dataOff = lho + 30 + lnameLen + lextraLen;
      const comp = u.subarray(dataOff, dataOff + csize);
      if (method === 0) return comp; // stored
      if (method !== 8) throw new Error('metode kompresi zip tidak didukung');
      const ds = new DecompressionStream('deflate-raw');
      const out = await new Response(new Blob([comp]).stream().pipeThrough(ds)).arrayBuffer();
      return new Uint8Array(out);
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error('file ' + want + ' tidak ada di arsip');
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...CORS } });
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

// ===== GET: status build / unduh APK =====
export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const projectId = url.searchParams.get('project_id') || '';
  const deny = await guardProject(env, request, projectId);
  if (deny) return deny;
  const action = url.searchParams.get('action');
  const db = env.DB;
  const T = await getProjectTables(db, projectId);

  if (action === 'download') {
    const runId = (url.searchParams.get('run_id') || '').replace(/\D/g, '');
    const name = (url.searchParams.get('name') || 'app').replace(/[^a-zA-Z0-9._-]/g, '');
    if (!runId) return json({ error: 'run_id required' }, 400);
    try {
      const owner = await getOwner(env);
      const repo = owner + '/' + REPO_NAME;
      const arts = await ghJson(env, '/repos/' + repo + '/actions/runs/' + runId + '/artifacts');
      const art = (arts.artifacts || []).find(a => a.name === 'apk' && !a.expired);
      if (!art) return json({ error: 'APK tidak ditemukan atau sudah kedaluwarsa (retensi 7 hari). Bangun ulang APK-nya.' }, 404);
      let res = await gh(env, '/repos/' + repo + '/actions/artifacts/' + art.id + '/zip', { headers: { Authorization: 'Bearer ' + (await getToken(env)) } });
      const loc = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && loc) res = await fetch(loc);
      if (!res.ok) return json({ error: 'Gagal mengunduh arsip (' + res.status + ')' }, 502);
      const apk = await unzipOne(await res.arrayBuffer(), 'app.apk');
      return new Response(apk, {
        headers: {
          'Content-Type': 'application/vnd.android.package-archive',
          'Content-Disposition': 'attachment; filename="' + (name || 'app') + '.apk"',
          'Content-Length': String(apk.byteLength),
          ...CORS
        }
      });
    } catch (err) {
      return json({ error: err.message }, 500);
    }
  }

  // default: status build
  const buildId = (url.searchParams.get('build_id') || '').toLowerCase();
  if (!/^[a-z0-9]{6,16}$/.test(buildId)) return json({ error: 'build_id tidak valid' }, 400);
  try {
    const owner = await getOwner(env);
    const repo = owner + '/' + REPO_NAME;
    const runs = await ghJson(env, '/repos/' + repo + '/actions/workflows/build.yml/runs?per_page=30');
    const run = (runs.workflow_runs || []).find(r => r.display_title === 'forge-' + buildId);
    if (!run) return json({ found: false, steps: [] });
    const jobs = await ghJson(env, '/repos/' + repo + '/actions/runs/' + run.id + '/jobs');
    const steps = ((jobs.jobs || [])[0]?.steps || [])
      .filter(s => !/^(Set up job|Complete job|Post )/.test(s.name))
      .map(s => ({ name: s.name, status: s.status, conclusion: s.conclusion }));
    const state = {
      found: true,
      run_id: run.id,
      status: run.status,          // queued | in_progress | completed
      conclusion: run.conclusion,  // success | failure | null saat berjalan
      steps
    };
    // simpan progres terakhir ke settings (merge field lama: app_name/url) supaya tahan lintas perangkat
    try {
      let prev = {};
      try {
        const row = await db.prepare(`SELECT value FROM ${T.projectSettings} WHERE project_id = ? AND key = 'apk_job'`).bind(projectId).first();
        if (row) prev = JSON.parse(row.value) || {};
      } catch (e) {}
      await db.prepare(`INSERT OR REPLACE INTO ${T.projectSettings} (project_id, key, value) VALUES (?, 'apk_job', ?)`)
        .bind(projectId, JSON.stringify({
          ...prev,
          build_id: buildId, run_id: run.id, status: run.status, conclusion: run.conclusion,
          updated_at: new Date().toISOString()
        })).run();
    } catch (e) {}

    // build sukses pertama kali: ambil keystore dari artifact lalu simpan permanen per proyek.
    // Build berikutnya otomatis pakai kunci ini — sertifikat konsisten, APK bisa diupdate tanpa uninstall.
    if (run.status === 'completed' && run.conclusion === 'success') {
      try {
        const stored = await db.prepare(`SELECT value FROM ${T.projectSettings} WHERE project_id = ? AND key = 'apk_keystore'`).bind(projectId).first();
        if (!stored) {
          const arts = await ghJson(env, '/repos/' + repo + '/actions/runs/' + run.id + '/artifacts');
          const art = (arts.artifacts || []).find(a => a.name === 'keystore' && !a.expired);
          if (art) {
            let res = await gh(env, '/repos/' + repo + '/actions/artifacts/' + art.id + '/zip');
            const loc = res.headers.get('location');
            if (res.status >= 300 && res.status < 400 && loc) res = await fetch(loc);
            if (res.ok) {
              const ks = await unzipOne(await res.arrayBuffer(), 'forge.jks');
              let bin = '';
              for (let i = 0; i < ks.length; i += 4096) bin += String.fromCharCode.apply(null, ks.subarray(i, i + 4096));
              await db.prepare(`INSERT OR REPLACE INTO ${T.projectSettings} (project_id, key, value) VALUES (?, 'apk_keystore', ?)`)
                .bind(projectId, JSON.stringify({ ks_b64: btoa(bin), run_id: run.id, created_at: new Date().toISOString() })).run();
            }
          }
        }
      } catch (e) {}
    }
    return json(state);
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}

// ===== POST: mulai build baru =====
export async function onRequestPost({ request, env }) {
  const db = env.DB;
  try {
    const body = await request.json();
    const projectId = body.project_id || '';
    const deny = await guardProject(env, request, projectId);
    if (deny) return deny;

    const buildId = String(body.build_id || '').toLowerCase();
    const url = String(body.url || '').trim();
    const appName = String(body.app_name || '').trim();
    let packageId = String(body.package_id || '').trim();
    const orientation = body.orientation === 'landscape' ? 'landscape' : 'portrait';
    const fullscreen = body.fullscreen === true || body.fullscreen === 'true';
    const iconBase64 = String(body.icon_base64 || '').replace(/^data:image\/png;base64,/, '');

    if (!/^[a-z0-9]{6,16}$/.test(buildId)) return json({ error: 'build_id tidak valid (6-16 huruf kecil/angka)' }, 400);
    if (!/^https?:\/\/.+\..+/.test(url)) return json({ error: 'URL situs tidak valid' }, 400);
    if (!appName || appName.length > 40) return json({ error: 'Nama aplikasi 1-40 karakter' }, 400);
    if (!packageId) {
      packageId = 'id.' + String(url.replace(/^https?:\/\//, '').replace(/[^a-z0-9]+/g, '').slice(0, 20)) + '.app';
    }
    if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(packageId)) return json({ error: 'Package id tidak valid' }, 400);
    if (iconBase64.length < 10 || iconBase64.length > 3_000_000) return json({ error: 'Ikon tidak valid (maks ~2MB)' }, 400);

    const repo = await ensureRepo(env);

    // keystore tetap per proyek: dipakai ulang tiap build supaya sertifikat konsisten
    // (APK bisa diupdate langsung tanpa uninstall; reputasi Play Protect tidak reset tiap build)
    const T = await getProjectTables(db, projectId);
    let ksB64 = '';
    try {
      const row = await db.prepare(`SELECT value FROM ${T.projectSettings} WHERE project_id = ? AND key = 'apk_keystore'`).bind(projectId).first();
      if (row) ksB64 = (JSON.parse(row.value) || {}).ks_b64 || '';
    } catch (e) {}

    // unggah ikon -> icons/<build_id>.png (sha kalau file sudah ada, biar aman dipakai ulang)
    {
      const ipath = 'icons/' + buildId + '.png';
      const cur = await gh(env, '/repos/' + repo + '/contents/' + ipath);
      let sha;
      if (cur.ok) sha = (await cur.json()).sha;
      await ghJson(env, '/repos/' + repo + '/contents/' + ipath, {
        method: 'PUT',
        body: JSON.stringify({ message: 'icon ' + buildId, content: iconBase64, sha })
      });
    }

    const inputs = {
      build_id: buildId,
      url: url,
      app_name: appName,
      package_id: packageId,
      orientation: orientation,
      fullscreen: String(fullscreen)
    };
    if (ksB64) inputs.keystore_b64 = ksB64;
    const payload = JSON.stringify({ ref: 'main', inputs });
    let dispatched = false;
    let lastErr = '';
    for (let i = 0; i < 5; i++) {
      const res = await gh(env, '/repos/' + repo + '/actions/workflows/build.yml/dispatches', { method: 'POST', body: payload });
      if (res.ok) { dispatched = true; break; }
      lastErr = 'HTTP ' + res.status + ': ' + (await res.text()).slice(0, 200);
      await new Promise(r => setTimeout(r, 2500));
    }
    if (!dispatched) return json({ error: 'Gagal memulai build: ' + lastErr }, 502);

    // catat job di settings (tahan refresh, lintas perangkat)
    await db.prepare(`INSERT OR REPLACE INTO ${T.projectSettings} (project_id, key, value) VALUES (?, 'apk_job', ?)`)
      .bind(projectId, JSON.stringify({
        build_id: buildId, app_name: appName, url: url, package_id: packageId,
        status: 'starting', created_at: new Date().toISOString()
      })).run();

    return json({ ok: true, build_id: buildId, package_id: packageId });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
