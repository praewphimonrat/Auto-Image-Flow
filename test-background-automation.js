// Test script to verify background tab automation works
(function initBackgroundTabTest() {
  if (window.BackgroundTabTest) {
    return;
  }

  const state = {
    testResults: [],
    isRunning: false,
    startTime: null
  };

  function log(message, type = 'info') {
    const timestamp = new Date().toISOString();
    const entry = { timestamp, message, type, tabVisible: document.visibilityState };
    state.testResults.push(entry);
    console.log(`[BackgroundTest ${type.toUpperCase()}] ${message}`, { tabVisible: document.visibilityState });
  }

  function createTestUI() {
    const testPanel = document.createElement('div');
    testPanel.id = 'background-test-panel';
    testPanel.style.cssText = `
      position: fixed;
      top: 10px;
      right: 10px;
      width: 300px;
      background: #fff;
      border: 2px solid #007bff;
      border-radius: 8px;
      padding: 15px;
      z-index: 10000;
      font-family: monospace;
      font-size: 12px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    `;

    testPanel.innerHTML = `
      <h3 style="margin: 0 0 10px 0; color: #007bff;">Background Tab Test</h3>
      <div id="test-status">Ready</div>
      <div style="margin: 10px 0;">
        <button id="start-test" style="margin-right: 5px;">Start Test</button>
        <button id="stop-test">Stop Test</button>
        <button id="clear-log">Clear Log</button>
      </div>
      <div id="test-log" style="max-height: 200px; overflow-y: auto; border: 1px solid #ccc; padding: 5px; background: #f8f9fa;"></div>
    `;

    document.body.appendChild(testPanel);

    // Bind events
    document.getElementById('start-test').onclick = startTest;
    document.getElementById('stop-test').onclick = stopTest;
    document.getElementById('clear-log').onclick = clearLog;

    return testPanel;
  }

  function updateTestUI() {
    const statusEl = document.getElementById('test-status');
    const logEl = document.getElementById('test-log');

    if (statusEl) {
      const elapsed = state.startTime ? Math.round((Date.now() - state.startTime) / 1000) : 0;
      statusEl.textContent = state.isRunning 
        ? `Running (${elapsed}s) - Tab: ${document.visibilityState}`
        : 'Stopped';
      statusEl.style.color = state.isRunning ? '#28a745' : '#6c757d';
    }

    if (logEl) {
      logEl.innerHTML = state.testResults
        .slice(-20) // Show last 20 entries
        .map(entry => `
          <div style="margin: 2px 0; color: ${entry.type === 'error' ? 'red' : entry.type === 'success' ? 'green' : 'black'};">
            [${entry.timestamp.split('T')[1].split('.')[0]}] ${entry.message}
            <span style="color: #666; font-size: 10px;">(${entry.tabVisible})</span>
          </div>
        `).join('');
      logEl.scrollTop = logEl.scrollHeight;
    }
  }

  function testDownloadButtonClick() {
    return new Promise((resolve) => {
      try {
        // Try to find a download button (adapt this to your specific site)
        const downloadButtons = Array.from(document.querySelectorAll('button')).filter(btn => {
          const text = btn.textContent.toLowerCase();
          return text.includes('download') || text.includes('ดาวน์โหลด') || 
                 btn.querySelector('i')?.textContent.includes('download');
        });

        if (downloadButtons.length === 0) {
          resolve({ success: false, message: 'No download button found' });
          return;
        }

        const button = downloadButtons[0];
        const rect = button.getBoundingClientRect();
        
        // Test click in background
        button.dispatchEvent(new MouseEvent('click', {
          bubbles: true,
          cancelable: true,
          clientX: rect.width === 0 ? window.innerWidth / 2 : rect.left + rect.width / 2,
          clientY: rect.height === 0 ? window.innerHeight / 2 : rect.top + rect.height / 2
        }));

        resolve({ 
          success: true, 
          message: `Clicked download button (${rect.width}x${rect.height})`,
          buttonVisible: rect.width > 0 && rect.height > 0
        });
      } catch (error) {
        resolve({ success: false, message: `Click failed: ${error.message}` });
      }
    });
  }

  function testBackgroundTimer() {
    return new Promise((resolve) => {
      const startTime = Date.now();
      
      // Use Web Worker timer (like in your code)
      const timerWorker = new Worker(URL.createObjectURL(new Blob([
        `self.onmessage = function(e) { 
           setTimeout(() => self.postMessage(e.data), e.data.ms); 
         };`
      ], { type: "text/javascript" })));

      const id = Math.random();
      const handler = (e) => {
        if (e.data && e.data.id === id) {
          timerWorker.removeEventListener("message", handler);
          const elapsed = Date.now() - startTime;
          resolve({ 
            success: true, 
            message: `Web Worker timer: ${elapsed}ms (expected ~2000ms)`,
            accurate: Math.abs(elapsed - 2000) < 500
          });
        }
      };

      timerWorker.addEventListener("message", handler);
      timerWorker.postMessage({ id, ms: 2000 });
    });
  }

  function testVisibilitySpoof() {
    return new Promise((resolve) => {
      const actualState = document.visibilityState;
      const spoofed = window.__flowHelperVisibilitySpoofed === true;
      
      resolve({
        success: true,
        message: `Visibility: ${actualState}, Spoofed: ${spoofed}`,
        spoofWorking: spoofed && actualState === 'visible'
      });
    });
  }

  async function runTestCycle() {
    if (!state.isRunning) return;

    log('Starting test cycle...');

    // Test 1: Visibility spoofing
    const visTest = await testVisibilitySpoof();
    log(visTest.message, visTest.spoofWorking ? 'success' : 'error');

    // Test 2: Background timer accuracy
    const timerTest = await testBackgroundTimer();
    log(timerTest.message, timerTest.accurate ? 'success' : 'error');

    // Test 3: Download button click
    const clickTest = await testDownloadButtonClick();
    log(clickTest.message, clickTest.success ? 'success' : 'error');

    // Test 4: Chrome API call
    try {
      const startTime = Date.now();
      chrome.runtime.sendMessage({ type: "FLOW_HELPER_PING" }, (response) => {
        const elapsed = Date.now() - startTime;
        if (chrome.runtime.lastError) {
          log(`Chrome API failed: ${chrome.runtime.lastError.message}`, 'error');
        } else {
          log(`Chrome API response: ${elapsed}ms`, 'success');
        }
      });
    } catch (error) {
      log(`Chrome API error: ${error.message}`, 'error');
    }

    updateTestUI();

    // Schedule next cycle
    if (state.isRunning) {
      setTimeout(runTestCycle, 5000); // Every 5 seconds
    }
  }

  function startTest() {
    if (state.isRunning) return;
    
    state.isRunning = true;
    state.startTime = Date.now();
    log('Background tab test started', 'success');
    
    // Start the test cycle
    runTestCycle();
  }

  function stopTest() {
    state.isRunning = false;
    log('Background tab test stopped', 'info');
    updateTestUI();
  }

  function clearLog() {
    state.testResults = [];
    updateTestUI();
  }

  // Initialize
  function init() {
    createTestUI();
    updateTestUI();
    
    // Monitor visibility changes
    document.addEventListener('visibilitychange', () => {
      log(`Tab visibility changed to: ${document.visibilityState}`, 'info');
      updateTestUI();
    });

    log('Background tab test initialized', 'success');
  }

  // Auto-start if in development
  if (window.location.hostname === 'localhost' || window.location.hostname.includes('dev')) {
    setTimeout(startTest, 1000);
  }

  window.BackgroundTabTest = {
    start: startTest,
    stop: stopTest,
    clear: clearLog,
    getResults: () => state.testResults
  };

  // Initialize when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();