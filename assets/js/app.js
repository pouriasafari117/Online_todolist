import {
  $, $$, uid, nowISO, clamp, debounce, CANDY, colorFor, escapeHtml,
  createVault, openVault, vaultToShareCode, shareCodeToVault, fingerprint,
  encryptJSON, decryptJSON, createRememberedBundle, decryptWithRawKey, randomHex,
  GitHub, GhError, STR,
} from "./lib.js";

/* ============================== state ============================== */
const LS = { settings: "tadaa.settings.v1", demo: "tadaa.demo.v1", vault: "tadaa.vault.v1", remembered: "tadaa.remembered.v1", deviceKey: "tadaa.deviceKey.v1" };
const VAULT_PATH = "todolist/vault.json";
const DEFAULT_REPO = "pouriasafari117/Online_todolist";

const state = {
  tasks: [], tombstones: {},
  filter: "all", search: "", sort: "manual",
  settings: { theme: "auto", lang: "fa", motion: "full", sound: false },
  sync: { status: "demo", config: null, passphrase: "", sha: null, vaultSha: null, lastSync: null, updatedAt: null, dirty: false, fp: "" },
  editingId: null, pendingVault: null, online: navigator.onLine,
};
try { Object.assign(state.settings, JSON.parse(localStorage.getItem(LS.settings) || "{}")); } catch {}
const motionPreference = matchMedia("(prefers-reduced-motion: reduce)");
const isMotionReduced = () => state.settings.motion === "reduced" || motionPreference.matches;

const t = (k) => (STR[state.settings.lang] || STR.fa)[k] || STR.fa[k] || k;
const locale = () => (state.settings.lang === "fa" ? "fa-IR" : "en-US");
const num = (n) => Number(n).toLocaleString(locale());
const saveSettings = () => localStorage.setItem(LS.settings, JSON.stringify(state.settings));

/* ============================== task model ============================== */
function makeTask(partial = {}) {
  const ts = nowISO();
  return { id: uid(), title: "", notes: "", priority: "normal", due: "", tags: [], done: false,
    createdAt: ts, updatedAt: ts, completedAt: null, order: Date.now(), ...partial };
}
function persistLocal() {
  if (state.sync.status === "demo" || state.sync.status === "locked") {
    localStorage.setItem(LS.demo, JSON.stringify({ tasks: state.tasks, tombstones: state.tombstones }));
  }
}
function loadDemo() {
  try {
    const d = JSON.parse(localStorage.getItem(LS.demo) || "null");
    if (d && Array.isArray(d.tasks)) { state.tasks = d.tasks; state.tombstones = d.tombstones || {}; return; }
  } catch {}
  // A device that already belongs to a synced list starts empty — never seed demo tasks into a shared list.
  if (localStorage.getItem(LS.vault) || localStorage.getItem(LS.remembered)) { state.tasks = []; return; }
  const day = 864e5, today = new Date(); const iso = (d) => d.toISOString().slice(0, 10);
  state.tasks = [
    makeTask({ title: state.settings.lang === "fa" ? "به Tadaa! خوش اومدی — این یه کار نمایشی‌ه" : "Welcome to Tadaa! — this is a demo task", priority: "high", due: iso(today), tags: [state.settings.lang === "fa" ? "شروع" : "start"], order: 1 }),
    makeTask({ title: state.settings.lang === "fa" ? "منو تیک بزن تا جشن بگیریم" : "Tick me off and let's celebrate", priority: "normal", due: iso(new Date(Date.now() + day)), order: 2 }),
    makeTask({ title: state.settings.lang === "fa" ? "از دکمه ابری بالا، لیست رو به گیت‌هاب وصل کن" : "Connect the list to GitHub from the cloud button", priority: "normal", tags: ["sync"], order: 3 }),
    makeTask({ title: state.settings.lang === "fa" ? "یه کار انجام‌شده برای نمونه" : "A sample completed task", done: true, completedAt: nowISO(), order: 4 }),
  ];
  persistLocal();
}

/* ============================== sync engine ============================== */
const gh = () => new GitHub(state.sync.config?.token || "");
function serializeData() {
  return { version: 2, app: "tadaa", updatedAt: nowISO(), tasks: state.tasks, tombstones: state.tombstones };
}
async function encodeRemote(data) {
  const cfg = state.sync.config;
  if (cfg.encryptData) return JSON.stringify({ format: "tadaa-data", version: 2, encrypted: true, crypto: await encryptJSON(data, state.sync.passphrase) }, null, 2);
  return JSON.stringify({ format: "tadaa-data", version: 2, encrypted: false, data }, null, 2);
}
async function decodeRemote(text) {
  const parsed = JSON.parse(text);
  if (parsed.format !== "tadaa-data") throw new Error("bad-format");
  if (parsed.encrypted) {
    const data = await decryptJSON(parsed.crypto, state.sync.passphrase);
    if (!data) throw new Error("wrong-pass");
    return data;
  }
  return parsed.data;
}
function mergeData(remote) {
  if (!remote || !Array.isArray(remote.tasks)) return;
  const local = new Map(state.tasks.map((x) => [x.id, x]));
  const tombs = { ...state.tombstones, ...(remote.tombstones || {}) };
  for (const [id, ts] of Object.entries(tombs)) {
    const l = local.get(id);
    if (l && ts > l.updatedAt) local.delete(id);
  }
  for (const r of remote.tasks) {
    const deletedAt = tombs[r.id];
    if (deletedAt && deletedAt > r.updatedAt) continue;
    const l = local.get(r.id);
    if (!l || r.updatedAt > l.updatedAt) local.set(r.id, r);
  }
  // union tombstones keeping newest delete time
  const mergedTombs = {};
  for (const src of [state.tombstones, remote.tombstones || {}])
    for (const [id, ts] of Object.entries(src)) if (!mergedTombs[id] || ts > mergedTombs[id]) mergedTombs[id] = ts;
  state.tasks = [...local.values()].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  state.tombstones = mergedTombs;
}
async function pullData() {
  const cfg = state.sync.config;
  const file = await gh().getFile(cfg.repo, cfg.path, cfg.branch);
  if (!file) return null;
  state.sync.sha = file.sha;
  const data = await decodeRemote(file.text);
  state.sync.updatedAt = data.updatedAt || null;
  return data;
}
async function pushData(retry = true) {
  const cfg = state.sync.config;
  const text = await encodeRemote(serializeData());
  try {
    state.sync.sha = await gh().putFile(cfg.repo, cfg.path, text, {
      branch: cfg.branch, sha: state.sync.sha || undefined,
      message: `sync: update tasks from ${cfg.deviceName || "device"} · ${new Date().toISOString()}`,
    });
    state.sync.dirty = false; state.sync.lastSync = Date.now();
  } catch (e) {
    if (retry && (e.status === 409 || e.status === 422)) {
      const remote = await pullData(); mergeData(remote);
      return pushData(false);
    }
    throw e;
  }
}
const schedulePush = debounce(async () => {
  if (!state.sync.config || state.sync.status === "locked") return;
  setSyncStatus("syncing");
  try { await pushData(); setSyncStatus("synced"); renderSync(); }
  catch { setSyncStatus(state.online ? "error" : "offline"); renderSync(); }
}, 1200);

async function fullSync({ quiet = false } = {}) {
  if (!state.sync.config) return;
  setSyncStatus("syncing"); renderSync();
  try {
    const remote = await pullData();
    if (remote) mergeData(remote);
    if (state.sync.dirty || !remote) await pushData();
    state.sync.dirty = false; state.sync.lastSync = Date.now();
    setSyncStatus("synced");
    if (!quiet) toast(t("toast.synced"), "success");
  } catch (e) { setSyncStatus(state.online ? "error" : "offline"); if (!quiet) toast(syncErrText(e), "error"); }
  renderAll(); renderSync();
}
function syncErrText(e) {
  if (!(e instanceof GhError)) return t("err.network");
  if (e.status === 401) return t("err.badToken");
  if (e.status === 403 || e.status === 429) return t("err.forbidden");
  if (e.status === 404) return t("err.repoAccess");
  return t("err.network");
}
function setSyncStatus(s) {
  state.sync.status = s;
  const pill = $("#syncBtn");
  pill.dataset.state = s === "offline" ? "error" : s;
  $("#syncPillText").textContent =
    s === "synced" ? t("pill.synced") : s === "syncing" ? t("pill.syncing") : s === "locked" ? t("pill.locked")
    : s === "error" ? t("pill.error") : s === "offline" ? t("pill.offline") : t("pill.demo");
  const card = $("#syncCard");
  if (card) card.dataset.state = s;
}
function changed() {
  state.sync.dirty = true; persistLocal();
  if (state.sync.config) schedulePush();
  renderAll();
}
/* remembered-device unlock (device key never leaves this browser profile) */
async function saveRemembered() {
  const { key, envelope } = await createRememberedBundle({ config: state.sync.config, passphrase: state.sync.passphrase });
  localStorage.setItem(LS.deviceKey, key);
  localStorage.setItem(LS.remembered, JSON.stringify(envelope));
}
function clearRemembered() {
  localStorage.removeItem(LS.remembered);
  localStorage.removeItem(LS.deviceKey);
}
function clearCredentialInputs() {
  for (const id of ["tokenInput", "passInput", "pass2Input", "joinPassInput", "newPassInput", "newPass2Input"]) {
    const input = document.getElementById(id);
    if (input) input.value = "";
  }
}
async function tryAutoUnlock() {
  const blobRaw = localStorage.getItem(LS.remembered); const key = localStorage.getItem(LS.deviceKey);
  if (!blobRaw || !key) return false;
  const data = await decryptWithRawKey(JSON.parse(blobRaw), key);
  if (!data || !data.config) return false;
  state.sync.config = data.config; state.sync.passphrase = data.passphrase || "";
  state.sync.fp = data.config.vaultId ? await fingerprint(data.config.vaultId) : "";
  setSyncStatus("synced");
  await fullSync({ quiet: true });
  return true;
}

/* ============================== i18n / theme ============================== */
function applyI18n() {
  const dict = STR[state.settings.lang] || STR.fa;
  document.documentElement.lang = state.settings.lang;
  document.documentElement.dir = state.settings.lang === "fa" ? "rtl" : "ltr";
  document.title = state.settings.lang === "fa" ? "Tadaa! — لیست کارهای رنگارنگ و همگام" : "Tadaa! — your colorful synced todo list";
  $$("[data-i18n]").forEach((el) => { const v = dict[el.dataset.i18n]; if (v) el.textContent = v; });
  $$("[data-i18n-placeholder]").forEach((el) => { const v = dict[el.dataset.i18nPlaceholder]; if (v) el.placeholder = v; });
  $$("[data-i18n-aria]").forEach((el) => { const v = dict[el.dataset.i18nAria]; if (v) el.setAttribute("aria-label", v); });
  $$("#themeChoice button").forEach((b) => b.classList.toggle("is-on", b.dataset.themeChoice === state.settings.theme));
  $$("#langChoice button").forEach((b) => b.classList.toggle("is-on", b.dataset.langChoice === state.settings.lang));
  $("#motionSwitch").setAttribute("aria-checked", String(state.settings.motion === "full"));
  $("#soundSwitch").setAttribute("aria-checked", String(!!state.settings.sound));
}
function applyTheme() {
  const choice = state.settings.theme;
  const dark = choice === "dark" || (choice === "auto" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  document.documentElement.dataset.motion = state.settings.motion;
  $("#themeColorMeta").setAttribute("content", dark ? "#17142e" : "#f5f0ff");
  $$("#themeChoice button").forEach((b) => b.classList.toggle("is-on", b.dataset.themeChoice === choice));
}

/* ============================== rendering ============================== */
const taskListEl = $("#taskList"), doneListEl = $("#doneList");
const PRIO_RANK = { high: 0, normal: 1, low: 2 };
function visibleTasks() {
  let list = [...state.tasks];
  const q = state.search.trim().toLowerCase();
  if (q) list = list.filter((x) => x.title.toLowerCase().includes(q) || x.notes.toLowerCase().includes(q) || x.tags.join(" ").toLowerCase().includes(q));
  if (state.sort === "due") list.sort((a, b) => (a.due || "9999") < (b.due || "9999") ? -1 : 1);
  else if (state.sort === "priority") list.sort((a, b) => PRIO_RANK[a.priority] - PRIO_RANK[b.priority]);
  else if (state.sort === "new") list.sort((a, b) => b.createdAt < a.createdAt ? -1 : 1);
  else list.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  return list;
}
function dueInfo(task) {
  if (!task.due || task.done) return task.due ? { text: fmtDate(task.due), cls: "" } : null;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const due = new Date(task.due + "T00:00:00");
  const diff = Math.round((due - today) / 864e5);
  if (diff < 0) return { text: `${fmtDate(task.due)} · ${t("due.overdue")}`, cls: "is-overdue" };
  if (diff === 0) return { text: t("due.today"), cls: "is-today" };
  if (diff === 1) return { text: t("due.tomorrow"), cls: "" };
  return { text: fmtDate(task.due), cls: "" };
}
function fmtDate(iso) {
  try { return new Date(iso + (iso.length === 10 ? "T00:00:00" : "")).toLocaleDateString(locale(), { day: "numeric", month: "short" }); }
  catch { return iso; }
}
function taskEl(task, isNew = false) {
  const el = document.createElement("article");
  el.className = "task" + (task.done ? " is-done" : "") + (isNew ? " is-new" : "");
  el.dataset.id = task.id; el.setAttribute("role", "listitem");
  el.style.setProperty("--tc", colorFor(task.id));
  el.draggable = state.sort === "manual" && state.filter !== "done";
  const due = dueInfo(task);
  el.innerHTML = `
    <button class="task-check" type="button" aria-label="toggle"><svg class="ico"><use href="#i-check"></use></svg></button>
    <div class="task__body">
      <span class="task__title">${escapeHtml(task.title)}</span>
      ${task.notes ? `<p class="task__notes">${escapeHtml(task.notes)}</p>` : ""}
      <div class="task__meta">
        <span class="chip chip--prio-${task.priority}">${t("prio." + task.priority)}</span>
        ${due ? `<span class="chip chip--due ${due.cls}"><svg class="ico"><use href="#i-calendar"></use></svg>${escapeHtml(due.text)}</span>` : ""}
        ${task.tags.map((tag) => `<span class="chip"><svg class="ico"><use href="#i-tag"></use></svg>${escapeHtml(tag)}</span>`).join("")}
      </div>
    </div>
    <span class="task__drag" aria-hidden="true"><svg class="ico"><use href="#i-drag"></use></svg></span>
    <div class="task__actions">
      <button class="task-btn" type="button" data-act="edit" aria-label="edit"><svg class="ico"><use href="#i-pencil"></use></svg></button>
      <button class="task-btn task-btn--del" type="button" data-act="del" aria-label="delete"><svg class="ico"><use href="#i-trash"></use></svg></button>
    </div>`;
  $(".task-check", el).addEventListener("click", (e) => { e.stopPropagation(); toggleTask(task.id, el); });
  $("[data-act='edit']", el).addEventListener("click", (e) => { e.stopPropagation(); openTaskDialog(task.id); });
  $("[data-act='del']", el).addEventListener("click", (e) => { e.stopPropagation(); deleteTask(task.id, el); });
  el.addEventListener("click", () => openTaskDialog(task.id));
  wireDrag(el, task.id);
  return el;
}
function renderTasks(newId = null) {
  const list = visibleTasks();
  const active = list.filter((x) => !x.done), done = list.filter((x) => x.done);
  const showActive = state.filter !== "done", showDone = state.filter !== "active";
  taskListEl.innerHTML = ""; doneListEl.innerHTML = "";
  if (showActive) active.forEach((x) => taskListEl.appendChild(taskEl(x, x.id === newId)));
  if (showDone) done.forEach((x) => doneListEl.appendChild(taskEl(x)));
  taskListEl.style.display = showActive ? "" : "none";
  $("#doneBlock").hidden = !showDone || (state.filter === "all" && done.length === 0 && !state.search);
  if (state.filter === "done") $("#doneBlock").hidden = false;
  const empty = $("#emptyState");
  const nothing = (showActive ? active.length : 0) + (showDone ? done.length : 0) === 0;
  empty.hidden = !nothing;
  if (nothing) {
    const searching = !!state.search;
    $("#emptyTitle").textContent = searching ? t("empty.searchTitle") : state.filter === "done" ? t("empty.doneTitle") : t("empty.title");
    $("#emptyText").textContent = searching ? t("empty.searchText") : state.filter === "done" ? t("empty.doneText") : t("empty.text");
  }
  $("#countAll").textContent = num(state.tasks.length);
  $("#countActive").textContent = num(state.tasks.filter((x) => !x.done).length);
  $("#countDone").textContent = num(state.tasks.filter((x) => x.done).length);
  $("#activeCountLabel").textContent = `${num(active.length)} ${t("count.tasks")}`;
  $("#doneCountLabel").textContent = num(done.length);
  positionFilterPill();
}
function renderStats() {
  const total = state.tasks.length, doneTasks = state.tasks.filter((x) => x.done);
  const pct = total ? Math.round((doneTasks.length / total) * 100) : 0;
  $("#progressRing").style.strokeDashoffset = String(314 - (314 * pct) / 100);
  $("#progressPct").textContent = num(pct) + (state.settings.lang === "fa" ? "٪" : "%");
  $("#statActive").textContent = num(total - doneTasks.length);
  const todayKey = new Date().toDateString();
  $("#statDoneToday").textContent = num(doneTasks.filter((x) => x.completedAt && new Date(x.completedAt).toDateString() === todayKey).length);
  // streak: consecutive days (ending today or yesterday) with >=1 completion
  const days = new Set(doneTasks.filter((x) => x.completedAt).map((x) => new Date(x.completedAt).toDateString()));
  let streak = 0; const cursor = new Date();
  if (!days.has(cursor.toDateString())) cursor.setDate(cursor.getDate() - 1);
  while (days.has(cursor.toDateString())) { streak++; cursor.setDate(cursor.getDate() - 1); }
  $("#statStreak").textContent = num(streak);
  // week bars
  const bars = $("#weekBars"); bars.innerHTML = "";
  let sum = 0;
  for (let i = 6; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const count = doneTasks.filter((x) => x.completedAt && new Date(x.completedAt).toDateString() === d.toDateString()).length;
    sum += count;
    const wrap = document.createElement("div");
    wrap.className = "week__bar" + (i === 0 ? " is-today" : "");
    wrap.innerHTML = `<i style="height:${clamp(6 + count * 13, 6, 50)}px"></i><span>${d.toLocaleDateString(locale(), { weekday: "narrow" })}</span>`;
    bars.appendChild(wrap);
  }
  $("#weekTotal").textContent = num(sum);
}
function renderSync() {
  const s = state.sync.status, cfg = state.sync.config;
  const title = $("#syncCardTitle"), text = $("#syncCardText"), btn = $("#syncCardBtn");
  if (s === "locked") { title.textContent = t("sync.lockedTitle"); text.textContent = t("sync.lockedText"); btn.textContent = t("sync.lockedBtn"); }
  else if (cfg) {
    title.textContent = s === "error" || s === "offline" ? t("sync.errorTitle") : t("sync.syncedTitle");
    text.textContent = cfg.repo + (state.sync.lastSync ? " · " + new Date(state.sync.lastSync).toLocaleTimeString(locale()) : "");
    btn.textContent = s === "error" || s === "offline" ? t("sync.retry") : t("sync.now");
  } else { title.textContent = t("sync.demoTitle"); text.textContent = t("sync.demoText"); btn.textContent = t("sync.connect"); }
  const has = !!cfg;
  $("#syncDetails").hidden = !has;
  $("#settingsSyncTitle").textContent = has ? t("sync.syncedTitle") : t("pill.demo");
  if (has) {
    $("#detailRepo").textContent = cfg.repo;
    $("#detailBranch").textContent = cfg.branch;
    $("#detailLast").textContent = state.sync.lastSync ? new Date(state.sync.lastSync).toLocaleString(locale()) : "—";
    $("#detailFingerprint").textContent = state.sync.fp || "—";
    $("#settingsSyncText").textContent = cfg.repo;
  } else $("#settingsSyncText").textContent = t("sync.settingsDemo");
  $("#inviteBtn").disabled = !has; $("#changePassBtn").disabled = !has; $("#syncNowBtn").disabled = !has; $("#disconnectBtn").disabled = !has && s !== "locked";
}
function renderAll() { renderTasks(); renderStats(); }
function positionFilterPill() {
  const btn = $("#filterBar .segmented__btn.is-on"), pill = $("#filterPill");
  if (!btn || !pill) return;
  pill.style.width = btn.offsetWidth + "px";
  pill.style.left = btn.offsetLeft + "px";
}

/* ============================== task actions ============================== */
let audioCtx = null;
function blip(freq = 660, dur = 0.09, type = "sine", gain = 0.05) {
  if (!state.settings.sound) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.type = type; o.frequency.value = freq;
    g.gain.setValueAtTime(gain, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + dur);
    o.connect(g).connect(audioCtx.destination); o.start(); o.stop(audioCtx.currentTime + dur);
  } catch {}
}
function toggleTask(id, el) {
  const task = state.tasks.find((x) => x.id === id); if (!task) return;
  task.done = !task.done; task.completedAt = task.done ? nowISO() : null; task.updatedAt = nowISO();
  const check = el?.querySelector(".task-check");
  if (check) check.classList.add("pop-check");
  blip(task.done ? 880 : 440, 0.1, "sine", 0.06);
  if (task.done) {
    confetti(el);
    toast(t("toast.done"), "success");
    const activeLeft = state.tasks.filter((x) => !x.done).length;
    if (activeLeft === 0 && state.tasks.length > 2) setTimeout(showCelebration, 450);
  }
  changed();
}
function deleteTask(id, el) {
  const idx = state.tasks.findIndex((x) => x.id === id); if (idx < 0) return;
  const [removed] = state.tasks.splice(idx, 1);
  state.tombstones[id] = nowISO();
  if (el) { el.classList.add("is-leaving"); setTimeout(() => changed(), 320); } else changed();
  persistLocal();
  toast(t("toast.deleted"), "info", { label: t("toast.undo"), fn: () => {
    state.tasks.splice(Math.min(idx, state.tasks.length), 0, removed);
    delete state.tombstones[id]; changed();
  }});
}
function addTaskFromForm(e) {
  e.preventDefault();
  const title = $("#newTitle").value.trim(); if (!title) { $("#newTitle").closest(".composer__field").classList.add("shake"); setTimeout(() => $(".composer__field")?.classList.remove("shake"), 500); return; }
  const prio = $("#addForm .prio-dot.is-on")?.dataset.prio || "normal";
  const tags = $("#newTags").value.split(/[،,]/).map((x) => x.trim()).filter(Boolean).slice(0, 6);
  const task = makeTask({ title, priority: prio, due: $("#newDue").value || "", tags, order: Math.min(0, ...state.tasks.map((x) => x.order ?? 0)) - 1 });
  state.tasks.unshift(task);
  $("#newTitle").value = ""; $("#newTags").value = ""; $("#newDue").value = "";
  blip(720, 0.07, "triangle", 0.04);
  toast(t("toast.added"), "success");
  changed(); renderTasks(task.id);
  $("#taskList .task")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
}
/* drag reorder */
let dragId = null;
function wireDrag(el, id) {
  el.addEventListener("dragstart", (e) => { dragId = id; el.classList.add("is-dragging"); e.dataTransfer.effectAllowed = "move"; try { e.dataTransfer.setData("text/plain", id); } catch {} });
  el.addEventListener("dragend", () => { dragId = null; $$(".task").forEach((x) => x.classList.remove("is-dragging", "is-drop-target")); });
  el.addEventListener("dragover", (e) => { if (dragId && dragId !== id) { e.preventDefault(); el.classList.add("is-drop-target"); } });
  el.addEventListener("dragleave", () => el.classList.remove("is-drop-target"));
  el.addEventListener("drop", (e) => {
    e.preventDefault(); el.classList.remove("is-drop-target");
    if (!dragId || dragId === id) return;
    const from = state.tasks.findIndex((x) => x.id === dragId), to = state.tasks.findIndex((x) => x.id === id);
    const [moved] = state.tasks.splice(from, 1); state.tasks.splice(to, 0, moved);
    state.tasks.forEach((x, i) => { x.order = i; });
    moved.updatedAt = nowISO(); changed();
  });
}

/* ============================== dialogs ============================== */
function openDialog(d) { if (!d.open) d.showModal(); }
function closeDialog(d) { if (d.open) d.close(); }
$$("dialog").forEach((d) => {
  d.addEventListener("click", (e) => { if (e.target === d) closeDialog(d); });
  $$("[data-close]", d).forEach((b) => b.addEventListener("click", () => closeDialog(d)));
});
let confirmResolve = null;
function askConfirm(text) {
  $("#confirmText").textContent = text; $("#confirmTitle").textContent = t("confirm.title");
  openDialog($("#confirmDialog"));
  return new Promise((res) => (confirmResolve = res));
}
$("#confirmOk").addEventListener("click", () => { closeDialog($("#confirmDialog")); confirmResolve?.(true); });
$("#confirmDialog").addEventListener("close", () => confirmResolve?.(false));

/* edit task */
function setPrioPick(container, value) {
  $$(".prio-dot", container).forEach((b) => { const on = b.dataset.prio === value; b.classList.toggle("is-on", on); b.setAttribute("aria-checked", String(on)); });
}
function getPrioPick(container) { return $(".prio-dot.is-on", container)?.dataset.prio || "normal"; }
$$(".prio-pick").forEach((pick) => $$(".prio-dot", pick).forEach((b) => b.addEventListener("click", () => { setPrioPick(pick, b.dataset.prio); blip(560, 0.05, "triangle", 0.03); })));
function openTaskDialog(id) {
  const task = state.tasks.find((x) => x.id === id); if (!task) return;
  state.editingId = id;
  $("#editTitle").value = task.title; $("#editNotes").value = task.notes || "";
  $("#editDue").value = task.due || ""; $("#editTags").value = (task.tags || []).join("، ");
  setPrioPick($("#editPrio"), task.priority);
  openDialog($("#taskDialog"));
  setTimeout(() => $("#editTitle").focus(), 60);
}
$("#taskForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const task = state.tasks.find((x) => x.id === state.editingId); if (!task) return;
  task.title = $("#editTitle").value.trim() || task.title;
  task.notes = $("#editNotes").value.trim();
  task.priority = getPrioPick($("#editPrio"));
  task.due = $("#editDue").value || "";
  task.tags = $("#editTags").value.split(/[،,]/).map((x) => x.trim()).filter(Boolean).slice(0, 6);
  task.updatedAt = nowISO();
  closeDialog($("#taskDialog")); toast(t("toast.saved"), "success"); changed();
});
$("#taskDeleteBtn").addEventListener("click", async () => {
  if (await askConfirm(t("confirm.deleteTask"))) { closeDialog($("#taskDialog")); deleteTask(state.editingId, null); }
});
$$("#dueQuick button").forEach((b) => b.addEventListener("click", () => {
  if (b.dataset.days === "clear") { $("#editDue").value = ""; return; }
  const d = new Date(); d.setDate(d.getDate() + Number(b.dataset.days));
  $("#editDue").value = d.toISOString().slice(0, 10);
}));

/* ============================== toasts / fx ============================== */
function toast(msg, kind = "success", action = null) {
  const el = document.createElement("div");
  el.className = "toast toast--" + kind;
  el.innerHTML = `<span class="toast__icon"><svg class="ico"><use href="#i-${kind === "error" ? "alert" : kind === "info" ? "info" : "check"}"></use></svg></span><span>${escapeHtml(msg)}</span>`;
  if (action) {
    const b = document.createElement("button"); b.type = "button"; b.textContent = action.label;
    b.addEventListener("click", () => { action.fn(); dismiss(); }); el.appendChild(b);
  }
  $("#toasts").appendChild(el);
  const dismiss = () => { el.classList.add("is-out"); setTimeout(() => el.remove(), 300); };
  setTimeout(dismiss, action ? 5200 : 3400);
}
/* confetti canvas */
const fx = $("#fxCanvas"), fxCtx = fx.getContext("2d");
let particles = [], fxRunning = false;
function sizeFx() { fx.width = innerWidth * devicePixelRatio; fx.height = innerHeight * devicePixelRatio; }
addEventListener("resize", sizeFx); sizeFx();
function confetti(anchorEl) {
  if (isMotionReduced()) return;
  const r = anchorEl?.getBoundingClientRect();
  const cx = (r ? r.left + 30 : innerWidth / 2) * devicePixelRatio, cy = (r ? r.top + 20 : innerHeight / 3) * devicePixelRatio;
  for (let i = 0; i < 42; i++) {
    const a = Math.random() * Math.PI * 2, sp = (2 + Math.random() * 6) * devicePixelRatio;
    particles.push({ x: cx, y: cy, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 3 * devicePixelRatio, g: 0.16 * devicePixelRatio, life: 46 + Math.random() * 26, size: (4 + Math.random() * 6) * devicePixelRatio, color: CANDY[i % CANDY.length], rot: Math.random() * 6, vr: (Math.random() - 0.5) * 0.3, shape: i % 3 });
  }
  if (!fxRunning) { fxRunning = true; requestAnimationFrame(fxTick); }
}
function fxTick() {
  fxCtx.clearRect(0, 0, fx.width, fx.height);
  particles = particles.filter((p) => p.life > 0);
  for (const p of particles) {
    p.x += p.vx; p.y += p.vy; p.vy += p.g; p.vx *= 0.985; p.rot += p.vr; p.life--;
    fxCtx.save(); fxCtx.translate(p.x, p.y); fxCtx.rotate(p.rot); fxCtx.globalAlpha = clamp(p.life / 40, 0, 1); fxCtx.fillStyle = p.color;
    if (p.shape === 0) fxCtx.beginPath(), fxCtx.arc(0, 0, p.size / 2, 0, 7), fxCtx.fill();
    else if (p.shape === 1) fxCtx.fillRect(-p.size / 2, -p.size / 3, p.size, p.size * 0.66);
    else { fxCtx.beginPath(); fxCtx.moveTo(0, -p.size / 2); fxCtx.lineTo(p.size / 2, p.size / 2); fxCtx.lineTo(-p.size / 2, p.size / 2); fxCtx.fill(); }
    fxCtx.restore();
  }
  if (particles.length) requestAnimationFrame(fxTick);
  else { fxRunning = false; fxCtx.clearRect(0, 0, fx.width, fx.height); }
}
function showCelebration() {
  const c = $("#celebration"); c.hidden = false;
  confetti(null); setTimeout(() => confetti(null), 220);
  blip(880, 0.12, "triangle", 0.05); setTimeout(() => blip(1174, 0.14, "triangle", 0.05), 130);
}
$("#celebrateClose").addEventListener("click", () => ($("#celebration").hidden = true));
$("#celebration").addEventListener("click", (e) => { if (e.target.id === "celebration") e.currentTarget.hidden = true; });

/* ============================== sync UI flows ============================== */
function showError(el, msg) { el.textContent = msg; el.hidden = !msg; if (msg) { el.classList.remove("shake"); void el.offsetWidth; el.classList.add("shake"); } }
function setBusy(btn, busy) { btn.classList.toggle("is-loading", busy); btn.disabled = busy; }
function passStrength(p) {
  let s = 0; if (p.length >= 10) s++; if (p.length >= 14) s++; if (/[0-9]/.test(p)) s++; if (/[^A-Za-z0-9]/.test(p) || /\s/.test(p)) s++; if (p.split(/\s+/).length >= 3) s++;
  return clamp(s / 5, 0.08, 1);
}
$("#passInput").addEventListener("input", (e) => ($("#passMeter").style.width = passStrength(e.target.value) * 100 + "%"));
$("#newPassInput").addEventListener("input", (e) => ($("#newPassMeter").style.width = passStrength(e.target.value) * 100 + "%"));
$$(".reveal-btn").forEach((b) => b.addEventListener("click", () => {
  const input = document.getElementById(b.dataset.reveal);
  input.type = input.type === "password" ? "text" : "password"; input.focus();
}));
$$(".copy-btn[data-copy]").forEach((b) => b.addEventListener("click", async () => {
  const input = document.getElementById(b.dataset.copy);
  try { await navigator.clipboard.writeText(input.value); toast(t("toast.copied"), "success"); } catch { input.select(); document.execCommand("copy"); }
}));

$$(".settings-tabs button").forEach((b) => b.addEventListener("click", () => $$(".settings-pane").forEach((p) => p.classList.toggle("is-on", p.dataset.pane === b.dataset.stab))));
$$(".connect-tabs button").forEach((b) => b.addEventListener("click", () => {
  $$(".connect-tabs button").forEach((x) => { x.classList.toggle("is-on", x === b); x.setAttribute("aria-selected", String(x === b)); });
  $$(".connect-pane").forEach((p) => p.classList.toggle("is-on", p.dataset.cpane === b.dataset.ctab));
  if (b.dataset.ctab === "join") detectVault();
}));
$("#settingsBtn").addEventListener("click", () => { openDialog($("#settingsDialog")); renderSync(); });
$("#syncBtn").addEventListener("click", () => {
  if (state.sync.status === "locked" || !state.sync.config) { openDialog($("#connectDialog")); detectVault(); }
  else openDialog($("#settingsDialog")), $$(".settings-tabs button").find((b) => b.dataset.stab === "sync")?.click(), renderSync();
});
$("#syncCardBtn").addEventListener("click", () => {
  if (!state.sync.config || state.sync.status === "locked") { openDialog($("#connectDialog")); detectVault(); }
  else fullSync();
});
$("#helpBtn").addEventListener("click", () => { openDialog($("#settingsDialog")); $$(".settings-tabs button").find((b) => b.dataset.stab === "about")?.click(); });
$("#exploreDemoBtn").addEventListener("click", () => closeDialog($("#connectDialog")));

async function detectVault() {
  const banner = $("#vaultBanner"); if (!banner || state.pendingVault) return;
  banner.dataset.state = "searching";
  $("#vaultBannerTitle").textContent = t("vault.searching"); $("#vaultBannerText").textContent = t("vault.searchingText");
  // 1) vault left in this browser  2) vault published on this site (GitHub Pages)
  try {
    const local = JSON.parse(localStorage.getItem(LS.vault) || "null");
    if (local?.format === "tadaa-vault") { state.pendingVault = local; banner.dataset.state = "found"; $("#vaultBannerTitle").textContent = t("vault.found"); $("#vaultBannerText").textContent = t("vault.foundText"); return; }
  } catch {}
  try {
    const res = await fetch("./todolist/vault.json", { cache: "no-store" });
    if (res.ok) {
      const v = await res.json();
      if (v?.format === "tadaa-vault") { state.pendingVault = v; banner.dataset.state = "found"; $("#vaultBannerTitle").textContent = t("vault.found"); $("#vaultBannerText").textContent = t("vault.foundText"); return; }
    }
  } catch {}
  banner.dataset.state = "missing";
  $("#vaultBannerTitle").textContent = t("vault.missing"); $("#vaultBannerText").textContent = t("vault.missingText");
}
$("#useShareCodeBtn").addEventListener("click", () => {
  const v = shareCodeToVault($("#shareCodeInput").value);
  const banner = $("#vaultBanner");
  if (!v) { showError($("#joinError"), t("err.badCode")); return; }
  state.pendingVault = v; banner.dataset.state = "found";
  $("#vaultBannerTitle").textContent = t("vault.fromCode"); $("#vaultBannerText").textContent = t("vault.fromCodeText");
  showError($("#joinError"), "");
});

/* owner connect */
$("#connectBtn").addEventListener("click", async () => {
  const err = $("#ownerError"); showError(err, "");
  const repo = $("#repoInput").value.trim().replace(/^https?:\/\/github\.com\//, "").replace(/\/$/, "");
  const token = $("#tokenInput").value.trim();
  const pass = $("#passInput").value, pass2 = $("#pass2Input").value;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return showError(err, t("err.repo"));
  if (!token) return showError(err, t("err.token"));
  if (pass.length < 10) return showError(err, t("err.passShort"));
  if (pass !== pass2) return showError(err, t("err.passMatch"));
  const btn = $("#connectBtn"); setBusy(btn, true);
  try {
    const client = new GitHub(token);
    const info = await client.repoInfo(repo);
    const defaultBranch = info.default_branch || "main";
    const branch = $("#branchInput").value.trim() || "todolist-data";
    const path = $("#pathInput").value.trim() || "data/todos.json";
    await client.ensureBranch(repo, branch, defaultBranch);
    const config = { repo, branch, path, token, encryptData: $("#encryptToggle").checked, deviceName: $("#deviceNameInput").value.trim() || t("device.default"), vaultId: "" };
    const vault = await createVault(config, pass);
    config.vaultId = vault.vaultId;
    state.sync.config = config; state.sync.passphrase = pass; state.sync.fp = await fingerprint(vault.vaultId);
    localStorage.setItem(LS.vault, JSON.stringify(vault));
    if ($("#publishToggle").checked) {
      const existing = await client.getFile(repo, VAULT_PATH, defaultBranch);
      state.sync.vaultSha = await client.putFile(repo, VAULT_PATH, JSON.stringify(vault, null, 2), {
        branch: defaultBranch, sha: existing?.sha, message: "sync: publish encrypted vault",
      });
    }
    if ($("#ownerRememberToggle").checked) await saveRemembered(); else clearRemembered();
    setSyncStatus("syncing");
    const remote = await pullData();
    if (remote) mergeData(remote);
    await pushData();
    setSyncStatus("synced"); state.sync.lastSync = Date.now();
    clearCredentialInputs();
    closeDialog($("#connectDialog"));
    toast(t("toast.connected"), "success"); confetti(null);
    renderAll(); renderSync();
  } catch (e) { showError(err, syncErrText(e)); }
  finally { setBusy(btn, false); }
});
/* join with password */
$("#joinBtn").addEventListener("click", async () => {
  const err = $("#joinError"); showError(err, "");
  if (!state.pendingVault) { await detectVault(); if (!state.pendingVault) return showError(err, t("err.noVault")); }
  const pass = $("#joinPassInput").value;
  if (!pass) return showError(err, t("err.passShort"));
  const btn = $("#joinBtn"); setBusy(btn, true);
  try {
    const payload = await openVault(state.pendingVault, pass);
    if (!payload) return showError(err, t("err.wrongPass"));
    state.sync.config = { repo: payload.repo, branch: payload.branch, path: payload.path, token: payload.token, encryptData: payload.encryptData !== false, deviceName: payload.deviceName || t("device.default"), vaultId: payload.vaultId };
    state.sync.passphrase = pass; state.sync.fp = await fingerprint(payload.vaultId);
    localStorage.setItem(LS.vault, JSON.stringify(state.pendingVault));
    if ($("#rememberToggle").checked) await saveRemembered(); else clearRemembered();
    setSyncStatus("syncing");
    const remote = await pullData();
    if (remote) mergeData(remote); else await pushData();
    setSyncStatus("synced"); state.sync.lastSync = Date.now();
    clearCredentialInputs();
    closeDialog($("#connectDialog"));
    toast(t("toast.unlocked"), "success"); confetti(null);
    renderAll(); renderSync();
  } catch (e) { showError(err, syncErrText(e)); }
  finally { setBusy(btn, false); }
});
/* settings sync actions */
$("#syncNowBtn").addEventListener("click", () => fullSync());
$("#inviteBtn").addEventListener("click", async () => {
  if (!state.sync.config) return;
  $("#inviteLink").value = location.origin + location.pathname;
  $("#inviteFingerprint").textContent = state.sync.fp || "—";
  openDialog($("#inviteDialog"));
});
$("#copyInviteBtn").addEventListener("click", async () => {
  const msg = state.settings.lang === "fa"
    ? `سلام! لیست کارهای مشترکمون اینجاست:\n${location.origin + location.pathname}\nتب «با رمز سینک وارد می‌شم» رو بزن و رمز سینک رو وارد کن (رمز رو جداگانه بهت می‌گم).\nشناسه سینک: ${state.sync.fp}`
    : `Hi! Our shared todo list is here:\n${location.origin + location.pathname}\nChoose “Join with sync password” and enter the sync password (I'll send it separately).\nSync ID: ${state.sync.fp}`;
  try { await navigator.clipboard.writeText(msg); toast(t("toast.copied"), "success"); } catch {}
});
$("#copyCodeBtn").addEventListener("click", async () => {
  try {
    const vault = JSON.parse(localStorage.getItem(LS.vault) || "null");
    if (vault) { await navigator.clipboard.writeText(vaultToShareCode(vault)); toast(t("toast.copied"), "success"); }
  } catch {}
});
$("#changePassBtn").addEventListener("click", () => { showError($("#passError"), ""); openDialog($("#passwordDialog")); });
$("#passwordForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = $("#passError"); showError(err, "");
  const p1 = $("#newPassInput").value, p2 = $("#newPass2Input").value;
  if (p1.length < 10) return showError(err, t("err.passShort"));
  if (p1 !== p2) return showError(err, t("err.passMatch"));
  if (!state.sync.config || !state.sync.passphrase) return showError(err, t("err.wrongPass"));
  try {
    const cfg = state.sync.config;
    const vault = await createVault({ ...cfg, vaultId: cfg.vaultId }, p1);
    const client = gh();
    const info = await client.repoInfo(cfg.repo);
    const existing = await client.getFile(cfg.repo, VAULT_PATH, info.default_branch || "main");
    await client.putFile(cfg.repo, VAULT_PATH, JSON.stringify(vault, null, 2), { branch: info.default_branch || "main", sha: existing?.sha, message: "sync: rotate sync password" });
    state.sync.passphrase = p1;
    localStorage.setItem(LS.vault, JSON.stringify(vault));
    if (localStorage.getItem(LS.remembered)) await saveRemembered();
    await pushData(); // re-encrypt data with the new password
    clearCredentialInputs();
    closeDialog($("#passwordDialog"));
    toast(t("toast.passChanged"), "success"); renderSync();
  } catch (ex) { showError(err, syncErrText(ex)); }
});
$("#disconnectBtn").addEventListener("click", async () => {
  if (!(await askConfirm(t("confirm.disconnect")))) return;
  localStorage.removeItem(LS.vault); clearRemembered();
  clearCredentialInputs();
  state.sync.config = null; state.sync.passphrase = ""; state.pendingVault = null;
  setSyncStatus("demo"); persistLocal();
  closeDialog($("#settingsDialog"));
  toast(t("toast.disconnected"), "info"); renderAll(); renderSync();
});

/* settings: look */
$("#themeBtn").addEventListener("click", () => {
  const cur = document.documentElement.dataset.theme;
  state.settings.theme = cur === "dark" ? "light" : "dark";
  saveSettings(); applyTheme(); blip(cur === "dark" ? 740 : 520, 0.07, "triangle", 0.04);
});
$$("#themeChoice button").forEach((b) => b.addEventListener("click", () => { state.settings.theme = b.dataset.themeChoice; saveSettings(); applyTheme(); }));
$$("#langChoice button").forEach((b) => b.addEventListener("click", () => {
  state.settings.lang = b.dataset.langChoice; saveSettings(); applyI18n(); renderAll(); renderSync(); updateHeader(); positionFilterPill();
}));
$("#motionSwitch").addEventListener("click", () => {
  state.settings.motion = state.settings.motion === "full" ? "reduced" : "full";
  saveSettings(); applyTheme(); applyI18n();
});
$("#soundSwitch").addEventListener("click", () => {
  state.settings.sound = !state.settings.sound; saveSettings(); applyI18n(); blip(880, 0.08, "sine", 0.05);
});
$("#exportBtn").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(serializeData(), null, 2)], { type: "application/json" });
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob);
  a.download = `tadaa-backup-${new Date().toISOString().slice(0, 10)}.json`; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
});
$("#importBtn").addEventListener("click", () => $("#importFile").click());
$("#importFile").addEventListener("change", async (e) => {
  const file = e.target.files[0]; if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const incoming = data.tasks || data.data?.tasks;
    if (!Array.isArray(incoming)) throw new Error("bad");
    mergeData({ tasks: incoming, tombstones: data.tombstones || {} });
    changed(); toast(t("toast.imported"), "success");
  } catch { toast(t("err.badCode"), "error"); }
  e.target.value = "";
});

/* filters / search / sort */
$$("#filterBar .segmented__btn").forEach((b) => b.addEventListener("click", () => {
  state.filter = b.dataset.filter;
  $$("#filterBar .segmented__btn").forEach((x) => { x.classList.toggle("is-on", x === b); x.setAttribute("aria-selected", String(x === b)); });
  blip(600, 0.05, "triangle", 0.03); renderTasks();
}));
$("#searchInput").addEventListener("input", debounce((e) => {
  state.search = e.target.value;
  $(".search").classList.toggle("has-text", !!state.search);
  renderTasks();
}, 160));
$("#searchClear").addEventListener("click", () => { $("#searchInput").value = ""; state.search = ""; $(".search").classList.remove("has-text"); renderTasks(); });
$("#sortSelect").addEventListener("change", (e) => { state.sort = e.target.value; renderTasks(); });
$("#clearDoneBtn").addEventListener("click", async (e) => {
  e.stopPropagation();
  if (!(await askConfirm(t("confirm.clearDone")))) return;
  state.tasks.filter((x) => x.done).forEach((x) => (state.tombstones[x.id] = nowISO()));
  state.tasks = state.tasks.filter((x) => !x.done);
  changed(); toast(t("toast.clearedDone"), "info");
});
$("#doneToggle").addEventListener("click", () => {
  const list = $("#doneList"); const open = list.style.display !== "none";
  list.style.display = open ? "none" : "";
  $("#doneToggle").setAttribute("aria-expanded", String(!open));
});
$("#addForm").addEventListener("submit", addTaskFromForm);
$("#tuneBtn").addEventListener("click", () => {
  const more = $("#composerMore"); const open = more.hidden;
  more.hidden = !open; $("#tuneBtn").setAttribute("aria-expanded", String(open));
  if (open) $("#newTags").focus();
});
$("#emptyAddBtn").addEventListener("click", () => { $("#newTitle").focus(); $("#newTitle").scrollIntoView({ behavior: "smooth", block: "center" }); });

/* header */
function updateHeader() {
  const h = new Date().getHours();
  $("#greetingText").textContent = t(h < 5 ? "greeting.night" : h < 11 ? "greeting.morning" : h < 15 ? "greeting.noon" : h < 19 ? "greeting.evening" : "greeting.night");
  $("#dateText").textContent = new Date().toLocaleDateString(locale(), { weekday: "long", day: "numeric", month: "long" });
}
setInterval(updateHeader, 60000);

/* keyboard shortcuts */
addEventListener("keydown", (e) => {
  const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || "") || document.activeElement?.isContentEditable;
  if (e.key === "Escape") { $$("dialog[open]").forEach(closeDialog); $("#celebration").hidden = true; return; }
  if (typing) return;
  const k = e.key.toLowerCase();
  if (k === "n") { e.preventDefault(); $("#newTitle").focus(); }
  else if (e.key === "/") { e.preventDefault(); $("#searchInput").focus(); }
  else if (k === "t") $("#themeBtn").click();
  else if (k === "g") { if (state.sync.config) fullSync(); else { openDialog($("#connectDialog")); detectVault(); } }
  else if (e.key === "?") { openDialog($("#settingsDialog")); $$(".settings-tabs button").find((b) => b.dataset.stab === "about")?.click(); }
});

/* online/offline + polling */
addEventListener("online", () => { state.online = true; if (state.sync.config) fullSync({ quiet: true }); });
addEventListener("offline", () => { state.online = false; if (state.sync.config) setSyncStatus("offline"); renderSync(); });
document.addEventListener("visibilitychange", () => { if (!document.hidden && state.sync.config) fullSync({ quiet: true }); });
setInterval(() => { if (!document.hidden && state.sync.config && state.online) fullSync({ quiet: true }); }, 45000);

/* ============================== playful fx ============================== */
function buildSparkles() {
  const field = $("#sparkleField"); if (!field) return;
  const glyphs = ["✦", "✧", "❋", "·"];
  for (let i = 0; i < 26; i++) {
    const s = document.createElement("i");
    s.textContent = glyphs[i % glyphs.length];
    s.style.left = Math.random() * 100 + "%"; s.style.top = Math.random() * 100 + "%";
    s.style.setProperty("--tw", 3 + Math.random() * 4 + "s");
    s.style.setProperty("--td", Math.random() * 4 + "s");
    s.style.setProperty("--ts", 9 + Math.random() * 9 + "px");
    s.style.color = CANDY[i % CANDY.length];
    field.appendChild(s);
  }
}
/* custom cursor + magnetic buttons */
(function cursorFx() {
  if (!matchMedia("(hover:hover) and (pointer:fine)").matches) return;
  const cursor = $("#cursor"), ring = $(".cursor__ring"), dot = $(".cursor__dot");
  let mx = -100, my = -100, rx = -100, ry = -100, frame = 0;
  function animateRing() {
    frame = 0;
    if (isMotionReduced()) return;
    const dx = mx - rx, dy = my - ry;
    rx += dx * 0.16; ry += dy * 0.16;
    ring.style.transform = `translate(${rx}px,${ry}px)`;
    if (Math.abs(dx) > 0.1 || Math.abs(dy) > 0.1) frame = requestAnimationFrame(animateRing);
  }
  addEventListener("mousemove", (e) => {
    if (isMotionReduced()) return;
    mx = e.clientX; my = e.clientY;
    dot.style.transform = `translate(${mx}px,${my}px)`;
    // gentle parallax on the ambient world
    const nx = (e.clientX / innerWidth - 0.5), ny = (e.clientY / innerHeight - 0.5);
    $("#sparkleField").style.transform = `translate(${nx * -14}px,${ny * -10}px)`;
    $(".world__grid").style.backgroundPosition = `${nx * 18}px ${ny * 14}px`;
    if (!frame) frame = requestAnimationFrame(animateRing);
  }, { passive: true });
  addEventListener("mousedown", (e) => {
    if (isMotionReduced()) return;
    cursor.classList.add("is-down");
    const ripple = document.createElement("i");
    ripple.style.left = e.clientX + "px"; ripple.style.top = e.clientY + "px";
    ripple.style.borderColor = CANDY[Math.floor(Math.random() * CANDY.length)];
    $("#tapRipples").appendChild(ripple); setTimeout(() => ripple.remove(), 750);
  });
  addEventListener("mouseup", () => cursor.classList.remove("is-down"));
  document.addEventListener("mouseover", (e) => { if (e.target.closest("button,a,input,select,textarea,.task,[role='switch']")) cursor.classList.add("is-hover"); });
  document.addEventListener("mouseout", (e) => { if (e.target.closest("button,a,input,select,textarea,.task,[role='switch']")) cursor.classList.remove("is-hover"); });
})();
/* mascot personality */
(function mascotFx() {
  const m = $("#mascot"); if (!m) return;
  const blink = () => {
    if (!isMotionReduced()) {
      m.classList.add("is-blink"); setTimeout(() => m.classList.remove("is-blink"), 150);
    }
    setTimeout(blink, 2200 + Math.random() * 3200);
  };
  setTimeout(blink, 1600);
  m.addEventListener("click", () => { m.classList.remove("is-happy"); void m.offsetWidth; m.classList.add("is-happy"); confetti(m); blip(990, 0.09, "triangle", 0.05); });
  addEventListener("mousemove", (e) => {
    if (isMotionReduced()) return;
    const r = m.getBoundingClientRect(); if (!r.width) return;
    const dx = clamp((e.clientX - (r.left + r.width / 2)) / 26, -3.4, 3.4), dy = clamp((e.clientY - (r.top + r.height / 2)) / 26, -2.4, 2.4);
    $$(".mascot__eye i", m).forEach((p) => (p.style.transform = `translate(${dx}px,${dy}px)`));
  }, { passive: true });
})();

/* ============================== boot / init ============================== */
async function init() {
  applyTheme(); applyI18n(); updateHeader(); buildSparkles();
  $("#repoInput").value = DEFAULT_REPO;
  loadDemo(); renderAll(); renderSync();
  // reveal-on-load choreography
  const io = new IntersectionObserver((entries) => entries.forEach((en) => { if (en.isIntersecting) { en.target.classList.add("is-in"); io.unobserve(en.target); } }), { threshold: 0.08 });
  $$(".reveal").forEach((el, i) => { el.style.transitionDelay = `${i * 70}ms`; io.observe(el); });
  requestAnimationFrame(() => setTimeout(() => $("#boot").classList.add("done"), 650));
  positionFilterPill();
  addEventListener("resize", debounce(positionFilterPill, 120));
  // sync session restore
  const vaultRaw = localStorage.getItem(LS.vault);
  const auto = await tryAutoUnlock();
  if (!auto && vaultRaw) { setSyncStatus("locked"); renderSync(); }
  renderAll(); renderSync();
  if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
    try { await navigator.serviceWorker.register("./sw.js"); } catch {}
  }
}
init();
