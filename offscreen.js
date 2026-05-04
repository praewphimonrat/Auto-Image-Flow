// 1-second silent WAV file
const SILENT_AUDIO = "data:audio/wav;base64,UklGRigAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQQAAAAAAA==";
let audio = null;
let audioStarted = false;

function startKeepAlive() {
  console.log("Flow Helper: Starting keep-alive in offscreen document");
  
  // Try to start silent audio, but don't fail if it doesn't work
  if (!audioStarted) {
    try {
      audio = new Audio(SILENT_AUDIO);
      audio.loop = true;
      audio.volume = 0; // Ensure it's completely silent
      
      // Try to play, but catch any errors
      const playPromise = audio.play();
      if (playPromise !== undefined) {
        playPromise.then(() => {
          console.log("Flow Helper: Silent audio started successfully");
          audioStarted = true;
        }).catch((error) => {
          console.log("Flow Helper: Silent audio failed (expected without user interaction):", error.message);
          // This is expected - browser blocks autoplay without user interaction
        });
      }
    } catch (error) {
      console.log("Flow Helper: Could not create silent audio:", error.message);
    }
  }

  // Keep the service worker alive by pinging it every 20 seconds
  setInterval(() => {
    chrome.runtime.sendMessage({ type: "FLOW_HELPER_PING" }).catch(() => {
      // Ignore if context invalidated
    });
  }, 20000);
}

// Try to start audio when user interacts with the page
function tryStartAudioOnInteraction() {
  if (audioStarted || !audio) return;
  
  try {
    const playPromise = audio.play();
    if (playPromise !== undefined) {
      playPromise.then(() => {
        console.log("Flow Helper: Silent audio started after user interaction");
        audioStarted = true;
        // Remove listeners since we only need to start once
        document.removeEventListener('click', tryStartAudioOnInteraction);
        document.removeEventListener('keydown', tryStartAudioOnInteraction);
      }).catch(() => {
        // Still might fail, that's ok
      });
    }
  } catch (error) {
    // Ignore errors
  }
}

// Listen for user interactions to start audio
document.addEventListener('click', tryStartAudioOnInteraction);
document.addEventListener('keydown', tryStartAudioOnInteraction);

startKeepAlive();