const healthControls = document.getElementById("healthControls");

// ---------- top-level tabs ----------
const TOP_TABS = [
  { key: "health", btnId: "healthTabBtn", contentId: "app" },
  { key: "spiritual", btnId: "spiritualTabBtn", contentId: "spiritualApp" },
  { key: "insights", btnId: "insightsTabBtn", contentId: "insightsApp" },
  { key: "groceries", btnId: "groceriesTabBtn", contentId: "groceriesApp" },
];

let spiritualLoaded = false;
let insightsLoaded = false;
let groceriesLoaded = false;

function activateTab(key) {
  TOP_TABS.forEach((t) => {
    document.getElementById(t.btnId).classList.toggle("active", t.key === key);
    document.getElementById(t.contentId).classList.toggle("hidden", t.key !== key);
  });
  healthControls.classList.toggle("hidden", key !== "health");

  if (key === "spiritual" && !spiritualLoaded) {
    spiritualLoaded = true;
    loadSpiritualData();
  }
  if (key === "insights" && !insightsLoaded) {
    insightsLoaded = true;
    loadInsightsData();
  }
  if (key === "groceries" && !groceriesLoaded) {
    groceriesLoaded = true;
    loadGroceriesData();
  }
}

TOP_TABS.forEach((t) => {
  document.getElementById(t.btnId).addEventListener("click", () => activateTab(t.key));
});

// ---------- health sub-tabs ----------
const HEALTH_SUBTABS = [
  { key: "overview", btnId: "overviewSubtabBtn", contentId: "healthOverview" },
  { key: "exercise", btnId: "exerciseSubtabBtn", contentId: "healthExercise" },
  { key: "fasting", btnId: "fastingSubtabBtn", contentId: "healthFasting" },
  { key: "plan", btnId: "planSubtabBtn", contentId: "healthPlan" },
];

function activateHealthSubtab(key) {
  HEALTH_SUBTABS.forEach((t) => {
    document.getElementById(t.btnId).classList.toggle("active", t.key === key);
    document.getElementById(t.contentId).classList.toggle("hidden", t.key !== key);
  });
}

HEALTH_SUBTABS.forEach((t) => {
  document.getElementById(t.btnId).addEventListener("click", () => activateHealthSubtab(t.key));
});

// ---------- groceries sub-tabs ----------
const GROCERIES_SUBTABS = [
  { key: "cart", btnId: "cartSubtabBtn", contentId: "groceriesCart" },
  { key: "inventory", btnId: "inventorySubtabBtn", contentId: "groceriesInventory" },
];

function activateGroceriesSubtab(key) {
  GROCERIES_SUBTABS.forEach((t) => {
    document.getElementById(t.btnId).classList.toggle("active", t.key === key);
    document.getElementById(t.contentId).classList.toggle("hidden", t.key !== key);
  });
}

GROCERIES_SUBTABS.forEach((t) => {
  document.getElementById(t.btnId).addEventListener("click", () => activateGroceriesSubtab(t.key));
});
