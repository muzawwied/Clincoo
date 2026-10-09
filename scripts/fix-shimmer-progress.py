#!/usr/bin/env python3
"""Make chat shimmer progress follow real AI activity (not timer hardcode)."""
from pathlib import Path
p = Path("proyek/chat/index.html")
c = p.read_text(encoding="utf-8")
if "Still waiting for the AI" in c and "slowShimmer" not in c:
    print("already patched")
else:
    start = c.find('// [9 Okt 2026] "Halo" cuma muter Thinking')
    end = c.find('const stallTimer = setInterval', start)
    if start < 0 or end < 0:
        raise SystemExit("slowTimer block not found")
    new_block = """// [9 Okt] Shimmer HANYA dari aktivitas AI nyata (progress/delta/tool),
                        // BUKAN timer hardcode "Working on it / Still composing".
                        // Timer di bawah hanya pesan koneksi setelah lama tanpa event sama sekali.
                        let __composingNotified = false; // "Composing" hanya saat delta BENAR-BENAR datang
                        const slowStart = Date.now();
                        let slowNotified = false;
                        const slowTimer = setInterval(() => {
                            if (!isGenerating) { clearInterval(slowTimer); return; }
                            if (hasReceivedData || deltaStreamed) { clearInterval(slowTimer); return; }
                            const waited = Date.now() - slowStart;
                            // Hanya satu pesan jujur setelah 45 dtk tanpa event — bukan progress palsu
                            if (!slowNotified && waited > 45000) {
                                slowNotified = true;
                                setAiStatus('Still waiting for the AI…');
                            }
                        }, 5000);
                        """
    c = c[:start] + new_block + c[end:]
    old_h = """return await readNdjsonStream(response0, (evt) => {
                                    lastEventAt = Date.now(); // event hidup -> stream masih sehat
                                    if (evt.t === 'delta') {
                                        hasReceivedData = true;
                                        if (!__composingNotified) { __composingNotified = true; setAiStatus('Composing the answer…'); }
                                        deltaStreamed += evt.text || '';
                                        streamingBuffer = deltaStreamed;
                                        return;
                                    }
                                    if (evt.t === 'progress') hasReceivedData = true;
                                    setAiStatus(evt.text || 'Thinking...');
                                });"""
    new_h = """return await readNdjsonStream(response0, (evt) => {
                                    lastEventAt = Date.now(); // event hidup -> stream masih sehat
                                    if (evt.t === 'delta') {
                                        hasReceivedData = true;
                                        if (!__composingNotified) { __composingNotified = true; setAiStatus('Composing the answer…'); }
                                        deltaStreamed += evt.text || '';
                                        streamingBuffer = deltaStreamed;
                                        return;
                                    }
                                    if (evt.t === 'progress') {
                                        hasReceivedData = true;
                                        if (evt.text) setAiStatus(evt.text);
                                        return;
                                    }
                                    // thinking: jangan hardcode ulang — biarkan status tool/progress terakhir
                                    if (evt.t === 'thinking') return;
                                    if (evt.text) setAiStatus(evt.text);
                                });"""
    if old_h not in c:
        raise SystemExit("ndjson handler not found")
    c = c.replace(old_h, new_h)
    p.write_text(c, encoding="utf-8")
    print("patched OK", p.stat().st_size)

# Server: keep thinking event, avoid clobbering with empty text on client
sp = Path("functions/api/chat.js")
if sp.exists():
    sc = sp.read_text(encoding="utf-8")
    marker = "if (streamSend) streamSend({ t: 'thinking' });"
    if marker in sc and "progress', text: 'Thinking" not in sc:
        better = """if (streamSend) {
      streamSend({ t: 'thinking' });
      try { streamSend({ t: 'progress', text: 'Thinking…' }); } catch (e) {}
    }"""
        sc = sc.replace(marker, better, 1)
        sp.write_text(sc, encoding="utf-8")
        print("server thinking progress patched")
    else:
        print("server skip or already done")
