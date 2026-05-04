chrome.runtime.onInstalled.addListener(() => {
  console.log("Google Labs Flow Helper installed");
});

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

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
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
    chrome.downloads.download({
      url: message.url,
      saveAs: false
    }).then((downloadId) => {
      sendResponse({ ok: true, downloadId });
    }).catch((error) => {
      console.error("Flow Helper: Background download failed", error);
      sendResponse({ ok: false, error: error.message });
    });
    return true;
  }
});

