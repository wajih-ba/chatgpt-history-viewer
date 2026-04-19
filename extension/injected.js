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
  const DETAIL_REQUEST_TIMEOUT_MS = 12000;
  const LIST_REQUEST_TIMEOUT_MS = 12000;
  const PAGE_DELAY_MS = 450;
  const MAX_PAGES = 500;
  const DETAIL_MAX_RETRIES = 3;
  const LIST_MODES = [
    { label: "active", archived: false },
    { label: "archived", archived: true },
  ];
  const AUTO_SYNC_STORAGE_KEY = "__chatgpt_archiver_last_auto_sync_ms__";
  const AUTO_SYNC_MIN_INTERVAL_MS = 60 * 60 * 1000;
  const AUTO_SYNC_DELAY_MS = 1800;
  const DEEP_SYNC_STATE_KEY = "__chatgpt_archiver_deep_sync_state__";
  const DEEP_CAPTURE_DELAY_MS = 700;
  const DISCOVERED_CHAT_IDS_KEY = "__chatgpt_archiver_discovered_chat_ids__";
  const DISCOVERED_CHAT_META_KEY = "__chatgpt_archiver_discovered_chat_meta__";
  const HISTORY_SCROLL_DELAY_MS = 650;
  const HISTORY_SCROLL_MAX_ROUNDS = 160;
  const HISTORY_SCROLL_STALE_ROUNDS = 8;

  let fullSyncInProgress = false;
  let discoveredChatIdsCache = null;
  let discoveredChatMetaCache = null;
  const emittedSummarySignatureById = new Map();

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

  function isPlaceholderTitle(title) {
    if (typeof title !== "string") {
      return true;
    }

    const normalized = title.trim().toLowerCase();
    return !normalized || normalized === "untitled chat";
  }

  function chooseBestTitle(candidateTitle, fallbackTitle) {
    if (!isPlaceholderTitle(candidateTitle)) {
      return candidateTitle.trim();
    }

    if (!isPlaceholderTitle(fallbackTitle)) {
      return fallbackTitle.trim();
    }

    return "Untitled chat";
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

  async function fetchWithTimeout(url, init, timeoutMs) {
    const requestInit = init && typeof init === "object" ? { ...init } : {};
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => {
      controller.abort();
    }, timeoutMs);

    requestInit.signal = controller.signal;

    try {
      return await window.fetch(url, requestInit);
    } catch (error) {
      if (error && typeof error === "object" && error.name === "AbortError") {
        throw new Error(`Request timed out after ${timeoutMs}ms`);
      }
      throw error;
    } finally {
      window.clearTimeout(timeoutId);
    }
  }

  async function fetchConversationDetailWithRetries(chatId) {
    for (let attempt = 1; attempt <= DETAIL_MAX_RETRIES; attempt += 1) {
      try {
        const detailResponse = await fetchWithTimeout(
          `/backend-api/conversation/${encodeURIComponent(chatId)}`,
          {
            credentials: "include",
          },
          DETAIL_REQUEST_TIMEOUT_MS,
        );

        if (detailResponse.ok) {
          return true;
        }
      } catch (_error) {
        // Retry below.
      }

      if (attempt < DETAIL_MAX_RETRIES) {
        await sleep(DETAIL_DELAY_MS * attempt);
      }
    }

    return false;
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

  function buildConversationsUrl(offset, archived) {
    const params = new URLSearchParams();
    params.set("offset", String(offset));
    params.set("limit", String(LIST_LIMIT));
    params.set("order", LIST_ORDER);

    if (archived) {
      params.set("is_archived", "true");
    }

    return `/backend-api/conversations?${params.toString()}`;
  }

  function shouldStartAutoSync() {
    try {
      const now = Date.now();
      const raw = window.localStorage.getItem(AUTO_SYNC_STORAGE_KEY);
      const last = raw ? Number(raw) : 0;

      if (Number.isFinite(last) && now - last < AUTO_SYNC_MIN_INTERVAL_MS) {
        return false;
      }

      window.localStorage.setItem(AUTO_SYNC_STORAGE_KEY, String(now));
      return true;
    } catch (_error) {
      return false;
    }
  }

  function scheduleAutoSync() {
    if (!shouldStartAutoSync()) {
      return;
    }

    window.setTimeout(() => {
      void syncAllConversations({ trigger: "auto" });
    }, AUTO_SYNC_DELAY_MS);
  }

  function loadDiscoveredChatIds() {
    if (Array.isArray(discoveredChatIdsCache)) {
      return [...discoveredChatIdsCache];
    }

    try {
      const raw = window.localStorage.getItem(DISCOVERED_CHAT_IDS_KEY);
      if (!raw) {
        discoveredChatIdsCache = [];
        return [];
      }

      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        discoveredChatIdsCache = [];
        return [];
      }

      discoveredChatIdsCache = parsed.filter((value) => typeof value === "string" && value);
      return [...discoveredChatIdsCache];
    } catch (_error) {
      discoveredChatIdsCache = [];
      return [];
    }
  }

  function saveDiscoveredChatIds(chatIds) {
    discoveredChatIdsCache = [...chatIds];

    try {
      window.localStorage.setItem(DISCOVERED_CHAT_IDS_KEY, JSON.stringify(chatIds));
    } catch (_error) {
      // Ignore storage write issues.
    }
  }

  function loadDiscoveredChatMeta() {
    if (discoveredChatMetaCache && typeof discoveredChatMetaCache === "object") {
      return { ...discoveredChatMetaCache };
    }

    try {
      const raw = window.localStorage.getItem(DISCOVERED_CHAT_META_KEY);
      if (!raw) {
        discoveredChatMetaCache = {};
        return {};
      }

      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        discoveredChatMetaCache = {};
        return {};
      }

      const normalized = {};

      for (const [chatId, entry] of Object.entries(parsed)) {
        if (typeof chatId !== "string" || !chatId) {
          continue;
        }

        const record = entry && typeof entry === "object" ? entry : {};
        normalized[chatId] = {
          title: chooseBestTitle(record.title, ""),
          created_at: toNumberOrNull(record.created_at),
        };
      }

      discoveredChatMetaCache = normalized;
      return { ...normalized };
    } catch (_error) {
      discoveredChatMetaCache = {};
      return {};
    }
  }

  function saveDiscoveredChatMeta(chatMeta) {
    discoveredChatMetaCache = { ...chatMeta };

    try {
      window.localStorage.setItem(DISCOVERED_CHAT_META_KEY, JSON.stringify(chatMeta));
    } catch (_error) {
      // Ignore storage write issues.
    }
  }

  function getDiscoveredChatCount() {
    const knownIds = new Set(loadDiscoveredChatIds());
    const knownMeta = loadDiscoveredChatMeta();

    for (const chatId of Object.keys(knownMeta)) {
      if (chatId) {
        knownIds.add(chatId);
      }
    }

    return knownIds.size;
  }

  function resolveChatSummary(chatId, title, createdAt) {
    const knownMeta = loadDiscoveredChatMeta();
    const cached = knownMeta[chatId] || null;

    return {
      id: chatId,
      title: chooseBestTitle(title, cached?.title),
      created_at: toNumberOrNull(createdAt) ?? toNumberOrNull(cached?.created_at),
    };
  }

  function rememberDiscoveredChats(chats) {
    if (!Array.isArray(chats) || chats.length === 0) {
      return [];
    }

    const existing = loadDiscoveredChatIds();
    const known = new Set(existing);
    const knownMeta = loadDiscoveredChatMeta();
    let idsChanged = false;
    let metaChanged = false;
    const remembered = [];

    for (const chat of chats) {
      const chatId = chat && typeof chat.id === "string" ? chat.id : "";
      if (!chatId) {
        continue;
      }

      const previous = knownMeta[chatId] || null;
      const summary = {
        id: chatId,
        title: chooseBestTitle(chat.title, previous?.title),
        created_at: toNumberOrNull(chat.created_at) ?? toNumberOrNull(previous?.created_at),
      };
      const previousTitle = previous && typeof previous.title === "string" ? previous.title : "";
      const previousCreatedAt = previous ? toNumberOrNull(previous.created_at) : null;

      if (
        !previous ||
        previousTitle !== summary.title ||
        previousCreatedAt !== summary.created_at
      ) {
        knownMeta[chatId] = {
          title: summary.title,
          created_at: summary.created_at,
        };
        metaChanged = true;
      }

      remembered.push(summary);

      if (known.has(chatId)) {
        continue;
      }

      known.add(chatId);
      existing.push(chatId);
      idsChanged = true;
    }

    if (idsChanged) {
      saveDiscoveredChatIds(existing);
    }

    if (metaChanged) {
      saveDiscoveredChatMeta(knownMeta);
    }

    return remembered;
  }

  function emitChatSummaries(chats) {
    if (!Array.isArray(chats) || chats.length === 0) {
      return;
    }

    const deduped = new Map();
    for (const chat of chats) {
      const chatId = chat && typeof chat.id === "string" ? chat.id : "";
      if (!chatId) {
        continue;
      }

      const summary = resolveChatSummary(chatId, chat.title, chat.created_at);
      deduped.set(chatId, summary);
    }

    const updates = [];
    for (const chat of deduped.values()) {
      const signature = `${chat.title}|${chat.created_at ?? "none"}`;
      if (emittedSummarySignatureById.get(chat.id) === signature) {
        continue;
      }

      emittedSummarySignatureById.set(chat.id, signature);
      updates.push(chat);
    }

    if (updates.length > 0) {
      emit("CHAT_SUMMARIES", { chats: updates });
    }
  }

  function parseChatIdFromHref(href) {
    if (typeof href !== "string" || !href) {
      return "";
    }

    try {
      const url = new URL(href, window.location.origin);
      const match = url.pathname.match(/^\/c\/([^/?#]+)/);
      return match ? decodeURIComponent(match[1]) : "";
    } catch (_error) {
      return "";
    }
  }

  function extractHistoryTitleFromAnchor(anchor) {
    const ariaLabel = anchor.getAttribute("aria-label");
    if (!isPlaceholderTitle(ariaLabel)) {
      return ariaLabel.trim();
    }

    const rawText = typeof anchor.textContent === "string" ? anchor.textContent : "";
    const compactText = rawText.replace(/\s+/g, " ").trim();
    return chooseBestTitle(compactText, "");
  }

  function collectHistoryDomChats() {
    const anchors = Array.from(document.querySelectorAll('a[href*="/c/"]'));
    const chatsById = new Map();

    for (const anchor of anchors) {
      if (!(anchor instanceof HTMLAnchorElement)) {
        continue;
      }

      const chatId = parseChatIdFromHref(anchor.getAttribute("href") || "");
      if (!chatId) {
        continue;
      }

      const discoveredTitle = extractHistoryTitleFromAnchor(anchor);
      const existing = chatsById.get(chatId);
      if (!existing) {
        chatsById.set(chatId, {
          id: chatId,
          title: discoveredTitle,
          created_at: null,
        });
        continue;
      }

      existing.title = chooseBestTitle(discoveredTitle, existing.title);
    }

    return Array.from(chatsById.values());
  }

  function collectHistoryDomAndEmit() {
    const chats = collectHistoryDomChats();
    const remembered = rememberDiscoveredChats(chats);
    emitChatSummaries(remembered);
    return remembered.length;
  }

  function emitKnownDiscoveredSummaries() {
    const knownMeta = loadDiscoveredChatMeta();
    const summaries = Object.entries(knownMeta).map(([chatId, entry]) => ({
      id: chatId,
      title: chooseBestTitle(entry?.title, ""),
      created_at: toNumberOrNull(entry?.created_at),
    }));

    emitChatSummaries(summaries);
  }

  function mergeDiscoveredIntoQueue(orderedChatIds, seenChatIds) {
    const discovered = new Set(loadDiscoveredChatIds());
    const knownMeta = loadDiscoveredChatMeta();

    for (const chatId of Object.keys(knownMeta)) {
      if (chatId) {
        discovered.add(chatId);
      }
    }

    for (const chatId of discovered) {
      if (!chatId || seenChatIds.has(chatId)) {
        continue;
      }

      seenChatIds.add(chatId);
      orderedChatIds.push(chatId);
    }
  }

  function getHistoryScroller() {
    const selectorCandidates = [
      '[data-testid="history-scroll-container"]',
      '[data-testid="history"]',
      "nav",
      "aside",
    ];

    for (const selector of selectorCandidates) {
      const node = document.querySelector(selector);
      if (!(node instanceof HTMLElement)) {
        continue;
      }

      if (node.scrollHeight > node.clientHeight + 120) {
        return node;
      }
    }

    const allElements = Array.from(document.querySelectorAll("*"));
    let best = null;
    let bestScore = -1;

    for (const element of allElements) {
      if (!(element instanceof HTMLElement)) {
        continue;
      }

      if (element.scrollHeight <= element.clientHeight + 120) {
        continue;
      }

      const style = window.getComputedStyle(element);
      if (style.overflowY !== "auto" && style.overflowY !== "scroll") {
        continue;
      }

      const rect = element.getBoundingClientRect();
      if (rect.width < 120 || rect.height < 200) {
        continue;
      }

      if (rect.left > window.innerWidth * 0.5) {
        continue;
      }

      const score = (element.scrollHeight - element.clientHeight) + rect.height;
      if (score > bestScore) {
        best = element;
        bestScore = score;
      }
    }

    return best;
  }

  async function autoScrollHistory(trigger) {
    collectHistoryDomAndEmit();

    const scroller = getHistoryScroller();
    if (!scroller) {
      emit("SYNC_STATUS", {
        state: "progress",
        stage: "history_unavailable",
        trigger,
        discovered: getDiscoveredChatCount(),
      });
      return;
    }

    let staleRounds = 0;

    for (let round = 1; round <= HISTORY_SCROLL_MAX_ROUNDS; round += 1) {
      const before = getDiscoveredChatCount();

      scroller.scrollTop = scroller.scrollHeight;
      scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
      await sleep(HISTORY_SCROLL_DELAY_MS);

      collectHistoryDomAndEmit();

      const after = getDiscoveredChatCount();
      if (after <= before) {
        staleRounds += 1;
      } else {
        staleRounds = 0;
      }

      emit("SYNC_STATUS", {
        state: "progress",
        stage: "history_scroll",
        trigger,
        discovered: after,
        round,
      });

      if (staleRounds >= HISTORY_SCROLL_STALE_ROUNDS) {
        break;
      }
    }
  }

  function getCurrentChatIdFromPath() {
    const match = window.location.pathname.match(/^\/c\/([^/?#]+)/);
    return match ? decodeURIComponent(match[1]) : null;
  }

  function loadDeepState() {
    try {
      const raw = window.localStorage.getItem(DEEP_SYNC_STATE_KEY);
      if (!raw) {
        return null;
      }

      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") {
        return null;
      }

      const queue = Array.isArray(parsed.queue)
        ? parsed.queue.filter((item) => typeof item === "string" && item)
        : [];

      return {
        running: Boolean(parsed.running),
        trigger: typeof parsed.trigger === "string" ? parsed.trigger : "manual",
        queue,
        total: typeof parsed.total === "number" ? parsed.total : queue.length,
        processed: typeof parsed.processed === "number" ? parsed.processed : 0,
        failed: typeof parsed.failed === "number" ? parsed.failed : 0,
      };
    } catch (_error) {
      return null;
    }
  }

  function saveDeepState(state) {
    try {
      window.localStorage.setItem(DEEP_SYNC_STATE_KEY, JSON.stringify(state));
    } catch (_error) {
      // Ignore storage write issues.
    }
  }

  function clearDeepState() {
    try {
      window.localStorage.removeItem(DEEP_SYNC_STATE_KEY);
    } catch (_error) {
      // Ignore storage cleanup issues.
    }
  }

  function navigateToChat(chatId) {
    const encodedId = encodeURIComponent(chatId);
    window.location.assign(`/c/${encodedId}`);
  }

  async function autoScrollConversation() {
    for (let i = 0; i < 4; i += 1) {
      window.scrollTo({ top: document.body.scrollHeight, behavior: "instant" });
      await sleep(220);
      window.scrollTo({ top: 0, behavior: "instant" });
      await sleep(300);
    }
  }

  async function resumeDeepSyncIfNeeded() {
    const state = loadDeepState();
    if (!state || !state.running) {
      return;
    }

    const nextChatId = state.queue.length > 0 ? state.queue[0] : null;
    if (!nextChatId) {
      emit("SYNC_STATUS", {
        state: "completed",
        trigger: state.trigger,
        processed: state.processed,
        failed: state.failed,
        scanned: state.total,
        total: state.total,
      });
      clearDeepState();
      return;
    }

    const currentChatId = getCurrentChatIdFromPath();
    if (currentChatId !== nextChatId) {
      emit("SYNC_STATUS", {
        state: "progress",
        stage: "navigating",
        trigger: state.trigger,
        target: nextChatId,
        processed: state.processed,
        failed: state.failed,
        total: state.total,
      });
      navigateToChat(nextChatId);
      return;
    }

    emit("SYNC_STATUS", {
      state: "progress",
      stage: "deep_capture",
      trigger: state.trigger,
      processed: state.processed,
      failed: state.failed,
      total: state.total,
      current: currentChatId,
    });

    const firstCapture = await fetchConversationDetailWithRetries(currentChatId);
    await autoScrollConversation();
    const secondCapture = await fetchConversationDetailWithRetries(currentChatId);

    if (firstCapture || secondCapture) {
      state.processed += 1;
    } else {
      state.failed += 1;
    }

    state.queue = state.queue.slice(1);
    saveDeepState(state);

    emit("SYNC_STATUS", {
      state: "progress",
      stage: "details",
      trigger: state.trigger,
      processed: state.processed,
      failed: state.failed,
      total: state.total,
      scanned: state.total,
    });

    if (state.queue.length === 0) {
      emit("SYNC_STATUS", {
        state: "completed",
        trigger: state.trigger,
        processed: state.processed,
        failed: state.failed,
        scanned: state.total,
        total: state.total,
      });
      clearDeepState();
      return;
    }

    await sleep(DEEP_CAPTURE_DELAY_MS);
    navigateToChat(state.queue[0]);
  }

  async function syncAllConversations(options = {}) {
    const trigger = typeof options.trigger === "string" ? options.trigger : "manual";
    const deep = options.deep !== false;

    if (fullSyncInProgress) {
      emit("SYNC_STATUS", {
        state: "already_running",
        trigger,
      });
      return;
    }

    if (deep) {
      clearDeepState();
    }

    fullSyncInProgress = true;

    let processed = 0;
    let failed = 0;
    let pageCount = 0;
    const seenChatIds = new Set();
    const orderedChatIds = [];

    emit("SYNC_STATUS", {
      state: "started",
      trigger,
    });

    try {
      collectHistoryDomAndEmit();
      emitKnownDiscoveredSummaries();

      if (deep) {
        await autoScrollHistory(trigger);
      }

      // Phase 1: page through every conversation ID for active and archived chats.
      for (const mode of LIST_MODES) {
        let offset = 0;
        let repeatedPages = 0;
        let modePageCount = 0;

        while (true) {
          pageCount += 1;
          modePageCount += 1;

          if (modePageCount > MAX_PAGES) {
            throw new Error(`Sync stopped after too many ${mode.label} pages. Try again.`);
          }

          const listResponse = await fetchWithTimeout(
            buildConversationsUrl(offset, mode.archived),
            {
              credentials: "include",
            },
            LIST_REQUEST_TIMEOUT_MS,
          );

          if (!listResponse.ok) {
            throw new Error(`Failed to fetch ${mode.label} conversation list (${listResponse.status})`);
          }

          const listPayload = await listResponse.json();
          const pageChats = normalizeConversations(listPayload);
          const rememberedPageChats = rememberDiscoveredChats(pageChats);
          emitChatSummaries(rememberedPageChats);

          const items = Array.isArray(listPayload?.items) ? listPayload.items : [];
          let pageNewChats = 0;

          if (pageChats.length === 0) {
            break;
          }

          for (const chat of rememberedPageChats) {
            const chatId = chat.id;
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
            mode: mode.label,
            discovered: orderedChatIds.length,
            page: pageCount,
            trigger,
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
      }

      collectHistoryDomAndEmit();

      if (deep) {
        await autoScrollHistory(trigger);
      }

      emitKnownDiscoveredSummaries();

      mergeDiscoveredIntoQueue(orderedChatIds, seenChatIds);

      if (orderedChatIds.length === 0) {
        throw new Error("No conversations discovered. Open ChatGPT history and retry sync.");
      }

      // In deep mode, go straight into auto-open capture to avoid long blocking detail loops.
      if (deep && orderedChatIds.length > 0) {
        saveDeepState({
          running: true,
          trigger,
          queue: [...orderedChatIds],
          total: orderedChatIds.length,
          processed: 0,
          failed: 0,
        });

        emit("SYNC_STATUS", {
          state: "progress",
          stage: "navigating",
          trigger,
          total: orderedChatIds.length,
          processed: 0,
          failed: 0,
          target: orderedChatIds[0],
        });

        navigateToChat(orderedChatIds[0]);
        return;
      }

      // Phase 2 (non-deep mode): fetch details for all discovered conversations.
      for (let index = 0; index < orderedChatIds.length; index += 1) {
        const chatId = orderedChatIds[index];
        const success = await fetchConversationDetailWithRetries(chatId);

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
          index: index + 1,
          page: pageCount,
          trigger,
        });

        await sleep(DETAIL_DELAY_MS);
      }

      emit("SYNC_STATUS", {
        state: "completed",
        processed,
        failed,
        scanned: seenChatIds.size,
        total: orderedChatIds.length,
        trigger,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      emit("SYNC_STATUS", {
        state: "error",
        message,
        processed,
        failed,
        scanned: seenChatIds.size,
        trigger,
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

    const chatSummary = resolveChatSummary(chatId, data?.title, data?.create_time);

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
        title: chatSummary.title,
        created_at: chatSummary.created_at,
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
      const payload = data.payload && typeof data.payload === "object" ? data.payload : {};
      const trigger = typeof payload.trigger === "string" ? payload.trigger : "manual";
      const deep = payload.deep !== false;
      void syncAllConversations({ trigger, deep });
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
          const remembered = rememberDiscoveredChats(chats);
          emitChatSummaries(remembered);
        }
      }

      const conversationMatch = requestUrl.match(CONVERSATION_REGEX);
      if (conversationMatch) {
        const payload = await response.clone().json();
        const detail = normalizeConversation(payload, conversationMatch[1]);
        if (detail && detail.chat && detail.chat.id) {
          const remembered = rememberDiscoveredChats([detail.chat]);
          if (remembered.length > 0) {
            detail.chat = remembered[0];
            emitChatSummaries(remembered);
          }

          emit("CHAT_DETAIL", detail);
        }
      }
    } catch (error) {
      console.debug("[ChatGPT Bridge] interception parse failed", error);
    }

    return response;
  };

  window.setTimeout(() => {
    void resumeDeepSyncIfNeeded();
  }, 600);

  scheduleAutoSync();
})();
