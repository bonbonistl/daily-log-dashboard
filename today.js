// "Today" dashboard — a time-aware landing page that pulls the few things that
// matter right now from every other tab: habits due in the current time slot
// (plus anything still open from earlier), today's/upcoming birthdays, unanswered
// prayer requests, active job openings, and today's food/exercise numbers. Fetches its own data rather
// than depending on the other tabs' lazy loads, so it works as the first screen.

// When each habit time slot "starts", in minutes after midnight. The current
// slot is the latest one whose start has passed; earlier slots with unchecked
// items surface as catch-up, later ones as "coming up".
const TODAY_SLOT_STARTS = {
  Morning: 0,
  "Mid Morning": 9 * 60,
  Noon: 11 * 60 + 30,
  "After Work": 16 * 60 + 30,
  Night: 19 * 60 + 30,
};
const BIRTHDAY_LOOKAHEAD_DAYS = 7;
const BIRTHDAY_BELATED_DAYS = 3;
const INACTIVE_JOB_STATUSES = ["declined", "auto_declined", "not_a_match"];
// Pipeline order, furthest along first — an offer matters more than something you're watching.
const JOB_STAGE_RANK = { offered: 0, interviewing: 1, heard_back: 2, applied: 3, watching: 4 };
const JOB_STALE_DAYS = 10;

let todayData = null; // { practices, habitLog, people, openings, businesses, logRows, planRows }
let todayLoadedOnce = false;
let todayShowUpcomingHabits = false;
// Prayer requests are private — collapsed on every page load so nothing shows over your shoulder.
let todayShowPrayers = false;

const escHtml = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

async function loadTodayData() {
  const statusEl = document.getElementById("todayLoading");
  if (!todayLoadedOnce) {
    statusEl.textContent = "Loading data…";
    statusEl.classList.remove("hidden");
  }

  const todayStr = todayLocalStr();
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);

  const fetchPromise = Promise.all([
    sb.from("rule_of_life_practices").select("*").order("sort_order", { ascending: true }),
    sb.from("rule_of_life_log").select("*").eq("log_date", todayStr),
    sb.from("people").select("id, name, birthday, birthday_celebrated_year").not("birthday", "is", null),
    sb.from("job_openings").select("*"),
    sb.from("businesses").select("id, name"),
    // Yesterday too, so "time since last food" works before today's first meal.
    sb.from("daily_log").select("*").gte("log_date", toLocalDateStr(yesterday))
      .order("log_date", { ascending: true }).order("id", { ascending: true }),
    sb.from("food_plan").select("*").eq("log_date", todayStr),
    sb.from("prayer_requests").select("*, people(name)").is("answered_at", null).order("pray_on", { ascending: true }),
  ]);

  let results;
  try {
    results = await withTimeout(fetchPromise, 15000, "Loading today");
  } catch (e) {
    statusEl.textContent = e.message;
    statusEl.classList.remove("hidden");
    return;
  }
  const error = results.find((r) => r.error)?.error;
  if (error) {
    statusEl.textContent = "Error loading data: " + error.message;
    statusEl.classList.remove("hidden");
    return;
  }

  const [practicesRes, habitLogRes, peopleRes, openingsRes, businessesRes, logRes, planRes, prayersRes] = results;
  todayData = {
    practices: practicesRes.data,
    habitLog: habitLogRes.data,
    people: peopleRes.data,
    openings: openingsRes.data,
    businesses: businessesRes.data,
    logRows: logRes.data,
    planRows: planRes.data,
    prayers: prayersRes.data,
  };
  todayLoadedOnce = true;
  statusEl.classList.add("hidden");
  markUpdated("todayUpdatedAt");
  renderTodayDashboard();
}

function renderTodayDashboard() {
  if (!todayData) return;
  const now = new Date();
  const todayStr = todayLocalStr();
  renderTodayGreeting(now);
  renderTodayHabits(now, todayStr);
  renderTodayBirthdays(now);
  renderTodayPrayers(now);
  renderTodayJobs(now);
  renderTodayHealth(todayStr);
  loadTodayWeather();
}

// ---------- weather (Open-Meteo, no API key) ----------
const WEATHER_LAT = 38.627;  // St. Louis, MO
const WEATHER_LON = -90.199;
const WEATHER_TTL_MS = 30 * 60 * 1000;
let todayWeather = null; // { fetchedAt, data }
let todayWeatherInflight = null;

// WMO weather codes → [emoji, label]
function weatherCodeInfo(code, isDay = true) {
  if (code === 0) return [isDay ? "☀️" : "🌙", "Clear"];
  if (code === 1) return [isDay ? "🌤️" : "🌙", "Mostly clear"];
  if (code === 2) return ["⛅", "Partly cloudy"];
  if (code === 3) return ["☁️", "Cloudy"];
  if (code === 45 || code === 48) return ["🌫️", "Fog"];
  if (code >= 51 && code <= 57) return ["🌦️", "Drizzle"];
  if (code >= 61 && code <= 67) return ["🌧️", "Rain"];
  if (code >= 71 && code <= 77) return ["🌨️", "Snow"];
  if (code >= 80 && code <= 82) return ["🌦️", "Showers"];
  if (code === 85 || code === 86) return ["🌨️", "Snow showers"];
  if (code >= 95) return ["⛈️", "Thunderstorms"];
  return ["🌡️", "—"];
}

async function loadTodayWeather() {
  const fresh = todayWeather && Date.now() - todayWeather.fetchedAt < WEATHER_TTL_MS;
  if (fresh || todayWeatherInflight) { renderTodayWeather(); return; }
  const url = "https://api.open-meteo.com/v1/forecast" +
    `?latitude=${WEATHER_LAT}&longitude=${WEATHER_LON}` +
    "&current=temperature_2m,apparent_temperature,weather_code,is_day" +
    "&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max" +
    "&temperature_unit=fahrenheit&timezone=auto&forecast_days=5";
  todayWeatherInflight = fetch(url)
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.status))))
    .then((data) => { todayWeather = { fetchedAt: Date.now(), data }; })
    .catch((err) => console.warn("Weather fetch failed", err))
    .finally(() => { todayWeatherInflight = null; renderTodayWeather(); });
}

function renderTodayWeather() {
  const el = document.getElementById("todayWeather");
  if (!el) return;
  if (!todayWeather) { el.innerHTML = ""; return; }
  const { current: c, daily: d } = todayWeather.data;
  const [icon, label] = weatherCodeInfo(c.weather_code, c.is_day === 1);
  const rain = d.precipitation_probability_max[0];
  const days = d.time.slice(1, 5).map((t, i) => {
    const [dIcon, dLabel] = weatherCodeInfo(d.weather_code[i + 1]);
    const name = new Date(t + "T12:00:00").toLocaleDateString(undefined, { weekday: "short" });
    return `<div class="weather-day" title="${escHtml(dLabel)}">
      <span class="weather-day-name">${name}</span>
      <span class="weather-day-icon">${dIcon}</span>
      <span class="weather-day-temps">${Math.round(d.temperature_2m_max[i + 1])}° <span class="muted">${Math.round(d.temperature_2m_min[i + 1])}°</span></span>
    </div>`;
  }).join("");
  el.innerHTML = `
    <div class="weather-now">
      <span class="weather-icon">${icon}</span>
      <div>
        <div class="weather-temp">${Math.round(c.temperature_2m)}°F <span class="weather-label">${escHtml(label)}</span></div>
        <div class="weather-sub">H ${Math.round(d.temperature_2m_max[0])}° · L ${Math.round(d.temperature_2m_min[0])}° · Feels ${Math.round(c.apparent_temperature)}°${rain != null ? ` · 💧 ${rain}%` : ""}</div>
      </div>
    </div>
    <div class="weather-days">${days}</div>`;
}

// ---------- greeting ----------
function currentHabitSlot(now) {
  const mins = now.getHours() * 60 + now.getMinutes();
  return TIMES_OF_DAY.filter((t) => TODAY_SLOT_STARTS[t] <= mins).pop() || TIMES_OF_DAY[0];
}

function renderTodayGreeting(now) {
  const h = now.getHours();
  const greeting = h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
  document.getElementById("todayGreeting").textContent = greeting;
  document.getElementById("todayDateLine").textContent =
    now.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" }) +
    " · " + now.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

// ---------- habits ----------
function renderTodayHabits(now, todayStr) {
  const { practices, habitLog } = todayData;
  const current = currentHabitSlot(now);
  const currentIdx = TIMES_OF_DAY.indexOf(current);

  const slotItems = (time) =>
    practices
      .filter((p) => p[TIME_KEY[time]] && practiceAppliesOnDate(p, todayStr))
      .map((p) => ({ p, time, row: habitLog.find((r) => r.time_of_day === time && r.practice === p.name) }));

  const itemHtml = (it, extraLabel) => habitItemHtml(it.p, it.time, it.row, extraLabel);

  const nowItems = slotItems(current);
  const earlierOpen = TIMES_OF_DAY.slice(0, currentIdx).flatMap(slotItems).filter((it) => !it.row);
  const laterItems = TIMES_OF_DAY.slice(currentIdx + 1).flatMap(slotItems);

  const allToday = TIMES_OF_DAY.flatMap(slotItems).filter((it) => !(it.row && it.row.skipped));
  const doneToday = allToday.filter((it) => it.row).length;
  document.getElementById("todayHabitsProgress").textContent = allToday.length ? `${doneToday}/${allToday.length} done today` : "";
  document.getElementById("todayHabitsHeading").textContent = `Habits — ${current}`;

  const nowDue = nowItems.filter((it) => !(it.row && it.row.skipped));
  const nowDone = nowDue.filter((it) => it.row).length;
  let html = `
    <div class="today-subhead">Now <span class="hint">${nowDue.length ? `${nowDone}/${nowDue.length}` : ""}</span></div>
    <div class="rol-checklist">
      ${nowItems.length ? nowItems.map((it) => itemHtml(it)).join("") : `<div class="journal-empty">Nothing scheduled for ${current.toLowerCase()}.</div>`}
    </div>
  `;
  if (nowItems.length && nowItems.every((it) => it.row)) {
    html = `<div class="today-allclear">✓ All ${current.toLowerCase()} habits done</div>` + html;
  }

  if (earlierOpen.length) {
    html += `
      <div class="today-subhead today-subhead-warn">Still open from earlier <span class="hint">${earlierOpen.length}</span></div>
      <div class="rol-checklist">${earlierOpen.map((it) => itemHtml(it, it.time)).join("")}</div>
    `;
  }

  if (laterItems.length) {
    const laterOpen = laterItems.filter((it) => !it.row).length;
    html += `
      <button type="button" class="today-toggle" id="todayUpcomingToggle">
        ${todayShowUpcomingHabits ? "▾" : "▸"} Coming up later <span class="hint">${laterOpen} to go</span>
      </button>
      ${todayShowUpcomingHabits ? `<div class="rol-checklist">${laterItems.map((it) => itemHtml(it, it.time)).join("")}</div>` : ""}
    `;
  }

  const el = document.getElementById("todayHabits");
  el.innerHTML = html;

  wireHabitItems(el, todayLocalStr, async () => {
    await loadTodayData();
    // Keep the Habits tab in sync if it's already been opened this session.
    if (typeof spiritualLoaded !== "undefined" && spiritualLoaded) loadSpiritualData();
  });
  const toggle = document.getElementById("todayUpcomingToggle");
  if (toggle) toggle.addEventListener("click", () => {
    todayShowUpcomingHabits = !todayShowUpcomingHabits;
    renderTodayHabits(new Date(), todayLocalStr());
  });
}

// ---------- birthdays ----------
// people.birthday is free text like "8/24" (year usually unknown).
function nextBirthdayInfo(p, now) {
  const m = (p.birthday || "").match(/^(\d{1,2})\/(\d{1,2})/);
  if (!m) return null;
  const month = Number(m[1]) - 1, day = Number(m[2]);
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  // Check last year / this year / next year so both belated and upcoming-across-New-Year work.
  let best = null;
  for (const y of [now.getFullYear() - 1, now.getFullYear(), now.getFullYear() + 1]) {
    const d = new Date(y, month, day);
    const diff = Math.round((d - midnight) / 86400000);
    if (diff >= -BIRTHDAY_BELATED_DAYS && diff <= BIRTHDAY_LOOKAHEAD_DAYS && (best == null || Math.abs(diff) < Math.abs(best.diff))) {
      best = { diff, year: y, date: d };
    }
  }
  return best;
}

const bdayGroup = (e) => (e.info.diff === 0 ? 0 : e.info.diff < 0 ? 1 : 2);

function renderTodayBirthdays(now) {
  const entries = todayData.people
    .map((p) => ({ p, info: nextBirthdayInfo(p, now) }))
    .filter((e) => e.info)
    .map((e) => ({ ...e, celebrated: e.p.birthday_celebrated_year === e.info.year }))
    // Belated ones only matter if you haven't celebrated them yet.
    .filter((e) => e.info.diff >= 0 || !e.celebrated)
    // Today first, then belated (still actionable), then upcoming in date order.
    .sort((a, b) => bdayGroup(a) - bdayGroup(b) || a.info.diff - b.info.diff || a.p.name.localeCompare(b.p.name));

  const todays = entries.filter((e) => e.info.diff === 0);
  document.getElementById("todayBirthdaysCount").textContent = todays.length
    ? `${todays.length} today`
    : "";

  const whenLabel = (diff, date) => {
    if (diff === 0) return "Today 🎉";
    if (diff === 1) return "Tomorrow";
    if (diff === -1) return "Yesterday";
    if (diff < 0) return `${-diff} days ago`;
    return date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  };

  const el = document.getElementById("todayBirthdays");
  if (!entries.length) {
    el.innerHTML = `<div class="journal-empty">No birthdays in the next ${BIRTHDAY_LOOKAHEAD_DAYS} days.</div>`;
    return;
  }
  el.innerHTML = entries.map((e) => `
    <div class="today-row ${e.info.diff === 0 ? "today-row-highlight" : ""} ${e.info.diff < 0 ? "today-row-belated" : ""}">
      <div class="today-row-main">
        <button type="button" class="today-row-title today-person-btn" data-person-id="${e.p.id}">${escHtml(e.p.name)}</button>
        <div class="today-row-sub">${whenLabel(e.info.diff, e.info.date)}</div>
      </div>
      ${e.info.diff <= 0 ? `
        <label class="today-celebrate">
          <input type="checkbox" data-person-id="${e.p.id}" data-year="${e.info.year}" ${e.celebrated ? "checked" : ""} />
          Celebrated
        </label>` : ""}
    </div>
  `).join("");

  el.querySelectorAll(".today-celebrate input").forEach((cb) => {
    cb.addEventListener("change", () => updateTodayCelebrated(cb));
  });
  el.querySelectorAll(".today-person-btn").forEach((btn) => {
    btn.addEventListener("click", () => openTodayPerson(btn.dataset.personId));
  });
}

// The person rail lives in crm.js and reads its full `people` list, so make sure
// that's loaded (Today only fetches name/birthday) before opening it.
async function openTodayPerson(personId) {
  if (!crmLoadedOnce || !people.some((p) => String(p.id) === personId)) await loadCrmData();
  openPersonDrawer(personId);
}

async function updateTodayCelebrated(cb) {
  cb.disabled = true;
  const year = cb.checked ? Number(cb.dataset.year) : null;
  const { error } = await sb.from("people").update({ birthday_celebrated_year: year }).eq("id", cb.dataset.personId);
  if (error) {
    alert("Failed to update: " + error.message);
    cb.checked = !cb.checked;
    cb.disabled = false;
    return;
  }
  const person = todayData.people.find((p) => String(p.id) === cb.dataset.personId);
  if (person) person.birthday_celebrated_year = year;
  cb.disabled = false;
  if (typeof connectionsLoaded !== "undefined" && connectionsLoaded) loadCrmData();
}

// ---------- prayer requests ----------
function renderTodayPrayers(now) {
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const entries = todayData.prayers.map((r) => ({
    r,
    diff: Math.round((new Date(r.pray_on + "T00:00:00") - midnight) / 86400000),
  }));

  document.getElementById("todayPrayerCount").textContent = entries.length ? `${entries.length} open` : "";

  // A past date isn't overdue — the request just hasn't been answered yet — so it gets
  // a plain date, no "ago"/warning framing.
  const whenLabel = (diff, dateStr) => {
    if (diff === 0) return "Today";
    if (diff === 1) return "Tomorrow";
    const d = new Date(dateStr + "T00:00:00");
    return diff > 0
      ? d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })
      : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  };

  const rowHtml = (e) => `
    <div class="today-row ${e.diff === 0 ? "today-row-highlight" : ""}">
      <div class="today-row-main">
        <button type="button" class="today-row-title today-person-btn" data-person-id="${e.r.person_id}">${escHtml(e.r.people?.name || "Someone")}</button>
        <div class="today-prayer-text">${escHtml(e.r.request)}</div>
        <div class="today-row-sub">${whenLabel(e.diff, e.r.pray_on)}</div>
      </div>
      <label class="today-celebrate">
        <input type="checkbox" data-prayer-id="${e.r.id}" />
        Answered
      </label>
    </div>
  `;

  const el = document.getElementById("todayPrayers");
  if (!entries.length) {
    el.innerHTML = `<div class="journal-empty">No unanswered prayer requests. Add one from a person in Connections → CRM.</div>`;
    return;
  }
  // Every unanswered request stays listed until it's marked answered, in date order —
  // but hidden behind a toggle until you choose to show them.
  el.innerHTML = `
    <button type="button" class="today-toggle today-prayer-toggle" id="todayPrayersToggle">
      ${todayShowPrayers ? "▾ Hide" : "▸ Show"} prayer requests
    </button>
    ${todayShowPrayers ? entries.map(rowHtml).join("") : ""}
  `;
  document.getElementById("todayPrayersToggle").addEventListener("click", () => {
    todayShowPrayers = !todayShowPrayers;
    renderTodayPrayers(new Date());
  });

  el.querySelectorAll("input[data-prayer-id]").forEach((cb) => {
    cb.addEventListener("change", async () => {
      cb.disabled = true;
      // setPrayerAnswered (crm.js) reloads Today on success.
      if (await setPrayerAnswered(cb.dataset.prayerId, cb.checked)) { cb.checked = !cb.checked; cb.disabled = false; }
    });
  });
  el.querySelectorAll(".today-person-btn").forEach((btn) => {
    btn.addEventListener("click", () => openTodayPerson(btn.dataset.personId));
  });
}

// ---------- jobs ----------
function renderTodayJobs(now) {
  const { openings, businesses } = todayData;
  const nameFor = (id) => businesses.find((b) => b.id === id)?.name || "Unknown company";
  const daysSince = (ts) => (ts ? Math.floor((now - new Date(ts)) / 86400000) : null);

  const active = openings
    .filter((o) => !INACTIVE_JOB_STATUSES.includes(o.status))
    .map((o) => ({ o, age: daysSince(o.status_changed_at || o.created_at) }))
    .sort((a, b) => (JOB_STAGE_RANK[a.o.status] ?? 9) - (JOB_STAGE_RANK[b.o.status] ?? 9) || (b.age ?? 0) - (a.age ?? 0));

  document.getElementById("todayJobsCount").textContent = active.length ? `${active.length} active` : "";

  const el = document.getElementById("todayJobs");
  if (!active.length) {
    el.innerHTML = `<div class="journal-empty">No active openings. Add some under Connections → Businesses.</div>`;
    return;
  }

  // A short, specific nudge per opening — what (if anything) to do about it today.
  const nudgeFor = ({ o, age }) => {
    if (o.status === "offered") return "Offer pending — decide";
    if (o.status === "interviewing") return "Prep / follow up";
    if (o.status === "watching" && !o.reached_out) return "Reach out to a contact?";
    if (o.status === "watching") return "Ready to apply?";
    if ((o.status === "applied" || o.status === "heard_back") && age != null && age >= JOB_STALE_DAYS) return `No movement in ${age}d — follow up?`;
    return null;
  };

  el.innerHTML = active.map((it) => {
    const nudge = nudgeFor(it);
    return `
      <div class="today-row">
        <div class="today-row-main">
          <div class="today-row-title">
            ${escHtml(it.o.title || "Untitled opening")}
            ${it.o.url ? `<a class="job-opening-url-link" href="${escHtml(it.o.url)}" target="_blank" rel="noopener noreferrer" title="Open posting">↗</a>` : ""}
          </div>
          <div class="today-row-sub">
            ${escHtml(nameFor(it.o.business_id))}${it.age != null ? ` · ${it.age}d in stage` : ""}${it.o.reached_out ? " · reached out" : ""}
          </div>
          ${nudge ? `<div class="today-nudge">${escHtml(nudge)}</div>` : ""}
        </div>
        <span class="job-status-badge status-${it.o.status}">${escHtml(JOB_STATUS_LABELS[it.o.status] || it.o.status)}</span>
      </div>
    `;
  }).join("") + `<button type="button" class="today-link-btn" id="todayJobsOpenBtn">Open pipeline →</button>`;

  document.getElementById("todayJobsOpenBtn").addEventListener("click", () => {
    activateTab("connections");
    activateConnectionsSubtab("businesses");
  });
}

// ---------- food & exercise ----------
function renderTodayHealth(todayStr) {
  const { logRows, planRows } = todayData;
  const today = logRows.filter((r) => r.log_date === todayStr);

  let cal = 0, prot = 0, hasCal = false, missing = 0, foodCount = 0;
  let exCal = 0, exMin = 0, exCount = 0, waterOz = 0;
  today.forEach((r) => {
    const v = categoryValue(r, r.details || "");
    if (r.category === "Food & Drink") {
      foodCount++;
      if (r.calories == null && r.est_calories == null) missing++;
      if (v.cal != null) { cal += v.cal; hasCal = true; }
      if (v.prot != null) prot += v.prot;
    } else if (r.category === "Exercise") {
      exCount++;
      if (v.cal != null) exCal += v.cal;
      if (v.min != null) exMin += v.min;
    } else if (r.category === "Water") {
      if (v.oz != null) waterOz += v.oz;
    }
  });

  // Same food-vs-drink split as the Health tab's "Last food" card.
  const lastFood = [...logRows].reverse().find((r) => r.category === "Food & Drink" && !isDrinkOnly(r.details));
  const lastFoodDate = lastFood ? parseLogTimeToDate(lastFood.log_date, lastFood.log_time) : null;

  const pending = planRows.filter((p) => !p.logged_daily_log_id);
  const pendingCal = pending.reduce((s, p) => s + (numOrNull(p.est_calories) || 0), 0);
  const pendingProt = pending.reduce((s, p) => s + (numOrNull(p.est_protein_g) || 0), 0);

  const cards = [
    { label: "Calories in", value: hasCal ? Math.round(cal) : "—", sub: missing ? `${missing} not yet estimated` : `${foodCount} food log${foodCount === 1 ? "" : "s"}`, cls: missing ? "warn" : "" },
    { label: "Net calories", value: hasCal ? Math.round(cal - exCal) : "—", sub: `${Math.round(exCal)} burned` },
    { label: "Protein", value: prot ? Math.round(prot) + " g" : "—", sub: pending.length ? `+${Math.round(pendingProt)} g planned` : "AI estimate" },
    { label: "Exercise", value: exMin ? Math.round(exMin) + " min" : "—", sub: exCount ? `${exCount} session${exCount === 1 ? "" : "s"}` : "not logged yet", cls: exCount ? "" : "warn" },
    { label: "Water", value: waterOz ? waterOz + " oz" : "—", sub: waterOz ? "logged today" : "not logged yet" },
    {
      label: "Last food",
      value: lastFoodDate ? formatElapsedSince(lastFoodDate).replace(" since last food", "") : "—",
      sub: lastFood ? escHtml((lastFood.details || "").slice(0, 40)) : "nothing recent",
    },
  ];

  document.getElementById("todayHealthCards").innerHTML = cards.map((c) => `
    <div class="card ${c.cls || ""}">
      <div class="label">${c.label}</div>
      <div class="value">${c.value}</div>
      <div class="sub">${c.sub}</div>
    </div>
  `).join("");

  const planEl = document.getElementById("todayPlanList");
  const order = (p) => PLAN_TIME_SLOTS.indexOf(p.time_of_day);
  const plan = [...planRows].sort((a, b) => order(a) - order(b) || a.id - b.id);
  planEl.innerHTML = plan.length ? `
    <div class="today-subhead">Food plan <span class="hint">${pending.length ? `~${Math.round(pendingCal)} cal · ${Math.round(pendingProt)} g protein left` : "all eaten"}</span></div>
    <div class="rol-checklist">
      ${plan.map((p) => `
        <label class="rol-item ${p.logged_daily_log_id ? "done" : ""}" data-id="${p.id}">
          <input type="checkbox" ${p.logged_daily_log_id ? "checked" : ""} />
          <span>${escHtml(p.item)}
            <span class="plan-item-macro">${Math.round(numOrNull(p.est_calories) || 0)} cal · ${Math.round(numOrNull(p.est_protein_g) || 0)} g protein</span>
          </span>
          <span class="today-item-tag">${escHtml(p.time_of_day)}</span>
        </label>
      `).join("")}
    </div>
  ` : "";

  planEl.querySelectorAll(".rol-item").forEach((label) => {
    label.addEventListener("click", (e) => {
      e.preventDefault();
      if (label.dataset.busy) return;
      toggleTodayPlanItem(label);
    });
  });
}

async function toggleTodayPlanItem(label) {
  label.dataset.busy = "1";
  const item = todayData.planRows.find((p) => String(p.id) === label.dataset.id);
  const error = await setPlanItemLogged(item, item.log_date);
  if (error) { alert("Failed to update: " + error.message); delete label.dataset.busy; return; }
  await loadTodayData();
  // Keep the Health tab (overview totals + Plan subtab) in sync if it's already loaded.
  if (typeof healthLoadedOnce !== "undefined" && healthLoadedOnce) loadData();
}

document.getElementById("todayHealthOpenBtn").addEventListener("click", () => {
  activateTab("health");
  activateHealthSubtab("plan");
});
