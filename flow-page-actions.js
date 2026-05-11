(function initFlowHelperPageActions() {
  if (window.FlowHelperPageActions) {
    return;
  }

  const FLOW_HELPER_ROOT_ID = "autogen-flow-helper-root";
  const DOWNLOAD_ACTIVATION_WINDOW_MS = 3000;
  let lastDownloadActivationKey = "";
  let lastDownloadActivationAt = 0;

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
    // The visibility spoofer overrides document.visibilityState to "visible"
    // even when the tab is actually in the background, so we cannot rely on
    // that API. Instead, probe a known-visible element: if its rect is all
    // zeros the tab is truly hidden by the browser compositor.
    try {
      const probe = document.documentElement;
      if (probe) {
        const rect = probe.getBoundingClientRect();
        // In a real foreground tab, documentElement always has a non-zero rect
        if (rect.width > 0 && rect.height > 0) {
          return false;
        }
      }
    } catch (_error) {
      // Fall through to true — safer to assume background.
    }
    return true;
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
    const enabledMatches = matches.filter((button) => !isButtonDisabled(button));
    const candidates = options.includeDisabled
      ? (enabledMatches.length ? enabledMatches : matches)
      : enabledMatches;

    return getNearestElement(candidates.length ? candidates : matches, referenceElement);
  }

  function findSendButton(referenceElement = null) {
    return findButtonByMatcher((button, _buttonText, iconText) => {
      // Exclude popup / dialog triggers. Flow has another button with the
      // same hidden label "สร้าง" but icon "add_2" and aria-haspopup="dialog"
      // — that opens the asset picker, NOT submit. Never click it here.
      if (button.getAttribute("aria-haspopup")) {
        return false;
      }

      // The submit button is uniquely identified by the icon "arrow_forward".
      // The hidden a11y label "สร้าง" alone is shared with the asset-picker
      // dialog button, so don't match on label alone.
      return iconText.includes("arrow_forward");
    }, referenceElement, {
      includeDisabled: true
    });
  }

  function findDownloadButton() {
    // ค้นหาปุ่มดาวน์โหลดที่เฉพาะเจาะจงสำหรับ Google Labs Flow
    const downloadButtons = getButtonsByMatcher((button, buttonText, iconText) => {
      // ห้ามจับปุ่มที่เปิด dialog เช่น ปุ่ม "สร้าง" (add_2) ที่เป็น asset picker
      if (button.getAttribute("aria-haspopup")) {
        return false;
      }

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

  function findArchiveButton(referenceElement = null) {
    return findButtonByMatcher((button, buttonText, iconText) => {
      // ห้ามจับปุ่มที่เปิด dialog เช่น ปุ่ม "สร้าง" (add_2) ที่เป็น asset picker
      if (button.getAttribute("aria-haspopup")) {
        return false;
      }

      return (
        iconText.includes("archive") ||
        buttonText.includes("ที่เก็บถาวร") ||
        buttonText.toLowerCase().includes("archive")
      );
    }, referenceElement);
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

  function getEditorPlaceholderText(editor) {
    if (!(editor instanceof HTMLElement)) {
      return "";
    }

    const placeholder = editor.querySelector('[data-slate-placeholder="true"]');
    return placeholder ? normalizeText(placeholder.textContent) : "";
  }

  // Google Labs Flow has multiple Slate editors on the same page (prompt
  // input, scene description, etc.). The prompt input is identified by a
  // placeholder like "คุณต้องการสร้างอะไร" / "What do you want to create".
  function isPromptEditorPlaceholder(text) {
    if (!text) {
      return false;
    }

    const lowered = text.toLowerCase();
    return (
      text.includes("คุณต้องการ") ||
      text.includes("ต้องการสร้าง") ||
      lowered.includes("what do you want") ||
      lowered.includes("describe what") ||
      lowered.includes("create something")
    );
  }

  function pickPromptEditor(editors, sendButton) {
    if (!editors.length) {
      return null;
    }

    const byPlaceholder = editors.find((editor) =>
      isPromptEditorPlaceholder(getEditorPlaceholderText(editor))
    );

    if (byPlaceholder) {
      return byPlaceholder;
    }

    return getNearestElement(editors, sendButton);
  }

  function findPromptEditor() {
    const sendButton = findSendButton();

    const slateEditors = Array.from(
      document.querySelectorAll('div[role="textbox"][data-slate-editor="true"][data-slate-node="value"][contenteditable="true"]')
    ).filter((element) => {
      return element instanceof HTMLElement && isVisible(element) && !element.closest(`#${FLOW_HELPER_ROOT_ID}`);
    });

    const editorByPlaceholder = pickPromptEditor(slateEditors, sendButton);
    if (editorByPlaceholder) {
      return editorByPlaceholder;
    }

    const slateParagraphs = Array.from(document.querySelectorAll('p[data-slate-node="element"]')).filter((element) => {
      return element instanceof HTMLParagraphElement && isVisible(element) && !element.closest(`#${FLOW_HELPER_ROOT_ID}`);
    });

    if (slateParagraphs.length) {
      const paragraphByPlaceholder = slateParagraphs.find((paragraph) =>
        isPromptEditorPlaceholder(getEditorPlaceholderText(paragraph))
      );

      if (paragraphByPlaceholder) {
        return paragraphByPlaceholder.closest('[contenteditable="true"]') || paragraphByPlaceholder;
      }

      return getNearestElement(
        slateParagraphs.map((element) => element.closest('[contenteditable="true"]') || element),
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
    if (!(element instanceof Node) || !element.isConnected) {
      return;
    }

    const selection = window.getSelection();

    if (!selection) {
      return;
    }

    // selectAllChildren is the modern equivalent of
    // createRange + selectNodeContents + removeAllRanges + addRange,
    // and it does NOT emit Blink's "addRange isn't in document" console
    // warning when nodes detach mid-frame.
    try {
      selection.selectAllChildren(element);
    } catch (_error) {
      // Slate will reconcile its own selection on next focus.
    }
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

    // Empty paragraph (Slate placeholder state). Do NOT anchor inside the
    // [data-slate-zero-width] span — execCommand("insertText") would write
    // text literally into that placeholder node, bypassing Slate's
    // onBeforeInput pipeline. The caller falls back to a block-level caret
    // so Slate can normalize and dispatch a real insertText op.
    return null;
  }

  function setSelectionToParagraph(paragraph) {
    if (!(paragraph instanceof HTMLParagraphElement) || !paragraph.isConnected) {
      return;
    }

    const selection = window.getSelection();

    if (!selection) {
      return;
    }

    // Use Selection.collapse() / setBaseAndExtent() instead of
    // createRange + removeAllRanges + addRange. The legacy combo logs
    // "addRange(): The given range isn't in document" from Blink's C++
    // side when nodes detach mid-frame (Slate re-renders). That warning
    // bypasses JS try/catch and surfaces in chrome://extensions Errors.
    try {
      const selectionTarget = getSlateSelectionTarget(paragraph);
      const targetNode = selectionTarget?.node;

      if (
        targetNode instanceof Text &&
        targetNode.isConnected &&
        paragraph.contains(targetNode)
      ) {
        selection.setBaseAndExtent(
          targetNode,
          selectionTarget.offset,
          targetNode,
          selectionTarget.offset
        );
      } else if (paragraph.isConnected) {
        selection.collapse(paragraph, 0);
      }
    } catch (_error) {
      // Selection still failed; Slate will reconcile its own selection
      // on its next focus event.
    }
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

    // Click the paragraph itself, not the wrapper. Slate's React onClick
    // handler on the paragraph picks up the focus + selection change in
    // one go and aligns its internal selection with the DOM.
    const clickTarget =
      slateParagraph instanceof HTMLParagraphElement ? slateParagraph : editorRoot;

    dispatchPointerSequence(clickTarget);
    clickTarget.click?.();
    editorRoot.focus();

    if (slateParagraph instanceof HTMLParagraphElement) {
      setSelectionToParagraph(slateParagraph);
    } else {
      selectNodeContents(editorRoot);
    }

    announceSelectionChange();
  }

  function selectAllInEditor(editorRoot) {
    try {
      if (document.execCommand("selectAll", false)) {
        return true;
      }
    } catch (_error) {
      // Fall through to manual range selection below.
    }

    if (editorRoot instanceof HTMLElement) {
      selectNodeContents(editorRoot);
      announceSelectionChange();
      return true;
    }

    return false;
  }

  function isPromptCommittedToSlateModel(editorRoot, prompt) {
    if (!(editorRoot instanceof HTMLElement)) {
      return false;
    }

    // Slate only renders [data-slate-string="true"] when the model has
    // text. If the placeholder span is still attached, the model is empty
    // even if some "text" leaked into the zero-width span.
    const stringNode = editorRoot.querySelector('[data-slate-string="true"]');
    if (!(stringNode instanceof HTMLElement)) {
      return false;
    }

    const expected = normalizeText(prompt);
    if (!expected) {
      return false;
    }

    return normalizeText(stringNode.textContent || "") === expected;
  }

  function tryInsertTextWithExecCommand(editorRoot, slateParagraph, prompt) {
    try {
      activateEditorForTyping(editorRoot, slateParagraph);
      selectAllInEditor(editorRoot);

      // Run delete + insertText as two separate trusted beforeinput events
      // so Slate observes the model going to length 0 before the insert.
      try {
        document.execCommand("delete", false);
      } catch (_error) {}

      const inserted = document.execCommand("insertText", false, prompt);
      announceSelectionChange();

      return (
        isPromptCommittedToSlateModel(editorRoot, prompt) ||
        (Boolean(inserted) && getEditorText(editorRoot) === normalizeText(prompt))
      );
    } catch (error) {
      console.warn("Flow Helper execCommand failed", error);
      return false;
    }
  }

  // IME-style fallback: Slate's onCompositionEnd handler reads `data` and
  // calls editor.insertText(data) via its internal transforms, regardless
  // of beforeinput trusted-ness. With selectAll first, insertText replaces
  // the entire selection — no need to execCommand("delete"), which mutates
  // the DOM raw and crashes Slate's reconciler.
  function tryInsertTextWithComposition(editorRoot, slateParagraph, prompt) {
    try {
      activateEditorForTyping(editorRoot, slateParagraph);
      selectAllInEditor(editorRoot);

      editorRoot.dispatchEvent(new CompositionEvent("compositionstart", {
        bubbles: true,
        cancelable: true,
        data: ""
      }));
      editorRoot.dispatchEvent(new CompositionEvent("compositionupdate", {
        bubbles: true,
        cancelable: true,
        data: prompt
      }));
      editorRoot.dispatchEvent(new CompositionEvent("compositionend", {
        bubbles: true,
        cancelable: true,
        data: prompt
      }));
      editorRoot.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        cancelable: false,
        inputType: "insertCompositionText",
        data: prompt
      }));
      announceSelectionChange();

      return isPromptCommittedToSlateModel(editorRoot, prompt);
    } catch (error) {
      console.warn("Flow Helper composition simulation failed", error);
      return false;
    }
  }

  function tryInsertTextWithBeforeInput(editorRoot, slateParagraph, prompt) {
    try {
      activateEditorForTyping(editorRoot, slateParagraph);
      selectAllInEditor(editorRoot);

      const beforeInputEvent = new InputEvent("beforeinput", {
        bubbles: true,
        cancelable: true,
        inputType: "insertReplacementText",
        data: prompt
      });
      const inputEvent = new InputEvent("input", {
        bubbles: true,
        cancelable: false,
        inputType: "insertReplacementText",
        data: prompt
      });

      editorRoot.dispatchEvent(beforeInputEvent);
      editorRoot.dispatchEvent(inputEvent);
      announceSelectionChange();

      return getEditorText(editorRoot) === normalizeText(prompt);
    } catch (error) {
      console.warn("Flow Helper synthetic beforeinput failed", error);
      return false;
    }
  }

  function tryInsertTextWithPasteEvent(editorRoot, slateParagraph, prompt) {
    try {
      activateEditorForTyping(editorRoot, slateParagraph);
      selectAllInEditor(editorRoot);

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

  async function waitForSlateCommit(editorRoot, prompt, timeoutMs = 600, intervalMs = 60) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      if (isPromptCommittedToSlateModel(editorRoot, prompt)) {
        return true;
      }
      await delay(intervalMs);
    }
    return isPromptCommittedToSlateModel(editorRoot, prompt);
  }

  async function applyTextToEditor(editor, prompt) {
    const editorRoot = resolveEditorRoot(editor);

    if (!(editorRoot instanceof HTMLElement)) {
      return;
    }

    // Slate owns the DOM inside editorRoot. Strategies that mutate the DOM
    // directly (document.execCommand) crash Slate's reconciler with
    // "NotFoundError: removeChild" because React tracks one DOM tree while
    // execCommand silently mutates another. Stick to event-based strategies
    // that go through Slate's own onCompositionEnd / onBeforeInput / onPaste
    // handlers — those run Slate transforms cleanly.
    const initialParagraph = getSlateParagraph(editorRoot);
    activateEditorForTyping(editorRoot, initialParagraph);
    await delay(40);

    const strategies = [
      tryInsertTextWithComposition,
      tryInsertTextWithBeforeInput,
      tryInsertTextWithPasteEvent
    ];

    for (const strategy of strategies) {
      // Re-fetch the paragraph each iteration. Slate replaces the <p> node
      // when it commits, so a cached reference becomes detached and any
      // subsequent setSelection on it throws "addRange isn't in document".
      const freshParagraph = getSlateParagraph(editorRoot);

      try {
        strategy(editorRoot, freshParagraph, prompt);
      } catch (error) {
        console.warn(`Flow Helper strategy ${strategy.name} threw`, error);
      }

      if (await waitForSlateCommit(editorRoot, prompt)) {
        break;
      }
    }

    const finalParagraph = getSlateParagraph(editorRoot);
    if (finalParagraph instanceof HTMLParagraphElement) {
      try {
        setSelectionToParagraph(finalParagraph);
      } catch (_error) {
        // Selection failed; Slate will recover on next focus.
      }
    }
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
    const inBackground = isBackgroundTab() || (rect.width === 0 && rect.height === 0);

    console.log(`Flow Helper: Clicking element in ${inBackground ? 'background' : 'foreground'} mode`, element.tagName, element.className.slice(0, 60));

    // Always try to scroll and focus — even in background, .focus() can
    // help React recognise the element as interactive.
    try {
      element.scrollIntoView({ block: "center", inline: "center" });
    } catch (_error) {}
    try {
      element.focus();
    } catch (_error) {}

    // --- Strategy 1: trusted .click() (highest compatibility with React) ---
    try {
      element.click();
      console.log("Flow Helper: Trusted .click() dispatched");
    } catch (error) {
      console.warn('Flow Helper: Direct click failed:', error);
    }

    // --- Strategy 2: synthetic pointer + mouse event sequence ---
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

    try {
      element.dispatchEvent(new PointerEvent('pointerdown', {
        ...eventInit, pointerId: 1, pointerType: 'mouse', isPrimary: true
      }));
      element.dispatchEvent(new MouseEvent('mousedown', eventInit));
      element.dispatchEvent(new PointerEvent('pointerup', {
        ...eventInit, pointerId: 1, pointerType: 'mouse', isPrimary: true
      }));
      element.dispatchEvent(new MouseEvent('mouseup', eventInit));
      element.dispatchEvent(new MouseEvent('click', eventInit));
    } catch (error) {
      console.warn('Flow Helper: Synthetic event sequence failed:', error);
    }

    // --- Strategy 3: keyboard Enter as final fallback ---
    try {
      element.focus();
      element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true, cancelable: true }));
      element.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true, cancelable: true }));
      element.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
    } catch (error) {
      console.warn('Flow Helper: Keyboard activation failed:', error);
    }
  }

  function getDownloadActivationTarget(downloadButton) {
    const anchor = downloadButton.querySelector("a[href]") || downloadButton.closest("a[href]");
    return anchor instanceof HTMLElement ? anchor : downloadButton;
  }

  function getDownloadActivationKey(target, downloadUrl) {
    const directUrl =
      downloadUrl ||
      target.href ||
      target.getAttribute("href") ||
      target.getAttribute("data-url") ||
      target.getAttribute("data-href") ||
      target.getAttribute("data-download-url") ||
      target.getAttribute("data-src");

    if (directUrl) {
      return `url:${String(directUrl).trim()}`;
    }

    return [
      "element",
      window.location.pathname,
      target.tagName,
      target.id || "",
      typeof target.className === "string" ? target.className : "",
      normalizeText(target.textContent).slice(0, 120)
    ].join(":");
  }

  function markDownloadActivation(key) {
    const now = Date.now();

    if (key && key === lastDownloadActivationKey && now - lastDownloadActivationAt < DOWNLOAD_ACTIVATION_WINDOW_MS) {
      console.warn("Flow Helper: Skipping duplicate download activation", key);
      return false;
    }

    lastDownloadActivationKey = key;
    lastDownloadActivationAt = now;
    return true;
  }

  function activateDownloadTargetOnce(target) {
    if (!(target instanceof HTMLElement)) {
      throw new Error("Download target is missing");
    }

    const rect = target.getBoundingClientRect();
    const inBackground = isBackgroundTab() || (rect.width === 0 && rect.height === 0);

    if (!inBackground) {
      target.scrollIntoView({
        block: "center",
        inline: "center"
      });
      target.focus?.();
    }

    try {
      target.click();
    } catch (error) {
      console.warn("Flow Helper: Native download click failed, dispatching one click event", error);
      target.dispatchEvent(new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        view: window,
        button: 0
      }));
    }
  }

  function sendRuntimeMessage(message) {
    return new Promise((resolve) => {
      let chromeRuntimeId;
      try {
        chromeRuntimeId = chrome?.runtime?.id;
      } catch (_error) {
        chromeRuntimeId = undefined;
      }

      if (!chromeRuntimeId) {
        resolve({ ok: false, error: "Extension context invalidated" });
        return;
      }

      try {
        chrome.runtime.sendMessage(message, (response) => {
          const lastError = chrome.runtime?.lastError;
          if (lastError) {
            resolve({ ok: false, error: lastError.message });
            return;
          }

          resolve(response || {});
        });
      } catch (error) {
        resolve({ ok: false, error: error?.message || String(error) });
      }
    });
  }

  function isFlowContentImageUrl(url) {
    try {
      const parsedUrl = new URL(url);
      return parsedUrl.hostname === "flow-content.google" && parsedUrl.pathname.startsWith("/image/");
    } catch (_error) {
      return false;
    }
  }

  function getLatestPerformanceImage(after = 0) {
    const afterTimestamp = Number.isFinite(after) ? after : 0;
    const timeOrigin = Number.isFinite(performance.timeOrigin) ? performance.timeOrigin : Date.now();

    return performance.getEntriesByType("resource")
      .filter((entry) => {
        if (!entry?.name || !isFlowContentImageUrl(entry.name)) {
          return false;
        }

        const completedAt = Math.round(timeOrigin + (entry.responseEnd || entry.startTime || 0));
        return completedAt >= afterTimestamp;
      })
      .map((entry) => ({
        url: entry.name,
        timestamp: Math.round(timeOrigin + (entry.responseEnd || entry.startTime || 0)),
        source: "performance",
        initiatorType: entry.initiatorType || ""
      }))
      .sort((left, right) => right.timestamp - left.timestamp)[0] || null;
  }

  function getFlowImageFilename(url, contentType = "") {
    let id = `flow-image-${Date.now()}`;

    try {
      id = new URL(url).pathname.split("/").filter(Boolean).pop() || id;
    } catch (_error) {
      // Keep timestamp fallback.
    }

    const normalizedType = String(contentType || "").toLowerCase();
    const extension =
      normalizedType.includes("png") ? "png" :
        normalizedType.includes("webp") ? "webp" :
          normalizedType.includes("gif") ? "gif" :
            "jpg";

    return `${id}.${extension}`;
  }

  async function downloadImageViaFetchBlob(url) {
    const downloadUrl = String(url || "").trim();

    if (!downloadUrl) {
      throw new Error("No network image URL provided");
    }

    if (!markDownloadActivation(`network-fetch:${downloadUrl}`)) {
      return {
        ok: true,
        method: "network-fetch-deduped",
        url: downloadUrl
      };
    }

    console.log("Flow Helper: Downloading network image with fetch/blob", downloadUrl);

    const response = await fetch(downloadUrl, {
      method: "GET",
      mode: "cors",
      credentials: "omit",
      cache: "no-store"
    });

    if (!response.ok) {
      throw new Error(`Network image fetch failed: ${response.status} ${response.statusText}`);
    }

    const contentType = response.headers.get("content-type") || "image/jpeg";
    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);
    const filename = getFlowImageFilename(downloadUrl, contentType);

    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = filename;
    anchor.style.display = "none";
    document.body.appendChild(anchor);
    anchor.click();

    setTimeout(() => {
      URL.revokeObjectURL(objectUrl);
      anchor.remove();
    }, 30000);

    return {
      ok: true,
      method: "network-fetch-blob",
      url: downloadUrl,
      filename,
      size: blob.size,
      contentType
    };
  }

  async function resetNetworkCapture() {
    const response = await sendRuntimeMessage({ type: "FLOW_HELPER_NETWORK_CAPTURE_RESET" });

    if (response?.ok && Number.isFinite(response.timestamp)) {
      return response.timestamp;
    }

    console.warn("Flow Helper: Background network capture reset failed", response?.error);
    return Date.now();
  }

  async function getLatestNetworkImageEntry(after = 0) {
    const response = await sendRuntimeMessage({
      type: "FLOW_HELPER_GET_LATEST_NETWORK_IMAGE",
      after
    });

    if (response?.ok && response.entry?.url) {
      return {
        ...response.entry,
        source: "webRequest"
      };
    }

    return getLatestPerformanceImage(after);
  }

  async function waitForNetworkImage(options = {}) {
    const check = typeof options.check === "function" ? options.check : () => {};
    const onProgress = typeof options.onProgress === "function" ? options.onProgress : () => {};
    const after = Number.isFinite(options.after) ? options.after : 0;
    const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 20 * 60 * 1000;
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      check();

      const entry = await getLatestNetworkImageEntry(after);

      if (entry?.url) {
        return entry;
      }

      onProgress("waiting-network-image");
      await delay(1000);
    }

    throw new Error("Network image request did not appear before timeout");
  }

  async function downloadNetworkImageWithBackground(url) {
    const response = await sendRuntimeMessage({
      type: "FLOW_HELPER_DOWNLOAD",
      url
    });

    if (!response?.ok) {
      throw new Error(response?.error || "Background network download failed");
    }

    return response;
  }

  async function downloadLatestNetworkImage(options = {}) {
    const after = Number.isFinite(options.after) ? options.after : 0;
    const response = await sendRuntimeMessage({
      type: "FLOW_HELPER_DOWNLOAD_LATEST_NETWORK_IMAGE",
      after
    });

    if (response?.ok) {
      console.log("Flow Helper: Network download queued from background", response.entry || response.url);
      await delay(1000);
      return response;
    }

    const performanceEntry = getLatestPerformanceImage(after);

    if (performanceEntry) {
      try {
        const backgroundResult = await downloadNetworkImageWithBackground(performanceEntry.url);
        console.log("Flow Helper: Network download queued from performance entries", performanceEntry);
        await delay(1000);
        return {
          ...backgroundResult,
          method: backgroundResult.method === "deduped" ? "deduped" : "network-performance-api",
          entry: performanceEntry
        };
      } catch (error) {
        console.warn("Flow Helper: Background network download failed, falling back to fetch/blob", error);
        const fetchResult = await downloadImageViaFetchBlob(performanceEntry.url);
        await delay(1000);
        return {
          ...fetchResult,
          method: fetchResult.method === "network-fetch-deduped" ? "network-fetch-deduped" : "network-performance-fetch-fallback",
          entry: performanceEntry
        };
      }
    }

    throw new Error(response?.error || "No network image request found");
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

  async function waitForSubmissionStart(editor, options = {}) {
    const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 6000;
    const intervalMs = Number.isFinite(options.intervalMs) ? options.intervalMs : 250;
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      const sendButton = findSendButton(editor);

      if (isSubmissionVisible(editor, sendButton, { acceptDisabledButton: true })) {
        return true;
      }

      await delay(intervalMs);
    }

    throw new Error("Submit click did not start generation");
  }

  async function forceSubmitClick(editor, options = {}) {
    const response = await sendRuntimeMessage({
      type: "FLOW_HELPER_FORCE_SUBMIT_CLICK",
      selector: "button:has(i.google-symbols)",
      iconFilter: "arrow_forward",
      useDebugger: options.useDebugger !== false
    });

    console.log("Flow Helper: force submit click result:", response);

    if (!response?.ok) {
      throw new Error(response?.error || response?.mainResult?.error || response?.trustedResult?.error || "Force submit click failed");
    }

    await waitForSubmissionStart(editor, {
      timeoutMs: Number.isFinite(options.timeoutMs) ? options.timeoutMs : 7000
    });

    return response;
  }

  async function fillPromptAndSubmit(prompt) {
    console.log("Flow Helper: fillPromptAndSubmit — typing prompt in MAIN world first");
    let mainResult = null;

    try {
      mainResult = await sendRuntimeMessage({
        type: "FLOW_HELPER_MAIN_WORLD_TYPE_AND_SUBMIT",
        prompt: prompt
      });
      console.log("Flow Helper: MAIN world type result:", mainResult);

      if (mainResult?.ok) {
        const editor = resolveEditorRoot(findPromptEditor());

        if (!editor) {
          throw new Error("Prompt editor not found after MAIN world typing");
        }

        try {
          await forceSubmitClick(editor, { timeoutMs: 8000 });
          console.log("Flow Helper: Forced submit click confirmed after MAIN world typing");
          return;
        } catch (error) {
          console.warn("Flow Helper: Forced submit click did not confirm, trying local fallbacks", error);

          const sendButton = findSendButton(editor);
          if (sendButton) {
            await activateSendButton(sendButton, editor);
            await waitForSubmissionStart(editor, { timeoutMs: 5000 });
            return;
          }

          throw error;
        }
      }
    } catch (error) {
      console.warn("Flow Helper: MAIN world typing failed:", error);
    }

    console.log("Flow Helper: fillPromptAndSubmit — falling back to content script typing");
    const editor = resolveEditorRoot(findPromptEditor());

    if (!editor) {
      throw new Error("Prompt editor not found");
    }

    if (!mainResult?.ok) {
      await applyTextToEditor(editor, prompt);
      await waitForCondition(() => {
        return isPromptCommittedToSlateModel(editor, prompt);
      }, {
        timeoutMs: 3000,
        intervalMs: 150,
        timeoutMessage: "Prompt text did not appear in the editor"
      });
    }

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

    try {
      await forceSubmitClick(editor, { timeoutMs: 8000 });
      return;
    } catch (error) {
      console.warn("Flow Helper: Force submit click failed, trying local activateSendButton", error);
    }

    await activateSendButton(sendButton, editor);
    await waitForSubmissionStart(editor, { timeoutMs: 5000 });
  }

  function isSubmissionVisible(editor, sendButton, options = {}) {
    return (
      getVisibleProgressElements().length > 0 ||
      getEditorText(editor) === "" ||
      (
        options.acceptDisabledButton === true &&
        sendButton instanceof HTMLButtonElement &&
        isButtonDisabled(sendButton)
      )
    );
  }

  // Simulate a real user click with proper timing between pointer events.
  // React 18+ batches events per-task; firing everything synchronously in
  // one microtask means React only sees the final "click" without the
  // preceding pointerdown/mousedown state transitions that its internal
  // event system expects. Adding await delay() between each step lets the
  // browser run a full task boundary so React processes each event.
  async function asyncClickElement(element) {
    if (!(element instanceof HTMLElement)) {
      throw new Error("Element is missing");
    }

    const rect = element.getBoundingClientRect();
    const inBackground = isBackgroundTab() || (rect.width === 0 && rect.height === 0);
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

    const pointerInit = {
      ...eventInit,
      pointerId: 1,
      pointerType: "mouse",
      isPrimary: true
    };

    try { element.scrollIntoView({ block: "center", inline: "center" }); } catch (_e) {}
    try { element.focus(); } catch (_e) {}

    // Full browser-native sequence with task boundaries
    element.dispatchEvent(new PointerEvent("pointerover", pointerInit));
    element.dispatchEvent(new PointerEvent("pointerenter", { ...pointerInit, bubbles: false }));
    element.dispatchEvent(new MouseEvent("mouseover", eventInit));
    element.dispatchEvent(new MouseEvent("mouseenter", { ...eventInit, bubbles: false }));
    await delay(30);

    element.dispatchEvent(new PointerEvent("pointerdown", pointerInit));
    await delay(30);
    element.dispatchEvent(new MouseEvent("mousedown", eventInit));
    await delay(80);

    element.dispatchEvent(new PointerEvent("pointerup", pointerInit));
    await delay(30);
    element.dispatchEvent(new MouseEvent("mouseup", eventInit));
    await delay(30);

    element.dispatchEvent(new MouseEvent("click", eventInit));
    await delay(50);

    console.log("Flow Helper: asyncClickElement completed", element.tagName);
  }

  async function activateSendButton(initialButton, editor) {
    // Ensure the editor has focus first
    try { editor.focus(); } catch (_error) {}
    await delay(50);

    let sendButton = findSendButton(editor) || initialButton;

    // ── Attempt 1: MAIN WORLD click via chrome.scripting.executeScript ──
    // Content scripts run in an isolated JS world. Events dispatched from
    // the isolated world share the same DOM but React's event delegation
    // (attached in the MAIN world) may not process them correctly.
    // Executing the click in the MAIN world ensures React handles it.
    console.log("Flow Helper: activateSendButton attempt 1 — MAIN world click");
    try {
      const mainWorldResult = await sendRuntimeMessage({
        type: "FLOW_HELPER_MAIN_WORLD_CLICK",
        selector: "button:has(i.google-symbols)",
        iconFilter: "arrow_forward"
      });
      console.log("Flow Helper: MAIN world result:", mainWorldResult);
    } catch (error) {
      console.warn("Flow Helper: MAIN world click failed:", error);
    }
    await delay(1500);

    if (isSubmissionVisible(editor, sendButton)) {
      console.log("Flow Helper: Submission detected after attempt 1 (MAIN world)");
      return;
    }

    // ── Attempt 2: async timed pointer sequence from content script ──
    sendButton = findSendButton(editor) || sendButton;
    console.log("Flow Helper: activateSendButton attempt 2 — async pointer sequence");
    await asyncClickElement(sendButton);
    await delay(800);

    if (isSubmissionVisible(editor, sendButton)) {
      console.log("Flow Helper: Submission detected after attempt 2");
      return;
    }

    // ── Attempt 3: click the <i> icon inside the button ──
    sendButton = findSendButton(editor) || sendButton;
    const iconElement = sendButton.querySelector("i") || sendButton.firstElementChild;
    if (iconElement instanceof HTMLElement) {
      console.log("Flow Helper: activateSendButton attempt 3 — click inner icon");
      await asyncClickElement(iconElement);
      await delay(800);

      if (isSubmissionVisible(editor, sendButton)) {
        console.log("Flow Helper: Submission detected after attempt 3 (icon)");
        return;
      }
    }

    // ── Attempt 4: Ctrl+Enter on editor ──
    console.log("Flow Helper: activateSendButton attempt 4 — Ctrl+Enter");
    try {
      editor.focus();
      await delay(50);
      const keyOpts = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true, ctrlKey: true };
      editor.dispatchEvent(new KeyboardEvent("keydown", keyOpts));
      editor.dispatchEvent(new KeyboardEvent("keypress", keyOpts));
      editor.dispatchEvent(new KeyboardEvent("keyup", { ...keyOpts, cancelable: false }));
    } catch (error) {
      console.warn("Flow Helper: Ctrl+Enter failed", error);
    }
    await delay(800);

    if (isSubmissionVisible(editor, sendButton)) {
      console.log("Flow Helper: Submission detected after attempt 4");
      return;
    }

    // ── Attempt 5: Enter on editor ──
    console.log("Flow Helper: activateSendButton attempt 5 — Enter");
    try {
      editor.focus();
      await delay(50);
      const keyOpts = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true };
      editor.dispatchEvent(new KeyboardEvent("keydown", keyOpts));
      editor.dispatchEvent(new KeyboardEvent("keypress", keyOpts));
      editor.dispatchEvent(new KeyboardEvent("keyup", { ...keyOpts, cancelable: false }));
    } catch (error) {
      console.warn("Flow Helper: Enter failed", error);
    }
    await delay(800);

    if (isSubmissionVisible(editor, sendButton)) {
      console.log("Flow Helper: Submission detected after attempt 5");
      return;
    }

    // ── Attempt 6: MAIN world React fiber onClick ──
    console.log("Flow Helper: activateSendButton attempt 6 — MAIN world React fiber");
    try {
      const fiberResult = await sendRuntimeMessage({
        type: "FLOW_HELPER_MAIN_WORLD_CLICK",
        selector: "button",
        iconFilter: "arrow_forward"
      });
      console.log("Flow Helper: MAIN world fiber result:", fiberResult);
    } catch (error) {
      console.warn("Flow Helper: attempt 6 failed", error);
    }
    await delay(800);

    if (isSubmissionVisible(editor, sendButton)) {
      console.log("Flow Helper: Submission detected after attempt 6");
      return;
    }

    console.warn("Flow Helper: All submit strategies exhausted — submission not detected");
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
    const activationTarget = getDownloadActivationTarget(downloadButton);
    const activationKey = getDownloadActivationKey(activationTarget, downloadUrl);

    if (!markDownloadActivation(activationKey)) {
      await delay(500);
      return;
    }
    
    if (downloadUrl) {
      console.log("Flow Helper: Using background download API for:", downloadUrl);
      
      const response = await sendRuntimeMessage({
        type: "FLOW_HELPER_DOWNLOAD",
        url: downloadUrl
      });

      if (response && response.ok) {
        console.log(`Flow Helper: Download ${response.method} successful`);
        await delay(1500);
        return;
      }
      console.warn("Flow Helper: Background download failed, trying click fallback", response?.error);
    }

    // Fallback: use exactly one activation target to avoid duplicate browser downloads.
    console.log("Flow Helper: Activating download target once");
    activateDownloadTargetOnce(activationTarget);

    await delay(3000);
  }

  async function archiveResult(options = {}) {
    const check = typeof options.check === "function" ? options.check : () => {};
    const archiveButton = findArchiveButton(findDownloadButton());

    check();

    if (!archiveButton) {
      throw new Error("Archive button not found");
    }

    clickElement(archiveButton);
    await delay(1500);
    check();
  }

  window.FlowHelperPageActions = {
    getProjectInfo,
    normalizeText,
    delay,
    fillPromptAndSubmit,
    waitForGenerationToFinish,
    clickDownload,
    resetNetworkCapture,
    waitForNetworkImage,
    downloadLatestNetworkImage,
    archiveResult
  };
})();
