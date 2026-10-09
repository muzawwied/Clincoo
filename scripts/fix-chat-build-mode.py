#!/usr/bin/env python3
"""Chat mode: no workspace tools. Build mode: smarter, write-first, more tokens."""
from pathlib import Path

up = Path("proyek/chat/index.html")
u = up.read_text(encoding="utf-8")
if "CHAT_BUILD_MODE_FIX" in u:
    print("index already patched")
else:
    old = "workspace_tools: true,"
    new = "workspace_tools: ((typeof window.selectedAiMode === 'function' && window.selectedAiMode()) === 'build'), // CHAT_BUILD_MODE_FIX: tools hanya di mode Build"
    count = u.count(old)
    if count < 1:
        raise SystemExit("workspace_tools: true not found")
    u = u.replace(old, new)
    print("workspace_tools gated x", count)

    old_mode = "MODE CHAT: untuk ngobrol, tanya-jawab, minta saran/penjelasan; GRATIS (tidak memotong kredit, ada batas pesan harian/bulanan); fokus menjawab, tidak membuat/mengubah file proyek. MODE BUILD: untuk membangun situs/aplikasi sungguhan; memakai tools (tulis file, backend, database, deploy) dan MEMOTONG KREDIT sesuai pemakaian nyata; kalau saldo kredit habis, user diarahkan Top Up di halaman Kredit. Kalau user minta dibuatkan web/app tapi sedang di mode Chat, beri tahu singkat: ganti ke mode Build lewat tombol mode di kotak input, lalu kirim lagi."
    new_mode = "MODE CHAT (CHAT_BUILD_MODE_FIX): HANYA ngobrol/tanya-jawab/saran — GRATIS, TANPA tools workspace (tidak list_items, tidak read_file, tidak write_file). Fokus jawaban pintar dan lengkap. MODE BUILD: membangun situs/app sungguhan dengan tools; kredit dipotong; LANGSUNG write_file — DILARANG muter list_items/read folder berulang jika riwayat sudah punya status workspace. Kalau user minta dibuatkan web/app di mode Chat, jawab singkat: ganti ke mode Build (tombol mode di kotak input), lalu kirim ulang — jangan pura-pura baca folder."
    if old_mode not in u:
        print("WARN: MODE CHAT text not exact")
    else:
        u = u.replace(old_mode, new_mode, 1)
        print("MODE CHAT/BUILD text updated")

    up.write_text(u, encoding="utf-8")
    print("index.html", up.stat().st_size)

sp = Path("functions/api/chat.js")
c = sp.read_text(encoding="utf-8")
if "CHAT_BUILD_MODE_FIX" in c:
    print("chat.js already patched")
else:
    old_tok = "const MR_MAX_TOKENS = { 'claude-haiku-5.5': 512,"
    new_tok = "const MR_MAX_TOKENS = { 'claude-haiku-5.5': 1024, // CHAT_BUILD_MODE_FIX: build lebih pintar/panjang"
    if old_tok not in c:
        print("WARN: MR_MAX_TOKENS not found")
    else:
        c = c.replace(old_tok, new_tok, 1)
        print("haiku tokens 512->1024")

    old_rule = "ATURAN MENULIS FILE (WAJIB — FILE_200KB_PLUS):"
    new_rule = "ATURAN MODE BUILD (CHAT_BUILD_MODE_FIX, WAJIB): Di mode Build kamu WAJIB langsung menghasilkan file. DILARANG membuka dengan list_items/read_file berulang-ulang di awal tugas baru jika user sudah minta dibuatkan/diubah — langsung write_file. list_items hanya bila perlu verifikasi SETELAH menulis, atau user eksplisit minta cek isi. Satu sesi = lanjut kerja, bukan eksplorasi folder. ATURAN MENULIS FILE (WAJIB — FILE_200KB_PLUS):"
    if old_rule not in c:
        # fallback if FILE_200KB not applied yet
        old_rule2 = "ATURAN MENULIS FILE (WAJIB, karena batas output per panggilan kecil):"
        if old_rule2 in c:
            c = c.replace(old_rule2, new_rule.replace("ATURAN MENULIS FILE (WAJIB — FILE_200KB_PLUS):", "ATURAN MENULIS FILE (WAJIB):"), 1)
            print("build rule injected (fallback)")
        else:
            print("WARN: ATURAN MENULIS not found")
    else:
        c = c.replace(old_rule, new_rule, 1)
        print("build write-first rule injected")

    old_gt = """    const gTools = body.workspace_tools === true
      ? [{ functionDeclarations: decls }]"""
    new_gt = """    // CHAT_BUILD_MODE_FIX: mode chat = tanpa tools workspace (cegah list_items loop)
    const wantTools = body.workspace_tools === true && String(body.mode || '').trim() !== 'chat';
    const gTools = wantTools
      ? [{ functionDeclarations: decls }]"""
    if old_gt not in c:
        print("WARN: gTools block not found")
    else:
        c = c.replace(old_gt, new_gt, 1)
        print("server workspace_tools gated by mode")

    sp.write_text(c, encoding="utf-8")
    print("chat.js", sp.stat().st_size)
