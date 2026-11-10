(() => {
  const STORE_KEY = "radiant-ai-chats";
  const THEME_KEY = "samuel-portfolio-theme";
  const SEARCH_KEY = "radiant-ai-search";
  const MAX_SAVED_CHATS = 50;

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
    searchToggle.title = on ? "Web search is on: the AI can look up current information" : "Web search is off";
    try {
      localStorage.setItem(SEARCH_KEY, on ? "on" : "off");
    } catch {}
  }

  searchToggle.addEventListener("click", () => applySearch(!searchOn));

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
      status === "searching" ? "Searching the web…" : status === "reconnecting" ? "Reconnecting…" : "Thinking…";
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
            headers: { "content-type": "application/json" },
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

  // ---------- init ----------
  applyTheme(root.dataset.theme === "light" ? "light" : "dark");
  applySearch(searchOn);
  renderSidebar();
  renderThread();
  autosize();
  input.focus();
})();
