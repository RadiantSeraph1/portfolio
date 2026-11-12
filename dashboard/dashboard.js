(() => {
  const TOKEN_KEY = "radiant-ai-sync-token"; // same sign-in as Sync chats in the AI page
  const CACHE_KEY = "radiant-dash-cache";
  const THEME_KEY = "samuel-portfolio-theme";
  const STATUSES = [
    ["all", "All"],
    ["building", "Building"],
    ["live", "Live"],
    ["idea", "Ideas"],
    ["paused", "Paused"],
    ["done", "Done"],
  ];
  const STATUS_LABEL = { idea: "Idea", building: "Building", live: "Live", paused: "Paused", done: "Done" };
  const PRIORITY_RANK = { high: 0, medium: 1, low: 2 };
  const STATUS_RANK = { building: 0, live: 1, idea: 2, paused: 3, done: 4 };

  const $ = (s) => document.querySelector(s);
  const root = document.documentElement;
  const grid = $("#grid");
  const editor = $("#editor");

  let token = read(TOKEN_KEY);
  let projects = [];
  let github = {}; // repo -> info
  let filter = "all";
  let query = "";
  let editing = null; // project being edited
  const pending = new Map(); // id -> project waiting to be saved
  const deleted = new Set();
  let saveTimer = 0;

  // ---------- helpers ----------
  function read(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }
  function write(key, value) {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch {}
  }
  const icons = () => window.lucide?.createIcons();
  const uid = () => (crypto.randomUUID?.() || String(Date.now() + Math.random())).replace(/[^\w-]/g, "").slice(0, 32);
  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const safeUrl = (u) => (/^https?:\/\//i.test(u || "") ? u : "");

  function timeAgo(date) {
    const t = new Date(date).getTime();
    if (!t) return "";
    const s = Math.max(0, (Date.now() - t) / 1000);
    const units = [
      [31536000, "y"],
      [2592000, "mo"],
      [604800, "w"],
      [86400, "d"],
      [3600, "h"],
      [60, "m"],
    ];
    for (const [sec, label] of units) if (s >= sec) return `${Math.floor(s / sec)}${label} ago`;
    return "just now";
  }

  async function api(path, options = {}) {
    const res = await fetch(path, {
      ...options,
      headers: {
        ...(options.body ? { "content-type": "application/json" } : {}),
        authorization: `Bearer ${token}`,
      },
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) {
      signOut();
      throw new Error("Please sign in again.");
    }
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
    return data;
  }

  let noteIsProblem = false;
  function note(text, problem = false) {
    $("#sync-note").textContent = text;
    noteIsProblem = problem;
  }

  // ---------- theme ----------
  function applyTheme(theme) {
    root.dataset.theme = theme;
    write(THEME_KEY, theme);
    $("#theme-toggle").innerHTML = `<i data-lucide="${theme === "dark" ? "sun" : "moon"}"></i>`;
    icons();
  }
  $("#theme-toggle").addEventListener("click", () => applyTheme(root.dataset.theme === "dark" ? "light" : "dark"));

  // ---------- sign in ----------
  function showSignedIn(on) {
    $("#signin").hidden = on;
    $("#dash").hidden = !on;
    $("#topbar-actions").hidden = !on;
  }

  function signOut() {
    token = null;
    write(TOKEN_KEY, null);
    showSignedIn(false);
  }

  $("#sign-out").addEventListener("click", () => {
    if (confirm("Sign out on this device? This also stops chat sync here.")) signOut();
  });

  $("#signin-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = $("#signin-submit");
    const err = $("#signin-error");
    btn.disabled = true;
    err.hidden = true;
    try {
      const res = await fetch("/api/sync?action=login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: $("#password").value }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.token) throw new Error(data.error || `Sign-in failed (${res.status}).`);
      token = data.token;
      write(TOKEN_KEY, token);
      $("#password").value = "";
      start();
    } catch (ex) {
      err.textContent = navigator.onLine ? ex.message : "You're offline.";
      err.hidden = false;
    } finally {
      btn.disabled = false;
    }
  });

  // ---------- loading & saving ----------
  function cacheLocally() {
    write(CACHE_KEY, JSON.stringify(projects));
  }

  async function load() {
    try {
      const cached = JSON.parse(read(CACHE_KEY) || "[]");
      if (Array.isArray(cached) && cached.length && !projects.length) {
        projects = cached;
        render();
      }
    } catch {}

    note("Loading…");
    try {
      const data = await api("/api/dashboard");
      // Keep local edits that haven't reached the server yet.
      const remote = new Map((data.projects || []).map((p) => [p.id, p]));
      for (const p of pending.values()) remote.set(p.id, p);
      for (const id of deleted) remote.delete(id);
      projects = [...remote.values()];
      cacheLocally();
      note("");
      render();
      loadGithub();
    } catch (ex) {
      note(`${ex.message} Showing the last saved copy on this device.`, true);
      render();
    }
  }

  async function loadGithub() {
    const repos = [...new Set(projects.map((p) => p.repo).filter(Boolean))];
    if (!repos.length) return;
    try {
      const data = await api(`/api/dashboard?action=github&repos=${encodeURIComponent(repos.join(","))}`);
      github = { ...github, ...(data.repos || {}) };
      render();
      if (editing) renderGithubSection();
    } catch {}
  }

  function queueSave(project) {
    project.updated = Date.now();
    pending.set(project.id, project);
    cacheLocally();
    setSaveState("Saving…");
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, 700);
  }

  async function flush() {
    if (!pending.size && !deleted.size) return;
    const upsert = [...pending.values()];
    const del = [...deleted];
    try {
      await api("/api/dashboard", { method: "POST", body: JSON.stringify({ upsert, delete: del }) });
      upsert.forEach((p) => pending.get(p.id) === p && pending.delete(p.id));
      del.forEach((id) => deleted.delete(id));
      setSaveState("Saved");
      if (noteIsProblem) note("");
    } catch (ex) {
      setSaveState("Not saved");
      note(`${ex.message} Changes are kept on this device and will retry.`, true);
      clearTimeout(saveTimer);
      saveTimer = setTimeout(flush, 15000);
    }
  }

  function setSaveState(text) {
    $("#save-state").textContent = text;
  }

  window.addEventListener("online", () => flush());
  window.addEventListener("beforeunload", (e) => {
    if (pending.size || deleted.size) {
      flush();
      e.preventDefault();
    }
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flush();
    else if (token && !editing) load();
  });

  // ---------- rendering ----------
  function matches(p) {
    if (filter !== "all" && p.status !== filter) return false;
    if (!query) return true;
    const hay = [p.name, p.kind, p.summary, p.nextAction, p.notes, p.repo, ...(p.tags || []), ...(p.tasks || []).map((t) => t.text)]
      .join(" ")
      .toLowerCase();
    return query
      .toLowerCase()
      .split(/\s+/)
      .every((w) => hay.includes(w));
  }

  function sorted(list) {
    const sort = $("#sort").value;
    const pushed = (p) => new Date(github[p.repo]?.pushedAt || 0).getTime();
    return [...list].sort((a, b) => {
      if (sort === "updated") return b.updated - a.updated;
      if (sort === "activity") return pushed(b) - pushed(a);
      if (sort === "progress") return b.progress - a.progress;
      if (sort === "name") return a.name.localeCompare(b.name);
      return (
        (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9) ||
        (PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9) ||
        b.updated - a.updated
      );
    });
  }

  function renderStats() {
    const count = (s) => projects.filter((p) => p.status === s).length;
    const openTasks = projects.reduce((n, p) => n + (p.tasks || []).filter((t) => !t.done).length, 0);
    const recent = projects.filter((p) => Date.now() - new Date(github[p.repo]?.pushedAt || 0).getTime() < 7 * 86400000).length;
    const stats = [
      [projects.length, "Projects"],
      [count("building"), "Building"],
      [count("live"), "Live"],
      [openTasks, "Open tasks"],
      [recent, "Pushed this week"],
    ];
    $("#stats").innerHTML = stats
      .map(([n, l]) => `<div class="card stat"><span class="num">${n}</span><span class="lbl">${l}</span></div>`)
      .join("");
  }

  function renderFilters() {
    $("#filters").innerHTML = STATUSES.map(([value, label]) => {
      const n = value === "all" ? projects.length : projects.filter((p) => p.status === value).length;
      return `<button class="chip" type="button" role="tab" data-filter="${value}" aria-selected="${filter === value}">${label} ${n}</button>`;
    }).join("");
  }

  function card(p) {
    const gh = p.repo ? github[p.repo] : null;
    const tasks = p.tasks || [];
    const done = tasks.filter((t) => t.done).length;
    const live = safeUrl(p.url);
    const repoUrl = p.repo ? `https://github.com/${p.repo}` : "";
    const meta = [];
    if (tasks.length) meta.push(`<span><i data-lucide="list-checks"></i>${done}/${tasks.length}</span>`);
    if (gh && !gh.error) {
      if (gh.pushedAt) meta.push(`<span title="Last push"><i data-lucide="git-commit-horizontal"></i>${esc(timeAgo(gh.pushedAt))}</span>`);
      if (gh.openPrs) meta.push(`<span><i data-lucide="git-pull-request"></i>${gh.openPrs}</span>`);
      if (gh.openIssues) meta.push(`<span><i data-lucide="circle-dot"></i>${gh.openIssues}</span>`);
    } else if (gh?.error) {
      meta.push(`<span title="${esc(gh.error)}"><i data-lucide="alert-triangle"></i>GitHub</span>`);
    }
    const links = [
      live ? `<a href="${esc(live)}" target="_blank" rel="noopener noreferrer" aria-label="Open ${esc(p.name)}" data-stop><i data-lucide="external-link"></i></a>` : "",
      repoUrl ? `<a href="${esc(repoUrl)}" target="_blank" rel="noopener noreferrer" aria-label="${esc(p.name)} on GitHub" data-stop><i data-lucide="github"></i></a>` : "",
    ].join("");

    return `<article class="card project" tabindex="0" data-id="${esc(p.id)}" aria-label="${esc(p.name)}">
      <div class="p-top">
        <span class="p-kind">${esc(p.kind || "Project")}</span>
        ${p.priority === "high" ? '<span class="prio high">High</span>' : ""}
        <span class="status ${esc(p.status)}">${STATUS_LABEL[p.status] || "Idea"}</span>
      </div>
      <h3>${esc(p.name)}</h3>
      ${p.nextAction ? `<p class="p-next"><i data-lucide="arrow-right-circle"></i><span>${esc(p.nextAction)}</span></p>` : p.summary ? `<p class="p-summary">${esc(p.summary)}</p>` : ""}
      ${p.progress ? `<div class="progress"><div class="bar"><span style="width:${Number(p.progress) || 0}%"></span></div>${Number(p.progress) || 0}%</div>` : ""}
      <div class="p-meta">
        ${meta.join("")}
        ${links ? `<span class="links">${links}</span>` : ""}
        ${gh?.lastCommit ? `<span class="gh-commit" title="${esc(gh.lastCommit.message)}">“${esc(gh.lastCommit.message)}”</span>` : ""}
      </div>
    </article>`;
  }

  function render() {
    renderStats();
    renderFilters();
    const list = sorted(projects.filter(matches));
    grid.innerHTML = list.map(card).join("");
    $("#empty").hidden = projects.length > 0;
    if (projects.length && !list.length) grid.innerHTML = `<p class="muted">No projects match.</p>`;
    icons();
  }

  $("#filters").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-filter]");
    if (!btn) return;
    filter = btn.dataset.filter;
    render();
  });
  $("#search").addEventListener("input", (e) => {
    query = e.target.value.trim();
    render();
  });
  $("#sort").addEventListener("change", render);

  grid.addEventListener("click", (e) => {
    if (e.target.closest("[data-stop]")) return;
    const el = e.target.closest(".project");
    if (el) openEditor(projects.find((p) => p.id === el.dataset.id));
  });
  grid.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const el = e.target.closest(".project");
    if (!el || e.target.closest("a")) return;
    e.preventDefault();
    openEditor(projects.find((p) => p.id === el.dataset.id));
  });

  // ---------- editor ----------
  const fields = {
    name: $("#ed-name"),
    kind: $("#ed-kind"),
    status: $("#ed-status"),
    priority: $("#ed-priority"),
    progress: $("#ed-progress"),
    url: $("#ed-url"),
    repo: $("#ed-repo"),
    tags: $("#ed-tags"),
    nextAction: $("#ed-next"),
    summary: $("#ed-summary"),
    notes: $("#ed-notes"),
  };

  function openEditor(project) {
    if (!project) return;
    editing = project;
    for (const [key, el] of Object.entries(fields)) {
      el.value = key === "tags" ? (project.tags || []).join(", ") : project[key] ?? "";
    }
    $("#ed-progress-value").textContent = `${project.progress || 0}%`;
    setSaveState(pending.has(project.id) ? "Saving…" : "");
    renderTasks();
    renderGithubSection();
    editor.showModal();
    if (!project.name) fields.name.focus();
  }

  function closeEditor() {
    if (editing && !editing.name.trim()) {
      // Discard an untitled new project.
      projects = projects.filter((p) => p !== editing);
      pending.delete(editing.id);
      cacheLocally();
    }
    editing = null;
    editor.close();
    flush();
    render();
  }

  $("#ed-close").addEventListener("click", closeEditor);
  editor.addEventListener("cancel", (e) => {
    e.preventDefault();
    closeEditor();
  });
  editor.addEventListener("click", (e) => {
    if (e.target === editor) closeEditor(); // click on the backdrop
  });

  for (const [key, el] of Object.entries(fields)) {
    el.addEventListener("input", () => {
      if (!editing) return;
      if (key === "tags") editing.tags = el.value.split(",").map((t) => t.trim()).filter(Boolean).slice(0, 12);
      else if (key === "progress") {
        editing.progress = Number(el.value);
        $("#ed-progress-value").textContent = `${el.value}%`;
      } else editing[key] = el.value;
      if (key === "repo") editing.repo = el.value.trim().replace(/^https?:\/\/github\.com\//i, "").replace(/\.git$|\/$/g, "");
      if (key === "name" && !el.value.trim()) return; // a name is required before saving
      queueSave(editing);
    });
  }
  fields.repo.addEventListener("change", () => {
    renderGithubSection();
    loadGithub();
  });

  function renderTasks() {
    const tasks = editing.tasks || (editing.tasks = []);
    $("#ed-task-count").textContent = tasks.length ? `${tasks.filter((t) => t.done).length}/${tasks.length}` : "";
    $("#ed-tasks").innerHTML = tasks
      .map(
        (t) => `<li class="task ${t.done ? "done" : ""}" data-id="${esc(t.id)}">
          <input type="checkbox" ${t.done ? "checked" : ""} aria-label="Done: ${esc(t.text)}" />
          <span>${esc(t.text)}</span>
          <button type="button" aria-label="Remove task"><i data-lucide="x"></i></button>
        </li>`
      )
      .join("");
    icons();
  }

  $("#ed-tasks").addEventListener("change", (e) => {
    const li = e.target.closest(".task");
    const task = editing?.tasks.find((t) => t.id === li?.dataset.id);
    if (!task) return;
    task.done = e.target.checked;
    renderTasks();
    queueSave(editing);
  });
  $("#ed-tasks").addEventListener("click", (e) => {
    if (!e.target.closest("button")) return;
    const li = e.target.closest(".task");
    editing.tasks = editing.tasks.filter((t) => t.id !== li.dataset.id);
    renderTasks();
    queueSave(editing);
  });
  $("#ed-task-input").addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const text = e.target.value.trim();
    if (!text || !editing) return;
    editing.tasks.push({ id: uid().slice(0, 12), text: text.slice(0, 300), done: false });
    e.target.value = "";
    renderTasks();
    if (editing.name.trim()) queueSave(editing);
  });

  function renderGithubSection() {
    const box = $("#ed-github");
    const repo = editing?.repo;
    if (!repo) {
      box.hidden = true;
      return;
    }
    const gh = github[repo];
    box.hidden = false;
    if (!gh) {
      box.innerHTML = `<h3><i data-lucide="github"></i> ${esc(repo)}</h3><p class="muted">Loading GitHub activity…</p>`;
    } else if (gh.error) {
      box.innerHTML = `<h3><i data-lucide="github"></i> ${esc(repo)}</h3><p class="muted">${esc(gh.error)}</p>`;
    } else {
      box.innerHTML = `<h3><i data-lucide="github"></i> <a href="${esc(safeUrl(gh.url))}" target="_blank" rel="noopener noreferrer">${esc(repo)}</a></h3>
        <p>${gh.private ? "Private" : "Public"}${gh.language ? ` · ${esc(gh.language)}` : ""} · ${gh.openPrs} open PR${gh.openPrs === 1 ? "" : "s"} · ${gh.openIssues} open issue${gh.openIssues === 1 ? "" : "s"}${gh.stars ? ` · ★ ${gh.stars}` : ""}</p>
        ${gh.lastCommit ? `<p class="muted">Last commit ${esc(timeAgo(gh.lastCommit.date))}: <a href="${esc(safeUrl(gh.lastCommit.url))}" target="_blank" rel="noopener noreferrer">${esc(gh.lastCommit.message)}</a></p>` : ""}`;
    }
    icons();
  }

  $("#ed-delete").addEventListener("click", () => {
    if (!editing || !confirm(`Delete “${editing.name || "this project"}”? This can't be undone.`)) return;
    const id = editing.id;
    projects = projects.filter((p) => p.id !== id);
    pending.delete(id);
    deleted.add(id);
    cacheLocally();
    editing = null;
    editor.close();
    flush();
    render();
  });

  $("#ed-claude").addEventListener("click", () => {
    if (!editing) return;
    const p = editing;
    const open = (p.tasks || []).filter((t) => !t.done).map((t) => `- ${t.text}`);
    const gh = github[p.repo];
    const lines = [
      `Help me move my project "${p.name}" forward.`,
      "",
      `Status: ${STATUS_LABEL[p.status] || p.status}, priority ${p.priority}, about ${p.progress || 0}% done.`,
      p.kind && `Type: ${p.kind}`,
      p.summary && `Summary: ${p.summary}`,
      p.tags?.length && `Tech/tags: ${p.tags.join(", ")}`,
      p.repo && `Repo: github.com/${p.repo}${gh?.lastCommit ? ` (last commit ${timeAgo(gh.lastCommit.date)}: "${gh.lastCommit.message}")` : ""}`,
      p.url && `Live: ${p.url}`,
      p.nextAction && `My planned next action: ${p.nextAction}`,
      open.length && `Open tasks:\n${open.slice(0, 15).join("\n")}`,
      p.notes && `Notes:\n${p.notes.slice(0, 1200)}`,
      "",
      "What should I focus on next? Give me a short, prioritised plan for the next few days, and point out any risks or quick wins.",
    ].filter((l) => typeof l === "string"); // drops the empty optional fields (false/undefined/0)
    const prompt = lines.join("\n").replace(/\n{3,}/g, "\n\n").slice(0, 3500);
    window.open(`/ai?model=claude&prompt=${encodeURIComponent(prompt)}`, "_blank", "noopener");
  });

  // ---------- new / import ----------
  function newProject(data = {}) {
    const now = Date.now();
    return {
      id: uid(),
      name: "",
      kind: "",
      summary: "",
      status: "idea",
      priority: "medium",
      progress: 0,
      url: "",
      repo: "",
      tags: [],
      nextAction: "",
      notes: "",
      tasks: [],
      created: now,
      updated: now,
      ...data,
    };
  }

  function addProject() {
    const p = newProject();
    projects.unshift(p);
    render();
    openEditor(p);
  }

  async function importFromPortfolio() {
    note("Reading your portfolio page…");
    try {
      const html = await (await fetch("/", { cache: "no-store" })).text();
      const doc = new DOMParser().parseFromString(html, "text/html");
      const existing = new Set(projects.map((p) => p.name.trim().toLowerCase()));
      const found = [];

      for (const el of doc.querySelectorAll(".project-card")) {
        const name = el.querySelector("h3")?.textContent.trim();
        if (!name || existing.has(name.toLowerCase())) continue;
        const links = [...el.querySelectorAll(".project-links a[href]")].map((a) => a.getAttribute("href"));
        const gh = links.find((h) => /^https:\/\/github\.com\/[^/]+\/[^/]+/.test(h));
        const live = links.find((h) => /^https?:\/\//.test(h) && !/github\.com/.test(h));
        const badge = el.querySelector(".project-status")?.textContent.trim().toLowerCase() || "";
        const status = /early|progress|building/.test(badge) ? "building" : live ? "live" : "building";
        found.push(
          newProject({
            name: name.slice(0, 120),
            kind: el.querySelector(".project-kind")?.textContent.trim().slice(0, 60) || "",
            summary: el.querySelector(":scope > p")?.textContent.trim().replace(/\s+/g, " ").slice(0, 600) || "",
            status,
            url: live || "",
            repo: gh ? gh.replace(/^https:\/\/github\.com\//, "").split(/[/?#]/).slice(0, 2).join("/") : "",
            tags: [...el.querySelectorAll(".tag-row span")].map((s) => s.textContent.trim()).filter(Boolean).slice(0, 12),
          })
        );
      }

      if (!found.length) {
        note("Everything on your portfolio page is already on the dashboard.");
        return;
      }
      projects.push(...found);
      found.forEach((p) => pending.set(p.id, p));
      cacheLocally();
      render();
      note(`Imported ${found.length} project${found.length === 1 ? "" : "s"} from your portfolio.`);
      await flush();
      loadGithub();
    } catch (ex) {
      note(`Couldn't import: ${ex.message}`);
    }
  }

  $("#new-project").addEventListener("click", addProject);
  $("#import").addEventListener("click", importFromPortfolio);
  $("#empty").addEventListener("click", (e) => {
    const action = e.target.closest("[data-action]")?.dataset.action;
    if (action === "import") importFromPortfolio();
    if (action === "new") addProject();
  });

  // ---------- start ----------
  function start() {
    showSignedIn(true);
    load();
  }

  applyTheme(root.dataset.theme === "light" ? "light" : "dark");
  if (token) start();
  else {
    showSignedIn(false);
    $("#password").focus();
  }
  icons();
})();
