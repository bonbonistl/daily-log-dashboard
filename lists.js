// Lists tab: any number of personal lists (movies, restaurants, albums…), each with items.
// Tables `lists` and `list_items` (supabase/migrations/20261119_lists.sql), private per owner.
// Pasting a link fills the item's name from the page via the `recipe-title` edge function,
// which falls back to og:title / <title> for non-recipe pages.

let listsLoadedOnce = false;
let listsAll = [];      // [{id, name, emoji, created_at}]
let listItemsAll = [];  // [{id, list_id, title, url, notes, done, done_at, created_at}]
let listsSelectedId = null;
let listsEditingItemId = null;
let listsTitleTouched = false;
let listsLookupTimer = null;
let listsLookupSeq = 0;

const LISTS_SELECTED_KEY = "lists.selectedId";
const LISTS_SHOW_DONE_KEY = "lists.showDone";

const escList = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const listsStore = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

function listsLooksLikeUrl(s) {
  const v = (s || "").trim();
  return /^https?:\/\/\S+$/i.test(v) || /^(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}(\/\S*)?$/i.test(v);
}
function listsFullUrl(s) {
  const v = (s || "").trim();
  if (!v) return "";
  return /^https?:\/\//i.test(v) ? v : "https://" + v;
}
function listsHost(url) {
  try { return new URL(url).hostname.replace(/^(www|m)\./, ""); } catch { return ""; }
}
// Last resort name from the link itself: "/the-grand-budapest-hotel-2014/" → "The Grand Budapest Hotel 2014".
function listsTitleFromUrl(url) {
  try {
    const u = new URL(url);
    const seg = u.pathname.split("/").filter(Boolean).pop() || "";
    const words = decodeURIComponent(seg).replace(/\.[a-z]{2,5}$/i, "").replace(/[-_+]+/g, " ").trim();
    if (words && /[a-z]{3,}/i.test(words) && !/^\d+$/.test(words)) return words.replace(/\b\w/g, (c) => c.toUpperCase());
    return listsHost(url);
  } catch { return ""; }
}

async function listsLookupTitle(url) {
  try {
    const { data } = await withTimeout(sb.functions.invoke("recipe-title", { body: { url } }), 15000, "Name lookup");
    return (data && data.title) || "";
  } catch { return ""; }
}

// ---------- loading ----------
async function loadListsData() {
  const loading = document.getElementById("listsLoading");
  if (!listsLoadedOnce) {
    loading.textContent = "Loading lists…";
    loading.classList.remove("hidden");
    document.getElementById("listsPanel").classList.add("hidden");
  }
  let res;
  try {
    res = await withTimeout(Promise.all([
      sb.from("lists").select("id, name, emoji, created_at").order("name"),
      sb.from("list_items").select("id, list_id, title, url, notes, done, done_at, created_at").order("created_at", { ascending: false }),
    ]), 15000, "Loading lists");
  } catch (e) {
    loading.textContent = e.message;
    loading.classList.remove("hidden");
    return;
  }
  const err = res[0].error || res[1].error;
  if (err) {
    loading.textContent = "Error loading lists: " + err.message;
    loading.classList.remove("hidden");
    return;
  }
  listsAll = res[0].data;
  listItemsAll = res[1].data;
  listsLoadedOnce = true;
  loading.classList.add("hidden");
  document.getElementById("listsPanel").classList.remove("hidden");

  const wanted = Number(window.listsRouteId || listsStore.get(LISTS_SELECTED_KEY));
  window.listsRouteId = null;
  if (!listsAll.some((l) => l.id === listsSelectedId)) {
    listsSelectedId = listsAll.some((l) => l.id === wanted) ? wanted : (listsAll[0] ? listsAll[0].id : null);
  }
  document.getElementById("listsShowDone").checked = listsStore.get(LISTS_SHOW_DONE_KEY) !== "0";
  renderLists();
}

// Called by the router for "#lists/<id>".
function selectListById(id) {
  const n = Number(id);
  if (!listsLoadedOnce) { window.listsRouteId = n; return; }
  if (listsAll.some((l) => l.id === n)) { listsSelectedId = n; renderLists(); }
}

function currentList() { return listsAll.find((l) => l.id === listsSelectedId) || null; }

// ---------- rendering ----------
function renderLists() {
  renderListsSidebar();
  renderListMain();
  if (typeof updateUrlHash === "function") updateUrlHash();
}

function renderListsSidebar() {
  const el = document.getElementById("listsNav");
  if (!listsAll.length) {
    el.innerHTML = `<div class="journal-empty">No lists yet. Make your first one below.</div>`;
    return;
  }
  el.innerHTML = listsAll.map((l) => {
    const items = listItemsAll.filter((i) => i.list_id === l.id);
    const open = items.filter((i) => !i.done).length;
    return `<button type="button" class="lists-nav-btn${l.id === listsSelectedId ? " active" : ""}" data-id="${l.id}">
      <span class="lists-nav-emoji">${escList(l.emoji || "📋")}</span>
      <span class="lists-nav-name">${escList(l.name)}</span>
      <span class="lists-nav-count" title="${open} to go of ${items.length}">${open}</span>
    </button>`;
  }).join("");
}

function renderListMain() {
  const list = currentList();
  const main = document.getElementById("listsMain");
  const empty = document.getElementById("listsMainEmpty");
  main.classList.toggle("hidden", !list);
  empty.classList.toggle("hidden", !!list);
  if (!list) return;

  document.getElementById("listsTitleEmoji").textContent = list.emoji || "📋";
  document.getElementById("listsTitleName").textContent = list.name;

  const q = document.getElementById("listsFilter").value.trim().toLowerCase();
  const showDone = document.getElementById("listsShowDone").checked;
  const all = listItemsAll.filter((i) => i.list_id === list.id);
  const doneCount = all.filter((i) => i.done).length;
  let items = all.filter((i) => showDone || !i.done);
  if (q) items = items.filter((i) => [i.title, i.notes, i.url].some((v) => (v || "").toLowerCase().includes(q)));
  // To-do first (newest on top), then done (most recently done on top).
  items.sort((a, b) =>
    (a.done - b.done) ||
    (a.done ? String(b.done_at || "").localeCompare(String(a.done_at || "")) : String(b.created_at).localeCompare(String(a.created_at))));

  document.getElementById("listsCount").textContent =
    `${all.length - doneCount} to go · ${doneCount} done` + (q ? ` · showing ${items.length}` : "");

  const ul = document.getElementById("listsItems");
  if (!items.length) {
    ul.innerHTML = `<li class="journal-empty lists-empty">${all.length ? "Nothing matches." : "Nothing on this list yet. Add something above."}</li>`;
    return;
  }
  ul.innerHTML = items.map((i) => (i.id === listsEditingItemId ? listItemEditHtml(i) : listItemHtml(i))).join("");
  if (listsEditingItemId) {
    const t = ul.querySelector(".lists-edit-title");
    if (t) t.focus();
  }
}

function listItemHtml(i) {
  const host = i.url ? listsHost(i.url) : "";
  const title = i.url
    ? `<a href="${escList(i.url)}" target="_blank" rel="noopener noreferrer" class="lists-item-title">${escList(i.title)}</a>`
    : `<span class="lists-item-title">${escList(i.title)}</span>`;
  return `<li class="lists-item${i.done ? " is-done" : ""}" data-id="${i.id}">
    <input type="checkbox" class="lists-item-done" ${i.done ? "checked" : ""} aria-label="Mark done" />
    <div class="lists-item-body">
      <div class="lists-item-line">${title}${host ? `<span class="lists-item-host">${escList(host)}</span>` : ""}</div>
      ${i.notes ? `<div class="lists-item-notes">${escList(i.notes)}</div>` : ""}
    </div>
    <div class="lists-item-actions">
      <button type="button" class="lists-item-edit" aria-label="Edit">Edit</button>
      <button type="button" class="lists-item-delete" aria-label="Delete">✕</button>
    </div>
  </li>`;
}

function listItemEditHtml(i) {
  return `<li class="lists-item is-editing" data-id="${i.id}">
    <form class="lists-edit-form">
      <input type="text" class="lists-edit-title" value="${escList(i.title)}" placeholder="Name" maxlength="300" required />
      <input type="text" inputmode="url" class="lists-edit-url" value="${escList(i.url || "")}" placeholder="Link (optional)" maxlength="2000" />
      <textarea class="lists-edit-notes" rows="2" placeholder="Notes (optional)" maxlength="4000">${escList(i.notes || "")}</textarea>
      <div class="lists-edit-actions">
        <button type="submit" class="lists-primary">Save</button>
        <button type="button" class="lists-edit-cancel">Cancel</button>
      </div>
    </form>
  </li>`;
}

// ---------- lists: create / rename / delete ----------
document.getElementById("listsNav").addEventListener("click", (e) => {
  const btn = e.target.closest(".lists-nav-btn");
  if (!btn) return;
  listsSelectedId = Number(btn.dataset.id);
  listsEditingItemId = null;
  listsStore.set(LISTS_SELECTED_KEY, String(listsSelectedId));
  renderLists();
  document.getElementById("listsItemUrl").focus({ preventScroll: true });
});

function listsSplitEmoji(raw) {
  // "🎬 Movies" → emoji 🎬, name Movies. Anything without a leading emoji keeps the default icon.
  const m = raw.trim().match(/^(\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic}|\p{Emoji_Modifier})*)\s*(.*)$/u);
  return m && m[2] ? { emoji: m[1], name: m[2].trim() } : { emoji: null, name: raw.trim() };
}

document.getElementById("listsNewForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = document.getElementById("listsNewName");
  const { emoji, name } = listsSplitEmoji(input.value);
  if (!name) return;
  const status = document.getElementById("listsNewStatus");
  if (listsAll.some((l) => l.name.trim().toLowerCase() === name.toLowerCase())) {
    status.textContent = "You already have a list with that name.";
    return;
  }
  status.textContent = "";
  const { data, error } = await sb.from("lists").insert({ name, emoji }).select("id, name, emoji, created_at").single();
  if (error) { status.textContent = "Couldn't create it: " + error.message; return; }
  input.value = "";
  listsAll.push(data);
  listsAll.sort((a, b) => a.name.localeCompare(b.name));
  listsSelectedId = data.id;
  listsStore.set(LISTS_SELECTED_KEY, String(data.id));
  renderLists();
  document.getElementById("listsItemUrl").focus();
});

document.getElementById("listsRenameBtn").addEventListener("click", async () => {
  const list = currentList();
  if (!list) return;
  const raw = prompt("Rename list (start with an emoji to change its icon):", `${list.emoji ? list.emoji + " " : ""}${list.name}`);
  if (raw == null) return;
  const { emoji, name } = listsSplitEmoji(raw);
  if (!name) return;
  if (listsAll.some((l) => l.id !== list.id && l.name.trim().toLowerCase() === name.toLowerCase())) {
    alert("You already have a list with that name.");
    return;
  }
  const patch = { name, emoji: emoji || list.emoji };
  const { error } = await sb.from("lists").update(patch).eq("id", list.id);
  if (error) { alert("Couldn't rename: " + error.message); return; }
  Object.assign(list, patch);
  listsAll.sort((a, b) => a.name.localeCompare(b.name));
  renderLists();
});

document.getElementById("listsDeleteBtn").addEventListener("click", async () => {
  const list = currentList();
  if (!list) return;
  const n = listItemsAll.filter((i) => i.list_id === list.id).length;
  if (!confirm(`Delete "${list.name}"${n ? ` and its ${n} item${n === 1 ? "" : "s"}` : ""}? This can't be undone.`)) return;
  const { error } = await sb.from("lists").delete().eq("id", list.id);
  if (error) { alert("Couldn't delete: " + error.message); return; }
  listsAll = listsAll.filter((l) => l.id !== list.id);
  listItemsAll = listItemsAll.filter((i) => i.list_id !== list.id);
  listsSelectedId = listsAll[0] ? listsAll[0].id : null;
  renderLists();
});

// ---------- adding items ----------
const listsUrlEl = document.getElementById("listsItemUrl");
const listsTitleEl = document.getElementById("listsItemTitle");
const listsAddStatus = document.getElementById("listsAddStatus");

function listsScheduleLookup() {
  clearTimeout(listsLookupTimer);
  const raw = listsUrlEl.value.trim();
  if (!raw || !listsLooksLikeUrl(raw)) { listsAddStatus.textContent = ""; return; }
  listsLookupTimer = setTimeout(async () => {
    const url = listsFullUrl(raw);
    const seq = ++listsLookupSeq;
    listsAddStatus.textContent = "Looking up the name…";
    const title = await listsLookupTitle(url);
    if (seq !== listsLookupSeq || listsFullUrl(listsUrlEl.value) !== url) return; // link changed meanwhile
    if (title) {
      listsAddStatus.textContent = "";
      if (!listsTitleTouched || !listsTitleEl.value.trim()) { listsTitleEl.value = title; listsTitleTouched = false; }
    } else {
      listsAddStatus.textContent = "Couldn't read the name from that page. Type one in.";
      if (!listsTitleTouched && !listsTitleEl.value.trim()) listsTitleEl.value = listsTitleFromUrl(url);
    }
  }, 500);
}

listsUrlEl.addEventListener("input", listsScheduleLookup);
listsTitleEl.addEventListener("input", () => { listsTitleTouched = !!listsTitleEl.value.trim(); });
// A link pasted into the name box goes to the link box instead.
listsTitleEl.addEventListener("paste", (e) => {
  const text = (e.clipboardData || window.clipboardData).getData("text");
  if (listsLooksLikeUrl(text) && !listsUrlEl.value.trim()) {
    e.preventDefault();
    listsUrlEl.value = text.trim();
    listsTitleTouched = false;
    listsScheduleLookup();
  }
});

document.getElementById("listsAddForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const list = currentList();
  if (!list) return;
  const btn = document.getElementById("listsAddBtn");
  let url = listsUrlEl.value.trim() ? listsFullUrl(listsUrlEl.value) : null;
  let title = listsTitleEl.value.trim();
  if (url && !listsLooksLikeUrl(url)) { listsAddStatus.textContent = "That link doesn't look right."; return; }
  btn.disabled = true;
  if (url && !title) {
    listsAddStatus.textContent = "Looking up the name…";
    title = (await listsLookupTitle(url)) || listsTitleFromUrl(url);
  }
  if (!title) { btn.disabled = false; listsAddStatus.textContent = "Add a name or a link."; listsTitleEl.focus(); return; }
  const notes = document.getElementById("listsItemNotes").value.trim() || null;
  const { data, error } = await sb.from("list_items")
    .insert({ list_id: list.id, title, url, notes })
    .select("id, list_id, title, url, notes, done, done_at, created_at").single();
  btn.disabled = false;
  if (error) { listsAddStatus.textContent = "Couldn't add it: " + error.message; return; }
  listItemsAll.unshift(data);
  e.target.reset();
  listsTitleTouched = false;
  listsLookupSeq++;
  listsAddStatus.textContent = "";
  renderLists();
  listsUrlEl.focus();
});

// ---------- item actions ----------
document.getElementById("listsItems").addEventListener("change", async (e) => {
  if (!e.target.classList.contains("lists-item-done")) return;
  const li = e.target.closest(".lists-item");
  const item = listItemsAll.find((i) => i.id === Number(li.dataset.id));
  if (!item) return;
  const done = e.target.checked;
  const patch = { done, done_at: done ? new Date().toISOString() : null };
  const { error } = await sb.from("list_items").update(patch).eq("id", item.id);
  if (error) { e.target.checked = !done; alert("Couldn't save: " + error.message); return; }
  Object.assign(item, patch);
  renderLists();
});

document.getElementById("listsItems").addEventListener("click", async (e) => {
  const li = e.target.closest(".lists-item");
  if (!li) return;
  const item = listItemsAll.find((i) => i.id === Number(li.dataset.id));
  if (!item) return;
  if (e.target.closest(".lists-item-edit")) {
    listsEditingItemId = item.id;
    renderListMain();
  } else if (e.target.closest(".lists-edit-cancel")) {
    listsEditingItemId = null;
    renderListMain();
  } else if (e.target.closest(".lists-item-delete")) {
    if (!confirm(`Remove "${item.title}"?`)) return;
    const { error } = await sb.from("list_items").delete().eq("id", item.id);
    if (error) { alert("Couldn't remove: " + error.message); return; }
    listItemsAll = listItemsAll.filter((i) => i.id !== item.id);
    renderLists();
  }
});

document.getElementById("listsItems").addEventListener("submit", async (e) => {
  if (!e.target.classList.contains("lists-edit-form")) return;
  e.preventDefault();
  const li = e.target.closest(".lists-item");
  const item = listItemsAll.find((i) => i.id === Number(li.dataset.id));
  if (!item) return;
  const title = e.target.querySelector(".lists-edit-title").value.trim();
  const rawUrl = e.target.querySelector(".lists-edit-url").value.trim();
  if (!title) return;
  const patch = { title, url: rawUrl ? listsFullUrl(rawUrl) : null, notes: e.target.querySelector(".lists-edit-notes").value.trim() || null };
  const { error } = await sb.from("list_items").update(patch).eq("id", item.id);
  if (error) { alert("Couldn't save: " + error.message); return; }
  Object.assign(item, patch);
  listsEditingItemId = null;
  renderLists();
});

document.getElementById("listsItems").addEventListener("keydown", (e) => {
  if (e.key === "Escape" && listsEditingItemId) { listsEditingItemId = null; renderListMain(); }
});

document.getElementById("listsFilter").addEventListener("input", renderListMain);
document.getElementById("listsShowDone").addEventListener("change", (e) => {
  listsStore.set(LISTS_SHOW_DONE_KEY, e.target.checked ? "1" : "0");
  renderListMain();
});
