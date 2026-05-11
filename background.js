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

function executeMainWorldScript(tabId, func, args = []) {
  return chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func,
    args
  }).then((results) => results?.[0]?.result || null);
}

function sendDebuggerCommand(target, method, params = {}) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand(target, method, params, (result) => {
      const lastError = chrome.runtime.lastError;
      if (lastError) {
        reject(new Error(lastError.message));
        return;
      }
      resolve(result);
    });
  });
}

function attachDebugger(target) {
  return new Promise((resolve, reject) => {
    chrome.debugger.attach(target, "1.3", () => {
      const lastError = chrome.runtime.lastError;
      if (lastError) {
        reject(new Error(lastError.message));
        return;
      }
      resolve();
    });
  });
}

function detachDebugger(target) {
  return new Promise((resolve) => {
    chrome.debugger.detach(target, () => {
      resolve();
    });
  });
}

async function dispatchTrustedClick(tabId, point) {
  if (!chrome.debugger) {
    return { ok: false, error: "chrome.debugger API is not available" };
  }

  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    return { ok: false, error: "No trusted-click point provided" };
  }

  const target = { tabId };
  let attached = false;

  try {
    await attachDebugger(target);
    attached = true;

    await sendDebuggerCommand(target, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: point.x,
      y: point.y,
      button: "none",
      pointerType: "mouse"
    });

    await sendDebuggerCommand(target, "Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: point.x,
      y: point.y,
      button: "left",
      buttons: 1,
      clickCount: 1,
      pointerType: "mouse"
    });

    await sendDebuggerCommand(target, "Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: point.x,
      y: point.y,
      button: "left",
      buttons: 0,
      clickCount: 1,
      pointerType: "mouse"
    });

    return { ok: true, method: "debugger-trusted-click", point };
  } catch (error) {
    return { ok: false, error: error.message };
  } finally {
    if (attached) {
      await detachDebugger(target);
    }
  }
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

  if (message?.type === "FLOW_HELPER_INSTALL_QUIET_MODE") {
    if (!sender?.tab?.id) {
      sendResponse({ ok: false, error: "No sender tab found" });
      return true;
    }

    executeMainWorldScript(sender.tab.id, () => {
      if (window.__flowHelperQuietModeInstalled) {
        return { ok: true, alreadyInstalled: true };
      }

      window.__flowHelperQuietModeInstalled = true;

      const shouldSuppress = (args) => {
        const message = args.map((item) => {
          if (typeof item === "string") {
            return item;
          }
          if (item instanceof Error) {
            return item.message;
          }
          try {
            return JSON.stringify(item);
          } catch (_error) {
            return String(item);
          }
        }).join(" ");

        return (
          message.includes("Flow Helper") ||
          message.includes("batchLog") ||
          message.includes("Flow log submission failed") ||
          message.includes("Invalid value used as weak map key")
        );
      };

      for (const method of ["log", "debug", "warn", "error", "info"]) {
        const original = console[method]?.bind(console);

        if (typeof original !== "function") {
          continue;
        }

        console[method] = (...args) => {
          if (shouldSuppress(args)) {
            return;
          }

          original(...args);
        };
      }

      const originalFetch = window.fetch?.bind(window);

      if (typeof originalFetch === "function") {
        window.fetch = (input, init) => {
          const url = typeof input === "string" ? input : input?.url || "";

          if (url.includes("https://aisandbox-pa.googleapis.com/v1:batchLog")) {
            return Promise.resolve(new Response("", {
              status: 204,
              statusText: "No Content"
            }));
          }

          return originalFetch(input, init);
        };
      }

      window.addEventListener("error", (event) => {
        if (String(event.message || "").includes("Invalid value used as weak map key")) {
          event.preventDefault();
        }
      }, true);

      window.addEventListener("unhandledrejection", (event) => {
        const reason = event.reason instanceof Error ? event.reason.message : String(event.reason || "");

        if (reason.includes("Invalid value used as weak map key") || reason.includes("batchLog")) {
          event.preventDefault();
        }
      }, true);

      return { ok: true };
    }).then((result) => {
      sendResponse(result || { ok: true });
    }).catch((error) => {
      sendResponse({ ok: false, error: error.message });
    });

    return true;
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

  if (message?.type === "FLOW_HELPER_FORCE_SUBMIT_CLICK") {
    if (!sender?.tab?.id) {
      sendResponse({ ok: false, error: "No sender tab found" });
      return true;
    }

    const buttonSelector = message.selector || 'button:has(i.google-symbols)';
    const iconFilter = message.iconFilter || 'arrow_forward';
    const shouldUseDebugger = message.useDebugger !== false;

    (async () => {
      const mainResult = await executeMainWorldScript(sender.tab.id, (selector, iconText) => {
        const isDisabled = (button) => {
          return (
            button.disabled ||
            button.getAttribute("aria-disabled") === "true" ||
            button.dataset.disabled === "true"
          );
        };

        const isVisibleEnough = (button) => {
          const style = window.getComputedStyle(button);
          return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
        };

        const getButtonCandidates = () => {
          let buttons = [];
          try {
            buttons = Array.from(document.querySelectorAll(selector));
          } catch (_error) {
            buttons = Array.from(document.querySelectorAll("button"));
          }

          const referenceElement =
            document.activeElement?.closest?.('[contenteditable="true"]') ||
            document.querySelector('[contenteditable="true"][data-slate-editor="true"]');
          const referenceRect = referenceElement?.getBoundingClientRect?.() || null;

          return buttons
            .filter((button) => button instanceof HTMLButtonElement)
            .filter((button) => !button.closest("#autogen-flow-helper-root"))
            .filter((button) => !button.getAttribute("aria-haspopup"))
            .filter((button) => isVisibleEnough(button))
            .filter((button) => {
              const icons = Array.from(button.querySelectorAll("i"));
              return icons.some((icon) => (icon.textContent || "").trim().includes(iconText));
            })
            .map((button) => {
              const rect = button.getBoundingClientRect();
              const distance = referenceRect
                ? Math.hypot(
                  rect.left + rect.width / 2 - (referenceRect.left + referenceRect.width / 2),
                  rect.top + rect.height / 2 - (referenceRect.top + referenceRect.height / 2)
                )
                : 0;

              return {
                button,
                disabled: isDisabled(button),
                distance
              };
            })
            .sort((left, right) => {
              if (left.disabled !== right.disabled) {
                return left.disabled ? 1 : -1;
              }
              return left.distance - right.distance;
            });
        };

        const getReactProps = (element) => {
          const propsKey = Object.keys(element).find((key) => key.startsWith("__reactProps$"));
          if (propsKey && element[propsKey]) {
            return element[propsKey];
          }

          const fiberKey = Object.keys(element).find((key) =>
            key.startsWith("__reactFiber$") || key.startsWith("__reactInternalInstance$")
          );
          let fiber = fiberKey ? element[fiberKey] : null;
          let depth = 0;

          while (fiber && depth < 8) {
            const props = fiber.memoizedProps || fiber.pendingProps;
            if (props) {
              return props;
            }
            fiber = fiber.return;
            depth += 1;
          }

          return null;
        };

        const createReactLikeEvent = (target, currentTarget, eventName) => {
          let defaultPrevented = false;
          let propagationStopped = false;
          const rect = target.getBoundingClientRect();
          const clientX = rect.width ? rect.left + rect.width / 2 : window.innerWidth / 2;
          const clientY = rect.height ? rect.top + rect.height / 2 : window.innerHeight / 2;

          return {
            type: eventName.replace(/^on/, "").toLowerCase(),
            target,
            currentTarget,
            nativeEvent: { isTrusted: true, target, currentTarget, clientX, clientY, button: 0, buttons: 1 },
            isTrusted: true,
            bubbles: true,
            cancelable: true,
            button: 0,
            buttons: 1,
            clientX,
            clientY,
            pointerId: 1,
            pointerType: "mouse",
            isPrimary: true,
            detail: 1,
            timeStamp: Date.now(),
            preventDefault() { defaultPrevented = true; },
            stopPropagation() { propagationStopped = true; },
            isDefaultPrevented() { return defaultPrevented; },
            isPropagationStopped() { return propagationStopped; },
            persist() {}
          };
        };

        const invokeReactHandlers = (button) => {
          const invoked = [];
          const handlerNames = [
            "onPointerDown",
            "onMouseDown",
            "onPointerUp",
            "onMouseUp",
            "onClick"
          ];
          const targets = [];
          let current = button;
          let depth = 0;

          while (current instanceof HTMLElement && depth < 6) {
            targets.push(current);
            current = current.parentElement;
            depth += 1;
          }

          for (const handlerName of handlerNames) {
            for (const target of targets) {
              const props = getReactProps(target);
              const handler = props?.[handlerName];

              if (typeof handler !== "function") {
                continue;
              }

              const event = createReactLikeEvent(button, target, handlerName);
              try {
                handler.call(target, event);
                invoked.push(`${target.tagName}.${handlerName}`);
              } catch (error) {
                invoked.push(`${target.tagName}.${handlerName}:error:${error.message}`);
              }

              if (event.isPropagationStopped()) {
                return invoked;
              }
            }
          }

          return invoked;
        };

        const dispatchDomEvents = (button) => {
          const rect = button.getBoundingClientRect();
          const clientX = rect.width ? rect.left + rect.width / 2 : window.innerWidth / 2;
          const clientY = rect.height ? rect.top + rect.height / 2 : window.innerHeight / 2;
          const mouseInit = {
            bubbles: true,
            cancelable: true,
            clientX,
            clientY,
            button: 0,
            view: window,
            detail: 1
          };
          const pointerInit = {
            ...mouseInit,
            pointerId: 1,
            pointerType: "mouse",
            isPrimary: true
          };
          const dispatched = [];
          const dispatch = (target, EventClass, type, init) => {
            try {
              target.dispatchEvent(new EventClass(type, init));
              dispatched.push(`${target.tagName}.${type}`);
            } catch (error) {
              dispatched.push(`${target.tagName}.${type}:error:${error.message}`);
            }
          };
          const icon = button.querySelector("i") || button.firstElementChild;
          const targets = [button];
          if (icon instanceof HTMLElement) {
            targets.push(icon);
          }

          for (const target of targets) {
            dispatch(target, PointerEvent, "pointerover", pointerInit);
            dispatch(target, PointerEvent, "pointerenter", { ...pointerInit, bubbles: false });
            dispatch(target, MouseEvent, "mouseover", mouseInit);
            dispatch(target, MouseEvent, "mouseenter", { ...mouseInit, bubbles: false });
            dispatch(target, PointerEvent, "pointerdown", pointerInit);
            dispatch(target, MouseEvent, "mousedown", mouseInit);
            dispatch(target, PointerEvent, "pointerup", pointerInit);
            dispatch(target, MouseEvent, "mouseup", mouseInit);
            try {
              target.click();
              dispatched.push(`${target.tagName}.nativeClick`);
            } catch (error) {
              dispatched.push(`${target.tagName}.nativeClick:error:${error.message}`);
            }
            dispatch(target, MouseEvent, "click", mouseInit);
          }

          return dispatched;
        };

        const requestSubmitFallback = (button) => {
          const form = button.closest("form");
          if (!form) {
            return "no-form";
          }

          try {
            if (typeof form.requestSubmit === "function") {
              form.requestSubmit(button);
              return "requestSubmit";
            }

            form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
            return "submit-event";
          } catch (error) {
            return `form-error:${error.message}`;
          }
        };

        try {
          const candidates = getButtonCandidates();
          const candidate = candidates[0];

          if (!candidate) {
            return { ok: false, error: "No matching submit button found", candidateCount: 0 };
          }

          const button = candidate.button;
          const rect = button.getBoundingClientRect();
          const point = {
            x: rect.width ? rect.left + rect.width / 2 : window.innerWidth / 2,
            y: rect.height ? rect.top + rect.height / 2 : window.innerHeight / 2
          };

          if (candidate.disabled) {
            return {
              ok: false,
              error: "Submit button stayed disabled",
              buttonDisabled: true,
              candidateCount: candidates.length,
              point
            };
          }

          try { button.scrollIntoView({ block: "center", inline: "center" }); } catch (_error) {}
          try { button.focus(); } catch (_error) {}

          const domEvents = dispatchDomEvents(button);
          const reactHandlers = invokeReactHandlers(button);
          const formSubmit = requestSubmitFallback(button);

          return {
            ok: true,
            method: "force-main-world-submit-click",
            buttonText: (button.textContent || "").trim().slice(0, 80),
            candidateCount: candidates.length,
            point,
            domEvents,
            reactHandlers,
            formSubmit
          };
        } catch (error) {
          return { ok: false, error: error.message };
        }
      }, [buttonSelector, iconFilter]);

      let trustedResult = { ok: false, method: "debugger-trusted-click", skipped: true };

      if (shouldUseDebugger && mainResult?.point) {
        trustedResult = await dispatchTrustedClick(sender.tab.id, mainResult.point);
      }

      sendResponse({
        ok: Boolean(mainResult?.ok || trustedResult?.ok),
        method: trustedResult?.ok ? "force-submit-click-with-debugger" : "force-submit-click",
        mainResult,
        trustedResult
      });
    })().catch((error) => {
      sendResponse({ ok: false, error: error.message });
    });

    return true;
  }

  if (message?.type === "FLOW_HELPER_MAIN_WORLD_CLICK") {
    if (!sender?.tab?.id) {
      sendResponse({ ok: false, error: "No sender tab found" });
      return true;
    }

    const buttonSelector = message.selector || 'button:has(i.google-symbols)';
    const iconFilter = message.iconFilter || 'arrow_forward';
    const timeoutMs = Number.isFinite(message.timeoutMs) ? message.timeoutMs : 6000;

    chrome.scripting.executeScript({
      target: { tabId: sender.tab.id },
      world: "MAIN",
      func: (selector, iconText, waitMs) => {
        return new Promise((resolve) => {
          try {
            const startedAt = Date.now();

            const isDisabled = (button) => {
              return (
                button.disabled ||
                button.getAttribute("aria-disabled") === "true" ||
                button.dataset.disabled === "true"
              );
            };

            const isVisibleEnough = (button) => {
              const style = window.getComputedStyle(button);
              return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
            };

            const getButtonCandidates = () => {
              let buttons = [];
              try {
                buttons = Array.from(document.querySelectorAll(selector));
              } catch (_error) {
                buttons = Array.from(document.querySelectorAll("button"));
              }

              const referenceElement =
                document.activeElement?.closest?.('[contenteditable="true"]') ||
                document.querySelector('[contenteditable="true"][data-slate-editor="true"]');
              const referenceRect = referenceElement?.getBoundingClientRect?.() || null;

              return buttons
                .filter((button) => button instanceof HTMLButtonElement)
                .filter((button) => !button.closest("#autogen-flow-helper-root"))
                .filter((button) => !button.getAttribute("aria-haspopup"))
                .filter((button) => isVisibleEnough(button))
                .filter((button) => {
                  const icons = Array.from(button.querySelectorAll("i"));
                  return icons.some((icon) => (icon.textContent || "").trim().includes(iconText));
                })
                .map((button) => {
                  const rect = button.getBoundingClientRect();
                  const distance = referenceRect
                    ? Math.hypot(
                      rect.left + rect.width / 2 - (referenceRect.left + referenceRect.width / 2),
                      rect.top + rect.height / 2 - (referenceRect.top + referenceRect.height / 2)
                    )
                    : 0;

                  return {
                    button,
                    disabled: isDisabled(button),
                    distance
                  };
                })
                .sort((left, right) => {
                  if (left.disabled !== right.disabled) {
                    return left.disabled ? 1 : -1;
                  }
                  return left.distance - right.distance;
                });
            };

            const dispatchClickSequence = (button) => {
              const rect = button.getBoundingClientRect();
              const clientX = rect.width ? rect.left + rect.width / 2 : window.innerWidth / 2;
              const clientY = rect.height ? rect.top + rect.height / 2 : window.innerHeight / 2;
              const mouseInit = {
                bubbles: true,
                cancelable: true,
                clientX,
                clientY,
                button: 0,
                view: window,
                detail: 1
              };
              const pointerInit = {
                ...mouseInit,
                pointerId: 1,
                pointerType: "mouse",
                isPrimary: true
              };

              try { button.scrollIntoView({ block: "center", inline: "center" }); } catch (_error) {}
              try { button.focus(); } catch (_error) {}

              try { button.dispatchEvent(new PointerEvent("pointerover", pointerInit)); } catch (_error) {}
              try { button.dispatchEvent(new PointerEvent("pointerenter", { ...pointerInit, bubbles: false })); } catch (_error) {}
              button.dispatchEvent(new MouseEvent("mouseover", mouseInit));
              button.dispatchEvent(new MouseEvent("mouseenter", { ...mouseInit, bubbles: false }));
              try { button.dispatchEvent(new PointerEvent("pointerdown", pointerInit)); } catch (_error) {}
              button.dispatchEvent(new MouseEvent("mousedown", mouseInit));

              setTimeout(() => {
                try { button.dispatchEvent(new PointerEvent("pointerup", pointerInit)); } catch (_error) {}
                button.dispatchEvent(new MouseEvent("mouseup", mouseInit));
                button.click();
                button.dispatchEvent(new MouseEvent("click", mouseInit));
                console.log("Flow Helper [MAIN]: Submit click sequence dispatched", button);
                resolve({
                  ok: true,
                  method: "main-world-click",
                  buttonText: (button.textContent || "").trim().slice(0, 80)
                });
              }, 80);
            };

            const tick = () => {
              const candidates = getButtonCandidates();
              const bestCandidate = candidates[0];

              if (bestCandidate && !bestCandidate.disabled) {
                dispatchClickSequence(bestCandidate.button);
                return;
              }

              if (Date.now() - startedAt >= waitMs) {
                resolve({
                  ok: false,
                  error: bestCandidate ? "Submit button stayed disabled" : "No matching button found in MAIN world",
                  buttonDisabled: Boolean(bestCandidate?.disabled),
                  candidateCount: candidates.length
                });
                return;
              }

              setTimeout(tick, 150);
            };

            tick();
          } catch (err) {
            resolve({ ok: false, error: err.message });
          }
        });
      },
      args: [buttonSelector, iconFilter, timeoutMs]
    }).then((results) => {
      const result = results?.[0]?.result;
      console.log("Flow Helper: MAIN world click result:", result);
      sendResponse(result || { ok: false, error: "No result from MAIN world" });
    }).catch((error) => {
      console.error("Flow Helper: MAIN world click failed:", error);
      sendResponse({ ok: false, error: error.message });
    });
    return true;
  }

  // Combined text insertion + submit in the MAIN world using Slate's editor API.
  // document.execCommand fails because it inserts text into Slate's zero-width
  // DOM node without updating the Slate model. By finding the editor instance
  // through React fiber traversal and calling editor.insertText(), we update
  // the actual Slate model which triggers proper React re-renders.
  if (message?.type === "FLOW_HELPER_MAIN_WORLD_TYPE_AND_SUBMIT") {
    if (!sender?.tab?.id) {
      sendResponse({ ok: false, error: "No sender tab found" });
      return true;
    }

    const promptText = message.prompt || "";

    chrome.scripting.executeScript({
      target: { tabId: sender.tab.id },
      world: "MAIN",
      func: (text) => {
        return new Promise((resolve) => {
          try {
            // ── Step 1: Find the Slate prompt editor DOM element ──
            const editors = document.querySelectorAll('[contenteditable="true"][data-slate-editor="true"]');
            let targetEditorEl = null;

            for (const ed of editors) {
              const placeholder = ed.querySelector('[data-slate-placeholder="true"]');
              const phText = placeholder ? placeholder.textContent : "";
              if (phText.includes("สร้าง") || phText.includes("create") || phText.includes("want")) {
                targetEditorEl = ed;
                break;
              }
            }
            if (!targetEditorEl && editors.length > 0) {
              targetEditorEl = editors[0];
            }
            if (!targetEditorEl) {
              resolve({ ok: false, error: "No Slate editor found" });
              return;
            }

            console.log("Flow Helper [MAIN]: Found Slate editor element");

            // ── Step 2: Find Slate editor instance via React fiber ──
            const fiberKey = Object.keys(targetEditorEl).find(k =>
              k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$")
            );

            let slateEditor = null;
            if (fiberKey) {
              let fiber = targetEditorEl[fiberKey];
              let depth = 0;
              while (fiber && depth < 50) {
                // Check memoizedProps for editor
                const props = fiber.memoizedProps || fiber.pendingProps || {};
                if (props.editor && typeof props.editor.apply === "function") {
                  slateEditor = props.editor;
                  console.log("Flow Helper [MAIN]: Found Slate editor via props.editor");
                  break;
                }
                // Check for onDOMBeforeInput (Editable component signature)
                if (props.onDOMBeforeInput && fiber.memoizedProps?.editor) {
                  slateEditor = fiber.memoizedProps.editor;
                  console.log("Flow Helper [MAIN]: Found Slate editor via Editable fiber");
                  break;
                }
                // Check hook state
                let hookState = fiber.memoizedState;
                let hookIdx = 0;
                while (hookState && hookIdx < 20) {
                  const val = hookState.memoizedState;
                  if (val && typeof val === "object" && typeof val.apply === "function" && val.children) {
                    slateEditor = val;
                    console.log("Flow Helper [MAIN]: Found Slate editor via hook state");
                    break;
                  }
                  // Check ref values
                  if (val && val.current && typeof val.current.apply === "function" && val.current.children) {
                    slateEditor = val.current;
                    console.log("Flow Helper [MAIN]: Found Slate editor via ref");
                    break;
                  }
                  hookState = hookState.next;
                  hookIdx++;
                }
                if (slateEditor) break;
                fiber = fiber.return;
                depth++;
              }
            }

            if (!slateEditor) {
              console.warn("Flow Helper [MAIN]: Could not find Slate editor instance, trying execCommand fallback");
              // Fallback: try execCommand anyway
              targetEditorEl.focus();
              const sel = window.getSelection();
              const range = document.createRange();
              range.selectNodeContents(targetEditorEl);
              sel.removeAllRanges();
              sel.addRange(range);
              document.execCommand("delete", false, null);
              document.execCommand("insertText", false, text);
              resolve({ ok: false, error: "Slate editor instance not found — used execCommand fallback" });
              return;
            }

            // ── Step 3: Clear editor content via Slate API ──
            console.log("Flow Helper [MAIN]: Current editor children:", JSON.stringify(slateEditor.children).slice(0, 200));

            // Select all content
            try {
              const endPath = [];
              let node = slateEditor;
              while (node.children && node.children.length > 0) {
                endPath.push(node.children.length - 1);
                node = node.children[node.children.length - 1];
              }
              const endOffset = (node.text || "").length;

              if (endPath.length > 0) {
                slateEditor.selection = {
                  anchor: { path: [0, 0], offset: 0 },
                  focus: { path: endPath, offset: endOffset }
                };
                // Delete all selected content
                slateEditor.deleteFragment();
                console.log("Flow Helper [MAIN]: Editor content cleared via deleteFragment");
              }
            } catch (clearError) {
              console.warn("Flow Helper [MAIN]: deleteFragment failed, trying alternative clear:", clearError.message);
              // Alternative: set children directly
              try {
                slateEditor.children = [{ type: "paragraph", children: [{ text: "" }] }];
                slateEditor.selection = { anchor: { path: [0, 0], offset: 0 }, focus: { path: [0, 0], offset: 0 } };
                slateEditor.onChange();
              } catch (e2) {
                console.warn("Flow Helper [MAIN]: Alternative clear also failed:", e2.message);
              }
            }

            // ── Step 4: Insert text via Slate API ──
            try {
              // Ensure cursor is at start
              slateEditor.selection = {
                anchor: { path: [0, 0], offset: 0 },
                focus: { path: [0, 0], offset: 0 }
              };
              slateEditor.insertText(text);
              console.log("Flow Helper [MAIN]: Text inserted via editor.insertText()");
            } catch (insertError) {
              console.warn("Flow Helper [MAIN]: insertText failed:", insertError.message);
              // Try applying operation directly
              try {
                slateEditor.apply({
                  type: "insert_text",
                  path: [0, 0],
                  offset: 0,
                  text: text
                });
                console.log("Flow Helper [MAIN]: Text inserted via editor.apply()");
              } catch (applyError) {
                console.warn("Flow Helper [MAIN]: apply also failed:", applyError.message);
                resolve({ ok: false, error: "All Slate insertion methods failed" });
                return;
              }
            }

            // Trigger onChange to ensure React re-renders
            try {
              if (typeof slateEditor.onChange === "function") {
                slateEditor.onChange();
              }
            } catch (_e) {}

            console.log("Flow Helper [MAIN]: Editor children after insert:", JSON.stringify(slateEditor.children).slice(0, 200));

            // Step 5: wait for React to enable the submit button, then click it.
            const waitStartedAt = Date.now();

            const isSubmitButtonDisabled = (button) => {
              return (
                button.disabled ||
                button.getAttribute("aria-disabled") === "true" ||
                button.dataset.disabled === "true"
              );
            };

            const isVisibleEnough = (button) => {
              const style = window.getComputedStyle(button);
              return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
            };

            const findSubmitButton = () => {
              const editorRect = targetEditorEl.getBoundingClientRect();

              return Array.from(document.querySelectorAll("button"))
                .filter((button) => button instanceof HTMLButtonElement)
                .filter((button) => !button.closest("#autogen-flow-helper-root"))
                .filter((button) => !button.getAttribute("aria-haspopup"))
                .filter((button) => isVisibleEnough(button))
                .filter((button) => {
                  const icons = Array.from(button.querySelectorAll("i"));
                  return icons.some((icon) => (icon.textContent || "").trim().includes("arrow_forward"));
                })
                .map((button) => {
                  const rect = button.getBoundingClientRect();
                  const distance = Math.hypot(
                    rect.left + rect.width / 2 - (editorRect.left + editorRect.width / 2),
                    rect.top + rect.height / 2 - (editorRect.top + editorRect.height / 2)
                  );

                  return {
                    button,
                    disabled: isSubmitButtonDisabled(button),
                    distance
                  };
                })
                .sort((left, right) => {
                  if (left.disabled !== right.disabled) {
                    return left.disabled ? 1 : -1;
                  }
                  return left.distance - right.distance;
                })[0] || null;
            };

            const clickSubmitButton = (submitBtn, editorText, hasPlaceholder) => {
              const rect = submitBtn.getBoundingClientRect();
              const clientX = rect.width ? rect.left + rect.width / 2 : window.innerWidth / 2;
              const clientY = rect.height ? rect.top + rect.height / 2 : window.innerHeight / 2;
              const mouseInit = {
                bubbles: true,
                cancelable: true,
                clientX,
                clientY,
                button: 0,
                view: window,
                detail: 1
              };
              const pointerInit = {
                ...mouseInit,
                pointerId: 1,
                pointerType: "mouse",
                isPrimary: true
              };

              try { submitBtn.scrollIntoView({ block: "center", inline: "center" }); } catch (_error) {}
              try { submitBtn.focus(); } catch (_error) {}
              try { submitBtn.dispatchEvent(new PointerEvent("pointerover", pointerInit)); } catch (_error) {}
              try { submitBtn.dispatchEvent(new PointerEvent("pointerenter", { ...pointerInit, bubbles: false })); } catch (_error) {}
              submitBtn.dispatchEvent(new MouseEvent("mouseover", mouseInit));
              submitBtn.dispatchEvent(new MouseEvent("mouseenter", { ...mouseInit, bubbles: false }));
              try { submitBtn.dispatchEvent(new PointerEvent("pointerdown", pointerInit)); } catch (_error) {}
              submitBtn.dispatchEvent(new MouseEvent("mousedown", mouseInit));

              setTimeout(() => {
                try { submitBtn.dispatchEvent(new PointerEvent("pointerup", pointerInit)); } catch (_error) {}
                submitBtn.dispatchEvent(new MouseEvent("mouseup", mouseInit));
                submitBtn.click();
                submitBtn.dispatchEvent(new MouseEvent("click", mouseInit));
                console.log("Flow Helper [MAIN]: Submit click sequence dispatched!");

                resolve({
                  ok: true,
                  method: "slate-api-type-and-submit",
                  editorText: editorText.slice(0, 50),
                  slateStringFound: Boolean(editorText),
                  placeholderGone: !hasPlaceholder,
                  buttonDisabled: false
                });
              }, 80);
            };

            const waitForSubmitButton = () => {
              try {
                // Verify text was committed
                const slateString = targetEditorEl.querySelector('[data-slate-string="true"]');
                const hasPlaceholder = targetEditorEl.querySelector('[data-slate-placeholder="true"]');
                const editorText = slateString ? slateString.textContent : "";

                console.log("Flow Helper [MAIN]: Post-insert check — slateString:", !!slateString, "placeholder:", !!hasPlaceholder, "text:", editorText.slice(0, 50));

                if (!slateString || hasPlaceholder) {
                  console.warn("Flow Helper [MAIN]: Text did not commit to Slate model (placeholder still visible)");
                }

                const submitCandidate = findSubmitButton();

                if (!submitCandidate) {
                  if (Date.now() - waitStartedAt < 6000) {
                    setTimeout(waitForSubmitButton, 150);
                    return;
                  }
                  resolve({ ok: false, error: "Submit button not found" });
                  return;
                }

                console.log("Flow Helper [MAIN]: Submit button disabled?", submitCandidate.disabled);

                if (submitCandidate.disabled) {
                  if (Date.now() - waitStartedAt < 6000) {
                    setTimeout(waitForSubmitButton, 150);
                    return;
                  }
                  resolve({
                    ok: false,
                    error: "Submit button stayed disabled",
                    editorText: editorText.slice(0, 50),
                    slateStringFound: !!slateString,
                    placeholderGone: !hasPlaceholder,
                    buttonDisabled: true
                  });
                  return;
                }

                resolve({
                  ok: true,
                  method: "slate-api-type-ready",
                  editorText: editorText.slice(0, 50),
                  slateStringFound: !!slateString,
                  placeholderGone: !hasPlaceholder,
                  buttonDisabled: false
                });
              } catch (err) {
                resolve({ ok: false, error: "Post-insertion failed: " + err.message });
              }
            };

            setTimeout(waitForSubmitButton, 800);
          } catch (err) {
            resolve({ ok: false, error: err.message });
          }
        });
      },
      args: [promptText]
    }).then((results) => {
      const result = results?.[0]?.result;
      console.log("Flow Helper: MAIN world type-and-submit result:", result);
      sendResponse(result || { ok: false, error: "No result" });
    }).catch((error) => {
      console.error("Flow Helper: MAIN world type-and-submit failed:", error);
      sendResponse({ ok: false, error: error.message });
    });
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
