const PLAN_TIME_SLOTS = ["Morning", "Midday", "Afternoon", "Evening"];

let planRows = [];
let actualLogRows = []; // today's real daily_log Food & Drink rows, for the forecast cards
let actualExerciseRows = []; // today's real daily_log Exercise rows, for net-calorie forecast
let planViewDate = todayLocalStr();
let planLoadedOnce = false;

function nowTimeStr() {
  return new Date().toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

async function renderFoodPlanDeepDive() {
  if (!planLoadedOnce) {
    document.getElementById("planLoading").classList.remove("hidden");
    document.getElementById("planLoading").textContent = "Loading data…";
    document.getElementById("planPanel").classList.add("hidden");
  }

  const [planRes, logRes, exRes] = await Promise.all([
    sb.from("food_plan").select("*")
      .eq("log_date", planViewDate)
      .order("id", { ascending: true }),
    // Real journal entries for the day, so the forecast reflects what you've actually
    // eaten (including anything logged outside the plan), not just checked-off plan items.
    sb.from("daily_log").select("calories, protein_g, est_calories, est_protein_g, details")
      .eq("log_date", planViewDate)
      .eq("category", "Food & Drink"),
    // Real exercise entries for the day, so the net-calorie forecast can subtract
    // calories actually burned (exercise isn't planned on this tab, only logged).
    sb.from("daily_log").select("calories, details")
      .eq("log_date", planViewDate)
      .eq("category", "Exercise"),
  ]);

  const error = planRes.error || logRes.error || exRes.error;
  if (error) {
    document.getElementById("planLoading").textContent = "Error loading data: " + error.message;
    document.getElementById("planLoading").classList.remove("hidden");
    return;
  }

  document.getElementById("planLoading").classList.add("hidden");
  document.getElementById("planPanel").classList.remove("hidden");
  planLoadedOnce = true;
  planRows = planRes.data;
  actualLogRows = logRes.data;
  actualExerciseRows = exRes.data;
  renderPlan();
}

function renderPlan() {
  const isToday = planViewDate === todayLocalStr();
  const dateLabel = new Date(planViewDate + "T00:00:00").toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
  document.getElementById("planHeading").textContent = isToday ? `Today's Plan — ${dateLabel}` : `Plan — ${dateLabel}`;

  renderPlanCards();

  document.getElementById("planGroups").innerHTML = PLAN_TIME_SLOTS.map((slot) => {
    const items = planRows.filter((r) => r.time_of_day === slot);
    const itemsHtml = items.map((r) => {
      const macros = [
        r.est_calories != null ? `~${Math.round(numOrNull(r.est_calories))} cal` : null,
        r.est_protein_g != null ? `${Math.round(numOrNull(r.est_protein_g))}g protein` : null,
      ].filter(Boolean).join(" · ");
      return `
      <div class="plan-item ${r.logged_daily_log_id ? "done" : ""}" data-id="${r.id}" data-logged-id="${r.logged_daily_log_id || ""}">
        <label>
          <input type="checkbox" ${r.logged_daily_log_id ? "checked" : ""} />
          <span>${r.item}${macros ? `<span class="plan-item-macro">${macros}</span>` : ""}</span>
        </label>
        <button class="plan-item-remove" aria-label="Remove">&times;</button>
      </div>
    `;
    }).join("");
    return `
      <div class="checkin-group">
        <h3>${slot}</h3>
        <div class="rol-checklist">${itemsHtml || `<div class="journal-empty">Nothing planned yet.</div>`}</div>
        <form class="plan-add-form" data-slot="${slot}">
          <input type="text" class="plan-add-item" placeholder="Add a food..." maxlength="200" required />
          <input type="number" class="plan-add-cal" placeholder="cal" min="0" step="1" required />
          <input type="number" class="plan-add-protein" placeholder="prot g" min="0" step="1" required />
          <button type="submit">Add</button>
        </form>
      </div>
    `;
  }).join("");

  document.querySelectorAll(".plan-item input[type=checkbox]").forEach((input) => {
    input.addEventListener("change", () => togglePlanItem(input.closest(".plan-item")));
  });
  document.querySelectorAll(".plan-item-remove").forEach((btn) => {
    btn.addEventListener("click", () => removePlanItem(btn.closest(".plan-item")));
  });
  document.querySelectorAll(".plan-add-form").forEach((form) => {
    form.addEventListener("submit", (e) => { e.preventDefault(); addPlanItem(form); });
  });
}

// Forecast = what you've actually eaten today (real daily_log entries, whatever their
// source — plan check-offs or logged some other way) + whatever's still unchecked on
// the plan. That's "where today is headed" if you follow through on what's left.
function renderPlanCards() {
  const cardsEl = document.getElementById("planCards");
  if (!planRows.length && !actualLogRows.length) { cardsEl.innerHTML = ""; return; }

  const actualCal = actualLogRows.reduce((s, r) => s + (numOrNull(r.calories) ?? numOrNull(r.est_calories) ?? parseCalories(r.details || "") ?? 0), 0);
  const actualProtein = actualLogRows.reduce((s, r) => s + (numOrNull(r.protein_g) ?? numOrNull(r.est_protein_g) ?? parseProteinG(r.details || "") ?? 0), 0);

  const remaining = planRows.filter((r) => !r.logged_daily_log_id);
  const remainingCal = remaining.reduce((s, r) => s + (numOrNull(r.est_calories) || 0), 0);
  const remainingProtein = remaining.reduce((s, r) => s + (numOrNull(r.est_protein_g) || 0), 0);

  const forecastCal = actualCal + remainingCal;
  const forecastProtein = actualProtein + remainingProtein;

  // Net calories = gross forecasted calories minus calories actually burned from exercise.
  // Exercise isn't planned on this tab (only logged), so this uses today's real exercise
  // entries only — same "gross - exercise" math and negative-value guard as the Today card
  // on the Overview tab (see renderToday in app.js).
  const exCal = actualExerciseRows.reduce((s, r) => s + Math.abs(numOrNull(r.calories) ?? parseCalories(r.details || "") ?? 0), 0);
  const forecastNetCal = forecastCal - exCal;

  cardsEl.innerHTML = [
    {
      label: "Forecasted Gross Calories", value: `${Math.round(forecastCal)}`,
      sub: `${Math.round(actualCal)} eaten so far + ${Math.round(remainingCal)} left on plan`,
    },
    {
      label: "Forecasted Net Calories", value: `${Math.round(forecastNetCal)}`,
      sub: `${Math.round(forecastCal)} gross − ${Math.round(exCal)} burned`,
    },
    {
      label: "Forecasted Protein", value: `${Math.round(forecastProtein)}g`,
      sub: `${Math.round(actualProtein)}g eaten so far + ${Math.round(remainingProtein)}g left on plan`,
    },
  ].map((c) => `
    <div class="card">
      <div class="label">${c.label}</div>
      <div class="value">${c.value}</div>
      <div class="sub">${c.sub}</div>
    </div>
  `).join("");
}

async function togglePlanItem(row) {
  if (row.dataset.busy) return;
  row.dataset.busy = "1";
  const planId = row.dataset.id;
  const loggedId = row.dataset.loggedId;

  if (loggedId) {
    const { error } = await sb.from("daily_log").delete().eq("id", loggedId);
    if (error) { alert("Failed to update: " + error.message); delete row.dataset.busy; return; }
    const { error: updateError } = await sb.from("food_plan").update({ logged_daily_log_id: null }).eq("id", planId);
    if (updateError) { alert("Failed to update: " + updateError.message); delete row.dataset.busy; return; }
  } else {
    const item = planRows.find((r) => String(r.id) === planId);
    // Carry the plan's estimate over as the journal entry's own estimate (est_calories/
    // est_protein_g), not the real calories/protein_g columns — those are reserved for
    // precise logged values, and a plan estimate is still just an estimate.
    const { data: inserted, error } = await sb.from("daily_log")
      .insert({
        log_date: planViewDate, log_time: nowTimeStr(), category: "Food & Drink", details: item.item,
        est_calories: item.est_calories, est_protein_g: item.est_protein_g,
      })
      .select().single();
    if (error) { alert("Failed to log: " + error.message); delete row.dataset.busy; return; }
    const { error: updateError } = await sb.from("food_plan").update({ logged_daily_log_id: inserted.id }).eq("id", planId);
    if (updateError) { alert("Failed to update: " + updateError.message); delete row.dataset.busy; return; }
  }

  // A logged/unlogged item changes the actual journal (Today panel, journal drawer),
  // not just the plan — refresh the whole health view, which re-renders the plan too.
  if (typeof loadData === "function") await loadData();
  else await renderFoodPlanDeepDive();
}

async function removePlanItem(row) {
  if (row.dataset.busy) return;
  row.dataset.busy = "1";
  const { error } = await sb.from("food_plan").delete().eq("id", row.dataset.id);
  if (error) { alert("Failed to remove: " + error.message); delete row.dataset.busy; return; }
  await renderFoodPlanDeepDive();
}

async function addPlanItem(form) {
  const itemInput = form.querySelector(".plan-add-item");
  const calInput = form.querySelector(".plan-add-cal");
  const proteinInput = form.querySelector(".plan-add-protein");
  const item = itemInput.value.trim();
  const estCalories = calInput.value.trim();
  const estProteinG = proteinInput.value.trim();
  // Every plan item needs a calorie/protein estimate so the day's totals always add up —
  // enforced here (and by a NOT NULL constraint in the DB as a backstop).
  if (!item || estCalories === "" || estProteinG === "") {
    alert("Please enter the food plus a calorie and protein estimate.");
    return;
  }
  const slot = form.dataset.slot;
  const { error } = await sb.from("food_plan").insert({
    log_date: planViewDate, time_of_day: slot, item,
    est_calories: Number(estCalories), est_protein_g: Number(estProteinG),
  });
  if (error) { alert("Failed to add: " + error.message); return; }
  await renderFoodPlanDeepDive();
}

document.getElementById("planPrevBtn").addEventListener("click", () => {
  const d = new Date(planViewDate + "T00:00:00");
  d.setDate(d.getDate() - 1);
  planViewDate = toLocalDateStr(d);
  renderFoodPlanDeepDive();
});
document.getElementById("planNextBtn").addEventListener("click", () => {
  const d = new Date(planViewDate + "T00:00:00");
  d.setDate(d.getDate() + 1);
  planViewDate = toLocalDateStr(d);
  renderFoodPlanDeepDive();
});
