#!/usr/bin/env python3
"""Enable 200KB+ files per project in one chat session (append_file + more hops)."""
from pathlib import Path

sp = Path("functions/api/chat.js")
if sp.exists():
    c = sp.read_text(encoding="utf-8")
    if "FILE_200KB_PLUS" in c:
        print("chat.js already patched")
    else:
        old = """    // [9 Okt, arahan pemilik] "usahain AI bisa buat file besar": sambungan args
    // tool naik 8 -> 14 hop (~7 ribu token, file ±20-30KB utuh dalam SATU write_file).
    for (let hop = 0; hop < 14; hop++) {"""
        new = """    // FILE_200KB_PLUS: sambungan args tool naik 14 -> 48 hop
    // (~25 ribu token, file puluhan–100KB+ bisa utuh / potongan besar per write_file).
    for (let hop = 0; hop < 48; hop++) {"""
        if old not in c:
            raise SystemExit("MR hop block not found in chat.js")
        c = c.replace(old, new, 1)

        old_p = "ATURAN MENULIS FILE (WAJIB, karena batas output per panggilan kecil): (1) Tulis SATU file per panggilan write_file — jangan pernah membungkus banyak file besar dalam satu write_files (akan terpotong dan gagal). (2) Satu file BOLEH besar — aman sampai ±20.000 karakter per write_file (sistem otomatis menyambung output yang terpotong); untuk file SANGAT besar (100KB+ sampai 1MB) lanjutkan dengan append_file berulang: path sama, potongan ±15-20 ribu karakter, done:true di potongan terakhir, tanpa menyela file lain sampai file utuh. Kalau tidak butuh file raksasa, lebih rapi pecah jadi beberapa file (mis. css/layout.css, js/cart.js) dan hubungkan lewat link/script."
        new_p = "ATURAN MENULIS FILE (WAJIB — FILE_200KB_PLUS): (1) Tulis SATU file per panggilan write_file — jangan bundel banyak file besar dalam satu write_files. (2) Satu proyek BOLEH total 200KB+ (bahkan sampai ~1MB) dalam SATU sesi chat: sistem menyambung output terpotong + append_file. Satu panggilan write_file aman ±15.000–25.000 karakter; untuk file besar (50KB–200KB+) atau file tunggal sangat besar: tulis bagian PERTAMA dengan write_file, lalu append_file berulang (path sama, tiap potongan ±12.000–20.000 karakter, done:true HANYA di potongan terakhir) tanpa menyela file lain sampai file itu utuh. Boleh pecah ke beberapa file (css/js) bila lebih rapi, tapi JANGAN berhenti di tengah hanya karena file besar — lanjut append sampai selesai dalam sesi yang sama."
        if old_p not in c:
            raise SystemExit("ATURAN MENULIS FILE not found in chat.js")
        c = c.replace(old_p, new_p, 1)

        old_a = "description: 'Tambahkan potongan isi di AKHIR file yang sudah ada (untuk file sangat besar 100KB+): panggil write_file untuk bagian pertama, lalu append_file berulang (sekitar 15.000-20.000 karakter per panggilan, path sama). done: true hanya pada potongan TERAKHIR agar sintaks diverifikasi.'"
        new_a = "description: 'Tambahkan potongan isi di AKHIR file (file 50KB–200KB+ sampai ~1MB dalam 1 sesi): write_file bagian pertama, lalu append_file berulang (path sama, ±12.000–20.000 karakter per panggilan). done:true HANYA di potongan TERAKHIR. Jangan henti di tengah — lanjut sampai file utuh.'"
        if old_a not in c:
            print("WARN: append_file description not exact, skip")
        else:
            c = c.replace(old_a, new_a, 1)

        sp.write_text(c, encoding="utf-8")
        print("chat.js patched", sp.stat().st_size)
else:
    print("chat.js missing")

up = Path("proyek/chat/index.html")
if up.exists():
    u = up.read_text(encoding="utf-8")
    if "FILE_200KB_PLUS" in u and "MAX_TOOL_HOPS = 120" in u:
        print("index.html already patched")
    else:
        if "const MAX_TOOL_HOPS = 64;" in u:
            u = u.replace("const MAX_TOOL_HOPS = 64;", "const MAX_TOOL_HOPS = 120; // FILE_200KB_PLUS", 1)
            print("MAX_TOOL_HOPS bumped")
        elif "MAX_TOOL_HOPS = 120" in u:
            print("MAX_TOOL_HOPS already 120")
        else:
            print("WARN: MAX_TOOL_HOPS not found")

        idx = u.find("== 4B2. FILE BESAR")
        if idx < 0:
            print("WARN: 4B2 section not found")
        elif "FILE_200KB_PLUS" not in u[idx:idx+200]:
            end = u.find("== 4B3", idx)
            if end < 0:
                end = u.find("== 5.", idx)
            if end < 0:
                end = idx + 800
            new_sec = (
                "== 4B2. FILE BESAR 200KB+ PER PROYEK DALAM 1 SESI (FILE_200KB_PLUS) ==\\n"
                "(1) Target: satu proyek boleh total 200KB+ (bahkan ~1MB) dalam SATU sesi chat — jangan berhenti hanya karena file besar.\\n"
                "(2) Per panggilan: tulis potongan ±12.000–20.000 karakter (sistem menyambung bila terpotong).\\n"
                "(3) Alur file besar: write_file bagian PERTAMA → append_file berulang (path sama, potongan berikutnya) → done:true HANYA di potongan TERAKHIR.\\n"
                "(4) Jangan menyela file lain sampai file besar itu utuh. Jangan klaim selesai sebelum list_items/ukuran membuktikan.\\n"
                "(5) Boleh pecah ke beberapa file (css/js) bila lebih rapi, tapi total proyek 200KB+ tetap diselesaikan dalam sesi yang sama.\\n\\n"
            )
            u = u[:idx] + new_sec + u[end:]
            print("4B2 section replaced")
        else:
            print("4B2 already updated")

        up.write_text(u, encoding="utf-8")
        print("index.html patched", up.stat().st_size)
else:
    print("index.html missing")
