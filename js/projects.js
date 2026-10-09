// Escape HTML — wajib untuk semua data user/server sebelum masuk innerHTML (anti-XSS)
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function stripMd(text) {
    if (!text) return '';
    return String(text)
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/`([^`]+)`/g, '$1')
        .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/^#{1,6}\s+/gm, '')
        .replace(/(\*\*|__)(.*?)\1/g, '$2')
        .replace(/(\*|_)(.*?)\1/g, '$2')
        .replace(/~~(.*?)~~/g, '$1')
        .replace(/^\s*[-*+]\s+/gm, '')
        .replace(/\s+/g, ' ')
        .trim();
}
/**
 * Clincoo Project Management
 */

// Detect GitHub Pages subpath
var _pjSeg = window.location.pathname.split('/')[1] || '';
var _pjKnown = ['akun','proyek','auth','templates','integrasi','assets','js','demo','sw.js','manifest.json','robots.txt','_redirects','index.html','404.html'];
var _isGHPages = window.location.hostname.indexOf('github.io') !== -1;
var _PJBASE = _isGHPages && _pjSeg && _pjKnown.indexOf(_pjSeg) === -1 ? '/' + _pjSeg : '';

// === Sinkronisasi D1 per akun (Cloudflare) ===
// Token Bearer diinjeksi otomatis oleh js/auth-client.js pada semua call /api/.
const PROJECTS_API = (['clincoo-be2.pages.dev','localhost','127.0.0.1'].indexOf(location.hostname) === -1 ? 'https://clincoo-be2.pages.dev/api' : '/api') + '/projects';
let _pushTimer = null;
let _dataVersion = 0; // versi data lokal — naik tiap perubahan lokal (hapus/duplikat), dipakai sync untuk membuang respons basi

// Modal batas proyek per paket langganan (server menolak sinkronisasi karena limit)
function showPlanLimitModal(d) {
    if (!d || !d.upgrade_needed) return;
    if (document.getElementById('plan-limit-modal')) return;
    var m = document.createElement('div');
    m.id = 'plan-limit-modal';
    var base = (location.pathname.indexOf('/Clincoo') !== -1) ? '/Clincoo.' : '';
    m.innerHTML =
        '<div class="fixed inset-0 z-[90] flex items-center justify-center p-4" style="background:rgba(0,0,0,0.45)">' +
        '<div class="bg-white rounded-2xl w-full max-w-xs px-5 pt-5 pb-4 text-center">' +
        '<h3 class="text-base font-semibold text-gray-900">Batas proyek paket ' + esc(d.plan || 'Starter') + '</h3>' +
        '<p class="text-sm text-gray-500 mt-1.5 leading-snug px-1">Paket kamu hanya bisa menyimpan maksimal <span class="font-semibold text-gray-700">' + (d.limit || 0) + ' proyek</span>. Proyek baru tetap tersimpan di perangkat ini, tapi tidak tersinkron ke akun.</p>' +
        '<a href="' + base + '/akun/langganan/upgrade/" class="mt-4 block w-full py-2.5 text-sm font-semibold text-white bg-gray-900 rounded-lg hover:bg-gray-800 transition-colors">Upgrade Paket</a>' +
        '<button id="plan-limit-close" class="mt-2 w-full py-2 text-sm font-medium text-gray-500 hover:text-black transition-colors">Nanti saja</button>' +
        '</div></div>';
    document.body.appendChild(m);
    var btn = m.querySelector('#plan-limit-close');
    if (btn) btn.addEventListener('click', function () { m.remove(); });
}

function pushProjectsToServer(projects) {
    if (_pushTimer) clearTimeout(_pushTimer);
    _pushTimer = setTimeout(function () {
        try {
            fetch(PROJECTS_API, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'replace_all', projects: projects })
            }).then(function (res) {
                if (!res.ok) return res.json().then(function (d) { showPlanLimitModal(d); }).catch(function () {});
            }).catch(function () {});
        } catch (e) {}
    }, 700);
}

// Tarik daftar proyek milik akun dari D1; migrasi otomatis data lokal lama.
async function syncProjectsFromServer() {
    const v = _dataVersion; // jika data lokal berubah saat menunggu respons (mis. proyek barusan dihapus), respons ini basi
    try {
        const res = await fetch(PROJECTS_API);
        if (!res.ok) return;
        const d = await res.json();
        if (v !== _dataVersion) return; // data lokal sudah berubah -> jangan timpah
        // Proyek yang sedang di antrean hapus (penghapusan server belum berhasil) tidak boleh
        // di-restore balik dari server — kalau tidak, kartu yang sudah dihapus terus muncul lagi.
        const _pend = _getPendingDeletes();
        const list = (Array.isArray(d.projects) ? d.projects : []).filter(sp => _pend.indexOf(sp.id) === -1);
        const local = getProjects();
        if (list.length === 0 && local.length > 0) {
            // migrasi pertama: dorong proyek lokal ke akun yang login
            try {
                await fetch(PROJECTS_API, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ action: 'replace_all', projects: local })
                });
            } catch (e) {}
            return;
        }
        if (JSON.stringify(list) !== JSON.stringify(local)) {
            try { localStorage.setItem('clincoo_projects', JSON.stringify(list)); } catch (e) {}
            renderProjects();
        }
    } catch (e) {}
}

function toggleOption(btn, event) {
    event.preventDefault();
    event.stopPropagation();
    document.querySelectorAll('.option-popup').forEach(popup => {
        if (popup !== btn.nextElementSibling) {
            popup.classList.remove('opacity-100', 'visible', 'translate-y-0');
            popup.classList.add('opacity-0', 'invisible', 'translate-y-2');
        }
    });
    const popup = btn.nextElementSibling;
    if (popup.classList.contains('opacity-100')) {
        popup.classList.remove('opacity-100', 'visible', 'translate-y-0');
        popup.classList.add('opacity-0', 'invisible', 'translate-y-2');
    } else {
        popup.classList.remove('opacity-0', 'invisible', 'translate-y-2');
        popup.classList.add('opacity-100', 'visible', 'translate-y-0');
    }
}

function timeAgo(dateStr) {
    const diff = Date.now() - new Date(dateStr).getTime();
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);
    if (days > 0) return 'Diperbarui ' + days + ' hari lalu';
    if (hours > 0) return 'Diperbarui ' + hours + ' jam lalu';
    return 'Diperbarui baru saja';
}

// Judul & deskripsi kartu proyek: dari Pengaturan Umum (app_name/app_desc), BUKAN dari chat AI —
// samakan dengan renderProjects() di halaman utama (index.html).
function umumCacheRead(pid) {
    try { return JSON.parse(localStorage.getItem('clincoo_umum_' + (pid || 'default')) || '{}'); } catch (e) { return {}; }
}
function projCardTitle(proj) {
    const st = umumCacheRead(proj && proj.id);
    return stripMd((st && st.app_name) || (proj && proj.aiName) || (proj && proj.title) || 'Proyek Tanpa Nama');
}
function projCardDesc(proj) {
    const st = umumCacheRead(proj && proj.id);
    return stripMd((st && st.app_desc) || (proj && proj.prompt) || '');
}
function projCardLogo(proj) {
    const st = umumCacheRead(proj && proj.id);
    return (st && st.app_logo) || '';
}
function _safeLogoUrl(v) {
    return (typeof v === 'string' && /^(data:image\/|https?:\/\/|\/)/.test(v)) ? v : '';
}

function getProjects() {
    let projects = [];
    try {
        const stored = localStorage.getItem('clincoo_projects');
        if (stored) projects = JSON.parse(stored);
    } catch(e) {}
    return projects;
}

function saveProjects(projects) {
    try { localStorage.setItem('clincoo_projects', JSON.stringify(projects)); } catch(e) {}
    pushProjectsToServer(projects); // simpan per akun di D1
}

function renderProjects() {
    const projects = getProjects();
    const homeList = document.getElementById('home-projects-list');
    const allList = document.getElementById('all-projects-list');

    function createHomeCard(proj) {
        const title = esc(projCardTitle(proj));
        const desc = esc(projCardDesc(proj));
        const logo = _safeLogoUrl(projCardLogo(proj));
        const avatarHtml = logo ? '<img src="' + esc(logo) + '" class="w-6 h-6 rounded-full object-cover shrink-0 border border-gray-100" alt="Logo">' : '';
        return '<div class="w-56 sm:w-60 flex-shrink-0 border border-gray-100 rounded-2xl p-4 shadow-sm hover:shadow-md transition-all duration-300 cursor-pointer group" onclick="openProject(\'' + esc(proj.id) + '\')">' +
            '<div class="w-full h-28 bg-[#F9FAFB] rounded-xl mb-3.5 p-3 flex flex-col justify-between border border-gray-100 group-hover:border-gray-200 transition-colors">' +
            '<div class="flex items-center justify-between"><div class="w-12 h-2 bg-gray-200 rounded-full"></div><div class="w-3 h-3 rounded-full bg-black/10"></div></div>' +
            '<div class="grid grid-cols-2 gap-2 my-auto"><div class="h-10 rounded-lg border border-gray-100 p-1.5 flex flex-col justify-between"><div class="w-6 h-1.5 bg-gray-200 rounded"></div><div class="w-10 h-2 bg-gray-900 rounded"></div></div><div class="h-10 rounded-lg border border-gray-100 p-1.5 flex flex-col justify-between"><div class="w-6 h-1.5 bg-gray-200 rounded"></div><div class="w-8 h-2 bg-gray-400 rounded"></div></div></div>' +
            '<div class="w-full h-1.5 bg-gray-200 rounded-full"></div></div>' +
            '<div class="flex items-center gap-2">' + avatarHtml + '<h3 class="font-semibold text-gray-900 text-sm group-hover:text-black truncate">' + title + '</h3></div>' +
            '<p class="text-[11px] text-gray-500 mt-0.5 truncate">' + desc.substring(0, 40) + '</p>' +
            '<p class="text-xs text-gray-400 mt-1.5">' + timeAgo(proj.updatedAt) + '</p></div>';
    }

    function createAllCard(proj) {
        const title = esc(projCardTitle(proj));
        const desc = esc(projCardDesc(proj));
        const logo = _safeLogoUrl(projCardLogo(proj));
        const thumbInner = logo
            ? '<img src="' + esc(logo) + '" class="w-full h-full rounded-full object-cover" alt="Logo">'
            : '<div class="w-full h-1.5 bg-gray-200 rounded-full"></div><div class="w-full h-1.5 bg-gray-200 rounded-full"></div><div class="w-full h-1.5 bg-gray-200 rounded-full"></div>';
        const thumbCls = 'w-20 h-20 shrink-0 bg-[#F9FAFB] p-2.5 flex flex-col justify-between items-center border border-gray-100 group-hover:border-gray-200 transition-colors overflow-hidden ' + (logo ? 'rounded-full' : 'rounded-xl');
        return '<div data-proj-id="' + esc(proj.id) + '" class="relative w-full bg-white border border-gray-100 rounded-2xl p-4 shadow-sm hover:shadow-md transition-all duration-300 cursor-pointer group flex items-center gap-4" onclick="openProject(\'' + esc(proj.id) + '\')">' +
            '<div class="' + thumbCls + '">' + thumbInner + '</div>' +
            '<div class="flex-1 min-w-0"><h3 class="font-semibold text-gray-900 text-base group-hover:text-black truncate">' + title + '</h3>' +
            '<p class="text-[13px] text-gray-500 mt-0.5 truncate">' + desc.substring(0, 60) + '</p>' +
            '<p class="text-sm text-gray-400 mt-1">' + timeAgo(proj.updatedAt) + '</p></div>' +
            '<div class="relative flex-shrink-0"><button class="cc-dots p-2 text-gray-400 hover:text-black transition-colors focus:outline-none focus-visible:outline-none" onclick="toggleOption(this, event)"><i data-lucide="more-vertical" class="w-5 h-5"></i></button>' +
            '<div class="option-popup absolute top-full right-0 mt-2 w-40 bg-white border border-gray-100 rounded-xl shadow-[0_4px_20px_rgb(0,0,0,0.08)] py-2 opacity-0 invisible translate-y-2 transition-all duration-200 z-20 origin-top-right" onclick="event.stopPropagation()">' +
            '<button class="w-full text-left px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors" onclick="openProject(\'' + esc(proj.id) + '\')">Lanjutkan</button>' +
            '<button class="w-full text-left px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors" onclick="duplicateProject(\'' + proj.id + '\')">Duplikat</button>' +
            '<button class="w-full text-left px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors" onclick="shareProject(\'' + proj.id + '\')">Bagikan</button>' +
            '<button class="w-full text-left px-4 py-2 text-sm font-medium text-red-600 hover:bg-gray-50 transition-colors" onclick="deleteProject(\'' + proj.id + '\')">Hapus</button>' +
            '</div></div></div>';
    }

    if (homeList) {
        if (projects.length === 0) {
            homeList.innerHTML = '<p class="text-sm text-gray-400 py-8 text-center w-full">Belum ada proyek. Buat proyek baru untuk memulai!</p>';
        } else {
            homeList.innerHTML = projects.slice(0, 6).map(createHomeCard).join('');
        }
    }
    if (allList) {
        if (projects.length === 0) {
            allList.innerHTML = '<p class="text-sm text-gray-400 py-8 text-center w-full">Belum ada proyek. Buat proyek baru untuk memulai!</p>';
        } else {
            allList.innerHTML = projects.map(createAllCard).join('');
        }
    }
    if (typeof lucide !== 'undefined') lucide.createIcons();
}

function openProject(id) {
    const projects = getProjects();
    const proj = projects.find(p => p.id === id);
    if (proj) {
        localStorage.setItem('clincoo_current_chat_msg', proj.prompt || '');
        localStorage.setItem('clincoo_current_project_id', id);
        if (_isGHPages) {
            window.location.href = _PJBASE + '/proyek/workspace/?id=' + encodeURIComponent(id);
        } else {
            window.location.href = _PJBASE + '/workspace/' + id;
        }
    }
}

// Popup konfirmasi hapus proyek (CTA teks saja, radius kecil) — disuntik sekali per halaman
// Toast teks sederhana (preferensi notifikasi teks-saja)
function _showToast(msg, kind) {
    var t = document.createElement('div');
    t.textContent = msg;
    t.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translate(-50%,12px);z-index:999;' +
        'padding:9px 18px;border-radius:999px;font-size:13px;font-weight:600;color:#fff;' +
        'background:' + (kind === 'error' ? '#dc2626' : '#111') + ';box-shadow:0 8px 24px rgba(0,0,0,.18);' +
        'opacity:0;transition:opacity .3s,transform .3s;pointer-events:none;white-space:nowrap;';
    document.body.appendChild(t);
    requestAnimationFrame(function () { t.style.opacity = '1'; t.style.transform = 'translate(-50%,0)'; });
    setTimeout(function () { t.style.opacity = '0'; t.style.transform = 'translate(-50%,12px)'; setTimeout(function () { t.remove(); }, 350); }, 2200);
}
function _ensureDeleteModal() {
    if (document.getElementById('confirm-delete-modal')) return;
    if (!document.getElementById('clincoo-delete-spin-css')) {
        const st = document.createElement('style');
        st.id = 'clincoo-delete-spin-css';
        st.textContent = '.cc-spin{animation:cc-spin .8s linear infinite}@keyframes cc-spin{to{transform:rotate(360deg)}}.cc-deleting{opacity:.45;pointer-events:none;filter:grayscale(.3)}';
        document.head.appendChild(st);
    }
    const div = document.createElement('div');
    div.innerHTML =
        '<div id="confirm-delete-modal" class="fixed inset-0 z-[80] hidden items-center justify-center p-4" style="background:rgba(0,0,0,0.45)">' +
        '<div class="bg-white rounded-md w-full max-w-xs px-5 pt-5 pb-4 text-center">' +
        '<h3 class="text-base font-semibold text-gray-900">Hapus proyek ini?</h3>' +
'<div class="flex items-center justify-center gap-1.5 mt-1 px-2">' +
        '<p id="confirm-delete-name" class="text-sm text-gray-500 truncate"></p>' +
        '<button type="button" id="confirm-delete-copy" aria-label="Salin nama proyek" title="Salin nama proyek" class="shrink-0 p-0.5 text-gray-400 hover:text-gray-600 transition-colors rounded-sm focus-visible:outline-none"><svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg></button>' +
        '</div>' +
        '<p class="text-[13px] text-gray-400 mt-2 leading-snug">Semua data proyek akan dihapus, <span class="text-gray-500">termasuk situs yang sudah dipublish dan link publiknya</span>.</p>' +
        '<input id="confirm-delete-name-input" type="text" autocomplete="off" spellcheck="false" placeholder="Ketik nama proyek untuk konfirmasi" class="w-full mt-3 px-3 py-2 text-sm text-center border border-gray-200 rounded-md focus:outline-none focus:border-gray-400" />' +
        '<p id="confirm-delete-error" class="text-xs text-red-600 mt-2 hidden">Gagal menghapus proyek. Periksa koneksi lalu coba lagi.</p>' +
        '<div id="confirm-delete-otp-step" class="hidden mt-3">' +
        '<p class="text-[13px] text-gray-500 leading-snug">Kode OTP 6 digit sudah dikirim ke email akunmu.</p>' +
        '<input id="confirm-delete-otp-input" type="text" inputmode="numeric" maxlength="6" placeholder="Kode OTP" class="w-full mt-2 px-3 py-2 text-sm text-center tracking-[0.3em] border border-gray-200 rounded-md focus:outline-none focus:border-gray-400" />' +
        '<p id="confirm-delete-otp-error" class="text-xs text-red-600 mt-2 hidden"></p>' +
        '</div>' +
        '<div class="flex items-center justify-center gap-10 mt-5">' +
        '<button type="button" id="confirm-delete-cancel" class="text-sm font-medium text-gray-400 hover:text-gray-900 transition-colors px-1 py-0.5">Batal</button>' +
        '<button type="button" id="confirm-delete-ok" disabled class="inline-flex items-center justify-center min-w-[64px] text-sm font-semibold text-red-600 hover:text-red-700 transition-colors px-1 py-0.5 opacity-40">Hapus</button>' +
        '</div></div></div>';
    document.body.appendChild(div.firstElementChild);
    const modal = document.getElementById('confirm-delete-modal');
    modal.addEventListener('click', function (e) { if (e.target === modal) _closeDeleteModal(); });
    document.getElementById('confirm-delete-cancel').addEventListener('click', _closeDeleteModal);
    var _cpBtn = document.getElementById('confirm-delete-copy');
    if (_cpBtn) _cpBtn.addEventListener('click', function () {
        var nm = String((function(){var pr=getProjects().find(function(x){return x.id===_pendingDeleteId;});return pr?String(projCardTitle(pr)):'';})() || '').trim();
        if (!nm) return;
        var ICON_OK = '<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"></path></svg>';
        var ICON_COPY = '<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';
        var done = function () {
            _cpBtn.innerHTML = ICON_OK;
            setTimeout(function () { _cpBtn.innerHTML = ICON_COPY; }, 1400);
        };
        var fb = function () {
            try {
                var ta = document.createElement('textarea');
                ta.value = nm; ta.style.cssText = 'position:fixed;opacity:0';
                document.body.appendChild(ta); ta.select();
                document.execCommand('copy'); ta.remove(); done();
            } catch (e) {}
        };
        try {
            if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(nm).then(done, fb);
            else fb();
        } catch (e) { fb(); }
    });
    // Aktif/nonaktif tombol Hapus: harus ketik nama proyek persis (atau OTP 6 digit di step 2).
    function _syncDeleteOkBtn() {
        const okBtn = document.getElementById('confirm-delete-ok');
        if (!okBtn) return;
        if (okBtn.dataset.step === 'otp') {
            const otpEl = document.getElementById('confirm-delete-otp-input');
            okBtn.disabled = !(otpEl && /^\d{6}$/.test((otpEl.value || '').trim()));
        } else {
            const nameEl = document.getElementById('confirm-delete-name-input');
            const proj = getProjects().find(function (p) { return p.id === _pendingDeleteId; });
            const expected = proj ? String(projCardTitle(proj) || '').trim().toLowerCase() : '';
            okBtn.disabled = !expected || !nameEl || (nameEl.value || '').trim().toLowerCase() !== expected;
        }
        okBtn.classList.toggle('opacity-40', okBtn.disabled);
    }
    document.getElementById('confirm-delete-name-input').addEventListener('input', function () {
        this.classList.remove('border-red-300');
        const errEl = document.getElementById('confirm-delete-error');
        if (errEl) errEl.classList.add('hidden');
        _syncDeleteOkBtn();
    });
    document.getElementById('confirm-delete-otp-input').addEventListener('input', function () {
        const otpErr = document.getElementById('confirm-delete-otp-error');
        if (otpErr) otpErr.classList.add('hidden');
        _syncDeleteOkBtn();
    });
    document.getElementById('confirm-delete-ok').addEventListener('click', async function () {
        const id = _pendingDeleteId;
        if (!id) { _closeDeleteModal(); return; }
        const okBtn = document.getElementById('confirm-delete-ok');
        const errEl = document.getElementById('confirm-delete-error');
        const otpErr = document.getElementById('confirm-delete-otp-error');
        const otpEl = document.getElementById('confirm-delete-otp-input');
        const tok = (function () { try { return localStorage.getItem('clincoo_auth_token') || ''; } catch (e) { return ''; } })();
        const hdrs = { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) };
        const apiRoot = PROJECTS_API.replace(/\/projects$/, '');

        // STEP OTP: konfirmasi terakhir dengan kode 6 digit dari email.
        if (okBtn.dataset.step === 'otp') {
            const otp = (otpEl.value || '').trim();
            if (!/^\d{6}$/.test(otp)) return;
            okBtn.disabled = true;
            okBtn.innerHTML = '<svg class="w-4 h-4 cc-spin inline-block" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M12 2a10 10 0 1 0 10 10"></path></svg>';
            try {
                // unpublish situs (non-fatal, fire-and-forget) lalu hapus terverifikasi OTP secara sinkron
                try { fetch(apiRoot + '/deploy', { method: 'POST', headers: hdrs, body: JSON.stringify({ project_id: id, action: 'unpublish' }) }).catch(function () {}); } catch (e) {}
                const res = await fetch(PROJECTS_API, { method: 'POST', headers: hdrs, body: JSON.stringify({ action: 'delete', id: id, otp: otp }) });
                const d = await res.json().catch(function () { return null; });
                if (res.ok && d && d.success) {
                    okBtn.classList.remove('cc-spin');
                    _closeDeleteModal();
                    _removeProjectLocally(id);
                    _unqueuePendingDelete(id);
                    _showToast('Proyek dihapus', 'success');
                    return;
                }
                okBtn.classList.remove('cc-spin');
                okBtn.innerHTML = 'Konfirmasi Hapus';
                if (d && d.guarded) {
                    // race: saldo masuk setelah OTP — balik ke step nama
                    okBtn.dataset.step = '';
                    document.getElementById('confirm-delete-otp-step').classList.add('hidden');
                    if (errEl) { errEl.textContent = d.error || 'Proyek ini tidak bisa dihapus dulu.'; errEl.classList.remove('hidden'); }
                    _syncDeleteOkBtn();
                    return;
                }
                if (otpErr) { otpErr.textContent = (d && d.error) || 'Kode OTP salah atau kadaluarsa.'; otpErr.classList.remove('hidden'); }
                _syncDeleteOkBtn();
            } catch (e) {
                okBtn.classList.remove('cc-spin');
                okBtn.innerHTML = 'Konfirmasi Hapus';
                if (otpErr) { otpErr.textContent = 'Koneksi gagal. Coba lagi.'; otpErr.classList.remove('hidden'); }
                _syncDeleteOkBtn();
            }
            return;
        }

        // STEP 1: nama proyek harus cocok persis.
        const nameEl = document.getElementById('confirm-delete-name-input');
        const proj = getProjects().find(function (p) { return p.id === id; });
        const expected = proj ? String(projCardTitle(proj) || '').trim().toLowerCase() : '';
        if (!nameEl || (nameEl.value || '').trim().toLowerCase() !== expected) {
            nameEl.classList.add('border-red-300');
            nameEl.focus();
            return;
        }
        okBtn.disabled = true;
        okBtn.innerHTML = '<svg class="w-4 h-4 cc-spin inline-block" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M12 2a10 10 0 1 0 10 10"></path></svg>';
        if (errEl) errEl.classList.add('hidden');
        // Pre-check guard server: saldo ClincooPay diblokir; sesi baru -> minta OTP email.
        let check = null;
        try {
            const res = await fetch(PROJECTS_API + '?delete_check=' + encodeURIComponent(id), { headers: hdrs });
            check = await res.json().catch(function () { return null; });
        } catch (e) { check = null; }
        okBtn.classList.remove('cc-spin');
        okBtn.innerHTML = 'Hapus';
        if (check && check.blocked) {
            if (errEl) { errEl.textContent = check.reason || 'Proyek ini tidak bisa dihapus dulu.'; errEl.classList.remove('hidden'); }
            _syncDeleteOkBtn();
            return;
        }
        // [8 Okt 2026] Pre-check gagal (server lambat/koneksi putus) -> JANGAN lanjut
        // ke hapus optimis. Sebelumnya: cek gagal = dianggap aman -> hapus lokal +
        // background delete; kalau server ternyata butuh OTP, penghapusan di server
        // ditinggal diam-diam dan proyek MUNCUL LAGI setelah refresh -> user harus
        // hapus 2x. Sekarang: minta user coba lagi saat cek sudah berhasil.
        if (!check) {
            if (errEl) { errEl.textContent = 'Server belum merespons. Periksa koneksi lalu coba lagi.'; errEl.classList.remove('hidden'); }
            _syncDeleteOkBtn();
            return;
        }
        if (check.otp_required) {
            // masuk step OTP: kirim kode ke email akun
            okBtn.dataset.step = 'otp';
            okBtn.disabled = true;
            okBtn.innerHTML = '<svg class="w-4 h-4 cc-spin inline-block" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M12 2a10 10 0 1 0 10 10"></path></svg>';
            if (errEl) errEl.classList.add('hidden');
            const otpStep = document.getElementById('confirm-delete-otp-step');
            if (otpStep) otpStep.classList.remove('hidden');
            const nameWrap = document.getElementById('confirm-delete-name-input');
            if (nameWrap) nameWrap.classList.add('hidden');
            try {
                const r2 = await fetch(PROJECTS_API, { method: 'POST', headers: hdrs, body: JSON.stringify({ action: 'delete_otp_send' }) });
                const d2 = await r2.json().catch(function () { return null; });
                okBtn.classList.remove('cc-spin');
                if (!d2 || !d2.success) {
                    if (otpErr) { otpErr.textContent = (d2 && d2.error) || 'Kode OTP gagal dikirim. Tutup modal lalu coba lagi.'; otpErr.classList.remove('hidden'); }
                    okBtn.innerHTML = 'Konfirmasi Hapus';
                    return;
                }
                okBtn.innerHTML = 'Konfirmasi Hapus';
                if (otpEl) otpEl.focus();
                _syncDeleteOkBtn();
            } catch (e) {
                okBtn.classList.remove('cc-spin');
                okBtn.innerHTML = 'Konfirmasi Hapus';
                if (otpErr) { otpErr.textContent = 'Kode OTP gagal dikirim. Coba lagi.'; otpErr.classList.remove('hidden'); }
            }
            return;
        }
        // tanpa OTP: lanjut alur lama (optimistic + hapus di latar belakang)
        // Optimistic: proyek langsung lenyap dari daftar & modal langsung tertutup —
        // penghapusan sungguhan di server (D1 + unpublish) jalan sendiri di latar belakang
        // (fire-and-forget + retry diam-diam), jadi hapus TERASA instan tanpa menunggu jaringan.
        _closeDeleteModal();
        _removeProjectLocally(id);
        _queuePendingDelete(id); // [8 Okt 2026] tombstone SEJAK AWAL: tab ditutup di tengah retry / sync balik,
                                 // proyek terhapus tidak boleh dihidupkan ulang dari server sebelum server benar2 hapus.
        _showToast('Proyek dihapus', 'success');
        _deleteProjectInBackground(id);
    });
}
function _resetDeleteModalUI() {
    const okBtn = document.getElementById('confirm-delete-ok');
    const cancelBtn = document.getElementById('confirm-delete-cancel');
    const errEl = document.getElementById('confirm-delete-error');
    const nameEl = document.getElementById('confirm-delete-name-input');
    const otpStep = document.getElementById('confirm-delete-otp-step');
    const otpEl = document.getElementById('confirm-delete-otp-input');
    const otpErr = document.getElementById('confirm-delete-otp-error');
    if (okBtn) { okBtn.disabled = true; okBtn.dataset.step = ''; okBtn.classList.remove('cc-spin'); okBtn.innerHTML = 'Hapus'; okBtn.classList.add('opacity-40'); }
    if (cancelBtn) cancelBtn.style.visibility = '';
    if (errEl) errEl.classList.add('hidden');
    if (nameEl) { nameEl.value = ''; nameEl.classList.remove('border-red-300'); nameEl.classList.remove('hidden'); }
    if (otpStep) otpStep.classList.add('hidden');
    if (otpEl) otpEl.value = '';
    if (otpErr) otpErr.classList.add('hidden');
    document.querySelectorAll('.cc-del-overlay').forEach(function (ov) { ov.remove(); });
    document.querySelectorAll('.cc-deleting').forEach(function (el) { el.classList.remove('cc-deleting'); });
}
function _closeDeleteModal() {
    const modal = document.getElementById('confirm-delete-modal');
    if (modal) { modal.classList.add('hidden'); modal.classList.remove('flex'); }
    _pendingDeleteId = null;
    _resetDeleteModalUI();
}
let _pendingDeleteId = null;
function deleteProject(id) {
    _ensureDeleteModal();
    const proj = getProjects().find(p => p.id === id);
    _pendingDeleteId = id;
    const nameEl = document.getElementById('confirm-delete-name');
    if (nameEl) nameEl.textContent = proj ? String(projCardTitle(proj)) : 'Proyek ini';
    const modal = document.getElementById('confirm-delete-modal');
    modal.classList.remove('hidden');
    modal.classList.add('flex');
}
// Hapus proyek dari tampilan & data lokal SEKETIKA (optimistic) — tidak menunggu server sama sekali.
function _removeProjectLocally(id) {
    try {
        localStorage.removeItem('clincoo_ls_chat_' + id);
        localStorage.removeItem('clincoo_workspace_files_' + id);
        if (localStorage.getItem('clincoo_current_project_id') === id) localStorage.removeItem('clincoo_current_project_id');
    } catch (e) {}
    let projects = getProjects();
    projects = projects.filter(p => p.id !== id);
    _dataVersion++; // tandai data lokal berubah agar respons sync basi tidak menghidupkan ulang proyek terhapus
    try { localStorage.setItem('clincoo_projects', JSON.stringify(projects)); } catch (e) {}
    renderProjects();
}

// Antrean retry diam-diam: kalau penghapusan di server gagal (jaringan putus dkk),
// id-nya disimpan supaya dicoba lagi otomatis saat halaman proyek dibuka lagi.
// Proyek TIDAK pernah dihidupkan kembali di UI — ini murni membereskan sisa data di server.
function _getPendingDeletes() {
    try { return JSON.parse(localStorage.getItem('clincoo_pending_deletes') || '[]'); } catch (e) { return []; }
}
function _setPendingDeletes(list) {
    try { localStorage.setItem('clincoo_pending_deletes', JSON.stringify(list)); } catch (e) {}
}
function _queuePendingDelete(id) {
    const list = _getPendingDeletes();
    if (list.indexOf(id) === -1) { list.push(id); _setPendingDeletes(list); }
}
function _unqueuePendingDelete(id) {
    const list = _getPendingDeletes().filter(x => x !== id);
    _setPendingDeletes(list);
}

// Penghapusan sungguhan di server, jalan di latar belakang — tidak pernah mem-block UI.
// Sampai 3x percobaan (dengan jeda), gagal terus -> masuk antrean retry diam-diam.
async function _deleteProjectInBackground(id, attempt) {
    attempt = attempt || 1;
    const tok = (function () { try { return localStorage.getItem('clincoo_auth_token') || ''; } catch (e) { return ''; } })();
    const hdrs = { 'Content-Type': 'application/json' };
    if (tok) hdrs['Authorization'] = 'Bearer ' + tok;
    const apiRoot = PROJECTS_API.replace(/\/projects$/, '');
    // unpublish situs + link publik Cloudflare Pages (non-fatal, fire-and-forget)
    try { fetch(apiRoot + '/deploy', { method: 'POST', headers: hdrs, body: JSON.stringify({ project_id: id, action: 'unpublish' }) }).catch(function () {}); } catch (e) {}
    let ok = false;
    try {
        const res = await fetch(PROJECTS_API, { method: 'POST', headers: hdrs, body: JSON.stringify({ action: 'delete', id: id }) });
        if (res.ok) { const d = await res.json().catch(() => null); ok = !d || d.success !== false; }
        else {
            const d = await res.json().catch(() => null);
            if (d && d.need_otp) { _unqueuePendingDelete(id); try { _showToast('Proyek belum terhapus di server — perlu kode OTP. Buka hapus proyek lagi untuk memasukkan kodenya.', 'error'); } catch (e) {} return; }
            if (d && d.guarded) { _unqueuePendingDelete(id); try { _showToast('Proyek tidak bisa dihapus: ' + (d.error || 'diblokir saldo ClincooPay.'), 'error'); } catch (e) {} return; } // diblokir guard saldo: jangan retry diam-diam
        }
    } catch (e) { ok = false; }
    if (ok) {
        _unqueuePendingDelete(id);
        try {
            fetch('https://clincoo-be2.pages.dev/api/activity', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'delete_project', details: 'Proyek dihapus' })
            }).catch(function () {});
        } catch (e) {}
        return;
    }
    if (attempt < 3) {
        setTimeout(function () { _deleteProjectInBackground(id, attempt + 1); }, attempt * 2000);
    } else {
        _queuePendingDelete(id); // dicoba lagi otomatis lain kali halaman ini dibuka
    }
}

// Dipanggil saat halaman dimuat: beresin sisa penghapusan yang gagal sebelumnya, diam-diam.
function _flushPendingDeletes() {
    const list = _getPendingDeletes();
    list.forEach(function (id) { _deleteProjectInBackground(id, 1); });
}

function duplicateProject(id) {
    let projects = getProjects();
    const proj = projects.find(p => p.id === id);
    if (proj) {
        const copyTitle = (proj.title ? String(proj.title).replace(/\s*\(Copy\)\s*$/i, '') : 'Proyek') + ' (Copy)';
        const copy = Object.assign({}, proj, { id: 'proj_' + Date.now(), title: copyTitle, aiName: '', updatedAt: new Date().toISOString() });
        projects.unshift(copy);
        saveProjects(projects);
        renderProjects();
    }
}

function shareProject(id) {
    const projects = getProjects();
    const proj = projects.find(p => p.id === id);
    if (proj && navigator.share) {
        navigator.share({ title: proj.title, text: proj.prompt }).catch(function(){});
    }
}

function processPromptSubmission() {
    const mainPromptInput = document.getElementById('main-prompt-input');
    if (!mainPromptInput) return;
    const prompt = mainPromptInput.value.trim();
    if (!prompt) return;
    
    try {
        localStorage.removeItem('clincoo_current_chat_msg');
        localStorage.removeItem('clincoo_current_project_id');
        localStorage.removeItem('clincoo_current_attachments');
    } catch(e) {}
    
    const projectId = 'proj_' + Date.now();
    let titleParts = prompt.split(' ');
    let title = titleParts.slice(0, 4).join(' ');
    if (titleParts.length > 4) title += '...';
    
    const newProject = { id: projectId, title: title, prompt: prompt, updatedAt: new Date().toISOString() };
    let projects = getProjects();
    projects.unshift(newProject);
    
    try {
        saveProjects(projects);
        localStorage.setItem('clincoo_current_chat_msg', prompt);
        localStorage.setItem('clincoo_current_project_id', projectId);
        const filePreviewContainer = document.getElementById('file-preview-container');
        const fileChips = filePreviewContainer ? filePreviewContainer.querySelectorAll('.file-chip') : [];
        if (fileChips.length > 0) {
            const attachments = Array.from(fileChips).map(function(chip) {
                const nameEl = chip.querySelector('span');
                return { name: nameEl ? nameEl.textContent : 'file', type: 'document' };
            });
            localStorage.setItem('clincoo_current_attachments', JSON.stringify(attachments));
        }
    } catch(e) {}
    if (_isGHPages) {
        window.location.href = _PJBASE + '/proyek/chat/?id=' + encodeURIComponent(projectId);
    } else {
        window.location.href = _PJBASE + '/workspace/' + projectId + '/chat';
    }
}

// Sinkron dengan database per akun saat halaman dibuka
document.addEventListener('DOMContentLoaded', function () { syncProjectsFromServer(); _flushPendingDeletes(); loadProjectLogos(); });
// Tarik app_logo (Pengaturan Umum) tiap proyek dari server agar logo kartu selalu segar,
// simpan ke cache lokal clincoo_umum_<id> (merge, tidak menimpa key lain), lalu render ulang.
function loadProjectLogos() {
    try {
        const base = PROJECTS_API.replace(/\/projects$/, '');
        const tok = (function () { try { return localStorage.getItem('clincoo_auth_token') || localStorage.getItem('clincoo_token') || ''; } catch (e) { return ''; } })();
        const hdr = tok ? { Authorization: 'Bearer ' + tok } : {};
        getProjects().forEach(function (proj) {
            fetch(base + '/project-settings?project_id=' + encodeURIComponent(proj.id), { headers: hdr })
                .then(function (r) { return r.ok ? r.json() : null; })
                .then(function (d) {
                    if (!d) return;
                    if (d.app_name || d.app_desc || d.app_logo) {
                        try {
                            const key = 'clincoo_umum_' + (proj.id || 'default');
                            let st = {}; try { st = JSON.parse(localStorage.getItem(key) || '{}'); } catch (e) {}
                            st.app_name = d.app_name || st.app_name || '';
                            st.app_desc = d.app_desc || st.app_desc || '';
                            st.app_logo = d.app_logo || st.app_logo || '';
                            localStorage.setItem(key, JSON.stringify(st));
                        } catch (e) {}
                        renderProjects();
                    }
                }).catch(function () {});
        });
    } catch (e) {}
}
if (document.readyState !== 'loading') { syncProjectsFromServer(); _flushPendingDeletes(); }
