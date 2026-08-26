const TIMES_OF_DAY = ["Morning", "Mid Morning", "Noon", "Night"];
const TIME_KEY = { Morning: "morning", "Mid Morning": "mid_morning", Noon: "noon", Night: "night" };
const ROL_RANGE_DAYS = 14;

let rolRows = [];
let rolPractices = []; // [{id, name, emoji, morning, mid_morning, noon, night, sort_order}], ordered by sort_order
let rolDisruptions = [];
let allDisruptionCauses = []; // every cause ever logged, all-time — powers the reusable suggestion chips
let spiritualLoadedOnce = false;
let checkinDateOffset = 0; // 0 = today, 1 = yesterday, 2 = day before

async function loadSpiritualData() {
  // Only blank the page on the first load — background refreshes update in place.
  if (!spiritualLoadedOnce) {
    document.getElementById("rolLoading").classList.remove("hidden");
    document.getElementById("rolLoading").textContent = "Loading data…";
    document.querySelectorAll("#spiritualApp .cards, #spiritualApp .panel").forEach((el) => el.classList.add("hidden"));
  }

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - ROL_RANGE_DAYS + 1);

  const fetchPromise = Promise.all([
    sb.from("rule_of_life_log").select("*").gte("log_date", toLocalDateStr(cutoff))
      .order("log_date", { ascending: true }).order("id", { ascending: true }),
    sb.from("rule_of_life_practices").select("*").order("sort_order", { ascending: true }),
    sb.from("rule_of_life_disruptions").select("*").gte("log_date", toLocalDateStr(cutoff))
      .order("log_date", { ascending: true }).order("id", { ascending: true }),
    // Unscoped by date (unlike the trend query above) so a cause you used months ago —
    // like a recurring "Sabbath" — still shows up as a one-click suggestion today.
    sb.from("rule_of_life_disruptions").select("cause"),
  ]);

  let logRes, practicesRes, disruptionsRes, allCausesRes;
  try {
    [logRes, practicesRes, disruptionsRes, allCausesRes] = await withTimeout(fetchPromise, 15000, "Loading spiritual data");
  } catch (e) {
    document.getElementById("rolLoading").textContent = e.message;
    document.getElementById("rolLoading").classList.remove("hidden");
    return;
  }

  document.getElementById("rolLoading").classList.add("hidden");
  const error = logRes.error || practicesRes.error || disruptionsRes.error || allCausesRes.error;
  if (error) {
    document.getElementById("rolLoading").textContent = "Error loading data: " + error.message;
    document.getElementById("rolLoading").classList.remove("hidden");
    return;
  }
  markUpdated("spiritualUpdatedAt");
  spiritualLoadedOnce = true;
  rolRows = logRes.data;
  rolPractices = practicesRes.data;
  rolDisruptions = disruptionsRes.data;
  allDisruptionCauses = allCausesRes.data;
  renderSpiritual();
}

function renderSpiritual() {
  const todayStr = todayLocalStr();
  renderCheckin();
  renderRolCards(todayStr);
  renderRolGrid(todayStr);
  renderRolBreakdown(todayStr);
  renderPracticesList();
  renderDisruptionBreakdown();
  renderDisruptionList();
  document.querySelectorAll("#spiritualApp .cards, #spiritualApp .panel").forEach((el) => el.classList.remove("hidden"));
}

function getCheckinViewDate() {
  const d = new Date();
  d.setDate(d.getDate() - checkinDateOffset);
  return toLocalDateStr(d);
}

function rolDayRange(todayStr) {
  // Always show the full trailing window (even with no data yet), so the grid/stats
  // reflect the declared "last 14 days" rather than collapsing to just today.
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - ROL_RANGE_DAYS + 1);
  const windowStart = toLocalDateStr(cutoff);
  const earliestRow = rolRows.length ? rolRows[0].log_date : todayStr;
  const min = earliestRow < windowStart ? earliestRow : windowStart;
  return dateRangeArray(min, todayStr);
}

function findRolRow(date, time, practice) {
  return rolRows.find((r) => r.log_date === date && r.time_of_day === time && r.practice === practice);
}

function practiceLabel(p) {
  return p.emoji ? `${p.emoji} ${p.name}` : p.name;
}

function renderCheckin() {
  const viewDate = getCheckinViewDate();
  const isToday = checkinDateOffset === 0;
  const dateLabel = new Date(viewDate + "T00:00:00").toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
  document.getElementById("checkinHeading").textContent = isToday ? `Today's Check-In — ${dateLabel}` : `Check-In — ${dateLabel}`;

  document.getElementById("checkinPrevBtn").disabled = checkinDateOffset >= 2;
  document.getElementById("checkinNextBtn").disabled = checkinDateOffset <= 0;

  const html = TIMES_OF_DAY.map((time) => {
    const applicable = rolPractices.filter((p) => p[TIME_KEY[time]]);
    const items = applicable.map((p) => {
      const row = findRolRow(viewDate, time, p.name);
      const checked = !!row;
      return `
        <label class="rol-item ${checked ? "done" : ""}" data-time="${time}" data-practice="${p.name}" data-id="${row ? row.id : ""}">
          <input type="checkbox" ${checked ? "checked" : ""} />
          <span>${practiceLabel(p)}</span>
        </label>
      `;
    }).join("");
    return `
      <div class="checkin-group">
        <h3>${time}</h3>
        <div class="rol-checklist">${applicable.length ? items : `<div class="journal-empty">No practices assigned to ${time.toLowerCase()}.</div>`}</div>
      </div>
    `;
  }).join("");

  document.getElementById("checkinGroups").innerHTML = html;

  document.querySelectorAll("#checkinGroups .rol-item").forEach((label) => {
    label.addEventListener("click", (e) => {
      e.preventDefault();
      if (label.dataset.busy) return;
      toggleCheckin(label);
    });
  });

  renderDisruptionToday(viewDate);
  renderDisruptionSuggestions(viewDate);
}

async function toggleCheckin(label) {
  const time = label.dataset.time;
  const practice = label.dataset.practice;
  const id = label.dataset.id;
  const viewDate = getCheckinViewDate();

  label.dataset.busy = "1";
  if (id) {
    const { error } = await sb.from("rule_of_life_log").delete().eq("id", id);
    if (error) { alert("Failed to update: " + error.message); delete label.dataset.busy; return; }
  } else {
    const { error } = await sb.from("rule_of_life_log").insert({ log_date: viewDate, time_of_day: time, practice });
    if (error) { alert("Failed to update: " + error.message); delete label.dataset.busy; return; }
  }
  await loadSpiritualData();
}

document.getElementById("checkinPrevBtn").addEventListener("click", () => {
  if (checkinDateOffset >= 2) return;
  checkinDateOffset++;
  renderCheckin();
});
document.getElementById("checkinNextBtn").addEventListener("click", () => {
  if (checkinDateOffset <= 0) return;
  checkinDateOffset--;
  renderCheckin();
});

function renderRolCards(todayStr) {
  const days = rolDayRange(todayStr);
  const completeDays = days.filter((d) => d !== todayStr);
  const practiceCount = rolPractices.length;

  const perDayPractices = {};
  days.forEach((d) => { perDayPractices[d] = new Set(); });
  rolRows.forEach((r) => { if (perDayPractices[r.log_date]) perDayPractices[r.log_date].add(r.practice); });

  const anyDay = (d) => perDayPractices[d] && perDayPractices[d].size > 0;
  const fullDay = (d) => perDayPractices[d] && perDayPractices[d].size === practiceCount;

  let currentStreak = 0;
  for (let i = completeDays.length - 1; i >= 0; i--) {
    if (anyDay(completeDays[i])) currentStreak++;
    else break;
  }

  let longestStreak = 0, run = 0;
  completeDays.forEach((d) => {
    if (anyDay(d)) { run++; longestStreak = Math.max(longestStreak, run); }
    else run = 0;
  });

  const perfectDays = completeDays.filter(fullDay).length;
  const totalPossible = completeDays.length * practiceCount;
  const totalDone = completeDays.reduce((s, d) => s + perDayPractices[d].size, 0);
  const adherencePct = totalPossible ? Math.round((totalDone / totalPossible) * 100) : 0;
  const todaySet = perDayPractices[todayStr] || new Set();

  const cards = [
    { label: "Today", value: `${todaySet.size}/${practiceCount}`, sub: "practices done so far" },
    { label: "Current streak", value: `${currentStreak} day${currentStreak === 1 ? "" : "s"}`, sub: "at least one practice", cls: "streak" },
    { label: "Longest streak", value: `${longestStreak} day${longestStreak === 1 ? "" : "s"}`, sub: `out of ${completeDays.length} days`, cls: "streak" },
    { label: "Perfect days", value: `${perfectDays}`, sub: `all ${practiceCount} practices done` },
    { label: "Adherence", value: `${adherencePct}%`, sub: `last ${completeDays.length} days`, cls: adherencePct < 50 ? "warn" : "" },
  ];

  document.getElementById("rolCards").innerHTML = cards.map((c) => `
    <div class="card ${c.cls || ""}">
      <div class="label">${c.label}</div>
      <div class="value">${c.value}</div>
      <div class="sub">${c.sub}</div>
    </div>
  `).join("");
}

function renderRolGrid(todayStr) {
  const days = rolDayRange(todayStr);
  const grid = document.getElementById("rolGrid");
  grid.classList.add("rol");
  grid.style.setProperty("--days", days.length);

  const doneSet = new Set(rolRows.map((r) => `${r.log_date}|${r.practice}`));

  let html = `<div class="row-label"></div>`;
  days.forEach((d) => { html += `<div class="date-label">${fmtShort(d)}</div>`; });

  rolPractices.forEach((p) => {
    html += `<div class="row-label">${practiceLabel(p)}</div>`;
    days.forEach((d) => {
      const logged = doneSet.has(`${d}|${p.name}`);
      html += `<div class="cell ${logged ? "logged" : "missing"}" title="${p.name} on ${d}: ${logged ? "done" : "not done"}"></div>`;
    });
  });

  grid.innerHTML = html;
}

function renderRolBreakdown(todayStr) {
  const days = rolDayRange(todayStr).filter((d) => d !== todayStr);
  const doneSet = new Set(rolRows.map((r) => `${r.log_date}|${r.practice}`));

  const rows = rolPractices.map((p) => {
    const doneDays = days.filter((d) => doneSet.has(`${d}|${p.name}`)).length;
    const pct = days.length ? Math.round((doneDays / days.length) * 100) : 0;
    return { practice: practiceLabel(p), pct, doneDays, total: days.length };
  });

  document.getElementById("rolBreakdown").innerHTML = rows.map((r) => `
    <div class="rol-breakdown-row">
      <div class="rol-breakdown-label">${r.practice}</div>
      <div class="rol-breakdown-bar-track"><div class="rol-breakdown-bar" style="width:${r.pct}%"></div></div>
      <div class="rol-breakdown-pct">${r.pct}% <span class="rol-breakdown-days">(${r.doneDays}/${r.total})</span></div>
    </div>
  `).join("");
}

// ---------- disruption tracking ----------
// Chips for whatever's logged on the day currently being viewed in the check-in panel.
function renderDisruptionToday(viewDate) {
  const todays = rolDisruptions.filter((d) => d.log_date === viewDate);
  document.getElementById("disruptionTodayList").innerHTML = todays.map((d) => `
    <span class="disruption-chip" data-id="${d.id}">
      ${d.cause}
      <button aria-label="Remove">&times;</button>
    </span>
  `).join("");

  document.querySelectorAll("#disruptionTodayList .disruption-chip button").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.closest(".disruption-chip").dataset.id;
      const { error } = await sb.from("rule_of_life_disruptions").delete().eq("id", id);
      if (error) { alert("Failed to remove: " + error.message); return; }
      await loadSpiritualData();
    });
  });
}

// causeOverride lets the suggestion chips log a pick with one click, bypassing the
// text input entirely — same insert path as typing it in and pressing "Log it".
async function logDisruption(causeOverride) {
  const input = document.getElementById("disruptionCause");
  const cause = (causeOverride != null ? causeOverride : input.value).trim();
  if (!cause) return;
  const viewDate = getCheckinViewDate();
  const { error } = await sb.from("rule_of_life_disruptions").insert({ log_date: viewDate, cause });
  if (error) { alert("Failed to log: " + error.message); return; }
  input.value = "";
  await loadSpiritualData();
}

document.getElementById("logDisruptionBtn").addEventListener("click", () => logDisruption());
document.getElementById("disruptionCause").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); logDisruption(); }
});

// Groups causes by trimmed/lowercased text so similar entries ("Community group" vs
// "community group") count together, while surfacing the most common original casing
// and how many times each has been logged (most-used first).
function groupCauses(rows) {
  const groups = {};
  rows.forEach((d) => {
    const key = d.cause.trim().toLowerCase();
    if (!groups[key]) groups[key] = { count: 0, labelCounts: {} };
    groups[key].count++;
    groups[key].labelCounts[d.cause] = (groups[key].labelCounts[d.cause] || 0) + 1;
  });
  return Object.values(groups)
    .map((g) => ({ count: g.count, label: Object.keys(g.labelCounts).sort((a, b) => g.labelCounts[b] - g.labelCounts[a])[0] }))
    .sort((a, b) => b.count - a.count);
}

// Reusable "pick it again" chips built from every cause ever logged (all-time, not just
// the 14-day trend window) — a recurring thing like "Sabbath" is one click from then on,
// not retyped every time. Causes already logged for the viewed day are hidden here since
// they already show (with a remove option) in the today list below.
function renderDisruptionSuggestions(viewDate) {
  const todaysCauses = new Set(
    rolDisruptions.filter((d) => d.log_date === viewDate).map((d) => d.cause.trim().toLowerCase())
  );
  const entries = groupCauses(allDisruptionCauses).filter((e) => !todaysCauses.has(e.label.trim().toLowerCase()));

  document.getElementById("disruptionSuggestions").innerHTML = entries.map((e, i) => `
    <button type="button" class="disruption-suggestion-chip" data-index="${i}">${e.label}</button>
  `).join("");

  document.querySelectorAll("#disruptionSuggestions .disruption-suggestion-chip").forEach((btn) => {
    btn.addEventListener("click", () => logDisruption(entries[Number(btn.dataset.index)].label));
  });
}

function renderDisruptionBreakdown() {
  const entries = groupCauses(rolDisruptions);

  document.getElementById("disruptionTrendsPanel").classList.toggle("hidden", entries.length === 0);
  if (!entries.length) return;

  const maxCount = Math.max(...entries.map((e) => e.count));

  document.getElementById("disruptionBreakdown").innerHTML = entries.map((e) => {
    const pct = Math.round((e.count / maxCount) * 100);
    return `
      <div class="rol-breakdown-row">
        <div class="rol-breakdown-label">${e.label}</div>
        <div class="rol-breakdown-bar-track"><div class="rol-breakdown-bar" style="width:${pct}%; background: ${CHART_COLORS.cal}"></div></div>
        <div class="rol-breakdown-pct">${e.count} time${e.count === 1 ? "" : "s"}</div>
      </div>
    `;
  }).join("");
}

function renderDisruptionList() {
  document.getElementById("disruptionList").innerHTML = [...rolDisruptions].reverse().map((d) => `
    <div class="disruption-item">
      <span class="cause">${d.cause}</span>
      <span class="date">${fmtShort(d.log_date)}</span>
    </div>
  `).join("");
}

// ---------- emoji picker ----------
// One shared popover (lazily created, reused for both the new-practice form and every
// existing-practice row) rather than one per input, since only one can be open at a time.
const HABIT_EMOJI_CHOICES = ["🙏", "🧘", "📖", "📓", "✍️", "💧", "🥗", "🍎", "🏃", "🚶", "💪", "🧹", "😴", "🌙", "☀️", "📵", "🎯", "🧠", "❤️", "🎵", "🚿", "🧴", "🦷", "🌿"];
let emojiPickerPopover = null;
let emojiPickerTargetInput = null;

function closeEmojiPicker() {
  if (emojiPickerPopover) emojiPickerPopover.classList.add("hidden");
  emojiPickerTargetInput = null;
}

function openEmojiPicker(targetInput) {
  if (!emojiPickerPopover) {
    emojiPickerPopover = document.createElement("div");
    emojiPickerPopover.className = "emoji-picker-popover hidden";
    emojiPickerPopover.innerHTML = HABIT_EMOJI_CHOICES.map((em) => `<button type="button">${em}</button>`).join("");
    document.body.appendChild(emojiPickerPopover);
    emojiPickerPopover.addEventListener("click", (e) => {
      const btn = e.target.closest("button");
      if (!btn || !emojiPickerTargetInput) return;
      emojiPickerTargetInput.value = btn.textContent;
      emojiPickerTargetInput.dispatchEvent(new Event("change", { bubbles: true }));
      closeEmojiPicker();
    });
  }
  emojiPickerTargetInput = targetInput;
  const rect = targetInput.getBoundingClientRect();
  emojiPickerPopover.style.top = `${rect.bottom + 4}px`;
  emojiPickerPopover.style.left = `${rect.left}px`;
  emojiPickerPopover.classList.remove("hidden");
}

document.addEventListener("click", (e) => {
  const input = e.target.closest(".practice-emoji-input");
  if (input) {
    const alreadyOpenForThis = emojiPickerTargetInput === input && emojiPickerPopover && !emojiPickerPopover.classList.contains("hidden");
    alreadyOpenForThis ? closeEmojiPicker() : openEmojiPicker(input);
    return;
  }
  if (emojiPickerPopover && !emojiPickerPopover.contains(e.target)) closeEmojiPicker();
});

document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeEmojiPicker(); });

// ---------- manage practices drawer ----------
function renderPracticesList() {
  document.getElementById("practicesList").innerHTML = rolPractices.map((p) => `
    <div class="practice-row">
      <div class="name-row">
        <input type="text" class="practice-emoji-input" data-id="${p.id}" value="${p.emoji || ""}" placeholder="🙂" maxlength="8" autocomplete="off" readonly />
        <div class="name">${p.name}</div>
      </div>
      <div class="time-toggles">
        ${TIMES_OF_DAY.map((time) => {
          const key = TIME_KEY[time];
          return `
            <label class="time-toggle">
              <input type="checkbox" data-id="${p.id}" data-field="${key}" ${p[key] ? "checked" : ""} />
              ${time}
            </label>
          `;
        }).join("")}
      </div>
    </div>
  `).join("");

  document.querySelectorAll("#practicesList input[type=checkbox]").forEach((input) => {
    input.addEventListener("change", async () => {
      const id = input.dataset.id;
      const field = input.dataset.field;
      input.disabled = true;
      const { error } = await sb.from("rule_of_life_practices").update({ [field]: input.checked }).eq("id", id);
      if (error) { alert("Failed to update: " + error.message); }
      await loadSpiritualData();
    });
  });

  document.querySelectorAll(".practice-emoji-input").forEach((input) => {
    input.addEventListener("change", async () => {
      const id = input.dataset.id;
      const emoji = input.value.trim() || null;
      input.disabled = true;
      const { error } = await sb.from("rule_of_life_practices").update({ emoji }).eq("id", id);
      if (error) { alert("Failed to update: " + error.message); }
      await loadSpiritualData();
    });
  });
}

function openPracticesDrawer() {
  document.getElementById("practicesDrawer").classList.add("open");
  document.getElementById("practicesBackdrop").classList.add("open");
}
function closePracticesDrawer() {
  document.getElementById("practicesDrawer").classList.remove("open");
  document.getElementById("practicesBackdrop").classList.remove("open");
}

document.getElementById("managePracticesBtn").addEventListener("click", openPracticesDrawer);
document.getElementById("practicesCloseBtn").addEventListener("click", closePracticesDrawer);
document.getElementById("practicesBackdrop").addEventListener("click", closePracticesDrawer);
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closePracticesDrawer(); });

document.getElementById("addPracticeForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const emojiInput = document.getElementById("newPracticeEmoji");
  const input = document.getElementById("newPracticeName");
  const name = input.value.trim();
  const emoji = emojiInput.value.trim() || null;
  if (!name) return;
  try {
    const sortOrder = rolPractices.length ? Math.max(...rolPractices.map((p) => p.sort_order)) + 1 : 1;
    // New practices start opted out of every time slot — the person adding it picks
    // where it belongs afterward via the checkboxes, rather than it defaulting into all four.
    const { error } = await sb.from("rule_of_life_practices").insert({
      name, emoji, sort_order: sortOrder,
      morning: false, mid_morning: false, noon: false, night: false,
    });
    if (error) throw error;
    emojiInput.value = "";
    input.value = "";
    await loadSpiritualData();
  } catch (err) {
    alert("Failed to add practice: " + (err && err.message ? err.message : String(err)));
  }
});
