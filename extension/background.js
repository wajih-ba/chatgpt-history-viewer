const API_BASES = ["http://127.0.0.1:8000", "http://localhost:8000"];
const syncStatusByTab = new Map();

function setSyncStatus(tabId, payload) {
  if (typeof tabId !== "number") {
    return;
  }

  syncStatusByTab.set(tabId, {
    ...payload,
    updated_at: Date.now(),
  });
}

async function postJson(path, payload) {
  for (const base of API_BASES) {
    try {
      const response = await fetch(`${base}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      if (response.ok) {
        return { ok: true, base };
      }

      console.warn(`[ChatGPT Bridge] POST ${path} failed on ${base}: ${response.status}`);
    } catch (error) {
      console.warn(`[ChatGPT Bridge] POST ${path} error on ${base}`, error);
    }
  }

  return { ok: false };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message.type !== "string") {
    return false;
  }

  if (message.type === "SYNC_STATUS") {
    const tabId = typeof _sender?.tab?.id === "number" ? _sender.tab.id : null;
    setSyncStatus(tabId, message.payload || { state: "unknown" });
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === "GET_SYNC_STATUS") {
    const tabId = typeof message.tabId === "number" ? message.tabId : null;
    const payload = tabId !== null ? syncStatusByTab.get(tabId) || null : null;
    sendResponse({ ok: true, payload });
    return false;
  }

  let endpoint = "";
  if (message.type === "UPSERT_CHAT") {
    endpoint = "/api/chats";
  } else if (message.type === "UPSERT_MESSAGES") {
    endpoint = "/api/messages";
  } else {
    return false;
  }

  postJson(endpoint, message.payload)
    .then((result) => sendResponse(result))
    .catch((error) => {
      console.error("[ChatGPT Bridge] dispatch error", error);
      sendResponse({ ok: false });
    });

  return true;
});
