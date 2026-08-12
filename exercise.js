// ---------- exercise type classification ----------
// Peloton class titles and dog-walk notes are consistent enough in this data to
// classify reliably by keyword; "Other" catches things like yard work.
// Ride/cycling is checked first because it's unambiguous ("Power Zone Ride"), and
// the strength match requires a class-title pattern (not just the word "strength"
// anywhere) — otherwise a ride whose notes mention "...after the strength class..."
// gets misclassified.
function classifyExerciseType(text) {
  const t = text || "";
  if (/\bride\b|\bcycling\b|\bbike\b/i.test(t)) return "Cycling";
  if (/\d+\s*min\s+[\w&\s]+?\bstrength\b/i.test(t) || /\(\s*[^,]+,\s*strength\s*\)/i.test(t)) return "Strength";
  if (/\bwalk\b/i.test(t)) return "Walk";
  return "Other";
}

const parseDistanceMi = (t) => parseFirst(t, /(\d+(?:\.\d+)?)\s*mi\b/i);

// Some strength sessions log a weight change mid-workout ("10 lb to start, moved to
// 12.5 lb") — the last mention is the more representative working weight.
function parseDumbbellWeight(text) {
  const matches = [...(text || "").matchAll(/(\d+(?:\.\d+)?)\s*lb\s*dumbbells?/gi)];
  if (!matches.length) return null;
  return parseFloat(matches[matches.length - 1][1]);
}

// Peloton strength class titles follow "<N> min <Muscle Group> Strength" — grab the
// muscle group phrase in between.
function parseStrengthClassTitle(text) {
  const m = (text || "").match(/\d+\s*min\s+([A-Za-z&\s]+?)\s+Strength\b/i);
  return m ? m[1].trim() : "Strength (other)";
}

const EX_TYPE_COLORS = { Walk: "#4fd1c5", Cycling: "#63b3ed", Strength: "#f6ad55", Other: "#8b98a9" };

function enrichExerciseRow(r) {
  const text = r.details || "";
  return {
    ...r,
    type: classifyExerciseType(text),
    min: numOrNull(r.duration_min) ?? parseMinutes(text),
    cal: numOrNull(r.calories) ?? parseCalories(text),
    mi: parseDistanceMi(text),
  };
}

function renderExerciseDeepDive() {
  renderExToday();

  const rows = lastRows.filter((r) => r.category === "Exercise");
  const hasData = rows.length > 0;

  document.getElementById("exRangeHeading").classList.toggle("hidden", !hasData);
  document.getElementById("exCards").classList.toggle("hidden", !hasData);
  document.getElementById("exTypePanel").classList.toggle("hidden", !hasData);
  document.getElementById("exDistancePanel").classList.toggle("hidden", !hasData);
  if (!hasData) {
    document.getElementById("exMusclePanel").classList.add("hidden");
    document.getElementById("exWeightLevelPanel").classList.add("hidden");
    return;
  }

  const rangeLabel = document.getElementById("rangeSelect").selectedOptions[0].text;
  document.getElementById("exRangeHeading").textContent = rangeLabel;

  const enriched = rows.map(enrichExerciseRow);

  renderExCards(enriched);
  renderExTypeBreakdown(enriched);
  renderExDistanceChart(enriched);
  renderExMuscleBreakdown(enriched);
  renderExWeightLevelChart(enriched);
}

function renderExToday() {
  const todayStr = todayLocalStr();
  const todayRows = lastRows.filter((r) => r.category === "Exercise" && r.log_date === todayStr).map(enrichExerciseRow);

  document.getElementById("exTodayHeading").textContent =
    `Today — ${new Date(todayStr + "T00:00:00").toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" })}`;

  if (!todayRows.length) {
    document.getElementById("exTodayCards").innerHTML = `
      <div class="card"><div class="label">Sessions</div><div class="value">—</div><div class="sub">nothing logged yet today</div></div>
    `;
    return;
  }

  const totalMin = todayRows.reduce((s, r) => s + (r.min || 0), 0);
  const totalCal = todayRows.reduce((s, r) => s + (r.cal || 0), 0);
  const totalMi = todayRows.reduce((s, r) => s + (r.mi || 0), 0);
  const types = [...new Set(todayRows.map((r) => r.type))].join(", ");

  const cards = [
    { label: "Sessions", value: todayRows.length, sub: types },
    { label: "Total time", value: `${Math.round(totalMin)} min`, sub: "today" },
    { label: "Calories burned", value: Math.round(totalCal), sub: "today" },
    { label: "Distance", value: `${totalMi.toFixed(1)} mi`, sub: "walk + cycling" },
  ];

  document.getElementById("exTodayCards").innerHTML = cards.map((c) => `
    <div class="card">
      <div class="label">${c.label}</div>
      <div class="value">${c.value}</div>
      <div class="sub">${c.sub}</div>
    </div>
  `).join("");
}

function renderExCards(enriched) {
  const totalMin = enriched.reduce((s, r) => s + (r.min || 0), 0);
  const totalCal = enriched.reduce((s, r) => s + (r.cal || 0), 0);
  const totalMi = enriched.reduce((s, r) => s + (r.mi || 0), 0);

  const cards = [
    { label: "Sessions", value: enriched.length, sub: "in selected range" },
    { label: "Total time", value: `${Math.round(totalMin)} min`, sub: `${(totalMin / 60).toFixed(1)} hrs` },
    { label: "Calories burned", value: Math.round(totalCal), sub: "from workouts" },
    { label: "Distance", value: `${totalMi.toFixed(1)} mi`, sub: "walk + cycling" },
  ];

  document.getElementById("exCards").innerHTML = cards.map((c) => `
    <div class="card">
      <div class="label">${c.label}</div>
      <div class="value">${c.value}</div>
      <div class="sub">${c.sub}</div>
    </div>
  `).join("");
}

function renderExTypeBreakdown(enriched) {
  const types = ["Walk", "Cycling", "Strength", "Other"];
  const byType = {};
  types.forEach((t) => { byType[t] = { count: 0, min: 0, cal: 0, mi: 0 }; });
  enriched.forEach((r) => {
    const b = byType[r.type];
    b.count++;
    b.min += r.min || 0;
    b.cal += r.cal || 0;
    b.mi += r.mi || 0;
  });

  document.getElementById("exTypeBreakdown").innerHTML = types.filter((t) => byType[t].count > 0).map((t) => {
    const b = byType[t];
    return `
      <div class="ex-type-card" style="border-color: ${EX_TYPE_COLORS[t]}55">
        <div class="type-name" style="color:${EX_TYPE_COLORS[t]}">${t}</div>
        <div class="stat-row"><span>Sessions</span><strong>${b.count}</strong></div>
        <div class="stat-row"><span>Total time</span><strong>${Math.round(b.min)} min</strong></div>
        <div class="stat-row"><span>Calories</span><strong>${Math.round(b.cal)}</strong></div>
        ${b.mi > 0 ? `<div class="stat-row"><span>Distance</span><strong>${b.mi.toFixed(1)} mi</strong></div>` : ""}
      </div>
    `;
  }).join("");
}

function renderExDistanceChart(enriched) {
  const days = dateRangeArray(enriched[0].log_date, enriched[enriched.length - 1].log_date);
  const walkByDay = {}, cycleByDay = {};
  days.forEach((d) => { walkByDay[d] = 0; cycleByDay[d] = 0; });
  enriched.forEach((r) => {
    if (r.mi == null) return;
    if (r.type === "Walk") walkByDay[r.log_date] += r.mi;
    if (r.type === "Cycling") cycleByDay[r.log_date] += r.mi;
  });

  renderChart("exDistanceChart", {
    type: "bar",
    data: {
      labels: days.map(fmtShort),
      datasets: [
        { label: "Walk (mi)", data: days.map((d) => walkByDay[d] || null), backgroundColor: EX_TYPE_COLORS.Walk },
        { label: "Cycling (mi)", data: days.map((d) => cycleByDay[d] || null), backgroundColor: EX_TYPE_COLORS.Cycling },
      ],
    },
    options: {
      responsive: true,
      scales: {
        y: { title: { display: true, text: "miles" }, ticks: { color: "#8b98a9" }, grid: { color: "#2a3341" } },
        x: { ticks: { color: "#8b98a9", maxRotation: 60, minRotation: 60 }, grid: { display: false } },
      },
      plugins: { legend: { labels: { color: "#e8edf3" } } },
    },
  });
}

function renderExMuscleBreakdown(enriched) {
  const strengthRows = enriched.filter((r) => r.type === "Strength");
  document.getElementById("exMusclePanel").classList.toggle("hidden", strengthRows.length === 0);
  if (!strengthRows.length) return;

  const muscleCounts = {};
  strengthRows.forEach((r) => {
    const group = parseStrengthClassTitle(r.details);
    muscleCounts[group] = (muscleCounts[group] || 0) + 1;
  });
  const maxCount = Math.max(...Object.values(muscleCounts));
  const sortedGroups = Object.keys(muscleCounts).sort((a, b) => muscleCounts[b] - muscleCounts[a]);

  document.getElementById("exMuscleBreakdown").innerHTML = sortedGroups.map((g) => {
    const count = muscleCounts[g];
    const pct = Math.round((count / maxCount) * 100);
    return `
      <div class="rol-breakdown-row">
        <div class="rol-breakdown-label">${g}</div>
        <div class="rol-breakdown-bar-track"><div class="rol-breakdown-bar" style="width:${pct}%; background: ${EX_TYPE_COLORS.Strength}"></div></div>
        <div class="rol-breakdown-pct">${count} session${count === 1 ? "" : "s"}</div>
      </div>
    `;
  }).join("");
}

function renderExWeightLevelChart(enriched) {
  const weightPoints = enriched
    .filter((r) => r.type === "Strength")
    .map((r) => ({ date: r.log_date, weight: parseDumbbellWeight(r.details) }))
    .filter((p) => p.weight != null);

  document.getElementById("exWeightLevelPanel").classList.toggle("hidden", weightPoints.length === 0);
  if (!weightPoints.length) return;

  renderChart("exWeightLevelChart", {
    type: "line",
    data: {
      labels: weightPoints.map((p) => fmtShort(p.date)),
      datasets: [{ label: "Dumbbell weight (lb)", data: weightPoints.map((p) => p.weight), borderColor: EX_TYPE_COLORS.Strength, backgroundColor: EX_TYPE_COLORS.Strength, tension: 0.2, pointRadius: 4 }],
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

