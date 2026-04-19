const chatListEl = document.getElementById("chatList");
const statusTextEl = document.getElementById("statusText");
const searchInputEl = document.getElementById("searchInput");

let searchTimer = null;

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

function escapeHtml(text) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderChats(chats) {
  if (!chats.length) {
    chatListEl.innerHTML = '<p class="empty-state">No conversations found.</p>';
    return;
  }

  chatListEl.innerHTML = chats
    .map((chat) => {
      const detailUrl = `/chats/${encodeURIComponent(chat.id)}`;
      const title = escapeHtml(chat.title || "Untitled chat");
      const messageCount = Number(chat.message_count ?? 0);
      const dateText = formatDate(chat.last_message_at || chat.created_at);

      return `
        <a class="chat-card" href="${detailUrl}">
          <div>
            <h3>${title}</h3>
            <p class="chat-meta">ID: ${escapeHtml(chat.id)}</p>
          </div>
          <div class="chat-stats">
            <span>${messageCount} messages</span>
            <span>${escapeHtml(dateText)}</span>
          </div>
        </a>
      `;
    })
    .join("");
}

async function loadChats(searchText = "") {
  statusTextEl.textContent = "Loading chats...";

  const params = new URLSearchParams();
  if (searchText.trim()) {
    params.set("search", searchText.trim());
  }

  const querySuffix = params.toString() ? `?${params.toString()}` : "";

  try {
    const response = await fetch(`/api/chats${querySuffix}`);
    if (!response.ok) {
      throw new Error(`Request failed with status ${response.status}`);
    }

    const chats = await response.json();
    renderChats(chats);
    statusTextEl.textContent = `${chats.length} chat(s)`;
  } catch (error) {
    console.error(error);
    chatListEl.innerHTML =
      '<p class="error-state">Unable to load chats. Make sure the backend is running.</p>';
    statusTextEl.textContent = "Error";
  }
}

searchInputEl.addEventListener("input", () => {
  if (searchTimer) {
    clearTimeout(searchTimer);
  }

  searchTimer = setTimeout(() => {
    loadChats(searchInputEl.value);
  }, 220);
});

loadChats();
