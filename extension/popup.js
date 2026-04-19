const syncButtonEl = document.getElementById("syncButton");
const statusTextEl = document.getElementById("statusText");
const detailTextEl = document.getElementById("detailText");

let activeTabId = null;
let pollTimer = null;

function setStatus(text, tone = "") {
  statusTextEl.textContent = text;
  statusTextEl.className = "status";
  if (tone) {
    statusTextEl.classList.add(`status--${tone}`);
  }
}

function setDetail(text) {
  detailTextEl.textContent = text;
}

function isChatgptUrl(url) {
  if (typeof url !== "string" || !url) {
    return false;
  }

  return url.startsWith("https://chatgpt.com/") || url.startsWith("https://chat.openai.com/");
}

function updateFromStatusPayload(payload) {
  if (!payload || typeof payload.state !== "string") {
    setStatus("Ready.");
    setDetail("");
    return;
  }

  if (payload.state === "started") {
    if (payload.trigger === "auto") {
      setStatus("Auto sync started. Keep ChatGPT tab open.", "running");
    } else {
      setStatus("Sync started. Keep ChatGPT tab open.", "running");
    }
    setDetail("");
    return;
  }

  if (payload.state === "progress") {
    setStatus("Sync in progress...", "running");
    if (payload.stage === "listing") {
      const modeLabel = typeof payload.mode === "string" ? payload.mode : "all";
      setDetail(
        `Collecting ${modeLabel} chats: ${payload.discovered || 0} found (page ${payload.page || 1})`,
      );
      return;
    }

    if (payload.stage === "details") {
      const total = payload.total || 0;
      setDetail(
        `Fetching details: ${payload.processed || 0}/${total} completed, failed ${payload.failed || 0}`,
      );
      return;
    }

    if (payload.stage === "navigating") {
      const total = payload.total || 0;
      setDetail(
        `Auto-opening chats: ${payload.processed || 0}/${total} done, failed ${payload.failed || 0}`,
      );
      return;
    }

    if (payload.stage === "history_scroll") {
      setDetail(`Auto-scrolling history: ${payload.discovered || 0} chats found (pass ${payload.round || 1})`);
      return;
    }

    if (payload.stage === "history_unavailable") {
      setDetail("History panel not found. Keeping API-based sync only.");
      return;
    }

    if (payload.stage === "deep_capture") {
      const total = payload.total || 0;
      setDetail(
        `Capturing opened chat: ${payload.processed || 0}/${total} done, failed ${payload.failed || 0}`,
      );
      return;
    }

    setDetail(`Processed ${payload.processed || 0}, failed ${payload.failed || 0}`);
    return;
  }

  if (payload.state === "completed") {
    setStatus("Sync completed.", "success");
    const total = payload.total || payload.scanned || 0;
    setDetail(`Finished ${payload.processed || 0}/${total} chats, failed ${payload.failed || 0}`);
    return;
  }

  if (payload.state === "already_running") {
    setStatus("Sync is already running.", "running");
    setDetail("");
    return;
  }

  if (payload.state === "error") {
    const message = typeof payload.message === "string" ? payload.message : "Unknown error";
    setStatus("Sync failed.", "error");
    setDetail(message);
    return;
  }

  setStatus("Ready.");
  setDetail("");
}

function stopPolling() {
  if (pollTimer) {
    window.clearInterval(pollTimer);
    pollTimer = null;
  }
}

function requestStatus() {
  if (typeof activeTabId !== "number") {
    return;
  }

  chrome.runtime.sendMessage({ type: "GET_SYNC_STATUS", tabId: activeTabId }, (response) => {
    if (chrome.runtime.lastError) {
      return;
    }

    const payload = response && response.ok ? response.payload : null;
    updateFromStatusPayload(payload);

    if (payload && (payload.state === "completed" || payload.state === "error")) {
      stopPolling();
    }
  });
}

function startPolling() {
  stopPolling();
  pollTimer = window.setInterval(requestStatus, 1000);
}

function triggerSync() {
  if (typeof activeTabId !== "number") {
    setStatus("Open a ChatGPT tab first.", "error");
    return;
  }

  syncButtonEl.disabled = true;
  setStatus("Starting sync...", "running");
  setDetail("");

  chrome.tabs.sendMessage(
    activeTabId,
    { type: "START_FULL_SYNC", trigger: "popup", deep: true },
    (response) => {
    syncButtonEl.disabled = false;

    if (chrome.runtime.lastError) {
      setStatus("Could not contact ChatGPT tab.", "error");
      setDetail("Open chatgpt.com and refresh once, then retry.");
      return;
    }

    if (!response || !response.ok) {
      setStatus("Sync request was rejected.", "error");
      setDetail("Try reloading the extension and the ChatGPT tab.");
      return;
    }

    setStatus("Sync started. Keep ChatGPT tab open.", "running");
    startPolling();
    requestStatus();
    },
  );
}

function init() {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = Array.isArray(tabs) && tabs.length > 0 ? tabs[0] : null;
    const tabId = tab && typeof tab.id === "number" ? tab.id : null;

    if (tabId === null) {
      syncButtonEl.disabled = true;
      setStatus("No active tab found.", "error");
      setDetail("");
      return;
    }

    activeTabId = tabId;

    if (!isChatgptUrl(tab.url || "")) {
      syncButtonEl.disabled = true;
      setStatus("Switch to a ChatGPT tab.", "error");
      setDetail("Then reopen this popup.");
      return;
    }

    syncButtonEl.disabled = false;
    setStatus("Ready.");
    setDetail("");
    requestStatus();
  });
}

syncButtonEl.addEventListener("click", triggerSync);
window.addEventListener("unload", stopPolling);

init();
