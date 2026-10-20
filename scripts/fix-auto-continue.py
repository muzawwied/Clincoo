#!/usr/bin/env python3
from pathlib import Path
p = Path("proyek/chat/index.html")
c = p.read_text(encoding="utf-8")
if "AUTO_CONTINUE_LENGTH_FIX" in c:
    print("already patched"); raise SystemExit(0)

c = c.replace(
    "const SILENT_MAX_ROUNDS = 1;",
    "const SILENT_MAX_ROUNDS = 12; // AUTO_CONTINUE_LENGTH_FIX",
    1,
)
c = c.replace(
    "if (_userAskedWork && !_didAct && t.length <= 600) {",
    "if (_userAskedWork && !_didAct && t.length <= 4000) { // AUTO_CONTINUE_LENGTH_FIX",
    1,
)
old_re = "const INTENT_RE = /(saya|aku|kami)\\s+(akan\\s+)?(cek|periksa|lihat|baca|lanjut(kan)?|perbaiki|deploy|kerjakan|buat|tulis|ubah|tambah(kan)?|susun)\\b[^\\n]{0,80}(dulu|sekarang|segera|berikutnya|selanjutnya)?|sedang\\s+saya\\s+(perbaiki|kerjakan|deploy|reboot|buat|tulis)|(deploy|publish)\\s+(sebelumnya\\s+)?gagal[^\\n]{0,120}(perbaiki|ulang|reboot)|belum\\s+selesai\\)?\\.?\\s*$|(dalam\\s+satu\\s+giliran)/i;"
new_re = "const INTENT_RE = /(saya|aku|kami)\\s+(akan\\s+)?(cek|periksa|lihat|baca|lanjut(kan)?|perbaiki|deploy|kerjakan|buat|bikin|tulis|menulis|ubah|tambah(kan)?|susun|membangun|bangun|menyusun)\\b|sedang\\s+saya\\s+(perbaiki|kerjakan|deploy|reboot|buat|tulis|menulis)|sekarang\\s+saya\\s+(tulis|menulis|buat|bikin|kerjakan|mulai)|fokus\\s+(penuh\\s+)?pada\\s+membangun|(deploy|publish)\\s+(sebelumnya\\s+)?gagal[^\\n]{0,120}(perbaiki|ulang|reboot)|belum\\s+selesai\\)?\\.?\\s*$|(dalam\\s+satu\\s+giliran)/i; // AUTO_CONTINUE_LENGTH_FIX"
if old_re not in c:
    raise SystemExit("INTENT_RE not found")
c = c.replace(old_re, new_re, 1)

old_if = """if (INTENT_RE.test(tail)) {
                        FINAL_NUDGE_EXTRA = 'JANGAN berhenti di kalimat niat. Kamu baru melihat/membaca proyek (atau cuma berencana) dan BELUM mengerjakan apa pun. Berdasarkan isi proyek yang barusan kamu lihat, LANGSUNG lakukan pekerjaan nyata SEKARANG: tulis/perbaiki file lewat write_file, lalu deploy_project jika perlu. Tanpa kalimat niat baru, tanpa minta izin.';
                        return 'promise';
                    }"""
new_if = """if (INTENT_RE.test(t) || INTENT_RE.test(tail)) {
                        const stateTail = t.slice(-180).replace(/\\s+/g, ' ').trim();
                        FINAL_NUDGE_EXTRA = 'JANGAN berhenti di kalimat niat dan JANGAN ulangi narasi. State terakhir: "' + stateTail + '". LANGSUNG panggil tool nyata SEKARANG (write_file / append_file / deploy_project) dari titik itu — tanpa sesi baru, tanpa minta izin, tanpa ringkasan.';
                        return 'promise';
                    }
                    // AUTO_CONTINUE_LENGTH_FIX: akhiran terasa kepotong
                    const endsAbrupt = /[,:;\\-—]\\s*$/.test(t) || /\\b(dan|atau|yang|untuk|dengan|serta|lalu|kemudian|sekarang|berikutnya)\\s*$/i.test(t);
                    if (endsAbrupt || /\\b(index\\.html|styles?\\.css|script|\\.js)\\.?\\s*$/i.test(t)) {
                        const stateTail2 = t.slice(-180).replace(/\\s+/g, ' ').trim();
                        FINAL_NUDGE_EXTRA = 'Output terpotong batas token. Lanjutkan PERSIS dari titik terakhir tanpa mengulang. State: "' + stateTail2 + '". Langsung tool call (write_file/append_file).';
                        return 'promise';
                    }"""
if old_if not in c:
    raise SystemExit("INTENT_RE.test block not found")
c = c.replace(old_if, new_if, 1)

c = c.replace(
    "const unfinishedMax = (unfinishedTag === 'promise' || unfinishedTag === 'ack') ? 2 : SILENT_MAX_ROUNDS;",
    "const unfinishedMax = SILENT_MAX_ROUNDS; // AUTO_CONTINUE_LENGTH_FIX",
    1,
)

old_push = """        function pushSilentNudge(extra) {
            const base = SILENT_NUDGES[Math.floor(Math.random() * SILENT_NUDGES.length)];
            messages.push({
                id: generateId(), role: 'user',
                text: base + (extra ? ' ' + extra : ''),
                silent: true, time: Date.now()
            });
            try { saveChatLog(); } catch (e) {}
        }"""
new_push = """        function pushSilentNudge(extra) {
            // AUTO_CONTINUE_LENGTH_FIX: jangan sesi baru — lanjut titik yang sama
            const base = 'Lanjutkan pekerjaan dari titik terakhir dalam sesi ini. Jangan mengulang dari awal. Jangan membuat sesi baru. Langsung kerjakan sisa tugas dengan tool (write_file/append_file/dll).';
            messages.push({
                id: generateId(), role: 'user',
                text: base + (extra ? ' ' + extra : ''),
                silent: true, time: Date.now()
            });
            try { saveChatLog(); } catch (e) {}
        }"""
if old_push not in c:
    raise SystemExit("pushSilentNudge not found")
c = c.replace(old_push, new_push, 1)

p.write_text(c, encoding="utf-8")
print("patched OK", p.stat().st_size)
