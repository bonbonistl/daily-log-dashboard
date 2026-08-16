const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);

// A hung network request would otherwise leave the UI stuck on "Loading data…"
// forever with no feedback. Race it against a timeout so failures are visible.
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s — check your connection and try again`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// ---------- text parsing helpers ----------
// The DB's numeric columns (calories, protein_g, etc.) are unpopulated —
// values live inside free-text `details` from the Notion migration.
// These are best-effort regex extractions, not authoritative numbers.

function parseFirst(text, re) {
  const m = text.match(re);
  return m ? parseFloat(m[1]) : null;
}
// Supabase returns Postgres numeric columns as strings to avoid precision loss.
const numOrNull = (v) => (v == null ? null : Number(v));
const parseCalories = (t) => parseFirst(t, /~?\s*(\d+(?:\.\d+)?)\s*cal/i);
const parseProteinG = (t) =>
  parseFirst(t, /(\d+(?:\.\d+)?)\s*g(?:rams?)?\s*(?:of\s*)?protein/i) ??
  parseFirst(t, /protein[^\d]{0,15}(\d+(?:\.\d+)?)\s*g/i);
const parseMinutes = (t) => parseFirst(t, /~?\s*(\d+(?:\.\d+)?)\s*min/i);
const parseOz = (t) => parseFirst(t, /(\d+(?:\.\d+)?)\s*oz/i);
const parseAvgHR = (t) => parseFirst(t, /avg(?:erage)?\s*hr\D{0,10}(\d+(?:\.\d+)?)/i);
const parseMaxHR = (t) => parseFirst(t, /max\s*hr\D{0,10}(\d+(?:\.\d+)?)/i);
const parseWeightLbs = (t) => parseFirst(t, /(\d+(?:\.\d+)?)\s*lbs?/i);

// "Food & Drink" is one category in the DB, but entries like "12 oz coffee" or
// "16 oz IPA" are pure beverages, not a meal. If any solid-food word appears, treat
// the whole entry as food (covers combo entries like "carrot cake, 16 oz IPA").
// Otherwise, if it matches a pure-beverage pattern, it's a drink.
const FOOD_WORDS = /taco|egg|bagel|salad|chicken|pasta|pizza|sandwich|burger|\brice\b|bread|cookie|cake|chip|fries|dumpling|nacho|wrap|yogurt|salmon|steak|pork|beef|noodle|toast|burrito|\bbar\b|banana|dessert|ice cream|brownie|pretzel|hummus|guac|queso|meatball|sausage|bratwurst|orzo|broccoli|tortilla|cheese|smoothie|shake|beignet|dog\b|fingers|wings|fillet|thigh|breast|drumstick|pita|cracker|bacon|ramen|lasagna|salami/i;
const DRINK_WORDS = /\bcoffee\b|\bespresso\b|\blatte\b|\bcappuccino\b|\btea\b|\bbeer\b|\bipa\b|\bapa\b|\blager\b|\bpilsner\b|\bale\b|\bwine\b|\bmezcal\b|\bspritz\b|\bhighball\b|red bull|\bcelsius\b|\bsoda\b|lemonade|powerade|sparkling|\bkombucha\b|\bcocktail\b|city wide|margarita|shandy/i;
function isDrinkOnly(text) {
  const t = text || "";
  if (FOOD_WORDS.test(t)) return false;
  return DRINK_WORDS.test(t);
}

// ---------- date helpers ----------
// Always derive YYYY-MM-DD from local date fields, never toISOString() (which is UTC
// and rolls over to "tomorrow" several hours early for US timezones in the evening).
function toLocalDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function todayLocalStr() {
  return toLocalDateStr(new Date());
}
// Calendar week starting Monday, not a rolling 7-day window.
function mondayOfThisWeek() {
  const d = new Date();
  const day = d.getDay(); // 0 = Sunday, 1 = Monday, ...
  const diff = day === 0 ? 6 : day - 1;
  d.setDate(d.getDate() - diff);
  return d;
}
function sundayOfThisWeek() {
  const monday = mondayOfThisWeek();
  monday.setDate(monday.getDate() + 6);
  return monday;
}
function fmtShort(dateStr) {
  const d = new Date(dateStr + "T00:00:00");
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// log_time is free text and shows up in a few different formats depending on how it
// was logged: "7:00 PM", "9:00-9:37 AM" (grab the end of the range), bare 24-hour
// "14:10" from some manual entries, or "14:10:00" with seconds from newer integrations.
// Try 12-hour AM/PM first, then fall back to 24-hour (with or without a seconds part).
function parseLogTimeToDate(dateStr, timeStr) {
  if (!timeStr) return null;
  const d = new Date(dateStr + "T00:00:00");

  const ampmMatches = [...timeStr.matchAll(/(\d{1,2}):(\d{2})\s*([AaPp][Mm])/g)];
  if (ampmMatches.length) {
    const m = ampmMatches[ampmMatches.length - 1];
    let hour = parseInt(m[1], 10);
    const minute = parseInt(m[2], 10);
    const meridiem = m[3].toUpperCase();
    if (meridiem === "PM" && hour !== 12) hour += 12;
    if (meridiem === "AM" && hour === 12) hour = 0;
    d.setHours(hour, minute, 0, 0);
    return d;
  }

  const h24Match = timeStr.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (h24Match) {
    d.setHours(parseInt(h24Match[1], 10), parseInt(h24Match[2], 10), parseInt(h24Match[3] || "0", 10), 0);
    return d;
  }

  return null;
}

// Consistent 12-hour display for any log_time format we can parse; falls back to the
// raw string (e.g. free-text ranges like "9:00-9:37 AM") if it doesn't parse cleanly.
function formatTimeDisplay(dateStr, timeStr) {
  const d = parseLogTimeToDate(dateStr, timeStr);
  if (!d) return timeStr || "";
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function formatElapsedSince(fromDate) {
  const diffMs = Date.now() - fromDate.getTime();
  if (diffMs < 0) return "just now";
  const totalMin = Math.floor(diffMs / 60000);
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  if (d > 0) return `${d}d ${h}h since last food`;
  if (h === 0) return `${m}m since last food`;
  return `${h}h ${m}m since last food`;
}
function markUpdated(elId) {
  const el = document.getElementById(elId);
  if (el) el.textContent = "Updated " + new Date().toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", second: "2-digit" });
}

function dateRangeArray(start, end) {
  const days = [];
  let cur = new Date(start + "T00:00:00");
  const last = new Date(end + "T00:00:00");
  while (cur <= last) {
    days.push(toLocalDateStr(cur));
    cur.setDate(cur.getDate() + 1);
  }
  return days;
}

const charts = {}; // keep instances so we can destroy on refresh
let elapsedInterval = null; // ticks the "time since last food" counter
function renderChart(id, config) {
  if (charts[id]) charts[id].destroy();
  charts[id] = new Chart(document.getElementById(id), config);
}

const CHART_COLORS = {
  cal: "#f6ad55",
  protein: "#63b3ed",
  water: "#4fd1c5",
  duration: "#4fd1c5",
  avgHr: "#63b3ed",
  maxHr: "#fc8181",
  weight: "#f6ad55",
};

let healthLoadedOnce = false;
async function loadData() {
  // Only blank the page on the first load. Background refreshes (auto-refresh,
  // tab refocus) should update data in place, not flash the whole page empty.
  if (!healthLoadedOnce) {
    document.getElementById("loading").classList.remove("hidden");
    document.getElementById("loading").textContent = "Loading data…";
    document.querySelectorAll(".cards, .panel").forEach((el) => el.classList.add("hidden"));
  }

  const rangeVal = document.getElementById("rangeSelect").value;
  let query = sb.from("daily_log").select("*").order("log_date", { ascending: true }).order("id", { ascending: true });

  if (rangeVal === "thisweek") {
    query = query.gte("log_date", toLocalDateStr(mondayOfThisWeek()));
  } else if (rangeVal !== "all") {
    const days = parseInt(rangeVal, 10);
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days + 1);
    query = query.gte("log_date", toLocalDateStr(cutoff));
  }

  let data, error;
  try {
    ({ data, error } = await withTimeout(query, 15000, "Loading health data"));
  } catch (e) {
    document.getElementById("loading").textContent = e.message;
    document.getElementById("loading").classList.remove("hidden");
    return;
  }
  document.getElementById("loading").classList.add("hidden");

  if (error) {
    document.getElementById("loading").textContent = "Error loading data: " + error.message;
    document.getElementById("loading").classList.remove("hidden");
    return;
  }
  markUpdated("healthUpdatedAt");
  healthLoadedOnce = true;

  render(data);
}

let lastRows = []; // kept around so the journal drawer can list today's raw entries
let lastTodayStr = null;

function render(rows) {
  if (rows.length === 0) {
    document.getElementById("loading").textContent = "No log entries in this range.";
    document.getElementById("loading").classList.remove("hidden");
    return;
  }

  const todayStr = todayLocalStr();
  lastRows = rows;
  lastTodayStr = todayStr;

  // "This Week" always shows the full Monday–Sunday template, including days later
  // in the week that haven't happened yet — everything else caps at today.
  const rangeVal = document.getElementById("rangeSelect").value;
  let minDate, maxDate;
  if (rangeVal === "thisweek") {
    minDate = toLocalDateStr(mondayOfThisWeek());
    maxDate = toLocalDateStr(sundayOfThisWeek());
  } else {
    minDate = rows[0].log_date;
    maxDate = rows[rows.length - 1].log_date > todayStr ? rows[rows.length - 1].log_date : todayStr;
  }
  const allDays = dateRangeArray(minDate, maxDate);

  // per-day accumulators
  const perDay = {};
  allDays.forEach((d) => {
    perDay[d] = {
      foodCount: 0, foodCal: 0, foodCalDays: false, foodProtein: 0, foodProteinDays: false,
      waterCount: 0, waterOz: 0,
      exCount: 0, exCal: 0, exMin: 0, exAvgHrSum: 0, exAvgHrN: 0, exMaxHr: null,
      weight: null,
      anyEntry: false,
      lastEntryCategory: null, lastEntryDetails: null, lastEntryTime: null,
      lastFoodTime: null, lastFoodDetails: null,
      foodMissingEstimate: 0,
    };
  });

  let foodEntriesWithCal = 0, foodEntriesWithProtein = 0, foodEntriesTotal = 0;
  const weightPoints = [];
  // Most recent actual food (not drink) entry across the whole fetched range, so "time
  // since last food" can look back past today if nothing's been eaten yet today.
  let lastFoodOverall = null;

  rows.forEach((r) => {
    const day = perDay[r.log_date];
    if (!day) return; // shouldn't happen
    day.anyEntry = true;
    day.lastEntryCategory = r.category;
    day.lastEntryDetails = r.details;
    day.lastEntryTime = r.log_time;
    const text = r.details || "";

    if (r.category === "Food & Drink") {
      day.foodCount++;
      foodEntriesTotal++;
      if (!isDrinkOnly(text)) {
        day.lastFoodTime = r.log_time;
        day.lastFoodDetails = r.details;
        lastFoodOverall = { date: r.log_date, time: r.log_time, details: r.details };
      }
      if (r.calories == null && r.est_calories == null) day.foodMissingEstimate++;
      // Prefer a real logged value (calories/protein_g) over the AI approximation
      // (est_calories/est_protein_g), and fall back to regex-parsed note text last.
      const cal = numOrNull(r.calories) ?? numOrNull(r.est_calories) ?? parseCalories(text);
      const prot = numOrNull(r.protein_g) ?? numOrNull(r.est_protein_g) ?? parseProteinG(text);
      if (cal != null) { day.foodCal += cal; day.foodCalDays = true; foodEntriesWithCal++; }
      if (prot != null) { day.foodProtein += prot; day.foodProteinDays = true; foodEntriesWithProtein++; }
    } else if (r.category === "Water") {
      day.waterCount++;
      const oz = parseOz(text);
      if (oz != null) day.waterOz += oz;
    } else if (r.category === "Exercise") {
      day.exCount++;
      // Prefer real logged columns (duration_min/calories/avg_hr/max_hr) over
      // regex-parsed note text — manual entries populate these directly.
      const cal = numOrNull(r.calories) ?? parseCalories(text);
      const min = numOrNull(r.duration_min) ?? parseMinutes(text);
      const avgHr = numOrNull(r.avg_hr) ?? parseAvgHR(text);
      const maxHr = numOrNull(r.max_hr) ?? parseMaxHR(text);
      if (cal != null) day.exCal += cal;
      if (min != null) day.exMin += min;
      if (avgHr != null) { day.exAvgHrSum += avgHr; day.exAvgHrN++; }
      if (maxHr != null) day.exMaxHr = Math.max(day.exMaxHr ?? 0, maxHr);
    } else if (r.category === "Weight") {
      const w = parseWeightLbs(text);
      if (w != null) {
        day.weight = w;
        weightPoints.push({ date: r.log_date, weight: w });
      }
    }
  });

  renderToday(perDay, todayStr, lastFoodOverall);
  renderSummaryCards(perDay, allDays, weightPoints, { foodEntriesWithCal, foodEntriesWithProtein, foodEntriesTotal });
  renderConsistency(perDay, allDays, todayStr);
  renderGaps(perDay, allDays, todayStr);
  renderNutritionChart(perDay, allDays);
  renderWaterChart(perDay, allDays);
  renderExerciseChart(perDay, allDays);
  renderWeightChart(weightPoints);

  document.querySelectorAll(".cards, .panel").forEach((el) => el.classList.remove("hidden"));

  // Runs last: the broad unhide above would otherwise clobber any panels this
  // deliberately hides (e.g. no strength sessions in range → hide muscle group panel).
  if (typeof renderExerciseDeepDive === "function") renderExerciseDeepDive();
  if (typeof renderFastingDeepDive === "function") renderFastingDeepDive();
  if (typeof renderFoodPlanDeepDive === "function") renderFoodPlanDeepDive();
}

function renderToday(perDay, todayStr, lastFoodOverall) {
  const t = perDay[todayStr];
  document.getElementById("todayHeading").textContent =
    `Today — ${new Date(todayStr + "T00:00:00").toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" })}`;

  if (!t) {
    document.getElementById("todayCards").innerHTML = `<div class="card"><div class="label">No data</div><div class="value">—</div></div>`;
    document.getElementById("todayLastEntry").textContent = "";
    return;
  }

  const calSub = t.foodMissingEstimate
    ? `${t.foodCount} food logs — ${t.foodMissingEstimate} not yet estimated!`
    : (t.foodCount ? `${t.foodCount} food log${t.foodCount === 1 ? "" : "s"}` : "nothing logged yet");

  const truncate = (s) => (s || "").length > 100 ? (s || "").slice(0, 100) + "…" : (s || "");

  const netCal = t.foodCalDays ? t.foodCal - t.exCal : null;

  const cards = [
    { label: "Calories in (gross)", value: t.foodCalDays ? Math.round(t.foodCal) : "—", sub: calSub, cls: t.foodMissingEstimate ? "warn" : "" },
    { label: "Net calories", value: netCal != null ? Math.round(netCal) : "—", sub: netCal != null ? `${Math.round(t.foodCal)} in − ${Math.round(t.exCal)} burned` : "no food logged yet" },
    { label: "Protein so far", value: t.foodProteinDays ? Math.round(t.foodProtein) + " g" : "—", sub: "AI estimate", cls: t.foodMissingEstimate ? "warn" : "" },
    { label: "Water", value: t.waterOz ? t.waterOz + " oz" : "—", sub: t.waterCount ? `${t.waterCount} log${t.waterCount === 1 ? "" : "s"}` : "not logged yet" },
    { label: "Exercise", value: t.exMin ? Math.round(t.exMin) + " min" : "—", sub: t.exCount ? `${t.exCount} session${t.exCount === 1 ? "" : "s"}` : "not logged yet" },
  ];

  // Look back across days (not just today) for the most recent actual food entry,
  // so the counter still works first thing in the morning before today's first meal.
  const lastFoodDate = lastFoodOverall ? parseLogTimeToDate(lastFoodOverall.date, lastFoodOverall.time) : null;
  const lastFoodIsToday = lastFoodOverall && lastFoodOverall.date === todayStr;
  const lastFoodTimeDisplay = lastFoodOverall ? formatTimeDisplay(lastFoodOverall.date, lastFoodOverall.time) : "";
  const lastFoodValue = lastFoodOverall
    ? (lastFoodIsToday ? lastFoodTimeDisplay : `${fmtShort(lastFoodOverall.date)}, ${lastFoodTimeDisplay}`)
    : "—";

  const lastFoodCardHtml = `
    <div class="card wide">
      <div class="label">Last food (not drink)</div>
      <div class="value">${lastFoodValue}</div>
      <div class="sub">${lastFoodOverall ? truncate(lastFoodOverall.details) : "no food logged recently"}</div>
      ${lastFoodDate ? `<div class="elapsed" id="lastFoodElapsed"></div>` : ""}
    </div>
  `;

  document.getElementById("todayCards").innerHTML = cards.map((c) => `
    <div class="card ${c.cls || ""}">
      <div class="label">${c.label}</div>
      <div class="value">${c.value}</div>
      <div class="sub">${c.sub}</div>
    </div>
  `).join("") + lastFoodCardHtml;

  if (elapsedInterval) clearInterval(elapsedInterval);
  if (lastFoodDate) {
    const el = document.getElementById("lastFoodElapsed");
    const tick = () => { el.textContent = formatElapsedSince(lastFoodDate); };
    tick();
    elapsedInterval = setInterval(tick, 30000);
  }

  document.getElementById("todayLastEntry").innerHTML = t.anyEntry
    ? `Last logged: <strong>${t.lastEntryCategory}</strong> at ${t.lastEntryTime ? formatTimeDisplay(todayStr, t.lastEntryTime) : "unknown time"} — ${truncate(t.lastEntryDetails)}`
    : `Nothing logged yet today.`;
}

function renderConsistency(perDay, allDays, todayStr) {
  // Don't count today or any not-yet-happened days (e.g. "This Week" pads out to
  // Sunday) toward streaks/rates — those days haven't been lived yet.
  const completeDays = allDays.filter((d) => d < todayStr);
  if (completeDays.length === 0) {
    document.getElementById("consistencyCards").innerHTML = `<div class="card"><div class="label">No data yet</div><div class="value">—</div></div>`;
    return;
  }

  // Current streak: consecutive logged days counting back from the most recent complete day.
  let currentStreak = 0;
  for (let i = completeDays.length - 1; i >= 0; i--) {
    if (perDay[completeDays[i]].anyEntry) currentStreak++;
    else break;
  }

  // Longest streak anywhere in range.
  let longestStreak = 0, run = 0;
  completeDays.forEach((d) => {
    if (perDay[d].anyEntry) { run++; longestStreak = Math.max(longestStreak, run); }
    else run = 0;
  });

  const loggedDays = completeDays.filter((d) => perDay[d].anyEntry).length;
  const mealEndDays = completeDays.filter((d) => perDay[d].anyEntry && perDay[d].lastEntryCategory === "Food & Drink").length;
  const foodDays = completeDays.filter((d) => perDay[d].foodCount > 0).length;
  const waterDays = completeDays.filter((d) => perDay[d].waterCount > 0).length;

  const pct = (n) => Math.round((n / completeDays.length) * 100);

  const cards = [
    { label: "Current streak", value: `${currentStreak} day${currentStreak === 1 ? "" : "s"}`, sub: "logged something every day", cls: "streak" },
    { label: "Longest streak", value: `${longestStreak} day${longestStreak === 1 ? "" : "s"}`, sub: `out of ${completeDays.length} days`, cls: "streak" },
    { label: "Days logged", value: `${pct(loggedDays)}%`, sub: `${loggedDays}/${completeDays.length} days`, cls: loggedDays === completeDays.length ? "" : "warn" },
    { label: "Ended with a meal", value: `${pct(mealEndDays)}%`, sub: "last log of the day was food", cls: mealEndDays === completeDays.length ? "" : "warn" },
    { label: "Food logged", value: `${pct(foodDays)}%`, sub: `${foodDays}/${completeDays.length} days` },
    { label: "Water logged", value: `${pct(waterDays)}%`, sub: `${waterDays}/${completeDays.length} days` },
  ];

  document.getElementById("consistencyCards").innerHTML = cards.map((c) => `
    <div class="card ${c.cls || ""}">
      <div class="label">${c.label}</div>
      <div class="value">${c.value}</div>
      <div class="sub">${c.sub}</div>
    </div>
  `).join("");
}

function renderSummaryCards(perDay, allDays, weightPoints, foodStats) {
  // "This Week" pads allDays out to Sunday even mid-week — averages should divide by
  // days that have actually happened, not the full padded template.
  const todayStr = todayLocalStr();
  const elapsedDays = allDays.filter((d) => d <= todayStr);

  const totalWaterOz = allDays.reduce((s, d) => s + perDay[d].waterOz, 0);
  const daysWithWater = allDays.filter((d) => perDay[d].waterOz > 0).length;
  const totalExMin = allDays.reduce((s, d) => s + perDay[d].exMin, 0);
  const exSessions = allDays.reduce((s, d) => s + perDay[d].exCount, 0);
  const latestWeight = weightPoints.length ? weightPoints[weightPoints.length - 1] : null;
  const firstWeight = weightPoints.length ? weightPoints[0] : null;
  const weightChange = latestWeight && firstWeight && latestWeight !== firstWeight
    ? (latestWeight.weight - firstWeight.weight) : null;

  const daysWithFood = allDays.filter((d) => perDay[d].foodCalDays).length;
  const totalCal = allDays.reduce((s, d) => s + perDay[d].foodCal, 0);
  const totalProtein = allDays.reduce((s, d) => s + perDay[d].foodProtein, 0);
  const missingEstimates = allDays.reduce((s, d) => s + perDay[d].foodMissingEstimate, 0);
  const estimateSub = missingEstimates
    ? `${missingEstimates} entries not yet estimated — total is low`
    : "AI estimate from your notes";

  const cards = [
    {
      label: "Days in range", value: allDays.length,
      sub: `${minMaxLabel(allDays)}`,
    },
    {
      label: "Avg calories / day", value: daysWithFood ? Math.round(totalCal / daysWithFood) : "—",
      sub: estimateSub, cls: missingEstimates ? "warn" : "",
    },
    {
      label: "Avg protein / day", value: daysWithFood ? Math.round(totalProtein / daysWithFood) + " g" : "—",
      sub: estimateSub, cls: missingEstimates ? "warn" : "",
    },
    {
      label: "Avg water / day", value: daysWithWater ? Math.round(totalWaterOz / elapsedDays.length) + " oz" : "—",
      sub: `logged on ${daysWithWater}/${elapsedDays.length} days`,
    },
    {
      label: "Exercise", value: Math.round(totalExMin) + " min",
      sub: `${exSessions} session${exSessions === 1 ? "" : "s"} total`,
    },
    {
      label: "Latest weight", value: latestWeight ? latestWeight.weight + " lbs" : "—",
      sub: weightChange != null ? `${weightChange > 0 ? "+" : ""}${weightChange.toFixed(1)} lbs since ${fmtShort(firstWeight.date)}` : (latestWeight ? fmtShort(latestWeight.date) : "no data"),
    },
  ];

  document.getElementById("summaryCards").innerHTML = cards.map((c) => `
    <div class="card ${c.cls || ""}">
      <div class="label">${c.label}</div>
      <div class="value">${c.value}</div>
      <div class="sub">${c.sub}</div>
    </div>
  `).join("");
}

function minMaxLabel(allDays) {
  return `${fmtShort(allDays[0])} – ${fmtShort(allDays[allDays.length - 1])}`;
}

function renderGaps(perDay, allDays, todayStr) {
  const grid = document.getElementById("gapsGrid");
  grid.style.setProperty("--days", allDays.length);

  const categories = [
    { key: "foodCount", label: "Food" },
    { key: "waterCount", label: "Water" },
    { key: "exCount", label: "Exercise" },
  ];

  let html = `<div class="row-label"></div>`;
  allDays.forEach((d) => {
    html += `<div class="date-label">${fmtShort(d)}</div>`;
  });

  categories.forEach((cat) => {
    html += `<div class="row-label">${cat.label}</div>`;
    allDays.forEach((d) => {
      const logged = perDay[d][cat.key] > 0;
      html += `<div class="cell ${logged ? "logged" : "missing"}" title="${cat.label} on ${d}: ${perDay[d][cat.key]} entr${perDay[d][cat.key] === 1 ? "y" : "ies"}"></div>`;
    });
  });

  grid.innerHTML = html;

  // gap callouts — exclude today and any not-yet-happened days ("This Week" pads
  // out to Sunday) from "no log at all", since those days haven't been lived yet.
  const blankDays = allDays.filter((d) => d < todayStr && !perDay[d].anyEntry);
  const noFoodDays = allDays.filter((d) => perDay[d].anyEntry && perDay[d].foodCount === 0);
  const noWaterDays = allDays.filter((d) => perDay[d].anyEntry && perDay[d].waterCount === 0);
  // Days where the last thing logged wasn't a meal — likely means tracking stopped
  // before dinner (or whatever was eaten after just never got logged). Skip today,
  // since it isn't over yet.
  const stoppedEarlyDays = allDays.filter((d) =>
    d !== todayStr && perDay[d].anyEntry && perDay[d].lastEntryCategory !== "Food & Drink"
  );

  const items = [];
  if (blankDays.length) items.push(`<div class="gap-item"><strong>${blankDays.length} day(s) with no log at all:</strong> ${blankDays.map(fmtShort).join(", ")}</div>`);
  if (stoppedEarlyDays.length) items.push(`<div class="gap-item"><strong>${stoppedEarlyDays.length} day(s) where the log doesn't end with a meal</strong> (may have stopped tracking early): ${stoppedEarlyDays.map((d) => `${fmtShort(d)} (last: ${perDay[d].lastEntryCategory})`).join(", ")}</div>`);
  if (noFoodDays.length) items.push(`<div class="gap-item"><strong>${noFoodDays.length} day(s) with other logs but no food entries:</strong> ${noFoodDays.map(fmtShort).join(", ")}</div>`);
  if (noWaterDays.length) items.push(`<div class="gap-item"><strong>${noWaterDays.length} day(s) with other logs but no water entries:</strong> ${noWaterDays.map(fmtShort).join(", ")}</div>`);

  document.getElementById("gapsList").innerHTML = items.length ? items.join("") : `<div class="none">No obvious gaps in this range.</div>`;
}

function renderNutritionChart(perDay, allDays) {
  renderChart("nutritionChart", {
    type: "bar",
    data: {
      labels: allDays.map(fmtShort),
      datasets: [
        { label: "Calories (AI estimate)", data: allDays.map((d) => perDay[d].foodCal || null), backgroundColor: CHART_COLORS.cal, yAxisID: "y" },
        { label: "Protein g (AI estimate)", data: allDays.map((d) => perDay[d].foodProtein || null), backgroundColor: CHART_COLORS.protein, yAxisID: "y1", type: "line", tension: 0.3 },
      ],
    },
    options: {
      responsive: true,
      interaction: { mode: "index", intersect: false },
      scales: {
        y: { position: "left", title: { display: true, text: "calories" }, ticks: { color: "#8b98a9" }, grid: { color: "#2a3341" } },
        y1: { position: "right", title: { display: true, text: "protein (g)" }, ticks: { color: "#8b98a9" }, grid: { display: false } },
        x: { ticks: { color: "#8b98a9", maxRotation: 60, minRotation: 60 }, grid: { display: false } },
      },
      plugins: { legend: { labels: { color: "#e8edf3" } } },
    },
  });
}

function renderWaterChart(perDay, allDays) {
  renderChart("waterChart", {
    type: "bar",
    data: {
      labels: allDays.map(fmtShort),
      datasets: [{ label: "Water (oz)", data: allDays.map((d) => perDay[d].waterOz || 0), backgroundColor: CHART_COLORS.water }],
    },
    options: {
      responsive: true,
      scales: {
        y: { title: { display: true, text: "oz" }, ticks: { color: "#8b98a9" }, grid: { color: "#2a3341" } },
        x: { ticks: { color: "#8b98a9", maxRotation: 60, minRotation: 60 }, grid: { display: false } },
      },
      plugins: { legend: { display: false } },
    },
  });
}

function renderExerciseChart(perDay, allDays) {
  renderChart("exerciseChart", {
    type: "bar",
    data: {
      labels: allDays.map(fmtShort),
      datasets: [{ label: "Duration (min)", data: allDays.map((d) => perDay[d].exMin || 0), backgroundColor: CHART_COLORS.duration }],
    },
    options: {
      responsive: true,
      scales: {
        y: { title: { display: true, text: "minutes" }, ticks: { color: "#8b98a9" }, grid: { color: "#2a3341" } },
        x: { ticks: { color: "#8b98a9", maxRotation: 60, minRotation: 60 }, grid: { display: false } },
      },
      plugins: { legend: { display: false }, title: { display: true, text: "Exercise duration per day", color: "#e8edf3" } },
    },
  });

  renderChart("hrChart", {
    type: "line",
    data: {
      labels: allDays.map(fmtShort),
      datasets: [
        { label: "Avg HR", data: allDays.map((d) => (perDay[d].exAvgHrN ? Math.round(perDay[d].exAvgHrSum / perDay[d].exAvgHrN) : null)), borderColor: CHART_COLORS.avgHr, backgroundColor: CHART_COLORS.avgHr, spanGaps: true, tension: 0.3 },
        { label: "Max HR", data: allDays.map((d) => perDay[d].exMaxHr), borderColor: CHART_COLORS.maxHr, backgroundColor: CHART_COLORS.maxHr, spanGaps: true, tension: 0.3 },
      ],
    },
    options: {
      responsive: true,
      scales: {
        y: { title: { display: true, text: "bpm" }, ticks: { color: "#8b98a9" }, grid: { color: "#2a3341" } },
        x: { ticks: { color: "#8b98a9", maxRotation: 60, minRotation: 60 }, grid: { display: false } },
      },
      plugins: { legend: { labels: { color: "#e8edf3" } }, title: { display: true, text: "Heart rate per exercise day", color: "#e8edf3" } },
    },
  });
}

function renderWeightChart(weightPoints) {
  renderChart("weightChart", {
    type: "line",
    data: {
      labels: weightPoints.map((p) => fmtShort(p.date)),
      datasets: [{ label: "Weight (lbs)", data: weightPoints.map((p) => p.weight), borderColor: CHART_COLORS.weight, backgroundColor: CHART_COLORS.weight, tension: 0.2, pointRadius: 4 }],
    },
    options: {
      responsive: true,
      scales: {
        y: { title: { display: true, text: "lbs" }, ticks: { color: "#8b98a9" }, grid: { color: "#2a3341" } },
        x: { ticks: { color: "#8b98a9" }, grid: { display: false } },
      },
      plugins: { legend: { display: false } },
    },
  });
}

// ---------- journal drawer ----------
function categoryValue(r, text) {
  if (r.category === "Food & Drink") {
    const cal = numOrNull(r.calories) ?? numOrNull(r.est_calories) ?? parseCalories(text);
    const prot = numOrNull(r.protein_g) ?? numOrNull(r.est_protein_g) ?? parseProteinG(text);
    return { cal, prot, isDrink: isDrinkOnly(text) };
  }
  if (r.category === "Exercise") {
    const cal = numOrNull(r.calories) ?? parseCalories(text);
    const min = numOrNull(r.duration_min) ?? parseMinutes(text);
    return { cal, min };
  }
  if (r.category === "Water") {
    return { oz: parseOz(text) };
  }
  if (r.category === "Weight") {
    return { lbs: parseWeightLbs(text) };
  }
  return {};
}

function renderJournal() {
  const todayRows = lastRows.filter((r) => r.log_date === lastTodayStr);
  const dateLabel = lastTodayStr
    ? new Date(lastTodayStr + "T00:00:00").toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" })
    : "";
  document.getElementById("journalTitle").textContent = `Journal — ${dateLabel}`;

  let totalCal = 0, totalProt = 0;
  const itemsHtml = todayRows.map((r) => {
    const text = r.details || "";
    const v = categoryValue(r, text);
    let macrosHtml = "";

    if (r.category === "Food & Drink") {
      if (v.cal != null) totalCal += v.cal;
      if (v.prot != null) totalProt += v.prot;
      const parts = [];
      if (v.cal != null) parts.push(`${Math.round(v.cal)} cal`);
      if (v.prot != null) parts.push(`${Math.round(v.prot)} g protein`);
      if (!parts.length) parts.push("no estimate yet");
      macrosHtml = `<div class="macros ${v.isDrink ? "drink" : ""}">${parts.join(" · ")}</div>`;
    } else if (r.category === "Exercise") {
      const parts = [];
      if (v.min != null) parts.push(`${Math.round(v.min)} min`);
      if (v.cal != null) parts.push(`${Math.round(v.cal)} cal burned`);
      if (parts.length) macrosHtml = `<div class="macros">${parts.join(" · ")}</div>`;
    } else if (r.category === "Water") {
      if (v.oz != null) macrosHtml = `<div class="macros">${v.oz} oz</div>`;
    } else if (r.category === "Weight") {
      if (v.lbs != null) macrosHtml = `<div class="macros">${v.lbs} lbs</div>`;
    }

    return `
      <div class="journal-item">
        <div class="row1">
          <span class="category">${r.category}</span>
          <span class="time">${r.log_time ? formatTimeDisplay(r.log_date, r.log_time) : ""}</span>
        </div>
        <div class="details">${text}</div>
        ${macrosHtml}
      </div>
    `;
  }).join("");

  document.getElementById("journalSummary").innerHTML = todayRows.length ? `
    <div><strong>${Math.round(totalCal)}</strong>calories</div>
    <div><strong>${Math.round(totalProt)} g</strong>protein</div>
    <div><strong>${todayRows.length}</strong>entries</div>
  ` : "";

  document.getElementById("journalList").innerHTML = todayRows.length
    ? itemsHtml
    : `<div class="journal-empty">Nothing logged today yet.</div>`;
}

function openJournal() {
  renderJournal();
  document.getElementById("journalDrawer").classList.add("open");
  document.getElementById("journalBackdrop").classList.add("open");
}
function closeJournal() {
  document.getElementById("journalDrawer").classList.remove("open");
  document.getElementById("journalBackdrop").classList.remove("open");
}

document.getElementById("journalBtn").addEventListener("click", openJournal);
document.getElementById("journalCloseBtn").addEventListener("click", closeJournal);
document.getElementById("journalBackdrop").addEventListener("click", closeJournal);
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeJournal(); });

document.getElementById("rangeSelect").addEventListener("change", loadData);
document.getElementById("refreshBtn").addEventListener("click", loadData);
// Initial load is triggered by auth.js once sign-in is confirmed, not here.

// Keep data fresh automatically: periodic refresh plus a refresh when the tab
// regains focus (e.g. after being backgrounded), so stale data isn't silently shown.
const AUTO_REFRESH_MS = 60000;
function refreshActiveTab() {
  if (!window.isAuthed) return;
  if (!document.getElementById("app").classList.contains("hidden")) {
    loadData();
  } else if (typeof spiritualLoaded !== "undefined" && spiritualLoaded) {
    loadSpiritualData();
  }
}
setInterval(refreshActiveTab, AUTO_REFRESH_MS);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) refreshActiveTab();
});
