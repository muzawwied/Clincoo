#!/usr/bin/env python3
from pathlib import Path
p = Path("proyek/chat/index.html")
c = p.read_text(encoding="utf-8")
if "SESSION_RESUME_FIX" in c:
    print("already patched"); raise SystemExit(0)
# 1 save filter
a = "m.text || (m.pollQuestions"
b = "m.text || m.isProcessing || m.isTyping || (m.pollQuestions"
if a not in c: raise SystemExit("filter anchor missing")
c = c.replace(a, b, 1)
# 2 bump ts on save
a2 = """                localStorage.setItem(lsChatKey(), JSON.stringify(log));
                // FIX: session_id ikut dipersist per proyek — setelah reload/error,
                // auto-lanjut memakai SESI YANG SAMA, bukan sesi baru dari server.
                if (currentSessionId) { try { localStorage.setItem(lsChatKey() + '_session', currentSessionId); } catch(e) {} }"""
b2 = """                localStorage.setItem(lsChatKey(), JSON.stringify(log));
                // SESSION_RESUME_FIX: timestamp lokal selalu naik — cegah cloud menimpa lokal lebih baru
                try { localStorage.setItem(chatSyncTsKey(), String(Date.now())); } catch(e) {}
                // FIX: session_id ikut dipersist per proyek — setelah reload/error,
                // auto-lanjut memakai SESI YANG SAMA, bukan sesi baru dari server.
                if (currentSessionId) { try { localStorage.setItem(lsChatKey() + '_session', currentSessionId); } catch(e) {} }"""
if a2 not in c: raise SystemExit("save ts anchor missing")
c = c.replace(a2, b2, 1)
# 3 sync overwrite guard
a3 = """        if (remote.ts <= localTs) return; // versi lokal masih yang terbaru
        messages = remote.log;"""
b3 = """        if (remote.ts <= localTs) return; // versi lokal masih yang terbaru
        // SESSION_RESUME_FIX: jangan timpa lokal yang pending / lebih panjang
        try {
            const localRaw = localStorage.getItem(lsChatKey());
            const localLog = localRaw ? JSON.parse(localRaw) : [];
            if (Array.isArray(localLog) && localLog.length > 0) {
                if (localLog.some(function (m) { return m && m.role === 'ai' && (m.isProcessing || m.isTyping); })) return;
                if (localLog.length > remote.log.length && localTs >= remote.ts - 5000) return;
            }
        } catch (e) {}
        if (typeof isGenerating !== 'undefined' && isGenerating) return;
        messages = remote.log;"""
if a3 not in c: raise SystemExit("sync guard anchor missing")
c = c.replace(a3, b3, 1)
# 4 load session always
a4 = """                    if (!currentSessionId) { try { currentSessionId = localStorage.getItem(lsChatKey() + '_session') || null; } catch(e) {} }"""
b4 = """                    try { const sid = localStorage.getItem(lsChatKey() + '_session'); if (sid) currentSessionId = sid; } catch(e) {} // SESSION_RESUME_FIX"""
if a4 not in c: raise SystemExit("load session anchor missing")
c = c.replace(a4, b4, 1)
# 5 handleSubmit save
a5 = """            renderMessages();
            pinMessageToTop(userMsg.id);
            
            if (agentModeOn && val) { runAgentTask(val); return; }
            fetchAIResponse();
        }"""
b5 = """            renderMessages();
            try { saveChatLog(); } catch (e) {} // SESSION_RESUME_FIX
            pinMessageToTop(userMsg.id);
            
            if (agentModeOn && val) { runAgentTask(val); return; }
            fetchAIResponse();
        }"""
if a5 not in c: raise SystemExit("handleSubmit anchor missing")
c = c.replace(a5, b5, 1)
# 6 AI bubble save
a6 = """            messages.push(aiMsgObj);
            renderMessages();
            // Tidak lagi force-scroll ke bawah di sini:"""
b6 = """            messages.push(aiMsgObj);
            renderMessages();
            try { saveChatLog(); } catch (e) {} // SESSION_RESUME_FIX
            // Tidak lagi force-scroll ke bawah di sini:"""
if a6 not in c: raise SystemExit("ai push anchor missing")
c = c.replace(a6, b6, 1)
# 7 persist session_id
c = c.replace(
    "if (resultJson && resultJson.session_id) currentSessionId = resultJson.session_id;",
    "if (resultJson && resultJson.session_id) { currentSessionId = resultJson.session_id; try { localStorage.setItem(lsChatKey() + '_session', currentSessionId); } catch(e) {} }",
)
p.write_text(c, encoding="utf-8")
print("patched OK", p.stat().st_size)
