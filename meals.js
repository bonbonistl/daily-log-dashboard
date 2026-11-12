// ---------- House → Meals ----------
// Family-shared recipe box (`recipes`) + dated plan (`meal_plan`). A plan row with
// cooked_at set is a "cooked" entry — those rows are the cooking history.

let mealsRecipes = [];   // [{id, title, url, url_key, source_text, notes, created_by, created_at}]
let mealsPlan = [];      // [{id, recipe_id, plan_date, cooked_at, cooked_by, created_by}]
let mealsWeekStart = mealsMonday(new Date());
let mealsTitleTouched = false; // stop auto-filling the title once it's been typed in
let mealsSelectedRecipeId = null; // set when a saved recipe is picked from the name dropdown

function mealsMonday(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  const day = x.getDay();
  x.setDate(x.getDate() - (day === 0 ? 6 : day - 1));
  return x;
}

// ---------- URL normalization ----------
// The same recipe gets shared with different query strings (?utm_source=…, ?igsh=…),
// with/without www., trailing slashes, AMP variants, Instagram /reel/ vs /p/, etc.
// Reduce a link to a stable key so all of those land on one recipe. Only a few query
// params that actually identify a page are kept (YouTube's v, WordPress's p, …).
const MEALS_KEEP_PARAMS = new Set(["v", "p", "id", "page_id", "recipe", "recipeid", "rid"]);

function mealsParseUrl(raw) {
  let s = (raw || "").trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  try {
    const u = new URL(s);
    return u.hostname.includes(".") ? u : null;
  } catch {
    return null;
  }
}

function mealsSafeDecode(s) {
  try { return decodeURI(s); } catch { return s; }
}

function mealsNormalizeUrl(raw) {
  const u = mealsParseUrl(raw);
  if (!u) return null;
  let host = u.hostname.toLowerCase().replace(/^(www\d*|m|mobile|amp)\./, "");
  let path = mealsSafeDecode(u.pathname).replace(/\/{2,}/g, "/");
  path = path.replace(/\/(amp|index\.html?|print)\/?$/i, "").replace(/\/+$/, "");
  let params = [...u.searchParams].filter(([k]) => MEALS_KEEP_PARAMS.has(k.toLowerCase()));

  if (host === "instagram.com") {
    // instagram.com/<user>/reel/ID, /reels/ID, /tv/ID and /p/ID are all the same post.
    const m = path.match(/^\/(?:[^/]+\/)?(?:p|reels?|tv)\/([^/]+)/i);
    if (m) path = "/p/" + m[1];
    params = [];
  } else if (host === "youtu.be") {
    host = "youtube.com";
    params = [["v", path.slice(1)]];
    path = "/watch";
  } else if (host === "youtube.com") {
    const m = path.match(/^\/(?:shorts|live)\/([^/]+)/i);
    if (m) { params = [["v", m[1]]]; path = "/watch"; }
    params = params.filter(([k]) => k === "v");
  } else if (host === "tiktok.com") {
    params = [];
  }

  params.sort(([a], [b]) => a.localeCompare(b));
  const qs = params.length ? "?" + params.map(([k, v]) => `${k.toLowerCase()}=${v}`).join("&") : "";
  return host + (path || "") + qs;
}

// Best-guess recipe name from a URL slug: ".../creamy-tuscan-chicken-pasta/" →
// "Creamy Tuscan Chicken Pasta". Skips numeric/ID-ish segments.
function mealsTitleFromUrl(raw) {
  const u = mealsParseUrl(raw);
  if (!u) return "";
  const segs = mealsSafeDecode(u.pathname).split("/").filter(Boolean)
    .filter((s) => !/^(recipes?|amp|print|index\.html?|p|reels?|tv|watch|shorts)$/i.test(s));
  for (let i = segs.length - 1; i >= 0; i--) {
    const seg = segs[i].replace(/\.\w+$/, "");
    if (!/[a-z]{3,}/i.test(seg) || !/[-_ ]/.test(seg)) continue;
    const words = seg.replace(/[-_]+/g, " ").replace(/\b\d{3,}\b/g, "").trim();
    if (words) return words.replace(/\b\w/g, (c) => c.toUpperCase());
  }
  return "";
}

// First meaningful line of pasted text, minus hashtags/emoji clutter.
function mealsTitleFromPaste(text) {
  const line = (text || "").split(/\r?\n/).map((l) => l.trim()).find((l) => l.replace(/[^\p{L}\p{N}]/gu, "").length >= 3);
  if (!line) return "";
  return line.replace(/#\S+/g, "").replace(/\s+/g, " ").trim().slice(0, 120);
}

function mealsFindRecipeByKey(key) {
  return key ? mealsRecipes.find((r) => r.url_key === key) : null;
}
function mealsFindRecipeByTitle(title) {
  const t = (title || "").trim().toLowerCase();
  return t ? mealsRecipes.find((r) => !r.url_key && r.title.trim().toLowerCase() === t) : null;
}

function mealsCookedRows(recipeId) {
  return mealsPlan.filter((p) => p.recipe_id === recipeId && p.cooked_at);
}
function mealsWho(email) {
  return email ? email.split("@")[0] : "";
}
function mealsFmtDate(dateStr, opts) {
  return new Date(dateStr + "T00:00:00").toLocaleDateString(undefined, opts || { weekday: "short", month: "short", day: "numeric" });
}

// ---------- load ----------
async function loadMealsData() {
  const loading = document.getElementById("mealsLoading");
  let res;
  try {
    res = await withTimeout(Promise.all([
      sb.from("recipes").select("*").order("title"),
      sb.from("meal_plan").select("*").order("plan_date", { ascending: false }).order("id"),
    ]), 15000, "Loading meals");
  } catch (e) {
    loading.textContent = e.message;
    loading.classList.remove("hidden");
    return;
  }
  const error = res[0].error || res[1].error;
  if (error) {
    loading.textContent = "Error loading data: " + error.message;
    loading.classList.remove("hidden");
    return;
  }
  mealsRecipes = res[0].data;
  mealsPlan = res[1].data;
  loading.classList.add("hidden");
  document.getElementById("mealsContent").classList.remove("hidden");
  markUpdated("mealsUpdatedAt");
  renderMeals();
}

function renderMeals() {
  renderMealsWeek();
  renderMealsHistory();
  renderMealsRecipes();
  updateMealMatchHint();
}

// ---------- shared bits ----------
function mealsRecipeTitleHtml(r) {
  const title = escapeHtml(r.title);
  const u = r.url && mealsParseUrl(r.url);
  return u
    ? `<a href="${escapeHtml(u.href)}" target="_blank" rel="noopener noreferrer">${title}</a>`
    : title;
}
function mealsRecipeTextHtml(r) {
  if (!r.source_text) return "";
  return `<details class="meal-recipe-text"><summary>Recipe</summary><div>${escapeHtml(r.source_text)}</div></details>`;
}

// ---------- week ----------
function renderMealsWeek() {
  const start = mealsWeekStart;
  const end = new Date(start); end.setDate(end.getDate() + 6);
  const isThisWeek = toLocalDateStr(start) === toLocalDateStr(mealsMonday(new Date()));
  document.getElementById("mealsWeekHeading").textContent = isThisWeek
    ? "This Week"
    : `Week of ${mealsFmtDate(toLocalDateStr(start), { month: "short", day: "numeric" })}`;

  const today = todayLocalStr();
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(start); d.setDate(d.getDate() + i);
    days.push(toLocalDateStr(d));
  }

  document.getElementById("mealsWeek").innerHTML = days.map((ds) => {
    const items = mealsPlan.filter((p) => p.plan_date === ds).sort((a, b) => a.id - b.id);
    const itemsHtml = items.map((p) => {
      const r = mealsRecipes.find((x) => x.id === p.recipe_id);
      if (!r) return "";
      const by = p.cooked_at && p.cooked_by ? `<span class="plan-item-macro">cooked by ${escapeHtml(mealsWho(p.cooked_by))}</span>` : "";
      return `
        <div class="plan-item meal-item ${p.cooked_at ? "done" : ""}" data-id="${p.id}">
          <label>
            <input type="checkbox" class="meal-cooked-toggle" ${p.cooked_at ? "checked" : ""} title="Cooked" />
          </label>
          <div class="meal-item-body">
            <div class="meal-item-title">${mealsRecipeTitleHtml(r)}</div>
            ${by}
            ${mealsRecipeTextHtml(r)}
          </div>
          <button class="plan-item-remove meal-plan-remove" aria-label="Remove from this day" title="Remove from this day">&times;</button>
        </div>`;
    }).join("");
    return `
      <div class="meals-day ${ds === today ? "today" : ""}">
        <div class="meals-day-head">
          <h3>${escapeHtml(mealsFmtDate(ds))}</h3>
          <button class="meals-day-add" data-date="${ds}" title="Add a meal to this day">+ Add</button>
        </div>
        <div class="rol-checklist">${itemsHtml || `<div class="journal-empty">Nothing planned.</div>`}</div>
      </div>`;
  }).join("");

  document.querySelectorAll("#mealsWeek .meal-cooked-toggle").forEach((input) => {
    input.addEventListener("change", () => toggleMealCooked(Number(input.closest(".meal-item").dataset.id), input));
  });
  document.querySelectorAll("#mealsWeek .meal-plan-remove").forEach((btn) => {
    btn.addEventListener("click", () => removeMealPlan(Number(btn.closest(".meal-item").dataset.id)));
  });
  document.querySelectorAll("#mealsWeek .meals-day-add").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.getElementById("mealDate").value = btn.dataset.date;
      const form = document.getElementById("mealAddForm");
      form.scrollIntoView({ behavior: "smooth", block: "start" });
      document.getElementById("mealUrl").focus({ preventScroll: true });
    });
  });
}

async function toggleMealCooked(planId, input) {
  const p = mealsPlan.find((x) => x.id === planId);
  if (!p) return;
  input.disabled = true;
  let patch = { cooked_at: null, cooked_by: null };
  if (!p.cooked_at) {
    const { data: { session } } = await sb.auth.getSession();
    patch = { cooked_at: new Date().toISOString(), cooked_by: session?.user?.email || null };
  }
  const { error } = await sb.from("meal_plan").update(patch).eq("id", planId);
  if (error) { alert("Failed to update: " + error.message); input.disabled = false; input.checked = !!p.cooked_at; return; }
  Object.assign(p, patch);
  renderMeals();
}

async function removeMealPlan(planId) {
  const p = mealsPlan.find((x) => x.id === planId);
  if (p && p.cooked_at && !confirm("This one's marked cooked. Remove it from the history too?")) return;
  const { error } = await sb.from("meal_plan").delete().eq("id", planId);
  if (error) { alert("Failed to remove: " + error.message); return; }
  mealsPlan = mealsPlan.filter((x) => x.id !== planId);
  renderMeals();
}

// ---------- history ----------
function renderMealsHistory() {
  const cooked = mealsPlan.filter((p) => p.cooked_at)
    .sort((a, b) => (b.plan_date.localeCompare(a.plan_date)) || (b.id - a.id));
  document.getElementById("mealsHistoryCount").textContent = cooked.length ? `${cooked.length} meal${cooked.length === 1 ? "" : "s"} cooked` : "";
  const el = document.getElementById("mealsHistory");
  if (!cooked.length) {
    el.innerHTML = `<div class="journal-empty">Nothing cooked yet. Check off a meal in the week above and it shows up here.</div>`;
    return;
  }
  let lastMonth = null;
  el.innerHTML = cooked.map((p) => {
    const r = mealsRecipes.find((x) => x.id === p.recipe_id);
    if (!r) return "";
    const month = mealsFmtDate(p.plan_date, { month: "long", year: "numeric" });
    const head = month !== lastMonth ? `<h3 class="meals-history-month">${escapeHtml(month)}</h3>` : "";
    lastMonth = month;
    const n = mealsCookedRows(r.id).length;
    return `${head}
      <div class="meals-history-row">
        <span class="meals-history-date">${escapeHtml(mealsFmtDate(p.plan_date))}</span>
        <span class="meals-history-title">${mealsRecipeTitleHtml(r)}${n > 1 ? ` <span class="hint">${n}×</span>` : ""}</span>
        <span class="hint">${escapeHtml(mealsWho(p.cooked_by))}</span>
      </div>`;
  }).join("");
}

// ---------- recipe box ----------
function renderMealsRecipes() {
  const q = document.getElementById("mealsRecipeSearch").value.trim().toLowerCase();
  const rows = mealsRecipes.map((r) => {
    const cooked = mealsCookedRows(r.id);
    const last = cooked.reduce((m, p) => (p.plan_date > m ? p.plan_date : m), "");
    return { r, count: cooked.length, last };
  })
    .filter(({ r }) => !q || r.title.toLowerCase().includes(q) || (r.url || "").toLowerCase().includes(q) || (r.source_text || "").toLowerCase().includes(q))
    .sort((a, b) => (b.last || "").localeCompare(a.last || "") || a.r.title.localeCompare(b.r.title));

  document.getElementById("mealsRecipeCount").textContent = mealsRecipes.length ? `${mealsRecipes.length} saved` : "";
  const el = document.getElementById("mealsRecipes");
  if (!rows.length) {
    el.innerHTML = `<div class="journal-empty">${mealsRecipes.length ? "No recipes match." : "No recipes yet. Add one above."}</div>`;
    return;
  }
  el.innerHTML = rows.map(({ r, count, last }) => {
    const host = r.url_key ? r.url_key.split("/")[0] : "pasted";
    const stats = count ? `cooked ${count}× · last ${escapeHtml(mealsFmtDate(last, { month: "short", day: "numeric", year: "numeric" }))}` : "never cooked";
    return `
      <div class="meals-recipe-row" data-id="${r.id}">
        <div class="meals-recipe-main">
          <div class="meal-item-title">${mealsRecipeTitleHtml(r)}</div>
          <div class="plan-item-macro">${escapeHtml(host)} · ${stats}</div>
          ${mealsRecipeTextHtml(r)}
        </div>
        <div class="meals-recipe-actions">
          <input type="date" class="meals-recipe-date" value="${todayLocalStr()}" aria-label="Day to plan" />
          <button class="meals-recipe-plan">Plan</button>
          <button class="meals-recipe-rename" title="Rename">Rename</button>
          <button class="plan-item-remove meals-recipe-delete" aria-label="Delete recipe" title="Delete recipe">&times;</button>
        </div>
      </div>`;
  }).join("");

  el.querySelectorAll(".meals-recipe-plan").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const row = btn.closest(".meals-recipe-row");
      const date = row.querySelector(".meals-recipe-date").value;
      if (!date) { alert("Pick a day first."); return; }
      btn.disabled = true;
      const err = await addMealPlan(Number(row.dataset.id), date);
      btn.disabled = false;
      if (err) { alert("Failed to plan: " + err.message); return; }
      mealsJumpToDate(date);
    });
  });
  el.querySelectorAll(".meals-recipe-rename").forEach((btn) => {
    btn.addEventListener("click", () => renameRecipe(Number(btn.closest(".meals-recipe-row").dataset.id)));
  });
  el.querySelectorAll(".meals-recipe-delete").forEach((btn) => {
    btn.addEventListener("click", () => deleteRecipe(Number(btn.closest(".meals-recipe-row").dataset.id)));
  });
}

async function renameRecipe(id) {
  const r = mealsRecipes.find((x) => x.id === id);
  const title = prompt("Recipe name", r.title);
  if (title == null || !title.trim() || title.trim() === r.title) return;
  const { error } = await sb.from("recipes").update({ title: title.trim() }).eq("id", id);
  if (error) { alert("Failed to rename: " + error.message); return; }
  r.title = title.trim();
  renderMeals();
}

async function deleteRecipe(id) {
  const r = mealsRecipes.find((x) => x.id === id);
  const n = mealsPlan.filter((p) => p.recipe_id === id).length;
  if (!confirm(`Delete "${r.title}"${n ? ` and its ${n} planned/cooked entr${n === 1 ? "y" : "ies"}` : ""}? This can't be undone.`)) return;
  const { error } = await sb.from("recipes").delete().eq("id", id);
  if (error) { alert("Failed to delete: " + error.message); return; }
  mealsRecipes = mealsRecipes.filter((x) => x.id !== id);
  mealsPlan = mealsPlan.filter((p) => p.recipe_id !== id);
  renderMeals();
}

// ---------- add ----------
async function addMealPlan(recipeId, date) {
  const { data, error } = await sb.from("meal_plan").insert({ recipe_id: recipeId, plan_date: date }).select().single();
  if (error) return error;
  mealsPlan.push(data);
  return null;
}

function mealsJumpToDate(date) {
  mealsWeekStart = mealsMonday(new Date(date + "T00:00:00"));
  renderMeals();
}

function mealsRecipeStats(id) {
  const cooked = mealsCookedRows(id);
  const last = cooked.reduce((m, p) => (p.plan_date > m ? p.plan_date : m), "");
  return { count: cooked.length, last };
}

// Shows whether what's in the form already matches a saved recipe.
function updateMealMatchHint() {
  const el = document.getElementById("mealMatchHint");
  const urlVal = document.getElementById("mealUrl").value.trim();
  const selected = mealsSelectedRecipeId && mealsRecipes.find((r) => r.id === mealsSelectedRecipeId);
  let match = null;
  if (selected) {
    match = selected;
  } else if (urlVal) {
    const key = mealsNormalizeUrl(urlVal);
    if (!key) { el.textContent = "That doesn't look like a link."; return; }
    match = mealsFindRecipeByKey(key);
  } else {
    match = mealsFindRecipeByTitle(document.getElementById("mealTitle").value);
  }
  if (!match) { el.textContent = ""; return; }
  const cooked = mealsCookedRows(match.id);
  const last = cooked.reduce((m, p) => (p.plan_date > m ? p.plan_date : m), "");
  el.textContent = (match.id === mealsSelectedRecipeId ? `Using your saved recipe "${match.title}"` : `Already in the recipe box as "${match.title}"`) +
    (cooked.length ? ` — cooked ${cooked.length}×, last ${mealsFmtDate(last, { month: "short", day: "numeric" })}.` : ".") +
    " Adding will use that recipe.";
}

// ---------- page-title lookup ----------
// The recipe-title edge function reads the page's real recipe name (browsers can't fetch
// other sites directly). Some sites block it; then the slug guess above stays.
const mealsPageTitles = new Map(); // url_key → title ("" = looked up, nothing found)
let mealsLookupTimer = null;

// Best name we have for a link without asking the server: a saved recipe's, a looked-up one, or the slug.
function mealsKnownUrlTitle(urlVal) {
  const key = mealsNormalizeUrl(urlVal);
  if (!key) return "";
  const existing = mealsFindRecipeByKey(key);
  return (existing && existing.title) || mealsPageTitles.get(key) || mealsTitleFromUrl(urlVal);
}

function setMealTitleStatus(text) {
  document.getElementById("mealTitleStatus").textContent = text;
}

async function lookupMealPageTitle(urlVal) {
  const key = mealsNormalizeUrl(urlVal);
  if (!key || mealsFindRecipeByKey(key) || mealsPageTitles.has(key)) return;
  setMealTitleStatus("Looking up the recipe name…");
  let title = "";
  try {
    const { data } = await withTimeout(sb.functions.invoke("recipe-title", { body: { url: urlVal.trim() } }), 15000, "Name lookup");
    title = (data && data.title) || "";
  } catch { /* fall back to the slug guess */ }
  mealsPageTitles.set(key, title);
  // Ignore the answer if the link changed or a name was typed meanwhile.
  if (mealsNormalizeUrl(document.getElementById("mealUrl").value) !== key) return;
  setMealTitleStatus(title ? "" : "Couldn't read the name from that page. Check the name below.");
  if (title && !mealsTitleTouched) document.getElementById("mealTitle").value = title;
}

document.getElementById("mealUrl").addEventListener("input", () => {
  const urlVal = document.getElementById("mealUrl").value;
  const titleEl = document.getElementById("mealTitle");
  // Typing a link means a different recipe than one picked from the name list.
  if (mealsSelectedRecipeId && urlVal.trim()) { mealsSelectedRecipeId = null; mealsTitleTouched = false; }
  if (!mealsTitleTouched) {
    titleEl.value = mealsKnownUrlTitle(urlVal) || mealsTitleFromPaste(document.getElementById("mealPaste").value);
  }
  setMealTitleStatus("");
  updateMealMatchHint();
  clearTimeout(mealsLookupTimer);
  if (mealsNormalizeUrl(urlVal)) mealsLookupTimer = setTimeout(() => lookupMealPageTitle(urlVal), 500);
});

document.getElementById("mealPaste").addEventListener("input", () => {
  const pasteEl = document.getElementById("mealPaste");
  const urlEl = document.getElementById("mealUrl");
  // A bare link pasted into the text box belongs in the link field.
  if (/^\s*https?:\/\/\S+\s*$/i.test(pasteEl.value) && !urlEl.value.trim()) {
    urlEl.value = pasteEl.value.trim();
    pasteEl.value = "";
    urlEl.dispatchEvent(new Event("input"));
    return;
  }
  // A link's slug (or a saved recipe's name) wins; otherwise name it from the paste.
  if (!mealsTitleTouched && !mealsKnownUrlTitle(urlEl.value)) {
    document.getElementById("mealTitle").value = mealsTitleFromPaste(pasteEl.value);
  }
  updateMealMatchHint();
});

document.getElementById("mealTitle").addEventListener("input", (e) => {
  mealsTitleTouched = e.target.value.trim() !== "";
  const selected = mealsSelectedRecipeId && mealsRecipes.find((r) => r.id === mealsSelectedRecipeId);
  if (selected && selected.title !== e.target.value) mealsSelectedRecipeId = null;
  updateMealMatchHint();
  renderMealSuggest();
});

// ---------- name type-ahead ----------
// Typing in the name box lists saved recipes (empty box: most recently cooked). Picking one
// reuses that exact recipe, so cooking it again adds to its history instead of a duplicate.
let mealsSuggestIndex = -1;
let mealsSuggestItems = [];

function renderMealSuggest() {
  const box = document.getElementById("mealTitleSuggest");
  const input = document.getElementById("mealTitle");
  const q = input.value.trim().toLowerCase();
  const withStats = mealsRecipes.map((r) => ({ r, ...mealsRecipeStats(r.id) }));
  let items;
  if (!q) {
    items = withStats.sort((a, b) => b.last.localeCompare(a.last) || b.r.id - a.r.id);
  } else {
    items = withStats
      .map((x) => {
        const t = x.r.title.toLowerCase();
        const pos = t.indexOf(q);
        // A match at the start of a word ("orange" in "Costco Orange Chicken") beats one mid-word.
        const wordStart = pos === 0 || (pos > 0 && /[^\p{L}\p{N}]/u.test(t[pos - 1]));
        return { ...x, pos, wordStart };
      })
      .filter((x) => x.pos >= 0)
      // Then the ones you actually cook, most recent first.
      .sort((a, b) => (b.wordStart - a.wordStart) || b.last.localeCompare(a.last) || a.r.title.localeCompare(b.r.title));
  }
  // Nothing to suggest if the box already holds exactly the picked recipe.
  if (mealsSelectedRecipeId && items.length === 1 && items[0].r.id === mealsSelectedRecipeId) items = [];
  mealsSuggestItems = items.slice(0, 8);
  mealsSuggestIndex = -1;

  if (!mealsSuggestItems.length || document.activeElement !== input) { box.classList.add("hidden"); return; }
  box.innerHTML = (q ? "" : `<div class="meal-suggest-head">Recent recipes</div>`) + mealsSuggestItems.map((x, i) => {
    const t = escapeHtml(x.r.title);
    const title = q ? t.replace(new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "i"), "<mark>$1</mark>") : t;
    const where = x.r.url_key ? x.r.url_key.split("/")[0] : (x.r.source_text ? "pasted" : "no link");
    const stats = x.count ? `cooked ${x.count}× · last ${mealsFmtDate(x.last, { month: "short", day: "numeric" })}` : "never cooked";
    return `<div class="meal-suggest-item" role="option" data-i="${i}">
      <span class="meal-suggest-title">${title}</span>
      <span class="meal-suggest-meta">${escapeHtml(where)} · ${escapeHtml(stats)}</span>
    </div>`;
  }).join("");
  box.classList.remove("hidden");
  box.querySelectorAll(".meal-suggest-item").forEach((el) => {
    // mousedown (not click) so it fires before the input's blur hides the list.
    el.addEventListener("mousedown", (e) => { e.preventDefault(); pickMealSuggestion(Number(el.dataset.i)); });
  });
}

function highlightMealSuggest() {
  document.querySelectorAll("#mealTitleSuggest .meal-suggest-item").forEach((el, i) => {
    el.classList.toggle("active", i === mealsSuggestIndex);
    if (i === mealsSuggestIndex) el.scrollIntoView({ block: "nearest" });
  });
}

function pickMealSuggestion(i) {
  const x = mealsSuggestItems[i];
  if (!x) return;
  mealsSelectedRecipeId = x.r.id;
  mealsTitleTouched = true;
  document.getElementById("mealTitle").value = x.r.title;
  // The saved recipe already has its own link/text; clear the other fields so they don't conflict.
  document.getElementById("mealUrl").value = "";
  document.getElementById("mealPaste").value = "";
  setMealTitleStatus("");
  document.getElementById("mealTitleSuggest").classList.add("hidden");
  updateMealMatchHint();
}

const mealTitleInput = document.getElementById("mealTitle");
mealTitleInput.addEventListener("focus", renderMealSuggest);
mealTitleInput.addEventListener("blur", () => document.getElementById("mealTitleSuggest").classList.add("hidden"));
mealTitleInput.addEventListener("keydown", (e) => {
  const open = !document.getElementById("mealTitleSuggest").classList.contains("hidden");
  if (e.key === "ArrowDown") {
    e.preventDefault();
    if (!open) { renderMealSuggest(); return; }
    mealsSuggestIndex = Math.min(mealsSuggestIndex + 1, mealsSuggestItems.length - 1);
    highlightMealSuggest();
  } else if (e.key === "ArrowUp" && open) {
    e.preventDefault();
    mealsSuggestIndex = Math.max(mealsSuggestIndex - 1, 0);
    highlightMealSuggest();
  } else if (e.key === "Enter" && open && mealsSuggestIndex >= 0) {
    e.preventDefault();
    pickMealSuggestion(mealsSuggestIndex);
  } else if (e.key === "Escape" && open) {
    document.getElementById("mealTitleSuggest").classList.add("hidden");
  }
});

document.getElementById("mealAddForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = document.getElementById("mealAddBtn");
  const urlRaw = document.getElementById("mealUrl").value.trim();
  const paste = document.getElementById("mealPaste").value.trim();
  const title = document.getElementById("mealTitle").value.trim();
  const date = document.getElementById("mealDate").value;

  const key = urlRaw ? mealsNormalizeUrl(urlRaw) : null;
  if (urlRaw && !key) { alert("That link doesn't look right."); return; }
  if (!title) { alert("Give it a name."); return; }

  btn.disabled = true;
  try {
    let recipe = (mealsSelectedRecipeId && mealsRecipes.find((r) => r.id === mealsSelectedRecipeId))
      || (key ? mealsFindRecipeByKey(key) : mealsFindRecipeByTitle(title));

    if (recipe) {
      // Fill in a pasted recipe on an existing link-only recipe, but never overwrite one.
      if (paste && !recipe.source_text) {
        const { error } = await sb.from("recipes").update({ source_text: paste }).eq("id", recipe.id);
        if (!error) recipe.source_text = paste;
      }
    } else {
      const row = { title, url: urlRaw ? mealsParseUrl(urlRaw).href : null, url_key: key, source_text: paste || null };
      let { data, error } = await sb.from("recipes").insert(row).select().single();
      if (error && error.code === "23505") {
        // Someone else in the family saved the same link (or name) since this page loaded.
        const q = sb.from("recipes").select("*");
        const res = key ? await q.eq("url_key", key) : await q.is("url_key", null);
        error = res.error;
        data = res.data && res.data.find((r) => (key ? true : r.title.trim().toLowerCase() === title.toLowerCase()));
        if (!error && !data) error = { message: "Couldn't find the existing recipe" };
      }
      if (error) { alert("Failed to save recipe: " + error.message); return; }
      recipe = data;
      if (!mealsRecipes.some((r) => r.id === recipe.id)) mealsRecipes.push(recipe);
    }

    if (date) {
      const err = await addMealPlan(recipe.id, date);
      if (err) { alert("Saved the recipe, but couldn't add it to the day: " + err.message); renderMeals(); return; }
      mealsWeekStart = mealsMonday(new Date(date + "T00:00:00"));
    }

    document.getElementById("mealUrl").value = "";
    document.getElementById("mealPaste").value = "";
    document.getElementById("mealTitle").value = "";
    mealsTitleTouched = false;
    mealsSelectedRecipeId = null;
    setMealTitleStatus("");
    renderMeals();
  } finally {
    btn.disabled = false;
  }
});

document.getElementById("mealsRecipeSearch").addEventListener("input", renderMealsRecipes);
document.getElementById("mealsPrevWeekBtn").addEventListener("click", () => {
  mealsWeekStart.setDate(mealsWeekStart.getDate() - 7);
  renderMeals();
});
document.getElementById("mealsNextWeekBtn").addEventListener("click", () => {
  mealsWeekStart.setDate(mealsWeekStart.getDate() + 7);
  renderMeals();
});
document.getElementById("mealsThisWeekBtn").addEventListener("click", () => {
  mealsWeekStart = mealsMonday(new Date());
  renderMeals();
});
document.getElementById("mealDate").value = todayLocalStr();
