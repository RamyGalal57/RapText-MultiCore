/**
 * ============================================================================
 * CAPTCHA AUTO-SOLVER - Ω-SUPERVISOR v16.0 (THE SURGEON)
 * ============================================================================
 */

const CONFIG = {
  cbb8a8b7d43c3cfadf6b2fae051c71ebab2f29',
    endpoint: 'https://openrouter.ai/api/v1/chat/completions',
    models: [
      'google/gemini-2.0-flash-exp:free',
      'qwen/qwen-2.5-vl-7b-instruct:free'
    ]
  },
  MISTRAL: {
    key: 'QRjlGifuxzukEXFK3bZziERIhi8giwSo',
    endpoint: 'https://api.mistral.ai/v1/chat/completions',
    model: 'pixtral-12b-2409'
  },
  NOPECHA: {
    key: '', // Enter NoPeCHA key here if available
    endpoint: 'https://api.nopecha.com/v1/recognition/textcaptcha'
  }
};

const state = {
  currentTier: 1, // 1: NoPeCHA, 2: OpenRouter, 3: Mistral Native
  lastSolved: null,
  cache: {}
};

// Persistence
chrome.storage.local.get(['captchaCache'], (res) => {
  if (res.captchaCache) state.cache = res.captchaCache;
});

// ============================================================================
// SOLVER ENGINES
// ============================================================================

/**
 * TIER 1: NOPECHA API (Specialized Solver)
 */
async function solveNoPeCHA(base64Image) {
  if (!CONFIG.NOPECHA.key) throw new Error("NOPECHA_KEY_MISSING");

  const response = await fetch(CONFIG.NOPECHA.endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      key: CONFIG.NOPECHA.key,
      image_data: [base64Image]
    })
  });

  if (!response.ok) throw new Error(`NOPECHA_${response.status}`);
  const data = await response.json();
  
  if (data.data && data.data[0]) return data.data[0];
  throw new Error("NOPECHA_EMPTY");
}

/**
 * TIER 2: OPENROUTER (Verified Free LLMs)
 */
async function solveOpenRouter(base64Image, modelIndex = 0) {
  const model = CONFIG.OPENROUTER.models[modelIndex];
  const response = await fetch(CONFIG.OPENROUTER.endpoint, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${CONFIG.OPENROUTER.key}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://github.com/RapText/MultiCore",
      "X-Title": "RapText MultiCore"
    },
    body: JSON.stringify({
      model: model,
      messages: [{
        role: "user",
        content: [
          { type: "image_url", image_url: { url: base64Image } },
          { type: "text", text: "CAPTCHA characters only. No quotes." }
        ]
      }],
      temperature: 0,
      max_tokens: 10
    })
  });

  if (response.status === 429) throw new Error('RATE_LIMIT');
  if (!response.ok) throw new Error(`OPENROUTER_${response.status}`);

  const json = await response.json();
  const content = json.choices?.[0]?.message?.content;
  if (!content) throw new Error('EMPTY_OR');

  return cleanText(content);
}

/**
 * TIER 3: MISTRAL NATIVE (Last Resort)
 */
async function solveMistral(base64Image) {
  const response = await fetch(CONFIG.MISTRAL.endpoint, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${CONFIG.MISTRAL.key}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: CONFIG.MISTRAL.model,
      messages: [{
        role: "user",
        content: [
          { type: "image_url", image_url: { url: base64Image } },
          { type: "text", text: "Read CAPTCHA." }
        ]
      }]
    })
  });

  if (!response.ok) throw new Error(`MISTRAL_${response.status}`);
  const json = await response.json();
  return cleanText(json.choices[0].message.content);
}

function cleanText(raw) {
  const match = raw.replace(/["' ]/g, '').match(/[A-Za-z0-9]{3,8}/);
  if (!match) throw new Error("UNPARSEABLE");
  return match[0];
}

function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h.toString();
}

// ============================================================================
// ORCHESTRATION
// ============================================================================

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "capture_screen") {
    chrome.tabs.captureVisibleTab(sender.tab.windowId, { format: 'png' }, (d) => sendResponse({ dataUrl: d }));
    return true;
  }

  if (request.action === "solve_captcha") {
    const imgHash = hash(request.base64Image);
    if (state.cache[imgHash]) {
      sendResponse({ text: state.cache[imgHash], status: "⚡ Cached" });
      return false;
    }

    const runSolve = async () => {
      try {
        let result;
        if (state.currentTier === 1) {
          // Attempt NoPeCHA, if key missing, jump to Tier 2
          if (!CONFIG.NOPECHA.key) { state.currentTier = 2; return runSolve(); }
          result = await solveNoPeCHA(request.base64Image);
        } else if (state.currentTier === 2) {
          try {
            result = await solveOpenRouter(request.base64Image, 0);
          } catch (e) {
            result = await solveOpenRouter(request.base64Image, 1);
          }
        } else {
          result = await solveMistral(request.base64Image);
        }

        state.lastSolved = { hash: imgHash, text: result };
        sendResponse({ text: result, status: `T${state.currentTier}` });
      } catch (err) {
        console.error(`[Ω-SURGEON] Tier ${state.currentTier} failed:`, err.message);
        state.currentTier = (state.currentTier % 3) + 1;
        sendResponse({ error: err.message });
      }
    };

    runSolve();
    return true;
  }

  if (request.action === "report_login_success") {
    if (state.lastSolved) {
      state.cache[state.lastSolved.hash] = state.lastSolved.text;
      chrome.storage.local.set({ captchaCache: state.cache });
      state.lastSolved = null;
    }
    return false;
  }

  return false;
});
