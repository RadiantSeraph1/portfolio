(() => {
  const STORE_KEY = "radiant-ai-chats";
  const THEME_KEY = "samuel-portfolio-theme";
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

  /** @type {{id: string, title: string, updated: number, messages: {role: string, content: string}[]}[]} */
  let chats = load();
  let current = null; // active chat object (null = unsaved new chat)
  let controller = null; // AbortController for the in-flight request

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
      chats.sort((a, b) => b.updated - a.updated);
      chats = chats.slice(0, MAX_SAVED_CHATS);
      localStorage.setItem(STORE_KEY, JSON.stringify(chats));
    } catch {}
  }

  // ---------- icons / theme ----------
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

  // ---------- markdown ----------
  function renderMarkdown(text) {
    if (!window.marked || !window.DOMPurify) {
      const div = document.createElement("div");
      div.textContent = text;
      return div.innerHTML.replace(/\n/g, "<br>");
    }
    const html = window.marked.parse(text, { gfm: true, breaks: false });
    return window.DOMPurify.sanitize(html);
  }

  function decorateCode(container) {
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
    } catch {}
  }

  // ---------- rendering ----------
  function renderSidebar() {
    chatList.innerHTML = "";
    if (!chats.length) return;
    const label = document.createElement("div");
    label.className = "label";
    label.textContent = "Recent";
    chatList.append(label);

    for (const chat of chats) {
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

  function assistantBubble(text = "", { pending = false } = {}) {
    const el = document.createElement("div");
    el.className = "msg assistant";
    el.innerHTML = `<span class="brand-mark avatar">AI</span><div class="content" style="flex:1;min-width:0"><div class="body"></div></div>`;
    const body = el.querySelector(".body");
    if (pending) {
      body.innerHTML = '<div class="typing" aria-label="Thinking"><span></span><span></span><span></span></div>';
    } else {
      body.innerHTML = renderMarkdown(text);
      decorateCode(body);
      addActions(el, text);
    }
    thread.append(el);
    return el;
  }

  function addActions(el, text) {
    const actions = document.createElement("div");
    actions.className = "msg-actions";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "icon-btn";
    btn.setAttribute("aria-label", "Copy response");
    btn.innerHTML = '<i data-lucide="copy"></i>';
    btn.addEventListener("click", async () => {
      await copy(text, btn);
      btn.innerHTML = '<i data-lucide="check"></i>';
      icons();
      setTimeout(() => {
        btn.innerHTML = '<i data-lucide="copy"></i>';
        icons();
      }, 1500);
    });
    actions.append(btn);
    el.querySelector(".content").append(actions);
    icons();
  }

  function renderThread() {
    thread.innerHTML = "";
    const msgs = current?.messages ?? [];
    empty.hidden = msgs.length > 0;
    for (const m of msgs) {
      m.role === "user" ? userBubble(m.content) : assistantBubble(m.content);
    }
    titleEl.textContent = current?.title ?? "New chat";
    document.title = current ? `${current.title} | Radiant AI` : "Radiant AI | Samuel Maclar";
    scrollToBottom(true);
  }

  function nearBottom() {
    return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 120;
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

  // ---------- sending ----------
  function setBusy(busy) {
    sendBtn.disabled = false;
    sendBtn.setAttribute("aria-label", busy ? "Stop generating" : "Send message");
    sendBtn.innerHTML = `<i data-lucide="${busy ? "square" : "arrow-up"}"></i>`;
    icons();
    updateSendState();
  }

  function updateSendState() {
    if (!controller) sendBtn.disabled = !input.value.trim();
  }

  function stop() {
    controller?.abort();
  }

  async function send(text) {
    text = text.trim();
    if (!text || controller) return;

    if (!current) {
      current = { id: crypto.randomUUID?.() ?? String(Date.now()), title: makeTitle(text), updated: Date.now(), messages: [] };
      chats.unshift(current);
    }
    const chat = current;
    chat.messages.push({ role: "user", content: text });
    chat.updated = Date.now();
    save();

    empty.hidden = true;
    titleEl.textContent = chat.title;
    renderSidebar();
    userBubble(text);
    const bubble = assistantBubble("", { pending: true });
    const body = bubble.querySelector(".body");
    scrollToBottom(true);

    input.value = "";
    autosize();

    controller = new AbortController();
    setBusy(true);

    let reply = "";
    let frame = 0;
    const paint = () => {
      frame = 0;
      body.innerHTML = renderMarkdown(reply);
      scrollToBottom();
    };

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: chat.messages }),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        let msg = `Request failed (${res.status})`;
        try {
          msg = (await res.json()).error || msg;
        } catch {}
        throw new Error(msg);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        reply += decoder.decode(value, { stream: true });
        if (!frame) frame = requestAnimationFrame(paint);
      }
      reply += decoder.decode();
    } catch (err) {
      if (err.name !== "AbortError") {
        if (!reply) {
          // Roll back the unanswered user message so the conversation stays valid.
          chat.messages.pop();
          bubble.remove();
          thread.lastElementChild?.remove();
          input.value = text;
          autosize();
          showError(err.message || "Network error — please try again.");
        }
      }
    } finally {
      if (frame) cancelAnimationFrame(frame);
      controller = null;
      setBusy(false);
    }

    if (reply.trim()) {
      body.innerHTML = renderMarkdown(reply);
      decorateCode(body);
      addActions(bubble, reply);
      chat.messages.push({ role: "assistant", content: reply });
      chat.updated = Date.now();
      save();
    } else if (bubble.isConnected) {
      // Stopped before any text arrived: drop the empty reply and the unanswered message.
      bubble.remove();
      if (chat.messages.at(-1)?.role === "user") chat.messages.pop();
      thread.lastElementChild?.remove();
      input.value = text;
      autosize();
    }

    if (!chat.messages.length) {
      chats = chats.filter((c) => c !== chat);
      if (current === chat) current = null;
      empty.hidden = thread.children.length > 0;
    }
    save();
    renderSidebar();
    scrollToBottom();
  }

  function showError(message) {
    const note = document.createElement("p");
    note.className = "error-note";
    note.setAttribute("role", "alert");
    note.textContent = message;
    thread.append(note);
    empty.hidden = true;
    scrollToBottom(true);
    setTimeout(() => {
      note.remove();
      if (!thread.children.length) empty.hidden = false;
    }, 6000);
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

  document.querySelectorAll(".suggestions button").forEach((btn) =>
    btn.addEventListener("click", () => send(btn.textContent))
  );

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
  renderSidebar();
  renderThread();
  autosize();
  input.focus();
})();
