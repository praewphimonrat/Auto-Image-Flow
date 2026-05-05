// Download queue management (inspired by Multi-file-downloader)
let downloadQueue = [];
let activeDownloads = [];
let processingQueue = false;
const MAX_CONCURRENT_DOWNLOADS = 3;
const DOWNLOAD_DEDUPE_WINDOW_MS = 10000;
const recentDownloadRequests = new Map();
const MAX_NETWORK_IMAGES_PER_TAB = 25;
const FLOW_CONTENT_IMAGE_URL_PATTERN = "https://flow-content.google/image/*";
const networkImageRequestsByTab = new Map();

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

function normalizeDownloadUrl(url) {
  return String(url || "").trim();
}

function pruneRecentDownloadRequests(now = Date.now()) {
  for (const [url, timestamp] of recentDownloadRequests.entries()) {
    if (now - timestamp > DOWNLOAD_DEDUPE_WINDOW_MS) {
      recentDownloadRequests.delete(url);
    }
  }
}

function isRecentDownloadRequest(url) {
  const now = Date.now();
  pruneRecentDownloadRequests(now);

  const previousTimestamp = recentDownloadRequests.get(url);
  if (previousTimestamp && now - previousTimestamp < DOWNLOAD_DEDUPE_WINDOW_MS) {
    return true;
  }

  recentDownloadRequests.set(url, now);
  return false;
}

function hasQueuedOrActiveDownload(url) {
  return (
    downloadQueue.some(item => item.url === url) ||
    activeDownloads.some(item => item.originalUrl === url)
  );
}

function queueDownload(url) {
  if (hasQueuedOrActiveDownload(url)) {
    console.log(`Flow Helper: Ignored duplicate queued/active download for ${url}`);
    return false;
  }

  downloadQueue.push({ url, timestamp: Date.now() });
  processDownloadQueue();
  console.log(`Flow Helper: Queued download for ${url}`);
  return true;
}

function startQueuedDownload(url) {
  const downloadUrl = normalizeDownloadUrl(url);

  if (!downloadUrl) {
    return { ok: false, error: "No URL provided" };
  }

  if (isRecentDownloadRequest(downloadUrl)) {
    console.log("Flow Helper: Ignored recent duplicate download request");
    return { ok: true, method: "deduped", url: downloadUrl };
  }

  const queued = queueDownload(downloadUrl);
  return { ok: true, method: queued ? "queued" : "deduped", url: downloadUrl };
}

function isFlowContentImageUrl(url) {
  try {
    const parsedUrl = new URL(url);
    return parsedUrl.hostname === "flow-content.google" && parsedUrl.pathname.startsWith("/image/");
  } catch (_error) {
    return false;
  }
}

function getResponseHeader(headers, name) {
  const targetName = name.toLowerCase();
  const match = Array.isArray(headers)
    ? headers.find(header => String(header.name || "").toLowerCase() === targetName)
    : null;

  return match?.value || "";
}

function recordNetworkImageRequest(details, phase = "completed") {
  if (!details || details.tabId < 0 || !isFlowContentImageUrl(details.url)) {
    return;
  }

  if (details.statusCode && (details.statusCode < 200 || details.statusCode >= 300)) {
    return;
  }

  const contentType = getResponseHeader(details.responseHeaders, "content-type").toLowerCase();

  if (contentType && !contentType.startsWith("image/")) {
    return;
  }

  const entry = {
    url: details.url,
    tabId: details.tabId,
    requestId: details.requestId,
    statusCode: details.statusCode || 0,
    contentType,
    fromCache: Boolean(details.fromCache),
    phase,
    timestamp: Date.now()
  };

  const entries = networkImageRequestsByTab.get(details.tabId) || [];
  const existingIndex = entries.findIndex(item => item.url === entry.url);

  if (existingIndex >= 0) {
    const previousEntry = entries.splice(existingIndex, 1)[0];
    entry.timestamp = previousEntry.timestamp || entry.timestamp;
    entry.phase = phase;
  }

  entries.push(entry);
  networkImageRequestsByTab.set(details.tabId, entries.slice(-MAX_NETWORK_IMAGES_PER_TAB));
  console.log("Flow Helper: Captured network image", {
    tabId: entry.tabId,
    statusCode: entry.statusCode,
    contentType: entry.contentType,
    fromCache: entry.fromCache,
    phase: entry.phase,
    url: entry.url
  });
}

function resetNetworkImageCapture(tabId) {
  networkImageRequestsByTab.set(tabId, []);
  return Date.now();
}

function getLatestNetworkImage(tabId, after = 0) {
  const entries = networkImageRequestsByTab.get(tabId) || [];
  const afterTimestamp = Number.isFinite(after) ? after : 0;

  return entries
    .filter(entry => entry.timestamp >= afterTimestamp)
    .sort((left, right) => right.timestamp - left.timestamp)[0] || null;
}

function registerNetworkImageCapture() {
  if (!chrome.webRequest?.onBeforeRequest || !chrome.webRequest?.onCompleted) {
    console.warn("Flow Helper: webRequest API is not available");
    return;
  }

  const filter = {
    urls: [FLOW_CONTENT_IMAGE_URL_PATTERN],
    types: ["image", "xmlhttprequest", "other"]
  };

  chrome.webRequest.onBeforeRequest.addListener(
    details => recordNetworkImageRequest(details, "started"),
    filter
  );

  try {
    chrome.webRequest.onCompleted.addListener(
      details => recordNetworkImageRequest(details, "completed"),
      filter,
      ["responseHeaders"]
    );
  } catch (error) {
    console.warn("Flow Helper: Falling back to webRequest without response headers", error);
    chrome.webRequest.onCompleted.addListener(
      details => recordNetworkImageRequest(details, "completed"),
      filter
    );
  }
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

  if (message?.type === "FLOW_HELPER_NETWORK_CAPTURE_RESET") {
    if (!sender?.tab?.id) {
      sendResponse({ ok: false, error: "No sender tab found" });
      return true;
    }

    const timestamp = resetNetworkImageCapture(sender.tab.id);
    sendResponse({ ok: true, timestamp });
    return true;
  }

  if (message?.type === "FLOW_HELPER_GET_LATEST_NETWORK_IMAGE") {
    if (!sender?.tab?.id) {
      sendResponse({ ok: false, error: "No sender tab found" });
      return true;
    }

    const entry = getLatestNetworkImage(sender.tab.id, Number(message.after) || 0);
    sendResponse({
      ok: Boolean(entry),
      entry,
      error: entry ? "" : "No captured network image request found"
    });
    return true;
  }

  if (message?.type === "FLOW_HELPER_DOWNLOAD_LATEST_NETWORK_IMAGE") {
    if (!sender?.tab?.id) {
      sendResponse({ ok: false, error: "No sender tab found" });
      return true;
    }

    const entry = getLatestNetworkImage(sender.tab.id, Number(message.after) || 0);

    if (!entry) {
      sendResponse({ ok: false, error: "No captured network image request found" });
      return true;
    }

    const result = startQueuedDownload(entry.url);
    sendResponse({
      ...result,
      method: result.ok ? (result.method === "deduped" ? "deduped" : "network") : result.method,
      entry
    });
    return true;
  }

  if (message?.type === "FLOW_HELPER_DOWNLOAD") {
    console.log("Flow Helper: Received download request for:", message.url);
    sendResponse(startQueuedDownload(message.url));
    return true;
  }
});

registerNetworkImageCapture();

chrome.tabs.onRemoved.addListener((tabId) => {
  networkImageRequestsByTab.delete(tabId);
});

// Track download completion
chrome.downloads.onChanged.addListener((downloadItem) => {
  const activeIndex = activeDownloads.findIndex(item => item.id === downloadItem.id);
  
  if (activeIndex === -1) return;
  
  if (downloadItem.state) {
    if (downloadItem.state.current === 'complete') {
      console.log(`Flow Helper: Download completed ${downloadItem.id} - ${downloadItem.filename || 'unknown'}`);
      activeDownloads.splice(activeIndex, 1);
      processDownloadQueue(); // Process next in queue
    } else if (downloadItem.state.current === 'interrupted') {
      console.warn(`Flow Helper: Download interrupted ${downloadItem.id} - ${downloadItem.error || 'unknown error'}`);
      activeDownloads.splice(activeIndex, 1);
      processDownloadQueue(); // Process next in queue
    }
  }
  
  // Log filename changes to help debug what's being downloaded
  if (downloadItem.filename) {
    console.log(`Flow Helper: Download ${downloadItem.id} filename: ${downloadItem.filename.current || downloadItem.filename}`);
  }
});
