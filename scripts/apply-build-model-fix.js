/**
 * Restore full chat.js then switch Build mode to Claude/GPT via OpenRouter.
 */
const fs = require('fs');
const { execSync } = require('child_process');
const path = 'functions/api/chat.js';

// Restore full file from known-good commit (246497 bytes)
try {
  execSync('git show 4b9ad675f18295f97af023b5b5920f85e656f7a0:functions/api/chat.js > ' + path, { stdio: 'inherit' });
} catch (e) {
  console.error('git show failed', e.message);
  process.exit(1);
}

let s = fs.readFileSync(path, 'utf8');
console.log('Restored size', s.length);

if (s.includes('BUILD_OR_MODELS')) {
  console.log('Already has BUILD_OR_MODELS');
  process.exit(0);
}

const oldOr = "const OPENROUTER_MODELS = ['openai/gpt-6-luna-pro']; // [10 Okt] haiku & glm DILARANG pemilik\n";
const newOr = `const OPENROUTER_MODELS = ['openai/gpt-6-luna-pro']; // [10 Okt] haiku & glm DILARANG pemilik
// [11 Okt] Mode Build: Claude Sonnet + GPT langsung via OpenRouter
const BUILD_OR_MODELS = ['anthropic/claude-sonnet-5.5', 'openai/gpt-6-luna-pro'];
`;
if (!s.includes(oldOr)) {
  // try alternate anchors
  const alt = s.match(/const OPENROUTER_MODELS = \[[^\]]+\];[^\n]*\n/);
  console.error('OR anchor missing. Found:', alt && alt[0]);
  process.exit(1);
}
s = s.replace(oldOr, newOr);

const oldBuild = `      if (buildMode && (!r || r.error)) {
        // AI 2 / Build: gunakan model Clouvia yang sudah terdaftar/tersedia.
        // ModelRouter dan Gemini dipertahankan sebagai fallback jika Clouvia gagal.
        if (cvKeysEarly.length) {
          const cvBuild = await withTimeout(
            tryClouviaText(
              cvKeysEarly, workMessages, toolDecls, CLOUVIA_MODELS,
              streamSend ? ((tx) => streamSend({ t: 'delta', text: tx })) : null
            ),
            40000,
            'Clouvia-Build-coding-high-flash'
          ).catch(e => ({ error: e.message }));
          if (cvBuild && !cvBuild.error && (cvBuild.text || cvBuild.tool_calls)) r = cvBuild;
        }
        if ((!r || r.error) && mrKeys.length) {
          let mrDelta = '';
          const mr = await withTimeout(
            tryModelRouterText(
              mrKeys, workMessages, toolDecls, MODELROUTER_MODELS,
              (tx) => { mrDelta += String(tx || ''); },
              mrUsageAcc
            ),
            14000,
            'ModelRouter-Build-fallback'
          ).catch(e => ({ error: e.message }));
          if (mr && !mr.error && (mr.text || mr.tool_calls)) {
            r = mr;
            if (mrDelta && streamSend) streamSend({ t: 'delta', text: mrDelta });
          }
        }
        if (!r || r.error) {
          try {
            const gKeys = await getGeminiKeys(env);
            if (gKeys && gKeys.length) {
              const { systemInstruction, contents } = toGeminiPayload(workMessages);
              const gem = await withTimeout(tryModels(gKeys, systemInstruction, contents, gTools, streamSend ? ((tx) => streamSend({ t: 'delta', text: tx })) : null), 45000, 'Gemini-build-fallback').catch(e => ({ error: e.message }));
              if (gem && !gem.error && (gem.text || gem.tool_calls)) r = gem;
            }
          } catch (e) {}
        }
      }
`;

const newBuild = `      if (buildMode && (!r || r.error)) {
        // [11 Okt] AI 2 / Build: Claude/GPT OpenRouter → Clouvia Sonnet → ModelRouter → Gemini
        if (orKeysEarly.length) {
          const orBuild = await withTimeout(
            tryOpenRouterText(
              orKeysEarly, workMessages, toolDecls, BUILD_OR_MODELS,
              streamSend ? ((tx) => streamSend({ t: 'delta', text: tx })) : null
            ),
            90000,
            'OpenRouter-Build-Claude-GPT'
          ).catch(e => ({ error: e.message }));
          if (orBuild && !orBuild.error && (orBuild.text || orBuild.tool_calls)) r = orBuild;
        }
        if ((!r || r.error) && cvKeysEarly.length) {
          const cvBuild = await withTimeout(
            tryClouviaText(
              cvKeysEarly, workMessages, toolDecls, CLOUVIA_SOL_MODELS,
              streamSend ? ((tx) => streamSend({ t: 'delta', text: tx })) : null
            ),
            60000,
            'Clouvia-Build-Claude-Sonnet'
          ).catch(e => ({ error: e.message }));
          if (cvBuild && !cvBuild.error && (cvBuild.text || cvBuild.tool_calls)) r = cvBuild;
        }
        if ((!r || r.error) && mrKeys.length) {
          let mrDelta = '';
          const mr = await withTimeout(
            tryModelRouterText(
              mrKeys, workMessages, toolDecls, MODELROUTER_MODELS,
              (tx) => { mrDelta += String(tx || ''); },
              mrUsageAcc
            ),
            30000,
            'ModelRouter-Build-fallback'
          ).catch(e => ({ error: e.message }));
          if (mr && !mr.error && (mr.text || mr.tool_calls)) {
            r = mr;
            if (mrDelta && streamSend) streamSend({ t: 'delta', text: mrDelta });
          }
        }
        if (!r || r.error) {
          try {
            const gKeys = await getGeminiKeys(env);
            if (gKeys && gKeys.length) {
              const { systemInstruction, contents } = toGeminiPayload(workMessages);
              const gem = await withTimeout(tryModels(gKeys, systemInstruction, contents, gTools, streamSend ? ((tx) => streamSend({ t: 'delta', text: tx })) : null), 45000, 'Gemini-build-fallback').catch(e => ({ error: e.message }));
              if (gem && !gem.error && (gem.text || gem.tool_calls)) r = gem;
            }
          } catch (e) {}
        }
      }
`;

if (!s.includes(oldBuild)) {
  console.error('build block missing');
  // show nearby lines for debug
  const i = s.indexOf('buildMode');
  console.error(s.slice(Math.max(0,i), i+200));
  process.exit(1);
}
s = s.replace(oldBuild, newBuild);
fs.writeFileSync(path, s);
console.log('Patched OK, size', s.length);
