/**
 * ============================================================================
 * CAPTCHA AUTO-SOLVER - Ω-OVERWATCH v15.1 (THE SURGEON - FIXED)
 * ============================================================================
 * 
 * DESCRIPTION:
 * - High-precision canvas-based cropping.
 * - Mutation-based auto-solve trigger.
 * - Manual Refresh Overwatch.
 * - Success reporting for permanent cache commit.
 */

{
  const DOM_CONFIG = {
    imgId: 'CaptchaImage',
    inputId: 'CaptchaInputText',
    refreshBtn: 'a[href="#CaptchaImage"]',
    successSelectors: ['.user-profile', '.dashboard', '#ctl00_btnLogout', '.welcome-user'],
    debounce: 800
  };

  let isBusy = false;

  /**
   * Main Solver logic
   */
  const solve = async () => {
    // Prevent concurrent executions
    if (isBusy) return;
    
    const img = document.getElementById(DOM_CONFIG.imgId);
    const input = document.getElementById(DOM_CONFIG.inputId);
    
    // Safety Guards
    if (!img || !input) return;
    if (input.value.length > 0) return; // Don't overwrite existing text
    if (img.naturalWidth === 0) return; // Wait for image to load

    isBusy = true;
    input.placeholder = "💉 Capturing...";

    try {
      // 1. Capture the current visible tab via Background script
      const captureResponse = await new Promise(r => {
        chrome.runtime.sendMessage({ action: "capture_screen" }, (response) => {
          if (chrome.runtime.lastError) r({ error: chrome.runtime.lastError.message });
          else r(response);
        });
      });

      if (!captureResponse?.dataUrl) {
        throw new Error("CAPTURE_FAILED");
      }

      // 2. Perform Precision Crop on Canvas
      const rect = img.getBoundingClientRect();
      const processedImg = await new Promise((resolve, reject) => {
        const i = new Image();
        i.onload = () => {
          const canvas = document.createElement('canvas');
          const ctx = canvas.getContext('2d');
          const dpr = window.devicePixelRatio || 1;
          
          // Scale 2x for OCR visibility enhancement
          canvas.width = rect.width * dpr * 2;
          canvas.height = rect.height * dpr * 2;
          
          // Smoothing for better character edge definition
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = 'high';
          
          ctx.drawImage(
            i, 
            rect.left * dpr, rect.top * dpr, 
            rect.width * dpr, rect.height * dpr, 
            0, 0, 
            canvas.width, canvas.height
          );
          
          resolve(canvas.toDataURL('image/jpeg', 0.9));
        };
        i.onerror = () => reject(new Error("IMAGE_LOAD_ERROR"));
        i.src = captureResponse.dataUrl;
      });

      if (!processedImg || processedImg.length < 500) {
        throw new Error("INVALID_CROP");
      }

      // 3. Request solve from Background LLM Orchestrator
      input.placeholder = "🧠 Solving...";
      const solveRes = await new Promise(r => {
        chrome.runtime.sendMessage({ 
          action: "solve_captcha", 
          base64Image: processedImg 
        }, r);
      });

      if (solveRes?.text) {
        input.value = solveRes.text;
        // Trigger UI events so site logic picks up the new value
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        input.placeholder = "✅ Solved";
      } else {
        throw new Error(solveRes?.error || "EMPTY_RESPONSE");
      }

    } catch (err) {
      console.error("[Ω-SURGEON] Solve operation aborted:", err.message);
      input.placeholder = "⚠️ Fail: " + err.message;
    } finally {
      isBusy = false;
    }
  };

  // ============================================================================
  // TRIGGERS & WATCHERS
  // ============================================================================

  // WATCHER: Manual Refresh Link
  document.body.addEventListener('click', (e) => {
    if (e.target.closest(DOM_CONFIG.refreshBtn)) {
      console.log("[Ω-SURGEON] Refresh detected. Triggering re-solve.");
      const input = document.getElementById(DOM_CONFIG.inputId);
      if (input) {
        input.value = '';
        input.placeholder = "Refreshing...";
      }
      setTimeout(solve, 1500); // Allow time for new image to load
    }
  });

  // WATCHER: Login Success Reporting (Interval check)
  setInterval(() => {
    const isHome = DOM_CONFIG.successSelectors.some(s => document.querySelector(s)) ||
                   window.location.href.toLowerCase().match(/dashboard|home|account/);
    if (isHome) {
      chrome.runtime.sendMessage({ action: "report_login_success" });
    }
  }, 3000);

  // WATCHER: DOM Mutations (Auto-solve when modal appears)
  let solveDebounceTimer;
  const observer = new MutationObserver(() => {
    clearTimeout(solveDebounceTimer);
    solveDebounceTimer = setTimeout(solve, DOM_CONFIG.debounce);
  });

  observer.observe(document.body, { childList: true, subtree: true });

  // Initial solve attempt
  console.log("[Ω-SURGEON] Ω-OVERWATCH v15.1 ACTIVE.");
  setTimeout(solve, 1000);
}
