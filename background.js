// Download queue management (inspired by Multi-file-downloader)
let downloadQueue = [];
let activeDownloads = [];
let processingQueue = false;
const MAX_CONCURRENT_DOWNLOADS = 3;

chrome.runtime.onInstalled.addListener(() => {
  console.log("Google Labs Flow Helper installed");
  
  // Set up keep-alive mechanism
  startKeepAlive();
});

// Keep-alive mechanism for service worker persistence
function startKeepAlive() {
  const KEEP_ALIVE_INTERVAL = 20000; // 20 seconds
  
  const keepAlive = () => {
    chrome.runtime.getPlatformInfo(() => {
      if (chrome.runtime.lastError) {
        console.warn('KeepAlive failed:', chrome.runtime.lastError.message);
      }
    });
  };
  
  // Initial call
  keepAlive();
  
  // Set up interval
  setInterval(keepAlive, KEEP_ALIVE_INTERVAL);
}

function processDownloadQueue() {
  if (processingQueue || downloadQueue.length === 0 || activeDownloads.length >= MAX_CONCURRENT_DOWNLOADS) {
    return;
  }
  
  processingQueue = true;
  const downloadItem = downloadQueue.shift();
  
  chrome.downloads.download({
    url: downloadItem.url,
    conflictAction: 'uniquify',
    saveAs: false
  }, (downloadId) => {
    processingQueue = false;
    
    if (downloadId) {
      activeDownloads.push({
        id: downloadId,
        originalUrl: downloadItem.url,
        timestamp: Date.now()
      });
      console.log(`Flow Helper: Started download ${downloadId} for ${downloadItem.url}`);
    } else {
      console.error(`Flow Helper: Failed to start download for ${downloadItem.url}`);
    }
    
    // Continue processing queue
    processDownloadQueue();
  });
}

function queueDownload(url) {
  downloadQueue.push({ url, timestamp: Date.now() });
  processDownloadQueue();
  console.log(`Flow Helper: Queued download for ${url}`);
}

async function setupOffscreen() {
  try {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"]
    });

    if (contexts.length > 0) {
      return;
    }

    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["AUDIO_PLAYBACK"],
      justification: "Maintain background automation and avoid service worker suspension during long-running tasks."
    });
    console.log("Flow Helper: Offscreen document created");
  } catch (error) {
    console.error("Flow Helper: Failed to create offscreen document", error);
  }
}

async function closeOffscreen() {
  try {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"]
    });

    if (contexts.length > 0) {
      await chrome.offscreen.closeDocument();
      console.log("Flow Helper: Offscreen document closed");
    }
  } catch (error) {
    console.error("Flow Helper: Failed to close offscreen document", error);
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "FLOW_HELPER_HEALTHCHECK") {
    sendResponse({
      ok: true,
      source: "background"
    });
  }

  if (message?.type === "FLOW_HELPER_PING") {
    sendResponse({
      ok: true,
      timestamp: Date.now()
    });
  }

  if (message?.type === "FLOW_HELPER_OFFSCREEN_START") {
    setupOffscreen().then(() => sendResponse({ ok: true }));
    return true;
  }

  if (message?.type === "FLOW_HELPER_OFFSCREEN_STOP") {
    closeOffscreen().then(() => sendResponse({ ok: true }));
    return true;
  }

  if (message?.type === "FLOW_HELPER_PREVENT_DISCARD") {
    if (sender?.tab?.id) {
      chrome.tabs.update(sender.tab.id, { autoDiscardable: false }).then(() => {
        sendResponse({ ok: true });
      });
      return true;
    }
  }

  if (message?.type === "FLOW_HELPER_DOWNLOAD") {
    // Try queue-based download first
    if (message.url) {
      queueDownload(message.url);
      sendResponse({ ok: true, method: 'queued' });
    } else {
      // Fallback to direct download
      chrome.downloads.download({
        url: message.url,
        saveAs: false
      }).then((downloadId) => {
        sendResponse({ ok: true, downloadId, method: 'direct' });
      }).catch((error) => {
        console.error("Flow Helper: Background download failed", error);
        sendResponse({ ok: false, error: error.message });
      });
    }
    return true;
  }
});

// Track download completion
chrome.downloads.onChanged.addListener((downloadItem) => {
  const activeIndex = activeDownloads.findIndex(item => item.id === downloadItem.id);
  
  if (activeIndex === -1) return;
  
  if (downloadItem.state) {
    if (downloadItem.state.current === 'complete') {
      console.log(`Flow Helper: Download completed ${downloadItem.id}`);
      activeDownloads.splice(activeIndex, 1);
      processDownloadQueue(); // Process next in queue
    } else if (downloadItem.state.current === 'interrupted') {
      console.warn(`Flow Helper: Download interrupted ${downloadItem.id}`);
      activeDownloads.splice(activeIndex, 1);
      processDownloadQueue(); // Process next in queue
    }
  }
});