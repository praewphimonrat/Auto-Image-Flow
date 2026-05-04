(function initFlowHelperQueuePanel() {
  if (window.FlowHelperQueuePanel) {
    return;
  }

  const FLOW_HELPER_ROOT_ID = "autogen-flow-helper-root";
  const STORAGE_KEY = "flowHelperQueueStateByProject";
  const RETRY_LIMIT = 3;
  const MAX_REFRESHES_PER_ITEM = 1;
  const STAGE_LABELS = {
    input: "Fill prompt",
    "wait-progress": "Wait for generation",
    download: "Download result",
    "delete-trigger": "Open delete dialog",
    "delete-confirm": "Confirm delete",
    completed: "Completed"
  };

  const state = {
    root: null,
    body: null,
    promptInput: null,
    addButton: null,
    startButton: null,
    pauseButton: null,
    clearDoneButton: null,
    clearAllButton: null,
    queueList: null,
    queueStatus: null,
    queueCount: null,
    projectDetailSection: null,
    storageMap: {},
    queueState: {
      queue: [],
      running: false,
      activeQueueItemId: null,
      statusMessage: "Ready"
    },
    runtimeStatus: "Ready",
    projectKey: "",
    isProcessing: false,
    booted: false,
    heartbeatInterval: null,
    silentAudio: null
  };

  class QueuePausedError extends Error {}
  class QueueRefreshError extends Error {}

  function startSilentAudio() {
    if (state.silentAudio) {
      return;
    }

    try {
      const SILENT_AUDIO = "data:audio/wav;base64,UklGRigAAABXQVZFRm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQQAAAAAAA==";
      state.silentAudio = new Audio(SILENT_AUDIO);
      state.silentAudio.loop = true;
      state.silentAudio.volume = 0; // Completely silent
      state.silentAudio.play().then(() => {
        console.log("Flow Helper: Tab silent audio started");
      }).catch((error) => {
        console.log("Flow Helper: Tab silent audio blocked (expected):", error.message);
        // Expected - browser blocks autoplay without user interaction
      });
    } catch (error) {
      console.warn("Flow Helper: Could not start silent audio in tab", error);
    }
  }

  function stopSilentAudio() {
    if (state.silentAudio) {
      state.silentAudio.pause();
      state.silentAudio = null;
    }
  }

  function startHeartbeat() {
    if (state.heartbeatInterval) {
      return;
    }

    // Start offscreen document via background script
    chrome.runtime.sendMessage({ type: "FLOW_HELPER_OFFSCREEN_START" }).catch(() => {});

    // Start silent audio in the current tab to prevent throttling
    startSilentAudio();

    state.heartbeatInterval = window.setInterval(() => {
      chrome.runtime.sendMessage({
        type: "FLOW_HELPER_PING"
      }).catch(() => {
        // Ignore errors if extension context is invalidated
      });
    }, 15000);
  }

  function stopHeartbeat() {
    if (state.heartbeatInterval) {
      window.clearInterval(state.heartbeatInterval);
      state.heartbeatInterval = null;
    }

    stopSilentAudio();
    chrome.runtime.sendMessage({ type: "FLOW_HELPER_OFFSCREEN_STOP" }).catch(() => {});
  }

  function getActions() {
    return window.FlowHelperPageActions;
  }

  function getPanelRoot() {
    const root = document.getElementById(FLOW_HELPER_ROOT_ID);
    return root instanceof HTMLElement ? root : null;
  }

  function createDefaultQueueState() {
    return {
      queue: [],
      running: false,
      activeQueueItemId: null,
      statusMessage: "Ready"
    };
  }

  function getProjectKey() {
    const actions = getActions();
    const projectInfo = actions.getProjectInfo();
    return `${projectInfo.projectId}:${window.location.pathname}`;
  }

  function normalizeQueueItem(item, index = 0) {
    const now = new Date().toISOString();
    const prompt = typeof item?.prompt === "string" ? item.prompt.trim() : "";

    return {
      id: typeof item?.id === "string" && item.id ? item.id : `queue-${Date.now()}-${index}`,
      prompt,
      status: ["queued", "running", "paused", "completed", "error"].includes(item?.status) ? item.status : "queued",
      stage: STAGE_LABELS[item?.stage] ? item.stage : "input",
      stageAttempts: Number.isFinite(item?.stageAttempts) ? item.stageAttempts : 0,
      refreshCount: Number.isFinite(item?.refreshCount) ? item.refreshCount : 0,
      lastError: typeof item?.lastError === "string" ? item.lastError : "",
      createdAt: typeof item?.createdAt === "string" ? item.createdAt : now,
      updatedAt: typeof item?.updatedAt === "string" ? item.updatedAt : now
    };
  }

  function normalizeQueueState(value) {
    const queue = Array.isArray(value?.queue)
      ? value.queue
        .map((item, index) => normalizeQueueItem(item, index))
        .filter((item) => item.prompt && item.status !== "completed" && item.stage !== "completed")
      : [];
    const activeQueueItemId = typeof value?.activeQueueItemId === "string" ? value.activeQueueItemId : null;

    return {
      queue,
      running: Boolean(value?.running),
      activeQueueItemId: queue.some((item) => item.id === activeQueueItemId && ["queued", "paused", "running"].includes(item.status))
        ? activeQueueItemId
        : null,
      statusMessage: typeof value?.statusMessage === "string" && value.statusMessage ? value.statusMessage : "Ready"
    };
  }

  function storageGet(keys) {
    return new Promise((resolve) => {
      chrome.storage.local.get(keys, (result) => {
        resolve(chrome.runtime.lastError ? {} : result || {});
      });
    });
  }

  function storageSet(value) {
    return new Promise((resolve) => {
      chrome.storage.local.set(value, () => {
        resolve();
      });
    });
  }

  async function loadQueueState() {
    const result = await storageGet([STORAGE_KEY]);
    state.storageMap = result[STORAGE_KEY] && typeof result[STORAGE_KEY] === "object" ? result[STORAGE_KEY] : {};
    state.projectKey = getProjectKey();
    state.queueState = normalizeQueueState(state.storageMap[state.projectKey]);
    state.runtimeStatus = state.queueState.statusMessage;
  }

  async function persistQueueState() {
    state.storageMap[state.projectKey] = {
      queue: state.queueState.queue.map((item) => ({ ...item })),
      running: state.queueState.running,
      activeQueueItemId: state.queueState.activeQueueItemId,
      statusMessage: state.queueState.statusMessage,
      updatedAt: new Date().toISOString()
    };

    await storageSet({
      [STORAGE_KEY]: state.storageMap
    });
  }

  function setRuntimeStatus(message) {
    state.runtimeStatus = message;

    if (state.queueStatus) {
      state.queueStatus.textContent = message;
    }
  }

  function truncateText(value, maxLength = 72) {
    return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
  }

  function buildQueueItem(prompt) {
    const now = new Date().toISOString();

    return {
      id: `queue-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      prompt,
      status: "queued",
      stage: "input",
      stageAttempts: 0,
      refreshCount: 0,
      lastError: "",
      createdAt: now,
      updatedAt: now
    };
  }

  function parsePromptBatch(rawValue) {
    const trimmedValue = typeof rawValue === "string" ? rawValue.trim() : "";

    if (!trimmedValue) {
      return [];
    }

    // 1. If contains double newlines, treat them as the primary separator
    if (trimmedValue.includes("\n\n")) {
      return trimmedValue
        .split(/\n\s*\n/)
        .map((block) => block.trim())
        .filter(Boolean);
    }

    // 2. Otherwise, look for list patterns (1., -, *, etc.)
    const lines = trimmedValue
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    const listItemPattern = /^(\d+[\.\)]|[-*])\s+/;
    const isList = lines.some((line) => listItemPattern.test(line));

    if (isList) {
      return lines
        .map((line) => line.replace(listItemPattern, "").trim())
        .filter(Boolean);
    }

    // 3. Fallback: if multiple lines exist without double newlines or list patterns, 
    // treat each line as a separate prompt to satisfy the "batch" expectation.
    if (lines.length > 1) {
      return lines;
    }

    return [trimmedValue];
  }

  function getQueueItemById(queueItemId) {
    return state.queueState.queue.find((item) => item.id === queueItemId) || null;
  }

  function getActiveQueueItem() {
    return getQueueItemById(state.queueState.activeQueueItemId);
  }

  function ensureActiveQueueItem() {
    const activeItem = getActiveQueueItem();

    if (activeItem && ["queued", "paused", "running"].includes(activeItem.status)) {
      return activeItem;
    }

    const nextItem = state.queueState.queue.find((item) => ["queued", "paused", "running"].includes(item.status));

    if (nextItem) {
      state.queueState.activeQueueItemId = nextItem.id;
      return nextItem;
    }

    state.queueState.activeQueueItemId = null;
    return null;
  }

  function assertQueueRunning() {
    if (!state.queueState.running) {
      throw new QueuePausedError("Queue paused");
    }
  }

  function createQueueListItem(queueItem, index) {
    const itemElement = document.createElement("li");
    itemElement.className = "flow-helper-queue-item";
    itemElement.dataset.status = queueItem.status;

    const topRow = document.createElement("div");
    topRow.className = "flow-helper-queue-item__top";

    const meta = document.createElement("div");
    meta.className = "flow-helper-queue-item__meta";

    const order = document.createElement("span");
    order.className = "flow-helper-queue-item__order";
    order.textContent = `#${index + 1}`;

    const badge = document.createElement("span");
    badge.className = "flow-helper-badge";
    badge.dataset.status = queueItem.status;
    badge.textContent = queueItem.status;

    meta.append(order, badge);

    const actions = document.createElement("div");
    actions.className = "flow-helper-queue-item__actions";

    if (queueItem.status === "error") {
      const retryButton = document.createElement("button");
      retryButton.type = "button";
      retryButton.className = "flow-helper-chip-button";
      retryButton.dataset.queueAction = "retry";
      retryButton.dataset.queueId = queueItem.id;
      retryButton.textContent = "Retry";
      actions.appendChild(retryButton);
    }

    const removeButton = document.createElement("button");
    removeButton.type = "button";
    removeButton.className = "flow-helper-chip-button";
    removeButton.dataset.queueAction = "remove";
    removeButton.dataset.queueId = queueItem.id;
    removeButton.textContent = "Remove";
    removeButton.disabled = state.queueState.running && state.queueState.activeQueueItemId === queueItem.id;
    actions.appendChild(removeButton);

    topRow.append(meta, actions);

    const prompt = document.createElement("p");
    prompt.className = "flow-helper-queue-item__prompt";
    prompt.textContent = queueItem.prompt;

    const stage = document.createElement("p");
    stage.className = "flow-helper-queue-item__stage";
    stage.textContent = `Stage: ${STAGE_LABELS[queueItem.stage]} • Retry: ${queueItem.stageAttempts}/${RETRY_LIMIT} • Refresh: ${queueItem.refreshCount}/${MAX_REFRESHES_PER_ITEM}`;

    itemElement.append(topRow, prompt, stage);

    if (queueItem.lastError) {
      const error = document.createElement("p");
      error.className = "flow-helper-queue-item__error";
      error.textContent = queueItem.lastError;
      itemElement.appendChild(error);
    }

    return itemElement;
  }

  function renderQueueUi() {
    if (!state.queueList || !state.queueStatus || !state.queueCount || !state.startButton || !state.pauseButton || !state.clearDoneButton || !state.clearAllButton) {
      return;
    }

    state.queueList.innerHTML = "";

    if (!state.queueState.queue.length) {
      const emptyState = document.createElement("li");
      emptyState.className = "flow-helper-queue-empty";
      emptyState.textContent = "No prompts queued yet.";
      state.queueList.appendChild(emptyState);
    } else {
      state.queueState.queue.forEach((queueItem, index) => {
        state.queueList.appendChild(createQueueListItem(queueItem, index));
      });
    }

    const completedCount = state.queueState.queue.filter((item) => item.status === "completed").length;
    const hasProcessableItems = state.queueState.queue.some((item) => ["queued", "paused", "running"].includes(item.status));
    state.queueCount.textContent = `${state.queueState.queue.length} item(s) • ${completedCount} done`;
    state.queueStatus.textContent = state.runtimeStatus || state.queueState.statusMessage;
    state.startButton.disabled = state.queueState.running || !hasProcessableItems;
    state.pauseButton.disabled = !state.queueState.running;
    state.clearDoneButton.disabled = !state.queueState.queue.some((item) => item.status === "completed" || item.status === "error");
    state.clearAllButton.disabled = state.queueState.queue.length === 0;
  }

  function bindUiEvents() {
    state.promptInput?.addEventListener("keydown", (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        void enqueuePrompt();
      }
    });

    state.addButton?.addEventListener("click", () => {
      void enqueuePrompt();
    });

    state.startButton?.addEventListener("click", () => {
      void startQueue();
    });

    state.pauseButton?.addEventListener("click", () => {
      void pauseQueue();
    });

    state.clearDoneButton?.addEventListener("click", () => {
      void clearDoneItems();
    });

    state.clearAllButton?.addEventListener("click", () => {
      void clearAllItems();
    });

    state.queueList?.addEventListener("click", (event) => {
      const target = event.target instanceof HTMLElement ? event.target.closest("[data-queue-action]") : null;

      if (!(target instanceof HTMLButtonElement)) {
        return;
      }

      const { queueAction, queueId } = target.dataset;

      if (queueAction === "remove" && queueId) {
        void removeQueueItem(queueId);
      }

      if (queueAction === "retry" && queueId) {
        void retryQueueItem(queueId);
      }
    });
  }

  function buildPanelUi() {
    const root = getPanelRoot();

    if (!root) {
      return false;
    }

    state.root = root;
    state.body = root.querySelector(".flow-helper-panel__body");

    if (!(state.body instanceof HTMLElement)) {
      return false;
    }

    const title = root.querySelector(".flow-helper-panel__title");
    const copy = root.querySelector(".flow-helper-panel__copy");

    if (title) {
      title.textContent = "Prompt Queue";
    }

    if (copy) {
      copy.textContent =
        "Add prompts, start the queue, and the panel will submit, wait, download, delete, and recover from one refresh if a step gets stuck.";
    }

    state.body.innerHTML = `
      <section class="flow-helper-section">
        <label class="flow-helper-label" for="flow-helper-prompt-input">Prompt</label>
        <textarea
          id="flow-helper-prompt-input"
          class="flow-helper-textarea"
          data-role="prompt-input"
          placeholder="Type a prompt here..."
        ></textarea>
        <div class="flow-helper-button-row">
          <button type="button" class="flow-helper-button flow-helper-button--primary" data-action="enqueue">Add to queue</button>
          <button type="button" class="flow-helper-button" data-action="start">Start queue</button>
          <button type="button" class="flow-helper-button flow-helper-button--ghost" data-action="pause">Pause</button>
        </div>
      </section>
      <section class="flow-helper-section flow-helper-section--queue">
        <div class="flow-helper-section__top">
          <div>
            <p class="flow-helper-label">Queue</p>
            <p class="flow-helper-counter" data-role="queue-count">0 item(s)</p>
          </div>
          <div class="flow-helper-inline-actions">
            <button type="button" class="flow-helper-chip-button" data-action="clear-done">Clear done</button>
            <button type="button" class="flow-helper-chip-button" data-action="clear-all">Clear all</button>
          </div>
        </div>
        <p class="flow-helper-status" data-role="queue-status">Ready</p>
        <ul class="flow-helper-queue" data-role="queue-list"></ul>
      </section>
    `;

    state.promptInput = state.body.querySelector('[data-role="prompt-input"]');
    state.addButton = state.body.querySelector('[data-action="enqueue"]');
    state.startButton = state.body.querySelector('[data-action="start"]');
    state.pauseButton = state.body.querySelector('[data-action="pause"]');
    state.clearDoneButton = state.body.querySelector('[data-action="clear-done"]');
    state.clearAllButton = state.body.querySelector('[data-action="clear-all"]');
    state.queueList = state.body.querySelector('[data-role="queue-list"]');
    state.queueStatus = state.body.querySelector('[data-role="queue-status"]');
    state.queueCount = state.body.querySelector('[data-role="queue-count"]');

    bindUiEvents();
    return true;
  }

  async function waitForPanelRoot() {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (buildPanelUi()) {
        return true;
      }

      await getActions().delay(150);
    }

    return false;
  }

  async function enqueuePrompt() {
    if (!state.promptInput) {
      return;
    }

    const prompts = parsePromptBatch(state.promptInput.value);

    if (!prompts.length) {
      setRuntimeStatus("Type a prompt before adding it to the queue.");
      return;
    }

    prompts.forEach((prompt) => {
      state.queueState.queue.push(buildQueueItem(prompt));
    });

    state.queueState.statusMessage =
      prompts.length === 1
        ? `${state.queueState.queue.length} prompt(s) in queue`
        : `Added ${prompts.length} prompts • ${state.queueState.queue.length} prompt(s) in queue`;
    setRuntimeStatus(state.queueState.statusMessage);
    state.promptInput.value = "";

    await persistQueueState();
    renderQueueUi();
  }

  async function startQueue() {
    if (!state.queueState.queue.some((item) => ["queued", "paused", "running"].includes(item.status))) {
      setRuntimeStatus("No pending prompts to process.");
      return;
    }

    const activeItem = ensureActiveQueueItem();

    if (activeItem && activeItem.status === "paused") {
      activeItem.status = "running";
      activeItem.updatedAt = new Date().toISOString();
    }

    state.queueState.running = true;
    state.queueState.statusMessage = "Queue running";
    setRuntimeStatus("Queue running");

    startHeartbeat();
    await persistQueueState();
    renderQueueUi();
    void processQueue();
  }

  async function pauseQueue() {
    state.queueState.running = false;
    stopHeartbeat();

    const activeItem = getActiveQueueItem();

    if (activeItem && activeItem.status === "running") {
      activeItem.status = "paused";
      activeItem.updatedAt = new Date().toISOString();
    }

    state.queueState.statusMessage = "Queue paused";
    setRuntimeStatus("Queue paused");

    await persistQueueState();
    renderQueueUi();
  }

  async function clearDoneItems() {
    state.queueState.queue = state.queueState.queue.filter((item) => item.status !== "completed" && item.status !== "error");

    if (!getActiveQueueItem()) {
      state.queueState.activeQueueItemId = null;
    }

    state.queueState.statusMessage = state.queueState.queue.length ? "Cleared finished items" : "Queue cleared";
    setRuntimeStatus(state.queueState.statusMessage);

    await persistQueueState();
    renderQueueUi();
  }

  async function clearAllItems() {
    state.queueState.queue = [];
    state.queueState.running = false;
    state.queueState.activeQueueItemId = null;
    state.queueState.statusMessage = "Queue cleared";
    setRuntimeStatus("Queue cleared");

    await persistQueueState();
    renderQueueUi();
  }

  async function removeQueueItem(queueItemId) {
    if (state.queueState.running && state.queueState.activeQueueItemId === queueItemId) {
      setRuntimeStatus("Pause the queue before removing the active item.");
      return;
    }

    state.queueState.queue = state.queueState.queue.filter((item) => item.id !== queueItemId);

    if (state.queueState.activeQueueItemId === queueItemId) {
      state.queueState.activeQueueItemId = null;
    }

    state.queueState.statusMessage = state.queueState.queue.length ? "Removed queue item" : "Queue is empty";
    setRuntimeStatus(state.queueState.statusMessage);

    await persistQueueState();
    renderQueueUi();
  }

  async function retryQueueItem(queueItemId) {
    const queueItem = getQueueItemById(queueItemId);

    if (!queueItem) {
      return;
    }

    queueItem.status = "queued";
    queueItem.stage = "input";
    queueItem.stageAttempts = 0;
    queueItem.refreshCount = 0;
    queueItem.lastError = "";
    queueItem.updatedAt = new Date().toISOString();

    if (!state.queueState.activeQueueItemId) {
      state.queueState.activeQueueItemId = queueItem.id;
    }

    state.queueState.statusMessage = `Retrying "${truncateText(queueItem.prompt)}"`;
    setRuntimeStatus(state.queueState.statusMessage);

    await persistQueueState();
    renderQueueUi();
  }

  async function advanceStage(queueItem, nextStage, message) {
    queueItem.stage = nextStage;
    queueItem.stageAttempts = 0;
    queueItem.lastError = "";
    queueItem.updatedAt = new Date().toISOString();
    state.queueState.statusMessage = message;
    setRuntimeStatus(message);
    await persistQueueState();
    renderQueueUi();
  }

  async function completeQueueItem(queueItem) {
    const completedPrompt = truncateText(queueItem.prompt);
    state.queueState.queue = state.queueState.queue.filter((item) => item.id !== queueItem.id);
    state.queueState.activeQueueItemId = null;
    state.queueState.statusMessage = state.queueState.queue.length
      ? `Completed "${completedPrompt}" and cleared it from the queue`
      : `Completed "${completedPrompt}" and cleared the queue`;
    setRuntimeStatus(state.queueState.statusMessage);
    await persistQueueState();
    renderQueueUi();
  }

  async function handleStageFailure(queueItem, error) {
    if (error instanceof QueuePausedError || error instanceof QueueRefreshError) {
      throw error;
    }

    queueItem.stageAttempts += 1;
    queueItem.lastError = error instanceof Error ? error.message : String(error);
    queueItem.updatedAt = new Date().toISOString();
    state.queueState.statusMessage = `${STAGE_LABELS[queueItem.stage]} failed (${queueItem.stageAttempts}/${RETRY_LIMIT})`;
    setRuntimeStatus(state.queueState.statusMessage);

    if (queueItem.stageAttempts >= RETRY_LIMIT) {
      if (queueItem.refreshCount < MAX_REFRESHES_PER_ITEM) {
        queueItem.refreshCount += 1;
        queueItem.stageAttempts = 0;
        state.queueState.statusMessage = `${STAGE_LABELS[queueItem.stage]} failed ${RETRY_LIMIT} times. Refreshing page.`;
        setRuntimeStatus(state.queueState.statusMessage);
        await persistQueueState();
        renderQueueUi();
        await getActions().delay(250);
        window.location.reload();
        throw new QueueRefreshError("Refreshing page");
      }

      queueItem.status = "error";
      state.queueState.activeQueueItemId = null;
      state.queueState.statusMessage = `Stopped "${truncateText(queueItem.prompt)}" after retry and refresh`;
      setRuntimeStatus(state.queueState.statusMessage);
    }

    await persistQueueState();
    renderQueueUi();

    if (queueItem.status !== "error") {
      await getActions().delay(1500);
    }
  }

  async function processQueueItem(queueItem) {
    const actions = getActions();

    queueItem.status = "running";
    queueItem.updatedAt = new Date().toISOString();
    await persistQueueState();
    renderQueueUi();

    while (state.queueState.running) {
      try {
        if (queueItem.stage === "input") {
          setRuntimeStatus(`Submitting "${truncateText(queueItem.prompt)}"`);
          await actions.fillPromptAndSubmit(queueItem.prompt);
          await advanceStage(queueItem, "wait-progress", `Submitted "${truncateText(queueItem.prompt)}"`);
          continue;
        }

        if (queueItem.stage === "wait-progress") {
          await actions.waitForGenerationToFinish({
            check: assertQueueRunning,
            onProgress: (progressText) => {
              if (progressText === "waiting-start") {
                setRuntimeStatus(`Waiting for generation to start for "${truncateText(queueItem.prompt)}"`);
                return;
              }

              if (progressText === "waiting-finish") {
                setRuntimeStatus(`Waiting for generation to finish for "${truncateText(queueItem.prompt)}"`);
                return;
              }

              setRuntimeStatus(`Generating ${progressText}`);
            }
          });
          await advanceStage(queueItem, "download", `Generation finished for "${truncateText(queueItem.prompt)}"`);
          continue;
        }

        if (queueItem.stage === "download") {
          setRuntimeStatus(`Downloading "${truncateText(queueItem.prompt)}"`);
          await actions.clickDownload();
          await advanceStage(queueItem, "delete-trigger", `Downloaded "${truncateText(queueItem.prompt)}"`);
          continue;
        }

        if (queueItem.stage === "delete-trigger") {
          setRuntimeStatus(`Opening delete dialog for "${truncateText(queueItem.prompt)}"`);
          await actions.openDeleteDialog({
            check: assertQueueRunning
          });
          await advanceStage(queueItem, "delete-confirm", `Delete dialog opened for "${truncateText(queueItem.prompt)}"`);
          continue;
        }

        if (queueItem.stage === "delete-confirm") {
          setRuntimeStatus(`Deleting "${truncateText(queueItem.prompt)}"`);
          await actions.confirmDelete({
            check: assertQueueRunning
          });
          await completeQueueItem(queueItem);
          return;
        }

        if (queueItem.stage === "completed") {
          queueItem.status = "completed";
          state.queueState.activeQueueItemId = null;
          await persistQueueState();
          renderQueueUi();
          return;
        }

        queueItem.stage = "input";
        await persistQueueState();
      } catch (error) {
        await handleStageFailure(queueItem, error);

        if (queueItem.status === "error") {
          return;
        }
      }
    }

    throw new QueuePausedError("Queue paused");
  }

  async function processQueue() {
    if (state.isProcessing) {
      return;
    }

    state.isProcessing = true;

    try {
      while (state.queueState.running) {
        const queueItem = ensureActiveQueueItem();

        if (!queueItem) {
          state.queueState.running = false;
          state.queueState.activeQueueItemId = null;
          state.queueState.statusMessage = "Queue completed";
          setRuntimeStatus("Queue completed");
          await persistQueueState();
          renderQueueUi();
          return;
        }

        try {
          await processQueueItem(queueItem);
        } catch (error) {
          if (error instanceof QueuePausedError || error instanceof QueueRefreshError) {
            return;
          }

          queueItem.status = "error";
          queueItem.lastError = error instanceof Error ? error.message : String(error);
          queueItem.updatedAt = new Date().toISOString();
          state.queueState.activeQueueItemId = null;
          state.queueState.statusMessage = `Unexpected error on "${truncateText(queueItem.prompt)}"`;
          setRuntimeStatus(state.queueState.statusMessage);
          await persistQueueState();
          renderQueueUi();
        }
      }
    } finally {
      state.isProcessing = false;
    }
  }

  async function handleLocationChange() {
    const nextProjectKey = getProjectKey();

    if (nextProjectKey === state.projectKey) {
      renderQueueUi();
      return;
    }

    state.projectKey = nextProjectKey;
    state.queueState = normalizeQueueState(state.storageMap[state.projectKey] || createDefaultQueueState());
    state.runtimeStatus = state.queueState.statusMessage;
    renderQueueUi();

    if (state.queueState.running) {
      startHeartbeat();
      void processQueue();
    }
  }

  async function boot() {
    if (state.booted || !getActions()) {
      return;
    }

    state.booted = true;

    await loadQueueState();

    if (!(await waitForPanelRoot())) {
      console.warn("Flow Helper queue panel could not find the docked panel root");
      return;
    }

    renderQueueUi();

    window.addEventListener("flow-helper-locationchange", () => {
      void handleLocationChange();
    });
    window.addEventListener("popstate", () => {
      void handleLocationChange();
    });

    if (state.queueState.running) {
      void processQueue();
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener(
      "DOMContentLoaded",
      () => {
        void boot();
      },
      { once: true }
    );
  } else {
    void boot();
  }

  window.FlowHelperQueuePanel = {
    boot
  };
})();
