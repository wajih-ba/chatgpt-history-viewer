(() => {
  if (window.__CHATGPT_ARCHIVER_FETCH_PATCHED__) {
    return;
  }
  window.__CHATGPT_ARCHIVER_FETCH_PATCHED__ = true;

  const CONVERSATIONS_REGEX = /\/backend-api\/conversations(?:\?|$)/;
  const CONVERSATION_REGEX = /\/backend-api\/conversation\/([^/?#]+)/;
  const LIST_LIMIT = 100;
  const LIST_ORDER = "updated";
  const DETAIL_DELAY_MS = 250;
  const PAGE_DELAY_MS = 450;
  const MAX_PAGES = 500;
  const DETAIL_MAX_RETRIES = 3;

  let fullSyncInProgress = false;

  const originalFetch = window.fetch.bind(window);

  function toAbsoluteUrl(input) {
    if (input instanceof Request) {
      return input.url;
    }

    if (typeof input === "string") {
      return new URL(input, window.location.origin).toString();
    }

    return "";
  }

  function toNumberOrNull(value) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    return null;
  }

  function normalizeTitle(title) {
    if (typeof title !== "string") {
      return "Untitled chat";
    }

    const trimmed = title.trim();
    return trimmed || "Untitled chat";
  }

  function extractText(content) {
    if (!content) {
      return "";
    }

    if (typeof content === "string") {
      return content.trim();
    }

    const parts = Array.isArray(content.parts) ? content.parts : [];
    const joined = parts
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }

        if (part && typeof part === "object" && typeof part.text === "string") {
          return part.text;
        }

        return "";
      })
      .filter(Boolean)
      .join("\n")
      .trim();

    if (joined) {
      return joined;
    }

    if (typeof content.text === "string") {
      return content.text.trim();
    }

    return "";
  }

  function sleep(ms) {
    return new Promise((resolve) => {
      window.setTimeout(resolve, ms);
    });
  }

  function emit(type, payload) {
    window.postMessage(
      {
        source: "CHATGPT_ARCHIVER_INJECTED",
        type,
        payload,
      },
      "*",
    );
  }

  function normalizeConversations(data) {
    const items = Array.isArray(data?.items) ? data.items : [];

    return items
      .filter((item) => item && typeof item.id === "string")
      .map((item) => ({
        id: item.id,
        title: normalizeTitle(item.title),
        created_at: toNumberOrNull(item.create_time),
      }));
  }

  async function syncAllConversations() {
    if (fullSyncInProgress) {
      emit("SYNC_STATUS", {
        state: "already_running",
      });
      return;
    }

    fullSyncInProgress = true;

    let processed = 0;
    let failed = 0;
    let offset = 0;
    let pageCount = 0;
    let repeatedPages = 0;
    const seenChatIds = new Set();
    const orderedChatIds = [];

    emit("SYNC_STATUS", {
      state: "started",
    });

    try {
      // Phase 1: page through every conversation ID first.
      while (true) {
        pageCount += 1;
        if (pageCount > MAX_PAGES) {
          throw new Error("Sync stopped after too many pages. Try again.");
        }

        const listResponse = await window.fetch(
          `/backend-api/conversations?offset=${offset}&limit=${LIST_LIMIT}&order=${LIST_ORDER}`,
          {
            credentials: "include",
          },
        );

        if (!listResponse.ok) {
          throw new Error(`Failed to fetch conversation list (${listResponse.status})`);
        }

        const listPayload = await listResponse.json();
        const items = Array.isArray(listPayload?.items) ? listPayload.items : [];
        let pageNewChats = 0;

        if (items.length === 0) {
          break;
        }

        for (const item of items) {
          const chatId = item && typeof item.id === "string" ? item.id : "";
          if (!chatId || seenChatIds.has(chatId)) {
            continue;
          }

          seenChatIds.add(chatId);
          orderedChatIds.push(chatId);
          pageNewChats += 1;
        }

        emit("SYNC_STATUS", {
          state: "progress",
          stage: "listing",
          discovered: orderedChatIds.length,
          page: pageCount,
        });

        offset += items.length;
        const total =
          typeof listPayload?.total === "number" && Number.isFinite(listPayload.total)
            ? listPayload.total
            : null;

        if (total !== null && offset >= total) {
          break;
        }

        if (typeof listPayload?.has_more === "boolean" && listPayload.has_more === false) {
          break;
        }

        if (pageNewChats === 0) {
          repeatedPages += 1;
          if (repeatedPages >= 3) {
            break;
          }
        } else {
          repeatedPages = 0;
        }

        await sleep(PAGE_DELAY_MS);
      }

      // Phase 2: fetch details for all discovered conversations.
      for (let index = 0; index < orderedChatIds.length; index += 1) {
        const chatId = orderedChatIds[index];
        let success = false;

        for (let attempt = 1; attempt <= DETAIL_MAX_RETRIES; attempt += 1) {
          try {
            const detailResponse = await window.fetch(
              `/backend-api/conversation/${encodeURIComponent(chatId)}`,
              {
                credentials: "include",
              },
            );

            if (detailResponse.ok) {
              success = true;
              break;
            }

            if (attempt < DETAIL_MAX_RETRIES) {
              await sleep(DETAIL_DELAY_MS * attempt);
            }
          } catch (_error) {
            if (attempt < DETAIL_MAX_RETRIES) {
              await sleep(DETAIL_DELAY_MS * attempt);
            }
          }
        }

        if (success) {
          processed += 1;
        } else {
          failed += 1;
        }

        emit("SYNC_STATUS", {
          state: "progress",
          stage: "details",
          processed,
          failed,
          scanned: seenChatIds.size,
          total: orderedChatIds.length,
          page: pageCount,
        });

        await sleep(DETAIL_DELAY_MS);
      }

      emit("SYNC_STATUS", {
        state: "completed",
        processed,
        failed,
        scanned: seenChatIds.size,
        total: orderedChatIds.length,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      emit("SYNC_STATUS", {
        state: "error",
        message,
        processed,
        failed,
        scanned: seenChatIds.size,
      });
    } finally {
      fullSyncInProgress = false;
    }
  }

  function getSortedMappingEntries(mapping) {
    const entries = Object.entries(mapping)
      .filter(([, node]) => node && typeof node === "object")
      .map(([nodeId, node]) => {
        const timestamp = toNumberOrNull(node?.message?.create_time);
        const parentId = typeof node?.parent === "string" ? node.parent : "";
        return {
          nodeId,
          node,
          parentId,
          timestamp,
        };
      });

    entries.sort((a, b) => {
      const aTs = a.timestamp ?? Number.MAX_SAFE_INTEGER;
      const bTs = b.timestamp ?? Number.MAX_SAFE_INTEGER;

      if (aTs !== bTs) {
        return aTs - bTs;
      }

      if (a.parentId !== b.parentId) {
        return a.parentId.localeCompare(b.parentId);
      }

      return a.nodeId.localeCompare(b.nodeId);
    });

    return entries;
  }

  function normalizeConversation(data, fallbackChatId) {
    const chatId = typeof data?.id === "string" && data.id ? data.id : fallbackChatId;
    if (!chatId) {
      return null;
    }

    const mapping = data && typeof data.mapping === "object" && data.mapping ? data.mapping : {};
    const candidateNodes = getSortedMappingEntries(mapping).map((entry) => entry.node);

    const seen = new Set();
    const messages = [];

    candidateNodes.forEach((node, index) => {
      const message = node?.message;
      if (!message) {
        return;
      }

      const role = typeof message.author?.role === "string" ? message.author.role : "unknown";
      const content = extractText(message.content);

      const sourceId = typeof message.id === "string" && message.id ? message.id : `${chatId}-${index}`;
      if (seen.has(sourceId)) {
        return;
      }
      seen.add(sourceId);

      messages.push({
        source_id: sourceId,
        role,
        content,
        timestamp: toNumberOrNull(message.create_time),
      });
    });

    messages.sort((a, b) => {
      const aTs = a.timestamp ?? Number.MAX_SAFE_INTEGER;
      const bTs = b.timestamp ?? Number.MAX_SAFE_INTEGER;

      if (aTs !== bTs) {
        return aTs - bTs;
      }

      return a.source_id.localeCompare(b.source_id);
    });

    return {
      chat: {
        id: chatId,
        title: normalizeTitle(data.title),
        created_at: toNumberOrNull(data.create_time),
      },
      messages,
    };
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) {
      return;
    }

    const data = event.data;
    if (!data || data.source !== "CHATGPT_ARCHIVER_CONTENT") {
      return;
    }

    if (data.type === "START_FULL_SYNC") {
      void syncAllConversations();
    }
  });

  window.fetch = async (...args) => {
    const requestUrl = toAbsoluteUrl(args[0]);
    const response = await originalFetch(...args);

    if (!requestUrl || !requestUrl.includes("/backend-api/")) {
      return response;
    }

    try {
      if (CONVERSATIONS_REGEX.test(requestUrl)) {
        const payload = await response.clone().json();
        const chats = normalizeConversations(payload);
        if (chats.length > 0) {
          emit("CHAT_SUMMARIES", { chats });
        }
      }

      const conversationMatch = requestUrl.match(CONVERSATION_REGEX);
      if (conversationMatch) {
        const payload = await response.clone().json();
        const detail = normalizeConversation(payload, conversationMatch[1]);
        if (detail && detail.chat && detail.chat.id) {
          emit("CHAT_DETAIL", detail);
        }
      }
    } catch (error) {
      console.debug("[ChatGPT Bridge] interception parse failed", error);
    }

    return response;
  };
})();
