// Personal settings drawer (opened from the gear next to Sign out).
// Values live in the `user_settings` table as key → jsonb, so they follow you across devices.

const DEFAULT_LOCATION = { name: "St. Louis, Missouri", lat: 38.627, lon: -90.199 };

let userSettings = {};          // { location: { name, lat, lon } }
let userSettingsPromise = null; // shared so callers can await the first load

function loadUserSettings() {
  if (!userSettingsPromise) {
    userSettingsPromise = sb.from("user_settings").select("key, value").then(({ data, error }) => {
      if (error) { console.warn("Failed to load settings", error); userSettingsPromise = null; return userSettings; }
      userSettings = Object.fromEntries((data || []).map((r) => [r.key, r.value]));
      return userSettings;
    });
  }
  return userSettingsPromise;
}

async function saveUserSetting(key, value) {
  const { error } = await sb.from("user_settings").upsert({ key, value, updated_at: new Date().toISOString() });
  if (error) throw error;
  userSettings[key] = value;
}

const weatherLocation = () => userSettings.location || DEFAULT_LOCATION;

// ---------- drawer ----------
function openSettingsDrawer() {
  loadUserSettings().then(renderSettingsLocation);
  document.getElementById("locationSearch").value = "";
  document.getElementById("locationResults").innerHTML = "";
  setLocationStatus("");
  document.getElementById("settingsDrawer").classList.add("open");
  document.getElementById("settingsBackdrop").classList.add("open");
}

function closeSettingsDrawer() {
  document.getElementById("settingsDrawer").classList.remove("open");
  document.getElementById("settingsBackdrop").classList.remove("open");
}

function renderSettingsLocation() {
  const loc = weatherLocation();
  document.getElementById("currentLocation").textContent =
    loc.name + (userSettings.location ? "" : " (default)");
}

function setLocationStatus(msg) {
  document.getElementById("locationStatus").textContent = msg;
}

async function setLocation(loc) {
  setLocationStatus("Saving…");
  try {
    await saveUserSetting("location", loc);
  } catch (err) {
    setLocationStatus("Couldn't save: " + err.message);
    return;
  }
  document.getElementById("locationResults").innerHTML = "";
  document.getElementById("locationSearch").value = "";
  setLocationStatus("Saved.");
  renderSettingsLocation();
  if (typeof refreshTodayWeather === "function") refreshTodayWeather();
}

const US_STATES = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut",
  DE: "Delaware", DC: "Washington, D.C.", FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois",
  IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland",
  MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana",
  NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York",
  NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania",
  RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah",
  VT: "Vermont", VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
};

let locationResults = [];

async function searchLocations(e) {
  e.preventDefault();
  const q = document.getElementById("locationSearch").value.trim();
  if (!q) return;
  setLocationStatus("Searching…");
  // Open-Meteo's geocoder matches on place name only, so search "Austin, TX" as "Austin"
  const name = q.split(",")[0].trim();
  try {
    const r = await fetch(`https://geocoding-api.open-meteo.com/v1/search?count=8&language=en&format=json&name=${encodeURIComponent(name)}`);
    const data = await r.json();
    locationResults = data.results || [];
  } catch (err) {
    setLocationStatus("Search failed: " + err.message);
    return;
  }
  // If they typed a state/country after the comma, float matching results to the top
  const hint = q.includes(",") ? q.split(",").slice(1).join(",").trim().toLowerCase() : "";
  if (hint) {
    const state = US_STATES[hint.toUpperCase()]?.toLowerCase();
    const matches = (res) => [res.admin1, res.country, res.country_code].some((v) =>
      v && (v.toLowerCase().startsWith(hint) || v.toLowerCase() === state));
    locationResults.sort((a, b) => matches(b) - matches(a));
  }
  setLocationStatus(locationResults.length ? "" : "No matches — try just the city name.");
  document.getElementById("locationResults").innerHTML = locationResults.map((res, i) => `
    <button type="button" class="location-result" data-i="${i}">
      ${escHtml(res.name)}<span class="muted">${escHtml([res.admin1, res.country].filter(Boolean).join(", "))}</span>
    </button>`).join("");
}

function useCurrentLocation() {
  if (!navigator.geolocation) { setLocationStatus("This browser can't share its location."); return; }
  setLocationStatus("Getting your location…");
  navigator.geolocation.getCurrentPosition(
    (pos) => setLocation({
      name: "Current location",
      lat: Math.round(pos.coords.latitude * 1000) / 1000,
      lon: Math.round(pos.coords.longitude * 1000) / 1000,
    }),
    (err) => setLocationStatus("Couldn't get location: " + err.message),
    { timeout: 10000 }
  );
}

document.getElementById("settingsBtn").addEventListener("click", openSettingsDrawer);
document.getElementById("settingsDrawerCloseBtn").addEventListener("click", closeSettingsDrawer);
document.getElementById("settingsBackdrop").addEventListener("click", closeSettingsDrawer);
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeSettingsDrawer(); });
document.getElementById("locationSearchForm").addEventListener("submit", searchLocations);
document.getElementById("useCurrentLocationBtn").addEventListener("click", useCurrentLocation);
document.getElementById("resetLocationBtn").addEventListener("click", async () => {
  setLocationStatus("Saving…");
  const { error } = await sb.from("user_settings").delete().eq("key", "location");
  if (error) { setLocationStatus("Couldn't reset: " + error.message); return; }
  delete userSettings.location;
  setLocationStatus("Reset to default.");
  renderSettingsLocation();
  if (typeof refreshTodayWeather === "function") refreshTodayWeather();
});
document.getElementById("locationResults").addEventListener("click", (e) => {
  const btn = e.target.closest(".location-result");
  if (!btn) return;
  const res = locationResults[Number(btn.dataset.i)];
  setLocation({
    name: [res.name, res.admin1 || res.country].filter(Boolean).join(", "),
    lat: res.latitude,
    lon: res.longitude,
  });
});
