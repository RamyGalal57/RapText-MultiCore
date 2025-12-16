/**
 * ============================================================================
 * CAPTCHA AUTO-SOLVER - BACKGROUND SERVICE WORKER (ALTERNATE)
 * ============================================================================
 *
 * 3-TIER FAILOVER ARCHITECTURE (DUAL-MODEL PER TIER):
 * 1. PRIMARY (Tier 1): Google Gemini 2.0 Flash -> Google Gemini 2.0 Pro
 * 2. BACKUP (Tier 2): Amazon Nova 2 Lite -> Mistral Small 3.1
 * 3. FALLBACK (Tier 3): NoPeCHA API (last resort)
 *
 * @version 8.1
 */

// ============================================================================
// CONFIGURATION
// ============================================================================

const OPENROUTER_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

const FAILOVER_CONFIG = {
  tier1Models: [
    'google/gemini-2.0-flash-exp:free',
    'google/gemini-2.0-pro-exp-02-05:free'
  ],
  tier2Models: [
    'amazon/nova-lite-v1:1.0',
    'mistralai/mistral-small-24b-instruct-2501:free'
  ],
  cooldownMs: 5 * 60 * 1000,
  triggerCodes: [429, 503, 404, 400, 500, 502],
  timeoutMs: 35000
};

const NOPECHA_CONFIG = {
  apiKey: '',
  submitEndpoint: 'https://api.nopecha.com/v1/recognition/textcaptcha',
  retrieveEndpoint: 'https://api.nopecha.com/v1/recognition/textcaptcha',
  pollIntervalMs: 500,
  maxPollAttempts: 20
};

const failoverState = {
  currentTier: 1,
  modelIndex: 0,
  lastFailoverTime: null
};

// ============================================================================
// API KEY MANAGEMENT
// ============================================================================

function getApiKey() {
  return new Promise((resolve, reject) => {
    chrome.storage.sync.get(['openrouter_api_key'], (result) => {
      if (chrome.runtime.lastError) {
        return reject(chrome.runtime.lastError);
      }
      if (result.openrouter_api_key) {
        resolve(result.openrouter_api_key);
      } else {
        reject(new Error('API key not found. Please set it on the options page.'));
      }
    });
  });
}

// ============================================================================
// STATUS & STATE MANAGEMENT
// ============================================================================

function getStatusIndicator() {
  const modelName = getCurrentModelName();
  switch (failoverState.currentTier) {
    case 1: return `🟢 Tier1-${modelName}`;
    case 2: return `🟡 Tier2-${modelName}`;
    case 3: return '🟠 Tier3-NoPeCHA';
    default: return '🔴 All Down';
  }
}

function getCurrentModelName() {
  if (failoverState.currentTier === 1) {
    return FAILOVER_CONFIG.tier1Models[failoverState.modelIndex] || 'Unknown';
  }
  if (failoverState.currentTier === 2) {
    return FAILOVER_CONFIG.tier2Models[failoverState.modelIndex] || 'Unknown';
  }
  return 'NoPeCHA';
}

function checkCooldownRecovery() {
  if (failoverState.currentTier > 1 && failoverState.lastFailoverTime) {
    const elapsed = Date.now() - failoverState.lastFailoverTime;
    if (elapsed >= FAILOVER_CONFIG.cooldownMs) {
      console.log(`[CAPTCHA] ${getStatusIndicator()} → Cooldown expired, recovering to Tier 1`);
      failoverState.currentTier = 1;
      failoverState.modelIndex = 0;
      failoverState.lastFailoverTime = null;
    }
  }
}

function advanceFailover(reason) {
    const prevStatus = getStatusIndicator();
    let nextTier = failoverState.currentTier;
    let nextIndex = failoverState.modelIndex + 1;

    let maxIndex = 0;
    if (failoverState.currentTier === 1) maxIndex = FAILOVER_CONFIG.tier1Models.length - 1;
    else if (failoverState.currentTier === 2) maxIndex = FAILOVER_CONFIG.tier2Models.length - 1;

    if (nextIndex > maxIndex) {
        nextTier++;
        nextIndex = 0;
    }

    failoverState.currentTier = nextTier;
    failoverState.modelIndex = nextIndex;
    failoverState.lastFailoverTime = Date.now();

    if (failoverState.currentTier > 3) {
        failoverState.currentTier = 4; // All down
        console.log(`[CAPTCHA] FAILOVER: ${prevStatus} → 🔴 All Down. Reason: ${reason}`);
    } else {
        console.log(`[CAPTCHA] FAILOVER: ${prevStatus} → ${getStatusIndicator()}. Reason: ${reason}`);
    }
}


function shouldFailover(statusCode, error) {
  if (FAILOVER_CONFIG.triggerCodes.includes(statusCode)) return true;
  if (error?.name === 'AbortError') return true;
  if (error?.message?.includes('empty')) return true;
  if (error?.message?.includes('Failed to extract')) return true;
  return false;
}

// ============================================================================
// MESSAGE LISTENER
// ============================================================================

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "capture_screen") {
    chrome.tabs.captureVisibleTab(sender.tab.windowId, { format: 'png' }, (dataUrl) => {
      if (chrome.runtime.lastError) {
        sendResponse({ error: chrome.runtime.lastError.message });
      } else {
        sendResponse({ dataUrl });
      }
    });
    return true;
  }

  if (request.action === "solve_captcha") {
    handleCaptchaSolve(request.base64Image, sendResponse);
    return true; // Indicates asynchronous response
  }
  return false;
});

// ============================================================================
// MAIN SOLVE HANDLER
// ============================================================================

async function handleCaptchaSolve(base64Image, sendResponse) {
  checkCooldownRecovery();
  console.log(`[CAPTCHA] ${getStatusIndicator()} Starting solve...`);

  try {
    const apiKey = await getApiKey();
    const text = await solveWithFailover(base64Image, apiKey);
    sendResponse({ text, status: getStatusIndicator() });
  } catch (error) {
    console.error(`[CAPTCHA] ${getStatusIndicator()} Fatal error:`, error.message);
    sendResponse({ error: error.message, status: getStatusIndicator() });
  }
}

async function solveWithFailover(base64Image, apiKey) {
  let lastError = null;

  while (failoverState.currentTier <= 3) {
    try {
      let result;
      const currentTier = failoverState.currentTier;
      const currentIndex = failoverState.modelIndex;

      if (currentTier === 1) {
        const model = FAILOVER_CONFIG.tier1Models[currentIndex];
        console.log(`[CAPTCHA] Trying Tier 1.${currentIndex + 1}: ${model}...`);
        result = await executeOpenRouterRequest(base64Image, model, apiKey);
      } else if (currentTier === 2) {
        const model = FAILOVER_CONFIG.tier2Models[currentIndex];
        console.log(`[CAPTCHA] Trying Tier 2.${currentIndex + 1}: ${model}...`);
        result = await executeOpenRouterRequest(base64Image, model, apiKey);
      } else if (currentTier === 3) {
        console.log(`[CAPTCHA] Trying Tier 3: NoPeCHA...`);
        result = await solveCaptchaWithNoPeCHA(base64Image);
      }

      console.log(`[CAPTCHA] ${getStatusIndicator()} Success:`, result);
      return result;

    } catch (error) {
      lastError = error;
      const modelName = getCurrentModelName();
      console.warn(`[CAPTCHA] ${modelName} failed:`, error.message);

      if (shouldFailover(error.statusCode, error)) {
        advanceFailover(`${modelName}: ${error.message}`);
      } else {
        throw error; // Non-retryable error
      }
    }
  }
  throw lastError || new Error('All tiers exhausted');
}

// ============================================================================
// API IMPLEMENTATIONS
// ============================================================================

async function executeOpenRouterRequest(base64Image, model, apiKey) {
  if (!apiKey) {
      const err = new Error('API key is missing.');
      err.statusCode = 401; // Unauthorized
      throw err;
  }

  const payload = {
    model,
    messages: [{
      role: "user",
      content: [
        { type: "image_url", image_url: { url: base64Image } },
        { type: "text", text: "Read the CAPTCHA text. Reply with ONLY the exact characters." }
      ]
    }],
    temperature: 0.1,
    max_tokens: 50
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FAILOVER_CONFIG.timeoutMs);

  let response;
  try {
    response = await fetch(OPENROUTER_ENDPOINT, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "X-Title": "CAPTCHA Auto-Solver"
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
  } catch (fetchError) {
    if (fetchError.name === 'AbortError') {
      const err = new Error(`Timeout after ${FAILOVER_CONFIG.timeoutMs}ms`);
      err.statusCode = 408;
      throw err;
    }
    throw fetchError;
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    const body = await response.text();
    const err = new Error(`API error ${response.status}: ${body}`);
    err.statusCode = response.status;
    throw err;
  }

  const json = await response.json();
  if (!json.choices?.[0]?.message?.content) {
    const err = new Error('Empty response from API');
    err.statusCode = 0; // Custom code for empty response
    throw err;
  }
  return cleanCaptchaText(json.choices[0].message.content);
}

async function solveCaptchaWithNoPeCHA(base64Image) {
  const nopechaApiKey = await new Promise((resolve) => {
    chrome.storage.sync.get(['nopecha_api_key'], (result) => {
      resolve(result.nopecha_api_key);
    });
  });

  if (!base64Image || typeof base64Image !== 'string') {
    throw new Error('Invalid image data');
  }

  console.log('[CAPTCHA] NoPeCHA: Submitting...');
  const submitResponse = await fetch(NOPECHA_CONFIG.submitEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(nopechaApiKey && { 'Authorization': `Basic ${nopechaApiKey}` })
    },
    body: JSON.stringify({ image_data: [base64Image] })
  });

  if (!submitResponse.ok) {
    const body = await submitResponse.text();
    const err = new Error(`NoPeCHA submit error ${submitResponse.status}: ${body}`);
    err.statusCode = submitResponse.status;
    throw err;
  }

  const submitResult = await submitResponse.json();
  const jobId = submitResult.data;

  if (!jobId) {
    const err = new Error('NoPeCHA: No job ID returned');
    err.statusCode = 0;
    throw err;
  }

  console.log('[CAPTCHA] NoPeCHA: Polling for result...');

  for (let attempt = 1; attempt <= NOPECHA_CONFIG.maxPollAttempts; attempt++) {
    await sleep(NOPECHA_CONFIG.pollIntervalMs);

    const retrieveResponse = await fetch(`${NOPECHA_CONFIG.retrieveEndpoint}?id=${jobId}`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(nopechaApiKey && { 'Authorization': `Basic ${nopechaApiKey}` })
      }
    });

    if (!retrieveResponse.ok) {
      if (retrieveResponse.status === 202) continue;
      const body = await retrieveResponse.text();
      const err = new Error(`NoPeCHA retrieve error ${retrieveResponse.status}: ${body}`);
      err.statusCode = retrieveResponse.status;
      throw err;
    }

    const result = await retrieveResponse.json();

    if (result.data?.[0] && typeof result.data[0] === 'string' && result.data[0].length > 0) {
      return result.data[0];
    }

    if (result.error) {
      const err = new Error(`NoPeCHA: ${result.error}`);
      err.statusCode = 0;
      throw err;
    }
  }

  const err = new Error('NoPeCHA: Timeout waiting for result');
  err.statusCode = 408;
  throw err;
}


// ============================================================================
// TEXT CLEANING & INIT
// ============================================================================

function cleanCaptchaText(rawText) {
    let text = rawText.trim();
    const cleaned = text.replace(/[^A-Za-z0-9]/g, '');
    if (cleaned.length >= 3 && cleaned.length <= 8) {
        return cleaned;
    }
    throw new Error(`Failed to extract valid CAPTCHA from: "${text.substring(0, 50)}..."`);
}

function init() {
    chrome.runtime.onInstalled.addListener((details) => {
        if (details.reason === 'install') {
            chrome.runtime.openOptionsPage();
        }
    });

    console.log('[CAPTCHA] ========================================');
    console.log('[CAPTCHA] Background service worker (v8.1)');
    console.log('[CAPTCHA] ========================================');
    console.log('[CAPTCHA] Tier 1:', FAILOVER_CONFIG.tier1Models.join(' -> '));
    console.log('[CAPTCHA] Tier 2:', FAILOVER_CONFIG.tier2Models.join(' -> '));
    console.log('[CAPTCHA] Tier 3: NoPeCHA API');
    console.log(`[CAPTCHA] ${getStatusIndicator()} Ready`);
}

init();
