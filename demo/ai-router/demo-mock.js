/* DEMO MOCK — interceptor fetch untuk pratinjau console statis.
   File ini HANYA dipakai oleh halaman demo publik; bukan bagian dari
   source template. Semua data di bawah adalah data sampel. */
(function () {
  'use strict';
  var BASE = '/demo/ai-router';

  function daysAgo(n, h, m) {
    var d = new Date();
    d.setDate(d.getDate() - n);
    d.setHours(h, m, 0, 0);
    return d.toISOString();
  }
  function dateOnly(n) { return daysAgo(n, 0, 0).slice(0, 10); }

  var PROVIDERS = [
    { id: 'prov_openrouter', name: 'OpenRouter', providerType: 'openai-compatible', baseUrl: 'https://openrouter.ai/api/v1', priority: 1, timeoutMs: 60000, enabled: true, keyConfigured: true, healthStatus: 'healthy', modelCount: 3, createdAt: daysAgo(42, 9, 12) },
    { id: 'prov_google', name: 'Google AI', providerType: 'openai-compatible', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', priority: 2, timeoutMs: 45000, enabled: true, keyConfigured: true, healthStatus: 'healthy', modelCount: 3, createdAt: daysAgo(40, 10, 4) },
    { id: 'prov_azure', name: 'Azure OpenAI', providerType: 'openai-compatible', baseUrl: 'https://kawata-demo.openai.azure.com/openai', priority: 3, timeoutMs: 90000, enabled: true, keyConfigured: true, healthStatus: 'degraded', modelCount: 2, createdAt: daysAgo(35, 14, 30) },
    { id: 'prov_deepinfra', name: 'DeepInfra', providerType: 'openai-compatible', baseUrl: 'https://api.deepinfra.com/v1/openai', priority: 4, timeoutMs: 60000, enabled: true, keyConfigured: true, healthStatus: 'healthy', modelCount: 2, createdAt: daysAgo(28, 11, 20) },
    { id: 'prov_groq', name: 'Groq', providerType: 'openai-compatible', baseUrl: 'https://api.groq.com/openai/v1', priority: 5, timeoutMs: 30000, enabled: true, keyConfigured: true, healthStatus: 'healthy', modelCount: 2, createdAt: daysAgo(21, 16, 45) },
    { id: 'prov_together', name: 'Together AI', providerType: 'openai-compatible', baseUrl: 'https://api.together.xyz/v1', priority: 6, timeoutMs: 60000, enabled: false, keyConfigured: false, healthStatus: 'unknown', modelCount: 0, createdAt: daysAgo(9, 13, 5) }
  ];

  var MODELS = [
    { id: 'mdl_gemini_pro', providerId: 'prov_google', providerName: 'Google AI', name: 'kawata/gemini-2.5-pro', modelName: 'gemini-2.5-pro', contextWindow: 1048576, inputPricePerMillion: 1.25, outputPricePerMillion: 10, supportsStreaming: true, supportsVision: true, supportsTools: true, enabled: true },
    { id: 'mdl_gemini_flash', providerId: 'prov_google', providerName: 'Google AI', name: 'kawata/gemini-2.5-flash', modelName: 'gemini-2.5-flash', contextWindow: 1048576, inputPricePerMillion: 0.3, outputPricePerMillion: 2.5, supportsStreaming: true, supportsVision: true, supportsTools: true, enabled: true },
    { id: 'mdl_gemini_nano', providerId: 'prov_google', providerName: 'Google AI', name: 'kawata/gemini-2.0-flash-lite', modelName: 'gemini-2.0-flash-lite', contextWindow: 1048576, inputPricePerMillion: 0.1, outputPricePerMillion: 0.4, supportsStreaming: true, supportsVision: true, supportsTools: true, enabled: true },
    { id: 'mdl_llama_scout', providerId: 'prov_openrouter', providerName: 'OpenRouter', name: 'kawata/llama-4-scout', modelName: 'meta-llama/llama-4-scout', contextWindow: 262144, inputPricePerMillion: 0.11, outputPricePerMillion: 0.34, supportsStreaming: true, supportsVision: true, supportsTools: true, enabled: true },
    { id: 'mdl_gpt_mini', providerId: 'prov_azure', providerName: 'Azure OpenAI', name: 'kawata/gpt-5-mini', modelName: 'gpt-5-mini', contextWindow: 262144, inputPricePerMillion: 0.25, outputPricePerMillion: 2, supportsStreaming: true, supportsVision: true, supportsTools: true, enabled: true },
    { id: 'mdl_gpt_5', providerId: 'prov_azure', providerName: 'Azure OpenAI', name: 'kawata/gpt-5', modelName: 'gpt-5', contextWindow: 262144, inputPricePerMillion: 1.25, outputPricePerMillion: 10, supportsStreaming: true, supportsVision: true, supportsTools: true, enabled: true },
    { id: 'mdl_qwen_coder', providerId: 'prov_deepinfra', providerName: 'DeepInfra', name: 'kawata/qwen3-coder', modelName: 'Qwen/Qwen3-Coder', contextWindow: 262144, inputPricePerMillion: 0.16, outputPricePerMillion: 0.6, supportsStreaming: true, supportsVision: false, supportsTools: true, enabled: true },
    { id: 'mdl_llama_70b', providerId: 'prov_deepinfra', providerName: 'DeepInfra', name: 'kawata/llama-3.3-70b', modelName: 'meta-llama/Llama-3.3-70B-Instruct', contextWindow: 131072, inputPricePerMillion: 0.08, outputPricePerMillion: 0.25, supportsStreaming: true, supportsVision: false, supportsTools: true, enabled: true },
    { id: 'mdl_llama_instant', providerId: 'prov_groq', providerName: 'Groq', name: 'kawata/llama-3.1-8b-instant', modelName: 'llama-3.1-8b-instant', contextWindow: 131072, inputPricePerMillion: 0.05, outputPricePerMillion: 0.08, supportsStreaming: true, supportsVision: false, supportsTools: true, enabled: true },
    { id: 'mdl_mixtral', providerId: 'prov_groq', providerName: 'Groq', name: 'kawata/mixtral-8x7b', modelName: 'mixtral-8x7b-32768', contextWindow: 32768, inputPricePerMillion: 0.24, outputPricePerMillion: 0.24, supportsStreaming: true, supportsVision: false, supportsTools: true, enabled: true }
  ];

  var API_KEYS = [
    { id: 'key_prod', name: 'Server produksi', prefix: 'kawata_prod_9fB2…', status: 'active', lastUsedAt: daysAgo(0, 9, 12), createdAt: daysAgo(60, 8, 30) },
    { id: 'key_staging', name: 'Staging pipeline', prefix: 'kawata_stg_C71d…', status: 'active', lastUsedAt: daysAgo(1, 18, 40), createdAt: daysAgo(31, 15, 10) },
    { id: 'key_personal', name: 'Eksperimen pribadi', prefix: 'kawata_dev_04aE…', status: 'revoked', lastUsedAt: daysAgo(12, 20, 5), createdAt: daysAgo(45, 11, 25) }
  ];

  var MODEL_NAMES = MODELS.map(function (m) { return m.name; });
  var PROVIDER_NAMES = {};
  MODELS.forEach(function (m) { PROVIDER_NAMES[m.name] = m.providerName; });
  function usageRecord(i, dayOffset, hour, minute) {
    var model = MODEL_NAMES[i % MODEL_NAMES.length];
    var inTok = 180 + ((i * 137) % 1400);
    var outTok = 120 + ((i * 89) % 900);
    var latency = 380 + ((i * 173) % 950);
    return {
      id: 'req_' + (1000 + i),
      requestId: 'req_demo_' + (1000 + i),
      model: model,
      provider: PROVIDER_NAMES[model],
      inputTokens: inTok,
      outputTokens: outTok,
      totalTokens: inTok + outTok,
      latencyMs: latency,
      providerCost: Math.round((inTok * 0.4 + outTok * 1.1)) / 10000,
      userCost: Math.round((inTok * 0.44 + outTok * 1.21)) / 10000,
      status: i % 19 === 3 ? 'error' : i % 11 === 5 ? 'retry' : 'success',
      error: i % 19 === 3 ? 'provider timeout setelah 30000 ms' : null,
      createdAt: daysAgo(dayOffset, hour, minute)
    };
  }
  var RECENT_USAGE = [
    usageRecord(0, 0, 9, 41), usageRecord(1, 0, 9, 40), usageRecord(2, 0, 9, 39),
    usageRecord(3, 0, 9, 38), usageRecord(4, 0, 9, 37), usageRecord(5, 0, 9, 35),
    usageRecord(6, 0, 9, 33), usageRecord(7, 0, 9, 31)
  ];

  var DAILY = [];
  for (var d = 13; d >= 0; d--) {
    var requests = 6200 + ((d * 17 + 11) % 37) * 90 + (d % 3 === 0 ? 900 : 0) - (d === 8 ? 700 : 0);
    var tokens = requests * (310 + (d % 5) * 9);
    DAILY.push({
      date: dateOnly(d),
      requests: requests,
      tokens: tokens,
      cost: Math.round(requests * 0.0117 * 100) / 100
    });
  }

  var DASHBOARD = {
    totalRequests: 128406,
    totalTokens: 42178233,
    totalSpend: 128.44,
    avgLatencyMs: 843,
    errorRate: 0.42,
    creditBalance: 257.2,
    activeProviders: 5,
    activeModels: 9,
    daily: DAILY,
    recentUsage: RECENT_USAGE
  };

  var CREDITS = {
    balance: 257.2,
    transactions: [
      { id: 'tx_01', type: 'credit', amount: 100, balanceAfter: 300, description: 'Top-up kredit bulanan', createdAt: daysAgo(14, 8, 0) },
      { id: 'tx_02', type: 'debit', amount: 18.42, balanceAfter: 281.58, description: 'Pemakaian gateway 30 Sep', createdAt: daysAgo(8, 0, 5) },
      { id: 'tx_03', type: 'debit', amount: 12.9, balanceAfter: 268.68, description: 'Pemakaian gateway 1 Okt', createdAt: daysAgo(7, 0, 5) },
      { id: 'tx_04', type: 'refund', amount: 1.02, balanceAfter: 269.7, description: 'Refund request gagal (timeout provider)', createdAt: daysAgo(6, 13, 42) },
      { id: 'tx_05', type: 'debit', amount: 9.15, balanceAfter: 260.55, description: 'Pemakaian gateway 3 Okt', createdAt: daysAgo(5, 0, 5) },
      { id: 'tx_06', type: 'adjustment', amount: 20, balanceAfter: 280.55, description: 'Kredit uji coba tim internal', createdAt: daysAgo(4, 10, 15) },
      { id: 'tx_07', type: 'debit', amount: 14.3, balanceAfter: 266.25, description: 'Pemakaian gateway 5 Okt', createdAt: daysAgo(3, 0, 5) },
      { id: 'tx_08', type: 'debit', amount: 6.8, balanceAfter: 259.45, description: 'Pemakaian gateway 6 Okt', createdAt: daysAgo(2, 0, 5) },
      { id: 'tx_09', type: 'debit', amount: 1.9, balanceAfter: 257.55, description: 'Pemakaian gateway 7 Okt', createdAt: daysAgo(1, 0, 5) },
      { id: 'tx_10', type: 'debit', amount: 0.35, balanceAfter: 257.2, description: 'Pemakaian gateway hari ini', createdAt: daysAgo(0, 9, 30) }
    ]
  };

  var ROUTING = { strategy: 'priority', markupPercent: 10, fallbackEnabled: true };

  var ME = { id: 'user_demo', email: 'akhmad@clincoo.buzz', displayName: 'Akhmad Rifai', role: 'admin', creditBalance: 257.2 };

  var USAGE_TOTAL = 1284;
  function usagePage(page, pageSize, search) {
    var all = [];
    for (var i = 0; i < 23; i++) {
      var dayOffset = Math.floor(i / 3);
      all.push(usageRecord(i + 2, dayOffset, 8 + (i % 6), (i * 17) % 60));
    }
    if (search) {
      var q = search.toLowerCase();
      all = all.filter(function (r) { return r.model.toLowerCase().indexOf(q) !== -1 || r.provider.toLowerCase().indexOf(q) !== -1 || r.requestId.toLowerCase().indexOf(q) !== -1; });
    }
    var start = (page - 1) * pageSize;
    return { items: all.slice(start, start + pageSize), page: page, pageSize: pageSize, total: search ? all.length : USAGE_TOTAL };
  }

  var ROUTES = [
    { method: 'GET', pattern: /^\/api\/healthz$/, handler: function () { return { status: 'ok' }; } },
    { method: 'GET', pattern: /^\/api\/me$/, handler: function () { return ME; } },
    { method: 'GET', pattern: /^\/api\/dashboard$/, handler: function () { return DASHBOARD; } },
    { method: 'GET', pattern: /^\/api\/providers$/, handler: function () { return PROVIDERS; } },
    { method: 'GET', pattern: /^\/api\/models$/, handler: function () { return MODELS; } },
    { method: 'GET', pattern: /^\/api\/api-keys$/, handler: function () { return API_KEYS; } },
    { method: 'GET', pattern: /^\/api\/credits$/, handler: function () { return CREDITS; } },
    { method: 'GET', pattern: /^\/api\/routing-settings$/, handler: function () { return ROUTING; } },
    { method: 'GET', pattern: /^\/api\/v1\/models$/, handler: function () {
        return { object: 'list', data: MODELS.map(function (m) { return { id: m.modelName, object: 'model', owned_by: m.providerName }; }) };
      } }
  ];

  function json(request, data, status) {
    return Promise.resolve(new Response(JSON.stringify(data), {
      status: status || 200,
      headers: { 'Content-Type': 'application/json', 'x-demo-mode': 'static-preview' }
    }));
  }

  var realFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    var method = ((init && init.method) || 'GET').toUpperCase();
    if (url.indexOf(BASE + '/') === 0) url = url.slice(BASE.length) || '/';
    if (url.charAt(0) !== '/') return realFetch(input, init);

    var pathOnly = url.split('?')[0];
    var params = {};
    var qs = url.split('?')[1];
    if (qs) qs.split('&').forEach(function (pair) {
      var kv = pair.split('=');
      params[decodeURIComponent(kv[0])] = decodeURIComponent(kv[1] || '');
    });

    var i, match;
    for (i = 0; i < ROUTES.length; i++) {
      if (method === ROUTES[i].method && ROUTES[i].pattern.test(pathOnly)) return json(null, ROUTES[i].handler(params));
    }

    // ---- Mutations (demo: balas dengan data hasil) ----
    var body = {};
    try { body = init && init.body ? JSON.parse(init.body) : {}; } catch (e) {}

    if (method === 'POST' && /^\/api\/providers$/.test(pathOnly)) {
      var np = JSON.parse(JSON.stringify(PROVIDERS[0]));
      np.id = 'prov_demo_' + Date.now(); np.name = body.name || 'Provider baru';
      np.providerType = body.providerType || 'openai-compatible'; np.baseUrl = body.baseUrl || '';
      np.priority = body.priority || 1; np.enabled = true; np.keyConfigured = true;
      np.healthStatus = 'unknown'; np.modelCount = 0; np.createdAt = new Date().toISOString();
      PROVIDERS.push(np); return json(null, np, 201);
    }
    match = pathOnly.match(/^\/api\/providers\/([^/]+)$/);
    if (match) {
      if (method === 'PATCH') {
        for (var pi = 0; pi < PROVIDERS.length; pi++) if (PROVIDERS[pi].id === match[1]) {
          Object.keys(body).forEach(function (k) { if (k !== 'id' && k !== 'apiKey') PROVIDERS[pi][k] = body[k]; });
          return json(null, PROVIDERS[pi]);
        }
      }
      if (method === 'DELETE') return json(null, { success: true });
      if (method === 'POST') return json(null, []);
    }
    if (method === 'POST' && /^\/api\/providers\/([^/]+)\/models$/.test(pathOnly)) return json(null, []);
    if (method === 'POST' && /^\/api\/models$/.test(pathOnly)) {
      var nm = JSON.parse(JSON.stringify(MODELS[0]));
      nm.id = 'mdl_demo_' + Date.now(); nm.providerId = body.providerId || 'prov_demo';
      nm.providerName = 'Demo'; nm.name = body.name || 'kawata/model-baru'; nm.modelName = body.modelName || 'model-baru';
      nm.contextWindow = body.contextWindow || 131072;
      nm.inputPricePerMillion = body.inputPricePerMillion || 0; nm.outputPricePerMillion = body.outputPricePerMillion || 0;
      nm.supportsStreaming = !!body.supportsStreaming; nm.supportsVision = !!body.supportsVision; nm.supportsTools = !!body.supportsTools;
      nm.enabled = true; MODELS.push(nm); return json(null, nm, 201);
    }
    match = pathOnly.match(/^\/api\/models\/([^/]+)$/);
    if (match) {
      if (method === 'PATCH') {
        for (var mi = 0; mi < MODELS.length; mi++) if (MODELS[mi].id === match[1]) {
          Object.keys(body).forEach(function (k) { MODELS[mi][k] = body[k]; });
          return json(null, MODELS[mi]);
        }
      }
      if (method === 'DELETE') return json(null, { success: true });
    }
    if (method === 'POST' && /^\/api\/api-keys$/.test(pathOnly)) {
      var nk = { id: 'key_demo_' + Date.now(), name: body.name || 'Kunci baru', prefix: 'kawata_prod_' + Math.random().toString(36).slice(2, 6) + '…', status: 'active', lastUsedAt: null, createdAt: new Date().toISOString() };
      API_KEYS.push(nk);
      return json(null, { key: nk, secret: 'kawata_prod_demo_secret_jangan_dipakai_di_produksi' }, 201);
    }
    match = pathOnly.match(/^\/api\/api-keys\/([^/]+)$/);
    if (match && method === 'DELETE') {
      for (var ki = 0; ki < API_KEYS.length; ki++) if (API_KEYS[ki].id === match[1]) API_KEYS[ki].status = 'revoked';
      return json(null, { success: true });
    }
    if (method === 'GET' && /^\/api\/usage$/.test(pathOnly)) {
      return json(null, usagePage(parseInt(params.page, 10) || 1, parseInt(params.pageSize, 10) || 20, params.search || ''));
    }
    if (method === 'PUT' && /^\/api\/routing-settings$/.test(pathOnly)) {
      ROUTING.strategy = body.strategy || ROUTING.strategy;
      ROUTING.markupPercent = typeof body.markupPercent === 'number' ? body.markupPercent : ROUTING.markupPercent;
      ROUTING.fallbackEnabled = typeof body.fallbackEnabled === 'boolean' ? body.fallbackEnabled : ROUTING.fallbackEnabled;
      return json(null, ROUTING);
    }
    if (method === 'POST' && /^\/api\/v1\/chat\/completions$/.test(pathOnly)) {
      var asked = '';
      try {
        (body.messages || []).forEach(function (m) { if (m.role === 'user' && typeof m.content === 'string') asked = m.content; });
      } catch (e) {}
      return json(null, {
        id: 'chatcmpl_demo_' + Date.now(),
        object: 'chat.completion',
        model: body.model || 'kawata-demo',
        choices: [{ index: 0, message: { role: 'assistant', content: 'Respons contoh dari mode demo console Kawata — halaman ini pratinjau statis dengan data sampel, jadi tidak ada request nyata yang dikirim ke provider.' + (asked ? '\n\nPrompt Anda: "' + asked.slice(0, 120) + '"' : '') }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 48, completion_tokens: 64, total_tokens: 112 }
      });
    }

    return realFetch(input, init);
  };
})();
