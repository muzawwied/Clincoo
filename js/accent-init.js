// Sinkronisasi warna aksen dari preferensi pengguna (Profile) ke semua halaman Clincoo
(function () {
  var map = {
    'Hitam (Default)': { m: '#000000', h: '#1f2937' },
    'Biru': { m: '#2563eb', h: '#1d4ed8' },
    'Hijau': { m: '#059669', h: '#047857' },
    'Ungu': { m: '#9333ea', h: '#7e22ce' },
    'Merah': { m: '#dc2626', h: '#b91c1c' }
  };
  function applyAccent(name) {
    try {
      var c = map[name] || map['Hitam (Default)'];
      var root = document.documentElement;
      root.style.setProperty('--accent-color', c.m);
      root.style.setProperty('--accent-hover', c.h);
    } catch (e) {}
  }
  applyAccent(localStorage.getItem('clincoo_accent') || 'Hitam (Default)');
  // Sinkron live bila aksen diganti di tab/halaman lain
  window.addEventListener('storage', function (e) {
    if (e.key === 'clincoo_accent') applyAccent(e.newValue || 'Hitam (Default)');
  });
})();
