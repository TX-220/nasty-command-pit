/* Nasty Command Pit — 3-pane: list | detail | GrokBuild reference (resizable) */

const state = {
  data: null,
  selectedId: null,
  selectedCmd: null,
  running: false,
  query: "",
  editorId: null,
  categoryEditorId: null,
  collapsed: new Set(),
  sheetCollapsed: new Set(),
};

const els = {
  list: document.getElementById("command-list"),
  count: document.getElementById("command-count"),
  empty: document.getElementById("empty-state"),
  detailBody: document.getElementById("detail-body"),
  label: document.getElementById("cmd-label"),
  description: document.getElementById("cmd-description"),
  argv: document.getElementById("cmd-argv"),
  cwd: document.getElementById("cmd-cwd"),
  btnRun: document.getElementById("btn-run"),
  btnAdd: document.getElementById("btn-add"),
  btnAddCategory: document.getElementById("btn-add-category"),
  btnRename: document.getElementById("btn-rename"),
  btnDelete: document.getElementById("btn-delete"),
  btnReload: document.getElementById("btn-reload"),
  editor: document.getElementById("editor-modal"),
  editorForm: document.getElementById("editor-form"),
  editorTitle: document.getElementById("editor-title"),
  editorError: document.getElementById("editor-error"),
  edLabel: document.getElementById("ed-label"),
  edCommand: document.getElementById("ed-command"),
  edCategory: document.getElementById("ed-category"),
  edNewCat: document.getElementById("ed-newcat"),
  edCwd: document.getElementById("ed-cwd"),
  edDescription: document.getElementById("ed-description"),
  edUrl: document.getElementById("ed-url"),
  edDetach: document.getElementById("ed-detach"),
  editorSave: document.getElementById("editor-save"),
  categoryModal: document.getElementById("category-modal"),
  categoryForm: document.getElementById("category-form"),
  categoryTitle: document.getElementById("category-title"),
  categoryName: document.getElementById("cat-name"),
  categoryError: document.getElementById("category-error"),
  categorySave: document.getElementById("category-save"),
  btnClearLog: document.getElementById("btn-clear-log"),
  log: document.getElementById("log"),
  toast: document.getElementById("toast"),
  cheatsheetList: document.getElementById("cheatsheet-list"),
  search: document.getElementById("search-input"),
  btnClearSearch: document.getElementById("btn-clear-search"),
};

/** Display-only generic Grok Build reference (not runnable from this pane). */
const GROK_CHEATSHEET = [
  {
    title: "Daily (core)",
    items: [
      { need: "New session", cmd: "grok" },
      { need: "Start with prompt", cmd: 'grok "fix the bug"' },
      { need: "Continue last", cmd: "grok -c  /  grok --continue" },
      { need: "Resume by ID", cmd: "grok -r SESSION_ID  /  grok --resume SESSION_ID" },
      { need: "Headless one-shot", cmd: 'grok -p "prompt"  /  grok --single "..."' },
      { need: "Resume + one turn", cmd: 'grok -r SESSION_ID -p "..."' },
      { need: "YOLO (always approve)", cmd: 'grok -p "..." --always-approve' },
      { need: "Set cwd", cmd: "grok --cwd PATH" },
      { need: "With worktree", cmd: "grok -w  /  grok -w -r SESSION_ID" },
      { need: "Model / effort", cmd: "grok -m MODEL  /  grok --reasoning-effort medium" },
      { need: "Sandbox", cmd: "grok --sandbox off  /  maxsec …" },
      { need: "Memory OFF", cmd: "grok --no-memory" },
      { need: "Web search OFF", cmd: "grok --disable-web-search" },
      { need: "Version", cmd: "grok -v  /  grok version" },
    ],
  },
  {
    title: "Session management",
    items: [
      { need: "List", cmd: "grok sessions list" },
      { need: "Search", cmd: 'grok sessions search "keyword"' },
      { need: "Delete (irreversible)", cmd: "grok sessions delete SESSION_ID" },
      { need: "Export transcript MD", cmd: "grok export SESSION_ID" },
      { need: "Import", cmd: "grok import …" },
      { need: "Inspect config", cmd: "grok inspect" },
    ],
  },
  {
    title: "Dashboard / agents",
    items: [
      { need: "Running agents (official TUI)", cmd: "grok dashboard" },
    ],
  },
  {
    title: "Leader / Agent / Workspace",
    items: [
      { need: "Shared leader", cmd: "grok agent leader" },
      { need: "Leader list / kill", cmd: "grok leader list  /  grok leader kill" },
      { need: "Connect / ignore leader", cmd: "grok --leader  /  grok --no-leader" },
      { need: "Headless agent", cmd: "grok agent headless  /  stdio  /  serve" },
      { need: "Start workspace", cmd: "grok workspace start" },
      { need: "status / pause / resume / stop", cmd: "grok workspace status …" },
    ],
  },
  {
    title: "Maint / config",
    items: [
      { need: "Model list", cmd: "grok models" },
      { need: "Update", cmd: "grok update" },
      { need: "Login / logout", cmd: "grok login  /  grok logout" },
      { need: "MCP / memory / plugin / …", cmd: "grok mcp|memory|plugin|worktree|completions|setup|trace …" },
    ],
  },
];

function normalizeQuery(q) {
  return String(q || "")
    .trim()
    .toLowerCase();
}

function matchesQuery(haystack, query) {
  if (!query) return true;
  return String(haystack || "")
    .toLowerCase()
    .includes(query);
}

function commandMatches(cmd, cat, query) {
  if (!query) return true;
  const argv = Array.isArray(cmd.command) ? cmd.command.join(" ") : String(cmd.command || "");
  const parts = [
    cmd.id,
    cmd.label,
    cmd.description,
    argv,
    cat?.name,
    cat?.id,
  ];
  return parts.some((p) => matchesQuery(p, query));
}

function cheatsheetItemMatches(item, cat, query) {
  if (!query) return true;
  return (
    matchesQuery(item.need, query) ||
    matchesQuery(item.cmd, query) ||
    matchesQuery(cat?.title, query)
  );
}

function renderCheatsheet() {
  const root = els.cheatsheetList;
  if (!root) return;
  root.innerHTML = "";

  const query = normalizeQuery(state.query);
  let shown = 0;
  let sections = 0;

  for (const cat of GROK_CHEATSHEET) {
    const items = (cat.items || []).filter((item) => cheatsheetItemMatches(item, cat, query));
    if (items.length === 0) continue;

    sections += 1;
    const collapsed = !query && state.sheetCollapsed.has(cat.title);
    const wrap = document.createElement("div");
    wrap.className = "cheatsheet-category";

    const title = document.createElement("button");
    title.type = "button";
    title.className = "cheatsheet-category-title";
    title.setAttribute("aria-expanded", collapsed ? "false" : "true");
    title.setAttribute("aria-label", (collapsed ? "Expand " : "Collapse ") + cat.title);

    const chevron = document.createElement("span");
    chevron.className = "category-chevron";
    chevron.setAttribute("aria-hidden", "true");
    chevron.textContent = collapsed ? "▸" : "▾";

    const name = document.createElement("span");
    name.className = "category-name";
    name.textContent = cat.title;

    title.appendChild(chevron);
    title.appendChild(name);
    title.addEventListener("click", () => toggleSheet(cat.title));
    wrap.appendChild(title);

    if (collapsed) {
      root.appendChild(wrap);
      continue;
    }

    for (const item of items) {
      const row = document.createElement("div");
      row.className = "cheatsheet-row";

      const need = document.createElement("div");
      need.className = "cheatsheet-need";
      need.textContent = item.need;

      const cmd = document.createElement("div");
      cmd.className = "cheatsheet-cmd";
      cmd.textContent = item.cmd;

      row.appendChild(need);
      row.appendChild(cmd);
      wrap.appendChild(row);
      shown += 1;
    }

    root.appendChild(wrap);
  }

  if (sections === 0) {
    root.innerHTML =
      '<div class="section-label empty-list">' +
      (query ? "No matching GrokBuild commands" : "No commands") +
      "</div>";
  }
}

function timestamp() {
  return new Date().toLocaleTimeString("en-GB", { hour12: false });
}

function appendLog(text, className) {
  const span = document.createElement("span");
  if (className) span.className = className;
  span.textContent = text.endsWith("\n") ? text : text + "\n";
  els.log.appendChild(span);
  els.log.scrollTop = els.log.scrollHeight;
}

function clearLog() {
  els.log.textContent = "";
}

function showToast(message, type) {
  if (!els.toast) return;
  els.toast.textContent = message;
  els.toast.classList.remove("hidden", "success", "error");
  if (type) els.toast.classList.add(type);
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => {
    els.toast.classList.add("hidden");
  }, 2400);
}

function findCommand(commandId) {
  if (!state.data) return null;
  for (const cat of state.data.categories || []) {
    for (const cmd of cat.commands || []) {
      if (cmd.id === commandId) return cmd;
    }
  }
  return null;
}

const COLLAPSE_KEY = "vesper-launcher-collapsed-cats";
const SHEET_COLLAPSE_KEY = "vesper-launcher-collapsed-sheet";

function loadCollapsed() {
  try {
    const raw = JSON.parse(localStorage.getItem(COLLAPSE_KEY) || "[]");
    state.collapsed = new Set(Array.isArray(raw) ? raw : []);
  } catch {
    state.collapsed = new Set();
  }
  try {
    const raw = JSON.parse(localStorage.getItem(SHEET_COLLAPSE_KEY) || "[]");
    state.sheetCollapsed = new Set(Array.isArray(raw) ? raw : []);
  } catch {
    state.sheetCollapsed = new Set();
  }
}

function saveCollapsed() {
  localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...state.collapsed]));
}

function saveSheetCollapsed() {
  localStorage.setItem(SHEET_COLLAPSE_KEY, JSON.stringify([...state.sheetCollapsed]));
}

function toggleSheet(title) {
  if (state.sheetCollapsed.has(title)) state.sheetCollapsed.delete(title);
  else state.sheetCollapsed.add(title);
  saveSheetCollapsed();
  renderCheatsheet();
}

function toggleCategory(categoryId) {
  if (state.collapsed.has(categoryId)) state.collapsed.delete(categoryId);
  else state.collapsed.add(categoryId);
  saveCollapsed();
  renderList();
}

function countCommands(data) {
  let n = 0;
  for (const cat of data?.categories || []) {
    n += (cat.commands || []).length;
  }
  return n;
}

function renderList() {
  const data = state.data;
  if (!data || !data.categories || data.categories.length === 0) {
    els.list.innerHTML = '<div class="section-label empty-list">No commands</div>';
    if (els.count) els.count.textContent = "0 commands";
    return;
  }

  const query = normalizeQuery(state.query);
  const total = countCommands(data);
  let shown = 0;
  let folders = 0;

  els.list.innerHTML = "";
  for (const cat of data.categories) {
    const cmds = (cat.commands || []).filter((cmd) => commandMatches(cmd, cat, query));
    if (query && cmds.length === 0) continue;

    const wrap = document.createElement("div");
    wrap.className = "category";

    folders += 1;
    const collapsed = !query && state.collapsed.has(cat.id);
    const label = cat.name || cat.id || "Category";

    const head = document.createElement("div");
    head.className = "category-head";

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "category-toggle";
    toggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
    toggle.setAttribute("aria-label", (collapsed ? "Expand " : "Collapse ") + label);

    const chevron = document.createElement("span");
    chevron.className = "category-chevron";
    chevron.setAttribute("aria-hidden", "true");
    chevron.textContent = collapsed ? "▸" : "▾";

    const title = document.createElement("span");
    title.className = "category-name";
    title.textContent = label;

    toggle.appendChild(chevron);
    toggle.appendChild(title);
    toggle.addEventListener("click", () => toggleCategory(cat.id));

    const actions = document.createElement("div");
    actions.className = "cmd-actions";

    const renameCat = document.createElement("button");
    renameCat.type = "button";
    renameCat.className = "cmd-rename";
    renameCat.textContent = "Rename";
    renameCat.title = "Rename category";
    renameCat.addEventListener("click", () => openCategoryEditor(cat));

    const deleteCat = document.createElement("button");
    deleteCat.type = "button";
    deleteCat.className = "cmd-delete";
    deleteCat.textContent = "Delete";
    deleteCat.title = "Delete category";
    deleteCat.addEventListener("click", () => deleteCategory(cat));

    actions.appendChild(renameCat);
    actions.appendChild(deleteCat);
    head.appendChild(toggle);
    head.appendChild(actions);
    wrap.appendChild(head);

    if (collapsed) {
      els.list.appendChild(wrap);
      continue;
    }

    for (const cmd of cmds) {
      const row = document.createElement("div");
      row.className = "cmd-item" + (state.selectedId === cmd.id ? " active" : "");
      row.dataset.id = cmd.id;
      row.tabIndex = 0;
      row.setAttribute("role", "button");

      const body = document.createElement("div");
      body.className = "cmd-item-body";

      const name = document.createElement("div");
      name.className = "cmd-item-name";
      name.textContent = cmd.label || cmd.id;

      const meta = document.createElement("div");
      meta.className = "cmd-item-meta";
      const argv = Array.isArray(cmd.command) ? cmd.command.join(" ") : String(cmd.command || "");
      meta.textContent = argv;

      const actions = document.createElement("div");
      actions.className = "cmd-actions";

      const rename = document.createElement("button");
      rename.type = "button";
      rename.className = "cmd-rename";
      rename.textContent = "Rename";
      rename.title = "Rename " + (cmd.label || cmd.id);
      rename.addEventListener("click", (event) => {
        event.stopPropagation();
        openEditor(cmd);
      });

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "cmd-delete";
      remove.textContent = "Delete";
      remove.title = "Delete " + (cmd.label || cmd.id);
      remove.addEventListener("click", (event) => {
        event.stopPropagation();
        deleteCommand(cmd);
      });

      actions.appendChild(rename);
      actions.appendChild(remove);
      body.appendChild(name);
      body.appendChild(meta);
      row.appendChild(body);
      row.appendChild(actions);
      row.addEventListener("click", () => selectCommand(cmd.id));
      row.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          selectCommand(cmd.id);
        }
      });
      wrap.appendChild(row);
      shown += 1;
    }

    els.list.appendChild(wrap);
  }

  if (folders === 0) {
    els.list.innerHTML =
      '<div class="section-label empty-list">' +
      (query ? "No matching commands" : "No commands") +
      "</div>";
  }

  if (els.count) {
    if (query) {
      els.count.textContent = `${shown} / ${total} command${total === 1 ? "" : "s"}`;
    } else {
      els.count.textContent = `${total} command${total === 1 ? "" : "s"}`;
    }
  }
}

function updateClearSearchButton() {
  if (!els.btnClearSearch) return;
  const has = Boolean(normalizeQuery(state.query));
  els.btnClearSearch.classList.toggle("hidden", !has);
}

function applySearch(raw) {
  state.query = String(raw || "");
  updateClearSearchButton();
  renderList();
  renderCheatsheet();
}

function initSearch() {
  if (!els.search) return;

  els.search.addEventListener("input", () => {
    applySearch(els.search.value);
  });

  if (els.btnClearSearch) {
    els.btnClearSearch.addEventListener("click", () => {
      els.search.value = "";
      applySearch("");
      els.search.focus();
    });
  }

  // "/" focuses search when not typing in an input
  document.addEventListener("keydown", (e) => {
    if (e.key === "/" && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const tag = (document.activeElement && document.activeElement.tagName) || "";
      if (tag === "INPUT" || tag === "TEXTAREA" || document.activeElement?.isContentEditable) {
        return;
      }
      e.preventDefault();
      els.search.focus();
      els.search.select();
    }
    if (e.key === "Escape" && document.activeElement === els.search) {
      if (els.search.value) {
        els.search.value = "";
        applySearch("");
      } else {
        els.search.blur();
      }
    }
  });

  updateClearSearchButton();
}

function selectCommand(commandId) {
  const cmd = findCommand(commandId);
  if (!cmd) return;

  state.selectedId = commandId;
  state.selectedCmd = cmd;
  renderList();
  renderDetail();
}

function renderDetail() {
  const cmd = state.selectedCmd;
  if (!cmd) {
    els.empty.classList.remove("hidden");
    els.detailBody.classList.add("hidden");
    return;
  }

  els.empty.classList.add("hidden");
  els.detailBody.classList.remove("hidden");
  els.label.textContent = cmd.label || cmd.id;
  els.description.textContent = cmd.description || "";

  const argv = Array.isArray(cmd.command) ? cmd.command.join(" ") : String(cmd.command || "");
  els.argv.textContent = `$ ${argv}`;
  const cwdPart = `cwd: ${cmd.cwd || "(default)"}`;
  const modePart = cmd.detach ? "mode: detach (background)" : "mode: wait (timeout 30s)";
  const openPart = cmd.open_url ? `open: ${cmd.open_url}` : "open: (none)";
  els.cwd.textContent = `${cwdPart}  ·  ${modePart}  ·  ${openPart}`;

  els.btnRun.disabled = state.running;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function openUrlInNewTab(url, delayMs, pendingTab) {
  if (!url) return;

  let tab = pendingTab;
  if (!tab || tab.closed) {
    tab = window.open("about:blank", "_blank");
  }
  if (!tab) {
    appendLog(`[${timestamp()}] popup blocked — open manually: ${url}`, "line-warn");
    showToast(`Open manually: ${url}`, "error");
    return;
  }

  try {
    tab.document.title = "Starting…";
    tab.document.body.innerHTML =
      '<p style="font-family:system-ui;padding:24px;color:#888">Starting… waiting for server</p>';
  } catch {
    /* ignore */
  }

  const wait = Math.max(0, Number(delayMs) || 0);
  if (wait > 0) {
    appendLog(`[${timestamp()}] opening ${url} in ${wait}ms…`, "line-info");
    await sleep(wait);
  }

  try {
    tab.location.href = url;
    appendLog(`[${timestamp()}] opened new tab: ${url}`, "line-ok");
  } catch (err) {
    const w = window.open(url, "_blank", "noopener,noreferrer");
    if (!w) {
      appendLog(`[${timestamp()}] failed to open tab: ${err.message || err}`, "line-err");
      showToast(`Open manually: ${url}`, "error");
    } else {
      appendLog(`[${timestamp()}] opened new tab: ${url}`, "line-ok");
    }
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function quoteArg(value) {
  const text = String(value);
  if (text === "") return "''";
  if (/^[A-Za-z0-9_@%+=:,./~-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

function quoteArgv(argv) {
  return (Array.isArray(argv) ? argv : []).map(quoteArg).join(" ");
}

function categoryOf(commandId) {
  if (!state.data) return null;
  for (const cat of state.data.categories || []) {
    for (const cmd of cat.commands || []) {
      if (cmd.id === commandId) return cat;
    }
  }
  return null;
}

function fillCategories(selectedId) {
  const select = els.edCategory;
  select.innerHTML = "";
  const cats = state.data?.categories || [];
  if (cats.length === 0) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "Custom";
    select.appendChild(opt);
    return;
  }
  for (const cat of cats) {
    const opt = document.createElement("option");
    opt.value = cat.id;
    opt.textContent = cat.name || cat.id;
    if (cat.id === selectedId) opt.selected = true;
    select.appendChild(opt);
  }
}

function showEditorError(message) {
  if (!message) {
    els.editorError.textContent = "";
    els.editorError.classList.add("hidden");
    return;
  }
  els.editorError.textContent = message;
  els.editorError.classList.remove("hidden");
}

async function readError(res) {
  const body = await res.json().catch(() => ({}));
  if (typeof body.detail === "string") return body.detail;
  if (Array.isArray(body.detail)) {
    return body.detail.map((item) => item.msg || JSON.stringify(item)).join("; ");
  }
  return `HTTP ${res.status}`;
}

function openEditor(cmd) {
  closeCategoryEditor();
  state.editorId = cmd ? cmd.id : null;
  els.editorTitle.textContent = cmd ? "Rename app" : "Add app";
  els.edLabel.value = cmd ? cmd.label || cmd.id : "";
  els.edCommand.value = cmd ? quoteArgv(cmd.command) : "";
  els.edCwd.value = cmd && cmd.cwd ? cmd.cwd : "";
  els.edDescription.value = cmd && cmd.description ? cmd.description : "";
  els.edUrl.value = cmd && cmd.open_url ? cmd.open_url : "";
  els.edDetach.checked = Boolean(cmd && cmd.detach);
  els.edNewCat.value = "";
  const cat = cmd ? categoryOf(cmd.id) : state.data?.categories?.[0];
  fillCategories(cat ? cat.id : "");
  showEditorError("");
  els.editor.classList.remove("hidden");
  els.edLabel.focus();
  els.edLabel.select();
}

function closeEditor() {
  els.editor.classList.add("hidden");
  state.editorId = null;
  showEditorError("");
}

function showCategoryError(message) {
  if (!message) {
    els.categoryError.textContent = "";
    els.categoryError.classList.add("hidden");
    return;
  }
  els.categoryError.textContent = message;
  els.categoryError.classList.remove("hidden");
}

function openCategoryEditor(cat) {
  closeEditor();
  state.categoryEditorId = cat ? cat.id : null;
  els.categoryTitle.textContent = cat ? "Rename category" : "Add category";
  els.categoryName.value = cat ? cat.name || cat.id : "";
  showCategoryError("");
  els.categoryModal.classList.remove("hidden");
  els.categoryName.focus();
  els.categoryName.select();
}

function closeCategoryEditor() {
  els.categoryModal.classList.add("hidden");
  state.categoryEditorId = null;
  showCategoryError("");
}

async function saveCategory(event) {
  event.preventDefault();
  const name = els.categoryName.value.trim();
  const editing = state.categoryEditorId;
  const url = editing ? `/api/categories/${encodeURIComponent(editing)}` : "/api/categories";
  els.categorySave.disabled = true;
  try {
    const res = await fetch(url, {
      method: editing ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) throw new Error(await readError(res));
    closeCategoryEditor();
    await loadCommands({ quiet: true });
    appendLog(`[${timestamp()}] ${editing ? "renamed category" : "added category"}: ${name}`, "line-ok");
    showToast(editing ? "Category renamed" : "Category added", "success");
  } catch (err) {
    showCategoryError(err.message || String(err));
  } finally {
    els.categorySave.disabled = false;
  }
}

async function deleteCommand(cmd) {
  const label = cmd.label || cmd.id;
  if (!window.confirm(`Delete "${label}" from the launcher?`)) return;
  try {
    const res = await fetch(`/api/commands/${encodeURIComponent(cmd.id)}`, { method: "DELETE" });
    if (!res.ok) throw new Error(await readError(res));
    if (state.selectedId === cmd.id) {
      state.selectedId = null;
      state.selectedCmd = null;
    }
    await loadCommands({ quiet: true });
    appendLog(`[${timestamp()}] deleted: ${label}`, "line-ok");
    showToast("Deleted", "success");
  } catch (err) {
    showToast(err.message || String(err), "error");
  }
}

async function deleteCategory(cat) {
  const name = cat.name || cat.id;
  const count = (cat.commands || []).length;
  const message = count
    ? `Delete category "${name}" and its ${count} app${count === 1 ? "" : "s"}?`
    : `Delete empty category "${name}"?`;
  if (!window.confirm(message)) return;
  try {
    const res = await fetch(`/api/categories/${encodeURIComponent(cat.id)}`, { method: "DELETE" });
    if (!res.ok) throw new Error(await readError(res));
    if (state.selectedCmd && categoryOf(state.selectedId)?.id === cat.id) {
      state.selectedId = null;
      state.selectedCmd = null;
    }
    await loadCommands({ quiet: true });
    appendLog(`[${timestamp()}] deleted category: ${name}`, "line-ok");
    showToast("Category deleted", "success");
  } catch (err) {
    showToast(err.message || String(err), "error");
  }
}

async function saveEditor(event) {
  event.preventDefault();
  const payload = {
    label: els.edLabel.value.trim(),
    command: els.edCommand.value.trim(),
    category_id: els.edCategory.value || null,
    new_category: els.edNewCat.value.trim() || null,
    cwd: els.edCwd.value.trim() || null,
    description: els.edDescription.value.trim() || null,
    detach: els.edDetach.checked,
    open_url: els.edUrl.value.trim() || null,
  };
  const editing = state.editorId;
  const url = editing ? `/api/commands/${encodeURIComponent(editing)}` : "/api/commands";
  els.editorSave.disabled = true;
  try {
    const res = await fetch(url, {
      method: editing ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(await readError(res));
    const body = await res.json();
    const savedId = body.command && body.command.id ? body.command.id : editing;
    closeEditor();
    await loadCommands({ quiet: true, selectId: savedId });
    appendLog(`[${timestamp()}] ${editing ? "renamed" : "registered"}: ${payload.label}`, "line-ok");
    showToast(editing ? "Renamed" : "App registered", "success");
  } catch (err) {
    showEditorError(err.message || String(err));
  } finally {
    els.editorSave.disabled = false;
  }
}

async function loadCommands(opts = {}) {
  const quiet = Boolean(opts.quiet);
  try {
    const res = await fetch("/api/commands", { cache: "no-store" });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.detail || `HTTP ${res.status}`);
    }
    state.data = await res.json();

    if (opts.selectId) state.selectedId = opts.selectId;
    if (state.selectedId) {
      state.selectedCmd = findCommand(state.selectedId);
      if (!state.selectedCmd) {
        state.selectedId = null;
        state.selectedCmd = null;
      }
    }

    renderList();
    renderDetail();
    if (!quiet) {
      appendLog(`[${timestamp()}] commands.json reloaded`, "line-info");
      showToast("Commands reloaded", "success");
    }
  } catch (err) {
    els.list.innerHTML = `<div class="section-label empty-list">Load failed: ${escapeHtml(err.message)}</div>`;
    if (els.count) els.count.textContent = "";
    appendLog(`[${timestamp()}] load error: ${err.message}`, "line-err");
    showToast(`Load failed: ${err.message}`, "error");
  }
}

async function runSelected() {
  if (!state.selectedId || state.running) return;

  const cmd = state.selectedCmd;
  const id = state.selectedId;
  const willOpen = Boolean(cmd && cmd.open_url);

  let pendingTab = null;
  if (willOpen) {
    pendingTab = window.open("about:blank", "_blank");
    if (!pendingTab) {
      appendLog(`[${timestamp()}] popup blocked — allow popups for this site`, "line-warn");
    }
  }

  state.running = true;
  els.btnRun.disabled = true;
  els.btnRun.classList.add("running");
  els.btnRun.textContent = "Running…";

  appendLog(`[${timestamp()}] ▶ run: ${id}`, "line-info");

  try {
    const res = await fetch("/api/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command_id: id }),
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      const detail = data.detail || `HTTP ${res.status}`;
      appendLog(
        `[${timestamp()}] ✖ rejected: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`,
        "line-err"
      );
      showToast("Run rejected", "error");
      if (pendingTab && !pendingTab.closed) pendingTab.close();
      return;
    }

    if (data.command) {
      appendLog(`  $ ${data.command.join(" ")}`, "line-info");
    }
    if (data.cwd) {
      appendLog(`  cwd: ${data.cwd}`, "line-info");
    }

    if (data.stdout) {
      appendLog("--- stdout ---", "line-info");
      appendLog(data.stdout);
    }
    if (data.stderr) {
      appendLog("--- stderr ---", "line-warn");
      appendLog(data.stderr, "line-warn");
    }

    if (data.ok) {
      appendLog(`[${timestamp()}] ✔ done returncode=${data.returncode}`, "line-ok");
      showToast("Done", "success");

      const url = data.open_url || (cmd && cmd.open_url) || null;
      const delay =
        data.open_delay_ms != null ? data.open_delay_ms : (cmd && cmd.open_delay_ms) || 0;
      if (url) {
        await openUrlInNewTab(url, delay, pendingTab);
      } else if (pendingTab && !pendingTab.closed) {
        pendingTab.close();
      }
    } else {
      const errMsg = data.error || `returncode=${data.returncode}`;
      appendLog(`[${timestamp()}] ✖ failed: ${errMsg}`, "line-err");
      showToast(errMsg, "error");
      if (pendingTab && !pendingTab.closed) pendingTab.close();
    }
  } catch (err) {
    appendLog(`[${timestamp()}] ✖ network: ${err.message}`, "line-err");
    showToast(`Network error: ${err.message}`, "error");
    if (pendingTab && !pendingTab.closed) pendingTab.close();
  } finally {
    state.running = false;
    els.btnRun.classList.remove("running");
    els.btnRun.textContent = "Run";
    els.btnRun.disabled = !state.selectedId;
  }
}

function initPaneResizers() {
  const main = document.querySelector(".main");
  const leftPanel = document.getElementById("sidebar-panel");
  const leftResizer = document.getElementById("sidebar-resizer");
  const rightWrap = document.getElementById("cheatsheet-wrap");
  const rightResizer = document.getElementById("cheatsheet-resizer");
  if (!main || !leftPanel || !leftResizer) return;

  const LEFT_MIN = 180;
  const LEFT_DEFAULT = 300;
  const RIGHT_MIN = 200;
  const RIGHT_DEFAULT = 300;
  const LEFT_KEY = "vesper-launcher-sidebar-w";
  const RIGHT_KEY = "vesper-launcher-cheatsheet-w";

  const detailMin = () => {
    const v = getComputedStyle(document.documentElement).getPropertyValue("--detail-min");
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : 160;
  };

  const mainWidth = () => main.getBoundingClientRect().width;

  const leftMax = () => {
    const rightW = rightWrap ? rightWrap.offsetWidth : 0;
    return Math.max(LEFT_MIN, mainWidth() - detailMin() - rightW);
  };

  const rightMax = () => {
    const leftW = leftPanel.offsetWidth;
    return Math.max(RIGHT_MIN, mainWidth() - detailMin() - leftW);
  };

  const setLeft = (w) => {
    const clamped = Math.min(leftMax(), Math.max(LEFT_MIN, w));
    leftPanel.style.width = `${clamped}px`;
    return clamped;
  };

  const setRight = (w) => {
    if (!rightWrap) return 0;
    const clamped = Math.min(rightMax(), Math.max(RIGHT_MIN, w));
    rightWrap.style.width = `${clamped}px`;
    return clamped;
  };

  const reclampAll = () => {
    setLeft(leftPanel.offsetWidth || LEFT_DEFAULT);
    if (rightWrap) setRight(rightWrap.offsetWidth || RIGHT_DEFAULT);
  };

  const savedLeft = Number(localStorage.getItem(LEFT_KEY));
  if (savedLeft >= LEFT_MIN) setLeft(savedLeft);
  else setLeft(LEFT_DEFAULT);

  if (rightWrap) {
    const savedRight = Number(localStorage.getItem(RIGHT_KEY));
    if (savedRight >= RIGHT_MIN) setRight(savedRight);
    else setRight(RIGHT_DEFAULT);
  }

  // After both applied, ensure center still has room (e.g. narrow window)
  reclampAll();

  window.addEventListener("resize", reclampAll);

  let active = null; // "left" | "right" | null

  const stop = () => {
    if (!active) return;
    if (active === "left") {
      leftResizer.classList.remove("active");
      localStorage.setItem(LEFT_KEY, String(leftPanel.offsetWidth));
    } else if (active === "right" && rightResizer && rightWrap) {
      rightResizer.classList.remove("active");
      localStorage.setItem(RIGHT_KEY, String(rightWrap.offsetWidth));
    }
    active = null;
    document.body.classList.remove("pane-resizing");
  };

  leftResizer.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    active = "left";
    leftResizer.classList.add("active");
    document.body.classList.add("pane-resizing");
    e.preventDefault();
  });

  leftResizer.addEventListener("dblclick", () => {
    setLeft(LEFT_DEFAULT);
    localStorage.setItem(LEFT_KEY, String(LEFT_DEFAULT));
  });

  if (rightResizer && rightWrap) {
    rightResizer.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      active = "right";
      rightResizer.classList.add("active");
      document.body.classList.add("pane-resizing");
      e.preventDefault();
    });

    rightResizer.addEventListener("dblclick", () => {
      setRight(RIGHT_DEFAULT);
      localStorage.setItem(RIGHT_KEY, String(RIGHT_DEFAULT));
    });
  }

  document.addEventListener("mousemove", (e) => {
    if (!active) return;
    const mainRect = main.getBoundingClientRect();
    if (active === "left") {
      setLeft(e.clientX - mainRect.left);
    } else if (active === "right") {
      // width from pointer to right edge of main
      setRight(mainRect.right - e.clientX);
    }
  });

  document.addEventListener("mouseup", stop);
  window.addEventListener("blur", stop);
}

els.btnReload.addEventListener("click", () => loadCommands());
els.btnClearLog.addEventListener("click", () => clearLog());
els.btnRun.addEventListener("click", () => runSelected());
els.btnAdd.addEventListener("click", () => openEditor(null));
els.btnAddCategory.addEventListener("click", () => openCategoryEditor(null));
els.btnRename.addEventListener("click", () => {
  if (state.selectedCmd) openEditor(state.selectedCmd);
});
els.btnDelete.addEventListener("click", () => {
  if (state.selectedCmd) deleteCommand(state.selectedCmd);
});
els.editorForm.addEventListener("submit", (event) => saveEditor(event));
document.getElementById("editor-cancel").addEventListener("click", () => closeEditor());
document.getElementById("editor-close").addEventListener("click", () => closeEditor());
els.editor.addEventListener("click", (event) => {
  if (event.target === els.editor) closeEditor();
});
els.categoryForm.addEventListener("submit", (event) => saveCategory(event));
document.getElementById("category-cancel").addEventListener("click", () => closeCategoryEditor());
document.getElementById("category-close").addEventListener("click", () => closeCategoryEditor());
els.categoryModal.addEventListener("click", (event) => {
  if (event.target === els.categoryModal) closeCategoryEditor();
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (!els.categoryModal.classList.contains("hidden")) {
    event.preventDefault();
    closeCategoryEditor();
    return;
  }
  if (!els.editor.classList.contains("hidden")) {
    event.preventDefault();
    closeEditor();
  }
});

initSearch();
loadCollapsed();
renderCheatsheet();
initPaneResizers();
loadCommands();
