(() => {
  const STORE_KEY = "radiant-ai-chats";
  const THEME_KEY = "samuel-portfolio-theme";
  const SEARCH_KEY = "radiant-ai-search";
  const MAX_SAVED_CHATS = 200;
  const SYNC_TOKEN_KEY = "radiant-ai-sync-token";
  const SYNC_STATE_KEY = "radiant-ai-sync-state";
  const DRIVE_KEY = "radiant-ai-drive";

  const $ = (sel) => document.querySelector(sel);
  const root = document.documentElement;
  const sidebar = $("#sidebar");
  const scrim = $(".scrim");
  const chatList = $(".chat-list");
  const thread = $("#thread");
  const empty = $("#empty");
  const messagesEl = $(".messages");
  const form = $("#composer");
  const input = $("#input");
  const sendBtn = $(".send");
  const titleEl = $(".chat-title");
  const themeToggle = $(".theme-toggle");
  const searchToggle = $("#search-toggle");
  const driveBtn = $("#drive-btn");
  const driveToggle = $("#drive-toggle");
  const modelPicker = $("#model-picker");
  const modelSelect = $("#model-select");

  /**
   * Saved chats. Each message is {role, content} plus optional `sources` on assistant replies.
   * @type {{id: string, title: string, updated: number, messages: {role: string, content: string, sources?: {title: string, url: string}[]}[]}[]}
   */
  let chats = load();
  let current = null; // active chat (null = new, unsaved chat)
  let controller = null; // AbortController for the in-flight request
  let failure = null; // {chat, text, userEl, errorEl} for the last failed message

  // ---------- storage ----------
  function load() {
    try {
      const data = JSON.parse(localStorage.getItem(STORE_KEY) || "[]");
      return Array.isArray(data) ? data : [];
    } catch {
      return [];
    }
  }

  function save() {
    try {
      chats = chats.filter((c) => c.messages.length);
      chats.sort((a, b) => b.updated - a.updated);
      chats = chats.slice(0, MAX_SAVED_CHATS);
      localStorage.setItem(STORE_KEY, JSON.stringify(chats));
    } catch {}
    scheduleSync();
  }

  // ---------- icons / theme / search toggle ----------
  const icons = () => window.lucide?.createIcons();

  function applyTheme(theme) {
    root.dataset.theme = theme;
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {}
    themeToggle.innerHTML = `<i data-lucide="${theme === "dark" ? "sun" : "moon"}"></i><span>${
      theme === "dark" ? "Light mode" : "Dark mode"
    }</span>`;
    document.querySelector('meta[name="theme-color"]').content = theme === "dark" ? "#14120f" : "#f3eee3";
    icons();
  }

  themeToggle.addEventListener("click", () => applyTheme(root.dataset.theme === "dark" ? "light" : "dark"));

  let searchOn = true;
  try {
    searchOn = localStorage.getItem(SEARCH_KEY) !== "off";
  } catch {}

  function applySearch(on) {
    searchOn = on;
    searchToggle.setAttribute("aria-pressed", String(on));
    applyModelNote();
    try {
      localStorage.setItem(SEARCH_KEY, on ? "on" : "off");
    } catch {}
  }

  searchToggle.addEventListener("click", () => applySearch(!searchOn));

  // ---------- model picker ----------
  /** @type {{provider: string, model: string, search: boolean} | null} null means Auto. */
  let selectedModel = null;
  const providerLabels = {};
  const shortModel = (id) => id.replace(/^[^/]+\//, "");

  function applyModelNote() {
    const limited = Boolean(selectedModel && !selectedModel.search);
    searchToggle.classList.toggle("unavailable", limited);
    const noTools = Boolean(selectedModel && !selectedModel.tools);
    driveToggle.classList.toggle("unavailable", noTools);
    driveToggle.title = noTools
      ? "This model can't use Google Drive. Pick Auto or an NVIDIA or Groq model."
      : "Let the AI use your Google Drive";
    searchToggle.title = limited
      ? "This model can't browse the web. Pick Auto or a model marked 'web' to search."
      : searchOn
        ? "Web search is on: the AI can look up current information"
        : "Web search is off";
  }

  async function loadModels() {
    try {
      const res = await fetch("/api/chat");
      if (!res.ok) return;
      const { providers } = await res.json();
      const total = (providers || []).reduce((n, p) => n + p.models.length, 0);
      if (total < 2) return;

      modelSelect.innerHTML = "";
      modelSelect.append(new Option("Auto (best available)", ""));
      for (const p of providers) {
        providerLabels[p.id] = p.label;
        for (const m of p.models) {
          const opt = new Option(`${p.label} · ${shortModel(m.id)}${m.search ? " · web" : ""}`, `${p.id}|${m.id}`);
          opt.dataset.search = m.search ? "1" : "";
          opt.dataset.tools = m.tools ? "1" : "";
          modelSelect.append(opt);
        }
      }

      let saved = "";
      try {
        saved = localStorage.getItem(MODEL_KEY) || "";
      } catch {}
      modelSelect.value = saved;
      if (modelSelect.value !== saved) modelSelect.value = ""; // that model is no longer available
      readModelSelect();
      modelPicker.hidden = false;
    } catch {
      // The picker is optional: without it the chat simply uses Auto.
    }
  }

  function readModelSelect() {
    const value = modelSelect.value;
    if (!value) {
      selectedModel = null;
    } else {
      const [provider, ...rest] = value.split("|");
      const opt = modelSelect.selectedOptions[0];
      selectedModel = { provider, model: rest.join("|"), search: Boolean(opt?.dataset.search), tools: Boolean(opt?.dataset.tools) };
    }
    try {
      localStorage.setItem(MODEL_KEY, value);
    } catch {}
    applyModelNote();
  }

  modelSelect.addEventListener("change", readModelSelect);

  // ---------- markdown ----------
  function renderMarkdown(text) {
    if (!window.marked || !window.DOMPurify) {
      const div = document.createElement("div");
      div.textContent = text;
      return div.innerHTML.replace(/\n/g, "<br>");
    }
    return window.DOMPurify.sanitize(window.marked.parse(text, { gfm: true, breaks: false }));
  }

  function decorate(container) {
    container.querySelectorAll("pre").forEach((pre) => {
      if (pre.querySelector(".copy-code")) return;
      const code = pre.querySelector("code");
      const lang = (code?.className.match(/language-([\w+-]+)/) || [])[1];
      if (lang) {
        const label = document.createElement("span");
        label.className = "code-label";
        label.textContent = lang;
        pre.prepend(label);
      }
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "copy-code";
      btn.innerHTML = '<i data-lucide="copy"></i><span>Copy</span>';
      btn.addEventListener("click", () => copy(code?.innerText ?? pre.innerText, btn));
      pre.append(btn);
    });
    container.querySelectorAll("a").forEach((a) => {
      a.target = "_blank";
      a.rel = "noopener noreferrer";
    });
    icons();
  }

  async function copy(text, btn) {
    try {
      await navigator.clipboard.writeText(text);
      const span = btn.querySelector("span");
      if (span) {
        const prev = span.textContent;
        span.textContent = "Copied!";
        setTimeout(() => (span.textContent = prev), 1500);
      }
      return true;
    } catch {
      return false;
    }
  }

  // ---------- rendering ----------
  function renderSidebar() {
    chatList.innerHTML = "";
    const saved = chats.filter((c) => c.messages.length);
    if (!saved.length) return;
    const label = document.createElement("div");
    label.className = "label";
    label.textContent = "Recent";
    chatList.append(label);

    for (const chat of saved) {
      const item = document.createElement("div");
      item.className = "chat-item" + (current?.id === chat.id ? " active" : "");

      const open = document.createElement("button");
      open.type = "button";
      open.className = "open";
      open.textContent = chat.title;
      open.title = chat.title;
      open.addEventListener("click", () => openChat(chat.id));

      const del = document.createElement("button");
      del.type = "button";
      del.className = "delete";
      del.setAttribute("aria-label", `Delete chat: ${chat.title}`);
      del.innerHTML = '<i data-lucide="trash-2"></i>';
      del.addEventListener("click", () => deleteChat(chat.id));

      item.append(open, del);
      chatList.append(item);
    }
    icons();
  }

  function userBubble(text) {
    const el = document.createElement("div");
    el.className = "msg user";
    el.textContent = text;
    thread.append(el);
    return el;
  }

  function assistantShell() {
    const el = document.createElement("div");
    el.className = "msg assistant";
    el.innerHTML =
      '<span class="brand-mark avatar">AI</span><div class="content" style="flex:1;min-width:0"><div class="body"></div></div>';
    thread.append(el);
    return el;
  }

  function setStatus(el, status) {
    const label =
      status === "searching"
        ? "Searching the web…"
        : status === "drive"
          ? "Working in Google Drive…"
          : status === "reconnecting"
            ? "Reconnecting…"
            : "Thinking…";
    el.querySelector(".body").innerHTML =
      `<div class="status-line"><div class="typing" aria-hidden="true"><span></span><span></span><span></span></div><span>${label}</span></div>`;
  }

  function finishAssistant(el, message, { isLast = false } = {}) {
    const body = el.querySelector(".body");
    body.innerHTML = renderMarkdown(message.content);
    decorate(body);

    const content = el.querySelector(".content");
    content.querySelector(".sources")?.remove();
    content.querySelector(".msg-actions")?.remove();

    if (message.cards?.length) content.append(cardsEl(message.cards));
    if (message.sources?.length) content.append(sourcesEl(message.sources));

    const actions = document.createElement("div");
    actions.className = "msg-actions";
    actions.append(
      actionBtn("copy", "Copy response", async (btn) => {
        if (await copy(message.content, btn)) {
          btn.innerHTML = '<i data-lucide="check"></i>';
          icons();
          setTimeout(() => {
            btn.innerHTML = '<i data-lucide="copy"></i>';
            icons();
          }, 1500);
        }
      })
    );
    if (isLast) actions.append(actionBtn("refresh-cw", "Regenerate response", () => regenerate()));
    if (message.model) {
      const note = document.createElement("span");
      note.className = "model-note";
      note.textContent = message.model;
      actions.append(note);
    }
    content.append(actions);
    icons();
  }

  function actionBtn(icon, label, onClick) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "icon-btn";
    btn.title = label;
    btn.setAttribute("aria-label", label);
    btn.innerHTML = `<i data-lucide="${icon}"></i>`;
    btn.addEventListener("click", () => onClick(btn));
    return btn;
  }

  const CARD_ICONS = { doc: "file-text", sheet: "table", slides: "presentation" };
  const CARD_LABELS = { doc: "Google Doc", sheet: "Google Sheet", slides: "Google Slides" };

  /** Links to Google files the assistant created or updated. */
  function cardsEl(cards) {
    const wrap = document.createElement("div");
    wrap.className = "cards";
    for (const c of cards) {
      if (!/^https:\/\/(docs|drive)\.google\.com\//.test(c.url || "")) continue;
      const a = document.createElement("a");
      a.className = "file-card";
      a.href = c.url;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      const icon = document.createElement("i");
      icon.dataset.lucide = CARD_ICONS[c.kind] || "file";
      const text = document.createElement("span");
      const title = document.createElement("strong");
      title.textContent = String(c.title || "Untitled").slice(0, 120);
      const kind = document.createElement("small");
      kind.textContent = `${CARD_LABELS[c.kind] || "File"} · Open in Google Drive`;
      text.append(title, kind);
      a.append(icon, text);
      wrap.append(a);
    }
    return wrap;
  }

  function sourcesEl(sources) {
    const wrap = document.createElement("div");
    wrap.className = "sources";
    const label = document.createElement("div");
    label.className = "sources-label";
    label.textContent = "Sources";
    wrap.append(label);

    for (const s of sources) {
      let host = "";
      try {
        const u = new URL(s.url);
        if (u.protocol !== "http:" && u.protocol !== "https:") continue;
        host = u.hostname.replace(/^www\./, "");
        // Gemini sources link through a Google redirect but carry the real site name as the title.
        if (/(^|\.)vertexaisearch\.cloud\.google\.com$/.test(u.hostname) && /^[\w-]+(\.[\w-]+)+$/.test(s.title || "")) {
          host = s.title.replace(/^www\./, "");
        }
      } catch {
        continue;
      }
      const a = document.createElement("a");
      a.className = "source-chip";
      a.href = s.url;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.title = s.title || s.url;

      const icon = document.createElement("img");
      icon.src = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=32`;
      icon.alt = "";
      icon.loading = "lazy";
      icon.onerror = () => icon.remove();

      const text = document.createElement("span");
      text.textContent = s.title && s.title !== s.url ? s.title : host;

      a.append(icon, text);
      wrap.append(a);
    }
    return wrap;
  }

  function renderThread() {
    clearFailure();
    thread.innerHTML = "";
    const msgs = current?.messages ?? [];
    empty.hidden = msgs.length > 0;
    const lastIndex = msgs.length - 1;
    msgs.forEach((m, i) => {
      if (m.role === "user") userBubble(m.content);
      else finishAssistant(assistantShell(), m, { isLast: i === lastIndex });
    });
    titleEl.textContent = current?.title ?? "New chat";
    document.title = current ? `${current.title} | Radiant AI` : "Radiant AI | Samuel Maclar";
    scrollToBottom(true);
  }

  function nearBottom() {
    return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 140;
  }

  function scrollToBottom(force = false) {
    if (force || nearBottom()) messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  // ---------- chat management ----------
  function newChat() {
    stop();
    current = null;
    renderThread();
    renderSidebar();
    closeSidebar();
    input.focus();
  }

  function openChat(id) {
    stop();
    current = chats.find((c) => c.id === id) ?? null;
    renderThread();
    renderSidebar();
    closeSidebar();
  }

  function deleteChat(id) {
    if (!confirm("Delete this chat?")) return;
    chats = chats.filter((c) => c.id !== id);
    syncState.deleted[id] = Date.now();
    delete syncState.pushed[id];
    saveSyncState();
    save();
    if (current?.id === id) newChat();
    else renderSidebar();
  }

  function makeTitle(text) {
    const clean = text.replace(/\s+/g, " ").trim();
    return clean.length > 48 ? clean.slice(0, 45) + "…" : clean;
  }

  // ---------- failures ----------
  function clearFailure({ removeUser = false } = {}) {
    if (!failure) return;
    failure.errorEl.remove();
    if (removeUser) failure.userEl.remove();
    failure = null;
  }

  function showFailure(chat, text, userEl, message) {
    const card = document.createElement("div");
    card.className = "error-card";
    card.setAttribute("role", "alert");
    const p = document.createElement("p");
    p.textContent = message;
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "retry-btn";
    retry.innerHTML = '<i data-lucide="rotate-ccw"></i><span>Retry</span>';
    retry.addEventListener("click", () => {
      clearFailure({ removeUser: true });
      send(text);
    });
    card.append(p, retry);
    thread.append(card);
    failure = { chat, text, userEl, errorEl: card };
    icons();
    scrollToBottom(true);
  }

  // ---------- sending ----------
  function setBusy(busy) {
    sendBtn.setAttribute("aria-label", busy ? "Stop generating" : "Send message");
    sendBtn.innerHTML = `<i data-lucide="${busy ? "square" : "arrow-up"}"></i>`;
    sendBtn.disabled = busy ? false : !input.value.trim();
    icons();
  }

  function updateSendState() {
    if (!controller) sendBtn.disabled = !input.value.trim();
  }

  function stop() {
    controller?.abort();
  }

  function friendlyNetworkError(err) {
    if (!navigator.onLine) return "You appear to be offline. Check your internet connection and try again.";
    if (err?.name === "TypeError") return "Couldn't reach the server. Check your connection and try again.";
    return err?.message || "Something went wrong. Please try again.";
  }

  const MAX_ATTEMPTS = 3;
  const MODEL_KEY = "radiant-ai-model";
  const STALL_TIMEOUT_MS = 45_000; // the server pings every ~8s, so this much silence means a dead connection
  const RETRYABLE_STATUS = new Set([502, 503, 504]);

  const sleep = (ms, signal) =>
    new Promise((resolve, reject) => {
      const t = setTimeout(resolve, ms);
      signal?.addEventListener("abort", () => {
        clearTimeout(t);
        reject(new DOMException("Aborted", "AbortError"));
      }, { once: true });
    });

  /** If the browser is offline, wait (up to `ms`) for the connection to come back. */
  function waitForOnline(ms, signal) {
    if (navigator.onLine) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const done = () => {
        clearTimeout(t);
        window.removeEventListener("online", done);
        resolve();
      };
      const t = setTimeout(done, ms);
      window.addEventListener("online", done);
      signal?.addEventListener("abort", () => {
        clearTimeout(t);
        window.removeEventListener("online", done);
        reject(new DOMException("Aborted", "AbortError"));
      }, { once: true });
    });
  }

  /** A failure that is worth trying again (connection problems, gateway errors). */
  class RetryableError extends Error {}

  /** Send a new user message. */
  function send(text) {
    text = text.trim();
    if (!text || controller) return;

    // A new message replaces any failed one that was never answered.
    clearFailure({ removeUser: true });

    if (!current) {
      current = {
        id: crypto.randomUUID?.() ?? String(Date.now()),
        title: makeTitle(text),
        updated: Date.now(),
        messages: [],
      };
      chats.unshift(current);
    }

    // Drop the "Regenerate" button from the previous answer.
    thread.querySelectorAll('.msg.assistant .msg-actions [aria-label="Regenerate response"]').forEach((b) => b.remove());

    current.messages.push({ role: "user", content: text });
    current.updated = Date.now();
    empty.hidden = true;
    titleEl.textContent = current.title;
    document.title = `${current.title} | Radiant AI`;
    const userEl = userBubble(text);

    input.value = "";
    autosize();
    save();
    renderSidebar();
    reply(current, text, userEl);
  }

  /** Re-run the last answer. */
  function regenerate() {
    if (controller || !current) return;
    const msgs = current.messages;
    if (msgs.at(-1)?.role !== "assistant") return;
    msgs.pop();
    [...thread.querySelectorAll(".msg.assistant")].at(-1)?.remove();
    const lastUser = msgs.at(-1);
    const userEls = thread.querySelectorAll(".msg.user");
    reply(current, lastUser.content, userEls[userEls.length - 1]);
  }

  /** Stream an assistant reply for a chat whose last message is from the user. */
  async function reply(chat, text, userEl) {
    const bubble = assistantShell();
    setStatus(bubble, "thinking");
    scrollToBottom(true);

    controller = new AbortController();
    setBusy(true);

    const body = bubble.querySelector(".body");
    let answer = "";
    let sources = [];
    let answeredBy = null;
    let cards = [];
    let streamError = null;
    let frame = 0;

    const paint = () => {
      frame = 0;
      body.innerHTML = renderMarkdown(answer);
      scrollToBottom();
    };

    const payload = JSON.stringify({
      messages: chat.messages.map(({ role, content }) => ({ role, content })),
      search: searchOn,
      ...(driveActive() ? { drive: true } : {}),
      ...(selectedModel ? { provider: selectedModel.provider, model: selectedModel.model } : {}),
    });

    const handle = (line) => {
      if (!line.trim()) return;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      if (event.type === "text") {
        answer += event.value;
        if (!frame) frame = requestAnimationFrame(paint);
      } else if (event.type === "status" && !answer) {
        setStatus(bubble, event.value);
      } else if (event.type === "sources" && Array.isArray(event.value)) {
        sources = event.value;
      } else if (event.type === "card" && event.value?.url) {
        cards.push(event.value);
      } else if (event.type === "model" && event.value?.model) {
        answeredBy = event.value;
      } else if (event.type === "error") {
        streamError = event.value;
      } else if (event.type === "debug") {
        console.debug("[Radiant AI]", event.value);
      }
    };

    /** One full attempt: send the request and read the streamed answer. */
    const attemptOnce = async () => {
      const attemptCtrl = new AbortController();
      const stopAttempt = () => attemptCtrl.abort();
      controller.signal.addEventListener("abort", stopAttempt, { once: true });
      let stalled = false;
      let watchdog = 0;
      const arm = () => {
        clearTimeout(watchdog);
        watchdog = setTimeout(() => {
          stalled = true;
          attemptCtrl.abort();
        }, STALL_TIMEOUT_MS);
      };

      try {
        arm();
        let res;
        try {
          res = await fetch("/api/chat", {
            method: "POST",
            headers: { "content-type": "application/json", ...(driveActive() ? { authorization: `Bearer ${syncToken}` } : {}) },
            body: payload,
            signal: attemptCtrl.signal,
          });
        } catch (err) {
          if (controller.signal.aborted) throw err;
          throw new RetryableError(friendlyNetworkError(err));
        }

        if (!res.ok || !res.body) {
          let msg =
            res.status === 429
              ? "Too many requests. Please wait a moment and try again."
              : `Something went wrong (error ${res.status}). Please try again.`;
          try {
            msg = (await res.json()).error || msg;
          } catch {}
          if (RETRYABLE_STATUS.has(res.status)) throw new RetryableError(msg);
          throw new Error(msg);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            arm();
            buffer += decoder.decode(value, { stream: true });
            let nl;
            while ((nl = buffer.indexOf("\n")) !== -1) {
              handle(buffer.slice(0, nl));
              buffer = buffer.slice(nl + 1);
            }
          }
          handle(buffer + decoder.decode());
        } catch (err) {
          if (controller.signal.aborted) throw err;
          throw new RetryableError(
            stalled ? "The AI took too long to respond. Please try again." : "The connection dropped. Please try again."
          );
        }
      } finally {
        clearTimeout(watchdog);
        controller.signal.removeEventListener("abort", stopAttempt);
      }
    };

    try {
      for (let attempt = 1; ; attempt++) {
        try {
          await attemptOnce();
          break;
        } catch (err) {
          // Only start over if nothing has been shown yet; otherwise keep the partial answer.
          if (!(err instanceof RetryableError) || answer || attempt >= MAX_ATTEMPTS) throw err;
          setStatus(bubble, "reconnecting");
          await waitForOnline(20_000, controller.signal);
          await sleep(attempt === 1 ? 1000 : 2500, controller.signal);
          setStatus(bubble, "thinking");
        }
      }
    } catch (err) {
      if (err.name !== "AbortError") streamError = err.message || friendlyNetworkError(err);
    } finally {
      if (frame) cancelAnimationFrame(frame);
      controller = null;
      setBusy(false);
    }

    if (answer.trim()) {
      if (streamError) answer += `\n\n_(${streamError})_`;
      const message = { role: "assistant", content: answer };
      if (sources.length) message.sources = sources;
      if (cards.length) message.cards = cards;
      if (answeredBy) {
        const name = `${providerLabels[answeredBy.provider] || answeredBy.provider} · ${shortModel(answeredBy.model)}`;
        const fellBack = selectedModel && (selectedModel.provider !== answeredBy.provider || selectedModel.model !== answeredBy.model);
        message.model = fellBack ? `${name} (fallback)` : name;
      }
      chat.messages.push(message);
      chat.updated = Date.now();
      if (current === chat) finishAssistant(bubble, message, { isLast: true });
    } else {
      // No answer: take the unanswered message back out of the history and offer a retry.
      bubble.remove();
      if (chat.messages.at(-1)?.role === "user") chat.messages.pop();
      if (current === chat) {
        if (streamError) showFailure(chat, text, userEl, streamError);
        else {
          // Stopped before anything arrived: put the text back so it can be edited and resent.
          userEl?.remove();
          input.value = text;
          autosize();
        }
      }
      if (!chat.messages.length && current === chat) {
        current = null;
        if (!thread.children.length) empty.hidden = false;
      }
    }

    save();
    renderSidebar();
    scrollToBottom();
  }

  // ---------- composer ----------
  function autosize() {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 200) + "px";
    updateSendState();
  }

  input.addEventListener("input", autosize);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing && window.matchMedia("(hover: hover)").matches) {
      e.preventDefault();
      form.requestSubmit();
    }
  });

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (controller) stop();
    else send(input.value);
  });

  document.querySelectorAll(".suggestions button").forEach((btn) => btn.addEventListener("click", () => send(btn.textContent)));

  // ---------- sidebar (mobile) ----------
  const openBtn = $(".sidebar-open");
  function openSidebar() {
    sidebar.classList.add("is-open");
    scrim.hidden = false;
    openBtn.setAttribute("aria-expanded", "true");
  }
  function closeSidebar() {
    sidebar.classList.remove("is-open");
    scrim.hidden = true;
    openBtn.setAttribute("aria-expanded", "false");
  }
  openBtn.addEventListener("click", openSidebar);
  $(".sidebar-close").addEventListener("click", closeSidebar);
  scrim.addEventListener("click", closeSidebar);
  document.querySelectorAll(".new-chat, .new-chat-mini").forEach((b) => b.addEventListener("click", newChat));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeSidebar();
  });

  // ---------- sync across devices (owner only) ----------
  const syncBtn = $("#sync-btn");
  const syncDialog = $("#sync-dialog");
  const syncForm = $("#sync-form");
  const syncPassword = $("#sync-password");
  const syncError = $("#sync-error");
  const SYNC_INTERVAL_MS = 60_000;

  let syncToken = null;
  try {
    syncToken = localStorage.getItem(SYNC_TOKEN_KEY);
  } catch {}

  /** pushed: {chatId: updated} last version the server has; deleted: {chatId: time} not yet sent. */
  let syncState = { pushed: {}, deleted: {} };
  try {
    syncState = { pushed: {}, deleted: {}, ...JSON.parse(localStorage.getItem(SYNC_STATE_KEY) || "{}") };
  } catch {}

  function saveSyncState() {
    try {
      localStorage.setItem(SYNC_STATE_KEY, JSON.stringify(syncState));
    } catch {}
  }

  let syncTimer = 0;
  let syncing = null;
  let syncAgain = false;
  let syncProblem = "";

  function renderSyncButton() {
    const on = Boolean(syncToken);
    syncBtn.classList.toggle("is-on", on);
    const icon = !on ? "cloud-off" : syncProblem ? "cloud-alert" : syncing ? "refresh-cw" : "cloud";
    const text = !on ? "Sync chats" : syncProblem ? "Sync paused" : syncing ? "Syncing…" : "Synced · Sign out";
    syncBtn.innerHTML = `<i data-lucide="${icon}"></i><span>${text}</span>`;
    syncBtn.title = !on
      ? "Sign in to sync your chats across devices"
      : syncProblem
        ? `${syncProblem} Click to sign out.`
        : "Your chats sync across devices. Click to sign out on this device.";
    icons();
  }

  function scheduleSync(delay = 1500) {
    if (!syncToken) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => syncNow(), delay);
  }

  async function syncFetch(method, body) {
    const res = await fetch("/api/sync", {
      method,
      headers: { authorization: `Bearer ${syncToken}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) {
      signOut("Your sync sign-in expired. Please sign in again.");
      throw new Error("signed out");
    }
    if (!res.ok) throw new Error(data.error || `Sync failed (${res.status}).`);
    return data;
  }

  /** Push local changes, then pull and merge everything from the server. */
  async function syncNow() {
    if (!syncToken) return;
    if (syncing) {
      syncAgain = true;
      return syncing;
    }
    syncing = (async () => {
      renderSyncButton();
      try {
        // 1. Push: chats changed since the server last saw them, and deletions.
        const upsert = chats.filter((c) => c.messages.length && (syncState.pushed[c.id] || 0) < c.updated);
        const del = Object.entries(syncState.deleted).map(([id, at]) => ({ id, at }));
        for (let i = 0; i < Math.max(upsert.length, del.length); i += 50) {
          const batch = { upsert: upsert.slice(i, i + 50), delete: del.slice(i, i + 50) };
          await syncFetch("POST", batch);
          batch.upsert.forEach((c) => (syncState.pushed[c.id] = c.updated));
          batch.delete.forEach((d) => delete syncState.deleted[d.id]);
          saveSyncState();
        }

        // 2. Pull and merge: the newest version of each chat wins.
        const remote = await syncFetch("GET");
        mergeRemote(remote);
        syncProblem = "";
      } catch (err) {
        if (syncToken) syncProblem = navigator.onLine ? err.message : "You're offline. Chats will sync when you reconnect.";
      } finally {
        syncing = null;
        renderSyncButton();
        if (syncAgain) {
          syncAgain = false;
          scheduleSync(300);
        }
      }
    })();
    return syncing;
  }

  function mergeRemote({ chats: remoteChats = [], deleted = {} }) {
    let changed = false;
    let currentChanged = false;
    const busyChat = controller ? current : null; // never replace a chat while it's answering
    const byId = new Map(chats.map((c) => [c.id, c]));

    for (const r of remoteChats) {
      if (!r?.id || r === busyChat) continue;
      const local = byId.get(r.id);
      if (local === busyChat && local) continue;
      if (!local) {
        if (syncState.deleted[r.id]) continue;
        chats.push(r);
        byId.set(r.id, r);
        changed = true;
      } else if (r.updated > local.updated) {
        Object.assign(local, r);
        changed = true;
        if (local === current) currentChanged = true;
      }
      syncState.pushed[r.id] = Math.max(syncState.pushed[r.id] || 0, r.updated);
    }

    for (const [id, at] of Object.entries(deleted)) {
      const local = byId.get(id);
      if (!local || local === busyChat || local.updated > at) continue;
      chats = chats.filter((c) => c.id !== id);
      delete syncState.pushed[id];
      changed = true;
      if (current?.id === id) {
        current = null;
        currentChanged = true;
      }
    }

    saveSyncState();
    if (!changed) return;
    try {
      chats.sort((a, b) => b.updated - a.updated);
      localStorage.setItem(STORE_KEY, JSON.stringify(chats.slice(0, MAX_SAVED_CHATS)));
    } catch {}
    renderSidebar();
    if (currentChanged && !controller) renderThread();
  }

  function signOut(message = "") {
    syncToken = null;
    syncProblem = "";
    try {
      localStorage.removeItem(SYNC_TOKEN_KEY);
    } catch {}
    renderSyncButton();
    refreshDrive();
    if (message) alert(message);
  }

  syncBtn.addEventListener("click", () => {
    if (syncToken) {
      if (confirm("Stop syncing on this device? Your chats stay saved here and on your other devices.")) signOut();
      return;
    }
    syncError.hidden = true;
    syncPassword.value = "";
    closeSidebar();
    syncDialog.showModal();
    syncPassword.focus();
  });

  $("#sync-cancel").addEventListener("click", () => syncDialog.close());

  syncForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const submit = $("#sync-submit");
    submit.disabled = true;
    syncError.hidden = true;
    try {
      const res = await fetch("/api/sync?action=login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: syncPassword.value }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.token) throw new Error(data.error || `Sign-in failed (${res.status}).`);
      syncToken = data.token;
      try {
        localStorage.setItem(SYNC_TOKEN_KEY, syncToken);
      } catch {}
      syncState.pushed = {}; // upload everything on this device the first time
      saveSyncState();
      syncDialog.close();
      syncNow();
      refreshDrive();
    } catch (err) {
      syncError.textContent = navigator.onLine ? err.message : "You're offline.";
      syncError.hidden = false;
    } finally {
      submit.disabled = false;
    }
  });

  // Keep devices in step: sync when the page is opened/focused, comes back online, and every minute.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") scheduleSync(200);
  });
  window.addEventListener("online", () => scheduleSync(200));
  setInterval(() => {
    if (document.visibilityState === "visible") syncNow();
  }, SYNC_INTERVAL_MS);

  // ---------- Google Drive (owner only) ----------
  let drive = { configured: false, connected: false, email: "" };
  let driveOn = true;
  try {
    driveOn = localStorage.getItem(DRIVE_KEY) !== "off";
  } catch {}

  /** Drive tools are only used when signed in as the owner, connected, and switched on. */
  function driveActive() {
    return Boolean(syncToken && drive.connected && driveOn);
  }

  function renderDrive() {
    const signedIn = Boolean(syncToken);
    driveBtn.hidden = !(signedIn && drive.configured);
    driveToggle.hidden = !(signedIn && drive.connected);
    driveToggle.setAttribute("aria-pressed", String(driveOn));
    driveBtn.classList.toggle("is-on", drive.connected);
    driveBtn.innerHTML = `<i data-lucide="hard-drive"></i><span>${
      drive.connected ? `Drive connected${drive.email ? ` · ${drive.email}` : ""}` : "Connect Google Drive"
    }</span>`;
    driveBtn.title = drive.connected ? "Click to disconnect Google Drive" : "Let the AI use your Google Drive (owner only)";
    icons();
  }

  async function driveApi(action, method = "GET") {
    const res = await fetch(`/api/google?action=${action}`, { method, headers: { authorization: `Bearer ${syncToken}` } });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) throw new Error("Please sign in again.");
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
    return data;
  }

  async function refreshDrive() {
    if (!syncToken) {
      drive = { configured: false, connected: false, email: "" };
      return renderDrive();
    }
    try {
      drive = await driveApi("status");
    } catch {
      drive = { configured: false, connected: false, email: "" };
    }
    renderDrive();
  }

  driveBtn.addEventListener("click", async () => {
    try {
      if (!drive.connected) {
        const { url } = await driveApi("connect", "POST");
        location.href = url;
      } else if (confirm("Disconnect Google Drive? The assistant will no longer be able to use your files.")) {
        drive = await driveApi("disconnect", "POST");
        renderDrive();
      }
    } catch (err) {
      flash(err.message, true);
    }
  });

  driveToggle.addEventListener("click", () => {
    driveOn = !driveOn;
    try {
      localStorage.setItem(DRIVE_KEY, driveOn ? "on" : "off");
    } catch {}
    renderDrive();
  });

  function flash(message, isError = false) {
    const el = document.createElement("div");
    el.className = `toast${isError ? " error" : ""}`;
    el.setAttribute("role", "status");
    el.textContent = message;
    document.body.append(el);
    setTimeout(() => el.remove(), 6000);
  }

  // Coming back from Google's consent screen.
  const returned = new URLSearchParams(location.search);
  if (returned.has("google")) {
    flash(returned.get("google") === "connected" ? "Google Drive connected." : `Couldn't connect Google Drive. ${returned.get("reason") || ""}`, returned.get("google") !== "connected");
    history.replaceState(null, "", location.pathname);
  }

  // ---------- init ----------
  applyTheme(root.dataset.theme === "light" ? "light" : "dark");
  applySearch(searchOn);
  loadModels();
  renderSidebar();
  renderThread();
  autosize();
  renderSyncButton();
  refreshDrive();
  scheduleSync(300);
  input.focus();
})();
