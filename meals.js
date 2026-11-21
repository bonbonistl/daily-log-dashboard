// ---------- House → Meals ----------
// Family-shared recipe box (`recipes`) + dated plan (`meal_plan`). A plan row with
// cooked_at set is a "cooked" entry — those rows are the cooking history.

let mealsRecipes = [];   // [{id, title, url, url_key, source_text, notes, created_by, created_at}]
let mealsPlan = [];      // [{id, recipe_id, plan_date, cooked_at, cooked_by, shop_status, missing_items, cook_note, created_by}]
let mealsAway = [];      // [{id, away_date, note}] — days the family is traveling (nothing to plan)
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
      sb.from("meal_away").select("id, away_date, note").order("away_date"),
    ]), 15000, "Loading meals");
  } catch (e) {
    loading.textContent = e.message;
    loading.classList.remove("hidden");
    return;
  }
  const error = res[0].error || res[1].error || res[2].error;
  if (error) {
    loading.textContent = "Error loading data: " + error.message;
    loading.classList.remove("hidden");
    return;
  }
  mealsRecipes = res[0].data;
  mealsPlan = res[1].data;
  mealsAway = res[2].data;
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
  renderRecipeDrawer();
}

// ---------- shared bits ----------
// The name opens the recipe's side pane (history + notes); ↗ goes straight to the link.
function mealsRecipeTitleHtml(r) {
  const u = r.url && mealsParseUrl(r.url);
  const link = u
    ? ` <a class="meal-ext-link" href="${escapeHtml(u.href)}" target="_blank" rel="noopener noreferrer" title="Open the recipe" aria-label="Open the recipe">↗</a>`
    : "";
  const note = r.notes ? ` <span class="meal-has-notes" title="Has notes">📝</span>` : "";
  return `<button type="button" class="meal-open-recipe" data-recipe-id="${r.id}">${escapeHtml(r.title)}</button>${note}${link}`;
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

  const dinners = mealsCalDinners(days); // null until the calendar has loaded (or none connected)
  const allAway = days.every((ds) => mealsAwayOn(ds));
  const weekBtn = document.getElementById("mealsAwayWeekBtn");
  weekBtn.textContent = allAway ? "✈️ Home this week" : "✈️ Away all week";
  weekBtn.title = allAway ? "Clear the traveling mark from every day this week" : "Mark every day this week as traveling — nothing to plan";
  document.getElementById("mealsWeek").innerHTML = days.map((ds) => {
    const items = mealsPlan.filter((p) => p.plan_date === ds).sort((a, b) => a.id - b.id);
    const dayDinners = dinners ? (dinners[ds] || []) : null;
    const matched = new Set();
    const itemHtml = (p) => {
      const r = p.eating_out ? null : mealsRecipes.find((x) => x.id === p.recipe_id);
      if (!p.eating_out && !r) return "";
      const name = p.eating_out ? (p.eat_out_place || "Eating out") : r.title;
      let cal = "";
      // The calendar only has "Dinner: …" events, so only dinners get the check.
      if (dayDinners && mealsSlot(p) === "dinner") {
        const hit = mealsCalMatch(p, r, dayDinners);
        if (hit) matched.add(hit);
        cal = mealsCalHtml(hit);
      }
      const grip = `<button type="button" class="meal-drag-handle" title="Drag to another day (or focus and use ← →)" aria-label="Move ${escapeHtml(name)} to another day">⠿</button>`;
      const remove = `<button class="plan-item-remove meal-plan-remove" aria-label="Remove from this day" title="Remove from this day">&times;</button>`;
      if (p.eating_out) {
        return `
        <div class="plan-item meal-item meal-eating-out" data-id="${p.id}">
          ${grip}
          <span class="meal-eat-out-icon" aria-hidden="true">🍴</span>
          <div class="meal-item-body">
            <div class="meal-item-title">Eating out ${mealsSlotHtml(p)}</div>
            <input type="text" class="meal-eat-out-place" maxlength="200" placeholder="Where? (optional)" value="${escapeHtml(p.eat_out_place || "")}" />
            ${cal}
          </div>
          ${remove}
        </div>`;
      }
      const by = p.cooked_at && p.cooked_by ? `<span class="plan-item-macro">cooked by ${escapeHtml(mealsWho(p.cooked_by))}</span>` : "";
      return `
        <div class="plan-item meal-item ${p.cooked_at ? "done" : ""}" data-id="${p.id}">
          ${grip}
          <label>
            <input type="checkbox" class="meal-cooked-toggle" ${p.cooked_at ? "checked" : ""} title="Cooked" />
          </label>
          <div class="meal-item-body">
            <div class="meal-item-title">${mealsRecipeTitleHtml(r)} ${mealsSlotHtml(p)}</div>
            ${by}
            ${cal}
            ${p.cooked_at ? (p.cook_note ? `<div class="meal-cook-note">${escapeHtml(p.cook_note)}</div>` : "") : mealsHaveHtml(p)}
            ${mealsRecipeTextHtml(r)}
          </div>
          ${remove}
        </div>`;
    };
    // Lunch first, then dinner; a heading over each once the day has any lunch.
    const lunch = items.filter((p) => mealsSlot(p) === "lunch");
    const dinner = items.filter((p) => mealsSlot(p) === "dinner");
    const itemsHtml = lunch.length
      ? `<div class="meals-slot-head">Lunch</div>${lunch.map(itemHtml).join("")}`
        + `<div class="meals-slot-head">Dinner</div>${dinner.map(itemHtml).join("") || `<div class="journal-empty">No dinner planned.</div>`}`
      : dinner.map(itemHtml).join("");
    // A "Dinner: …" on the calendar that doesn't match anything planned here.
    const extra = (dayDinners || []).filter((d) => !matched.has(d));
    const away = mealsAwayOn(ds);
    const extraHtml = extra.length
      ? `<div class="meals-cal-extra" title="On the ${escapeHtml(extra[0].cal)} calendar but not planned here">📅 Calendar says: ${extra.map((d) => escapeHtml(d.meal)).join(", ")}</div>`
      : "";
    return `
      <div class="meals-day ${ds === today ? "today" : ""} ${away ? "away" : ""}" data-date="${ds}">
        <div class="meals-day-head">
          <h3>${escapeHtml(mealsFmtDate(ds))}</h3>
          <div class="meals-day-actions">
            ${away ? "" : `<button class="meals-day-add" data-date="${ds}" title="Add a meal to this day">+ Add</button>
            <button class="meals-day-eat-out" data-date="${ds}" title="Eating out for dinner this day (switch it to lunch on the card)">🍴 Eat out</button>`}
            <button class="meals-day-away ${away ? "on" : ""}" data-date="${ds}" aria-pressed="${away ? "true" : "false"}"
              title="${away ? "Not traveling after all — plan this day again" : "Traveling this day — nothing to plan"}">✈️ Away</button>
          </div>
        </div>
        <div class="meals-day-body">
          ${away ? `<div class="meals-away-banner">✈️ Traveling — nothing to plan${items.length ? ` <span class="hint">(${items.length} meal${items.length === 1 ? " is" : "s are"} still on this day — drag ${items.length === 1 ? "it" : "them"} elsewhere or remove)</span>` : ""}</div>` : ""}
          ${extraHtml}
          ${away && !items.length ? "" : `<div class="rol-checklist meals-day-list">${itemsHtml || `<div class="journal-empty">Nothing planned.</div>`}</div>`}
        </div>
      </div>`;
  }).join("");

  document.querySelectorAll("#mealsWeek .meal-cooked-toggle").forEach((input) => {
    input.addEventListener("change", () => toggleMealCooked(Number(input.closest(".meal-item").dataset.id), input));
  });
  document.querySelectorAll("#mealsWeek .meal-have-btn").forEach((btn) => {
    btn.addEventListener("click", () => setMealHave(Number(btn.closest(".meal-item").dataset.id), btn.dataset.v));
  });
  document.querySelectorAll("#mealsWeek .meal-missing").forEach((input) => {
    input.addEventListener("change", () => saveMealMissing(Number(input.closest(".meal-item").dataset.id), input));
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); input.blur(); } });
  });
  document.querySelectorAll("#mealsWeek .meal-slot-btn").forEach((btn) => {
    btn.addEventListener("click", () => setMealSlot(Number(btn.closest(".meal-item").dataset.id), btn.dataset.slot));
  });
  document.querySelectorAll("#mealsWeek .meal-eat-out-place").forEach((input) => {
    input.addEventListener("change", () => saveEatOutPlace(Number(input.closest(".meal-item").dataset.id), input));
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); input.blur(); } });
  });
  document.querySelectorAll("#mealsWeek .meals-day-eat-out").forEach((btn) => {
    btn.addEventListener("click", () => addEatingOut(btn.dataset.date, btn));
  });
  renderMealsShopSummary(days);
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
  document.querySelectorAll("#mealsWeek .meals-day-away").forEach((btn) => {
    btn.addEventListener("click", () => toggleMealAway([btn.dataset.date], !mealsAwayOn(btn.dataset.date), btn));
  });
  document.querySelectorAll("#mealsWeek .meal-drag-handle").forEach((handle) => {
    handle.addEventListener("pointerdown", (e) => mealsDragStart(e, handle));
    handle.addEventListener("keydown", (e) => mealsDragKey(e, handle));
  });
}

// ---------- on the calendar? ----------
// Dinners go on the family Google Calendar ("Kids Calendar" in Google; whatever name it has
// in Settings) as "Dinner: <meal>". Each planned meal gets a check when a matching dinner
// event is on the same day. Read-only — it's checked by putting the event on the calendar.
// Uses the calendars connected in Settings (per person) and the helpers in today.js.
let mealsCalFeeds = null;    // { sig, fetchedAt, feeds: [{ name, text }] }
let mealsCalInflight = null;
let mealsCalWeek = null;     // { key, fetchedAt, dinners: { "YYYY-MM-DD": [{ title, meal, norm, cal }] } }

function mealsCalNorm(s) {
  return (s || "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();
}

function mealsCalLoad() {
  if (mealsCalInflight) return;
  mealsCalInflight = loadUserSettings().then(async () => {
    const cals = calendarSettings();
    const feeds = [];
    await Promise.all(cals.map(async (c) => {
      try { feeds.push({ name: c.name, text: await fetchCalendarFeed(c.url) }); }
      catch (err) { console.warn(`Calendar "${c.name}" failed`, err); }
    }));
    mealsCalFeeds = { sig: cals.map((c) => c.url).join("|"), fetchedAt: Date.now(), feeds };
  })
    .catch((err) => console.warn("Meals calendar load failed", err))
    .finally(() => { mealsCalInflight = null; if (mealsCalFeeds) renderMealsWeek(); });
}

// "Dinner: …" events by day for the week shown, or null while loading / if no calendar.
function mealsCalDinners(days) {
  const sig = calendarSettings().map((c) => c.url).join("|");
  const fresh = mealsCalFeeds && mealsCalFeeds.sig === sig && Date.now() - mealsCalFeeds.fetchedAt < CALENDAR_TTL_MS;
  if (!fresh) mealsCalLoad();
  if (!mealsCalFeeds || !mealsCalFeeds.feeds.length || mealsCalFeeds.sig !== sig) return null;
  const key = days[0];
  if (mealsCalWeek && mealsCalWeek.key === key && mealsCalWeek.fetchedAt === mealsCalFeeds.fetchedAt) return mealsCalWeek.dinners;
  const start = new Date(days[0] + "T00:00:00");
  const end = new Date(start); end.setDate(end.getDate() + 7);
  const dinners = {};
  mealsCalFeeds.feeds.forEach((f) => {
    let events = [];
    try { events = calendarEventsForDay(f.text, f.name, start, end); }
    catch (err) { console.warn(`Calendar "${f.name}" couldn't be read`, err); }
    events.forEach((e) => {
      const m = /^\s*dinner\s*:\s*(.*)$/i.exec(e.title);
      if (!m || !m[1].trim()) return;
      const ds = toLocalDateStr(e.start);
      (dinners[ds] = dinners[ds] || []).push({ title: e.title, meal: m[1].trim(), norm: mealsCalNorm(m[1]), cal: e.cal });
    });
  });
  mealsCalWeek = { key, fetchedAt: mealsCalFeeds.fetchedAt, dinners };
  return dinners;
}

// Same name, ignoring case/punctuation — or one name contains the other
// ("Enchiladas" ↔ "Dinner: Enchiladas/Quesadillas"). Eating out matches the place's
// name, or a "Dinner: out" / "Dinner: eating out" / "Dinner: restaurant" event.
function mealsCalMatch(p, r, dayDinners) {
  if (p.eating_out) {
    const place = mealsCalNorm(p.eat_out_place);
    const hit = place && dayDinners.find((d) => d.norm === place || (place.length >= 4 && d.norm.includes(place)) || (d.norm.length >= 4 && place.includes(d.norm)));
    return hit || dayDinners.find((d) => /\b(out|eat out|eating out|restaurant|takeout|take out)\b/.test(d.norm)) || null;
  }
  const t = mealsCalNorm(r.title);
  if (!t) return null;
  return dayDinners.find((d) => d.norm === t)
    || dayDinners.find((d) => (t.length >= 4 && d.norm.includes(t)) || (d.norm.length >= 4 && t.includes(d.norm)))
    || null;
}

function mealsCalHtml(hit) {
  return hit
    ? `<div class="meal-cal on" title="${escapeHtml(`“${hit.title}” is on the ${hit.cal} calendar`)}"><span class="meal-cal-box" aria-hidden="true">✓</span> On calendar</div>`
    : `<div class="meal-cal" title="No matching “Dinner: …” event on this day yet"><span class="meal-cal-box" aria-hidden="true"></span> Not on calendar</div>`;
}

// ---------- move a meal to another day ----------
// Drag by the ⠿ grip. Pointer events rather than HTML5 drag-and-drop so it works on
// phones too (the grip has touch-action: none, so dragging it doesn't scroll the page).
// With the grip focused, ←/↑ and →/↓ move the meal a day within the week.
let mealsDrag = null;

function mealsDragStart(e, handle) {
  if (e.pointerType === "mouse" && e.button !== 0) return;
  if (mealsDrag) return;
  const item = handle.closest(".meal-item");
  const day = item.closest(".meals-day");
  e.preventDefault();
  const rect = item.getBoundingClientRect();
  const ghost = item.cloneNode(true);
  ghost.classList.add("meal-drag-ghost");
  ghost.removeAttribute("data-id");
  ghost.style.width = rect.width + "px";
  document.body.appendChild(ghost);
  item.classList.add("meal-dragging");
  document.body.classList.add("meal-drag-active");
  mealsDrag = {
    planId: Number(item.dataset.id), item, ghost, handle,
    from: day.dataset.date, over: null,
    dx: e.clientX - rect.left, dy: e.clientY - rect.top,
    x: e.clientX, y: e.clientY, raf: 0,
  };
  try { handle.setPointerCapture(e.pointerId); } catch (_) { /* fine without it */ }
  handle.addEventListener("pointermove", mealsDragMove);
  handle.addEventListener("pointerup", mealsDragEnd);
  handle.addEventListener("pointercancel", mealsDragCancel);
  document.addEventListener("keydown", mealsDragEscape);
  window.addEventListener("scroll", mealsDragPosition, { passive: true });
  mealsDragPosition();
  mealsDrag.raf = requestAnimationFrame(mealsDragAutoScroll);
}

function mealsDragMove(e) {
  if (!mealsDrag) return;
  mealsDrag.x = e.clientX;
  mealsDrag.y = e.clientY;
  mealsDragPosition();
}

// Move the floating copy under the pointer and highlight the day it's over.
function mealsDragPosition() {
  const d = mealsDrag;
  if (!d) return;
  d.ghost.style.left = (d.x - d.dx) + "px";
  d.ghost.style.top = (d.y - d.dy) + "px";
  const under = document.elementFromPoint(d.x, d.y);
  const day = under && under.closest("#mealsWeek .meals-day");
  const over = day ? day.dataset.date : null;
  if (over === d.over) return;
  document.querySelectorAll("#mealsWeek .meals-day.drop-target").forEach((el) => el.classList.remove("drop-target"));
  if (day && over !== d.from) day.classList.add("drop-target");
  d.over = over;
}

// Days stack on narrow screens, so scroll when dragging near the top/bottom edge.
function mealsDragAutoScroll() {
  if (!mealsDrag) return;
  const edge = 70, h = window.innerHeight, y = mealsDrag.y;
  let dy = 0;
  if (y < edge) dy = -Math.ceil((edge - y) / 5);
  else if (y > h - edge) dy = Math.ceil((y - (h - edge)) / 5);
  if (dy) { window.scrollBy(0, dy); mealsDragPosition(); }
  mealsDrag.raf = requestAnimationFrame(mealsDragAutoScroll);
}

function mealsDragCleanup() {
  const d = mealsDrag;
  if (!d) return null;
  mealsDrag = null;
  cancelAnimationFrame(d.raf);
  d.handle.removeEventListener("pointermove", mealsDragMove);
  d.handle.removeEventListener("pointerup", mealsDragEnd);
  d.handle.removeEventListener("pointercancel", mealsDragCancel);
  document.removeEventListener("keydown", mealsDragEscape);
  window.removeEventListener("scroll", mealsDragPosition);
  d.ghost.remove();
  d.item.classList.remove("meal-dragging");
  document.body.classList.remove("meal-drag-active");
  document.querySelectorAll("#mealsWeek .meals-day.drop-target").forEach((el) => el.classList.remove("drop-target"));
  return d;
}

function mealsDragEnd() {
  const d = mealsDragCleanup();
  if (d && d.over && d.over !== d.from) moveMealPlan(d.planId, d.over);
}
function mealsDragCancel() { mealsDragCleanup(); }
function mealsDragEscape(e) { if (e.key === "Escape") mealsDragCleanup(); }

async function mealsDragKey(e, handle) {
  const step = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[e.key];
  if (!step) return;
  e.preventDefault();
  const days = [...document.querySelectorAll("#mealsWeek .meals-day")].map((el) => el.dataset.date);
  const from = handle.closest(".meals-day").dataset.date;
  const to = days[days.indexOf(from) + step];
  if (!to) return;
  const planId = Number(handle.closest(".meal-item").dataset.id);
  await moveMealPlan(planId, to);
  const moved = document.querySelector(`#mealsWeek .meal-item[data-id="${planId}"] .meal-drag-handle`);
  if (moved) moved.focus();
}

async function moveMealPlan(planId, date) {
  const p = mealsPlan.find((x) => x.id === planId);
  if (!p || p.plan_date === date) return;
  const prev = p.plan_date;
  p.plan_date = date; // show it on the new day right away
  renderMeals();
  const { error } = await sb.from("meal_plan").update({ plan_date: date }).eq("id", planId);
  if (error) {
    p.plan_date = prev;
    renderMeals();
    alert("Failed to move: " + error.message);
  }
}

// ---------- shopping status ----------
// shop_status: null = not checked yet, 'need' = have to shop, 'in_cart' = shopped/ordered
// (on its way), 'have' = have everything.
const MEALS_SHOP_STATES = [
  { v: "need", label: "Need", title: "I need to buy things for this" },
  { v: "in_cart", label: "In cart", title: "What I need is in the cart / ordered" },
  { v: "have", label: "Have ✓", title: "I have everything for this" },
];

function mealsHaveHtml(p) {
  const v = p.shop_status;
  const missing = v === "need" || v === "in_cart"
    ? `<input type="text" class="meal-missing" maxlength="500" placeholder="What do you need? (e.g. limes, cilantro)" value="${escapeHtml(p.missing_items || "")}" />`
    : "";
  return `
    <div class="meal-have" role="group" aria-label="Shopping status">
      ${MEALS_SHOP_STATES.map((st) => `<button type="button" class="meal-have-btn ${st.v} ${v === st.v ? "on" : ""}" data-v="${st.v}" aria-pressed="${v === st.v}" title="${st.title}">${st.label}</button>`).join("")}
    </div>
    ${missing}`;
}

async function setMealHave(planId, value) {
  const p = mealsPlan.find((x) => x.id === planId);
  if (!p) return;
  // Clicking the button that's already on clears it back to "not checked yet".
  const next = p.shop_status === value ? null : value;
  const { error } = await sb.from("meal_plan").update({ shop_status: next }).eq("id", planId);
  if (error) { alert("Failed to update: " + error.message); return; }
  p.shop_status = next;
  renderMeals();
  if (next === "need") {
    const input = document.querySelector(`#mealsWeek .meal-item[data-id="${planId}"] .meal-missing`);
    if (input && !input.value) input.focus();
  }
}

async function saveMealMissing(planId, input) {
  const p = mealsPlan.find((x) => x.id === planId);
  if (!p) return;
  const val = input.value.trim() || null;
  if (val === (p.missing_items || null)) return;
  const { error } = await sb.from("meal_plan").update({ missing_items: val }).eq("id", planId);
  if (error) { alert("Failed to save: " + error.message); input.value = p.missing_items || ""; return; }
  p.missing_items = val;
  renderMealsShopSummary();
}

// ---------- lunch / dinner, eating out ----------
function mealsSlot(p) {
  return p.meal_slot === "lunch" ? "lunch" : "dinner";
}

function mealsSlotHtml(p) {
  const s = mealsSlot(p);
  return `<span class="meal-slot" role="group" aria-label="Lunch or dinner">${["lunch", "dinner"].map((v) =>
    `<button type="button" class="meal-slot-btn ${s === v ? "on" : ""}" data-slot="${v}" aria-pressed="${s === v}" title="${v === "lunch" ? "Make this lunch" : "Make this dinner"}">${v === "lunch" ? "Lunch" : "Dinner"}</button>`).join("")}</span>`;
}

async function setMealSlot(planId, slot) {
  const p = mealsPlan.find((x) => x.id === planId);
  if (!p || mealsSlot(p) === slot) return;
  const prev = p.meal_slot;
  p.meal_slot = slot;
  renderMeals();
  const { error } = await sb.from("meal_plan").update({ meal_slot: slot }).eq("id", planId);
  if (error) { p.meal_slot = prev; renderMeals(); alert("Failed to update: " + error.message); }
}

async function addEatingOut(date, btn) {
  if (btn) btn.disabled = true;
  const { data, error } = await sb.from("meal_plan")
    .insert({ plan_date: date, eating_out: true, meal_slot: "dinner" }).select().single();
  if (btn) btn.disabled = false;
  if (error) { alert("Couldn't add it: " + error.message); return; }
  mealsPlan.push(data);
  renderMeals();
  const input = document.querySelector(`#mealsWeek .meal-item[data-id="${data.id}"] .meal-eat-out-place`);
  if (input) input.focus();
}

async function saveEatOutPlace(planId, input) {
  const p = mealsPlan.find((x) => x.id === planId);
  if (!p) return;
  const val = input.value.trim() || null;
  if (val === (p.eat_out_place || null)) return;
  const { error } = await sb.from("meal_plan").update({ eat_out_place: val }).eq("id", planId);
  if (error) { alert("Failed to save: " + error.message); input.value = p.eat_out_place || ""; return; }
  p.eat_out_place = val;
  renderMealsWeek();
}

// ---------- away (traveling) ----------
function mealsAwayOn(ds) {
  return mealsAway.some((a) => a.away_date === ds);
}

async function toggleMealAway(dates, on, btn) {
  if (btn) btn.disabled = true;
  let error;
  if (on) {
    const rows = dates.filter((d) => !mealsAwayOn(d)).map((d) => ({ away_date: d }));
    if (rows.length) {
      const res = await sb.from("meal_away").insert(rows).select("id, away_date, note");
      error = res.error;
      if (!error) mealsAway.push(...res.data);
    }
  } else {
    const ids = mealsAway.filter((a) => dates.includes(a.away_date)).map((a) => a.id);
    if (ids.length) {
      ({ error } = await sb.from("meal_away").delete().in("id", ids));
      if (!error) mealsAway = mealsAway.filter((a) => !ids.includes(a.id));
    }
  }
  if (btn) btn.disabled = false;
  if (error) { alert("Couldn't save: " + error.message); return; }
  renderMealsWeek();
}

function mealsWeekDays() {
  const days = [];
  for (let i = 0; i < 7; i++) { const d = new Date(mealsWeekStart); d.setDate(d.getDate() + i); days.push(toLocalDateStr(d)); }
  return days;
}

// One line above the week: which planned (not yet cooked) meals still need shopping.
function renderMealsShopSummary(days) {
  if (!days) days = mealsWeekDays();
  const el = document.getElementById("mealsShopSummary");
  // Nothing to shop for on days we're away.
  const open = mealsPlan.filter((p) => days.includes(p.plan_date) && !p.cooked_at && !p.eating_out && !mealsAwayOn(p.plan_date));
  const need = open.filter((p) => p.shop_status === "need");
  const inCart = open.filter((p) => p.shop_status === "in_cart");
  if (!need.length && !inCart.length) { el.classList.add("hidden"); el.innerHTML = ""; return; }
  const lines = [];
  if (need.length) {
    const items = need.map((p) => p.missing_items).filter(Boolean);
    lines.push(`🛒&nbsp; <strong>${need.length} meal${need.length === 1 ? "" : "s"}</strong> still need${need.length === 1 ? "s" : ""} shopping`
      + (items.length ? `: ${items.map(escapeHtml).join(", ")}` : ""));
  }
  if (inCart.length) {
    lines.push(`🛍️&nbsp; <strong>${inCart.length}</strong> in the cart`);
  }
  el.innerHTML = lines.map((l) => `<div>${l}</div>`).join("");
  el.classList.toggle("all-in-cart", !need.length);
  el.classList.remove("hidden");
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
        <span class="meals-history-title">${mealsRecipeTitleHtml(r)}${n > 1 ? ` <span class="hint">${n}×</span>` : ""}${p.cook_note ? `<span class="meal-cook-note">${escapeHtml(p.cook_note)}</span>` : ""}</span>
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
    const host = r.url_key ? r.url_key.split("/")[0] : (r.source_text ? "pasted" : "no link");
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
  if (mealsOpenRecipeId === id) closeRecipeDrawer();
  renderMeals();
}

// ---------- recipe side pane ----------
// Click any recipe name (week, history, recipe box) to open it: link + pasted recipe, notes,
// every time it was cooked (with a note per time), what's planned, and rename/delete.
let mealsOpenRecipeId = null;

// Any recipe name anywhere on the Meals tab opens the pane.
document.getElementById("homeMeals").addEventListener("click", (e) => {
  const btn = e.target.closest(".meal-open-recipe");
  if (btn) openRecipeDrawer(Number(btn.dataset.recipeId));
});

function openRecipeDrawer(id) {
  const r = mealsRecipes.find((x) => x.id === id);
  if (!r) return;
  if (mealsOpenRecipeId !== id) {
    mealsOpenRecipeId = id;
    document.getElementById("recipeNotes").value = r.notes || "";
    document.getElementById("recipeNotesStatus").textContent = "";
    document.getElementById("recipeLogDate").value = todayLocalStr();
    document.getElementById("recipeLogNote").value = "";
    document.getElementById("recipePlanDate").value = todayLocalStr();
  }
  renderRecipeDrawer();
  document.getElementById("recipeDrawer").classList.add("open");
  document.getElementById("recipeBackdrop").classList.add("open");
}

async function closeRecipeDrawer() {
  if (mealsOpenRecipeId == null) return;
  await saveRecipeNotes(); // don't lose a note typed right before closing
  mealsOpenRecipeId = null;
  document.getElementById("recipeDrawer").classList.remove("open");
  document.getElementById("recipeBackdrop").classList.remove("open");
}

function renderRecipeDrawer() {
  if (mealsOpenRecipeId == null) return;
  const r = mealsRecipes.find((x) => x.id === mealsOpenRecipeId);
  if (!r) { closeRecipeDrawer(); return; }

  document.getElementById("recipeDrawerTitle").textContent = r.title;
  const where = r.url_key ? r.url_key.split("/")[0] : (r.source_text ? "pasted recipe" : "no link");
  const added = r.created_by ? ` · added by ${mealsWho(r.created_by)}` : "";
  document.getElementById("recipeDrawerSubtitle").textContent = where + added;

  const u = r.url && mealsParseUrl(r.url);
  document.getElementById("recipeDrawerLink").innerHTML = u
    ? `<a href="${escapeHtml(u.href)}" target="_blank" rel="noopener noreferrer">Open recipe ↗</a>`
    : "";
  document.getElementById("recipeDrawerText").innerHTML = mealsRecipeTextHtml(r);
  // Someone else may have edited the notes; only refresh the box if it isn't being typed in.
  const notesEl = document.getElementById("recipeNotes");
  if (document.activeElement !== notesEl) notesEl.value = r.notes || "";

  const rows = mealsPlan.filter((p) => p.recipe_id === r.id);
  const cooked = rows.filter((p) => p.cooked_at).sort((a, b) => b.plan_date.localeCompare(a.plan_date) || b.id - a.id);
  const today = todayLocalStr();
  const upcoming = rows.filter((p) => !p.cooked_at).sort((a, b) => a.plan_date.localeCompare(b.plan_date));

  document.getElementById("recipeCookCount").textContent = cooked.length
    ? `${cooked.length}× · last ${mealsFmtDate(cooked[0].plan_date, { month: "short", day: "numeric", year: "numeric" })}`
    : "";

  document.getElementById("recipeCookHistory").innerHTML = cooked.length
    ? cooked.map((p) => `
      <div class="recipe-cook-row" data-id="${p.id}">
        <div class="recipe-cook-head">
          <span class="recipe-cook-date">${escapeHtml(mealsFmtDate(p.plan_date, { weekday: "short", month: "short", day: "numeric", year: "numeric" }))}</span>
          <span class="hint">${escapeHtml(mealsWho(p.cooked_by))}</span>
          <button class="plan-item-remove recipe-cook-remove" aria-label="Remove from history" title="Remove from history">&times;</button>
        </div>
        <input type="text" class="recipe-cook-note" maxlength="2000" placeholder="Add a note for this time…" value="${escapeHtml(p.cook_note || "")}" />
      </div>`).join("")
    : `<div class="journal-empty">Not cooked yet. Check it off on the plan, or log a time above.</div>`;

  document.getElementById("recipeUpcoming").innerHTML = upcoming.length
    ? upcoming.map((p) => {
        const st = MEALS_SHOP_STATES.find((s) => s.v === p.shop_status);
        const late = p.plan_date < today ? ` <span class="hint">(not checked off)</span>` : "";
        return `
        <div class="recipe-upcoming-row" data-id="${p.id}">
          <button type="button" class="recipe-upcoming-date" data-date="${p.plan_date}" title="Show this week">${escapeHtml(mealsFmtDate(p.plan_date))}</button>${late}
          ${st ? `<span class="meal-have-btn ${st.v} on recipe-upcoming-status">${st.label}</span>` : ""}
        </div>`;
      }).join("")
    : `<div class="journal-empty">Not on the plan.</div>`;

  const hist = document.getElementById("recipeCookHistory");
  hist.querySelectorAll(".recipe-cook-note").forEach((input) => {
    input.addEventListener("change", () => saveCookNote(Number(input.closest(".recipe-cook-row").dataset.id), input));
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); input.blur(); } });
  });
  hist.querySelectorAll(".recipe-cook-remove").forEach((btn) => {
    btn.addEventListener("click", () => removeMealPlan(Number(btn.closest(".recipe-cook-row").dataset.id)));
  });
  document.querySelectorAll("#recipeUpcoming .recipe-upcoming-date").forEach((btn) => {
    btn.addEventListener("click", () => {
      closeRecipeDrawer();
      mealsJumpToDate(btn.dataset.date);
      document.getElementById("mealsWeek").scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });
}

async function saveRecipeNotes() {
  const id = mealsOpenRecipeId;
  const r = id != null && mealsRecipes.find((x) => x.id === id);
  if (!r) return;
  const el = document.getElementById("recipeNotes");
  const val = el.value.trim() || null;
  if (val === (r.notes || null)) return;
  const status = document.getElementById("recipeNotesStatus");
  status.textContent = "Saving…";
  const { error } = await sb.from("recipes").update({ notes: val }).eq("id", id);
  if (error) { status.textContent = "Couldn't save: " + error.message; return; }
  r.notes = val;
  status.textContent = "Saved";
  setTimeout(() => { if (status.textContent === "Saved") status.textContent = ""; }, 1500);
  renderMealsWeek();
  renderMealsHistory();
  renderMealsRecipes();
}

let mealsNotesTimer = null;
document.getElementById("recipeNotes").addEventListener("input", () => {
  document.getElementById("recipeNotesStatus").textContent = "";
  clearTimeout(mealsNotesTimer);
  mealsNotesTimer = setTimeout(saveRecipeNotes, 1200);
});
document.getElementById("recipeNotes").addEventListener("blur", () => { clearTimeout(mealsNotesTimer); saveRecipeNotes(); });

async function saveCookNote(planId, input) {
  const p = mealsPlan.find((x) => x.id === planId);
  if (!p) return;
  const val = input.value.trim() || null;
  if (val === (p.cook_note || null)) return;
  const { error } = await sb.from("meal_plan").update({ cook_note: val }).eq("id", planId);
  if (error) { alert("Failed to save the note: " + error.message); input.value = p.cook_note || ""; return; }
  p.cook_note = val;
  renderMealsWeek();
  renderMealsHistory();
}

// Log a time it was cooked that wasn't on the plan (or before the app existed).
document.getElementById("recipeLogCookForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const id = mealsOpenRecipeId;
  const date = document.getElementById("recipeLogDate").value;
  if (id == null || !date) return;
  const note = document.getElementById("recipeLogNote").value.trim() || null;
  const btn = e.submitter || e.target.querySelector("button");
  btn.disabled = true;
  try {
    const { data: { session } } = await sb.auth.getSession();
    // Already planned for that day and not checked off? Check that one off instead of adding a second.
    const planned = mealsPlan.find((p) => p.recipe_id === id && p.plan_date === date && !p.cooked_at);
    const patch = { cooked_at: new Date().toISOString(), cooked_by: session?.user?.email || null };
    if (note) patch.cook_note = note;
    const q = planned
      ? sb.from("meal_plan").update(patch).eq("id", planned.id).select().single()
      : sb.from("meal_plan").insert({ recipe_id: id, plan_date: date, ...patch }).select().single();
    const { data, error } = await q;
    if (error) { alert("Failed to log it: " + error.message); return; }
    if (planned) Object.assign(planned, data); else mealsPlan.push(data);
    document.getElementById("recipeLogNote").value = "";
    renderMeals();
  } finally {
    btn.disabled = false;
  }
});

document.getElementById("recipePlanForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const id = mealsOpenRecipeId;
  const date = document.getElementById("recipePlanDate").value;
  if (id == null || !date) return;
  const btn = e.submitter || e.target.querySelector("button");
  btn.disabled = true;
  const err = await addMealPlan(id, date);
  btn.disabled = false;
  if (err) { alert("Failed to plan: " + err.message); return; }
  mealsJumpToDate(date);
});

document.getElementById("recipeRenameBtn").addEventListener("click", () => {
  if (mealsOpenRecipeId != null) renameRecipe(mealsOpenRecipeId);
});
document.getElementById("recipeDeleteBtn").addEventListener("click", () => {
  if (mealsOpenRecipeId != null) deleteRecipe(mealsOpenRecipeId);
});
document.getElementById("recipeDrawerCloseBtn").addEventListener("click", closeRecipeDrawer);
document.getElementById("recipeBackdrop").addEventListener("click", closeRecipeDrawer);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && mealsOpenRecipeId != null) closeRecipeDrawer();
});

// ---------- add ----------
async function addMealPlan(recipeId, date, slot) {
  const { data, error } = await sb.from("meal_plan").insert({ recipe_id: recipeId, plan_date: date, meal_slot: slot || "dinner" }).select().single();
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
  const noDate = document.getElementById("mealNoDate").checked;
  const date = noDate ? "" : document.getElementById("mealDate").value;

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
      const err = await addMealPlan(recipe.id, date, document.getElementById("mealSlot").value);
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
document.getElementById("mealsAwayWeekBtn").addEventListener("click", (e) => {
  const days = mealsWeekDays();
  toggleMealAway(days, !days.every((ds) => mealsAwayOn(ds)), e.currentTarget);
});
document.getElementById("mealsThisWeekBtn").addEventListener("click", () => {
  mealsWeekStart = mealsMonday(new Date());
  renderMeals();
});
document.getElementById("mealDate").value = todayLocalStr();

// "No day" saves the recipe to the Recipe Box without putting it on the plan.
function syncMealNoDate() {
  const off = document.getElementById("mealNoDate").checked;
  const dateInput = document.getElementById("mealDate");
  if (!off && !dateInput.value) dateInput.value = todayLocalStr();
  dateInput.disabled = off;
  document.getElementById("mealSlot").disabled = off;
  dateInput.closest(".meal-date-label").classList.toggle("is-off", off);
  document.getElementById("mealAddBtn").textContent = off ? "Save" : "Add";
}
document.getElementById("mealNoDate").addEventListener("change", syncMealNoDate);
syncMealNoDate(); // browsers can restore the checkbox's state on reload
document.getElementById("mealDate").addEventListener("input", () => {
  // Clearing the date by hand means the same thing as ticking "No day".
  if (!document.getElementById("mealDate").value) {
    document.getElementById("mealNoDate").checked = true;
    syncMealNoDate();
  }
});
