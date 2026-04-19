(() => {
  const script = document.createElement("script");
  script.src = chrome.runtime.getURL("injected.js");
  script.async = false;

  const target = document.head || document.documentElement;
  target.appendChild(script);
  script.onload = () => script.remove();

  function relay(type, payload) {
    chrome.runtime.sendMessage({ type, payload }, () => {
      if (chrome.runtime.lastError) {
        console.debug("[ChatGPT Bridge] relay failed", chrome.runtime.lastError.message);
      }
    });
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.type !== "START_FULL_SYNC") {
      return false;
    }

    const trigger = typeof message.trigger === "string" ? message.trigger : "popup";
    const deep = message.deep !== false;

    window.postMessage(
      {
        source: "CHATGPT_ARCHIVER_CONTENT",
        type: "START_FULL_SYNC",
        payload: {
          trigger,
          deep,
        },
      },
      "*",
    );

    sendResponse({ ok: true });
    return false;
  });

  window.addEventListener("message", (event) => {
    if (event.source !== window) {
      return;
    }

    const data = event.data;
    if (!data || data.source !== "CHATGPT_ARCHIVER_INJECTED") {
      return;
    }

    if (data.type === "CHAT_SUMMARIES") {
      const chats = Array.isArray(data.payload?.chats) ? data.payload.chats : [];
      chats.forEach((chat) => relay("UPSERT_CHAT", chat));
      return;
    }

    if (data.type === "CHAT_DETAIL") {
      const detail = data.payload;
      if (!detail || !detail.chat || !detail.chat.id) {
        return;
      }

      relay("UPSERT_CHAT", detail.chat);
      relay("UPSERT_MESSAGES", {
        chat_id: detail.chat.id,
        messages: Array.isArray(detail.messages) ? detail.messages : [],
      });
      return;
    }

    if (data.type === "SYNC_STATUS") {
      relay("SYNC_STATUS", data.payload || {});
    }
  });
})();
