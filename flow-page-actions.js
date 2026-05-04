(function initFlowHelperPageActions() {
  if (window.FlowHelperPageActions) {
    return;
  }

  const FLOW_HELPER_ROOT_ID = "autogen-flow-helper-root";

  function normalizeText(value) {
    return String(value || "")
      .replace(/[ \t\f\v]+/g, " ")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .join("\n")
      .trim();
  }

  // Use setTimeout with a wrapper to bypass background tab throttling
  function delay(ms) {
    return new Promise((resolve) => {
      // For very short delays, use setTimeout
      if (ms < 1000) {
        setTimeout(resolve, ms);
        return;
      }
      
      // For longer delays in background tabs, use chrome.alarms API
      if (isBackgroundTab() && chrome.alarms) {
        const alarmName = `flow-helper-delay-${Date.now()}-${Math.random()}`;
        
        const handler = (alarm) => {
          if (alarm.name === alarmName) {
            chrome.alarms.onAlarm.removeListener(handler);
            resolve();
          }
        };
        
        chrome.alarms.onAlarm.addListener(handler);
        chrome.alarms.create(alarmName, { delayInMinutes: ms / 60000 });
      } else {
        // Fallback to setTimeout for foreground or when alarms not available
        setTimeout(resolve, ms);
      }
    });
  }

  function isBackgroundTab() {
    // True when the tab is not the active/focused tab
    return document.visibilityState === "hidden" || window.__flowHelperVisibilitySpoofed === true;
  }

  function isVisible(element) {
    if (!(element instanceof HTMLElement)) {
      return false;
    }

    // Check the element and its parents for display/visibility/opacity
    let current = element;
    while (current && current !== document.body) {
      const style = window.getComputedStyle(current);
      if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
        return false;
      }
      current = current.parentElement;
    }

    // In background tabs getBoundingClientRect returns 0/0 — skip size check
    if (isBackgroundTab()) {
      return true;
    }

    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function distanceBetweenRects(a, b) {
    const ax = a.left + a.width / 2;
    const ay = a.top + a.height / 2;
    const bx = b.left + b.width / 2;
    const by = b.top + b.height / 2;

    return Math.hypot(ax - bx, ay - by);
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

  function getVisibleButtons() {
    return Array.from(document.querySelectorAll("button")).filter((button) => {
      return (
        button instanceof HTMLButtonElement &&
        isVisible(button) &&
        !button.closest(`#${FLOW_HELPER_ROOT_ID}`)
      );
    });
  }

  function getButtonsByMatcher(matcher) {
    const matches = [];

    for (const button of getVisibleButtons()) {
      const buttonText = normalizeText(button.textContent);
      const iconText = normalizeText(Array.from(button.querySelectorAll("i")).map((icon) => icon.textContent).join(" "));

      if (matcher(button, buttonText, iconText)) {
        matches.push(button);
      }
    }

    return matches;
  }

  function getNearestElement(elements, referenceElement) {
    if (!referenceElement || !elements.length) {
      return elements[0] || null;
    }

    return (
      elements
        .map((element) => ({
          element,
          distance: distanceBetweenRects(element.getBoundingClientRect(), referenceElement.getBoundingClientRect())
        }))
        .sort((left, right) => left.distance - right.distance)[0]?.element || null
    );
  }

  function isButtonDisabled(button) {
    if (!(button instanceof HTMLButtonElement)) {
      return true;
    }

    return (
      button.disabled ||
      button.getAttribute("aria-disabled") === "true" ||
      button.dataset.disabled === "true"
    );
  }

  function findButtonByMatcher(matcher, referenceElement = null, options = {}) {
    const matches = getButtonsByMatcher(matcher);
    const candidates = options.includeDisabled ? matches : matches.filter((button) => !isButtonDisabled(button));

    return getNearestElement(candidates.length ? candidates : matches, referenceElement);
  }

  function findSendButton(referenceElement = null) {
    return findButtonByMatcher((_button, buttonText, iconText) => {
      return iconText.includes("arrow_forward") || buttonText === "สร้าง" || buttonText.endsWith(" สร้าง");
    }, referenceElement, {
      includeDisabled: true
    });
  }

  function findDownloadButton() {
    // ค้นหาปุ่มดาวน์โหลดที่เฉพาะเจาะจงสำหรับ Google Labs Flow
    const downloadButtons = getButtonsByMatcher((button, buttonText, iconText) => {
      // ตรวจสอบ icon ที่มี "download" 
      const hasDownloadIcon = iconText.includes("download");
      
      // ตรวจสอบ text ที่มี "ดาวน์โหลด"
      const hasDownloadText = buttonText.includes("ดาวน์โหลด");
      
      // ตรวจสอบ class ที่เฉพาะเจาะจง
      const hasSpecificClass = button.classList.contains("sc-e8425ea6-0") || 
                              button.classList.contains("gLXNUV") ||
                              button.querySelector('i.google-symbols');
      
      // ตรวจสอบ data attributes
      const hasDataState = button.hasAttribute("data-state");
      
      // ตรวจสอบ span ที่ซ่อนอยู่ที่มีข้อความ "ดาวน์โหลด"
      const hiddenSpan = button.querySelector('span[style*="position: absolute"]');
      const hasHiddenDownloadText = hiddenSpan && hiddenSpan.textContent.includes("ดาวน์โหลด");
      
      return (hasDownloadIcon || hasDownloadText || hasHiddenDownloadText) && 
             (hasSpecificClass || hasDataState);
    });

    // หาปุ่มที่ใกล้ที่สุดกับ reference element
    return downloadButtons.length > 0 ? downloadButtons[0] : null;
  }

  function findDeleteTriggerButton() {
    return findButtonByMatcher((_button, buttonText, iconText) => {
      return (buttonText.includes("ลบ") && iconText.includes("delete")) || iconText === "delete";
    });
  }

  function findDeleteConfirmButton() {
    return findButtonByMatcher((_button, buttonText, iconText) => {
      return buttonText === "ลบ" && !iconText.includes("delete");
    });
  }

  function getVisibleProgressElements() {
    return Array.from(document.querySelectorAll("div")).filter((element) => {
      if (!(element instanceof HTMLDivElement) || !isVisible(element)) {
        return false;
      }

      if (element.closest(`#${FLOW_HELPER_ROOT_ID}`)) {
        return false;
      }

      const text = normalizeText(element.textContent);
      const hasExpectedClass = typeof element.className === "string" && element.className.includes("sc-55ebc859-7");

      return hasExpectedClass && /^\d{1,3}%$/.test(text);
    });
  }

  function findPromptEditor() {
    const sendButton = findSendButton();
    const slateEditors = Array.from(
      document.querySelectorAll('div[role="textbox"][data-slate-editor="true"][data-slate-node="value"][contenteditable="true"]')
    ).filter((element) => {
      return element instanceof HTMLElement && isVisible(element) && !element.closest(`#${FLOW_HELPER_ROOT_ID}`);
    });

    if (slateEditors.length) {
      return getNearestElement(slateEditors, sendButton);
    }

    const slateParagraph = Array.from(document.querySelectorAll('p[data-slate-node="element"]')).filter((element) => {
      return element instanceof HTMLParagraphElement && isVisible(element) && !element.closest(`#${FLOW_HELPER_ROOT_ID}`);
    });

    if (slateParagraph.length) {
      return getNearestElement(
        slateParagraph.map((element) => element.closest('[contenteditable="true"]') || element),
        sendButton
      );
    }

    const candidateEditors = Array.from(document.querySelectorAll('[contenteditable="true"]')).filter((element) => {
      return element instanceof HTMLElement && isVisible(element) && !element.closest(`#${FLOW_HELPER_ROOT_ID}`);
    });

    if (!candidateEditors.length) {
      return null;
    }

    if (!sendButton) {
      return candidateEditors[0];
    }

    return candidateEditors
      .map((editor) => ({
        editor,
        distance: distanceBetweenRects(editor.getBoundingClientRect(), sendButton.getBoundingClientRect())
      }))
      .sort((left, right) => left.distance - right.distance)[0]?.editor || candidateEditors[0];
  }

  function resolveEditorRoot(editor) {
    if (!(editor instanceof HTMLElement)) {
      return null;
    }

    if (editor.matches('[data-slate-editor="true"][contenteditable="true"]')) {
      return editor;
    }

    return (
      editor.closest?.('[data-slate-editor="true"][contenteditable="true"]') ||
      editor.querySelector?.('[data-slate-editor="true"][contenteditable="true"]') ||
      editor
    );
  }

  function selectNodeContents(element) {
    const selection = window.getSelection();

    if (!selection) {
      return;
    }

    const range = document.createRange();
    range.selectNodeContents(element);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function getSlateParagraph(editor) {
    const editorRoot = resolveEditorRoot(editor);

    if (!(editorRoot instanceof HTMLElement)) {
      return null;
    }

    const paragraph = editorRoot.querySelector('p[data-slate-node="element"]');
    return paragraph instanceof HTMLParagraphElement ? paragraph : null;
  }

  function getSlateSelectionTarget(paragraph) {
    if (!(paragraph instanceof HTMLParagraphElement)) {
      return null;
    }

    const stringNode = paragraph.querySelector('[data-slate-string="true"]');

    if (stringNode?.firstChild instanceof Text) {
      return {
        node: stringNode.firstChild,
        offset: stringNode.firstChild.textContent?.length || 0
      };
    }

    const zeroWidthNode = paragraph.querySelector('[data-slate-zero-width]');

    if (zeroWidthNode?.firstChild instanceof Text) {
      return {
        node: zeroWidthNode.firstChild,
        offset: Math.min(zeroWidthNode.firstChild.textContent?.length || 0, 1)
      };
    }

    return null;
  }

  function setSelectionToParagraph(paragraph) {
    if (!(paragraph instanceof HTMLParagraphElement)) {
      return;
    }

    const selection = window.getSelection();

    if (!selection) {
      return;
    }

    const range = document.createRange();
    const selectionTarget = getSlateSelectionTarget(paragraph);

    if (selectionTarget?.node instanceof Text) {
      range.setStart(selectionTarget.node, selectionTarget.offset);
      range.setEnd(selectionTarget.node, selectionTarget.offset);
    } else {
      range.selectNodeContents(paragraph);
      range.collapse(false);
    }

    selection.removeAllRanges();
    selection.addRange(range);
  }

  function dispatchKeyboardEvent(element, eventName, options = {}) {
    if (!(element instanceof HTMLElement)) {
      return;
    }

    element.dispatchEvent(new KeyboardEvent(eventName, {
      bubbles: true,
      cancelable: true,
      ...options
    }));
  }

  function announceSelectionChange() {
    document.dispatchEvent(new Event("selectionchange", {
      bubbles: true
    }));
  }

  function activateEditorForTyping(editorRoot, slateParagraph) {
    if (!(editorRoot instanceof HTMLElement)) {
      return;
    }

    editorRoot.scrollIntoView({
      block: "center",
      inline: "nearest"
    });
    dispatchPointerSequence(editorRoot);
    editorRoot.click?.();
    editorRoot.focus();

    if (slateParagraph instanceof HTMLParagraphElement) {
      setSelectionToParagraph(slateParagraph);
    } else {
      selectNodeContents(editorRoot);
    }

    announceSelectionChange();
  }

  function ensureSlateTextContainers(paragraph) {
    let textNode = paragraph.querySelector(':scope > span[data-slate-node="text"]');

    if (!(textNode instanceof HTMLSpanElement)) {
      textNode = document.createElement("span");
      textNode.setAttribute("data-slate-node", "text");
      paragraph.replaceChildren(textNode);
    }

    let leafNode = textNode.querySelector(':scope > span[data-slate-leaf="true"]');

    if (!(leafNode instanceof HTMLSpanElement)) {
      leafNode = document.createElement("span");
      leafNode.setAttribute("data-slate-leaf", "true");
      textNode.replaceChildren(leafNode);
    }

    return {
      textNode,
      leafNode
    };
  }

  function buildSlateTextTree(prompt) {
    const textNode = document.createElement("span");
    textNode.setAttribute("data-slate-node", "text");

    const leafNode = document.createElement("span");
    leafNode.setAttribute("data-slate-leaf", "true");

    const stringNode = document.createElement("span");
    stringNode.setAttribute("data-slate-string", "true");
    stringNode.textContent = prompt;

    leafNode.appendChild(stringNode);
    textNode.appendChild(leafNode);

    return textNode;
  }

  function replaceSlateParagraphText(paragraph, prompt) {
    if (!(paragraph instanceof HTMLParagraphElement)) {
      return;
    }

    const { leafNode } = ensureSlateTextContainers(paragraph);
    const stringNode = buildSlateTextTree(prompt).querySelector('[data-slate-string="true"]');

    if (!(stringNode instanceof HTMLSpanElement)) {
      return;
    }

    leafNode.replaceChildren(stringNode);
  }

  function clearEditorText(editorRoot, slateParagraph) {
    activateEditorForTyping(editorRoot, slateParagraph);

    if (slateParagraph instanceof HTMLParagraphElement) {
      selectNodeContents(slateParagraph);
      announceSelectionChange();
    }

    try {
      document.execCommand("delete", false);
    } catch (error) {
      console.warn("Flow Helper delete failed", error);
    }

    if (slateParagraph instanceof HTMLParagraphElement) {
      setSelectionToParagraph(slateParagraph);
    }

    announceSelectionChange();
  }

  function tryInsertTextWithExecCommand(editorRoot, slateParagraph, prompt) {
    try {
      clearEditorText(editorRoot, slateParagraph);
      const inserted = document.execCommand("insertText", false, prompt);
      announceSelectionChange();

      return Boolean(inserted) || getEditorText(editorRoot) === normalizeText(prompt);
    } catch (error) {
      console.warn("Flow Helper execCommand failed", error);
      return false;
    }
  }

  function tryInsertTextWithBeforeInput(editorRoot, slateParagraph, prompt) {
    try {
      clearEditorText(editorRoot, slateParagraph);
      const beforeInputEvent = new InputEvent("beforeinput", {
        bubbles: true,
        cancelable: true,
        inputType: "insertText",
        data: prompt
      });
      const inputEvent = new InputEvent("input", {
        bubbles: true,
        cancelable: false,
        inputType: "insertText",
        data: prompt
      });

      editorRoot.dispatchEvent(beforeInputEvent);
      editorRoot.dispatchEvent(inputEvent);
      announceSelectionChange();

      return getEditorText(editorRoot) === normalizeText(prompt) || Boolean(findSendButton(editorRoot));
    } catch (error) {
      console.warn("Flow Helper synthetic beforeinput failed", error);
      return false;
    }
  }

  function tryInsertTextWithPasteEvent(editorRoot, slateParagraph, prompt) {
    try {
      clearEditorText(editorRoot, slateParagraph);
      dispatchKeyboardEvent(editorRoot, "keydown", {
        key: "v",
        code: "KeyV",
        ctrlKey: true
      });

      const clipboardData = new DataTransfer();
      clipboardData.setData("text/plain", prompt);

      const pasteEvent = new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true
      });

      Object.defineProperty(pasteEvent, "clipboardData", {
        configurable: true,
        value: clipboardData
      });

      editorRoot.dispatchEvent(new InputEvent("beforeinput", {
        bubbles: true,
        cancelable: true,
        inputType: "insertFromPaste",
        data: prompt
      }));
      editorRoot.dispatchEvent(pasteEvent);
      editorRoot.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        cancelable: false,
        inputType: "insertFromPaste",
        data: prompt
      }));
      dispatchKeyboardEvent(editorRoot, "keyup", {
        key: "v",
        code: "KeyV",
        ctrlKey: true
      });
      announceSelectionChange();

      return getEditorText(editorRoot) === normalizeText(prompt);
    } catch (error) {
      console.warn("Flow Helper paste simulation failed", error);
      return false;
    }
  }

  function dispatchInputEvents(element, inputType, data = null) {
    if (!(element instanceof HTMLElement)) {
      return;
    }

    const beforeInputEvent = new InputEvent("beforeinput", {
      bubbles: true,
      cancelable: true,
      inputType,
      data
    });
    const inputEvent = new InputEvent("input", {
      bubbles: true,
      cancelable: false,
      inputType,
      data
    });

    element.dispatchEvent(beforeInputEvent);
    element.dispatchEvent(inputEvent);
    element.dispatchEvent(new Event("change", {
      bubbles: true
    }));
  }

  function getEditorText(editor) {
    const editorRoot = resolveEditorRoot(editor);

    if (!(editorRoot instanceof HTMLElement)) {
      return "";
    }

    const slateStrings = Array.from(editorRoot.querySelectorAll('[data-slate-string="true"]'))
      .map((node) => node.textContent?.replace(/\uFEFF/g, ""))
      .filter((text) => typeof text === "string" && text.length > 0);

    if (slateStrings.length) {
      return normalizeText(slateStrings.join("\n"));
    }

    const clone = editorRoot.cloneNode(true);

    if (clone instanceof HTMLElement) {
      clone.querySelectorAll('[data-slate-placeholder="true"], [data-slate-zero-width]').forEach((node) => {
        node.remove();
      });

      return normalizeText(clone.textContent.replace(/\uFEFF/g, ""));
    }

    return normalizeText(editorRoot.textContent.replace(/\uFEFF/g, ""));
  }

  function applyTextToEditor(editor, prompt) {
    const editorRoot = resolveEditorRoot(editor);

    if (!(editorRoot instanceof HTMLElement)) {
      return;
    }

    let slateParagraph = getSlateParagraph(editorRoot);

    if (!(slateParagraph instanceof HTMLParagraphElement)) {
      slateParagraph = document.createElement("p");
      slateParagraph.setAttribute("data-slate-node", "element");
      editorRoot.replaceChildren(slateParagraph);
    }

    activateEditorForTyping(editorRoot, slateParagraph);
    let applied = tryInsertTextWithExecCommand(editorRoot, slateParagraph, prompt);

    if (!applied) {
      applied = tryInsertTextWithBeforeInput(editorRoot, slateParagraph, prompt);
    }

    if (!applied) {
      applied = tryInsertTextWithPasteEvent(editorRoot, slateParagraph, prompt);
    }

    if (getEditorText(editorRoot) !== normalizeText(prompt)) {
      replaceSlateParagraphText(slateParagraph, prompt);
      dispatchInputEvents(editorRoot, "insertText", prompt);
    }

    setSelectionToParagraph(slateParagraph);
  }

  function dispatchPointerSequence(element) {
    const rect = element.getBoundingClientRect();
    const eventInit = {
      bubbles: true,
      cancelable: true,
      clientX: rect.left + Math.min(rect.width / 2, 12),
      clientY: rect.top + Math.min(rect.height / 2, 12),
      button: 0
    };

    const pointerEvents = ["pointerover", "pointerenter", "pointerdown", "pointerup"];
    const mouseEvents = ["mouseover", "mouseenter", "mousedown", "mouseup"];

    for (const eventName of pointerEvents) {
      try {
        element.dispatchEvent(new PointerEvent(eventName, {
          ...eventInit,
          pointerId: 1,
          pointerType: "mouse",
          isPrimary: true
        }));
      } catch (_error) {
        break;
      }
    }

    for (const eventName of mouseEvents) {
      element.dispatchEvent(new MouseEvent(eventName, eventInit));
    }
  }

  function clickElement(element) {
    if (!(element instanceof HTMLElement)) {
      throw new Error("Element is missing");
    }

    const rect = element.getBoundingClientRect();
    // In background tabs rect is always 0 — treat as background
    const inBackground = isBackgroundTab() || (rect.width === 0 && rect.height === 0);

    console.log(`Flow Helper: Clicking element in ${inBackground ? 'background' : 'foreground'} mode`);

    // Only scroll and focus if we are in foreground
    if (!inBackground) {
      element.scrollIntoView({
        block: "center",
        inline: "center"
      });
      element.focus?.();
    }

    // Use centre of viewport as fallback coordinates for background clicks
    const clientX = inBackground ? window.innerWidth / 2 : rect.left + rect.width / 2;
    const clientY = inBackground ? window.innerHeight / 2 : rect.top + rect.height / 2;

    const eventInit = {
      bubbles: true,
      cancelable: true,
      clientX,
      clientY,
      button: 0,
      view: window,
      detail: 1
    };

    // Comprehensive event sequence for maximum compatibility
    const events = [
      'mouseenter',
      'mouseover', 
      'mousedown',
      'mouseup',
      'click'
    ];

    // Dispatch all mouse events
    events.forEach(eventType => {
      try {
        element.dispatchEvent(new MouseEvent(eventType, eventInit));
      } catch (error) {
        console.warn(`Flow Helper: Failed to dispatch ${eventType}:`, error);
      }
    });

    // Also try pointer events for modern browsers
    try {
      element.dispatchEvent(new PointerEvent('pointerdown', {
        ...eventInit,
        pointerId: 1,
        pointerType: 'mouse',
        isPrimary: true
      }));
      element.dispatchEvent(new PointerEvent('pointerup', {
        ...eventInit,
        pointerId: 1,
        pointerType: 'mouse',
        isPrimary: true
      }));
    } catch (error) {
      console.warn('Flow Helper: Pointer events not supported');
    }

    // Direct click method
    try {
      element.click();
    } catch (error) {
      console.warn('Flow Helper: Direct click failed:', error);
    }

    // Force focus and keyboard activation as backup
    try {
      element.focus();
      element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      element.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
    } catch (error) {
      console.warn('Flow Helper: Keyboard activation failed:', error);
    }
  }

  async function waitForCondition(predicate, options = {}) {
    const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 15000;
    const intervalMs = Number.isFinite(options.intervalMs) ? options.intervalMs : 400;
    const stableMs = Number.isFinite(options.stableMs) ? options.stableMs : 0;
    const timeoutMessage = options.timeoutMessage || "Condition timed out";
    const check = typeof options.check === "function" ? options.check : () => {};
    const startedAt = Date.now();
    let stableSince = 0;

    while (Date.now() - startedAt < timeoutMs) {
      check();

      if (predicate()) {
        if (!stableMs) {
          return true;
        }

        if (!stableSince) {
          stableSince = Date.now();
        }

        if (Date.now() - stableSince >= stableMs) {
          return true;
        }
      } else {
        stableSince = 0;
      }

      await delay(intervalMs);
    }

    throw new Error(timeoutMessage);
  }

  async function fillPromptAndSubmit(prompt) {
    const editor = resolveEditorRoot(findPromptEditor());

    if (!editor) {
      throw new Error("Prompt editor not found");
    }

    applyTextToEditor(editor, prompt);
    await waitForCondition(() => {
      const sendButton = findSendButton(editor);
      return (
        getEditorText(editor) === normalizeText(prompt) ||
        (Boolean(sendButton) && !isButtonDisabled(sendButton))
      );
    }, {
      timeoutMs: 2500,
      intervalMs: 150,
      timeoutMessage: "Prompt text did not appear in the editor"
    });

    await waitForCondition(() => {
      const sendButton = findSendButton(editor);
      return Boolean(sendButton) && !isButtonDisabled(sendButton);
    }, {
      timeoutMs: 8000,
      intervalMs: 200,
      timeoutMessage: "Send button was not ready"
    });

    let sendButton = findSendButton(editor);

    if (!sendButton) {
      throw new Error("Send button not found");
    }

    clickElement(sendButton);

    await delay(800);

    const looksSubmitted =
      getVisibleProgressElements().length > 0 ||
      getEditorText(editor) === "" ||
      isButtonDisabled(sendButton);

    if (!looksSubmitted) {
      sendButton = findSendButton(editor);

      if (!sendButton) {
        throw new Error("Send button disappeared before retry");
      }

      clickElement(sendButton);
    }
  }

  async function waitForGenerationToFinish(options = {}) {
    const check = typeof options.check === "function" ? options.check : () => {};
    const onProgress = typeof options.onProgress === "function" ? options.onProgress : () => {};
    const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 20 * 60 * 1000;
    const startedAt = Date.now();
    let sawProgress = false;
    let noProgressSince = 0;

    while (Date.now() - startedAt < timeoutMs) {
      check();

      const progressElements = getVisibleProgressElements();
      const downloadButton = findDownloadButton();

      if (progressElements.length) {
        sawProgress = true;
        noProgressSince = 0;
        onProgress(progressElements.map((element) => normalizeText(element.textContent)).join(", "));
        await delay(1000);
        continue;
      }

      if (downloadButton) {
        if (!noProgressSince) {
          noProgressSince = Date.now();
        }

        if (Date.now() - noProgressSince >= 2000) {
          return;
        }
      } else {
        onProgress(sawProgress ? "waiting-finish" : "waiting-start");
        noProgressSince = 0;
      }

      await delay(800);
    }

    throw new Error("Generation did not finish before timeout");
  }

  async function clickDownload() {
    const downloadButton = findDownloadButton();

    if (!downloadButton) {
      throw new Error("Download button not found");
    }

    console.log("Flow Helper: Found download button:", downloadButton);

    // --- Strategy 1: Extract URL from various sources ---
    const findDownloadUrl = (el) => {
      const sources = [];
      
      // Check the button itself and nearby elements
      const checkElement = (element, depth = 0) => {
        if (!element || depth > 5) return;
        
        // Direct href
        if (element.href) sources.push(element.href);
        
        // Data attributes
        ['data-url', 'data-href', 'data-download-url', 'data-src'].forEach(attr => {
          const val = element.getAttribute(attr);
          if (val) sources.push(val);
        });
        
        // Check parent and children
        if (depth < 3) {
          if (element.parentElement) checkElement(element.parentElement, depth + 1);
          Array.from(element.children).forEach(child => checkElement(child, depth + 1));
        }
      };
      
      checkElement(el);
      
      // Look for nearby links or images that might be the actual download
      const nearbyElements = el.parentElement?.querySelectorAll('a[href], img[src], [data-url]') || [];
      nearbyElements.forEach(elem => checkElement(elem));
      
      // Filter for valid URLs
      return sources.find(url => 
        url && (
          url.startsWith('http') || 
          url.startsWith('blob:') || 
          url.startsWith('data:') ||
          url.includes('.jpg') ||
          url.includes('.png') ||
          url.includes('.webp') ||
          url.includes('.gif')
        )
      );
    };

    const downloadUrl = findDownloadUrl(downloadButton);
    
    if (downloadUrl) {
      console.log("Flow Helper: Using background download API for:", downloadUrl);
      
      const response = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: "FLOW_HELPER_DOWNLOAD", url: downloadUrl }, (res) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
          } else {
            resolve(res);
          }
        });
      });

      if (response && response.ok) {
        console.log(`Flow Helper: Download ${response.method} successful`);
        await delay(1500);
        return;
      }
      console.warn("Flow Helper: Background download failed, trying click fallback", response?.error);
    }

    // --- Strategy 2: Comprehensive clicking approaches ---
    console.log("Flow Helper: Using comprehensive click approaches");
    
    // Approach 2a: Try to trigger any associated form submission
    const form = downloadButton.closest('form');
    if (form) {
      console.log("Flow Helper: Trying form submission");
      try {
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        await delay(500);
      } catch (error) {
        console.warn("Flow Helper: Form submission failed:", error);
      }
    }
    
    // Approach 2b: Look for and click any nested anchor tags
    const nestedAnchor = downloadButton.querySelector('a') || downloadButton.closest('a');
    if (nestedAnchor) {
      console.log("Flow Helper: Clicking nested anchor");
      clickElement(nestedAnchor);
      await delay(500);
    }
    
    // Approach 2c: Main button click with comprehensive events
    console.log("Flow Helper: Clicking main download button");
    clickElement(downloadButton);
    
    // Approach 2d: Try to find and trigger any onclick handlers
    try {
      if (downloadButton.onclick) {
        console.log("Flow Helper: Triggering onclick handler");
        downloadButton.onclick.call(downloadButton, new MouseEvent('click'));
      }
    } catch (error) {
      console.warn("Flow Helper: onclick handler failed:", error);
    }
    
    // Approach 2e: Check for React/Vue event handlers and trigger them
    try {
      const reactKey = Object.keys(downloadButton).find(key => key.startsWith('__reactInternalInstance'));
      if (reactKey) {
        console.log("Flow Helper: Found React component, triggering events");
        downloadButton.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      }
    } catch (error) {
      console.warn("Flow Helper: React event handling failed:", error);
    }

    await delay(3000);
  }

  async function openDeleteDialog(options = {}) {
    const check = typeof options.check === "function" ? options.check : () => {};

    if (findDeleteConfirmButton()) {
      return;
    }

    const deleteButton = findDeleteTriggerButton();

    if (!deleteButton) {
      throw new Error("Delete button not found");
    }

    clickElement(deleteButton);

    await waitForCondition(() => Boolean(findDeleteConfirmButton()), {
      timeoutMs: 8000,
      intervalMs: 300,
      timeoutMessage: "Delete confirmation did not appear",
      check
    });
  }

  async function confirmDelete(options = {}) {
    const check = typeof options.check === "function" ? options.check : () => {};
    const confirmButton = findDeleteConfirmButton();

    if (!confirmButton) {
      throw new Error("Delete confirmation button not found");
    }

    clickElement(confirmButton);

    await waitForCondition(() => !findDeleteConfirmButton(), {
      timeoutMs: 10000,
      intervalMs: 350,
      stableMs: 500,
      timeoutMessage: "Delete confirmation did not close",
      check
    });
  }

  window.FlowHelperPageActions = {
    getProjectInfo,
    normalizeText,
    delay,
    fillPromptAndSubmit,
    waitForGenerationToFinish,
    clickDownload,
    openDeleteDialog,
    confirmDelete
  };
})();
