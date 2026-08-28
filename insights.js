const INSIGHTS_RANGE_DAYS = 30;
const ALCOHOL_WORDS = /\bbeer\b|\bipa\b|\blager\b|\bpilsner\b|\bale\b|\bwine\b|\bmezcal\b|\bspritz\b|\bhighball\b|\bcocktail\b|\bmargarita\b|\bvodka\b|\bwhiskey\b|\bgin\b|\brum\b|\btequila\b|\bchampagne\b|\bprosecco\b/i;

let insightsLoadedOnce = false;
let insightsFoodRows = [];
let insightsRolRows = [];
let insightsPractices = [];
let insightsDisruptions = [];

async function loadInsightsData() {
  if (!insightsLoadedOnce) {
    document.getElementById("insightsLoading").classList.remove("hidden");
    document.getElementById("insightsLoading").textContent = "Loading data…";
    document.querySelectorAll("#insightsApp .panel").forEach((el) => el.classList.add("hidden"));
  }

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - INSIGHTS_RANGE_DAYS + 1);
  const cutoffStr = toLocalDateStr(cutoff);

  const fetchPromise = Promise.all([
    sb.from("daily_log").select("*").eq("category", "Food & Drink").gte("log_date", cutoffStr),
    sb.from("rule_of_life_log").select("*").gte("log_date", cutoffStr),
    sb.from("rule_of_life_practices").select("*"),
    sb.from("rule_of_life_disruptions").select("*").gte("log_date", cutoffStr).order("log_date", { ascending: false }),
  ]);

  let foodRes, rolRes, practicesRes, disruptRes;
  try {
    [foodRes, rolRes, practicesRes, disruptRes] = await withTimeout(fetchPromise, 15000, "Loading insights data");
  } catch (e) {
    document.getElementById("insightsLoading").textContent = e.message;
    document.getElementById("insightsLoading").classList.remove("hidden");
    return;
  }

  document.getElementById("insightsLoading").classList.add("hidden");
  const error = foodRes.error || rolRes.error || practicesRes.error || disruptRes.error;
  if (error) {
    document.getElementById("insightsLoading").textContent = "Error loading data: " + error.message;
    document.getElementById("insightsLoading").classList.remove("hidden");
    return;
  }

  insightsLoadedOnce = true;
  insightsFoodRows = foodRes.data;
  insightsRolRows = rolRes.data;
  insightsPractices = practicesRes.data;
  insightsDisruptions = disruptRes.data;
  renderInsights();
}

function renderInsights() {
  const hasDisruptions = insightsDisruptions.length > 0;
  document.getElementById("insightsComparePanel").classList.toggle("hidden", !hasDisruptions);
  document.getElementById("insightsDetailPanel").classList.toggle("hidden", !hasDisruptions);
  if (!hasDisruptions) return;

  renderInsightsCompare();
  renderInsightsDetail();
}

function dayCaloriesAndAlcohol(logDate) {
  let cal = 0, alcohol = 0;
  insightsFoodRows.filter((r) => r.log_date === logDate).forEach((r) => {
    const text = r.details || "";
    const c = numOrNull(r.calories) ?? numOrNull(r.est_calories) ?? parseCalories(text);
    if (c != null) cal += c;
    if (ALCOHOL_WORDS.test(text)) alcohol++;
  });
  return { cal, alcohol };
}

function dayPracticesDone(logDate) {
  const done = new Set(insightsRolRows.filter((r) => r.log_date === logDate).map((r) => r.practice));
  return done;
}

function renderInsightsCompare() {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - INSIGHTS_RANGE_DAYS + 1);
  const allDays = dateRangeArray(toLocalDateStr(cutoff), todayLocalStr()).filter((d) => d !== todayLocalStr());

  const disruptionDates = new Set(insightsDisruptions.map((d) => d.log_date));
  const disruptionDays = allDays.filter((d) => disruptionDates.has(d));
  const normalDays = allDays.filter((d) => !disruptionDates.has(d));

  function averages(days) {
    if (!days.length) return null;
    let totalPractices = 0, totalScheduled = 0, totalCal = 0, totalAlcohol = 0;
    days.forEach((d) => {
      totalPractices += dayPracticesDone(d).size;
      totalScheduled += insightsPractices.filter((p) => practiceAppliesOnDate(p, d)).length;
      const { cal, alcohol } = dayCaloriesAndAlcohol(d);
      totalCal += cal;
      totalAlcohol += alcohol;
    });
    return {
      practices: totalPractices / days.length,
      scheduled: totalScheduled / days.length,
      cal: totalCal / days.length,
      alcohol: totalAlcohol / days.length,
    };
  }

  const disruptAvg = averages(disruptionDays);
  const normalAvg = averages(normalDays);

  const rows = [
    {
      label: "Practices done / day",
      disrupt: disruptAvg ? `${disruptAvg.practices.toFixed(1)} / ${disruptAvg.scheduled.toFixed(1)}` : "—",
      normal: normalAvg ? `${normalAvg.practices.toFixed(1)} / ${normalAvg.scheduled.toFixed(1)}` : "—",
    },
    {
      label: "Calories / day",
      disrupt: disruptAvg ? Math.round(disruptAvg.cal) : "—",
      normal: normalAvg ? Math.round(normalAvg.cal) : "—",
    },
    {
      label: "Alcoholic drinks / day",
      disrupt: disruptAvg ? disruptAvg.alcohol.toFixed(1) : "—",
      normal: normalAvg ? normalAvg.alcohol.toFixed(1) : "—",
    },
  ];

  document.getElementById("insightsCompareGrid").innerHTML = `
    <div class="compare-header">
      <div></div>
      <div class="compare-col-label disrupt">Disruption days<span class="hint">(${disruptionDays.length})</span></div>
      <div class="compare-col-label normal">Normal days<span class="hint">(${normalDays.length})</span></div>
    </div>
    ${rows.map((r) => `
      <div class="compare-row">
        <div class="compare-metric">${r.label}</div>
        <div class="compare-value disrupt">${r.disrupt}</div>
        <div class="compare-value normal">${r.normal}</div>
      </div>
    `).join("")}
  `;
}

function renderInsightsDetail() {
  const truncate = (s) => (s || "").length > 60 ? (s || "").slice(0, 60) + "…" : (s || "");

  // Group disruptions by day (usually one, but handle multiple causes same day).
  const byDay = {};
  insightsDisruptions.forEach((d) => {
    if (!byDay[d.log_date]) byDay[d.log_date] = [];
    byDay[d.log_date].push(d.cause);
  });
  const days = Object.keys(byDay).sort().reverse();

  document.getElementById("insightsDetailList").innerHTML = days.map((logDate) => {
    const causes = byDay[logDate].join(", ");
    const doneSet = dayPracticesDone(logDate);
    const scheduled = insightsPractices.filter((p) => practiceAppliesOnDate(p, logDate));
    const missed = scheduled.filter((p) => !doneSet.has(p.name)).map((p) => p.name);
    const { cal, alcohol } = dayCaloriesAndAlcohol(logDate);
    const foodItems = insightsFoodRows.filter((r) => r.log_date === logDate);

    return `
      <div class="insights-day-card">
        <div class="insights-day-header">
          <strong>${fmtShort(logDate)}</strong>
          <span class="insights-day-cause">${causes}</span>
        </div>
        <div class="insights-day-row">
          <span class="insights-day-label">Practices:</span>
          ${scheduled.length ? `${doneSet.size}/${scheduled.length} done${missed.length ? ` — missed: ${missed.join(", ")}` : ""}` : "no practices scheduled"}
        </div>
        <div class="insights-day-row">
          <span class="insights-day-label">Food:</span>
          ${foodItems.length ? `${Math.round(cal)} cal, ${alcohol} alcoholic drink${alcohol === 1 ? "" : "s"}, ${foodItems.length} log${foodItems.length === 1 ? "" : "s"}` : "nothing logged"}
        </div>
        ${foodItems.length ? `<div class="insights-day-food-list">${foodItems.map((r) => truncate(r.details)).join(" · ")}</div>` : ""}
      </div>
    `;
  }).join("");
}
