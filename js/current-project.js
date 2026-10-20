// Validasi proyek aktif + expose getClincooProjectId() untuk halaman fitur (MCP/Email)
// yang tidak memuat auth-client (namespace localStorage per akun).
(function () {
    function readNamespacedPid() {
        try {
            var v = localStorage.getItem('clincoo_current_project_id');
            if (v) return v;
            // Tanpa auth-client proxy: cari u<id>:clincoo_current_project_id
            for (var i = 0; i < localStorage.length; i++) {
                var k = localStorage.key(i);
                if (k && /(?:^|:)clincoo_current_project_id$/.test(k)) {
                    var x = localStorage.getItem(k);
                    if (x) return x;
                }
            }
        } catch (e) {}
        return '';
    }

    function resolvePid() {
        var qid = '';
        try { qid = new URLSearchParams(location.search).get('id') || ''; } catch (e) {}
        if (qid) {
            try { localStorage.setItem('clincoo_current_project_id', qid); } catch (e) {}
            return qid;
        }
        var list = [];
        try { list = JSON.parse(localStorage.getItem('clincoo_projects') || '[]'); } catch (e) {}
        if (!list.length) {
            try {
                for (var i = 0; i < localStorage.length; i++) {
                    var k = localStorage.key(i);
                    if (k && /(?:^|:)clincoo_projects$/.test(k)) {
                        list = JSON.parse(localStorage.getItem(k) || '[]');
                        if (list.length) break;
                    }
                }
            } catch (e) {}
        }
        var ids = {};
        list.forEach(function (p) { if (p && p.id) ids[p.id] = true; });
        var pid = readNamespacedPid();
        if (!pid || (Object.keys(ids).length && !ids[pid])) {
            var latest = null;
            list.forEach(function (p) {
                if (!p || !p.id) return;
                if (!latest || (p.updatedAt || '') > (latest.updatedAt || '')) latest = p;
            });
            pid = (latest && latest.id) || '';
            try {
                if (pid) localStorage.setItem('clincoo_current_project_id', pid);
                else localStorage.removeItem('clincoo_current_project_id');
            } catch (e) {}
        }
        return pid || '';
    }

    var pid = '';
    try { pid = resolvePid(); } catch (e) {}

    try {
        var list2 = [];
        try { list2 = JSON.parse(localStorage.getItem('clincoo_projects') || '[]'); } catch (e) {}
        var ids2 = {};
        list2.forEach(function (p) { if (p && p.id) ids2[p.id] = true; });
        var prev = '';
        try { prev = sessionStorage.getItem('clincoo_last_feature_pid') || ''; } catch (e) {}
        if (pid && prev && prev !== pid) {
            var keys = [];
            for (var i = 0; i < localStorage.length; i++) {
                var k = localStorage.key(i);
                if (k && (k.indexOf('clincoo_mcp_') >= 0 || k.indexOf('clincoo_email_') >= 0 || k.indexOf('clincoo_pay_') >= 0))
                    keys.push(k);
            }
            keys.forEach(function (k) {
                if (k.indexOf(pid) === -1) try { localStorage.removeItem(k); } catch (e) {}
            });
        }
        var drop = [];
        for (var j = 0; j < localStorage.length; j++) {
            var key = localStorage.key(j);
            if (!key) continue;
            var m = key.match(/(?:^|:)(?:clincoo_mcp_|clincoo_email_|clincoo_pay_)(.+)$/);
            if (m && m[1] && m[1] !== 'none' && Object.keys(ids2).length && !ids2[m[1]]) drop.push(key);
        }
        drop.forEach(function (k) { try { localStorage.removeItem(k); } catch (e) {} });
        if (pid) try { sessionStorage.setItem('clincoo_last_feature_pid', pid); } catch (e) {}
    } catch (e) {}

    window.getClincooProjectId = function () {
        try {
            var q = new URLSearchParams(location.search).get('id');
            if (q) return q;
        } catch (e) {}
        return readNamespacedPid() || pid || '';
    };
})();
