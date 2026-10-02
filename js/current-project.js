// Validasi proyek aktif — cegah state basi antar-proyek di halaman fitur (MCP, Email, dst).
// URL ?id= selalu menang; kalau localStorage menunjuk proyek terhapus, pindah ke proyek valid.
// Saat ganti proyek, cache fitur (MCP/Email) proyek lama dibuang supaya UI tidak "masih aktif".
(function () {
    try {
        var qid = '';
        try { qid = new URLSearchParams(location.search).get('id') || ''; } catch (e) {}
        var list = [];
        try { list = JSON.parse(localStorage.getItem('clinqoo_projects') || '[]'); } catch (e) {}
        var ids = {};
        list.forEach(function (p) { if (p && p.id) ids[p.id] = true; });

        var pid = qid || localStorage.getItem('clinqoo_current_project_id') || '';
        if (qid) {
            try { localStorage.setItem('clinqoo_current_project_id', qid); } catch (e) {}
            pid = qid;
        } else if (!pid || !ids[pid]) {
            var latest = null;
            list.forEach(function (p) {
                if (!p || !p.id) return;
                if (!latest || (p.updatedAt || '') > (latest.updatedAt || '')) latest = p;
            });
            if (latest && latest.id) {
                pid = latest.id;
                try { localStorage.setItem('clinqoo_current_project_id', pid); } catch (e) {}
            } else {
                pid = '';
                try { localStorage.removeItem('clinqoo_current_project_id'); } catch (e) {}
            }
        }

        // Deteksi ganti proyek (per tab) → bersihkan cache fitur proyek lain
        var prev = '';
        try { prev = sessionStorage.getItem('clinqoo_last_feature_pid') || ''; } catch (e) {}
        if (pid && prev && prev !== pid) {
            try {
                var keys = [];
                for (var i = 0; i < localStorage.length; i++) {
                    var k = localStorage.key(i);
                    if (!k) continue;
                    if (k.indexOf('clinqoo_mcp_') === 0 || k.indexOf('clincoo_email_') === 0 || k.indexOf('clinqoo_pay_') === 0)
                        keys.push(k);
                }
                keys.forEach(function (k) {
                    // hapus cache yang bukan milik proyek aktif
                    if (k.slice(-pid.length) !== pid && k.indexOf(pid) === -1)
                        localStorage.removeItem(k);
                });
            } catch (e) {}
        }
        // Buang cache milik proyek yang sudah tidak ada di daftar
        try {
            var drop = [];
            for (var j = 0; j < localStorage.length; j++) {
                var key = localStorage.key(j);
                if (!key) continue;
                var m = key.match(/^(?:clinqoo_mcp_|clincoo_email_|clinqoo_pay_)(.+)$/);
                if (m && m[1] && m[1] !== 'none' && !ids[m[1]]) drop.push(key);
            }
            drop.forEach(function (k) { localStorage.removeItem(k); });
        } catch (e) {}

        if (pid) {
            try { sessionStorage.setItem('clinqoo_last_feature_pid', pid); } catch (e) {}
        } else {
            try { sessionStorage.removeItem('clinqoo_last_feature_pid'); } catch (e) {}
        }
    } catch (e) {}
})();
