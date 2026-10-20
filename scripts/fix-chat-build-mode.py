#!/usr/bin/env python3
"""Chat mode: no workspace tools. Build mode: write-first + more tokens."""
from pathlib import Path
import re

up = Path("proyek/chat/index.html")
if up.exists():
    u = up.read_text(encoding="utf-8")
    if "CHAT_BUILD_MODE_FIX" not in u:
        old = "workspace_tools: true,"
        new = "workspace_tools: ((typeof window.selectedAiMode === 'function' && window.selectedAiMode()) === 'build'), /* CHAT_BUILD_MODE_FIX */"
        n = u.count(old)
        if n:
            u = u.replace(old, new)
            print("workspace_tools gated x", n)
        old_mode = "MODE CHAT: untuk ngobrol, tanya-jawab, minta saran/penjelasan; GRATIS (tidak memotong kredit, ada batas pesan harian/bulanan); fokus menjawab, tidak membuat/mengubah file proyek. MODE BUILD: untuk membangun situs/aplikasi sungguhan; memakai tools (tulis file, backend, database, deploy) dan MEMOTONG KREDIT sesuai pemakaian nyata; kalau saldo kredit habis, user diarahkan Top Up di halaman Kredit. Kalau user minta dibuatkan web/app tapi sedang di mode Chat, beri tahu singkat: ganti ke mode Build lewat tombol mode di kotak input, lalu kirim lagi."
        new_mode = "MODE CHAT (CHAT_BUILD_MODE_FIX): HANYA ngobrol/tanya-jawab/saran — GRATIS, TANPA tools workspace. Fokus jawaban pintar. MODE BUILD: bangun situs/app dengan tools; LANGSUNG write_file — DILARANG muter list_items/read folder berulang. Kalau user minta web di mode Chat: minta ganti ke Build, jangan baca folder."
        if old_mode in u:
            u = u.replace(old_mode, new_mode, 1)
        up.write_text(u, encoding="utf-8")
        print("index patched")
    else:
        print("index already OK")

sp = Path("functions/api/chat.js")
c = sp.read_text(encoding="utf-8")
changed = False

c2, n = re.subn(r"('claude-haiku-5\.5':\s*)512\b", r"\g<1>1024 /* CHAT_BUILD_MODE_FIX */", c, count=1)
if n:
    c = c2
    changed = True
    print("haiku tokens -> 1024")
else:
    print("haiku tokens skip")

if "CHAT_BUILD_MODE_FIX, WAJIB" not in c:
    needle = "ATURAN MENULIS FILE (WAJIB"
    idx = c.find(needle)
    if idx >= 0:
        inject = "ATURAN MODE BUILD (CHAT_BUILD_MODE_FIX, WAJIB): Di mode Build WAJIB langsung menghasilkan file. DILARANG list_items/read_file berulang di awal tugas baru bila user minta dibuatkan/diubah — langsung write_file. list_items hanya untuk verifikasi SETELAH menulis atau jika user minta cek. Satu sesi = lanjut kerja, bukan eksplorasi folder. "
        c = c[:idx] + inject + c[idx:]
        changed = True
        print("write-first injected")
    else:
        print("ATURAN MENULIS not found")

if "wantTools" not in c:
    old = "const gTools = body.workspace_tools === true"
    new = "const wantTools = body.workspace_tools === true && String(body.mode || '').trim() !== 'chat'; // CHAT_BUILD_MODE_FIX\n    const gTools = wantTools"
    if old in c:
        c = c.replace(old, new, 1)
        changed = True
        print("gTools gated")
    else:
        print("gTools anchor missing")

if changed:
    sp.write_text(c, encoding="utf-8")
    print("chat.js written", sp.stat().st_size)
else:
    print("chat.js no changes", "CHAT_BUILD_MODE_FIX" in c)
