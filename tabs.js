const healthControls = document.getElementById("healthControls");

// ---------- top-level tabs ----------
const TOP_TABS = [
  { key: "home", btnId: "homeTabBtn", contentId: "homeApp" },
  { key: "health", btnId: "healthTabBtn", contentId: "app" },
  { key: "spiritual", btnId: "spiritualTabBtn", contentId: "spiritualApp" },
  { key: "insights", btnId: "insightsTabBtn", contentId: "insightsApp" },
  { key: "groceries", btnId: "groceriesTabBtn", contentId: "groceriesApp" },
  { key: "businesses", btnId: "businessesTabBtn", contentId: "businessesApp" },
  { key: "crm", btnId: "crmTabBtn", contentId: "crmApp" },
  { key: "paper", btnId: "paperTabBtn", contentId: "paperApp" },
];

let homeLoaded = false;
let spiritualLoaded = false;
let insightsLoaded = false;
let groceriesLoaded = false;
let businessesLoaded = false;
let crmLoaded = false;
let paperLoaded = false;

// Which subtab is current within a top tab that has subtabs — tracked so the
// hash can be rebuilt (e.g. "#groceries/inventory") whenever either level changes.
let currentHealthSubtab = "overview";
let currentGroceriesSubtab = "inventory";
let currentHomeSubtab = "frametv";

function activateTab(key) {
  TOP_TABS.forEach((t) => {
    document.getElementById(t.btnId).classList.toggle("active", t.key === key);
    document.getElementById(t.contentId).classList.toggle("hidden", t.key !== key);
  });
  healthControls.classList.toggle("hidden", key !== "health");

  if (key === "home" && !homeLoaded) {
    homeLoaded = true;
    loadFrameTVData();
  }
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
  if (key === "businesses" && !businessesLoaded) {
    businessesLoaded = true;
    loadBusinessesData();
  }
  if (key === "crm" && !crmLoaded) {
    crmLoaded = true;
    loadCrmData();
  }
  if (key === "paper" && !paperLoaded) {
    paperLoaded = true;
    loadPaperData();
  }

  updateUrlHash();
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
  currentHealthSubtab = key;
  updateUrlHash();
}

HEALTH_SUBTABS.forEach((t) => {
  document.getElementById(t.btnId).addEventListener("click", () => activateHealthSubtab(t.key));
});

// ---------- groceries sub-tabs ----------
const GROCERIES_SUBTABS = [
  { key: "inventory", btnId: "inventorySubtabBtn", contentId: "groceriesInventory" },
  { key: "cart", btnId: "cartSubtabBtn", contentId: "groceriesCart" },
];

function activateGroceriesSubtab(key) {
  GROCERIES_SUBTABS.forEach((t) => {
    document.getElementById(t.btnId).classList.toggle("active", t.key === key);
    document.getElementById(t.contentId).classList.toggle("hidden", t.key !== key);
  });
  currentGroceriesSubtab = key;
  updateUrlHash();
}

GROCERIES_SUBTABS.forEach((t) => {
  document.getElementById(t.btnId).addEventListener("click", () => activateGroceriesSubtab(t.key));
});

// ---------- home sub-tabs ----------
const HOME_SUBTABS = [
  { key: "frametv", btnId: "frametvSubtabBtn", contentId: "homeFrameTV" },
];

function activateHomeSubtab(key) {
  HOME_SUBTABS.forEach((t) => {
    document.getElementById(t.btnId).classList.toggle("active", t.key === key);
    document.getElementById(t.contentId).classList.toggle("hidden", t.key !== key);
  });
  currentHomeSubtab = key;
  updateUrlHash();
}

HOME_SUBTABS.forEach((t) => {
  document.getElementById(t.btnId).addEventListener("click", () => activateHomeSubtab(t.key));
});

// ---------- URL routing ----------
// Hash-based (not the History API's pushState) since the app is served as a
// static file with no server-side route fallback — a real path like /crm
// would 404 on refresh, but a hash always resolves to the same index.html.
function updateUrlHash() {
  const activeTop = TOP_TABS.find((t) => document.getElementById(t.btnId).classList.contains("active"));
  if (!activeTop) return;
  const sub = activeTop.key === "health" ? currentHealthSubtab : activeTop.key === "groceries" ? currentGroceriesSubtab : activeTop.key === "home" ? currentHomeSubtab : null;
  const next = "#" + (sub ? `${activeTop.key}/${sub}` : activeTop.key);
  if (location.hash !== next) history.replaceState(null, "", next);
}

// Reads the current hash and activates the tab/subtab it names, falling back
// to Health/Overview for anything empty or unrecognized. Only called once
// signed in — calling it earlier would fire each tab's lazy data load before
// there's a session, permanently tripping its "already loaded" guard on the
// resulting error.
function applyRouteFromHash() {
  if (!window.isAuthed) return;

  const [topKey, subKey] = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);

  const validTop = TOP_TABS.some((t) => t.key === topKey) ? topKey : "health";
  activateTab(validTop);

  if (validTop === "health") {
    const validSub = HEALTH_SUBTABS.some((t) => t.key === subKey) ? subKey : "overview";
    activateHealthSubtab(validSub);
  } else if (validTop === "groceries") {
    const validSub = GROCERIES_SUBTABS.some((t) => t.key === subKey) ? subKey : "inventory";
    activateGroceriesSubtab(validSub);
  } else if (validTop === "home") {
    const validSub = HOME_SUBTABS.some((t) => t.key === subKey) ? subKey : "frametv";
    activateHomeSubtab(validSub);
  }
}

window.addEventListener("hashchange", applyRouteFromHash);
