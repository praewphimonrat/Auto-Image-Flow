const FLOW_HELPER_ROOT_ID = "autogen-flow-helper-root";
const FLOW_HELPER_OPENER_ID = "autogen-flow-helper-opener";
const FLOW_HELPER_OPEN_CLASS = "autogen-flow-helper-panel-open";
const FLOW_HELPER_SHIFT_ATTR = "data-autogen-flow-helper-shiftable";
const FLOW_HELPER_STORAGE_KEY = "flowHelperPanelOpen";
const PANEL_MIN_WIDTH = 320;
const PANEL_MAX_WIDTH = 400;
const PANEL_WIDTH_RATIO = 0.28;
const PANEL_GUTTER = 16;
const FLOW_HELPER_DEBUG = false;

function installContentConsoleFilter() {
  if (FLOW_HELPER_DEBUG || window.__flowHelperContentConsoleFiltered) {
    return;
  }

  window.__flowHelperContentConsoleFiltered = true;

  for (const method of ["log", "debug", "warn", "error", "info"]) {
    const original = console[method]?.bind(console);

    if (typeof original !== "function") {
      continue;
    }

    console[method] = (...args) => {
      const firstArg = String(args[0] || "");
      if (
        firstArg.startsWith("Flow Helper") ||
        firstArg.includes("Flow log submission failed") ||
        firstArg.includes("batchLog") ||
        firstArg.includes("Invalid value used as weak map key")
      ) {
        return;
      }

      original(...args);
    };
  }
}

function isExtensionContextValid() {
  try {
    return Boolean(chrome?.runtime?.id);
  } catch (_error) {
    return false;
  }
}

function isContextInvalidatedError(error) {
  const message = String(error?.message || error || "");
  return message.includes("Extension context invalidated") ||
    message.includes("Extension context was invalidated");
}

const state = {
  isOpen: true,
  root: null,
  openerButton: null,
  toggleButton: null,
  toggleIcon: null,
  toggleLabel: null,
  panelInner: null,
  projectIdValue: null,
  pageUrlValue: null,
  shiftTargets: [],
  bodyObserver: null
};

function getExistingElement(id) {
  const element = document.getElementById(id);
  return element instanceof HTMLElement ? element : null;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function getPanelWidth() {
  return clamp(
    Math.round(window.innerWidth * PANEL_WIDTH_RATIO),
    PANEL_MIN_WIDTH,
    PANEL_MAX_WIDTH
  );
}

function getReservedPageWidth() {
  return getPanelWidth() + PANEL_GUTTER * 2;
}

function getProjectInfo() {
  const segments = window.location.pathname.split("/").filter(Boolean);
  const projectIndex = segments.lastIndexOf("project");
  const projectId = projectIndex >= 0 ? segments[projectIndex + 1] || "unknown" : "unknown";

  return {
    href: window.location.href,
    projectId
  };
}

function isHelperNode(element) {
  return element.id === FLOW_HELPER_ROOT_ID || element.id === FLOW_HELPER_OPENER_ID;
}

function isMeaningfulNode(element) {
  if (!(element instanceof HTMLElement)) {
    return false;
  }

  if (isHelperNode(element)) {
    return false;
  }

  return !["SCRIPT", "STYLE", "LINK", "META", "NOSCRIPT"].includes(element.tagName);
}

function syncShiftTargets() {
  const nextTargets = Array.from(document.body.children).filter(isMeaningfulNode);
  const nextTargetSet = new Set(nextTargets);

  for (const previousTarget of state.shiftTargets) {
    if (!nextTargetSet.has(previousTarget)) {
      previousTarget.removeAttribute(FLOW_HELPER_SHIFT_ATTR);
    }
  }

  for (const nextTarget of nextTargets) {
    nextTarget.setAttribute(FLOW_HELPER_SHIFT_ATTR, "true");
  }

  state.shiftTargets = nextTargets;
}

function updateProjectInfo() {
  const projectInfo = getProjectInfo();

  if (state.projectIdValue) {
    state.projectIdValue.textContent = projectInfo.projectId;
  }

  if (state.pageUrlValue) {
    state.pageUrlValue.textContent = projectInfo.href;
  }

  // Prevent Chrome from discarding this tab to save memory
  if (!isExtensionContextValid()) {
    return;
  }

  try {
    const result = chrome.runtime.sendMessage({
      type: "FLOW_HELPER_PREVENT_DISCARD"
    });
    if (result && typeof result.catch === "function") {
      result.catch(() => {});
    }
  } catch (_error) {
    // Extension context invalidated — silently ignore.
  }
}

function installPageQuietMode() {
  if (!isExtensionContextValid()) {
    return;
  }

  try {
    const result = chrome.runtime.sendMessage({
      type: "FLOW_HELPER_INSTALL_QUIET_MODE"
    });

    if (result && typeof result.catch === "function") {
      result.catch(() => {});
    }
  } catch (_error) {
    // Extension context invalidated — silently ignore.
  }
}

// Lightly spoof visibility so Google Labs Flow does not throttle generation
// when the tab is in the background. Anything heavier (RAF, IntersectionObserver,
// blur/focusout listeners, window.focus) breaks React/Slate on labs.google.
function injectVisibilitySpoofer() {
  try {
    if (window.__flowHelperVisibilitySpoofed) return;
    window.__flowHelperVisibilitySpoofed = true;

    Object.defineProperty(document, 'visibilityState', {
      get: () => 'visible',
      configurable: true
    });

    Object.defineProperty(document, 'hidden', {
      get: () => false,
      configurable: true
    });

    const originalHasFocus = document.hasFocus.bind(document);
    document.hasFocus = function flowHelperHasFocus() {
      try {
        return originalHasFocus() || true;
      } catch (_error) {
        return true;
      }
    };

    const VISIBILITY_EVENTS = new Set(['visibilitychange', 'webkitvisibilitychange']);

    const originalDocumentAdd = document.addEventListener.bind(document);
    document.addEventListener = function(type, listener, options) {
      if (VISIBILITY_EVENTS.has(type)) {
        return;
      }
      return originalDocumentAdd(type, listener, options);
    };

    const originalWindowAdd = window.addEventListener.bind(window);
    window.addEventListener = function(type, listener, options) {
      if (VISIBILITY_EVENTS.has(type)) {
        return;
      }
      return originalWindowAdd(type, listener, options);
    };

    console.log("Flow Helper: Visibility spoofed (minimal)");
  } catch (error) {
    console.warn("Flow Helper: Could not inject visibility spoofer", error);
  }
}

function persistOpenState() {
  if (!isExtensionContextValid()) {
    return;
  }

  try {
    chrome.storage.local.set({
      [FLOW_HELPER_STORAGE_KEY]: state.isOpen
    });
  } catch (error) {
    if (!isContextInvalidatedError(error)) {
      console.warn("Flow Helper could not persist panel state", error);
    }
  }
}

function loadOpenState() {
  return new Promise((resolve) => {
    if (!isExtensionContextValid()) {
      resolve(true);
      return;
    }

    try {
      chrome.storage.local.get([FLOW_HELPER_STORAGE_KEY], (result) => {
        if (chrome.runtime?.lastError) {
          resolve(true);
          return;
        }

        resolve(result[FLOW_HELPER_STORAGE_KEY] !== false);
      });
    } catch (error) {
      if (!isContextInvalidatedError(error)) {
        console.warn("Flow Helper could not load panel state", error);
      }
      resolve(true);
    }
  });
}

function updateToggleUi() {
  if (!state.root || !state.toggleButton || !state.toggleIcon || !state.toggleLabel || !state.panelInner || !state.openerButton) {
    return;
  }

  state.root.dataset.state = state.isOpen ? "open" : "closed";
  state.toggleButton.setAttribute("aria-expanded", String(state.isOpen));
  state.toggleButton.title = state.isOpen ? "Hide panel" : "Show panel";
  state.toggleIcon.textContent = state.isOpen ? ">" : "<";
  state.toggleLabel.textContent = state.isOpen ? "Close panel" : "Open panel";
  state.panelInner.setAttribute("aria-hidden", String(!state.isOpen));
  state.openerButton.hidden = state.isOpen;
}

function applyLayoutState() {
  const panelWidth = getPanelWidth();
  const reservedWidth = state.isOpen ? getReservedPageWidth() : 0;

  document.documentElement.style.setProperty("--autogen-flow-helper-panel-width", `${panelWidth}px`);
  document.documentElement.style.setProperty("--autogen-flow-helper-page-inset", `${reservedWidth}px`);
  document.documentElement.classList.toggle(FLOW_HELPER_OPEN_CLASS, state.isOpen);

  syncShiftTargets();
  updateProjectInfo();
  updateToggleUi();
}

function setOpenState(nextIsOpen, shouldPersist = true) {
  state.isOpen = nextIsOpen;
  applyLayoutState();

  if (shouldPersist) {
    persistOpenState();
  }
}

function openPanel() {
  setOpenState(true);
}

function togglePanel() {
  setOpenState(!state.isOpen);
}

function bindPanelElements(root) {
  state.root = root;
  state.toggleButton = root.querySelector(".flow-helper-toggle");
  state.toggleIcon = root.querySelector(".flow-helper-toggle__icon");
  state.toggleLabel = root.querySelector(".flow-helper-toggle__label");
  state.panelInner = root.querySelector(".flow-helper-panel__inner");
  state.projectIdValue = root.querySelector('[data-role="project-id"]');
  state.pageUrlValue = root.querySelector('[data-role="page-url"]');

  if (state.toggleButton) {
    state.toggleButton.onclick = togglePanel;
  }
}

function createPanel() {
  const existingRoot = getExistingElement(FLOW_HELPER_ROOT_ID);

  if (existingRoot) {
    bindPanelElements(existingRoot);
    return;
  }

  const root = document.createElement("aside");
  root.id = FLOW_HELPER_ROOT_ID;
  root.setAttribute("aria-live", "polite");
  root.innerHTML = `
    <div class="flow-helper-shell">
      <section class="flow-helper-panel" aria-label="Flow helper panel">
        <button class="flow-helper-toggle" type="button" aria-controls="flow-helper-panel-inner">
          <span class="flow-helper-toggle__icon" aria-hidden="true"></span>
          <span class="flow-helper-toggle__label"></span>
        </button>
        <div class="flow-helper-panel__inner" id="flow-helper-panel-inner">
          <header class="flow-helper-panel__header">
            <p class="flow-helper-panel__eyebrow">Google Labs Flow</p>
            <h2 class="flow-helper-panel__title">Prompt Queue</h2>
            <p class="flow-helper-panel__copy">
              Loading queue controls...
            </p>
          </header>
          <div class="flow-helper-panel__body">
            <section class="flow-helper-section">
              <p class="flow-helper-status">Preparing Flow Helper...</p>
            </section>
          </div>
        </div>
      </section>
    </div>
  `;

  document.body.appendChild(root);
  bindPanelElements(root);
}

function createOpenerButton() {
  const existingButton = getExistingElement(FLOW_HELPER_OPENER_ID);

  if (existingButton) {
    state.openerButton = existingButton;
    state.openerButton.onclick = openPanel;
    return;
  }

  const openerButton = document.createElement("button");
  openerButton.id = FLOW_HELPER_OPENER_ID;
  openerButton.type = "button";
  openerButton.innerHTML = `
    <span class="flow-helper-opener__icon" aria-hidden="true">&lt;</span>
    <span class="flow-helper-opener__label">Open panel</span>
  `;
  openerButton.onclick = openPanel;

  document.body.appendChild(openerButton);
  state.openerButton = openerButton;
}

function observeBodyChanges() {
  if (state.bodyObserver) {
    state.bodyObserver.disconnect();
  }

  state.bodyObserver = new MutationObserver(() => {
    syncShiftTargets();
  });

  state.bodyObserver.observe(document.body, {
    childList: true
  });
}

function watchNavigationChanges() {
  if (window.__flowHelperNavigationPatched) {
    return;
  }

  window.__flowHelperNavigationPatched = true;

  const originalPushState = history.pushState;
  const originalReplaceState = history.replaceState;

  const emitLocationChange = () => {
    window.dispatchEvent(new Event("flow-helper-locationchange"));
  };

  history.pushState = function pushState(...args) {
    originalPushState.apply(this, args);
    emitLocationChange();
  };

  history.replaceState = function replaceState(...args) {
    originalReplaceState.apply(this, args);
    emitLocationChange();
  };

  window.addEventListener("popstate", updateProjectInfo);
  window.addEventListener("flow-helper-locationchange", updateProjectInfo);
}

async function boot() {
  installContentConsoleFilter();
  injectVisibilitySpoofer();
  installPageQuietMode();
  createPanel();
  createOpenerButton();
  observeBodyChanges();
  watchNavigationChanges();

  state.isOpen = await loadOpenState();
  applyLayoutState();

  window.addEventListener("resize", applyLayoutState);

  console.log("Flow Helper panel ready", {
    ...getProjectInfo(),
    isOpen: state.isOpen
  });
  window.dispatchEvent(new Event("flow-helper-panel-ready"));
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => {
    void boot();
  }, { once: true });
} else {
  void boot();
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "FLOW_HELPER_PING") {
    sendResponse({
      ok: true,
      source: "content",
      panelOpen: state.isOpen,
      page: getProjectInfo()
    });
  }

  if (message?.type === "FLOW_HELPER_SET_PANEL_OPEN") {
    setOpenState(Boolean(message.open));

    sendResponse({
      ok: true,
      panelOpen: state.isOpen
    });
  }
});
