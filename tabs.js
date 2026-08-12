const healthTabBtn = document.getElementById("healthTabBtn");
const spiritualTabBtn = document.getElementById("spiritualTabBtn");
const healthApp = document.getElementById("app");
const spiritualApp = document.getElementById("spiritualApp");
const healthControls = document.getElementById("healthControls");

let spiritualLoaded = false;

function activateTab(tab) {
  const isHealth = tab === "health";
  healthTabBtn.classList.toggle("active", isHealth);
  spiritualTabBtn.classList.toggle("active", !isHealth);
  healthApp.classList.toggle("hidden", !isHealth);
  spiritualApp.classList.toggle("hidden", isHealth);
  healthControls.classList.toggle("hidden", !isHealth);

  if (!isHealth && !spiritualLoaded) {
    spiritualLoaded = true;
    loadSpiritualData();
  }
}

healthTabBtn.addEventListener("click", () => activateTab("health"));
spiritualTabBtn.addEventListener("click", () => activateTab("spiritual"));

// ---------- health sub-tabs ----------
const HEALTH_SUBTABS = [
  { key: "overview", btnId: "overviewSubtabBtn", contentId: "healthOverview" },
  { key: "exercise", btnId: "exerciseSubtabBtn", contentId: "healthExercise" },
  { key: "fasting", btnId: "fastingSubtabBtn", contentId: "healthFasting" },
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
