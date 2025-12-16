/**
 * ============================================================================
 * CAPTCHA AUTO-SOLVER - CONTENT SCRIPT
 * ============================================================================
 * 
 * Advanced detection with:
 * - Login state tracking (stops after successful login)
 * - Debounced mutation handling (prevents spam)
 * - Smart visibility detection with multiple strategies
 * - Graceful cleanup and resource management
 * 
 * @version 2.0
 */

console.log('[CAPTCHA] Content script loaded');

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
  // Target element IDs
  captchaImageId: 'CaptchaImage',
  captchaInputId: 'CaptchaInputText',
  rememberCheckboxId: 'rembChk',
  
  // Login detection - elements that indicate successful login
  loginSuccessIndicators: [
    // Add selectors that appear after login
    '.user-profile',
    '.logout-btn',
    '#logout',
    '.dashboard',
    '[data-logged-in="true"]',
    '.welcome-user'
  ],
  
  // Modal/login form indicators (when these disappear, user logged in)
  loginModalSelectors: [
    '#loginModal',
    '.login-modal',
    '.modal-login',
    '[data-modal="login"]'
  ],
  
  // Timing
  debounceMs: 500,
  visibilityTimeoutMs: 10000,    // Increased: 10 seconds for slow-loading images
  visibilityPollMs: 150,
  postVisibilityDelayMs: 500,    // Increased: more time for render
  
  // Limits
  maxSolveAttempts: 5,           // Increased: more attempts allowed
  cooldownAfterSuccessMs: 5000,  // Reduced: faster retry after success
  
  // Re-login detection
  reactivateCheckMs: 3000        // Check for logout every 3 seconds
};

// ============================================================================
// STATE MANAGEMENT
// ============================================================================

const state = {
  isProcessing: false,
  isLoggedIn: false,
  solveAttempts: 0,
  lastSolveTime: null,
  observer: null,
  debounceTimer: null,
  hasSuccessfullySolved: false
};

/**
 * Get current state as string for logging
 */
function getStateLog() {
  return `[Processing:${state.isProcessing}|LoggedIn:${state.isLoggedIn}|Attempts:${state.solveAttempts}]`;
}

// ============================================================================
// LOGIN STATE DETECTION
// ============================================================================

/**
 * Check if user appears to be logged in
 * Multiple strategies to detect login state
 */
function checkIfLoggedIn() {
  // Strategy 1: Check for success indicators
  for (const selector of CONFIG.loginSuccessIndicators) {
    if (document.querySelector(selector)) {
      console.log(`[CAPTCHA] Login detected via: ${selector}`);
      return true;
    }
  }
  
  // Strategy 2: Check if login modal disappeared after we solved
  if (state.hasSuccessfullySolved) {
    const captchaImg = document.getElementById(CONFIG.captchaImageId);
    const captchaInput = document.getElementById(CONFIG.captchaInputId);
    
    // If CAPTCHA elements are gone after successful solve, likely logged in
    if (!captchaImg && !captchaInput) {
      console.log('[CAPTCHA] Login detected: CAPTCHA elements removed after solve');
      return true;
    }
    
    // Check if modal is hidden/removed
    for (const selector of CONFIG.loginModalSelectors) {
      const modal = document.querySelector(selector);
      if (modal) {
        const style = window.getComputedStyle(modal);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
          console.log(`[CAPTCHA] Login detected: Modal hidden (${selector})`);
          return true;
        }
      }
    }
  }
  
  // Strategy 3: Check URL change indicating login
  if (window.location.href.includes('dashboard') || 
      window.location.href.includes('home') ||
      window.location.href.includes('account')) {
    console.log('[CAPTCHA] Login detected via URL change');
    return true;
  }
  
  return false;
}

/**
 * Update login state and stop if logged in
 */
function updateLoginState() {
  if (state.isLoggedIn) return true;
  
  state.isLoggedIn = checkIfLoggedIn();
  
  if (state.isLoggedIn) {
    console.log('[CAPTCHA] ✅ User logged in - stopping auto-solver');
    cleanup();
    return true;
  }
  
  return false;
}

// ============================================================================
// VISIBILITY DETECTION (IMPROVED)
// ============================================================================

/**
 * Check if element is truly visible
 * Multiple checks for robust detection
 */
function isElementVisible(element) {
  if (!element) return false;
  
  // Check basic properties
  const rect = element.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return false;
  
  // Check computed style
  const style = window.getComputedStyle(element);
  if (style.display === 'none') return false;
  if (style.visibility === 'hidden') return false;
  if (style.opacity === '0') return false;
  
  // Check if in viewport (at least partially)
  const inViewport = (
    rect.top < window.innerHeight &&
    rect.bottom > 0 &&
    rect.left < window.innerWidth &&
    rect.right > 0
  );
  
  return inViewport;
}

/**
 * Check if image is loaded (for img elements)
 */
function isImageLoaded(imgElement) {
  if (!imgElement) return false;
  if (!(imgElement instanceof HTMLImageElement)) return true; // Not an img tag
  
  // Check naturalWidth (0 if not loaded or broken)
  if (imgElement.naturalWidth === 0) return false;
  
  // Check complete property
  if (!imgElement.complete) return false;
  
  return true;
}

/**
 * Wait for element to become visible with timeout
 * Returns: { visible: boolean, reason: string }
 */
function waitForVisibility(element, timeout = CONFIG.visibilityTimeoutMs) {
  return new Promise((resolve) => {
    const startTime = Date.now();
    
    const check = () => {
      // Check if we should abort (logged in or processing stopped)
      if (state.isLoggedIn || !state.isProcessing) {
        resolve({ visible: false, reason: 'aborted' });
        return;
      }
      
      const elapsed = Date.now() - startTime;
      
      // Check visibility
      if (isElementVisible(element) && isImageLoaded(element)) {
        resolve({ visible: true, reason: 'visible' });
        return;
      }
      
      // Timeout check
      if (elapsed >= timeout) {
        resolve({ visible: false, reason: 'timeout' });
        return;
      }
      
      // Continue polling
      setTimeout(check, CONFIG.visibilityPollMs);
    };
    
    check();
  });
}


// ============================================================================
// MUTATION OBSERVER (DEBOUNCED)
// ============================================================================

/**
 * Debounced handler for DOM mutations
 * Prevents spam when page has lots of DOM activity
 */
function handleMutation() {
  // Clear existing debounce timer
  if (state.debounceTimer) {
    clearTimeout(state.debounceTimer);
  }
  
  // Debounce the actual check
  state.debounceTimer = setTimeout(() => {
    checkForCaptcha();
  }, CONFIG.debounceMs);
}

/**
 * Check if CAPTCHA is present and needs solving
 */
function checkForCaptcha() {
  // Guard: Already logged in
  if (updateLoginState()) {
    return;
  }
  
  // Guard: Already processing
  if (state.isProcessing) {
    console.log('[CAPTCHA] Already processing, skipping');
    return;
  }
  
  // Guard: Max attempts reached
  if (state.solveAttempts >= CONFIG.maxSolveAttempts) {
    console.log(`[CAPTCHA] Max attempts (${CONFIG.maxSolveAttempts}) reached, stopping`);
    return;
  }
  
  // Guard: Cooldown after success
  if (state.lastSolveTime) {
    const elapsed = Date.now() - state.lastSolveTime;
    if (elapsed < CONFIG.cooldownAfterSuccessMs) {
      console.log(`[CAPTCHA] In cooldown (${Math.round((CONFIG.cooldownAfterSuccessMs - elapsed) / 1000)}s remaining)`);
      return;
    }
  }
  
  // Find CAPTCHA elements
  const captchaImg = document.getElementById(CONFIG.captchaImageId);
  const captchaInput = document.getElementById(CONFIG.captchaInputId);
  
  // Guard: Elements not found
  if (!captchaImg || !captchaInput) {
    return;
  }
  
  // Guard: Already has value
  if (captchaInput.value && captchaInput.value.trim().length > 0) {
    console.log('[CAPTCHA] Input already has value, skipping');
    return;
  }
  
  // Start solving
  console.log(`[CAPTCHA] 🎯 CAPTCHA detected! ${getStateLog()}`);
  initiateSolver(captchaImg, captchaInput);
}

/**
 * Start the mutation observer
 */
function startObserver() {
  if (state.observer) {
    console.log('[CAPTCHA] Observer already running');
    return;
  }
  
  state.observer = new MutationObserver((mutations) => {
    // Quick filter: only care about added nodes
    const hasAddedNodes = mutations.some(m => m.addedNodes.length > 0);
    if (hasAddedNodes) {
      handleMutation();
    }
  });
  
  state.observer.observe(document.body, {
    childList: true,
    subtree: true
  });
  
  console.log('[CAPTCHA] 👁️ Observer started - watching for login modal');
}

/**
 * Stop the mutation observer
 */
function stopObserver() {
  if (state.observer) {
    state.observer.disconnect();
    state.observer = null;
    console.log('[CAPTCHA] Observer stopped');
  }
}

// ============================================================================
// SOLVER ORCHESTRATION
// ============================================================================

/**
 * Main solver entry point
 */
async function initiateSolver(imgElement, inputElement) {
  // Set processing flag
  state.isProcessing = true;
  state.solveAttempts++;
  
  console.log(`[CAPTCHA] Attempt ${state.solveAttempts}/${CONFIG.maxSolveAttempts}`);
  
  try {
    // Wait for image to be visible
    console.log('[CAPTCHA] Waiting for image visibility...');
    const visibility = await waitForVisibility(imgElement);
    
    if (!visibility.visible) {
      console.warn(`[CAPTCHA] Image not visible: ${visibility.reason}`);
      state.isProcessing = false;
      return;
    }
    
    // Small delay for rendering to complete
    await sleep(CONFIG.postVisibilityDelayMs);
    
    // Double-check we're still good to proceed
    if (state.isLoggedIn) {
      console.log('[CAPTCHA] Aborted: User logged in');
      state.isProcessing = false;
      return;
    }
    
    // Solve the CAPTCHA
    await solveCaptcha(imgElement, inputElement);
    
  } catch (error) {
    console.error('[CAPTCHA] Solver error:', error);
    inputElement.style.backgroundColor = '#f8d7da';
  } finally {
    state.isProcessing = false;
  }
}

/**
 * Core CAPTCHA solving logic
 */
async function solveCaptcha(imgElement, inputElement) {
  // Update UI
  inputElement.placeholder = 'Capturing...';
  inputElement.style.backgroundColor = '#fff3cd';
  
  // Step 1: Capture screenshot
  console.log('[CAPTCHA] 📸 Capturing screenshot...');
  const rect = imgElement.getBoundingClientRect();
  
  const captureResponse = await sendMessage({ action: 'capture_screen' });
  
  if (captureResponse.error) {
    throw new Error(`Capture failed: ${captureResponse.error}`);
  }
  
  // Step 2: Crop and process image
  console.log('[CAPTCHA] 🖼️ Processing image...');
  const processedImage = await cropAndProcessImage(
    captureResponse.dataUrl,
    rect,
    window.devicePixelRatio
  );
  
  // Step 3: Send to background for OCR
  inputElement.placeholder = 'Solving...';
  console.log('[CAPTCHA] 🤖 Sending to AI...');
  
  const solveResponse = await sendMessage({
    action: 'solve_captcha',
    base64Image: processedImage
  });
  
  if (solveResponse.error) {
    throw new Error(`Solve failed: ${solveResponse.error}`);
  }
  
  const text = solveResponse.text;
  
  if (!text) {
    throw new Error('No text returned from solver');
  }
  
  // Step 4: Fill in the result
  console.log(`[CAPTCHA] ✅ SOLVED: ${text} ${solveResponse.status || ''}`);
  
  inputElement.focus();
  inputElement.value = text;
  inputElement.style.backgroundColor = '#d4edda';
  
  // Dispatch events for frameworks
  inputElement.dispatchEvent(new Event('input', { bubbles: true }));
  inputElement.dispatchEvent(new Event('change', { bubbles: true }));
  inputElement.dispatchEvent(new Event('blur', { bubbles: true }));
  
  // Click remember checkbox if present
  const rememberCheckbox = document.getElementById(CONFIG.rememberCheckboxId);
  if (rememberCheckbox && !rememberCheckbox.checked) {
    rememberCheckbox.click();
  }
  
  // Mark success
  state.hasSuccessfullySolved = true;
  state.lastSolveTime = Date.now();
  
  // Schedule login check
  setTimeout(() => {
    updateLoginState();
  }, 2000);
}

// ============================================================================
// IMAGE PROCESSING
// ============================================================================

/**
 * Crop and preprocess CAPTCHA image for better OCR
 */
function cropAndProcessImage(base64Url, rect, dpr = 1) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        const scale = 2.0;
        
        // Calculate source coordinates
        const sx = rect.left * dpr;
        const sy = rect.top * dpr;
        const sw = rect.width * dpr;
        const sh = rect.height * dpr;
        
        // Set canvas size
        canvas.width = sw * scale;
        canvas.height = sh * scale;
        
        // Draw cropped region
        ctx.drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
        
        // Apply image processing for better OCR
        const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const data = imgData.data;
        
        for (let i = 0; i < data.length; i += 4) {
          const r = data[i];
          const g = data[i + 1];
          const b = data[i + 2];
          
          // Isolate blue channel (common CAPTCHA text color)
          const isBlueish = b > (r + g) * 0.7 && b > 90;
          const color = isBlueish ? 0 : 255;
          
          data[i] = color;
          data[i + 1] = color;
          data[i + 2] = color;
        }
        
        ctx.putImageData(imgData, 0, 0);
        resolve(canvas.toDataURL('image/jpeg', 0.9));
        
      } catch (err) {
        reject(err);
      }
    };
    
    img.onerror = () => reject(new Error('Failed to load screenshot'));
    img.src = base64Url;
  });
}

// ============================================================================
// UTILITIES
// ============================================================================

/**
 * Promise-based message sending to background script
 */
function sendMessage(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ error: chrome.runtime.lastError.message });
      } else {
        resolve(response || { error: 'No response' });
      }
    });
  });
}

/**
 * Sleep utility
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Cleanup resources (but keep watching for logout)
 */
function cleanup() {
  stopObserver();
  if (state.debounceTimer) {
    clearTimeout(state.debounceTimer);
    state.debounceTimer = null;
  }
  console.log('[CAPTCHA] 🛑 Cleanup complete - auto-solver paused');
  
  // Start watching for logout (re-login scenario)
  startLogoutWatcher();
}

/**
 * Reset state for re-login attempt
 */
function resetState() {
  state.isProcessing = false;
  state.isLoggedIn = false;
  state.solveAttempts = 0;
  state.lastSolveTime = null;
  state.hasSuccessfullySolved = false;
  console.log('[CAPTCHA] 🔄 State reset for new login attempt');
}

/**
 * Watch for logout - reactivate solver when user logs out
 */
function startLogoutWatcher() {
  console.log('[CAPTCHA] 👁️ Watching for logout...');
  
  const checkForLogout = () => {
    // If we're not marked as logged in, no need to watch
    if (!state.isLoggedIn) return;
    
    // Check if CAPTCHA elements reappear (indicates logout/re-login)
    const captchaImg = document.getElementById(CONFIG.captchaImageId);
    const captchaInput = document.getElementById(CONFIG.captchaInputId);
    
    if (captchaImg && captchaInput) {
      // CAPTCHA is back! User logged out and is trying to login again
      console.log('[CAPTCHA] 🔓 Logout detected - CAPTCHA reappeared');
      resetState();
      startObserver();
      checkForCaptcha();
      return; // Stop the logout watcher
    }
    
    // Check if login success indicators disappeared
    let stillLoggedIn = false;
    for (const selector of CONFIG.loginSuccessIndicators) {
      if (document.querySelector(selector)) {
        stillLoggedIn = true;
        break;
      }
    }
    
    // Also check URL - if we're back on login page
    const onLoginPage = window.location.href.includes('login') || 
                        window.location.href.includes('signin') ||
                        window.location.href.includes('ETax');
    
    if (!stillLoggedIn && onLoginPage) {
      console.log('[CAPTCHA] 🔓 Logout detected - redirected to login page');
      resetState();
      startObserver();
      setTimeout(checkForCaptcha, 1000);
      return;
    }
    
    // Continue watching
    setTimeout(checkForLogout, CONFIG.reactivateCheckMs);
  };
  
  // Start checking after a delay
  setTimeout(checkForLogout, CONFIG.reactivateCheckMs);
}

// ============================================================================
// INITIALIZATION
// ============================================================================

/**
 * Initialize the content script
 */
function init() {
  console.log('[CAPTCHA] ========================================');
  console.log('[CAPTCHA] Auto-Solver v2.0 initializing...');
  console.log('[CAPTCHA] ========================================');
  
  // Check if already logged in
  if (checkIfLoggedIn()) {
    console.log('[CAPTCHA] User already logged in - not starting');
    return;
  }
  
  // Start watching
  startObserver();
  
  // Also check immediately in case CAPTCHA is already visible
  setTimeout(checkForCaptcha, 500);
  
  // Listen for page unload to cleanup
  window.addEventListener('beforeunload', cleanup);
  
  console.log('[CAPTCHA] ✅ Ready and watching');
}

// Start
init();
