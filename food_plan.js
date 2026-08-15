const PLAN_TIME_SLOTS = ["Morning", "Midday", "Afternoon", "Evening"];

let planRows = [];
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

  const { data, error } = await sb.from("food_plan").select("*")
    .eq("log_date", planViewDate)
    .order("id", { ascending: true });

  if (error) {
    document.getElementById("planLoading").textContent = "Error loading data: " + error.message;
    document.getElementById("planLoading").classList.remove("hidden");
    return;
  }

  document.getElementById("planLoading").classList.add("hidden");
  document.getElementById("planPanel").classList.remove("hidden");
  planLoadedOnce = true;
  planRows = data;
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
          <input type="text" placeholder="Add a food..." maxlength="200" />
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

// Hypothetical macros for the day: total = everything planned, eaten = the subset
// already checked off. Items without an AI estimate yet just contribute 0.
function renderPlanCards() {
  const cardsEl = document.getElementById("planCards");
  if (!planRows.length) { cardsEl.innerHTML = ""; return; }

  const sum = (rows, field) => rows.reduce((s, r) => s + (numOrNull(r[field]) || 0), 0);
  const eaten = planRows.filter((r) => r.logged_daily_log_id);
  const totalCal = sum(planRows, "est_calories");
  const eatenCal = sum(eaten, "est_calories");
  const totalProtein = sum(planRows, "est_protein_g");
  const eatenProtein = sum(eaten, "est_protein_g");
  const missing = planRows.filter((r) => r.est_calories == null).length;
  const missingNote = missing ? ` (${missing} item${missing === 1 ? "" : "s"} missing an estimate)` : "";

  cardsEl.innerHTML = [
    { label: "Calories", value: `${Math.round(eatenCal)} / ${Math.round(totalCal)}`, sub: `eaten / planned today${missingNote}` },
    { label: "Protein", value: `${Math.round(eatenProtein)}g / ${Math.round(totalProtein)}g`, sub: `eaten / planned today${missingNote}` },
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
    const { data: inserted, error } = await sb.from("daily_log")
      .insert({ log_date: planViewDate, log_time: nowTimeStr(), category: "Food & Drink", details: item.item })
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
  const input = form.querySelector("input[type=text]");
  const item = input.value.trim();
  if (!item) return;
  const slot = form.dataset.slot;
  const { error } = await sb.from("food_plan").insert({ log_date: planViewDate, time_of_day: slot, item });
  if (error) { alert("Failed to add: " + error.message); return; }
  input.value = "";
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
