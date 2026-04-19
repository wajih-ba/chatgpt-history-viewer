const chatId = window.__CHAT_ID__;
const chatTitleEl = document.getElementById("chatTitle");
const chatMetaEl = document.getElementById("chatMeta");
const conversationEl = document.getElementById("conversation");
const exportBtnEl = document.getElementById("exportBtn");

function formatDate(value) {
  if (!value) {
    return "No timestamp";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "No timestamp";
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function createMessageNode(message) {
  const role = (message.role || "unknown").toLowerCase();
  const roleClass = role === "assistant" || role === "user" ? role : "other";

  const wrapper = document.createElement("article");
  wrapper.className = `message message--${roleClass}`;

  const head = document.createElement("header");
  head.className = "message-head";

  const roleEl = document.createElement("strong");
  roleEl.textContent = role;

  const timestampEl = document.createElement("time");
  timestampEl.textContent = formatDate(message.timestamp);

  head.append(roleEl, timestampEl);

  const content = document.createElement("pre");
  content.className = "message-content";
  content.textContent = message.content || "";

  wrapper.append(head, content);
  return wrapper;
}

async function loadConversation() {
  chatTitleEl.textContent = "Loading conversation...";

  try {
    const response = await fetch(`/api/chats/${encodeURIComponent(chatId)}`);
    if (!response.ok) {
      throw new Error(`Request failed with status ${response.status}`);
    }

    const detail = await response.json();
    chatTitleEl.textContent = detail.title || "Untitled chat";
    chatMetaEl.textContent = `${detail.messages.length} message(s) • Created ${formatDate(
      detail.created_at,
    )}`;

    if (!detail.messages.length) {
      conversationEl.innerHTML = '<p class="empty-state">No messages captured yet.</p>';
      return;
    }

    conversationEl.innerHTML = "";
    detail.messages.forEach((message) => {
      conversationEl.append(createMessageNode(message));
    });
  } catch (error) {
    console.error(error);
    chatTitleEl.textContent = "Conversation not available";
    chatMetaEl.textContent = "";
    conversationEl.innerHTML =
      '<p class="error-state">Unable to load this chat. Check whether the chat exists.</p>';
  }
}

exportBtnEl.addEventListener("click", () => {
  const url = `/api/chats/${encodeURIComponent(chatId)}/export`;
  window.location.assign(url);
});

loadConversation();
