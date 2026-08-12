const TIMES_OF_DAY = ["Morning", "Noon", "Night"];
const TIME_KEY = { Morning: "morning", Noon: "noon", Night: "night" };
const ROL_RANGE_DAYS = 14;

let rolRows = [];
let rolPractices = []; // [{id, name, morning, noon, night, sort_order}], ordered by sort_order
let spiritualLoadedOnce = false;

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
  ]);

  let logRes, practicesRes;
  try {
    [logRes, practicesRes] = await withTimeout(fetchPromise, 15000, "Loading spiritual data");
  } catch (e) {
    document.getElementById("rolLoading").textContent = e.message;
    document.getElementById("rolLoading").classList.remove("hidden");
    return;
  }

  document.getElementById("rolLoading").classList.add("hidden");
  const error = logRes.error || practicesRes.error;
  if (error) {
    document.getElementById("rolLoading").textContent = "Error loading data: " + error.message;
    document.getElementById("rolLoading").classList.remove("hidden");
    return;
  }
  markUpdated("spiritualUpdatedAt");
  spiritualLoadedOnce = true;
  rolRows = logRes.data;
  rolPractices = practicesRes.data;
  renderSpiritual();
}

function renderSpiritual() {
  const todayStr = todayLocalStr();
  renderCheckin(todayStr);
  renderRolCards(todayStr);
  renderRolGrid(todayStr);
  renderRolBreakdown(todayStr);
  renderPracticesList();
  document.querySelectorAll("#spiritualApp .cards, #spiritualApp .panel").forEach((el) => el.classList.remove("hidden"));
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

function renderCheckin(todayStr) {
  document.getElementById("checkinHeading").textContent =
    `Today's Check-In — ${new Date(todayStr + "T00:00:00").toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" })}`;

  const html = TIMES_OF_DAY.map((time) => {
    const applicable = rolPractices.filter((p) => p[TIME_KEY[time]]);
    const items = applicable.map((p) => {
      const row = findRolRow(todayStr, time, p.name);
      const checked = !!row;
      return `
        <label class="rol-item ${checked ? "done" : ""}" data-time="${time}" data-practice="${p.name}" data-id="${row ? row.id : ""}">
          <input type="checkbox" ${checked ? "checked" : ""} />
          <span>${p.name}</span>
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
}

async function toggleCheckin(label) {
  const time = label.dataset.time;
  const practice = label.dataset.practice;
  const id = label.dataset.id;
  const todayStr = todayLocalStr();

  label.dataset.busy = "1";
  if (id) {
    const { error } = await sb.from("rule_of_life_log").delete().eq("id", id);
    if (error) { alert("Failed to update: " + error.message); delete label.dataset.busy; return; }
  } else {
    const { error } = await sb.from("rule_of_life_log").insert({ log_date: todayStr, time_of_day: time, practice });
    if (error) { alert("Failed to update: " + error.message); delete label.dataset.busy; return; }
  }
  await loadSpiritualData();
}

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
    html += `<div class="row-label">${p.name}</div>`;
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
    return { practice: p.name, pct, doneDays, total: days.length };
  });

  document.getElementById("rolBreakdown").innerHTML = rows.map((r) => `
    <div class="rol-breakdown-row">
      <div class="rol-breakdown-label">${r.practice}</div>
      <div class="rol-breakdown-bar-track"><div class="rol-breakdown-bar" style="width:${r.pct}%"></div></div>
      <div class="rol-breakdown-pct">${r.pct}% <span class="rol-breakdown-days">(${r.doneDays}/${r.total})</span></div>
    </div>
  `).join("");
}

// ---------- manage practices drawer ----------
function renderPracticesList() {
  document.getElementById("practicesList").innerHTML = rolPractices.map((p) => `
    <div class="practice-row">
      <div class="name">${p.name}</div>
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
  const input = document.getElementById("newPracticeName");
  const name = input.value.trim();
  if (!name) return;
  const sortOrder = rolPractices.length ? Math.max(...rolPractices.map((p) => p.sort_order)) + 1 : 1;
  const { error } = await sb.from("rule_of_life_practices").insert({ name, sort_order: sortOrder });
  if (error) { alert("Failed to add practice: " + error.message); return; }
  input.value = "";
  await loadSpiritualData();
});
