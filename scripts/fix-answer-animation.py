#!/usr/bin/env python3
"""Smooth AI answer appearance: soft fade-in + gentler typewriter."""
from pathlib import Path

p = Path("proyek/chat/index.html")
c = p.read_text(encoding="utf-8")

if "ai-answer-reveal" in c and "AI_ANSWER_SMOOTH" in c:
    print("already patched")
    raise SystemExit(0)

css_anchor = """        .typing-cursor::after {
            content: '|';
            animation: blink 1s step-start infinite;
            color: #9ca3af;
            margin-left: 2px;
        }"""

css_new = """        .typing-cursor::after {
            content: '|';
            animation: blink 1s step-start infinite;
            color: #9ca3af;
            margin-left: 2px;
        }

        /* Jawaban AI muncul halus (bukan pop mendadak) */
        .ai-answer-reveal {
            animation: aiAnswerReveal 0.45s cubic-bezier(0.22, 0.61, 0.36, 1) both;
        }
        @keyframes aiAnswerReveal {
            from { opacity: 0; transform: translateY(6px); filter: blur(1.5px); }
            to   { opacity: 1; transform: translateY(0); filter: blur(0); }
        }
        .md-content.ai-streaming {
            transition: opacity 0.2s ease;
        }
        .md-content.ai-answer-reveal > *:first-child {
            animation: aiAnswerReveal 0.4s cubic-bezier(0.22, 0.61, 0.36, 1) both;
        }"""

if css_anchor not in c:
    raise SystemExit("CSS typing-cursor block not found")
c = c.replace(css_anchor, css_new, 1)

old_tw = """            let localText = "";
            typingInterval = setInterval(() => {
                if (charIndex < streamingBuffer.length) {
                    const diff = streamingBuffer.length - charIndex;
                    
                    let charsToProcess = Math.max(2, Math.floor(diff / 2));
                    if (diff > 50) charsToProcess = Math.max(20, Math.floor(diff / 1.5));
                    
                    localText += streamingBuffer.substring(charIndex, charIndex + charsToProcess);
                    charIndex += charsToProcess;
                    
                    const msgIndex = messages.findIndex(m => m.id === aiMsgObj.id);
                    if (msgIndex !== -1) {
                        messages[msgIndex].text = localText;
                        const textEl = document.getElementById(`msg-text-${aiMsgObj.id}`);
                        if (textEl) {
                            textEl.innerHTML = formatMarkdown(balanceMarkdown(messages[msgIndex].text));
                            textEl.classList.add('typing-cursor');
                        }
                    }
                    scrollToBottom(false);
                } else if (isFetchComplete && charIndex >= streamingBuffer.length) {
                    stopGeneration();
                }
            }, 15);"""

new_tw = """            let localText = "";
            let __answerRevealed = false; // AI_ANSWER_SMOOTH
            // Typewriter lebih halus: chunk kecil + interval sedikit lebih longgar
            typingInterval = setInterval(() => {
                if (charIndex < streamingBuffer.length) {
                    const diff = streamingBuffer.length - charIndex;
                    // chunk lembut: 1–8 karakter; hanya kejar cepat bila backlog sangat besar
                    let charsToProcess = 1;
                    if (diff > 8) charsToProcess = Math.min(4, Math.ceil(diff / 12));
                    if (diff > 80) charsToProcess = Math.min(12, Math.ceil(diff / 10));
                    if (diff > 400) charsToProcess = Math.min(28, Math.ceil(diff / 8));
                    
                    localText += streamingBuffer.substring(charIndex, charIndex + charsToProcess);
                    charIndex += charsToProcess;
                    
                    const msgIndex = messages.findIndex(m => m.id === aiMsgObj.id);
                    if (msgIndex !== -1) {
                        messages[msgIndex].text = localText;
                        const textEl = document.getElementById(`msg-text-${aiMsgObj.id}`);
                        if (textEl) {
                            textEl.innerHTML = formatMarkdown(balanceMarkdown(messages[msgIndex].text));
                            textEl.classList.add('typing-cursor', 'md-content', 'ai-streaming');
                            if (!__answerRevealed && localText.trim().length > 0) {
                                __answerRevealed = true;
                                textEl.classList.add('ai-answer-reveal');
                            }
                        }
                    }
                    scrollToBottom(false);
                } else if (isFetchComplete && charIndex >= streamingBuffer.length) {
                    const textEl = document.getElementById(`msg-text-${aiMsgObj.id}`);
                    if (textEl) {
                        textEl.classList.remove('typing-cursor', 'ai-streaming');
                        if (!__answerRevealed) {
                            textEl.classList.add('ai-answer-reveal');
                            __answerRevealed = true;
                        }
                    }
                    stopGeneration();
                }
            }, 22);"""

if old_tw not in c:
    raise SystemExit("typewriter block not found")
c = c.replace(old_tw, new_tw, 1)

marker_skip = "charIndex = parsedFinalApk.clean.length;\n                            const dfIdx = messages.findIndex(m => m.id === aiMsgObj.id);\n                            if (dfIdx !== -1) messages[dfIdx].text = parsedFinalApk.clean;"
if marker_skip not in c:
    raise SystemExit("skip-typewriter marker not found")
inject = """charIndex = parsedFinalApk.clean.length;
                            const dfIdx = messages.findIndex(m => m.id === aiMsgObj.id);
                            if (dfIdx !== -1) messages[dfIdx].text = parsedFinalApk.clean;
                            // AI_ANSWER_SMOOTH: jawaban penuh tetap fade-in sekali
                            requestAnimationFrame(() => {
                                const el = document.getElementById('msg-text-' + aiMsgObj.id);
                                if (el && !el.classList.contains('ai-answer-reveal')) el.classList.add('ai-answer-reveal');
                            });"""
c = c.replace(marker_skip, inject, 1)

old_msg = '''                                <div class="text-black text-[15px] leading-normal break-words w-full md-content pointer-events-auto overflow-hidden" style="word-break: break-word; overflow-wrap: break-word; max-width: 100%;" id="msg-text-${msg.id}">
                                    ${(msg.isProcessing && isInfoOnlyToolCalls(msg.toolCalls)) ? processIndicator : (msg.isImageResponse ? msg.text : formatMarkdown(balanceMarkdown(msg.text)))}
                                </div>'''

new_msg = '''                                <div class="text-black text-[15px] leading-normal break-words w-full md-content pointer-events-auto overflow-hidden${(!msg.isProcessing && !msg.isTyping && msg.text && msg.role === 'ai') ? ' ai-answer-reveal' : ''}" style="word-break: break-word; overflow-wrap: break-word; max-width: 100%;" id="msg-text-${msg.id}">
                                    ${(msg.isProcessing && isInfoOnlyToolCalls(msg.toolCalls)) ? processIndicator : (msg.isImageResponse ? msg.text : formatMarkdown(balanceMarkdown(msg.text)))}
                                </div>'''

if old_msg not in c:
    raise SystemExit("msg-text container not found")
c = c.replace(old_msg, new_msg, 1)

p.write_text(c, encoding="utf-8")
print("patched OK", p.stat().st_size)
