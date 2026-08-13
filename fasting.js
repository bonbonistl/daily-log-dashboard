const FAST_COLOR = "#63b3ed";
const FAST_SHORT_THRESHOLD_HOURS = 10; // flag nights shorter than this as notably short

let fastingExclusions = new Set(); // from_date strings the user has marked as bad data

function formatFastDuration(hours) {
  const h = Math.floor(hours);
  const m = Math.round((hours - h) * 60);
  return `${h}h ${m}m`;
}

// Pairs each day's last actual food (not drink) with the next calendar day's first
// actual food, giving the overnight fasting window. Only pairs truly consecutive
// days — a day with zero food logged in between breaks the chain rather than
// silently producing a misleading multi-day "fast".
function computeFastingWindows() {
  const foodByDay = {};
  lastRows.forEach((r) => {
    if (r.category !== "Food & Drink") return;
    const text = r.details || "";
    if (isDrinkOnly(text)) return;
    const dt = parseLogTimeToDate(r.log_date, r.log_time);
    if (!dt) return;
    if (!foodByDay[r.log_date]) foodByDay[r.log_date] = { first: null, last: null };
    const day = foodByDay[r.log_date];
    if (!day.first || dt < day.first.dt) day.first = { dt, time: r.log_time, details: r.details };
    if (!day.last || dt > day.last.dt) day.last = { dt, time: r.log_time, details: r.details };
  });

  const days = Object.keys(foodByDay).sort();
  const windows = [];
  days.forEach((d0) => {
    const nextDate = new Date(d0 + "T00:00:00");
    nextDate.setDate(nextDate.getDate() + 1);
    const d1 = toLocalDateStr(nextDate);
    if (!foodByDay[d1]) return;
    const last = foodByDay[d0].last;
    const first = foodByDay[d1].first;
    const hours = (first.dt - last.dt) / 3600000;
    if (hours <= 0) return; // guard against unparseable/odd times
    windows.push({ fromDate: d0, toDate: d1, lastTime: last.time, lastDetails: last.details, firstTime: first.time, firstDetails: first.details, hours });
  });
  return windows;
}

async function renderFastingDeepDive() {
  const windows = computeFastingWindows();

  // Fetch the most recent food entries independent of whatever date range is
  // selected elsewhere, so "Current fast" stays accurate right at a range boundary
  // (e.g. fasting from Sunday night into Monday when "This Week" is selected).
  const [exclusionsRes, recentFoodRes] = await Promise.all([
    sb.from("fasting_exclusions").select("from_date"),
    sb.from("daily_log").select("log_date, log_time, details")
      .eq("category", "Food & Drink")
      .order("log_date", { ascending: false }).order("id", { ascending: false })
      .limit(30),
  ]);
  if (!exclusionsRes.error) fastingExclusions = new Set((exclusionsRes.data || []).map((e) => e.from_date));

  const activeWindows = windows.filter((w) => !fastingExclusions.has(w.fromDate));
  const hasWindowData = windows.length > 0;

  document.getElementById("fastCards").classList.remove("hidden");
  document.getElementById("fastChartPanel").classList.toggle("hidden", activeWindows.length === 0);
  document.getElementById("fastListPanel").classList.toggle("hidden", !hasWindowData);

  renderFastCards(windows, activeWindows, recentFoodRes.data || []);
  if (activeWindows.length) renderFastChart(activeWindows);
  if (hasWindowData) renderFastList(windows);
}

function renderFastCards(windows, activeWindows, recentFoodRows) {
  const excludedCount = windows.length - activeWindows.length;
  const excludedNote = excludedCount ? ` (${excludedCount} excluded)` : "";

  // Currently fasting? True if the most recent actual food (not drink) wasn't today.
  let mostRecent = null;
  recentFoodRows.forEach((r) => {
    const text = r.details || "";
    if (isDrinkOnly(text)) return;
    const dt = parseLogTimeToDate(r.log_date, r.log_time);
    if (dt && (!mostRecent || dt > mostRecent)) mostRecent = dt;
  });
  const todayStr = todayLocalStr();
  const currentlyFasting = mostRecent && toLocalDateStr(mostRecent) !== todayStr;
  const currentFastValue = currentlyFasting ? formatFastDuration((Date.now() - mostRecent.getTime()) / 3600000) : "Eating window open";

  let cards = [
    { label: "Current fast", value: currentFastValue, sub: currentlyFasting ? "since last food" : "food logged today" },
  ];

  if (activeWindows.length) {
    const hoursArr = activeWindows.map((w) => w.hours);
    const avg = hoursArr.reduce((s, h) => s + h, 0) / hoursArr.length;
    const longest = activeWindows.reduce((a, b) => (b.hours > a.hours ? b : a));
    const shortest = activeWindows.reduce((a, b) => (b.hours < a.hours ? b : a));
    cards = cards.concat([
      { label: "Avg overnight fast", value: formatFastDuration(avg), sub: `over ${activeWindows.length} night${activeWindows.length === 1 ? "" : "s"}${excludedNote}` },
      { label: "Longest fast", value: formatFastDuration(longest.hours), sub: `night of ${fmtShort(longest.fromDate)}` },
      { label: "Shortest fast", value: formatFastDuration(shortest.hours), sub: `night of ${fmtShort(shortest.fromDate)}`, cls: shortest.hours < FAST_SHORT_THRESHOLD_HOURS ? "warn" : "" },
    ]);
  } else if (windows.length > 0) {
    cards.push({ label: "Avg overnight fast", value: "—", sub: `all ${windows.length} night${windows.length === 1 ? "" : "s"} excluded` });
  } else {
    cards.push({ label: "Avg overnight fast", value: "—", sub: "no completed overnight fasts yet" });
  }

  document.getElementById("fastCards").innerHTML = cards.map((c) => `
    <div class="card ${c.cls || ""}">
      <div class="label">${c.label}</div>
      <div class="value">${c.value}</div>
      <div class="sub">${c.sub}</div>
    </div>
  `).join("");
}

function renderFastChart(activeWindows) {
  renderChart("fastChart", {
    type: "bar",
    data: {
      labels: activeWindows.map((w) => fmtShort(w.fromDate)),
      datasets: [{
        label: "Fast length (hrs)",
        data: activeWindows.map((w) => Math.round(w.hours * 10) / 10),
        backgroundColor: activeWindows.map((w) => (w.hours < FAST_SHORT_THRESHOLD_HOURS ? CHART_COLORS.maxHr : FAST_COLOR)),
      }],
    },
    options: {
      responsive: true,
      scales: {
        y: { title: { display: true, text: "hours" }, ticks: { color: "#8b98a9" }, grid: { color: "#2a3341" } },
        x: { ticks: { color: "#8b98a9", maxRotation: 60, minRotation: 60 }, grid: { display: false } },
      },
      plugins: { legend: { display: false } },
    },
  });
}

function renderFastList(windows) {
  const truncate = (s) => (s || "").length > 70 ? (s || "").slice(0, 70) + "…" : (s || "");
  document.getElementById("fastList").innerHTML = [...windows].reverse().map((w) => {
    const excluded = fastingExclusions.has(w.fromDate);
    return `
      <div class="fast-item ${excluded ? "excluded" : (w.hours < FAST_SHORT_THRESHOLD_HOURS ? "short" : "")}">
        <div class="fast-item-header">
          <label class="fast-exclude-toggle">
            <input type="checkbox" data-from-date="${w.fromDate}" ${excluded ? "checked" : ""} />
            <span>${fmtShort(w.fromDate)} → ${fmtShort(w.toDate)}</span>
          </label>
          <strong>${formatFastDuration(w.hours)}</strong>
        </div>
        <div class="fast-item-detail">Last food ${formatTimeDisplay(w.fromDate, w.lastTime)} — ${truncate(w.lastDetails)}</div>
        <div class="fast-item-detail">First food ${formatTimeDisplay(w.toDate, w.firstTime)} — ${truncate(w.firstDetails)}</div>
        ${excluded ? `<div class="fast-item-excluded-note">Excluded — likely missing data, not counted in stats</div>` : ""}
      </div>
    `;
  }).join("");

  document.querySelectorAll(".fast-exclude-toggle input").forEach((input) => {
    input.addEventListener("change", async () => {
      const fromDate = input.dataset.fromDate;
      input.disabled = true;
      if (input.checked) {
        await sb.from("fasting_exclusions").insert({ from_date: fromDate });
      } else {
        await sb.from("fasting_exclusions").delete().eq("from_date", fromDate);
      }
      renderFastingDeepDive();
    });
  });
}
