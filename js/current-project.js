// Validasi proyek aktif — cegah state basi antar-proyek di halaman fitur (MCP, Email, Environment, dst).
// Jika 'clinqoo_current_project_id' menunjuk proyek yang sudah tidak ada (terhapus / pindah proyek),
// otomatis pindah ke proyek terbaru dalam daftar, sehingga fitur & secret selalu mengikuti proyek yang benar.
(function () {
    try {
        var pid = localStorage.getItem('clinqoo_current_project_id') || '';
        var list = JSON.parse(localStorage.getItem('clinqoo_projects') || '[]');
        var ids = {};
        list.forEach(function (p) { if (p && p.id) ids[p.id] = true; });
        if (!pid || !ids[pid]) {
            var latest = null;
            list.forEach(function (p) {
                if (!p || !p.id) return;
                if (!latest || (p.updatedAt || '') > (latest.updatedAt || '')) latest = p;
            });
            if (latest && latest.id) localStorage.setItem('clinqoo_current_project_id', latest.id);
            else localStorage.removeItem('clinqoo_current_project_id');
        }
    } catch (e) {}
})();
