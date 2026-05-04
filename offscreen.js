// 1-second silent WAV file
const SILENT_AUDIO = "data:audio/wav;base64,UklGRigAAABXQVZFRm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQQAAAAAAA==";
const audio = new Audio(SILENT_AUDIO);
audio.loop = true;

function startKeepAlive() {
  console.log("Flow Helper: Starting silent audio keep-alive in offscreen document");
  
  audio.play().catch((error) => {
    console.error("Flow Helper: Failed to play silent audio", error);
  });

  // Keep the service worker alive by pinging it every 20 seconds
  setInterval(() => {
    chrome.runtime.sendMessage({ type: "FLOW_HELPER_PING" }).catch(() => {
      // Ignore if context invalidated
    });
  }, 20000);
}

startKeepAlive();
