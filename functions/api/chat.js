import { PLAN_AI_LIMITS, ADMIN_EMAILS, getEffectivePlanByUserKey, featureAllowed } from './plan-helpers.js';
import { searchClincooBlog } from './blogsearch.js';
import { paymentDocsFor } from './payment-kb-data.js';
import { aiStorageSave, aiStorageGet, aiStorageList, aiStorageDelete } from './ai-storage.js';
import { consumePackCredit, getActivePacks } from './ai-packs.js';
import { initTables as initAuthTables, getUserByToken, getToken } from './auth/shared.js';
import { wsToolExec, WS_TOOL_NAMES } from './_ws-tools.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

export async function onRequestOptions() {
  return new Response(null, { status: 200, headers: CORS });
}

const RATE_LIMIT = { max: 30, windowMs: 60_000 };
const rateBuckets = new Map();
function rateLimitOk(ip) {
  const now = Date.now();
  let b = rateBuckets.get(ip);
  if (!b || now - b.start >= RATE_LIMIT.windowMs) b = { start: now, count: 0 };
  b.count++;
  rateBuckets.set(ip, b);
  if (rateBuckets.size > 5000) {
    for (const [k, v] of rateBuckets) if (now - v.start >= RATE_LIMIT.windowMs) rateBuckets.delete(k);
  }
  return b.count <= RATE_LIMIT.max;
}
function clientIp(request) {
  try { return (request && request.headers && request.headers.get('cf-connecting-ip')) || 'unknown'; } catch (e) { return 'unknown'; }
}
function textOf(m) {
  if (typeof m.content === 'string') return m.content;
  if (Array.isArray(m.content)) return m.content.filter(b => b && b.type === 'text').map(b => b.text).join('\n');
  return '';
}

function toOAIChat(messages) {
  let system = messages.some(m => m.role === 'system') ? messages.filter(m => m.role === 'system').map(textOf).join('\n\n') : '';

  try {
    const lastUser = [...messages].reverse().find(m => m && m.role === 'user');
    const pay = paymentDocsFor(lastUser ? textOf(lastUser) : '');
    if (pay) system = (system ? system + '\n\n' : '') + pay;
  } catch (e) {}
  const chatMsgs = [];
  let lastCallIds = [];
  for (const m of messages) {
    if (m.role === 'system') continue;
    const blocks = Array.isArray(m.content) ? m.content : null;
    const t = textOf(m);
    if (blocks && blocks.some(b => b && b.type === 'function_call')) {
      const calls = blocks.filter(b => b && b.type === 'function_call');
      lastCallIds = calls.map((b, i) => 'call_' + chatMsgs.length + '_' + i);
      chatMsgs.push({ role: 'assistant', content: t || '', tool_calls: calls.map((b, i) => ({ id: lastCallIds[i], type: 'function', function: { name: b.name, arguments: JSON.stringify(b.args || {}) } })) });
      continue;
    }
    if (blocks && blocks.some(b => b && b.type === 'function_response')) {
      for (const b of blocks.filter(b => b && b.type === 'function_response')) {
        let rs = ''; try { rs = (typeof b.result === 'string') ? b.result : JSON.stringify(b.result); } catch (e) { rs = ''; }
        chatMsgs.push({ role: 'tool', tool_call_id: lastCallIds.shift() || ('call_orphan_' + chatMsgs.length), content: rs || ' ' });
      }
      if (t) chatMsgs.push({ role: 'user', content: t });
      continue;
    }
    if (t) chatMsgs.push({ role: m.role, content: t });
  }
  return { system, chatMsgs };
}
const oaiToolsOf = (gDecls) => (gDecls && gDecls.length) ? gDecls.map(d => ({ type: 'function', function: { name: d.name, description: d.description || '', parameters: orParam(d.parameters || { type: 'OBJECT', properties: {} }) } })) : null;

function withTimeout(promise, ms, label) {
  let t;
  const timeout = new Promise((_, reject) => { t = setTimeout(() => reject(new Error((label || 'provider') + ' timeout setelah ' + ms + 'ms')), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

async function readOAICompatStream(res, onDelta) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '', text = '', fin = null;
  const tcMap = {};
  let streamEnd = false;
  while (!streamEnd) {
    const rd = await reader.read();
    if (rd.done) break;
    buf += dec.decode(rd.value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line || line.charAt(0) === ':') continue;
      if (line.indexOf('data:') !== 0) continue;
      const dbody = line.slice(5).trim();
      if (dbody === '[DONE]') { streamEnd = true; break; }
      let j; try { j = JSON.parse(dbody); } catch (e) { continue; }
      const ch = j.choices && j.choices[0];
      if (!ch) continue;
      const d = ch.delta || {};
      if (typeof d.content === 'string' && d.content) {
        text += d.content;
        try { onDelta(d.content); } catch (e) {}
      }
      if (Array.isArray(d.tool_calls)) {
        for (const tc of d.tool_calls) {
          const ix = (tc.index !== undefined) ? tc.index : 0;
          if (!tcMap[ix]) tcMap[ix] = { name: '', args: '' };
          const fn = tc.function || {};
          if (fn.name && !tcMap[ix].name) tcMap[ix].name = fn.name;
          if (typeof fn.arguments === 'string') tcMap[ix].args += fn.arguments;
        }
      }
      if (ch.finish_reason) fin = ch.finish_reason;
    }
  }
  const tcs = Object.keys(tcMap).sort((a, b) => Number(a) - Number(b)).map((k) => tcMap[k]).filter((x) => x.name);
  return { text, fin, tcs };
}

function normStreamToolCalls(tcs) {
  const norm = [];
  for (const c of tcs) {

    let a = null; try { a = c.args ? JSON.parse(c.args) : null; } catch (e) { a = null; }
    if (a) norm.push({ name: c.name, args: a });
  }
  return norm;
}

async function getModelRouterKeys(env) {
  const keys = [];
  const seen = new Set();
  const add = v => { v = String(v || '').trim(); if (v && !seen.has(v)) { seen.add(v); keys.push(v); } };
  add(env.MODELROUTER_API_KEY);
  if (!env.DB) return keys;
  try {
    const rows = await env.DB.prepare("SELECT key, value FROM env_vars WHERE key = 'MODELROUTER_API_KEY'").all();
    for (const r of rows.results || []) add(r.value);
  } catch {}
  return keys;
}

const MR_MODEL = 'glm-5.3-flash:mr';
const MR_OUT_TOKENS = 8192;
const MR_TIMEOUT_MS = 170000;

const MODELROUTER_MODELS = [MR_MODEL];

const MR_MAX_TOKENS = { [MR_MODEL]: MR_OUT_TOKENS };
const MR_ENDPOINT = 'https://modelrouter.id/v1/chat/completions';

const mrLabel = () => 'orkestra-1-pro';

function mrContinueMsg(seg) {
  const tailTxt = String(seg || '').slice(-80).replace(/\s+/g, ' ');
  return 'Jawabanmu terpotong batas panjang. Ekor teks terakhirmu: "' + tailTxt + '". Sambung LANGSUNG dari karakter berikutnya setelah ekor itu (kalau terpotong di tengah kata, lengkapi kata itu dulu). DILARANG mengulang kalimat/kata yang sudah tertulis, DILARANG membuka kalimat baru seperti "Lanjut..." atau minta maaf, DILARANG bertanya. Keluarkan HANYA sambungannya.';
}
function mrJoinContinuation(prev, cont) {
  let c = String(cont || '');
  if (!c) return String(prev || '');
  c = c.replace(/^\s*(lanjut(an)?(\s+dari[^.\n]{0,40})?[:,.\-–—]*\s*)/i, '');
  const p = String(prev || '');
  const maxOv = Math.min(120, p.length, c.length);
  for (let n = maxOv; n >= 6; n--) {
    if (p.slice(-n) === c.slice(0, n)) { c = c.slice(n); break; }
  }

  const lastWord = (p.match(/([A-Za-zÀ-ÿ]+)$/) || [])[1] || '';
  const WHOLE = /^(dan|yang|di|ke|dari|untuk|ini|itu|ada|atau|juga|saya|aku|kamu|kita|anda|akan|bisa|mau|oke|ok|ya|tidak|bukan|the|and|for|with|web|app|css|js|api|seo)$/i;
  if (lastWord && lastWord.length <= 3 && !WHOLE.test(lastWord) && /^[A-Z][a-z]/.test(c)) {
    const cut = p.slice(0, p.length - lastWord.length).replace(/\s+$/, '');
    return cut + (cut && !/[.!?:\n]$/.test(cut) ? '. ' : ' ') + c;
  }

  if (/[A-Za-zÀ-ÿ0-9]$/.test(p) && /^[A-Z][a-z]/.test(c)) return p + ' ' + c;
  return p + c;
}

async function tryModelRouterText(keys, messages, gDecls, models, onDelta, usageAcc) {
  const keyList = Array.isArray(keys) ? keys.filter(Boolean) : [keys].filter(Boolean);
  if (!keyList.length) return null;
  const modelList = (Array.isArray(models) && models.length) ? models : MODELROUTER_MODELS;
  const { system, chatMsgs } = toOAIChat(messages);
  const oaiTools = oaiToolsOf(gDecls);
  const callMr = (key, model, msgs, stream) => {

    if (usageAcc) usageAcc[model] = (usageAcc[model] || 0) + tokensOfChars(JSON.stringify(msgs));
    const p = { model, messages: msgs, max_tokens: (MR_MAX_TOKENS && MR_MAX_TOKENS[model]) || 128 };
    if (stream) p.stream = true;
    if (oaiTools) p.tools = oaiTools;
    return fetch(MR_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key, 'HTTP-Referer': 'https://clincoo.buzz', 'X-Title': 'Clincoo' },
      body: JSON.stringify(p)
    });
  };
  let lastErr = null;
  let sawRateLimit = false;

  const mrContinueToolArgs = async (key, model, baseMsgs, tc) => {
    let acc = tc.args || '';

    for (let hop = 0; hop < 48; hop++) {
      const tryMsgs = baseMsgs.slice();
      tryMsgs.push({ role: 'assistant', content: null, tool_calls: [{ id: 'cut' + hop, type: 'function', function: { name: tc.name, arguments: acc } }] });
      tryMsgs.push({ role: 'user', content: 'Tool call terakhirmu TERPOTONG karena batas token. Lanjutkan PERSIS dari karakter terakhir argumen JSON itu — keluarkan HANYA sambungan string JSON-nya tanpa penjelasan, tanpa blok kode, lalu berhenti segera setelah JSON-nya lengkap dan valid.' });
      try {
        const cr = await callMr(key, model, tryMsgs, true);
        if (!cr.ok || !cr.body) return null;
        const st2 = await readOAICompatStream(cr, null);
        let cont = (st2 && st2.text ? st2.text : '').trim();
        if (!cont) return null;
        cont = cont.replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/, '').trim();
        acc += cont;
        try { return JSON.parse(acc); } catch (e) {}
        if (st2.fin !== 'length') return null;
      } catch (e) { return null; }
    }
    return null;
  };
  for (const key of keyList) {
  for (const model of modelList) {
    const baseMsgs = system ? [{ role: 'system', content: system }, ...chatMsgs] : chatMsgs;
    let data = null;

    if (onDelta) {
      try {
        const sr = await callMr(key, model, baseMsgs, true);
        if (sr.ok && sr.body) {
          const st = await readOAICompatStream(sr, onDelta);
          if (st.text || st.tcs.length) {
            if (st.tcs.length) {

              const nt = normStreamToolCalls(st.tcs);
              if (nt.length && st.fin !== 'length') return { tool_calls: nt, text: st.text, model: mrLabel(model) };
              if (st.fin === 'length') {
                const fixed = [];
                for (const c of st.tcs) {
                  let a = null; try { a = c.args ? JSON.parse(c.args) : null; } catch (e) { a = null; }
                  if (!a) a = await mrContinueToolArgs(key, model, baseMsgs, c);
                  if (a) fixed.push({ name: c.name, args: a });
                }
                if (fixed.length) { if (usageAcc) usageAcc[model] = (usageAcc[model] || 0) + tokensOfChars((st.text || '') + JSON.stringify(fixed)); return { tool_calls: fixed, text: st.text, model: mrLabel(model) }; }
                lastErr = 'ModelRouter ' + model + ': tool call terpotong, penyambungan gagal';
                continue;
              }
              lastErr = 'ModelRouter ' + model + ': tool call rusak (args gak valid)';
              continue;
            }

            let full = st.text, seg = st.text, fin2 = st.fin;
            const contMsgs = baseMsgs.slice();
            for (let sc = 0; sc < 5 && fin2 === 'length'; sc++) {
              contMsgs.push({ role: 'assistant', content: seg });
              contMsgs.push({ role: 'user', content: mrContinueMsg(seg) });
              try {
                const cr = await callMr(key, model, contMsgs, true);
                if (!cr.ok || !cr.body) break;
                const st2 = await readOAICompatStream(cr, onDelta);
                if (!st2.text) break;
                full = mrJoinContinuation(full, st2.text); seg = st2.text; fin2 = st2.fin;
              } catch (e2) { break; }
            }
            { if (usageAcc) usageAcc[model] = (usageAcc[model] || 0) + tokensOfChars(full); return { text: full, model: mrLabel(model) }; }
          }
          lastErr = 'ModelRouter ' + model + ': stream kosong';
        }
        if (!sr.ok) { lastErr = 'ModelRouter ' + model + ': HTTP ' + sr.status; if (sr.status === 429) sawRateLimit = true; }
      } catch (e) { lastErr = 'ModelRouter ' + model + ': ' + (e && e.message); }
    }
    try {
      const res = await callMr(key, model, baseMsgs, false);
      data = await res.json().catch(() => ({}));
      if (!res.ok) { lastErr = 'ModelRouter ' + model + ': HTTP ' + res.status; if (res.status === 429) sawRateLimit = true; continue; }
    } catch (e) { lastErr = 'ModelRouter ' + model + ': ' + (e && e.message); continue; }
    const msg = data && data.choices && data.choices[0] && data.choices[0].message;
    const text = (msg && msg.content) || '';
    const finish = data && data.choices && data.choices[0] && data.choices[0].finish_reason;
    const tcs = msg && Array.isArray(msg.tool_calls) ? msg.tool_calls : null;
    if (tcs && tcs.length) {
      const norm = [];
      for (const c of tcs) {
        let a = null;
        const rawArgs = (c && c.function && typeof c.function.arguments === 'string') ? c.function.arguments : null;
        if (rawArgs) { try { a = JSON.parse(rawArgs); } catch (e) { a = null; } }

        if (!a && c && c.function && c.function.name) {
          a = await mrContinueToolArgs(key, model, baseMsgs, { name: c.function.name, args: rawArgs || '' });
        }
        if (c && c.function && c.function.name && a) norm.push({ name: c.function.name, args: a });
      }
      if (norm.length) { if (usageAcc) usageAcc[model] = (usageAcc[model] || 0) + tokensOfChars(text + JSON.stringify(norm)); return { tool_calls: norm, text, model: mrLabel(model) }; }

      lastErr = 'ModelRouter ' + model + ': tool call terpotong, penyambungan gagal';
      continue;
    }
    if (text) {

      let full = text, seg = text, fin = finish;
      const contMsgs = baseMsgs.slice();
      for (let ac = 0; ac < 3 && fin === 'length'; ac++) {
        contMsgs.push({ role: 'assistant', content: seg });
        contMsgs.push({ role: 'user', content: mrContinueMsg(seg) });
        let dc = null;
        try { const rc = await callMr(key, model, contMsgs, false); dc = await rc.json().catch(() => ({})); } catch (e2) { dc = null; }
        const dm = dc && dc.choices && dc.choices[0] && dc.choices[0].message;
        const dseg = (dm && dm.content) || '';
        fin = dc && dc.choices && dc.choices[0] && dc.choices[0].finish_reason;
        if (!dseg) break;
        full = mrJoinContinuation(full, dseg); seg = dseg;
      }
      { if (usageAcc) usageAcc[model] = (usageAcc[model] || 0) + tokensOfChars(full); return { text: full, model: mrLabel(model) }; }
    }
    lastErr = 'ModelRouter ' + model + ': respons kosong';
  }
  }
  return lastErr ? (sawRateLimit ? { error: lastErr, quotaExhausted: true } : { error: lastErr }) : null;
}

// ===== Fallback Provider 1: Gemini (Google AI Studio) =====
const GEMINI_MODELS = ["gemini-2.5-flash", "gemini-2.0-flash", "gemini-1.5-flash", "gemini-3.6-flash"];

async function getGeminiKeys(env) {
  const keys = [];
  const seen = new Set();
  const add = v => { v = String(v || "").trim(); if (v && !seen.has(v)) { seen.add(v); keys.push(v); } };
  add(env.GEMINI_API_KEY);
  add(env.GEMINI_API_KEY_4); add(env.GEMINI_API_KEY_5); add(env.GEMINI_API_KEY_6);
  if (!env.DB) return keys;
  try {
    const rows = await env.DB.prepare("SELECT key, value FROM env_vars WHERE key IN ('GEMINI_API_KEY','GEMINI_API_KEY_2','GEMINI_API_KEY_3','GEMINI_API_KEY_4','GEMINI_API_KEY_5','GEMINI_API_KEY_6')").all();
    for (const r of rows.results || []) add(r.value);
  } catch {}
  return keys;
}

function partsFromContent(content) {
  if (typeof content === "string") return [{ text: content }];
  if (Array.isArray(content)) {
    const parts = [];
    for (const block of content) {
      if (!block) continue;
      if (block.type === "text" && block.text) parts.push({ text: block.text });
      else if (block.type === "image_url" && block.image_url?.url) {
        const m = /^data:(.+?);base64,(.+)$/.exec(block.image_url.url || "");
        if (m) parts.push({ inlineData: { mimeType: m[1], data: m[2] } });
      } else if (block.type === "function_call" && block.name) {
        const fcPart = { functionCall: { name: block.name, args: block.args || {} } };
        if (block.thought_signature) fcPart.thoughtSignature = block.thought_signature;
        parts.push(fcPart);
      } else if (block.type === "function_response" && block.name) {
        parts.push({ functionResponse: { name: block.name, response: { result: block.result } } });
      }
    }
    return parts.length ? parts : [{ text: "." }];
  }
  return [{ text: "." }];
}

function toGeminiPayload(messages) {
  let systemInstruction = null;
  const contents = [];
  for (const m of messages) {
    if (!m) continue;
    if (m.role === "system") {
      const text = typeof m.content === "string" ? m.content : partsFromContent(m.content).map(p => p.text || "").join("\n");
      systemInstruction = systemInstruction ? systemInstruction + "\n" + text : text;
      continue;
    }
    contents.push({ role: m.role === "assistant" ? "model" : "user", parts: partsFromContent(m.content) });
  }
  if (contents.length > 30) contents.splice(0, contents.length - 30);
  return { systemInstruction, contents };
}

async function fetchGeminiStream(apiKey, model, systemInstruction, contents, tools, onDelta) {
  const payload = { contents };
  if (tools) payload.tools = tools;
  if (systemInstruction) payload.systemInstruction = { parts: [{ text: systemInstruction }] };
  const res = await withTimeout(fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify(payload)
  }), 35000, "GeminiStream");
  if (!res.ok) {
    await res.text().catch(() => {});
    return { error: `Gemini ${model}: HTTP ${res.status}`, status: res.status };
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const parts = [];
  let finishReason = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      let j; try { j = JSON.parse(line.slice(5).trim()); } catch (e) { continue; }
      if (j.candidates && j.candidates[0] && j.candidates[0].finishReason) finishReason = j.candidates[0].finishReason;
      const cps = (j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts) || [];
      for (const pt of cps) {
        parts.push(pt);
        if (pt.text && onDelta) { try { onDelta(pt.text); } catch (eD) {} }
      }
    }
  }
  return { data: { candidates: [{ content: { parts }, finishReason }] } };
}

async function fetchGemini(apiKey, model, systemInstruction, contents, tools) {
  const payload = { contents };
  if (tools) payload.tools = tools;
  if (systemInstruction) payload.systemInstruction = { parts: [{ text: systemInstruction }] };
  const res = await withTimeout(fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify(payload)
  }), 35000, "Gemini");
  if (!res.ok) {
    await res.text().catch(() => {});
    return { error: `Gemini ${model}: HTTP ${res.status}`, status: res.status };
  }
  return { data: await res.json() };
}

async function tryGeminiText(apiKeys, messages, gDecls, onDelta) {
  const keys = Array.isArray(apiKeys) ? apiKeys.filter(Boolean) : [apiKeys].filter(Boolean);
  if (!keys.length) return null;
  const { systemInstruction, contents } = toGeminiPayload(messages);
  const tools = (gDecls && gDecls.length) ? [{ functionDeclarations: gDecls }] : null;
  let lastErr = null;
  for (const apiKey of keys) {
    for (const model of GEMINI_MODELS) {
      try {
        const r = onDelta
          ? await fetchGeminiStream(apiKey, model, systemInstruction, contents, tools, onDelta)
          : await fetchGemini(apiKey, model, systemInstruction, contents, tools);
        if (r.error) { lastErr = r.error; continue; }
        const parts = r.data?.candidates?.[0]?.content?.parts || [];
        const text = parts.map(p => p.text || "").join("");
        const toolCalls = parts
          .filter(p => p.functionCall)
          .map(p => ({ name: p.functionCall.name, args: p.functionCall.args || {}, thought_signature: p.thoughtSignature || undefined }));
        if (toolCalls.length > 0 || text) {
          return toolCalls.length > 0
            ? { tool_calls: toolCalls, text, model: `Gemini (${model})` }
            : { text, model: `Gemini (${model})` };
        }
      } catch (err) {
        lastErr = `Gemini ${model}: ${err && err.message}`;
      }
    }
  }
  return lastErr ? { error: lastErr } : null;
}

// ===== Fallback Provider 2: OpenRouter =====
const OPENROUTER_MODELS = [
  "google/gemma-4-26b-a4b-it:free",
  "cohere/north-mini-code:free",
  "anthropic/claude-haiku-5.5",
  "z-ai/glm-5.3-flash"
];

async function getOpenRouterKeys(env) {
  const keys = [];
  const seen = new Set();
  const add = v => { v = String(v || "").trim(); if (v && !seen.has(v)) { seen.add(v); keys.push(v); } };
  add(env.OPENROUTER_API_KEY);
  add(env.OPENROUTER_API_KEY_4); add(env.OPENROUTER_API_KEY_5); add(env.OPENROUTER_API_KEY_6);
  if (!env.DB) return keys;
  try {
    const rows = await env.DB.prepare("SELECT key, value FROM env_vars WHERE key IN ('OPENROUTER_API_KEY','OPENROUTER_API_KEY_2','OPENROUTER_API_KEY_3','OPENROUTER_API_KEY_4','OPENROUTER_API_KEY_5','OPENROUTER_API_KEY_6')").all();
    for (const r of rows.results || []) add(r.value);
  } catch {}
  return keys;
}

async function tryOpenRouterText(keys, messages, gDecls, onDelta) {
  const keyList = Array.isArray(keys) ? keys.filter(Boolean) : [keys].filter(Boolean);
  if (!keyList.length) return null;
  const { system, chatMsgs } = toOAIChat(messages);
  const oaiTools = oaiToolsOf(gDecls);
  const baseMsgs = system ? [{ role: "system", content: system }, ...chatMsgs] : chatMsgs;
  let lastErr = null;
  for (const key of keyList) {
    for (const model of OPENROUTER_MODELS) {
      try {
        const p = { model, messages: baseMsgs, max_tokens: 4096 };
        if (onDelta) p.stream = true;
        if (oaiTools) p.tools = oaiTools;
        const res = await withTimeout(fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": "Bearer " + key,
            "HTTP-Referer": "https://clincoo.buzz",
            "X-Title": "Clincoo"
          },
          body: JSON.stringify(p)
        }), 45000, "OpenRouter");
        if (!res.ok) {
          lastErr = `OpenRouter ${model}: HTTP ${res.status}`;
          continue;
        }
        if (onDelta && res.body) {
          const st = await readOAICompatStream(res, onDelta);
          if (st.text || st.tcs.length) {
            if (st.tcs.length) {
              const nt = normStreamToolCalls(st.tcs);
              if (nt.length) return { tool_calls: nt, text: st.text, model: model.split("/").pop() + " (OpenRouter)" };
            }
            return { text: st.text, model: model.split("/").pop() + " (OpenRouter)" };
          }
        } else {
          const data = await res.json().catch(() => ({}));
          const msg = data && data.choices && data.choices[0] && data.choices[0].message;
          const text = (msg && msg.content) || "";
          const tcs = msg && Array.isArray(msg.tool_calls) ? msg.tool_calls : null;
          if (tcs && tcs.length) {
            const norm = [];
            for (const c of tcs) {
              let a = null;
              if (c && c.function && typeof c.function.arguments === "string") {
                try { a = JSON.parse(c.function.arguments); } catch {}
              }
              if (c && c.function && c.function.name) norm.push({ name: c.function.name, args: a || {} });
            }
            if (norm.length) return { tool_calls: norm, text, model: model.split("/").pop() + " (OpenRouter)" };
          }
          if (text) return { text, model: model.split("/").pop() + " (OpenRouter)" };
        }
      } catch (err) {
        lastErr = `OpenRouter ${model}: ${err && err.message}`;
      }
    }
  }
  return lastErr ? { error: lastErr } : null;
}

// ===== Fallback Provider 3: Cloudflare Workers AI =====
const WORKERS_AI_MODELS = [
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  "@cf/zai-org/glm-4.7-flash"
];

async function tryWorkersAIText(env, messages, onDelta) {
  if (!env || !env.AI) return null;
  const sys = messages.filter(m => m.role === "system").map(textOf).join("\n\n");
  const chatMsgs = messages.filter(m => m.role !== "system").map(m => ({ role: m.role, content: textOf(m) }));
  let lastErr = null;
  for (const model of WORKERS_AI_MODELS) {
    try {
      const payload = { messages: chatMsgs };
      if (sys) payload.system = sys;
      const res = await env.AI.run(model, payload);
      const raw = (res && (res.response || (typeof res === "string" ? res : ""))) || "";
      const text = raw || ((res && Array.isArray(res.choices) && res.choices[0] && res.choices[0].message && res.choices[0].message.content) || "");
      if (text) {
        if (onDelta) { try { onDelta(text); } catch {} }
        return { text, model: model.split("/").pop() + " (Workers AI)" };
      }
    } catch (e) {
      lastErr = `Workers AI ${model}: ${e && e.message}`;
    }
  }
  return lastErr ? { error: lastErr } : null;
}

// ===== Orkestrasi Unified Multi-Model Generation =====
async function executeAiGeneration({ env, mrKeys, geminiKeys, orKeys, messages, toolDecls, onDelta, usageAcc }) {
  let deltaSent = false;
  const wrappedDelta = onDelta ? (tx) => { deltaSent = true; onDelta(tx); } : null;
  let lastError = null;

  // 1. ModelRouter (Utama)
  if (mrKeys && mrKeys.length) {
    try {
      const r = await withTimeout(tryModelRouterText(mrKeys, messages, toolDecls, MODELROUTER_MODELS, wrappedDelta, usageAcc), MR_TIMEOUT_MS, "ModelRouter");
      if (r && !r.error) return r;
      if (r && r.error) lastError = r.error;
    } catch (e) { lastError = e.message; }
    if (deltaSent) return { error: lastError || "ModelRouter terputus saat streaming" };
  }

  // 2. Gemini (Fallback 1)
  if (geminiKeys && geminiKeys.length) {
    try {
      const r = await tryGeminiText(geminiKeys, messages, toolDecls, wrappedDelta);
      if (r && !r.error) return r;
      if (r && r.error) lastError = r.error;
    } catch (e) { lastError = e.message; }
    if (deltaSent) return { error: lastError || "Gemini terputus saat streaming" };
  }

  // 3. OpenRouter (Fallback 2)
  if (orKeys && orKeys.length) {
    try {
      const r = await tryOpenRouterText(orKeys, messages, toolDecls, wrappedDelta);
      if (r && !r.error) return r;
      if (r && r.error) lastError = r.error;
    } catch (e) { lastError = e.message; }
    if (deltaSent) return { error: lastError || "OpenRouter terputus saat streaming" };
  }

  // 4. Workers AI (Fallback 3)
  if (env && env.AI) {
    try {
      const r = await tryWorkersAIText(env, messages, wrappedDelta);
      if (r && !r.error) return r;
      if (r && r.error) lastError = r.error;
    } catch (e) { lastError = e.message; }
  }

  return { error: lastError || "Semua penyedia AI sedang gangguan" };
}

const QUOTA_MSG_DAILY = 'Kuota AI Clincoo hari ini sudah habis. Batas harian paket Anda tercapai — silakan coba lagi besok.';
const QUOTA_MSG_MONTHLY = 'Kuota AI Clincoo bulan ini sudah habis. Reset otomatis awal bulan depan — atau upgrade paket / beli Paket Kredit AI di menu Profil > Kredit AI.';

const TOPUP_URL = 'https://app.clincoo.buzz/akun/kredit/topup/';
const QUOTA_MSG_EMPTY = '⚡ Kuota pesanmu sudah habis.\nIngin tetap menggunakan Clincoo? Isi ulang saldo kredit-mu di sini\n\n' + TOPUP_URL;

const FALLBACK_LIMITS = { monthly: 50, daily: 10 };
const ADMIN_LIMITS = { monthly: 5000, daily: 500 };

async function aiLimits(env, user) {
  const isAdmin = ADMIN_EMAILS.has(user.email);
  try {
    const eff = await getEffectivePlanByUserKey(env.DB, user.key);
    const byPlan = PLAN_AI_LIMITS[eff.plan] || FALLBACK_LIMITS;
    if (isAdmin) return { monthly: Math.max(ADMIN_LIMITS.monthly, byPlan.monthly), daily: Math.max(ADMIN_LIMITS.daily, byPlan.daily) };
    return byPlan;
  } catch (e) {
    return isAdmin ? ADMIN_LIMITS : FALLBACK_LIMITS;
  }
}

async function resolveUser(env, request) {
  const token = getToken(request);
  if (!token) return null;
  try {
    await initAuthTables(env.DB);
    const u = await getUserByToken(env.DB, token);
    if (u) return { key: 'u' + u.id, email: String(u.email || '').toLowerCase(), name: String(u.name || '').trim() };
  } catch (e) {}
  return null;
}

async function quotaCheck(env, user, cost = 1) {
  const limits = await aiLimits(env, user);
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  const month = now.toISOString().slice(0, 7);
  try {
    await env.DB.prepare(
      'CREATE TABLE IF NOT EXISTS ai_quota (user_key TEXT, day TEXT, count INTEGER, PRIMARY KEY (user_key, day))'
    ).run();
    const rows = await env.DB.prepare(
      'SELECT day, count FROM ai_quota WHERE user_key = ? AND day IN (?, ?)'
    ).bind(user.key, day, month).all();
    let dayCount = 0, monthCount = 0;
    for (const r of rows.results || []) {
      if (r.day === day) dayCount = r.count;
      if (r.day === month) monthCount = r.count;
    }

    if (!ADMIN_EMAILS.has(user.email)) {
      const packs = await getActivePacks(env.DB, user.key);
      const balance = packs.reduce((a, p) => a + (p.credits_left || 0), 0);
      if (balance < 0.00001) {
        return { exceeded: true, scope: 'empty', balance: 0, count: monthCount, message: QUOTA_MSG_EMPTY };
      }
    }

    if (cost > limits.daily || cost > limits.monthly) {
      return { exceeded: true, scope: 'daily', limit: limits.daily, count: dayCount, message: QUOTA_MSG_DAILY };
    }
    // Kenaikan atomik: hanya naik bila hasilnya masih <= limit (tanpa baca-lalu-tulis)
    const upsert = (k, lim) => env.DB.prepare(
      'INSERT INTO ai_quota (user_key, day, count) VALUES (?, ?, ?) ' +
      'ON CONFLICT(user_key, day) DO UPDATE SET count = count + ? WHERE count + ? <= ?'
    ).bind(user.key, k, cost, cost, cost, lim).run();
    const rd = await upsert(day, limits.daily);
    if (!((rd.meta && rd.meta.changes) > 0)) {
      return { exceeded: true, scope: 'daily', limit: limits.daily, count: dayCount, message: QUOTA_MSG_DAILY };
    }
    const rm = await upsert(month, limits.monthly);
    if (!((rm.meta && rm.meta.changes) > 0)) {
      // batalkan kenaikan harian karena bulanan sudah penuh
      await env.DB.prepare('UPDATE ai_quota SET count = count - ? WHERE user_key = ? AND day = ?').bind(cost, user.key, day).run();
      return { exceeded: true, scope: 'monthly', limit: limits.monthly, count: monthCount, message: QUOTA_MSG_MONTHLY };
    }
    return { exceeded: false, limit: limits, limits, usedDay: dayCount, usedMonth: monthCount };
  } catch (e) {
    // fail-closed: bila DB bermasalah, jangan loloskan gratis
    return { exceeded: true, scope: 'error', error: true, count: 0 };
  }
}

function tokensOfChars(chars) { return Math.ceil((chars || 0) / 4); }
const KRED_PER_30K_GLM = 1.5;
function aiCostOf(model, outputChars, inputChars) {
  const per30k = KRED_PER_30K_GLM;
  const tokens = tokensOfChars(inputChars) + tokensOfChars(outputChars);
  const cost = (tokens / 30000) * per30k;
  return Math.max(0.01, Math.round(cost * 100) / 100);
}

function mrTokenCost(acc) {
  if (!acc) return null;
  const W = { 'glm-5.3-flash:mr': 1.5 };
  let used = false, total = 0;
  for (const k of Object.keys(acc)) {
    used = true;
    total += (W[k] != null ? W[k] : 1) * (acc[k] || 0);
  }
  if (!used) return null;
  if (total <= 0) return 0;
  return Math.max(0.01, Math.round(total / 30000 * 100) / 100);
}
async function chargeAiUsage(env, user, model, outputChars, inputChars, charge = true, costOverride = null) {
  if (!user || !user.key) return;
  try {
    const cost = (costOverride === null || costOverride === undefined) ? aiCostOf(model, outputChars, inputChars) : costOverride;

    if (!charge) {
      await env.DB.prepare(
        'CREATE TABLE IF NOT EXISTS ai_usage (user_key TEXT, ts INTEGER, model TEXT, out_chars INTEGER, cost INTEGER)'
      ).run();
      try { await env.DB.prepare('ALTER TABLE ai_usage ADD COLUMN in_chars INTEGER').run(); } catch (e) {}
      await env.DB.prepare(
        'INSERT INTO ai_usage (user_key, ts, model, out_chars, in_chars, cost) VALUES (?, ?, ?, ?, ?, ?)'
      ).bind(user.key, Date.now(), String(model || '').slice(0, 64), Math.max(0, outputChars | 0), Math.max(0, inputChars | 0), 0).run();
      return;
    }

    await env.DB.prepare(
      'CREATE TABLE IF NOT EXISTS ai_usage (user_key TEXT, ts INTEGER, model TEXT, out_chars INTEGER, cost INTEGER)'
    ).run();
    try { await env.DB.prepare('ALTER TABLE ai_usage ADD COLUMN in_chars INTEGER').run(); } catch (e) {}

    try { await consumePackCredit(env.DB, user.key, cost); } catch (e) {}
    await env.DB.prepare(
      'INSERT INTO ai_usage (user_key, ts, model, out_chars, in_chars, cost) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(user.key, Date.now(), String(model || '').slice(0, 64), Math.max(0, outputChars | 0), Math.max(0, inputChars | 0), cost).run();
  } catch (e) {  }
}

const WORKSPACE_FUNCTION_DECLARATIONS = [
  { name: 'list_items',
    description: 'Lihat daftar file & folder di dalam sebuah folder workspace Clincoo milik user. Gunakan ini untuk melihat isi workspace atau folder sebelum melakukan operasi lain.',
    parameters: { type: 'OBJECT', properties: { path: { type: 'STRING', description: 'Path folder. Contoh: "root" (folder utama), "js", "root/css/style". Default: root.' } } } },
  { name: 'read_file',
    description: 'Baca isi lengkap sebuah file di workspace. WAJIB dipakai sebelum mengedit file agar konten terbaru dan akurat.',
    parameters: { type: 'OBJECT', properties: { path: { type: 'STRING', description: 'Path file. Contoh: "index.html", "js/app.js", "root/style.css".' } }, required: ['path'] } },
  { name: 'write_file',
    description: 'Buat file baru di workspace atau timpa seluruh isi file yang sudah ada dengan konten baru. Folder induk dibuat otomatis jika belum ada.',
    parameters: { type: 'OBJECT', properties: { path: { type: 'STRING', description: 'Path file tujuan, contoh: "pages/about.html".' }, content: { type: 'STRING', description: 'Isi lengkap file yang akan ditulis (overwrite penuh).' } }, required: ['path', 'content'] } },
  { name: 'append_file',
    description: 'Tambahkan potongan isi di AKHIR file (file 50KB–200KB+ sampai ~1MB dalam 1 sesi): write_file bagian pertama, lalu append_file berulang (path sama, ±12.000–20.000 karakter per panggilan). done:true HANYA di potongan TERAKHIR. Jangan henti di tengah — lanjut sampai file utuh.',
    parameters: { type: 'OBJECT', properties: { path: { type: 'STRING', description: 'Path file yang sama dengan write_file pertama, contoh: "js/app.js".' }, content: { type: 'STRING', description: 'Potongan isi berikutnya, TANPA mengulang isi awal.' }, done: { type: 'BOOLEAN', description: 'true kalau ini potongan terakhir.' } }, required: ['path', 'content'] } },
  { name: 'create_folder',
    description: 'Buat folder baru (beserta folder induknya) di workspace.',
    parameters: { type: 'OBJECT', properties: { path: { type: 'STRING', description: 'Path folder, contoh: "assets/img".' } }, required: ['path'] } },
  { name: 'rename_item',
    description: 'Ubah nama file atau folder di workspace.',
    parameters: { type: 'OBJECT', properties: { path: { type: 'STRING', description: 'Path item yang di-rename, contoh: "old-name.html".' }, new_name: { type: 'STRING', description: 'Nama baru (tanpa path), contoh: "new-name.html".' } }, required: ['path', 'new_name'] } },
  { name: 'delete_item',
    description: 'Hapus file atau folder (beserta seluruh isinya) dari workspace. PERMANEN — konfirmasi dulu ke user kecuali user sudah jelas meminta penghapusan.',
    parameters: { type: 'OBJECT', properties: { path: { type: 'STRING', description: 'Path item yang akan dihapus.' } }, required: ['path'] } },
  { name: 'search_items',
    description: 'Cari file atau folder di seluruh workspace berdasarkan nama.',
    parameters: { type: 'OBJECT', properties: { query: { type: 'STRING', description: 'Kata kunci nama file/folder.' } }, required: ['query'] } },

  { name: 'run_command',
    description: 'Jalankan perintah di TERMINAL LINUX persisten milik user (sandbox E2B terisolasi, ada internet). Sesi bertahan ±10 menit antar-command: file yang dibuat, tool yang di-install (apt-get install, pip install, npm), dan working directory TETAP ADA sampai sesi habis. Bisa: perintah Linux umum (ls, grep, awk, curl, ping, whois, dig), install & jalankan tool tambahan (nmap, sqlmap, netcat, jq, ffmpeg, dll), fetch API eksternal dengan header/secret yang USER berikan di command (curl -H "Authorization: Bearer ..."), download file (wget), compile kode (gcc/python/node), dsb. Sandbox TIDAK melihat file workspace atau secret platform Clincoo — jika kode butuh isi file, tulis/tempel isinya langsung. Gunakan hanya untuk aksi terminal yang diminta user atau yang benar-benar dibutuhkan. DILARANG memakai run_command untuk memanggil API Clincoo sendiri (app.clincoo.buzz/api/* termasuk /api/pay) atau API gateway pembayaran (Pakasir/BuatQris dkk) — SEMUA operasi Clincoo wajib lewat tool resmi (mis. clincoo_pay untuk pembayaran); bila tool gagal, laporkan errornya, jangan improvisasi manual via terminal.',
    parameters: { type: 'OBJECT', properties: {
      command: { type: 'STRING', description: 'Perintah bash/CLI lengkap, contoh: "curl -s https://api.contoh.com", "apt-get install -y nmap && nmap -v target", "python3 -c \'print(2+2)\'".' },
      reset: { type: 'BOOLEAN', description: 'true untuk MULAI SESI BARU (buang semua file & instalasi, Linux bersih). Pakai saat user minta reset/terminal baru, atau saat instalasi korupt.' }
    }, required: ['command'] } },
  { name: 'read_web_page',
    description: 'Baca konten sebuah halaman web (URL) dan ubah jadi teks markdown yang bisa dibaca. Gunakan untuk membaca dokumentasi, artikel, atau halaman apapun yang user sebutkan.',
    parameters: { type: 'OBJECT', properties: { url: { type: 'STRING', description: 'URL lengkap halaman, contoh: "https://contoh.com/docs".' } }, required: ['url'] } },
  { name: 'web_search',
    description: 'Cari informasi terbaru di web (search engine). Gunakan untuk pertanyaan yang butuh data real-time atau terkini: harga, berita, dokumentasi versi baru, dll.',
    parameters: { type: 'OBJECT', properties: { query: { type: 'STRING', description: 'Kata kunci pencarian.' } }, required: ['query'] } },
  { name: 'rename_project',
    description: 'Ganti nama (judul) proyek Clincoo yang sedang aktif di percakapan ini.',
    parameters: { type: 'OBJECT', properties: { new_name: { type: 'STRING', description: 'Nama baru proyek.' } }, required: ['new_name'] } },
  { name: 'set_project_info',
    description: 'Simpan "Nama Aplikasi" & "Deskripsi" proyek aktif ke halaman Pengaturan Umum Clincoo (identitas yang tampil di kartu & daftar proyek). WAJIB dipanggil setelah selesai membangun situs/aplikasi baru: isi dengan nama aplikasi yang tepat dari pembahasan (BUKAN potongan awal chat) + deskripsi singkat 1 kalimat.',
    parameters: { type: 'OBJECT', properties: { app_name: { type: 'STRING', description: 'Nama aplikasi yang tepat, ringkas & manusiawi (mis. "Kedai Kopi Senja").' }, app_desc: { type: 'STRING', description: 'Deskripsi singkat 1 kalimat tentang aplikasinya.' }, app_logo: { type: 'STRING', description: 'Opsional. Nama file gambar di workspace (mis. "logo.png") untuk dipasang sebagai logo & favicon aplikasi di Pengaturan Umum.' } }, required: ['app_name'] } },
  { name: 'generate_image',
    description: 'Buat gambar AI baru (PNG) langsung di workspace proyek — logo, ilustrasi, hero, ikon. Pakai saat user minta dibuatkan gambar/logo, atau situs butuh visual yang tidak ada di web. set_as_logo: true otomatis memasangnya sebagai logo & favicon di Pengaturan Umum.',
    parameters: { type: 'OBJECT', properties: {
      prompt: { type: 'STRING', description: 'Deskripsi gambar yang diinginkan, detail & spesifik (subjek, gaya, warna).' },
      filename: { type: 'STRING', description: 'Opsional. Nama file tujuan, contoh: "images/hero.png". Default otomatis.' },
      set_as_logo: { type: 'BOOLEAN', description: 'true = pasang sebagai logo aplikasi di Pengaturan Umum (jadi logo & favicon situs, aktif pada deploy berikutnya).' }
    }, required: ['prompt'] } },
  { name: 'deploy_project',
    description: 'Publish / deploy proyek yang sedang aktif ke internet (Cloudflare Pages) sehingga situsnya live. Gunakan saat user minta deploy, publish, atau membuat situsnya online.',
    parameters: { type: 'OBJECT', properties: {} } },
  { name: 'create_automation',
    description: 'Pasang otomasi/tugas terjadwal baru milik user (tampil di halaman Tugas Terjadwal Clincoo) — AI menjalankan prompt-nya otomatis sesuai jadwal. Gunakan saat user minta buat otomasi, scheduled task, atau tugas berkala, contoh: "setiap hari jam 9 pagi rangkum berita tech" atau "tiap 30 menit cek harga".',
    parameters: { type: 'OBJECT', properties: {
      name: { type: 'STRING', description: 'Nama tugas, contoh: "Ringkasan Berita Harian".' },
      prompt: { type: 'STRING', description: 'Prompt lengkap yang dijalankan AI otomatis sesuai jadwal.' },
      schedule_type: { type: 'STRING', description: 'Jenis jadwal: "daily" (setiap hari pada jam tertentu WIB) atau "interval_minutes" (berulang tiap N menit). Default "daily".' },
      time_wib: { type: 'STRING', description: 'Jam eksekusi WIB format "HH:MM", contoh "09:00". WAJIB jika schedule_type daily.' },
      interval_minutes: { type: 'NUMBER', description: 'Interval eksekusi dalam menit 5-1440, contoh 15 atau 30. Untuk schedule_type interval_minutes.' },
      notify_email: { type: 'BOOLEAN', description: 'true jika hasil eksekusi dikirim ke email user. Default false.' }
    }, required: ['name', 'prompt'] } },
  { name: 'add_env_var',
    description: 'Tambah atau perbarui environment variable (key=value) milik proyek aktif — contoh API key atau konfigurasi situs.',
    parameters: { type: 'OBJECT', properties: { key: { type: 'STRING', description: 'Nama variable, contoh: "STRIPE_KEY".' }, value: { type: 'STRING', description: 'Nilai variable.' }, is_secret: { type: 'BOOLEAN', description: 'true jika sensitif (disembunyikan). Default false.' } }, required: ['key', 'value'] } },
  { name: 'list_env_vars',
    description: 'Lihat daftar environment variable milik proyek aktif (nilai secret ditampilkan tersembunyi).',
    parameters: { type: 'OBJECT', properties: {} } },
  { name: 'test_secret',
    description: 'Uji status & validitas secret / API key milik user SECARA LANGSUNG (tanpa menyimpan). Dukungan: cloudflare (verify token + info akun), resend, github, openai, openrouter. Gunakan saat user memberi secret dan minta dicek aktif/tidak, izin apa saja, atau kadaluarsa kapan. WAJIB: jangan pernah menampilkan nilai secret mentah di jawaban — tampilkan versi tersamarkan (mis. "ab12…ef90") saja.',
    parameters: { type: 'OBJECT', properties: { provider: { type: 'STRING', description: 'Nama provider: cloudflare, resend, github, openai, atau openrouter.' }, secret: { type: 'STRING', description: 'Nilai secret/API key yang diuji.' } }, required: ['provider', 'secret'] } },
  { name: 'cloudflare_request',
    description: 'Akses Cloudflare API memakai API token milik USER (izin mengikuti token itu persis). Path API relatif dari https://api.cloudflare.com/client/v4, contoh: /user/tokens/verify, /accounts, /zones, /accounts/<account_id>/d1/database, /accounts/<account_id>/pages/projects. Gunakan untuk operasi yang user izinkan lewat token-nya: buat/kelola D1 database, list/detail Pages, DNS record, workers, dsb. WAJIB: gunakan token hanya untuk request yang diminta user; JANGAN pernah menyimpan, mencatat, atau menampilkan token; jangan menuliskannya ke file proyek atau env var.',
    parameters: { type: 'OBJECT', properties: { secret: { type: 'STRING', description: 'API token Cloudflare milik user.' }, method: { type: 'STRING', description: 'HTTP method: GET, POST, PUT, PATCH, atau DELETE. Default GET.' }, path: { type: 'STRING', description: 'Path API Cloudflare, contoh: "/accounts/<id>/d1/database".' }, body: { type: 'OBJECT', description: 'Body JSON untuk POST/PUT/PATCH (opsional).' } }, required: ['secret', 'path'] } },
  { name: 'github_request',
    description: 'Akses GitHub API lewat KONEKTOR GitHub user (token OAuth otomatis dari halaman Integrasi Clincoo — JANGAN minta user menempel token manual). Contoh path: /user (profil), /user/repos (daftar repo), /repos/{owner}/{repo} (GET detail, POST buat repo), /repos/{owner}/{repo}/contents/{path} (GET baca file; PUT commit dengan body {message, content base64, sha bila file sudah ada}), /search/repositories?q= (cari repo). Gunakan untuk aksi GitHub yang diminta user: lihat repo, baca/kirim file, buat repo, dsb. Jika GitHub belum terhubung, minta user membuka halaman Integrasi Clincoo dulu.',
    parameters: { type: 'OBJECT', properties: { method: { type: 'STRING', description: 'HTTP method: GET, POST, PUT, PATCH, atau DELETE. Default GET.' }, path: { type: 'STRING', description: 'Path API GitHub, contoh: "/user/repos" atau "/repos/owner/repo/contents/index.html".' }, body: { type: 'OBJECT', description: 'Body JSON untuk POST/PUT/PATCH (opsional).' } }, required: ['path'] } },
  { name: 'drive_request',
    description: 'Akses Google Drive milik user lewat KONEKTOR Drive Clincoo (token OAuth otomatis dari halaman Plugin — JANGAN minta user menempel token manual). Path API relatif dari https://www.googleapis.com. Contoh: /drive/v3/about?fields=user (info akun), /drive/v3/files?pageSize=20&fields=files(id,name,mimeType,modifiedTime,size) (daftar file; tambahkan q= untuk filter mis. q=name%20contains%20%27laporan%27), /drive/v3/files/{fileId} (metadata file), /drive/v3/files/{fileId}?alt=media (unduh isi file — hanya file teks/kecil yang berguna di chat), POST /drive/v3/files dengan body {name, mimeType} (buat file/folder: mimeType application/vnd.google-apps.folder untuk folder), POST /upload/drive/v3/files?uploadType=media (unggah isi file: gunakan raw_body + content_type, dan path ?uploadType=media). Gunakan untuk aksi Drive yang diminta user: cari/daftar file, baca isi file, buat file atau folder, dsb. Jika Drive belum terhubung, minta user membuka halaman Plugin Clincoo dulu. Jika hasilnya success:false, sampaikan alasan aslinya.',
    parameters: { type: 'OBJECT', properties: { method: { type: 'STRING', description: 'HTTP method: GET, POST, PUT, PATCH, atau DELETE. Default GET.' }, path: { type: 'STRING', description: 'Path API Drive, contoh: "/drive/v3/files?pageSize=20".' }, body: { type: 'OBJECT', description: 'Body JSON untuk POST/PUT/PATCH (opsional), contoh metadata file {name, mimeType}.' }, raw_body: { type: 'STRING', description: 'Isi mentah file untuk upload (uploadType=media) — string polos, bukan JSON.' }, content_type: { type: 'STRING', description: 'Content-Type file yang diunggah, contoh "text/plain" atau "text/html".' } }, required: ['path'] } },
  { name: 'calendar_request',
    description: 'Akses Google Calendar milik user lewat KONEKTOR Calendar Clincoo (token OAuth otomatis dari halaman Plugin — JANGAN minta user menempel token manual). Path API relatif dari https://www.googleapis.com. Contoh: /calendar/v3/calendars/primary?fields=summary,id (info kalender utama), /calendar/v3/calendars/primary/events?singleEvents=true&orderBy=startTime&timeMin=2026-01-01T00:00:00Z&timeMax=2026-01-31T23:59:59Z (daftar event pada rentang waktu — timeMin/timeMax format ISO 8601 — WAJIB diisi agar hanya event dalam rentang itu yang dikembalikan), POST /calendar/v3/calendars/primary/events dengan body {summary, start:{dateTime,timeZone}, end:{dateTime,timeZone}} (buat event; dateTime format ISO 8601 mis. 2026-09-24T14:00:00, timeZone contoh Asia/Jakarta), PATCH /calendar/v3/calendars/primary/events/{eventId} (ubah event), DELETE .../events/{eventId} (hapus event). Gunakan untuk aksi kalender yang diminta user: cek jadwal/agenda hari ini atau tanggal tertentu, buat/ubah/hapus event, cari event dengan q=. Jika Calendar belum terhubung, minta user membuka halaman Plugin Clincoo dulu. Jika hasilnya success:false, sampaikan alasan aslinya.',
    parameters: { type: 'OBJECT', properties: { method: { type: 'STRING', description: 'HTTP method: GET, POST, PUT, PATCH, atau DELETE. Default GET.' }, path: { type: 'STRING', description: 'Path API Calendar, contoh: "/calendar/v3/calendars/primary/events?timeMin=...".' }, body: { type: 'OBJECT', description: 'Body JSON untuk POST/PUT/PATCH (opsional), contoh event {summary, start:{dateTime,timeZone}, end:{dateTime,timeZone}}.' } }, required: ['path'] } },
  { name: 'notion_request',
    description: 'Akses Notion milik user lewat KONEKTOR Notion Clincoo (token OAuth otomatis dari halaman Plugin — JANGAN minta user menempel token manual). Action: "search" (daftar halaman Notion yang dibagikan — gunakan juga untuk verifikasi koneksi), "read" (baca isi halaman; WAJIB kirim page_id dari hasil search), "create" (buat halaman baru; kirim title + markdown; halaman tujuan otomatis pakai pilihan user di halaman Plugin, atau kirim page_id dari search). Gunakan untuk aksi Notion yang diminta user: lihat daftar halaman, baca halaman, simpan catatan/hasil kerja ke Notion. Jika Notion belum terhubung, minta user membuka halaman Plugin Clincoo dulu. Jika hasilnya success:false, sampaikan alasan aslinya.',
    parameters: { type: 'OBJECT', properties: { action: { type: 'STRING', description: 'Salah satu: search, read, atau create.' }, page_id: { type: 'STRING', description: 'ID halaman (dari hasil search), untuk read atau create dengan tujuan tertentu.' }, title: { type: 'STRING', description: 'Judul halaman baru (untuk create).' }, markdown: { type: 'STRING', description: 'Isi halaman dalam format markdown (heading, list, kode) — dikonversi otomatis ke blok Notion (untuk create).' } }, required: ['action'] } },
  { name: 'search_clincoo_kb',
    description: 'Cari informasi RESMI tentang Clincoo (platformnya sendiri) di basis pengetahuan internal yang diindeks real-time dari dokumentasi resmi docs.clincoo.buzz — founder, visi, fitur produk, editor, AI, template, deploy, saldo, kebijakan/privasi, tips, dll. WAJIB dipanggil untuk pertanyaan tentang Clincoo sebagai produk/perusahaan (siapa pembuatnya, bagaimana cara pakai fitur X, kebijakan apa saja) — hasilnya adalah sumber kebenaran resmi, jangan mengarang. TIDAK untuk mencari info di web umum (pakai web_search) atau membaca file workspace.',
    parameters: { type: 'OBJECT', properties: { query: { type: 'STRING', description: 'Pertanyaan atau kata kunci tentang Clincoo, contoh: "siapa pendiri clincoo", "cara deploy situs", "kebijakan privasi data".' } }, required: ['query'] } },
  { name: 'install_automation',
    description: 'Pasang otomatisasi (tugas terjadwal AI) ke akun user — otomatis muncul real-time di halaman Akun > Tugas Terjadwal. Gunakan saat user minta pengingat/otomatisasi berulang: "ingatkan aku tiap pagi", "kirim ringkasan tiap hari jam 8", "cek X tiap 30 menit", dsb. Prompt tugas WAJIB detail & mandiri (AI penjadwal hanya melihat prompt itu, bukan percakapan ini).',
    parameters: { type: 'OBJECT', properties: {
      name: { type: 'STRING', description: 'Nama tugas singkat & jelas, contoh: "Ringkasan berita pagi".' },
      schedule_type: { type: 'STRING', description: '"daily" (sekali sehari pada time_wib) atau "interval_minutes" (berulang tiap N menit).' },
      time_wib: { type: 'STRING', description: 'Jam harian HH:MM WIB untuk schedule_type daily, contoh "08:00".' },
      interval_minutes: { type: 'NUMBER', description: 'Interval menit untuk schedule_type interval_minutes (5-1440), contoh 30.' },
      prompt: { type: 'STRING', description: 'Instruksi lengkap yang dijalankan AI penjadwal pada waktunya — tulis detail, mandiri, dengan sumber data yang jelas (mis. "Cari 5 berita teknologi terbaru hari ini di web, rangkum dalam 5 poin singkat").' },
      notify_email: { type: 'BOOLEAN', description: 'true bila hasil juga dikirim ke email user.' }
    }, required: ['name', 'schedule_type', 'prompt'] } },
  { name: 'clincoo_pay',
    description: 'SEKALI JALAN terima pembayaran di situs Clincoo via ClincooPay (QRIS bawaan, tanpa gateway eksternal). PAKAI INI DULU setiap user ingin situsnya bisa menerima pembayaran/checkout/QRIS/bayar — lewati HANYA bila user EKSPLISIT minta gateway luar (Xendit/Midtrans/DOKU/Pakasir dll. dengan API key sendiri). JANGAN bikin backend function atau halaman bayar sendiri untuk kasus ini — selesaikan langsung dengan tool ini lalu BERIKAN checkout_url ke user di jawaban yang sama. Actions: "config" (cek status aktifasi + pay_key + saldo proyek aktif), "activate" (aktifkan ClincooPay proyek aktif, butuh login Clincoo), "create" (buat order QRIS — respons berisi checkout_url, order_id, total_payment; TUNJUKKAN checkout_url SEGERA — checkout_url ADALAH SATU-SATUNYA link bayar untuk user: DILARANG memberikan link gateway mentah seperti pakasir.zone.id/buatqris atau qr_image/qr_string/payment_url sebagai link bayar ke user), "status" (cek order sudah dibayar/belum). ALUR KILAT 1 GILIRAN: config -> bila belum aktif: activate -> create(amount, description) -> kasih checkout_url. amount = rupiah integer minimum 1000. Bila nominal belum disebut user, pakai nominal contoh untuk demo dan jelaskan ganti nominal tinggal create ulang.',
    parameters: { type: 'OBJECT', properties: {
      action: { type: 'STRING', description: 'Salah satu: config, activate, create, status.' },
      amount: { type: 'NUMBER', description: 'create: nominal rupiah integer, minimum 1000.' },
      description: { type: 'STRING', description: 'create opsional: keterangan order, contoh "Paket A".' },
      order_id: { type: 'STRING', description: 'status: id order dari hasil create.' },
      key: { type: 'STRING', description: 'pay_key proyek — diisi otomatis dari config bila kosong.' }
    }, required: ['action'] } },
  { name: 'manage_domain',
    description: 'Kelola domain kustom + DNS proyek AKTIF (halaman Fitur Domain / Domain Kustom). Action: "status" (daftar domain terpasang + record DNS yang harus disetel), "add" (pasang domain kustom ke situs — domain harus sudah dimiliki user), "remove" (lepas domain dari situs), "dns_status" (cek zona DNS + record yang ada untuk domain), "set_dns" (SETEL LANGSUNG record CNAME domain -> <proyek>.pages.dev di Cloudflare — pakai ini saat user minta AI mengatur DNS domainnya; konflik A/AAAA lama otomatis dibersihkan), "delete_dns" (hapus record DNS domain). Alur lengkap pindah domain: set_dns dulu, lalu add. Zona DNS harus ada di akun Cloudflare yang tersimpan di Pengaturan Deploy; bila domainnya di provider lain, jelaskan record manualnya (CNAME -> <proyek>.pages.dev). HANYA untuk domain kustom SITUS PROYEK — bila user bicara tentang halaman Domain Clincoo (/domain/, Kelola DNS), pakai tool domain_dns.',
    parameters: { type: 'OBJECT', properties: {
      action: { type: 'STRING', description: 'Salah satu: status, add, remove, dns_status, set_dns, delete_dns.' },
      domain: { type: 'STRING', description: 'Nama domain, contoh "tokosaya.com" atau "www.tokosaya.com".' }
    }, required: ['action'] } },
  { name: 'domain_dns',
    description: 'Kelola record DNS di halaman Domain Clincoo (/domain/ — Kelola DNS; backend terpisah dari domain kustom proyek). Action: "list" (daftar domain user di halaman Domain + statusnya), "records" (lihat semua record DNS domain — tandai managed/zone_status), "add" (tambah record A/AAAA/CNAME/TXT/MX), "delete" (hapus record berdasarkan record_id dari action records). Bila respons menyebut managed=false/local, domain tidak dikelola jaringan Clincoo: record hanya tersimpan di Clincoo sebagai catatan — ingatkan user untuk menyalinnya ke penyedia DNS domain agar aktif.',
    parameters: { type: 'OBJECT', properties: {
      action: { type: 'STRING', description: 'Salah satu: list, records, add, delete.' },
      domain: { type: 'STRING', description: 'Nama domain, contoh "tokosaya.com". Wajib untuk records/add/delete.' },
      type: { type: 'STRING', description: 'add: salah satu A, AAAA, CNAME, TXT, MX.' },
      name: { type: 'STRING', description: 'add: host/nama record, contoh "@" (root), "www", "mail".' },
      content: { type: 'STRING', description: 'add: nilai record — IP untuk A/AAAA, target host untuk CNAME, teks untuk TXT, host mail untuk MX.' },
      ttl: { type: 'NUMBER', description: 'add opsional: TTL dalam detik.' },
      proxied: { type: 'BOOLEAN', description: 'add opsional (A/AAAA/CNAME): aktifkan proxy Cloudflare.' },
      priority: { type: 'NUMBER', description: 'add untuk MX opsional: prioritas (default 10).' },
      record_id: { type: 'STRING', description: 'delete: id record dari action records.' }
    }, required: ['action'] } },
  { name: 'build_apk',
    description: 'Buat file APK Android dari sebuah website/aplikasi web yang sudah live (fondasi PressForge — build di GitHub Actions, butuh konektor GitHub terhubung). WAJIB dipakai setiap kali user minta "jadikan APK", "bikin aplikasi Android dari situs ini", "convert ke APK", dsb. ALUR WAJIB (langkah KECIL terpisah satu-satu — JANGAN tumpuk semua pertanyaan jadi satu kartu besar): (1) LOGO — bila belum ditentukan user, WAJIB tulis dulu SATU kalimat singkat natural menyapa/menanyakan logo (mis. "Oke, mau pakai logo khusus buat aplikasinya? Klik bulatan di bawah ya, atau lewati kalau mau pakai ikon default.") — JANGAN PERNAH kirim blok [[APK_LOGO]] tanpa teks apa pun di depannya, bubble kosong bikin bingung — baru setelah kalimat itu keluarkan blok [[APK_LOGO]][[/APK_LOGO]] (penanda saja, tanpa isi), lalu BERHENTI SEPENUHNYA (persis aturan [[POLL]]) — elemen flat sentris kecil (ikon bulat klik-untuk-unggah di tengah + tautan "Lewati" di bawahnya, TANPA kotak/card) dirender otomatis tepat di bawah kalimatmu; jawaban ("Logo tersimpan..." atau "Lewati logo...") terkirim otomatis ke chat begitu user memilih. (2) NAMA — setelah logo terjawab dan nama APLIKASI belum diketahui, JANGAN pakai kartu/marker apa pun: tanyakan dengan TEKS BIASA singkat (mis. "Nama aplikasinya apa?") lalu berhenti menunggu balasan teks biasa dari user di giliran berikutnya. (3) PENGATURAN — setelah nama diketahui, bila orientasi/fullscreen/splash belum ditentukan, tanyakan lewat [[POLL]] standar (format Q:/A:/B:/C biasa, maksimal dalam satu blok): "Orientasi aplikasi?" (Berdiri/Tiduran), "Mode tampilan?" (Fullscreen/Normal dengan status bar), dan bila relevan "Splash logo Clincoo saat dibuka?" (Aktif/Nonaktif) — lalu BERHENTI menunggu jawaban poll (server tetap pemutus akhir utk splash paket gratis, jadi aman ditanya ke semua paket). (4) Setelah logo+nama+pengaturan lengkap, panggil action "start" dengan: url WAJIB http/https (situs harus sudah live — deploy dulu dengan deploy_project bila belum), app_name, orientation, fullscreen, splash, dan icon: "saved" bila user mengunggah logo di langkah (1) (logo diambil otomatis dari sana; jangan minta user menempel logo manual). (5) Setelah start sukses, beri penjelasan singkat lalu keluarkan blok [[APK_CARD]] dengan baris "ID: <build_id>", "NAME: <nama aplikasi>", "URL: <url situs>", tutup [[/APK_CARD]] — kartu progres ini TIDAK berubah, tetap seperti biasa: memantau progres build REAL-TIME sendiri (progress bar, status) dan tombol Unduh APK muncul otomatis saat selesai; JANGAN panggil action status berkali-kali untuk menunggu (kartu sudah memantau). PENTING (bug nyata yang pernah terjadi): JANGAN PERNAH menyalin/menampilkan field hasil tool action start sebagai daftar/bullet/tabel ke user (mis. "Build ID: ...", "Package: ...", "Orientasi: ...", "Paket: ..." ) — balasanmu HANYA boleh berupa maks satu-dua kalimat natural singkat (sampaikan hal penting saja, mis. splash dipaksa aktif) langsung diikuti blok [[APK_CARD]], TIDAK ADA list/bullet/field lain apa pun sebelum atau sesudahnya. (6) Splash screen logo Clincoo (logo saja, tanpa teks) otomatis dipaksa aktif untuk paket gratis apa pun pilihan user di poll — diputuskan server, sampaikan singkat bila respons start menyebut splash:true meski user pilih nonaktif (ikon aplikasi tetap milik user). Respons TIDAK memuat link repo GitHub — jangan mencari atau menampilkan alamat repo/sumbunya ke user. Bila success:false, sampaikan error aslinya.',
    parameters: { type: 'OBJECT', properties: {
      action: { type: 'STRING', description: 'Salah satu: start (mulai build), status (cek progres — jarang perlu, kartu [[APK_CARD]] sudah real-time), download (kirim APK ke user — kartu lakukan otomatis).' },
      url: { type: 'STRING', description: 'start: URL lengkap website, contoh "https://app.clincoo.buzz".' },
      app_name: { type: 'STRING', description: 'start: nama aplikasi (maks 40 karakter, default dari domain).' },
      package_id: { type: 'STRING', description: 'start opsional: package Android, contoh "com.tokosaya.app" (default otomatis).' },
      orientation: { type: 'STRING', description: 'start: "portrait" (berdiri) atau "landscape" (tiduran) — dari kartu setup user.' },
      fullscreen: { type: 'BOOLEAN', description: 'start: true = mode fullscreen — dari kartu setup user.' },
      icon: { type: 'STRING', description: 'start: kirim "saved" bila user mengunggah logo lewat kartu setup (diambil otomatis).' },
      splash: { type: 'BOOLEAN', description: 'start: splash screen logo Clincoo di aplikasi — sesuai toggle di kartu setup user. Paket gratis (Starter): SELALU aktif apa pun nilainya (server memutuskan). Paket berbayar: aktif hanya bila splash true.' },
      build_id: { type: 'STRING', description: 'status/download: id build dari hasil start.' }
    }, required: ['action'] } },
  { name: 'write_files',
    description: 'Tulis BEBERAPA file KECIL sekaligus ke workspace (bulk write): satu panggilan berisi array files [{path, content}]. BATAS KERAS: total isi SEMUA file dalam satu panggilan harus muat di sekitar 1500 token (kira-kira 4000 karakter) — jika lebih, panggilan TERPOTONG dan gagal "Parameter files wajib array". Cocok HANYA untuk file kecil/config/salin (package.json, .env.example, README pendek, dll). Untuk HTML/CSS/JS halaman nyata, JANGAN pakai tool ini: panggil write_file SATU file per panggilan. Maks 60 file per panggilan. File tersimpan permanen (cloud) dan langsung bisa di-deploy.',
    parameters: { type: 'OBJECT', properties: {
      files: { type: 'ARRAY', description: 'Array file yang mau ditulis/salin.', items: { type: 'OBJECT', properties: {
        path: { type: 'STRING', description: 'Path file di workspace, contoh "assets/style.css".' },
        content: { type: 'STRING', description: 'Isi lengkap file siap jalan.' }
      }, required: ['path', 'content'] } }
    }, required: ['files'] } },
  { name: 'save_to_storage',
    description: 'Simpan/update file ke AI STORAGE milikmu sendiri (server Clincoo, per akun — BUKAN workspace proyek, BUKAN GitHub). Penyimpanan abadi antar sesi/chat, isi file TIDAK memakan token history: simpan sekali, lalu di giliran mana pun baca ulang hanya file yang perlu dengan read_storage_file. WAJIB dipakai untuk: hasil clone/fetch file dari sumber mana pun (GitHub, web) yang akan dipakai lagi nanti, file rujukan besar, atau kode sumber yang akan sering diubah atas perintah user. Upor path konsisten (mis. "repo/nama/file.ext").',
    parameters: { type: 'OBJECT', properties: {
      files: { type: 'ARRAY', description: 'Array file yang mau disimpan.', items: { type: 'OBJECT', properties: {
        path: { type: 'STRING', description: 'Path/identitas file, contoh "libs/jquery-3.7.js".' },
        content: { type: 'STRING', description: 'Isi file.' }
      }, required: ['path', 'content'] } }
    }, required: ['files'] } },
  { name: 'read_storage_file',
    description: 'Baca isi satu file dari AI STORAGE milikmu — jauh lebih hemat & cepat daripada re-clone atau membaca ulang dari history. Gunakan setiap kali akan mengubah/memakai file yang sudah tersimpan di storage.',
    parameters: { type: 'OBJECT', properties: {
      path: { type: 'STRING', description: 'Path file di storage, contoh "libs/jquery-3.7.js".' }
    }, required: ['path'] } },
  { name: 'list_storage',
    description: 'Lihat daftar file di AI STORAGE milikmu (path, ukuran, waktu update) — opsional filter prefix. Jalankan bila lupa path persis file yang tersimpan.',
    parameters: { type: 'OBJECT', properties: {
      prefix: { type: 'STRING', description: 'Filter path awalan (opsional).' }
    }, required: [] } },
  { name: 'delete_from_storage',
    description: 'Hapus satu file dari AI STORAGE milikmu. Batas: 500 file / 8MB total.',
    parameters: { type: 'OBJECT', properties: {
      path: { type: 'STRING', description: 'Path file yang dihapus.' }
    }, required: ['path'] } },
  { name: 'clone_repo',
    description: 'Salin (clone) seluruh isi repo GitHub ke folder workspace proyek aktif — data tersimpan permanen di workspace, lalu bisa diubah, dicari, di-deploy, atau di-push. Mendukung repo publik (tanpa perlu login GitHub) dan repo privat milik user (lewat konektor GitHub yang sudah terhubung di menu Integrasi). Batas: ±300 file teks per clone, file ≤256KB, binary besar dilewati otomatis. Pakai saat user minta "ambil/clone/copy repo X" atau "masukin kode dari repo X".',
    parameters: { type: 'OBJECT', properties: {
      repo: { type: 'STRING', description: 'Repo dalam bentuk "owner/nama" atau URL GitHub lengkap, contoh "tailwindlabs/heroicons".' },
      folder: { type: 'STRING', description: 'Folder tujuan di workspace (opsional, default: nama repo).' },
      ref: { type: 'STRING', description: 'Branch/tag/commit (opsional, default: branch utama repo).' },
      target: { type: 'STRING', description: '"workspace" (default: folder proyek aktif) atau "storage" (AI Storage milik AI, per akun — hemat token, tidak memakan kuota workspace).' }
    }, required: ['repo'] } },
  { name: 'clone_url',
    description: 'Salin (clone) file-file statis sebuah halaman situs dari sebuah URL — HTML utama (index.html) + file CSS & JS yang dirujuknya diunduh LANGSUNG KE ROOT workspace proyek aktif (asset di assets/, TANPA subfolder pembungkus dan TANPA halaman redirect/stub), gambar/font tetap dimuat dari server asal (URL-nya di-absolutkan otomatis). Pakai saat user minta "clone/copy situs ini", "ambil file2 dari URL ini", "jadikan ini bagian proyek", dsb. Batas: maks 40 file asset, tiap file ≤256KB, total ±2MB; HANYA file statis — situs yang isinya dirender JavaScript (SPA/React/Vue) atau butuh login tidak akan lengkap, sampaikan batasan itu bila user minta clone situs semacam itu. Untuk repo GitHub, pakai clone_repo (bukan tool ini).',
    parameters: { type: 'OBJECT', properties: {
      url: { type: 'STRING', description: 'URL halaman lengkap, contoh "https://example.com".' },
      folder: { type: 'STRING', description: 'Folder tujuan di workspace (opsional, default: nama host situs).' },
      target: { type: 'STRING', description: '"workspace" (default: folder proyek aktif) atau "storage" (AI Storage milik AI, per akun — hemat token).' }
    }, required: ['url'] } },
  { name: 'push_to_github',
    description: 'Push SEMUA file workspace proyek aktif ke repo GitHub user lewat konektor GitHub (commit file demi file via contents API, update otomatis bila file sudah ada). Repo bisa dibuat dulu lewat github_request (POST /user/repos body {name}) bila belum ada. Gunakan saat user minta "push/simpan/kirim kode ke GitHub saya".',
    parameters: { type: 'OBJECT', properties: {
      repo: { type: 'STRING', description: 'Repo tujuan "owner/nama" atau URL GitHub lengkap.' },
      branch: { type: 'STRING', description: 'Branch tujuan (opsional, default "main"). Repo harus sudah punya branch ini.' },
      commit_message: { type: 'STRING', description: 'Pesan commit (opsional).' }
    }, required: ['repo'] } },

  { name: 'db_list_tables',
    description: 'Lihat semua tabel di DATABASE proyek aktif (nama, kolom, jumlah baris). Gunakan saat user bertanya isi database-nya, atau sebelum membuat/mengubah tabel & baris.',
    parameters: { type: 'OBJECT', properties: {} } },
  { name: 'db_create_table',
    description: 'Buat tabel baru di DATABASE proyek aktif — tabel yang sama persis dengan halaman Database Clincoo (data permanen, bisa dibaca aplikasi user lewat API /v1/db). WAJIB dipakai saat user minta membuat tabel/database, mis. "buat tabel produk dengan kolom nama dan harga". Batas jumlah tabel mengikuti paket (Starter: 2 tabel).',
    parameters: { type: 'OBJECT', properties: {
      table_name: { type: 'STRING', description: 'Nama tabel, contoh: "produk".' },
      columns: { type: 'ARRAY', description: 'Definisi kolom tabel (minimal 1).', items: { type: 'OBJECT', properties: {
        name: { type: 'STRING', description: 'Nama kolom, contoh: "nama".' },
        type: { type: 'STRING', description: 'Tipe kolom: "text", "number", "boolean", atau "date".' }
      }, required: ['name', 'type'] } }
    }, required: ['table_name', 'columns'] } },
  { name: 'db_drop_table',
    description: 'Hapus tabel dari DATABASE proyek aktif beserta SELURUH barisnya. PERMANEN — konfirmasi dulu ke user kecuali user sudah jelas meminta penghapusan.',
    parameters: { type: 'OBJECT', properties: {
      table_name: { type: 'STRING', description: 'Nama tabel yang dihapus.' }
    }, required: ['table_name'] } },
  { name: 'db_add_row',
    description: 'Tambah satu baris data ke tabel di DATABASE proyek aktif. WAJIB saat user minta menambah/menyimpan data ke tabel, mis. "tambahkan produk kopi susu harga 15000". Kembalikan id baris baru ke user.',
    parameters: { type: 'OBJECT', properties: {
      table_name: { type: 'STRING', description: 'Nama tabel tujuan.' },
      data: { type: 'OBJECT', description: 'Objek pasangan kolom:nilai, contoh: {"nama": "Kopi Susu", "harga": 15000}. Hanya kolom yang ada di tabel.' }
    }, required: ['table_name', 'data'] } },
  { name: 'db_list_rows',
    description: 'Baca baris data dari tabel di DATABASE proyek aktif (terbaru dulu). Gunakan saat user minta melihat isi tabel, laporan, rekap, atau data tertentu.',
    parameters: { type: 'OBJECT', properties: {
      table_name: { type: 'STRING', description: 'Nama tabel.' },
      limit: { type: 'NUMBER', description: 'Jumlah baris per baca, 1-200. Default 50.' },
      offset: { type: 'NUMBER', description: 'Lewati N baris pertama (untuk paging). Default 0.' }
    }, required: ['table_name'] } },
  { name: 'db_update_row',
    description: 'Ubah nilai kolom pada satu baris (berdasarkan id) di tabel DATABASE proyek aktif. Gunakan saat user minta mengubah data, mis. "ubah harga produk id 3 jadi 20000".',
    parameters: { type: 'OBJECT', properties: {
      table_name: { type: 'STRING', description: 'Nama tabel.' },
      id: { type: 'NUMBER', description: 'ID baris yang diubah.' },
      data: { type: 'OBJECT', description: 'Pasangan kolom:nilai baru, contoh: {"harga": 20000}.' }
    }, required: ['table_name', 'id', 'data'] } },
  { name: 'db_delete_row',
    description: 'Hapus satu baris data dari tabel di DATABASE proyek aktif berdasarkan id. Konfirmasi dulu ke user kecuali user sudah jelas meminta penghapusan.',
    parameters: { type: 'OBJECT', properties: {
      table_name: { type: 'STRING', description: 'Nama tabel.' },
      id: { type: 'NUMBER', description: 'ID baris yang dihapus.' }
    }, required: ['table_name', 'id'] } },

  { name: 'create_backend_function',
    description: 'Buat backend function baru milik user (ala platform builder): tulis kode -> terpasang -> bisa dipanggil via URL /api/fn/<nama>. Kode adalah badan fungsi async dengan parameter `args` (objek), boleh pakai `fetch`, `JSON`, dan `db` (DATABASE BAWAAN: await db.get(k), db.set(k,v), db.del(k), db.list(prefix), db.count() — data bertahan permanen, kuota mengikuti paket langganan). WAJIB return nilai. Contoh kode: "await db.set(args.id, args); return { ok: true }". BATAS RUNTIME: eksekusi maksimal 14 detik per panggilan (lebih dari itu = timeout). Tiap db.get/db.set adalah network call yang lambat: DILARANG loop berurutan lebih dari 20 get dalam satu function — gunakan db.list(prefix) untuk membaca banyak data sekaligus, dan simpan index/agregat saat menulis data agar laporan cukup membaca 1-2 kunci saja. Untuk WEBHOOK PUBLIK (callback payment gateway Midtrans/Xendit/Tripay, layanan eksternal): set is_public true — respons berisi webhook_url berisi key rahasia yang WAJIB diberikan ke user untuk dipasang di dashboard gateway. Gunakan saat user minta API endpoint, webhook, payment backend, integrasi data, atau logika backend.',
    parameters: { type: 'OBJECT', properties: {
      name: { type: 'STRING', description: 'Nama function: huruf kecil/angka/garis tengah, 2-40 karakter, contoh: "payment-webhook".' },
      description: { type: 'STRING', description: 'Deskripsi singkat kegunaan function (bahasa Indonesia).' },
      code: { type: 'STRING', description: 'Badan fungsi async JavaScript (bukan deklarasi function). Parameter `args` objek input. Tersedia fetch, JSON, db. Wajib return nilai.' },
      is_public: { type: 'BOOLEAN', description: 'true jika function harus bisa dipanggil TANPA login sebagai webhook publik (callback gateway, integrasi eksternal). Respons berisi webhook_url + key rahasia.' }
    }, required: ['name', 'code'] } },
  { name: 'list_backend_functions',
    description: 'Lihat semua backend function milik user beserta URL pemanggilannya.',
    parameters: { type: 'OBJECT', properties: {} } },
  { name: 'delete_backend_function',
    description: 'Hapus backend function milik user. Konfirmasi dulu ke user sebelum menghapus.',
    parameters: { type: 'OBJECT', properties: { name: { type: 'STRING', description: 'Nama function yang dihapus.' } }, required: ['name'] } },
  { name: 'call_backend_function',
    description: 'Jalankan backend function milik user dengan args tertentu dan kembalikan hasilnya. Gunakan untuk menguji function yang baru dibuat.',
    parameters: { type: 'OBJECT', properties: {
      name: { type: 'STRING', description: 'Nama function.' },
      args: { type: 'OBJECT', description: 'Objek argumen input untuk function, contoh: {"url": "https://contoh.com"}.' }
    }, required: ['name'] } },

  { name: 'review_code',
    description: 'Periksa SEMUA kode proyek di workspace untuk menemukan error, bug, kelemahan keamanan, dan masalah logika — laporan per file dengan saran perbaikan. Gunakan saat user minta cek/review/debug/cari bug kode proyek.',
    parameters: { type: 'OBJECT', properties: { question: { type: 'STRING', description: 'Fokus review khusus (opsional), contoh: "kenapa tombol simpan tidak berfungsi".' } } } },
  { name: 'take_screenshot',
    description: 'Ambil screenshot halaman web dari sebuah URL dan kembalikan LINK gambar pratinjau yang bisa dibagikan ke user. Gunakan saat user minta screenshot/preview situs, baik situs user maupun situs lain.',
    parameters: { type: 'OBJECT', properties: {
      url: { type: 'STRING', description: 'URL lengkap halaman, contoh: "https://contoh.com".' },
      width: { type: 'NUMBER', description: 'Lebar gambar 400-1600 px. Default 1200.' }
    }, required: ['url'] } }
];

const GUEST_DAILY_LIMIT = 25;
async function guestQuotaCheck(env, guestKey) {
  const day = new Date().toISOString().slice(0, 10);
  try {
    await env.DB.prepare('CREATE TABLE IF NOT EXISTS ai_quota (user_key TEXT, day TEXT, count INTEGER, PRIMARY KEY (user_key, day))').run();
    // Atomik: naik hanya bila hasilnya masih <= limit; RETURNING kosong = sudah penuh
    const r = await env.DB.prepare(
      'INSERT INTO ai_quota (user_key, day, count) VALUES (?, ?, 1) ' +
      'ON CONFLICT(user_key, day) DO UPDATE SET count = count + 1 WHERE count + 1 <= ? RETURNING count'
    ).bind(guestKey, day, GUEST_DAILY_LIMIT).first();
    if (!r) {
      return { exceeded: true, scope: 'daily', count: GUEST_DAILY_LIMIT, message: 'Kuota AI Clincoo tanpa login untuk hari ini sudah habis. Masuk atau daftar gratis untuk kuota penuh — atau coba lagi besok.' };
    }
    const used = (r.count || 1) - 1;
    return { exceeded: false, count: used + 1, usedDay: used, limit: GUEST_DAILY_LIMIT };
  } catch (e) {
    // fail-closed
    return { exceeded: true, scope: 'error', error: true, count: 0 };
  }
}

const SERVER_TOOLS = new Set(['create_backend_function', 'list_backend_functions', 'delete_backend_function', 'call_backend_function', 'take_screenshot', 'search_clincoo_kb', 'create_automation', 'install_automation', 'save_to_storage', 'read_storage_file', 'list_storage', 'delete_from_storage']);

const SERVER_TOOLS_ALL = new Set([...SERVER_TOOLS, ...WS_TOOL_NAMES]);
async function executeServerTool(env, user, tc, origin, projectId) {

  if (tc && WS_TOOL_NAMES.indexOf(tc.name) !== -1) {
    return await wsToolExec(env.DB, user, String(projectId || ''), tc.name, tc.args || {});
  }

  if (tc && tc.name === 'create_automation') tc = Object.assign({}, tc, { name: 'install_automation' });
  const a = tc.args || {};

  if (!user && ['create_backend_function', 'list_backend_functions', 'delete_backend_function', 'call_backend_function', 'install_automation', 'save_to_storage', 'read_storage_file', 'list_storage', 'delete_from_storage'].indexOf(tc.name) !== -1) {
    return { error: 'Fitur ini memerlukan login Clincoo (gratis).' };
  }
  try {
    if (tc.name === 'search_clincoo_kb') {
      return await searchClincooBlog(env, a.query || '');
    }
    if (tc.name === 'install_automation') {
      const st = await import('./scheduled-tasks.js');
      return await st.createScheduledTask(env.DB, user, a);
    }
    if (tc.name === 'save_to_storage') return await aiStorageSave(env.DB, user, a.files || []);
    if (tc.name === 'read_storage_file') return await aiStorageGet(env.DB, user, a.path || '');
    if (tc.name === 'list_storage') return await aiStorageList(env.DB, user, a.prefix || '');
    if (tc.name === 'delete_from_storage') return await aiStorageDelete(env.DB, user, a.path || '');
    if (tc.name === 'take_screenshot') {
      const m = await import('./screenshot.js');
      return await m.takeScreenshot(a.url, a.width);
    }
    const m = await import('./fns.js');

    if (tc.name !== 'list_backend_functions') {
      const _effFns = await getEffectivePlanByUserKey(env.DB, user.key);
      if (!featureAllowed(_effFns.plan, 'backendFunctions')) return { error: 'Fitur ini hanya untuk paket Bisnis. Sampaikan ke user singkat bahwa fitur ini butuh upgrade paket Bisnis, lalu lanjutkan bangun bagian situs yang tidak butuh backend function.' };
    }
    if (tc.name === 'create_backend_function') return await m.createFunction(env.DB, user.key, a.name, a.description, a.code, { is_public: !!a.is_public, origin: origin || '' });
    if (tc.name === 'list_backend_functions') return await m.listFunctions(env.DB, user.key, origin || '');
    if (tc.name === 'delete_backend_function') return await m.deleteFunction(env.DB, user.key, a.name);
    if (tc.name === 'call_backend_function') return await m.invokeFunction(env.DB, user.key, a.name, a.args, { origin: origin || '' });
    return { error: 'Tool server tidak dikenal: ' + tc.name };
  } catch (e) {
    return { error: 'Gagal mengeksekusi tool server: ' + (e && e.message) };
  }
}

function orParam(schema) {
  const t = String((schema && schema.type) || '').toLowerCase();
  const out = { type: t === 'array' ? 'array' : t === 'boolean' ? 'boolean' : t === 'number' ? 'number' : t === 'object' ? 'object' : 'string' };
  if (schema && schema.description) out.description = schema.description;
  if (schema && schema.properties) {
    out.properties = {};
    for (const [k, v] of Object.entries(schema.properties)) out.properties[k] = orParam(v);
  }
  if (schema && Array.isArray(schema.required)) out.required = schema.required;
  if (schema && schema.items) out.items = orParam(schema.items);
  return out;
}

function workspaceDecls(_body) {
  return WORKSPACE_FUNCTION_DECLARATIONS;
}

async function logAiFailure(env, projectId, errText, mode) {
  try {
    if (!env || !env.DB) return;
    const db = env.DB;
    await db.prepare('CREATE TABLE IF NOT EXISTS ai_router_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT, ts TEXT, model TEXT, ok INTEGER, ms INTEGER, tokens INTEGER, err TEXT)').run();
    await db.prepare('INSERT INTO ai_router_logs (project_id, ts, model, ok, ms, tokens, err) VALUES (?, ?, ?, 0, 0, 0, ?)')
      .bind(String(projectId || '-'), new Date().toISOString(), String(mode || 'ai').slice(0, 60), String(errText || '(tanpa pesan)').slice(0, 240)).run();

    await db.prepare('DELETE FROM ai_router_logs WHERE id NOT IN (SELECT id FROM (SELECT id FROM ai_router_logs ORDER BY id DESC LIMIT 500))').run();
  } catch (e) {}
}

export async function onRequestGet({ request, env }) {
  try {
    const user = await resolveUser(env, request);
    if (!user) {
      return new Response(JSON.stringify({ error: 'Login diperlukan', need_login: true }), {
        status: 401, headers: { 'Content-Type': 'application/json', ...CORS }
      });
    }

    if (new URL(request.url).searchParams.get('usage') === '1') {
      const limit = Math.min(200, Math.max(1, Number(new URL(request.url).searchParams.get('limit')) || 50));
      try {
        await env.DB.prepare('CREATE TABLE IF NOT EXISTS ai_usage (user_key TEXT, ts INTEGER, model TEXT, out_chars INTEGER, cost INTEGER)').run();
        const rows = await env.DB.prepare(
          'SELECT ts, model, out_chars, cost FROM ai_usage WHERE user_key = ? ORDER BY ts DESC LIMIT ?'
        ).bind(user.key, limit).all();
        return new Response(JSON.stringify({ success: true, usage: rows.results || [] }), {
          headers: { 'Content-Type': 'application/json', ...CORS }
        });
      } catch (e) {
        return new Response(JSON.stringify({ success: true, usage: [] }), {
          headers: { 'Content-Type': 'application/json', ...CORS }
        });
      }
    }
    const limits = await aiLimits(env, user);
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    const month = now.toISOString().slice(0, 7);
    let dayUsed = 0, monthUsed = 0;
    try {
      await env.DB.prepare(
        'CREATE TABLE IF NOT EXISTS ai_quota (user_key TEXT, day TEXT, count INTEGER, PRIMARY KEY (user_key, day))'
      ).run();
      const rows = await env.DB.prepare('SELECT day, count FROM ai_quota WHERE user_key = ? AND day IN (?, ?)').bind(user.key, day, month).all();
      for (const r of rows.results || []) {
        if (r.day === day) dayUsed = r.count;
        if (r.day === month) monthUsed = r.count;
      }
    } catch (e) {}
    let creditsLeftTotal = 0;
    try {
      const active = await getActivePacks(env.DB, user.key);
      creditsLeftTotal = active.reduce((s, p) => s + (p.credits_left || 0), 0);
    } catch (e) {}
    const subscriptionExhausted = monthUsed >= limits.monthly || dayUsed >= limits.daily;
    const isAdmin = ADMIN_EMAILS.has(user.email);

    const exhausted = isAdmin ? subscriptionExhausted : (creditsLeftTotal <= 0 || subscriptionExhausted);
    return new Response(JSON.stringify({
      success: true,
      limit: limits.daily, used: dayUsed, remaining: Math.max(0, limits.daily - dayUsed), day,
      monthly_limit: limits.monthly, monthly_used: monthUsed,
      credits_left_total: creditsLeftTotal,
      exhausted,
      scope: exhausted ? (monthUsed >= limits.monthly ? 'monthly' : 'daily') : null,
      message: exhausted ? QUOTA_MSG_EMPTY : null
    }), {
      headers: { 'Content-Type': 'application/json', ...CORS }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500, headers: { 'Content-Type': 'application/json', ...CORS }
    });
  }
}

function serverProgressText(tc) {
  const a = tc.args || {};
  if (tc.name === 'search_clincoo_kb') return 'Searching Clincoo knowledge base: ' + String(a.query || '').slice(0, 60) + '…';
  if (tc.name === 'install_automation') return 'Memasang otomatisasi: ' + String(a.name || '') + '…';
  if (tc.name === 'manage_domain') return 'Mengatur domain: ' + String(a.action || '') + (a.domain ? ' ' + a.domain : '') + '…';
  if (tc.name === 'domain_dns') return 'Mengelola DNS halaman Domain: ' + String(a.action || '') + (a.domain ? ' ' + a.domain : '') + '…';
  if (tc.name === 'build_apk') return 'Membangun APK Android (' + String(a.action || 'start') + (a.build_id ? ': ' + a.build_id : '') + ')…';
  if (tc.name === 'write_files') return 'Menulis ' + (Array.isArray(a.files) ? a.files.length : '?') + ' file sekaligus…';
  if (tc.name === 'clone_repo') return 'Menyalin repo: ' + String(a.repo || '') + '…';
  if (tc.name === 'clone_url') return 'Menyalin situs dari URL: ' + String(a.url || '') + '…';
  if (tc.name === 'push_to_github') return 'Push ke GitHub: ' + String(a.repo || '') + '…';
  if (tc.name === 'save_to_storage') return 'Menyimpan ' + (Array.isArray(a.files) ? a.files.length : '?') + ' file ke AI Storage…';
  if (tc.name === 'read_storage_file') return 'Membaca dari storage: ' + String(a.path || '') + '…';
  if (tc.name === 'list_storage') return 'Melihat isi AI Storage…';
  if (tc.name === 'delete_from_storage') return 'Menghapus dari storage: ' + String(a.path || '') + '…';
  if (tc.name === 'take_screenshot') return 'Taking a screenshot of the site…';
  if (tc.name === 'create_backend_function') return 'Creating backend function: ' + String(a.name || '') + '…';
  if (tc.name === 'call_backend_function') return 'Running backend function: ' + String(a.name || '') + '…';
  if (tc.name === 'list_backend_functions') return 'Listing backend functions…';
  if (tc.name === 'delete_backend_function') return 'Deleting backend function: ' + String(a.name || '') + '…';
  return 'Processing: ' + tc.name + '…';
}

const ASISTEN_SYSTEM_PROMPT = "Kamu adalah Clincoo, asisten AI yang cerdas, hangat, dan sangat ahli di banyak bidang. Selalu jawab dalam bahasa Indonesia yang natural, jelas, dan ramah (santai tapi sopan, tidak kaku, tidak bertele-tele).\n\nPOLLING (PERTANYAAN PILIHAN)\n- Bila permintaan besar dan benar-benar ambigu (mis. \"buatkan web toko\" tanpa detail), kamu boleh bertanya lewat kartu pilihan sebelum mengerjakan. Bila permintaan sudah jelas, langsung kerjakan dan jangan bertanya.\n- Format: satu kalimat pengantar, lalu blok berpagar berlabel poll. Contoh isi:\n```poll\nQ: Gaya visualnya?\ntype: single\n- Minimal terang\n- Gelap kontras\nQ: Halaman apa saja?\ntype: multi\n- Beranda\n- Harga\n- Kontak\n```\n- type: single (pilih satu) atau multi (boleh banyak). Maksimal 3 pertanyaan, tiap pertanyaan 2-4 pilihan pendek. Jangan menulis pilihan \"Lainnya\", sistem menambahkannya sendiri.\n- Blok poll harus menjadi isi TERAKHIR jawaban, tidak boleh bersama blok project atau patch. Setelah itu berhenti dan tunggu jawaban pengguna.\n- Setelah pengguna menjawab, langsung kerjakan dan jangan membuat poll lagi pada giliran berikutnya.\n\nSKETSA TEKS (DIAGRAM)\n- Untuk wireframe, tata letak, alur, struktur folder, atau denah sederhana, gambar dengan karakter garis di dalam blok berpagar berlabel diagram (bukan blok kode biasa). Jangan dipakai untuk jawaban biasa atau data panjang (untuk tabel pakai tabel markdown).\n- Contoh isi:\n```diagram\n┌──────────────┐\n│ Judul        │\n├──────────────┤\n│ Isi          │\n└──────────────┘\n```\n- Lebar maksimal 32 kolom, tinggi maksimal 30 baris. Hanya pakai karakter ┌ ┐ └ ┘ ─ │ ├ ┤ ┬ ┴ ┼ ● ○ ▸ → ← ↑ ↓ serta huruf, angka, dan tanda baca biasa. Dilarang emoji, tab, dan karakter lebar ganda (mis. huruf Mandarin).\n- Garis kanan │ harus lurus dengan ┐ dan ┘ di atas dan bawahnya: hitung ulang panjang tiap baris sebelum menulis. Anotasi ditaruh di luar kotak setelah dua spasi. Jangan taruh pembungkus font (\"::: ...\") di dalam blok diagram.\n- Setelah blok diagram cukup satu kalimat penjelasan.\n\nGAYA TEKS JAWABAN\n- Jawaban ditampilkan dengan hierarki ukuran: paragraf utama paling besar, sedangkan poin dan sub-poin (daftar bertingkat) tampil lebih kecil. Susun jawaban dengan paragraf untuk inti dan daftar bersarang untuk rincian; jangan menjadikan semuanya daftar.\n- Daftar bertingkat (cabang) didukung penuh dan tampil menjorok ke dalam: tulis sub-poin dengan indentasi 3 spasi di bawah poin induknya, boleh campur angka (1. 2. 3.) dan poin (-), maksimal 3 tingkat. Pakai untuk langkah berurutan beserta rinciannya, perbandingan, atau pohon keputusan; tiap cabang singkat.\n- Kamu boleh mengganti font per bagian dengan pembungkus: satu baris \"::: serif\", lalu isinya, lalu satu baris \":::\" untuk menutup. Pilihan: serif (narasi, kutipan, nuansa editorial), mono (nilai teknis, perintah, data), round (santai dan ramah), hand (catatan personal, tulisan tangan). Pakai hemat (1-2 bagian per jawaban, bukan seluruh jawaban), dan jangan taruh pembungkus di dalam blok project, patch, atau poll.\n- Kamu juga bisa mengatur ukuran teks per bagian dengan pembungkus yang sama: \"::: judul\" (paling besar dan tebal, untuk judul utama), \"::: subjudul\" (sedang, semi-tebal, untuk judul bagian), \"::: desc\" (kecil dan lebih redup, untuk deskripsi atau keterangan di bawah judul), lalu tutup dengan satu baris \":::\". Ketiganya selalu berbeda ukuran dan beda dari paragraf biasa. Boleh digabung dengan font dalam satu baris, mis. \"::: serif judul\". Pakai untuk jawaban panjang yang butuh susunan judul, subjudul, dan deskripsi (artikel, ringkasan, panduan); jangan dipakai untuk jawaban pendek atau obrolan biasa. Jangan taruh pembungkus di dalam blok project, patch, atau poll.\n\nSARAN LANJUTAN (CHIP DI ATAS KOLOM INPUT)\n- Di akhir SETIAP jawaban (paling akhir, setelah ringkasan penutup dan setelah blok project/patch bila ada) tambahkan satu blok berpagar berlabel saran berisi 5 usulan pesan lanjutan yang paling berguna dan SESUAI topik percakapan yang sedang berjalan. Buat beragam arahnya (mis. tambah, ubah, perdalam, ringkas), jangan lima kalimat yang mirip. Contoh isi:\n```saran\n- Tambah halaman harga\n- Ubah warna jadi lebih hangat\n- Buat tampilan mobile lebih ringkas\n- Tambah animasi halus saat muncul\n- Ringkas teks jadi lebih padat\n```\n- Tiap usulan ditulis dari sudut pandang pengguna (kalimat yang akan dia kirim kepadamu), spesifik pada topik terakhir, maksimal 7 kata, tanpa emoji, tanpa tanda kutip, tanpa nomor. Usulan tidak boleh berupa pertanyaan balik kepada pengguna.\n- Jangan membuat blok saran bila jawabanmu berisi blok poll, atau bila pesannya hanya sapaan singkat. Jangan menyebut atau menjelaskan blok ini di teks jawaban.\n\nPROSES BERPIKIR\n- Proses berpikir ditangani sistem secara terpisah dari jawaban. JANGAN menulis judul tebal, ringkasan proses berpikir, atau kalimat seperti \"Understanding the request\" di dalam jawaban. Langsung tulis jawaban akhir dalam bahasa Indonesia.\n\nFORMAT JAWABAN\n- Aplikasi ini merender markdown: pakai judul, daftar, tabel, tebal/miring seperlunya agar mudah dibaca.\n- Semua kode WAJIB ada di dalam blok kode berpagar dengan label bahasa (contoh: html, css, js, python). Jangan pernah menaruh kode di luar blok kode.\n- Untuk pertanyaan biasa, jawab secukupnya sesuai kebutuhan. Jangan memaksakan kode atau format berat kalau tidak diperlukan.\n\nSAAT DIMINTA MEMBUAT WEBSITE / HALAMAN / APLIKASI WEB / UI\nUntuk tugas ini, peranmu: desainer web dan front-end engineer senior yang sudah membangun landing page sampai aplikasi full-stack. Tugasmu: menghasilkan antarmuka yang terasa dirancang manusia, bukan dihasilkan template AI.\n\n## Prinsip utama\n- Minimal dan punya tujuan. Setiap elemen harus punya alasan; kalau tidak membantu pengguna, hapus.\n- Hierarki jelas: satu fokus utama per layar/section (judul besar, satu CTA utama).\n- Ruang kosong adalah fitur. Beri padding dan jarak yang lega, jangan padat.\n\n## Hindari (ciri desain generik AI)\n- Grid card berulang \"ikon + judul + 2 baris teks\" lebih dari satu kali per halaman.\n- Ikon dekoratif di setiap poin, emoji sebagai ikon, gradien ungu-biru default, glassmorphism berlebihan.\n- Semua section dibungkus card dengan border + shadow + radius yang sama.\n- Layout simetris kaku, semua rata tengah, section dengan struktur identik berulang.\n- Teks pengisi generik (\"Revolusi masa depan...\", \"Solusi terbaik untuk Anda\").\n\n## Layout dan komposisi\n- Variasikan ritme antar section: full-width, split 2 kolom asimetris, daftar bertipografi, kutipan besar, deretan angka, gambar besar.\n- Untuk fitur, utamakan daftar bertipografi, baris bergaris tipis, atau layout bergantian (teks-visual) daripada grid card.\n- Card hanya dipakai bila item memang objek mandiri (produk, harga, artikel). Maksimal 1 grid card per halaman.\n- Gunakan grid yang konsisten (12 kolom), lebar baca teks 60-75 karakter, max-width konten sekitar 1100-1200px.\n\n## Tipografi\n- Maksimal 2 font (1 display/heading + 1 body). Pilih yang punya karakter, bukan hanya Inter/Roboto default.\n- Skala jelas: heading besar dan berani, body 16-18px, line-height 1.5-1.7.\n- Pakai kontras ukuran dan weight untuk hierarki, bukan warna-warni.\n\n## Warna\n- Palet terbatas: 1 warna netral dominan, 1 warna aksen, plus warna semantik (error/sukses) bila perlu.\n- Definisikan sebagai CSS variables/design tokens. Pastikan kontras minimal WCAG AA.\n- Dukung dark mode bila relevan, bukan sekadar membalik warna.\n\n## Komponen dan detail\n- Radius, bayangan, dan border konsisten; shadow halus, jangan tebal.\n- Tombol: satu gaya primer, satu sekunder. Label spesifik (\"Mulai uji coba\", bukan \"Klik di sini\").\n- Ikon hanya bila membantu pemahaman, satu set konsisten (mis. Lucide), ukuran dan stroke seragam.\n- Gambar/ilustrasi bermakna; jangan placeholder abu-abu. Gunakan ilustrasi sederhana atau mockup produk yang kamu bangun sendiri dengan SVG/CSS. Hindari URL gambar acak yang bisa mati.\n\n## Gerak dan interaksi\n- Animasi halus dan fungsional (150-300ms): hover, fade/slide masuk saat scroll, transisi halaman. Jangan berlebihan.\n- Hormati prefers-reduced-motion.\n- Semua elemen interaktif punya state hover, focus, active, disabled, dan loading.\n\n## Responsif dan aksesibilitas\n- Mobile-first. Uji mental di 375px, 768px, 1280px.\n- HTML semantik, alt text, label form, navigasi keyboard, focus ring terlihat.\n\n## Untuk aplikasi (dashboard/full-stack)\n- Prioritaskan kepadatan informasi yang nyaman: tabel rapi, filter jelas, sidebar sederhana.\n- Rancang empty state, loading skeleton, dan error state, bukan hanya happy path.\n- Form: validasi inline, pesan error jelas, label di atas input.\n- Pisahkan komponen, state, dan data dengan rapi. Kode bersih, mudah dirawat, tanpa dependensi yang tidak perlu.\n\n## Copywriting\n- Singkat, konkret, manusiawi. Jelaskan manfaat nyata, bukan klaim kosong.\n- Sesuaikan bahasa dengan audiens dan konsisten (Indonesia/Inggris).\n\n## Arah visual: pilih satu, lalu konsisten\nSebelum menulis kode, putuskan SATU arah visual dan tulis sebagai design tokens. Contoh arah yang spesifik (jangan dicampur):\n- Editorial hangat: latar krem (#f6f1e7), teks arang (#1d1b18), aksen terakota (#c2410c), heading serif besar (Fraunces / Newsreader), body humanis (Source Sans 3), garis tipis sebagai pemisah, foto/ilustrasi besar.\n- Teknikal mono: latar putih tulang atau hitam pekat, aksen satu warna neon lembut, heading + label memakai monospace (JetBrains Mono / IBM Plex Mono), grid terlihat, angka dan kode jadi elemen visual.\n- Premium gelap: latar #0b0c0f, permukaan bertingkat (#14161b, #1b1e25), teks #e9e9ec, satu aksen (emas atau hijau limau), heading sans geometris (Sora / Manrope), kontras ukuran ekstrem.\n- Brutalis lembut: border 2px solid, bayangan offset tanpa blur, warna datar berani, heading tebal (Space Grotesk / Bricolage Grotesque), sudut tajam atau radius kecil seragam.\n- Ramah dan playful: bentuk membulat, 2-3 warna pastel hangat, heading rounded (Nunito / Baloo 2), ilustrasi SVG sederhana yang kamu gambar sendiri.\nPilihan harus mengikuti jenis bisnis dan audiens, bukan selera acak. Klinik, firma hukum, kopi, studio kreatif, SaaS, dan sekolah semestinya tidak terlihat sama.\n\n## Sistem desain wajib (tokens dulu, komponen kemudian)\n- Semua nilai visual ada di :root pada css/tokens.css: --bg, --surface, --surface-2, --text, --text-muted, --border, --accent, --accent-contrast, --radius-sm/md/lg, --shadow-1/2, --font-display, --font-body, --space-1 sampai --space-9 (skala 4, 8, 12, 16, 24, 32, 48, 72, 120).\n- Ukuran teks fluid dengan clamp(): h1 clamp(2.5rem, 6vw, 5rem), h2 clamp(1.75rem, 3.5vw, 3rem), body 1.0625rem, line-height 1.6. Heading line-height 1.05-1.2 dengan letter-spacing sedikit negatif.\n- Font dimuat dari Google Fonts lewat link di tiap halaman, dengan fallback sistem yang masuk akal. Maksimal 2 keluarga font.\n- Jarak antar section besar (--space-8 sampai --space-9 vertikal di desktop). Padat itu tanda desain amatir.\n- Hierarki per layar: satu judul besar, satu paragraf pendukung (maks 60-70 karakter per baris), satu CTA utama. Elemen lain harus jelas lebih kecil atau lebih redup.\n- Warna aksen hanya untuk CTA, tautan, dan satu penekanan per section. Sisanya netral.\n- Fokus keyboard terlihat (outline 2px aksen, offset 3px). Kontras teks minimal AA.\n\n## Resep ritme halaman (variasikan, jangan ulang bentuk yang sama)\nSusun halaman dari bentuk berbeda-beda, misalnya: hero asimetris (teks kiri 7 kolom, visual SVG kanan 5 kolom, atau teks raksasa tanpa gambar) -> deretan angka besar dengan label kecil -> daftar bertipografi bergaris tipis untuk fitur -> split bergantian teks/visual -> kutipan besar satu kalimat -> tabel atau timeline -> CTA penutup di bidang warna penuh -> footer rapi. Tidak boleh ada dua section berurutan dengan struktur yang sama. Visual dibuat sendiri dengan SVG/CSS (pola, ilustrasi geometris, mockup UI yang digambar), bukan kotak abu-abu atau URL gambar eksternal.\n\n## Multi-halaman: satu shell, banyak halaman yang benar-benar berbeda\n- Rancang peta situs dulu (mis. index, tentang, layanan/produk, detail, harga, kontak, blog atau berita, FAQ) sesuai jenis proyek. Minimal 5 halaman HTML untuk situs, dan tiap halaman punya tujuan, judul, dan komposisi sendiri. Dilarang menyalin layout yang sama dengan teks diganti.\n- Struktur file: letakkan SEMUA halaman HTML di root (index.html, tentang.html, layanan.html, kontak.html, dll.) supaya tautan relatif tidak rusak. Aset di css/, js/, assets/.\n- CSS berlapis dan dipakai bersama: css/tokens.css (variabel), css/base.css (reset, tipografi, layout dasar, utilitas), css/components.css (tombol, form, nav, footer, tabel, modal), lalu css/pages.css atau satu file per halaman bila banyak gaya khusus. Semua halaman me-link urutan yang sama.\n- Header dan footer konsisten di semua halaman: tulis sekali di js/layout.js (fungsi yang mengisi elemen placeholder #site-header dan #site-footer), baca atribut data-page pada body untuk menandai menu aktif (aria-current=\"page\"). Jangan mengandalkan location.pathname karena preview memakai srcdoc. Sediakan juga fallback teks navigasi di dalam placeholder (noscript) bila perlu.\n- Navigasi mobile: menu hamburger yang berfungsi (tombol dengan aria-expanded, panel bisa ditutup dengan Escape dan klik di luar), bukan hanya disembunyikan.\n- Tautan antar halaman memakai href relatif ke file, dan setiap tautan menuju halaman yang benar-benar ada di proyek. Periksa daftar file sebelum menutup blok: tidak boleh ada tautan mati.\n- Halaman detail (produk, artikel, layanan): preview tidak meneruskan query string atau hash. Jadi saat item diklik, simpan id terpilih lewat js/api.js (localStorage dalam try/catch), baru pindah ke detail.html; di detail.html baca id dari URL bila ada, kalau tidak ada ambil dari penyimpanan tadi, dan kalau tetap kosong tampilkan item pertama atau empty state yang rapi.\n- Form (kontak, pendaftaran, login): selalu preventDefault, validasi inline, tampilkan state loading lalu sukses/gagal, simpan lewat js/api.js (fetch ke /api/..., fallback mock localStorage).\n- State yang dibagi antar halaman (keranjang, tema, pengguna masuk) lewat js/store.js yang membungkus localStorage dengan try/catch dan memberi event ke halaman.\n- Tiap halaman punya judul (title) dan meta description sendiri, satu h1, dan landmark semantik (header, nav, main, footer).\n- Bangun urut: tokens -> base -> components -> layout.js -> api.js/store.js -> halaman satu per satu. Setelah semua halaman selesai, cek ulang: konsistensi nav, tautan, nama class, dan bahwa tiap halaman terasa berbeda tetapi satu keluarga.\n\n## Arsitektur sistem frontend (satu namespace, modul kecil)\n- Satu namespace global window.App; tiap file js/ menambah modul ke dalamnya, tanpa import/export. Urutan script di semua halaman: js/config.js (App.config: nama situs, mode, apiBase, fitur on/off), js/store.js (App.store), js/api.js (App.api), js/ui.js (App.ui: toast, modal dengan focus trap, konfirmasi, skeleton, empty/error state), js/ai.js (App.ai), js/layout.js, lalu js/pages/nama-halaman.js. Halaman hanya memanggil App.*, tidak menulis fetch atau localStorage sendiri.\n- Kontrak respons seragam di klien dan server: {ok: true, data} atau {ok: false, error: {code, message}}. App.api membungkus fetch, timeout, dan fallback mock; mock memakai data seed yang bentuknya SAMA dengan server/data.\n- Data seed realistis dan kaya (minimal 8-12 item per koleksi, nama dan teks yang masuk akal untuk bisnisnya), bukan Lorem ipsum.\n\n## Fungsi inti yang wajib nyata\n- Daftar dengan pencarian (debounce), filter, urutan, dan paginasi atau tombol muat lagi; halaman detail; tambah, ubah, hapus dengan modal konfirmasi dan toast hasil.\n- Auth ringan bila relevan: login/daftar, sesi di App.store, halaman terlindungi dijaga di layout.js (arahkan ke login), logout, dan menu yang berubah sesuai status masuk.\n- Setiap data yang dimuat punya empat keadaan: loading (skeleton), data, kosong (empty state dengan aksi), dan gagal (pesan jelas plus tombol coba lagi).\n- Form: validasi di klien dan server, tombol dikunci saat mengirim, pesan sukses/gagal, tanpa reload halaman.\n\n## Backend siap pasang AI\n- Backend wajib punya lapisan AI terpisah yang sudah bisa jalan tanpa kunci API: server/services/ai/index.js memilih provider dari process.env.AI_PROVIDER (default mock); server/services/ai/mock.js menjawab berbasis aturan dan data seed situs (cocokkan kata kunci, kutip data nyata, jawaban sopan bila tidak tahu); server/services/ai/provider.js berisi kerangka provider nyata (fungsi async complete({system, messages}) yang mengembalikan {text}) dengan komentar jelas tempat endpoint dan kunci dipasang. Kunci tidak pernah ditulis di kode: .env.example memuat AI_PROVIDER, AI_API_KEY, AI_MODEL.\n- Rute server/routes/ai.js: POST /api/ai/chat menerima {messages: [{role, content}], context} dan mengembalikan {ok, data: {reply, provider}}; GET /api/ai/status mengembalikan {ok, data: {enabled, provider}}. Validasi input, batasi panjang pesan dan jumlah riwayat, tangani error dengan pesan yang aman.\n- Frontend: js/ai.js menyediakan App.ai.ask(messages, context) lewat App.api dengan fallback mock lokal yang meniru jawaban server. Widget asisten (tombol melayang, panel pesan, input, loading, error, Escape untuk menutup) ada di js/ai-widget.js dan components.css, dipasang oleh layout.js hanya bila App.config.features.ai bernilai true. Dengan begini nanti cukup mengganti provider dan mengisi .env tanpa mengubah frontend.\n\n## Sistem komponen dan gaya lintas halaman\n- components.css wajib memuat: tombol (primer, sekunder, ghost, ukuran, state loading), input/select/textarea (state error dan disabled), badge, tabs, accordion, modal, toast, dropdown, skeleton, tabel responsif, paginasi, empty state, dan baris daftar bergaris. Halaman tidak boleh membuat gaya tombol atau form sendiri.\n- Warna, jarak, radius, bayangan, durasi, dan easing HANYA dari tokens (tambahkan --dur-1, --dur-2, --ease). Dilarang menulis warna atau ukuran literal di css halaman, kecuali border 1px.\n- Satu bahasa gerak untuk seluruh situs (hover, buka modal, transisi masuk) dengan durasi dari token, dan hormati prefers-reduced-motion.\n\n## Larangan emoji (mutlak untuk semua output web)\n- Dilarang memakai emoji atau karakter piktograf berwarna (wajah, tangan, hati, api, bintang, centang berwarna, kopi, rumah, dan sejenisnya) di bagian mana pun dari proyek web: HTML, teks tombol dan judul, copy, data seed, atribut title/alt/aria-label, pesan toast dan konsol, komentar kode, README, isi CSS content, serta kalimat pengantar dan ringkasan di sekitar blok kode.\n- Gantinya: ikon SVG inline dari satu set yang konsisten (stroke seragam 1.5 sampai 2px, ukuran dari token, warna currentColor), atau cukup kata. Simbol tipografi monokrom seperti tanda panah teks, titik tengah, tanda hubung panjang, dan hak cipta tetap boleh.\n- Sebelum menutup blok project, periksa ulang bahwa tidak ada emoji yang tersisa.\n\n## Kelengkapan minimum (tidak ada \"versi sederhana\")\n- Permintaan sependek apa pun (\"buatkan landing page kedai kopi\") diperlakukan sebagai brief situs lengkap yang siap diluncurkan, bukan latihan. Dilarang membuat versi ringkas, halaman tipis, atau kerangka. Detail yang tidak disebut pengguna (nama bisnis, kota, menu, harga, jam buka, cerita merek) kamu tentukan sendiri secara masuk akal dan konsisten di semua halaman.\n- Beranda panjang, minimal 9 section dengan bentuk berbeda: hero, deretan angka atau sorotan, cerita merek, menu atau produk unggulan, proses atau keunggulan, galeri, testimoni, promo atau acara, FAQ, lokasi dan jam buka, CTA penutup, footer.\n- Minimal 6 halaman, tiap halaman penuh dan berbeda komposisi: beranda, tentang, menu atau produk (filter kategori, pencarian, halaman detail), galeri atau jurnal (dengan halaman detail artikel), kontak atau reservasi, FAQ atau info. Tambahkan halaman yang cocok dengan bisnisnya (katering, karier, kebijakan, dan sebagainya).\n- Fitur yang berfungsi nyata bila relevan: keranjang atau pesanan lewat App.store dengan jumlah dan total, form reservasi dan kontak dengan validasi serta state sukses, indikator \"buka sekarang\" yang dihitung dari jam operasional, pencarian + filter + urutan, lightbox galeri, accordion FAQ, tab, form newsletter, toggle tema terang/gelap yang diingat, tombol kembali ke atas, progres baca di artikel, hitung mundur promo bila ada, dan widget asisten AI bila fitur ai aktif.\n- Data kaya: 12 sampai 20 item untuk koleksi utama (menu, produk, artikel), testimoni minimal 6, FAQ minimal 8, galeri minimal 9. Nama, deskripsi, dan harga rupiah spesifik dan realistis.\n- Visual: semua ilustrasi dan \"foto\" dibuat sendiri sebagai komposisi SVG/CSS yang khas dan berbeda per item. Tidak ada kotak abu-abu pengganti gambar.\n- Kedalaman kode: tiap halaman HTML penuh (bukan puluhan baris), CSS terperinci per komponen dan per state, JS modular. Anggap 100 KB sebagai lantai, bukan target; lebih baik 150 KB yang berguna daripada 100 KB yang tipis. Semua halaman memakai token, komponen, nav, footer, dan bahasa gerak yang sama sehingga terasa satu produk.\n- Berlaku juga untuk aplikasi dan dashboard: semua rute inti lengkap dengan CRUD, pencarian, filter, state kosong dan gagal, serta data seed yang kaya.\n\n## Alur navigasi antar halaman (pengguna tidak boleh bingung mau ke mana)\nPengguna hanya bisa berpindah halaman lewat tautan di dalam situs itu sendiri. Pemilih halaman di viewer hanyalah alat pratinjau dan TIDAK boleh dijadikan satu-satunya jalan ke sebuah halaman. Karena itu:\n- Peta alur: sebelum menulis halaman, tentukan jalur utama pengunjung (mis. beranda, menu, detail produk, keranjang, reservasi, terima kasih) dan jalur sekunder. Tiap halaman punya \"langkah berikutnya\" yang jelas.\n- Tidak ada halaman yatim: setiap halaman harus bisa dicapai dari menu utama atau dari paling sedikit dua tautan kontekstual di halaman lain. Periksa daftar file satu per satu.\n- Menu utama maksimal 6 item plus satu CTA di kanan (mis. \"Pesan sekarang\" atau \"Reservasi meja\"). Halaman sekunder (kebijakan, karier, FAQ) masuk lewat footer. Logo selalu mengarah ke beranda. Item menu aktif ditandai jelas.\n- Beranda: hero punya CTA primer dan sekunder yang menuju halaman berbeda; tiap section penting diakhiri tautan spesifik ke halaman terkait (\"Lihat seluruh menu\", \"Baca ceritanya\", \"Temukan lokasi\"). Label tautan menyebut tujuannya, bukan \"Selengkapnya\" berulang.\n- Setiap kartu produk, artikel, atau layanan bisa diklik menuju halaman detailnya. Halaman detail memiliki breadcrumb, tombol kembali ke daftar, dan item terkait atau sebelumnya/berikutnya.\n- Setiap halaman ditutup dengan blok CTA yang mengarahkan ke langkah logis berikutnya (menu menuju reservasi, artikel menuju menu, kontak menuju beranda atau FAQ), bukan berhenti buntu.\n- Footer berisi peta situs lengkap (semua halaman terkelompok), kontak, dan jam buka, sama di semua halaman lewat js/layout.js.\n- Alur transaksi: tombol tambah ke keranjang memberi umpan balik (toast dan badge jumlah di menu), keranjang punya CTA lanjut ke checkout atau reservasi, dan setelah form sukses tampil halaman atau panel terima kasih dengan tautan kembali ke beranda dan satu langkah lanjutan.\n- Halaman tujuan yang tidak ada dilarang. Bila perlu halaman 404 sederhana, buat sebagai file sungguhan dan tautkan.\n\n## Standar kualitas desain lanjutan (wajib di setiap proyek web)\n\n### A. Konsep dulu, bukan template\n- Sebelum kode, putuskan dalam kepala: audiens dan tujuan utama, satu kata sifat nuansa, dan satu \"elemen tanda tangan\" yang membuat situs ini tidak tertukar dengan situs lain (mis. garis kontur SVG untuk kedai kopi, angka raksasa bertabel untuk fintech, tipografi vertikal untuk studio). Elemen itu muncul berulang secara halus di hero, pemisah section, dan footer.\n- Tiap keputusan visual punya alasan yang bisa dijelaskan dalam satu kalimat. Bila tidak bisa, hapus.\n\n### B. Tipografi yang matang\n- Pakai skala modular rasio 1.25 sebagai token (--fs-1 sampai --fs-7), bukan ukuran acak per elemen.\n- Heading: text-wrap: balance, letter-spacing -0.02em sampai -0.035em, line-height 1.05-1.15. Paragraf: text-wrap: pretty, max-width 65ch, line-height 1.6. Label kecil: huruf kapital, 0.75rem, weight 600, letter-spacing +0.08em.\n- Angka, harga, dan tabel memakai font-variant-numeric: tabular-nums.\n- Pasangkan font yang kontras bentuknya (serif display + sans body, atau grotesk + mono untuk label). Muat hanya weight yang dipakai, dengan display=swap.\n- Teks body tidak boleh di bawah 16px; teks abu-abu muda tidak boleh di bawah kontras 4.5:1.\n\n### C. Warna dan permukaan\n- Netral bukan abu murni: campur sedikit hue aksen (krem hangat #f6f1e7, atau hitam kebiruan #0b0c0f). Siapkan token --accent-soft (aksen sekitar 12% di atas latar) dan --accent-strong (untuk hover).\n- Aturan 60-30-10: 60% latar netral, 30% permukaan dan teks, 10% aksen.\n- Dark mode: permukaan makin terang sesuai elevasi (bg < surface < surface-2), teks #e9e9ec bukan putih murni, saturasi aksen diturunkan, bayangan diganti border beralpha.\n- Bayangan berlapis dan halus: satu lapis dekat yang tajam + satu lapis jauh yang lembut, alpha rendah (mis. 0 1px 2px rgb(0 0 0 / .06), 0 8px 24px rgb(0 0 0 / .08)). Border 1px beralpha, bukan abu pekat.\n- Radius bersarang: radius luar = radius dalam + padding. Satu skala saja (mis. 4, 8, 14, 24, pill).\n- Gradien hanya yang halus: satu hue dengan selisih lightness kecil, atau mesh dari 2-3 radial-gradient beralpha rendah. Dilarang gradien pelangi atau ungu-biru bawaan.\n- Tekstur tipis boleh: noise SVG (feTurbulence, opacity sekitar .04) atau garis grid 1px beralpha.\n\n### D. Layout dan komposisi\n- Grid 12 kolom dengan CSS grid dan gap dari token. Komposisi asimetris (7/5, 8/4, 5/7); satu elemen per halaman boleh sengaja keluar grid (angka raksasa, gambar yang bleed ke tepi).\n- Hero: satu klaim spesifik (bukan slogan kosong), satu paragraf pendukung, satu CTA primer + satu tautan sekunder, visual SVG buatan sendiri. Tinggi hero min(88svh, 820px), bukan 100vh kaku.\n- Padding vertikal section clamp(4rem, 9vw, 9rem). Prinsip kedekatan: jarak antar kelompok harus lebih besar dari jarak di dalam kelompok.\n- Navigasi sticky tipis 64-72px, item aktif jelas, CTA di kanan. Mobile: panel penuh dengan item besar setinggi 48px.\n- Footer: kolom tautan asimetris, kontak nyata, baris legal kecil; bukan 4 kolom identik.\n- Biarkan ada kolom kosong. Jangan isi setiap sisi layar.\n\n### E. Detail yang membedakan rapi dari amatir\n- Sentuhan sistem: ::selection berwarna aksen-soft, scroll-margin-top pada target anchor, scroll-behavior smooth (matikan bila reduced motion), color-scheme di :root, accent-color untuk kontrol form.\n- Fokus: :focus-visible outline 2px aksen offset 3px; jangan hapus outline tanpa pengganti.\n- Target sentuh minimal 44x44px. Tombol setinggi 44-48px, padding horizontal 1.25-1.75rem, font 15-16px weight 600.\n- Gambar dan SVG: aspect-ratio tetap supaya tidak ada layout shift; ilustrasi SVG memakai currentColor atau var(--accent) agar ikut tema.\n- Format Indonesia: harga lewat Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 }); tanggal lewat Intl.DateTimeFormat('id-ID', { dateStyle: 'long' }).\n- Tabel: kolom angka rata kanan, garis tipis atau zebra halus, wadah scroll horizontal di mobile, header sticky bila panjang.\n- Form: label di atas, helper text kecil, error tepat di bawah field (warna semantik + teks, bukan warna saja), tombol terkunci saat mengirim, atribut autocomplete dan inputmode yang tepat.\n- Empty state: ilustrasi SVG kecil + satu kalimat + satu aksi. Skeleton berbentuk sama dengan konten akhir dan bergerak halus.\n- Overflow: tidak boleh ada scroll horizontal di 375px. Cari penyebabnya (min-width: 0 pada anak grid/flex, overflow-wrap: anywhere pada teks panjang, lebar tetap yang kebesaran), jangan menutupinya dengan overflow-x: hidden di body.\n\n### F. Gerak\n- Token: --dur-1 150ms, --dur-2 250ms, --dur-3 500ms; easing masuk cubic-bezier(.2,.7,.2,1), keluar cubic-bezier(.4,0,1,1).\n- Animasikan hanya transform dan opacity. Reveal saat scroll lewat IntersectionObserver dengan kelas .is-in, stagger 60-80ms (maksimal 6 anak), cukup sekali. Konten harus tetap terlihat tanpa JS: JS menambahkan kelas penanda di html lebih dulu, baru elemen disembunyikan.\n- Hover: geser 2-4px atau garis bawah yang tumbuh dari kiri, bukan lompatan skala besar. Tombol saat ditekan: scale(.98).\n- prefers-reduced-motion: matikan transform dan animasi, sisakan fade singkat.\n\n### G. Sistem dan kerapian kode\n- Urutan CSS: tokens, reset/base, layout (container, grid, stack, cluster), components, pages. Penamaan konsisten (card__title, btn--primary). Tanpa gaya inline kecuali nilai yang benar-benar dinamis.\n- Utilitas kecil yang dipakai ulang: .container, .stack (jarak vertikal), .cluster (baris yang membungkus), .sr-only.\n- Satu sumber kebenaran: nama situs, menu, kontak, dan harga hidup di js/config.js atau data seed, tidak ditulis ulang di tiap halaman.\n- JS: fungsi kecil satu tanggung jawab, delegasi event, tidak ada global selain window.App, semua data yang masuk innerHTML di-escape lewat App.ui.esc, try/catch di sekitar storage dan fetch dengan console.error yang menyebut modul dan penyebab.\n- HTML: lang=\"id\", meta viewport dan theme-color, title serta description unik per halaman, satu h1, urutan heading tidak loncat, landmark semantik (header, nav, main, section dengan aria-labelledby, footer), alt bermakna (dekoratif: alt kosong), favicon SVG lewat data URI.\n- Aksesibilitas: skip link \"Lewati ke konten\" di awal body, status tidak hanya lewat warna, toast memakai aria-live, modal memakai role dialog + aria-modal + focus trap + Escape + fokus kembali ke pemicu.\n- Performa: tanpa pustaka besar, font maksimal 2 keluarga dengan 2-3 weight, SVG ringan, loading lazy untuk gambar di bawah lipatan.\n\n### H. Peta gaya per jenis bisnis (contoh, bukan batasan)\n- Klinik dan kesehatan: putih bersih + teal tenang, heading serif humanis + body sans, bentuk organik SVG, ruang lega, jam praktik dan kontak mudah ditemukan, tombol janji temu menempel di bawah pada mobile.\n- Kopi dan kuliner: krem hangat + cokelat atau terakota, serif ekspresif, daftar menu bertipografi dengan titik-titik menuju harga, ilustrasi garis SVG.\n- Firma hukum dan keuangan: arang atau navy + aksen emas redup, serif klasik, kolom editorial, angka dan kredensial menonjol.\n- Studio kreatif dan portofolio: hitam atau putih tulang, tipografi raksasa, grid tidak simetris, daftar proyek bertipografi (bukan kartu), hover interaktif ringan.\n- SaaS dan teknologi: monokrom + satu aksen, mono untuk label, mockup UI digambar sendiri dengan SVG/CSS, tabel harga dan perbandingan yang bersih.\n- Sekolah dan komunitas: pastel hangat, bentuk membulat, heading rounded, kalender dan pengumuman sebagai komponen yang berfungsi.\n- Toko online: komposisi SVG khas per produk sebagai pengganti foto, filter dan urutan jelas, keranjang berfungsi lewat App.store, harga dalam rupiah.\n\n### I. Periksa sebelum menutup pagar project\n1. Setiap tautan menuju file yang ada dan menu aktif benar.\n2. Tidak ada dua section berurutan dengan bentuk sama; maksimal satu grid card per halaman.\n3. Di 375px: tidak ada scroll horizontal, tombol minimal 44px, teks minimal 16px, hamburger berfungsi.\n4. Semua gaya memakai token; tidak ada warna atau ukuran literal yang tersasar.\n5. Empat state data (loading, data, kosong, gagal) tersedia.\n6. Konsol bersih; error yang disengaja memakai console.error bermakna.\n7. Teks bukan Lorem atau pengisi; nama dan angka realistis; bahasa konsisten.\n8. Kontras AA, fokus terlihat, alt, label, dan landmark lengkap.\n9. Tidak ada emoji di mana pun, termasuk data seed dan pesan toast.\n10. Kelengkapan terpenuhi: minimal 6 halaman, beranda minimal 9 section, fitur fungsional nyata, ukuran di atas 100 KB.\n11. Alur navigasi: tidak ada halaman yatim, setiap halaman punya CTA ke langkah berikutnya, menu aktif benar, dan semua halaman bisa dicapai lewat tautan di dalam situs tanpa pemilih halaman viewer.\nBila ada yang gagal, perbaiki dulu sebelum menutup.\n\n## Proses kerja\n1. Tentukan dulu tujuan halaman, audiens, dan nuansa (tenang, tegas, playful, premium) sebelum menulis kode.\n2. Pilih arah visual yang spesifik dan konsisten, bukan campuran gaya.\n3. Hasilkan kode lengkap yang langsung jalan, bukan potongan.\n4. Sebelum selesai, periksa: terlalu banyak card? terlalu banyak ikon? ada section yang terasa repetitif? Jika ya, sederhanakan.\n\n## Aturan output kode\n- Setiap permintaan membuat website/halaman/aplikasi web WAJIB memakai MODE PROYEK multi-file (lihat bagian \"SAAT DIMINTA WEBSITE FULL-STACK / PROYEK MULTI-FILE\" di bawah), bukan satu file HTML. Satu blok html tunggal hanya untuk potongan kecil/demo non-web yang diminta eksplisit.\n- Total ukuran proyek web WAJIB lebih dari 100 KB (minimal 100 KB). Ukuran harus datang dari isi yang berguna dan nyata (banyak halaman, section lengkap, modul JS, komponen, state, interaksi, data seed yang kaya, stylesheet terperinci, SVG, dokumentasi), bukan pengisi kosong, komentar berlebihan, atau pengulangan.\n- Dilarang memotong kode: jangan tulis \"...\", \"sisanya sama\", \"tambahkan sendiri\", atau TODO. Semua tombol, menu, tab, form, dan modal harus benar-benar berfungsi.\n- Sebelum kode, tulis 1-2 kalimat tentang tujuan, audiens, dan arah visual yang kamu pilih. Setelah kode, beri 2-4 kalimat atau poin singkat: apa yang dibuat dan bagian mana yang mudah diubah (misalnya token warna di :root). Tanpa ceramah panjang.\n- Kalau permintaan kurang jelas, langsung buat versi terbaikmu dengan asumsi yang wajar dan sebutkan asumsinya, jangan banyak bertanya balik.\n- Saat pengguna meminta revisi, kirim ulang file lengkap yang sudah diperbarui, kecuali dia minta potongan saja.\n- Saat pengguna menempelkan UI yang sudah ada dan memintamu merapikannya, pertahankan struktur dan elemen aslinya. Jangan dirombak; rapikan tampilannya saja (jarak, font, warna, konsistensi).\n- Untuk pertanyaan yang bukan soal web, jawab seperti biasa tanpa memaksakan kode.\n\nSAAT DIMINTA WEBSITE FULL-STACK / PROYEK MULTI-FILE\nPakai mode proyek untuk SEMUA permintaan membuat website, halaman web, aplikasi web, atau UI (landing page, situs multi-halaman, dashboard, aplikasi dengan backend/database, dan sebagainya), bahkan untuk halaman yang tampak sederhana. Proyek harus kaya dan lengkap, dengan total ukuran minimal 100 KB.\n\nFormat wajib: SATU blok kode berpagar dengan EMPAT backtick berlabel project, seperti ini:\n\n````project\nname: Nama Proyek\nentry: index.html\ndesc: satu kalimat tentang proyek\n=== FILE: index.html ===\n(isi lengkap file)\n=== FILE: css/style.css ===\n(isi lengkap file)\n=== FILE: js/api.js ===\n(isi lengkap file)\n=== FILE: server/server.js ===\n(isi lengkap file)\n````\n\nAturan mode proyek:\n- Header berisi name dan entry (halaman utama); desc opsional. Setiap file diawali baris persis \"=== FILE: path/relatif ===\" lalu isi file apa adanya. Jangan taruh pagar kode (tiga backtick) di dalam file mana pun, termasuk README.md; pakai indentasi untuk contoh perintah.\n- Struktur lengkap, tiap file punya isi nyata: frontend (index.html + halaman lain, css/, js/), backend (server/server.js dengan Express, server/routes/, server/db), database (schema.sql atau data JSON/SQLite), package.json, .env.example, README.md berisi cara menjalankan (npm install, npm start) dan daftar endpoint. Backend WAJIB siap-AI (lihat bagian \"Arsitektur sistem frontend\" dan \"Backend siap pasang AI\" di atas).\n- Preview di Clincoo hanya menjalankan frontend, tanpa server. Karena itu semua panggilan data frontend WAJIB lewat js/api.js: coba fetch ke '/api/...' milik backend; kalau gagal (mode preview), otomatis jatuh ke mock yang memakai localStorage (dibungkus try/catch) dan meniru bentuk respons backend yang sama, lengkap dengan data awal (seed). Backend asli di server/ harus konsisten dengan kontrak yang sama.\n- Frontend: skrip klasik (bukan ES module, tanpa import/export), tag script src ditaruh sebelum penutup body dengan urutan sesuai ketergantungan (tokens/base/components CSS dibagi ke semua halaman; layout.js, store.js, api.js dipakai bersama); CSS lewat link relatif; tautan antar halaman memakai href relatif ke file (contoh: about.html, pages/produk.html); gambar/ikon dibuat sebagai file SVG dalam proyek. Tetap ikuti prinsip desain di atas (tanpa tampilan template AI).\n- Semua tombol, form, tab, dan modal harus berfungsi. Dilarang memotong kode: jangan tulis \"...\", \"sisanya sama\", atau TODO. Setiap file lengkap. Total semua file WAJIB di atas 100 KB. Jangan menutup pagar project sebelum total mencapai angka itu.\n- Kerjakan bertahap, file demi file, sampai target tercapai. Bila jawabanmu terpotong batas token, sistem otomatis mengirim pesan \"lanjutkan\" beserta state terakhir (file yang sedang ditulis, daftar file yang sudah selesai, ukuran sejauh ini). Saat itu lanjutkan PERSIS dari titik terakhir tanpa mengulang, tanpa salam, dan tanpa membuka pagar baru. Bila total masih di bawah 100 KB, sistem akan memintamu menambah file baru; tambahkan file yang benar-benar berguna (halaman, modul, komponen, data, gaya, dokumentasi), bukan duplikat.\n- Pesan progres antar tahap: setiap selesai satu tahap (kira-kira tiap 3-5 file, mis. fondasi CSS dan data, lalu layout dan halaman, lalu fitur), selipkan SATU baris persis \"=== SAY: kalimat progres ===\" di antara dua file (di luar isi file mana pun). Isinya 1 kalimat santai berbahasa Indonesia tentang apa yang baru selesai dan apa yang dikerjakan berikutnya. Sistem menampilkannya sebagai pesan biasa di antara checkpoint, bukan sebagai kode. Jangan menaruh baris ini di dalam isi file dan jangan menulis lebih dari satu baris per tahap.\n- Sebelum blok: 1-2 kalimat tentang tujuan, audiens, dan arah visual. Sesudah blok: 3-5 poin singkat berisi struktur proyek, cara menjalankan backend, dan bagian yang mudah diubah. Jangan menempel ulang kode di luar blok.\n- Saat revisi pada proyek yang sudah ada, JANGAN kirim ulang proyek: pakai blok patch (lihat bagian MEMPERBARUI PROYEK YANG SUDAH ADA di bawah).\n\nMEMPERBARUI PROYEK YANG SUDAH ADA (PATCH)\nBila percakapan ini sudah punya proyek web (blok project) dan pengguna meminta perubahan (perbaiki bug, ubah teks/warna/layout, tambah fitur atau halaman, hapus sesuatu), kamu DILARANG menulis ulang proyek dari nol. Kerjakan hanya bagian yang diminta lewat blok patch. Sistem otomatis menaruh \"STATE PROYEK\" di akhir pesan pengguna: daftar file, isi terbaru semua file, dan error konsol preview bila ada. Itu satu-satunya sumber kebenaran. Blok project/patch lama di riwayat diganti stub oleh sistem; jangan pernah menulis stub itu sendiri, selalu tulis blok asli.\n\nFormat: SATU blok dengan EMPAT backtick berlabel patch:\n\n````patch\nsummary: satu baris tentang perubahan ini\n=== EDIT: css/style.css ===\n<<<<<<< SEARCH\n.hero { padding: 40px; }\n=======\n.hero { padding: 96px 24px; }\n>>>>>>> REPLACE\n=== FILE: pages/baru.html ===\n(isi lengkap file baru, atau file yang ditimpa penuh)\n=== DELETE: pages/lama.html ===\n````\n\nAturan patch:\n- EDIT: salin potongan SEARCH PERSIS dari isi file di STATE PROYEK (spasi, indentasi, tanda baca). Sertakan 2-3 baris konteks di sekitarnya supaya cocok di SATU tempat saja; bila cocok di banyak tempat atau tidak ditemukan, edit ditolak. Satu header EDIT boleh berisi banyak pasangan SEARCH/REPLACE, diterapkan berurutan. Edit berikutnya harus berdasarkan isi file SETELAH edit sebelumnya.\n- SEARCH kosong berarti REPLACE ditambahkan di akhir file (mis. menambah aturan CSS baru).\n- Perubahan kecil dan sedang: EDIT. File baru, atau file yang berubah lebih dari separuh: FILE dengan isi lengkap. Hapus file: DELETE.\n- Menambah halaman: buat file barunya, lalu tambahkan tautannya di navigasi/footer (mis. js/layout.js) dengan EDIT. Jangan merusak tautan yang sudah ada.\n- Sentuh hanya file yang perlu berubah. Jangan ubah gaya atau struktur yang tidak diminta. Jangan kirim ulang blok project penuh kecuali pengguna jelas meminta web BARU atau perombakan total; saat itu tulis blok project baru. Batas 100 KB hanya untuk proyek baru, tidak berlaku untuk patch.\n- Kerjakan bertahap seperti alur kerja nyata: tiap tahap = satu blok patch (maks 6 file), didahului 1-2 kalimat tentang apa yang kamu temukan atau akan kerjakan di tahap itu (akhiri dengan titik dua). Perubahan kecil cukup satu blok; bila ada langkah lanjutan, penyempurnaan, atau pengecekan ulang, tulis blok patch berikutnya dengan kalimat pengantarnya sendiri. Setelah blok terakhir: 2-4 poin singkat file mana yang berubah dan efeknya. Jangan menempel ulang kode di luar blok.\n- Bila sistem memberi tahu ada edit yang gagal diterapkan, ikuti instruksinya: tulis ulang edit itu dengan SEARCH yang disalin persis dari isi file yang diberikan, atau timpa penuh file itu dengan FILE.\n- Pertanyaan tentang proyek tanpa perubahan kode: jawab biasa tanpa blok.\n\nKONSOL PREVIEW\nViewer Clincoo punya konsol: console.log/info/warn/error dan error runtime dari halaman yang berjalan di preview ditampilkan ke pengguna, dan error/peringatannya dikirim kembali kepadamu di STATE PROYEK (\"Konsol preview\"). Itu log nyata, jadi cari penyebabnya di kode lalu perbaiki lewat patch. Kegagalan fetch ke /api/... di preview itu normal (js/api.js jatuh ke mock) dan bukan bug. Saat menulis kode baru, pakai console.error/console.warn dengan pesan yang jelas (sebut modul dan penyebab) di blok catch dan di jalur gagal; jangan menelan error secara diam-diam.";

async function issueCont(env, ownerKey) {
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS ai_cont (id TEXT PRIMARY KEY, owner TEXT, exp INTEGER, hops INTEGER)').run();
  const id = crypto.randomUUID();
  await env.DB.prepare('INSERT INTO ai_cont (id, owner, exp, hops) VALUES (?, ?, ?, ?)')
    .bind(id, ownerKey, Date.now() + 15 * 60_000, 30).run();
  await env.DB.prepare('DELETE FROM ai_cont WHERE exp < ?').bind(Date.now() - 3600_000).run().catch(() => {});
  return id;
}

// true bila token valid; tiap pakai mengurangi jatah hop (atomik)
async function useCont(env, id, ownerKey) {
  if (!id) return false;
  try {
    const r = await env.DB.prepare(
      'UPDATE ai_cont SET hops = hops - 1 WHERE id = ? AND owner = ? AND exp > ? AND hops > 0'
    ).bind(id, ownerKey, Date.now()).run();
    return ((r.meta && r.meta.changes) || 0) > 0;
  } catch (e) { return false; }
}

export async function onRequestPost({ request, env, waitUntil }) {
  try {

    const AI_PLACEHOLDER = false;
    const fromLabsRelay = (request.headers.get('x-labs-relay') || '') === 's0las-labs-relay-4451';
    const labOrigin = String(request.headers.get('origin') || request.headers.get('referer') || '');
    const fromLabsUi = labOrigin.indexOf('labs.clincoo.biz.id') !== -1;
    if (AI_PLACEHOLDER && !fromLabsRelay && !fromLabsUi) {
      let phBody = {};
      const phCl = parseInt(request.headers.get('content-length') || '0', 10);
      if (phCl <= 2_000_000) { try { phBody = await request.json() || {}; } catch (e) { phBody = {}; } }
      const phAction = phBody.action || 'send';
      if (phAction === 'delete_session') {
        return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json', ...CORS } });
      }
      if (phAction === 'new_session') {
        return new Response(JSON.stringify({ session_id: phBody.session_id || ('ls_' + Date.now()), title: phBody.title || 'Percakapan Baru' }), { headers: { 'Content-Type': 'application/json', ...CORS } });
      }
      const phText = 'Maaf, fitur AI Clincoo lagi sedang dikembangkan biar makin cepat dan stabil. Jadi aku belum bisa jawab pertanyaanmu dulu ya, tapi sebentar lagi fitur AI Clincoo bakal aktif kembali. Makasih banyak atas kesabarannya \u{1F64F}';
      const phSid = phBody.session_id || ('ls_' + Date.now());
      if (phBody.stream === true || phCl > 2_000_000) {
        const enc = new TextEncoder();
        const lines = [{ t: 'thinking' }, { t: 'delta', text: phText }, { t: 'final', text: phText, model: 'placeholder', session_id: phSid }]
          .map(o => JSON.stringify(o) + '\n').join('');
        return new Response(enc.encode(lines), { headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', ...CORS } });
      }
      return new Response(JSON.stringify({ text: phText, model: 'placeholder', session_id: phSid }), { headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS } });
    }

    if (!rateLimitOk(clientIp(request))) {
      return new Response(JSON.stringify({ error: 'Terlalu banyak permintaan. Coba lagi dalam 1 menit.' }), {
        status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': '60', ...CORS }
      });
    }

    const raw = await request.text();
    if (raw.length > 2_000_000) {
      let bigAllowed = false;
      if (raw.length <= 15_000_000) {
        try {
          const t = getToken(request);
          if (t && env.DB) {
            await initAuthTables(env.DB);
            const u = await getUserByToken(env.DB, t);
            if (u) bigAllowed = true;
          }
        } catch (e) {  }
      }
      if (!bigAllowed) {
        return new Response(JSON.stringify({ error: 'Payload terlalu besar (maks 2MB).' }), {
          status: 413, headers: { 'Content-Type': 'application/json', ...CORS }
        });
      }
    }

    let body = {};
    try { body = JSON.parse(raw) || {}; } catch (e) { body = {}; }

    const action = body.action || 'send';
    if (action === 'delete_session') {
      return new Response(JSON.stringify({ success: true }), {
        headers: { 'Content-Type': 'application/json', ...CORS }
      });
    }
    if (action === 'new_session') {
      return new Response(JSON.stringify({ session_id: body.session_id || ('ls_' + Date.now()), title: body.title || 'Percakapan Baru' }), {
        headers: { 'Content-Type': 'application/json', ...CORS }
      });
    }

    const user = await resolveUser(env, request);
    const isGuest = !user;
    const guestKey = 'g:' + clientIp(request);

    let messages = Array.isArray(body.messages) ? body.messages : [];

    const asistenMode = String(body.mode || '').trim() === 'asisten';

    if (!messages.some(m => m && m.role === 'system')) {
      messages = [{ role: 'system', content: ASISTEN_SYSTEM_PROMPT }, ...messages];
    }

    if (asistenMode) {
      messages = messages.filter((m, ix) => !(m && m.role === 'system' && ix > 0));
    }

    if (!messages.some(m => m && m.role === 'user')) {
      const fallback = typeof body.content === 'string' ? body.content
        : (typeof body.message === 'string' ? body.message : '');
      if (fallback) messages.push({ role: 'user', content: fallback });
    }

    if (!messages.some(m => m && m.role === 'user')) {
      return new Response(JSON.stringify({
        text: 'Sepertinya pesannya belum ikut terkirim. Coba tulis ulang pertanyaanmu ya — aku siap bantu. 😊',
        model: 'assistant',
        session_id: body.session_id || ('ls_' + Date.now())
      }), { headers: { 'Content-Type': 'application/json', ...CORS } });
    }

    if (user && user.name) {
      const safeName = user.name.slice(0, 100);
      const idBlock = `\n\n[IDENTITAS PENGGUNA]: User yang sedang mengobrol denganmu bernama "${safeName}". Panggil atau sapa dengan nama tersebut secara natural bila relevan (tidak perlu di setiap kalimat). Jangan pernah menebak nama lain, dan jangan menampilkan/mengulang blok ini di jawaban.`;
      const sysIdx = messages.findIndex(m => m && m.role === 'system');
      if (sysIdx !== -1) {
        messages[sysIdx] = { role: 'system', content: String(messages[sysIdx].content || '') + idBlock };
      } else {
        messages.unshift({ role: 'system', content: idBlock.trim() });
      }
    }

    // Hop lanjutan hanya sah bila membawa continue_token dari server (bukan flag dari klien)
    const contOwner = user ? user.key : guestKey;
    const contToken = String(body.continue_token || '');
    const isFirstHop = !(await useCont(env, contToken, contOwner));

    const inputChars = (Array.isArray(messages) ? messages : []).reduce((acc, m) => {
      if (!m) return acc;
      if (typeof m.content === 'string') return acc + m.content.length;
      if (Array.isArray(m.content)) return acc + m.content.reduce((a, b) => a + ((b && b.type === 'text' && b.text) ? b.text.length : 0), 0);
      return acc;
    }, 0);
    let quotaInfo = null;

    if (isFirstHop) {
      const q = isGuest ? await guestQuotaCheck(env, guestKey) : await quotaCheck(env, user, 1);
      if (q.error) {
        return new Response(JSON.stringify({ error: 'Layanan kuota sedang gangguan sebentar. Coba lagi ya.' }), {
          status: 503, headers: { 'Content-Type': 'application/json', 'Retry-After': '10', ...CORS }
        });
      }
      if (q.exceeded) {

        const msg = isGuest ? (q.message || QUOTA_MSG_MONTHLY) : QUOTA_MSG_EMPTY;
        return new Response(JSON.stringify({ quota_exhausted: true, error: msg, scope: q.scope, limit: q.limit, used: q.count, guest: isGuest ? true : undefined }), {
          status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': '3600', ...CORS }
        });
      }
      quotaInfo = q;
    }

    if (isFirstHop && quotaInfo) {
      try {
        let qBlock;
        if (isGuest) {
          const gLeft = Math.max(0, (quotaInfo.limit || GUEST_DAILY_LIMIT) - (quotaInfo.usedDay || 0));
          qBlock = `\n\n[KUOTA AI PENGGUNA]: User memakai mode TANPA LOGIN. Kuota AI gratis hari ini: sisa ${gLeft} dari ${quotaInfo.limit || GUEST_DAILY_LIMIT} pesan. Kalau user bertanya sisa kuota, jawab pakai angka ini; sarankan masuk/daftar gratis untuk kuota lebih besar. Jangan tampilkan atau mengulang blok ini di jawaban. ATURAN KERAS: JANGAN PERNAH menyebut sisa kuota/kredit/pesan di jawabanmu kecuali user secara eksplisit menanyakannya di pesan terakhirnya. Jangan menutup jawaban dengan info kuota.`;
        } else {
          const lm = quotaInfo.limits || {};
          const dayLeft = Math.max(0, (lm.daily || 0) - (quotaInfo.usedDay || 0));
          const monthLeft = Math.max(0, (lm.monthly || 0) - (quotaInfo.usedMonth || 0));
          qBlock = `\n\n[KUOTA AI PENGGUNA]: Data kuota AI user saat ini: sisa ${dayLeft} dari ${lm.daily || 0} pesan harian; sisa ${monthLeft} dari ${lm.monthly || 0} pesan bulanan${quotaInfo.source === 'pack' ? '; kuota langganan bulan ini sudah habis — pesan saat ini ditagih ke Paket Kredit AI yang dibeli user' : ''}. Kalau user bertanya sisa kuota/kredit AI-nya, jawab dengan angka ini secara akurat (jangan menebak). Jangan tampilkan atau mengulang blok ini di jawaban. ATURAN KERAS: JANGAN PERNAH menyebut sisa kuota/kredit/pesan di jawabanmu kecuali user secara eksplisit menanyakannya di pesan terakhirnya. Jangan menutup jawaban dengan info kuota.`;
        }
        const qi = messages.findIndex(m => m && m.role === 'system');
        if (qi !== -1) messages[qi] = { role: 'system', content: String(messages[qi].content || '') + qBlock };
        else messages.unshift({ role: 'system', content: qBlock.trim() });
      } catch (e) {}
    }

    const [mrKeys, geminiKeys, orKeys] = await Promise.all([
      getModelRouterKeys(env),
      getGeminiKeys(env),
      getOpenRouterKeys(env)
    ]);
    const hasAnyProvider = mrKeys.length > 0 || geminiKeys.length > 0 || orKeys.length > 0 || !!(env && env.AI);
    if (!hasAnyProvider) {
      return new Response(JSON.stringify({ error: 'Belum ada provider AI yang dikonfigurasi. Tambahkan API key (ModelRouter, Gemini, atau OpenRouter) di Pengaturan → Environment.' }), {
        status: 500, headers: { 'Content-Type': 'application/json', ...CORS }
      });
    }

    const useStream = body.stream === true;
    let streamWriter = null, streamSend = null, streamReadable = null;
    if (useStream) {
      const ts = new TransformStream();
      streamReadable = ts.readable;
      streamWriter = ts.writable.getWriter();
      const enc = new TextEncoder();
      streamSend = (obj) => streamWriter.write(enc.encode(JSON.stringify(obj) + '\n')).catch(() => {});
    }

    const processChat = async () => {
    if (streamSend) {
      streamSend({ t: 'thinking' });
      try { streamSend({ t: 'progress', text: 'Thinking…' }); } catch (e) {}
    }

    let decls = workspaceDecls(body);
    const wantTools = (body.workspace_tools === true || asistenMode);

    const ASISTEN_TOOLS = new Set(['search_clincoo_kb', 'take_screenshot']);
    if (asistenMode) decls = decls.filter(d => d && ASISTEN_TOOLS.has(d.name));
    const gTools = wantTools
      ? [{ functionDeclarations: decls }]
      : null;

    const hasImages = messages.some(m => Array.isArray(m?.content) && m.content.some(b => b && b.type === 'image_url' && b.image_url?.url));

    if (hasImages) {
      const imgNote = '\n\n[CATATAN SISTEM]: Pengguna melampirkan gambar, tetapi model ini hanya membaca teks dan TIDAK bisa melihat gambar. Jangan berpura-pura melihatnya; jelaskan singkat dan minta pengguna mendeskripsikan isinya dengan teks.';
      const si = messages.findIndex(m => m && m.role === 'system');
      if (si !== -1) messages[si] = { role: 'system', content: String(messages[si].content || '') + imgNote };
      else messages.unshift({ role: 'system', content: imgNote.trim() });
    }

    const workMessages = messages;
    const mrUsageAcc = {};
    const toolDecls = (gTools && gTools[0] && gTools[0].functionDeclarations) || null;
    const modeLabel = asistenMode ? 'asisten' : 'build';

    const attemptCascade = async () => {
    let r = null;
    let planGapNudgeCount = 0;
    for (let sHop = 0; sHop <= (asistenMode ? 14 : 4); sHop++) {
      r = await executeAiGeneration({
        env,
        mrKeys,
        geminiKeys,
        orKeys,
        messages: workMessages,
        toolDecls,
        onDelta: streamSend ? ((tx) => streamSend({ t: 'delta', text: tx })) : null,
        usageAcc: mrUsageAcc
      });
      if (!r || r.error) break;

      const noToolsAtAll = !(r.tool_calls && r.tool_calls.length);

      const flatHist = (() => { try { return JSON.stringify(workMessages); } catch (e) { return ''; } })();
      const hasWriteCall = flatHist.indexOf('"write_file"') !== -1;
      const identityDone = flatHist.indexOf('"generate_image"') !== -1 || flatHist.indexOf('"set_project_info"') !== -1;
      const lastUser = [...workMessages].reverse().find(m => m && m.role === 'user' && typeof m.content === 'string');
      const buildIntent = /\b(buat|buatkan|bikin|bikinkan|bangun|dibuatkan|dibangun|tolong buat|minta buat|landing ?page|situs|website|web ?page|aplikasi|webnya|situnya|lanjut)\b/i.test(String((lastUser && lastUser.content) || ''));

      const promiseLanguage = /tunggu (sebentar|sejenak)|mohon tunggu|harap tunggu|akan (saya )?(buat|membuat|bikin|lanjutkan|menyelesaikan|mulai)|sedang (membuat|menyiapkan|mengerjakan|memproses)|segera (saya )?(buat|lanjutkan)|silakan tunggu/i.test(String(r.text || ''));
      const isPlanGap = !asistenMode && toolDecls && !hasImages && noToolsAtAll && String(r.text || '').trim()
        && !hasWriteCall && (buildIntent || identityDone || promiseLanguage)
        && !/\[\[POLL\]\]|\[\[FORM\]\]|\[\[PLUGIN:/i.test(r.text);
      if (isPlanGap && planGapNudgeCount < 2) {
        planGapNudgeCount++;
        workMessages.push({ role: 'assistant', content: r.text });
        workMessages.push({ role: 'user', content: 'Kamu baru menulis rencana/klaim TANPA memanggil tool apa pun — itu janji kosong, bukan progres (lihat aturan (7): dilarang keras). DILARANG mengarang fitur/URL yang tidak pernah disebut sistem (mis. "workspace.clincoo.buzz" atau link publik otomatis) — itu melanggar aturan (3) dilarang mengarang fakta. JANGAN menulis teks apa pun lagi. LANGSUNG panggil tool yang sesuai SEKARANG (write_file untuk tiap file tersisa, generate_image, atau set_project_info) untuk benar-benar melanjutkan pekerjaan.' });

        if (streamSend) { try { streamSend({ t: 'delta', text: '\n\n' }); } catch (e) {} }
        continue;
      }
      const stCalls = (r.tool_calls || []).filter(tc => SERVER_TOOLS_ALL.has(tc.name));
      if (!stCalls.length) break;
      const clientCalls = (r.tool_calls || []).filter(tc => !SERVER_TOOLS_ALL.has(tc.name));
      const results = [];
      for (const tc of stCalls) {
        if (streamSend) streamSend({ t: 'progress', text: serverProgressText(tc) });
        results.push(await executeServerTool(env, user, tc, new URL(request.url).origin, body.project_id));
      }

      workMessages.push({ role: 'assistant', content: (r.tool_calls || []).map(tc => ({ type: 'function_call', name: tc.name, args: tc.args || {}, thought_signature: tc.thought_signature || undefined })) });
      workMessages.push({ role: 'user', content: stCalls.map((tc, i) => ({ type: 'function_response', name: tc.name, result: results[i] })) });

      r.tool_calls = r.tool_calls.map(tc => {
        const i = stCalls.indexOf(tc);
        return i !== -1 ? Object.assign({}, tc, { result: results[i] }) : tc;
      });
      if (clientCalls.length) break;

    }

    if (!toolDecls && r && !r.error && r.tool_calls && r.tool_calls.length) {
      r = { text: String(r.text || ''), model: r.model };
    }
    if (r && !r.error && !String(r.text || '').trim() && !(r.tool_calls && r.tool_calls.length)) {
      const sumPrompt = toolDecls
        ? 'Semua tool sudah selesai dieksekusi dan seluruh hasilnya tercatat di percakapan. Sekarang tulis RINGKASAN FINAL untuk user dalam Bahasa Indonesia: apa yang sudah dikerjakan, status/hasilnya, URL endpoint bila ada, dan contoh pemakaian singkat. Jangan memanggil tool apa pun — langsung tulis jawabannya sekarang.'
        : 'Kamu dipanggil sebagai AI teks murni dan TIDAK punya tool apa pun — dilarang memanggil atau menjanjikan tool/eksekusi apa pun. Jawab permintaan user secara LENGKAP dan BERISI dalam Bahasa Indonesia sebagai teks biasa: kalau diminta dibuatkan situs/kode, tulis kode lengkapnya sebagai blok kode di jawabanmu; kalau diminta penjelasan, jelaskan tuntas. Langsung tulis jawabannya sekarang.';
      const sumMsgs = workMessages.concat([{ role: 'user', content: sumPrompt }]);
      const sm = await executeAiGeneration({
        env,
        mrKeys,
        geminiKeys,
        orKeys,
        messages: sumMsgs,
        toolDecls: null,
        onDelta: null,
        usageAcc: mrUsageAcc
      }).catch(() => null);
      if (sm && !sm.error && String(sm.text || '').trim()) r = { text: sm.text, model: sm.model };
    }
    return r;
    };
    let r = await attemptCascade();

    if ((!r || r.error) && !(r && (r.contextOverflow || r.quotaExhausted))) {
      try { streamSend && streamSend({ t: 'progress', text: 'Retrying…' }); } catch (e) {}
      await new Promise(res => setTimeout(res, 2500));
      r = await attemptCascade();
    }
    if (!r) r = { error: 'Tidak ada provider AI tersedia' };

    if (streamSend) {
      if (r && !r.error) streamSend({ t: 'progress', text: 'Composing answer…' });
      if (r && r.error) {

        const busy = !!r.quotaExhausted;

        const rawErr1 = r.error || '';
        try { await logAiFailure(env, body.project_id, rawErr1, modeLabel + (busy ? ' [429-modelrouter]' : '') + (r.contextOverflow ? ' [konteks-penuh]' : '')); } catch (eLog) {}
        const errText = busy
          ? 'Server AI sedang sibuk (limit provider). Coba lagi sebentar lagi.'
          : (rawErr1 === 'Tidak ada provider AI tersedia' ? rawErr1
             : 'Maaf, AI sedang gangguan sebentar sehingga belum bisa menjawab. Coba kirim ulang pesanmu ya.');
        streamSend({ t: 'error', error: errText, detail: (!busy && rawErr1 && rawErr1 !== errText) ? String(rawErr1).slice(0, 300) : undefined, provider_busy: busy ? true : undefined, quota_exhausted: busy ? undefined : !!r.quotaExhausted, context_overflow: !!r.contextOverflow });
      } else {
        const outS = {
          text: r.text || '',
          model: r.model,
          session_id: body.session_id || ('ls_' + Date.now())
        };
        if (r.tool_calls) outS.tool_calls = r.tool_calls;
        if (r.tool_calls && r.tool_calls.length) {
          try { outS.continue_token = isFirstHop ? await issueCont(env, contOwner) : contToken; } catch (eTok) {}
        }

        const outCharsS = (r.text || '').length + (r.tool_calls ? JSON.stringify(r.tool_calls).length : 0);

        const _mrCostS = mrTokenCost(mrUsageAcc);
        if (!isGuest && (_mrCostS !== null || isFirstHop)) await chargeAiUsage(env, user, r.model, outCharsS, inputChars, true, _mrCostS);
        streamSend({ t: 'final', ...outS });
      }
      streamWriter.close().catch(() => {});
      return;
    }

    if (r.error && r.quotaExhausted) {
      try { await logAiFailure(env, body.project_id, r.error, modeLabel + ' [429-modelrouter]'); } catch (eLog) {}

      return new Response(JSON.stringify({ provider_busy: true, error: 'Server AI sedang sibuk (limit provider). Coba lagi sebentar lagi.' }), {
        status: 429, headers: { 'Content-Type': 'application/json', ...CORS }
      });
    }
    if (r.error && r.contextOverflow) {
      try { await logAiFailure(env, body.project_id, r.error, modeLabel + ' [konteks-penuh]'); } catch (eLog) {}
      return new Response(JSON.stringify({ context_overflow: true, error: 'Konteks percakapan penuh (terlalu banyak kode besar dalam satu chat). Balas "lanjut" untuk meneruskan tugas dengan riwayat yang dipangkas otomatis.' }), {
        status: 429, headers: { 'Content-Type': 'application/json', ...CORS }
      });
    }
    if (r.error) {
      try { await logAiFailure(env, body.project_id, r.error, modeLabel); } catch (eLog) {}

      const friendly = r.error === 'Tidak ada provider AI tersedia' ? r.error
        : 'Maaf, AI sedang gangguan sebentar sehingga belum bisa menjawab. Coba kirim ulang pesanmu ya.';
      return new Response(JSON.stringify({ error: friendly, detail: (r.error !== friendly) ? String(r.error).slice(0, 300) : undefined }), {
        status: 502, headers: { 'Content-Type': 'application/json', ...CORS }
      });
    }

    const outChars = (r.text || '').length + (r.tool_calls ? JSON.stringify(r.tool_calls).length : 0);

    const _mrCost = mrTokenCost(mrUsageAcc);
    if (!isGuest && (_mrCost !== null || isFirstHop)) await chargeAiUsage(env, user, r.model, outChars, inputChars, true, _mrCost);
    const out = {
      text: r.text || '',
      model: r.model,
      session_id: body.session_id || ('ls_' + Date.now())
    };
    if (r.tool_calls) out.tool_calls = r.tool_calls;
    if (r.tool_calls && r.tool_calls.length) {
      try { out.continue_token = isFirstHop ? await issueCont(env, contOwner) : contToken; } catch (eTok) {}
    }
    return new Response(JSON.stringify(out), {
      headers: { 'Content-Type': 'application/json', ...CORS }
    });
    };

    if (useStream) {
      const p = processChat().catch((e) => {
        if (streamSend) streamSend({ t: 'error', error: 'Server error: ' + ((e && e.message) || e) });
        if (streamWriter) streamWriter.close().catch(() => {});
      });
      if (waitUntil) waitUntil(p);
      return new Response(streamReadable, {
        headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-cache', ...CORS }
      });
    }
    return await processChat();
  } catch (err) {
    return new Response(JSON.stringify({ error: 'Server error: ' + err.message }), {
      status: 500, headers: { 'Content-Type': 'application/json', ...CORS }
    });
  }
}
