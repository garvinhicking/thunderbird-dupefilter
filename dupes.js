"use strict";

/* ------------------------------------------------------------------ *
 * State
 * ------------------------------------------------------------------ */

const params = new URLSearchParams(location.search);

const state = {
  folder: params.has("folder") ? JSON.parse(params.get("folder")) : null,
  mailTabId: params.has("mailTab") ? Number(params.get("mailTab")) : null,
  messages: new Map(),   // id -> MessageHeader
  groups: [],            // [{key, subject, ids: [rootId, ...dupeIds]}], sorted by count desc
  groupOf: new Map(),    // message id -> group
  rows: [],              // visible rows: [{id, group, root: bool}]
  rowIndex: new Map(),   // message id -> index in rows
  rowEls: new Map(),     // message id -> <tr>
  expanded: new Set(),   // expanded group keys
  selection: new Set(),  // selected message ids (visible rows)
  anchor: null,          // anchor row id for shift selection
  focus: null,           // focused row id
  minCount: 4,           // "more than 3 times"
  ignorePrefixes: false,
  busy: false,
};

const $ = (id) => document.getElementById(id);
const tbody = $("rows");
const listWrap = $("listWrap");

/* ------------------------------------------------------------------ *
 * Settings (per-viewer convenience only)
 * ------------------------------------------------------------------ */

function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem("settings") || "{}");
    if (Number.isInteger(s.minCount) && s.minCount >= 2) state.minCount = s.minCount;
    if (typeof s.ignorePrefixes === "boolean") state.ignorePrefixes = s.ignorePrefixes;
  } catch (e) { /* ignore */ }
  $("minCount").value = state.minCount;
  $("ignorePrefixes").checked = state.ignorePrefixes;
}

function saveSettings() {
  try {
    localStorage.setItem("settings", JSON.stringify({
      minCount: state.minCount,
      ignorePrefixes: state.ignorePrefixes,
    }));
  } catch (e) { /* ignore */ }
}

/* ------------------------------------------------------------------ *
 * Status
 * ------------------------------------------------------------------ */

function status(text, isError = false) {
  const el = $("status");
  el.textContent = text;
  el.classList.toggle("error", isError);
}

function setBusy(busy, text) {
  state.busy = busy;
  document.body.classList.toggle("busy", busy);
  if (text) status(text);
  updateButtons();
}

function errorText(e) {
  return (e && e.message) ? e.message : String(e);
}

/* ------------------------------------------------------------------ *
 * Loading and grouping
 * ------------------------------------------------------------------ */

const PREFIX_RE = /^\s*(re|fw|fwd|aw|wg|sv|vs|antw|tr|rif|r)\s*(\[\d+\]|\(\d+\))?\s*:\s*/i;

function normalizeSubject(subject) {
  let s = (subject || "").replace(/\s+/g, " ").trim();
  if (state.ignorePrefixes) {
    let prev;
    do {
      prev = s;
      s = s.replace(PREFIX_RE, "");
    } while (s !== prev);
  }
  return s.toLowerCase();
}

async function load() {
  if (!state.folder) {
    $("folderName").textContent = "No folder";
    showEmpty("No folder was selected. Open a folder in Thunderbird and click “Show dupes” again.");
    status("");
    return;
  }
  $("folderName").textContent = state.folder.name || state.folder.path;
  document.title = `Dupes – ${state.folder.name || state.folder.path}`;

  setBusy(true, "Scanning messages…");
  state.messages.clear();
  try {
    let page = await browser.messages.list(folderRef(state.folder));
    for (;;) {
      for (const m of page.messages) state.messages.set(m.id, m);
      status(`Scanning messages… ${state.messages.size}`);
      if (!page.id) break;
      page = await browser.messages.continueList(page.id);
    }
    rebuild();
    status(`Scanned ${state.messages.size} messages.`);
  } catch (e) {
    console.error(e);
    status(`Could not read folder: ${errorText(e)}`, true);
  } finally {
    setBusy(false);
  }
}

function rebuild() {
  const buckets = new Map();
  for (const m of state.messages.values()) {
    const key = normalizeSubject(m.subject);
    let bucket = buckets.get(key);
    if (!bucket) buckets.set(key, bucket = []);
    bucket.push(m);
  }

  const groups = [];
  for (const [key, msgs] of buckets) {
    if (msgs.length < state.minCount) continue;
    // The first (oldest) message is the thread root.
    msgs.sort((a, b) => ((+a.date || 0) - (+b.date || 0)) || (a.id - b.id));
    groups.push({ key, subject: msgs[0].subject, ids: msgs.map((m) => m.id) });
  }
  groups.sort((a, b) => (b.ids.length - a.ids.length) || a.key.localeCompare(b.key));

  state.groups = groups;
  state.groupOf = new Map();
  for (const g of groups) for (const id of g.ids) state.groupOf.set(id, g);

  const keys = new Set(groups.map((g) => g.key));
  for (const k of [...state.expanded]) if (!keys.has(k)) state.expanded.delete(k);

  buildRows();
  render();
}

function buildRows() {
  const rows = [];
  for (const g of state.groups) {
    rows.push({ id: g.ids[0], group: g, root: true });
    if (state.expanded.has(g.key)) {
      for (let i = 1; i < g.ids.length; i++) rows.push({ id: g.ids[i], group: g, root: false });
    }
  }
  state.rows = rows;
  state.rowIndex = new Map(rows.map((r, i) => [r.id, i]));

  // Drop selection / focus of rows that are no longer visible.
  for (const id of [...state.selection]) if (!state.rowIndex.has(id)) state.selection.delete(id);
  if (!state.rowIndex.has(state.focus)) state.focus = null;
  if (!state.rowIndex.has(state.anchor)) state.anchor = null;
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

function showEmpty(text) {
  const el = $("empty");
  el.hidden = !text;
  el.textContent = text || "";
}

function render() {
  const frag = document.createDocumentFragment();
  state.rowEls = new Map();
  for (const row of state.rows) {
    const tr = renderRow(row);
    state.rowEls.set(row.id, tr);
    frag.append(tr);
  }
  tbody.replaceChildren(frag);

  const dupeMsgs = state.groups.reduce((n, g) => n + g.ids.length, 0);
  $("summary").textContent = state.groups.length
    ? `${state.groups.length} subjects, ${dupeMsgs} messages`
    : "";
  showEmpty(state.groups.length || state.busy
    ? ""
    : `No subject occurs ${state.minCount} times or more in this folder.`);
  updateSelectionUI();
}

function renderRow(row) {
  const msg = state.messages.get(row.id);
  const g = row.group;
  const tr = document.createElement("tr");
  tr.dataset.id = row.id;
  tr.className = row.root ? "root" : "child";
  if (!msg.read) tr.classList.add("unread");

  const tdIcon = document.createElement("td");
  if (row.root) {
    const wrap = document.createElement("div");
    wrap.className = "icon-cell";
    const twisty = document.createElement("span");
    twisty.className = "twisty";
    twisty.textContent = state.expanded.has(g.key) ? "▼" : "▶";
    twisty.title = state.expanded.has(g.key) ? "Collapse" : "Expand";
    const icon = document.createElement("span");
    icon.className = "thread-icon";
    wrap.append(twisty, icon);
    tdIcon.append(wrap);
  }

  const tdSubject = document.createElement("td");
  tdSubject.className = "subject-cell";
  const subj = document.createElement("span");
  subj.className = "subj";
  subj.textContent = msg.subject || "(no subject)";
  const meta = document.createElement("span");
  meta.className = "meta";
  meta.textContent = [msg.author, msg.date ? dateFmt.format(msg.date) : ""].filter(Boolean).join(" · ");
  tdSubject.append(subj, meta);
  tdSubject.title = `${msg.subject}\n${meta.textContent}`;

  const tdCount = document.createElement("td");
  tdCount.className = "num";
  if (row.root) {
    const c = document.createElement("span");
    c.className = "count";
    c.textContent = g.ids.length;
    tdCount.append(c);
  }

  tr.append(tdIcon, tdSubject, tdCount);
  return tr;
}

function updateSelectionUI() {
  for (const [id, tr] of state.rowEls) {
    tr.classList.toggle("selected", state.selection.has(id));
    tr.classList.toggle("focused", id === state.focus);
  }
  updateButtons();
}

function updateButtons() {
  const count = effectiveIds().length;
  for (const id of ["btnShow", "btnArchive", "btnMove", "btnDelete"]) {
    $(id).disabled = state.busy || count === 0;
  }
  if (!state.busy && state.groups.length) {
    status(count ? `${count} message(s) selected` : `Scanned ${state.messages.size} messages.`);
  }
}

function scrollToRow(id) {
  state.rowEls.get(id)?.scrollIntoView({ block: "nearest" });
}

/* ------------------------------------------------------------------ *
 * Selection
 * ------------------------------------------------------------------ */

function setFocus(id) {
  state.focus = id;
  updateSelectionUI();
  scrollToRow(id);
}

function selectOnly(id) {
  state.selection = new Set([id]);
  state.anchor = id;
  setFocus(id);
}

function toggleSelect(id) {
  if (state.selection.has(id)) state.selection.delete(id);
  else state.selection.add(id);
  state.anchor = id;
  setFocus(id);
}

function selectRange(toId, additive) {
  const from = state.rowIndex.get(state.anchor ?? toId);
  const to = state.rowIndex.get(toId);
  if (!additive) state.selection.clear();
  for (let i = Math.min(from, to); i <= Math.max(from, to); i++) {
    state.selection.add(state.rows[i].id);
  }
  setFocus(toId);
}

function selectAll() {
  state.selection = new Set(state.rows.map((r) => r.id));
  updateSelectionUI();
}

/**
 * Message ids the next action applies to. Like in Thunderbird, a selected
 * collapsed thread root stands for the whole thread.
 */
function effectiveIds() {
  const out = new Set();
  for (const id of state.selection) {
    const g = state.groupOf.get(id);
    if (!g) continue;
    if (g.ids[0] === id && !state.expanded.has(g.key)) g.ids.forEach((x) => out.add(x));
    else out.add(id);
  }
  return [...out];
}

/* ------------------------------------------------------------------ *
 * Expand / collapse
 * ------------------------------------------------------------------ */

function setExpanded(g, expand) {
  if (expand === state.expanded.has(g.key)) return;
  if (expand) {
    state.expanded.add(g.key);
  } else {
    state.expanded.delete(g.key);
    // Collapsing moves a selection inside the thread to its root.
    const childSelected = g.ids.slice(1).some((id) => state.selection.has(id));
    if (childSelected) state.selection.add(g.ids[0]);
    if (g.ids.includes(state.focus)) state.focus = g.ids[0];
  }
  buildRows();
  render();
  if (state.focus != null) scrollToRow(state.focus);
}

function setAllExpanded(expand) {
  if (expand) {
    for (const g of state.groups) state.expanded.add(g.key);
  } else {
    for (const g of state.groups) {
      if (g.ids.slice(1).some((id) => state.selection.has(id))) state.selection.add(g.ids[0]);
      if (g.ids.includes(state.focus)) state.focus = g.ids[0];
    }
    state.expanded.clear();
  }
  buildRows();
  render();
  if (state.focus != null) scrollToRow(state.focus);
}

/* ------------------------------------------------------------------ *
 * Actions
 * ------------------------------------------------------------------ */

/**
 * Removes messages from the view (after delete/move or external changes)
 * and selects the row that took the place of the first removed one.
 */
function removeMessages(ids) {
  let firstIdx = Infinity;
  let changed = false;
  for (const id of ids) {
    if (state.rowIndex.has(id)) firstIdx = Math.min(firstIdx, state.rowIndex.get(id));
    if (state.messages.delete(id)) changed = true;
  }
  if (!changed) return;
  const hadSelection = state.selection.size > 0;
  rebuild();
  if (hadSelection && state.selection.size === 0 && state.rows.length) {
    const idx = Math.min(Number.isFinite(firstIdx) ? firstIdx : 0, state.rows.length - 1);
    selectOnly(state.rows[idx].id);
  }
}

async function runAction(label, fn, { removes = true } = {}) {
  const ids = effectiveIds();
  if (!ids.length || state.busy) return;
  setBusy(true, `${label} ${ids.length} message(s)…`);
  let ok = false;
  try {
    await fn(ids);
    ok = true;
  } catch (e) {
    console.error(e);
    status(`${label} failed: ${errorText(e)}`, true);
  } finally {
    setBusy(false);
  }
  if (ok) {
    if (removes) removeMessages(ids);
    status(`${label} ${ids.length} message(s): done.`);
  }
  listWrap.focus();
}

const commands = {
  async open() {
    const ids = effectiveIds();
    if (!ids.length) return;
    if (ids.length > 10 && !confirm(`Open ${ids.length} messages in separate tabs?`)) return;
    for (let i = 0; i < ids.length; i++) {
      await browser.messageDisplay.open({ messageId: ids[i], location: "tab", active: i === 0 });
    }
  },

  async show() {
    const ids = effectiveIds();
    if (!ids.length) return;
    try {
      let tabId = state.mailTabId;
      try {
        await browser.mailTabs.get(tabId);
      } catch (e) {
        const [mt] = await browser.mailTabs.query({});
        tabId = mt?.id;
      }
      if (tabId == null) throw new Error("No mail tab available");
      await browser.mailTabs.update(tabId, { displayedFolder: folderRef(state.folder) });
      await browser.mailTabs.setSelectedMessages(tabId, ids);
      await browser.tabs.update(tabId, { active: true });
    } catch (e) {
      status(`Show in folder failed: ${errorText(e)}`, true);
    }
  },

  archive() {
    return runAction("Archiving", (ids) => browser.messages.archive(ids));
  },

  async move() {
    if (!effectiveIds().length) return;
    const dest = await pickFolder("Move to folder");
    if (dest) await runAction("Moving", (ids) => browser.messages.move(ids, folderRef(dest)));
  },

  async copy() {
    if (!effectiveIds().length) return;
    const dest = await pickFolder("Copy to folder");
    if (dest) await runAction("Copying", (ids) => browser.messages.copy(ids, folderRef(dest)), { removes: false });
  },

  delete() {
    return runAction("Deleting", (ids) => browser.messages.delete(ids, { deletePermanently: false }));
  },

  deletePermanent() {
    const n = effectiveIds().length;
    if (!n || !confirm(`Permanently delete ${n} message(s)? This cannot be undone.`)) return;
    return runAction("Deleting", (ids) => browser.messages.delete(ids, { deletePermanently: true }));
  },
};

// Keep the view in sync when messages vanish elsewhere (or through our own actions).
browser.messages.onDeleted.addListener((list) => removeMessages(list.messages.map((m) => m.id)));
browser.messages.onMoved?.addListener((original) => removeMessages(original.messages.map((m) => m.id)));

/* ------------------------------------------------------------------ *
 * Folder picker
 * ------------------------------------------------------------------ */

function sameFolder(a, b) {
  return a && b && a.accountId === b.accountId && a.path === b.path;
}

async function collectFolders() {
  const accounts = await browser.accounts.list(true);
  const out = [];
  const walk = (folders, depth, accountName) => {
    for (const f of folders || []) {
      if (!f.isVirtual && !f.isRoot) {
        out.push({ folder: f, depth, label: f.name, path: `${accountName}/${f.path}` });
      }
      walk(f.subFolders, depth + 1, accountName);
    }
  };
  for (const acc of accounts) {
    out.push({ account: acc.name, depth: 0, label: acc.name, path: acc.name });
    walk(acc.folders ?? acc.rootFolder?.subFolders, 1, acc.name);
  }
  return out;
}

// Thunderbird 121+ wants a MailFolderId; older versions want the MailFolder object.
function folderRef(folder) {
  return folder?.id ?? folder;
}

function pickFolder(title) {
  return new Promise(async (resolve) => {
    const dialog = $("folderDialog");
    const filter = $("folderFilter");
    const list = $("folderList");
    $("folderDialogTitle").textContent = title;

    let entries;
    try {
      entries = await collectFolders();
    } catch (e) {
      status(`Could not list folders: ${errorText(e)}`, true);
      resolve(null);
      return;
    }
    let lastKey = null;
    try { lastKey = localStorage.getItem("lastFolder"); } catch (e) { /* ignore */ }

    let visible = [];
    let active = -1;

    const keyOf = (f) => `${f.accountId}|${f.path}`;
    const setActive = (i) => {
      const opts = list.querySelectorAll(".opt[data-idx]");
      opts.forEach((o) => o.classList.toggle("active", Number(o.dataset.idx) === i));
      active = i;
      list.querySelector(`.opt[data-idx="${i}"]`)?.scrollIntoView({ block: "nearest" });
    };

    const draw = () => {
      const q = filter.value.trim().toLowerCase();
      list.replaceChildren();
      visible = [];
      for (const e of entries) {
        if (q && (e.account || !e.path.toLowerCase().includes(q))) continue;
        const div = document.createElement("div");
        div.className = "opt";
        div.style.paddingLeft = `${8 + (q ? 0 : e.depth * 16)}px`;
        div.textContent = q && e.folder ? e.path : e.label;
        if (e.account) {
          div.classList.add("account");
        } else {
          if (sameFolder(e.folder, state.folder)) div.classList.add("current");
          div.dataset.idx = visible.length;
          visible.push(e);
        }
        list.append(div);
      }
      let idx = 0;
      if (!q && lastKey) {
        const found = visible.findIndex((e) => keyOf(e.folder) === lastKey);
        if (found >= 0) idx = found;
      }
      setActive(visible.length ? idx : -1);
    };

    const finish = (folder) => {
      cleanup();
      if (dialog.open) dialog.close();
      if (folder) {
        try { localStorage.setItem("lastFolder", keyOf(folder)); } catch (e) { /* ignore */ }
      }
      resolve(folder || null);
    };

    const onKey = (ev) => {
      if (ev.key === "ArrowDown") { ev.preventDefault(); setActive(Math.min(active + 1, visible.length - 1)); }
      else if (ev.key === "ArrowUp") { ev.preventDefault(); setActive(Math.max(active - 1, 0)); }
      else if (ev.key === "Enter") { ev.preventDefault(); finish(visible[active]?.folder); }
    };
    const onClick = (ev) => {
      const opt = ev.target.closest(".opt[data-idx]");
      if (opt) setActive(Number(opt.dataset.idx));
    };
    const onDbl = (ev) => {
      const opt = ev.target.closest(".opt[data-idx]");
      if (opt) finish(visible[Number(opt.dataset.idx)]?.folder);
    };
    const onClose = () => finish(dialog.returnValue === "ok" ? visible[active]?.folder : null);
    const cleanup = () => {
      filter.removeEventListener("input", draw);
      filter.removeEventListener("keydown", onKey);
      list.removeEventListener("click", onClick);
      list.removeEventListener("dblclick", onDbl);
      dialog.removeEventListener("close", onClose);
    };

    filter.value = "";
    filter.addEventListener("input", draw);
    filter.addEventListener("keydown", onKey);
    list.addEventListener("click", onClick);
    list.addEventListener("dblclick", onDbl);
    dialog.addEventListener("close", onClose);
    dialog.returnValue = "";
    draw();
    dialog.showModal();
    filter.focus();
  });
}

/* ------------------------------------------------------------------ *
 * Context menu
 * ------------------------------------------------------------------ */

const menu = $("ctxMenu");

function openMenu(x, y) {
  const n = effectiveIds().length;
  for (const b of menu.querySelectorAll("button")) b.disabled = n === 0;
  menu.hidden = false;
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, innerWidth - r.width - 4)}px`;
  menu.style.top = `${Math.min(y, innerHeight - r.height - 4)}px`;
}

function closeMenu() {
  menu.hidden = true;
}

menu.addEventListener("click", (ev) => {
  const cmd = ev.target.closest("button")?.dataset.cmd;
  closeMenu();
  if (cmd) commands[cmd]();
});
document.addEventListener("mousedown", (ev) => {
  if (!menu.hidden && !menu.contains(ev.target)) closeMenu();
});
window.addEventListener("blur", closeMenu);

/* ------------------------------------------------------------------ *
 * List events
 * ------------------------------------------------------------------ */

function rowFromEvent(ev) {
  const tr = ev.target.closest("tr[data-id]");
  return tr ? Number(tr.dataset.id) : null;
}

tbody.addEventListener("mousedown", (ev) => {
  const id = rowFromEvent(ev);
  if (id == null) return;
  listWrap.focus();
  if (ev.button === 2) {
    // Right click on an unselected row selects just that row (like Thunderbird).
    if (!state.selection.has(id)) selectOnly(id);
    return;
  }
  if (ev.button !== 0) return;

  if (ev.target.closest(".twisty")) {
    setExpanded(state.groupOf.get(id), !state.expanded.has(state.groupOf.get(id).key));
    return;
  }
  if (ev.shiftKey) selectRange(id, ev.ctrlKey || ev.metaKey);
  else if (ev.ctrlKey || ev.metaKey) toggleSelect(id);
  else selectOnly(id);
});

tbody.addEventListener("dblclick", (ev) => {
  const id = rowFromEvent(ev);
  if (id == null || ev.target.closest(".twisty")) return;
  browser.messageDisplay.open({ messageId: id, location: "tab" });
});

tbody.addEventListener("contextmenu", (ev) => {
  ev.preventDefault();
  if (rowFromEvent(ev) != null) openMenu(ev.clientX, ev.clientY);
});

listWrap.addEventListener("keydown", (ev) => {
  if (state.busy || !state.rows.length) return;
  const accel = ev.ctrlKey || ev.metaKey;
  const cur = state.focus != null ? state.rowIndex.get(state.focus) : -1;
  const pageSize = Math.max(1, Math.floor(listWrap.clientHeight / 24) - 1);

  const moveTo = (idx) => {
    idx = Math.max(0, Math.min(state.rows.length - 1, idx));
    const id = state.rows[idx].id;
    if (ev.shiftKey) selectRange(id, accel);
    else if (accel) setFocus(id);
    else selectOnly(id);
  };

  const row = cur >= 0 ? state.rows[cur] : null;
  let handled = true;

  switch (ev.key) {
    case "ArrowDown": moveTo(cur + 1); break;
    case "ArrowUp": moveTo(cur < 0 ? 0 : cur - 1); break;
    case "PageDown": moveTo(cur + pageSize); break;
    case "PageUp": moveTo(cur - pageSize); break;
    case "Home": moveTo(0); break;
    case "End": moveTo(state.rows.length - 1); break;
    case " ":
      if (accel && state.focus != null) toggleSelect(state.focus);
      else handled = false;
      break;
    case "ArrowRight":
      if (row?.root) {
        if (!state.expanded.has(row.group.key)) setExpanded(row.group, true);
        else moveTo(cur + 1);
      }
      break;
    case "ArrowLeft":
      if (row) {
        if (row.root) setExpanded(row.group, false);
        else selectOnly(row.group.ids[0]);
      }
      break;
    case "*": setAllExpanded(true); break;
    case "\\": setAllExpanded(false); break;
    case "Enter": commands.open(); break;
    case "Delete":
    case "Backspace":
      if (ev.shiftKey) commands.deletePermanent();
      else commands.delete();
      break;
    case "Escape": closeMenu(); break;
    case "ContextMenu":
      if (state.focus != null) {
        const r = state.rowEls.get(state.focus).getBoundingClientRect();
        openMenu(r.left + 40, r.bottom);
      }
      break;
    default:
      if (accel && ev.key.toLowerCase() === "a") selectAll();
      else if (!accel && !ev.altKey && ev.key.toLowerCase() === "a") commands.archive();
      else if (accel && ev.shiftKey && ev.key.toLowerCase() === "m") commands.move();
      else handled = false;
  }
  if (handled) ev.preventDefault();
});

/* ------------------------------------------------------------------ *
 * Toolbar
 * ------------------------------------------------------------------ */

for (const btn of document.querySelectorAll(".actions button[data-cmd]")) {
  btn.addEventListener("click", () => commands[btn.dataset.cmd]());
}
$("btnRefresh").addEventListener("click", () => load());
$("btnExpand").addEventListener("click", () => setAllExpanded(true));
$("btnCollapse").addEventListener("click", () => setAllExpanded(false));

$("minCount").addEventListener("change", () => {
  const v = parseInt($("minCount").value, 10);
  state.minCount = Number.isInteger(v) && v >= 2 ? v : 4;
  $("minCount").value = state.minCount;
  saveSettings();
  rebuild();
});
$("ignorePrefixes").addEventListener("change", () => {
  state.ignorePrefixes = $("ignorePrefixes").checked;
  saveSettings();
  rebuild();
});

/* ------------------------------------------------------------------ *
 * Start
 * ------------------------------------------------------------------ */

loadSettings();
load().then(() => listWrap.focus());
