let crmLoadedOnce = false;
let people = []; // [{id, name, title, linkedin_url, instagram_url, email, phone, city, state, country, birthday, birthday_celebrated_year, business_id, created_at}] — birthday is free text (e.g. "8/24"), not a date column, since the year is often unknown
let crmBusinesses = []; // [{id, name}] — lightweight, just for the business select + display
let openPersonId = null; // id of the person currently shown in the side rail, or null if closed
let personNotes = []; // [{id, person_id, note_date, body, created_at}] — for the currently open rail only
let personPrayers = []; // [{id, person_id, request, pray_on, answered_at, created_at}] — for the currently open rail only; answered_at null = still being prayed for

async function loadCrmData() {
  if (!crmLoadedOnce) {
    document.getElementById("crmLoading").classList.remove("hidden");
    document.getElementById("crmLoading").textContent = "Loading data…";
    document.getElementById("crmPanel").classList.add("hidden");
  }

  const fetchPromise = Promise.all([
    sb.from("people").select("*").order("name", { ascending: true }),
    sb.from("businesses").select("id, name").order("name", { ascending: true }),
  ]);

  let peopleRes, businessesRes;
  try {
    [peopleRes, businessesRes] = await withTimeout(fetchPromise, 15000, "Loading CRM data");
  } catch (e) {
    document.getElementById("crmLoading").textContent = e.message;
    document.getElementById("crmLoading").classList.remove("hidden");
    return;
  }

  const error = peopleRes.error || businessesRes.error;
  if (error) {
    document.getElementById("crmLoading").textContent = "Error loading data: " + error.message;
    document.getElementById("crmLoading").classList.remove("hidden");
    return;
  }

  people = peopleRes.data;
  crmBusinesses = businessesRes.data;

  document.getElementById("crmLoading").classList.add("hidden");
  document.getElementById("crmPanel").classList.remove("hidden");
  crmLoadedOnce = true;
  markUpdated("crmUpdatedAt");
  renderPeopleTable();
}

function businessSelectHtml(selectedId) {
  return [
    `<option value="">— none —</option>`,
    ...crmBusinesses.map((b) => `<option value="${b.id}" ${String(b.id) === String(selectedId) ? "selected" : ""}>${b.name}</option>`),
  ].join("");
}

function businessNameFor(businessId) {
  const b = crmBusinesses.find((biz) => biz.id === businessId);
  return b ? b.name : null;
}

// ---------- people table: sort + filter ----------
const PEOPLE_SORT_HEADERS = [
  { id: "peopleSortName", key: "name" },
  { id: "peopleSortBusiness", key: "business" },
  { id: "peopleSortLocation", key: "location" },
  { id: "peopleSortBirthday", key: "birthday" },
  { id: "peopleSortCelebrated", key: "celebrated" },
  { id: "peopleSortLinks", key: "links" },
];
let peopleSortKey = "name";
let peopleSortDir = 1;

// Empty values sort after real ones regardless of direction toggling, by
// pushing them past every real string ("￿" sorts after any normal text).
const NULLS_LAST = "￿";

function currentYear() {
  return Number(todayLocalStr().slice(0, 4));
}

function celebratedThisYear(p) {
  return p.birthday_celebrated_year === currentYear();
}

// Birthday is free text like "8/24" — sort by calendar order (month, then day),
// not as a string, or "10/5" would sort before "2/3". Unparseable/missing values sort last.
function birthdaySortValue(p) {
  const match = (p.birthday || "").match(/^(\d{1,2})\/(\d{1,2})/);
  if (!match) return 9999;
  const [, month, day] = match;
  return Number(month) * 100 + Number(day);
}

const PEOPLE_SORT_VALUE = {
  name: (p) => p.name.toLowerCase(),
  business: (p) => (businessNameFor(p.business_id) || NULLS_LAST).toLowerCase(),
  location: (p) => ([p.city, p.state, p.country].filter(Boolean).join(", ") || NULLS_LAST).toLowerCase(),
  birthday: birthdaySortValue,
  // Not-yet-celebrated first, then celebrated, then no-birthday-at-all last — surfaces who still needs a shoutout.
  celebrated: (p) => (!p.birthday ? 2 : celebratedThisYear(p) ? 1 : 0),
  links: (p) => (p.linkedin_url ? 1 : 0) + (p.instagram_url ? 1 : 0),
};

function getVisiblePeople() {
  const filterText = document.getElementById("peopleFilterInput").value.trim().toLowerCase();
  const notCelebratedOnly = document.getElementById("peopleNotCelebratedFilter").checked;

  const filtered = people.filter((p) => {
    if (notCelebratedOnly && (!p.birthday || celebratedThisYear(p))) return false;
    if (!filterText) return true;
    const businessName = businessNameFor(p.business_id) || "";
    const location = [p.city, p.state, p.country].filter(Boolean).join(", ");
    const haystack = `${p.name} ${businessName} ${p.title || ""} ${location}`.toLowerCase();
    return haystack.includes(filterText);
  });

  const valueFn = PEOPLE_SORT_VALUE[peopleSortKey];
  return filtered.sort((a, b) => {
    const av = valueFn(a);
    const bv = valueFn(b);
    if (av < bv) return -1 * peopleSortDir;
    if (av > bv) return peopleSortDir;
    return a.name.localeCompare(b.name);
  });
}

function updatePeopleSortIndicators() {
  PEOPLE_SORT_HEADERS.forEach(({ id, key }) => {
    document.getElementById(id + "Indicator").textContent =
      key === peopleSortKey ? (peopleSortDir === 1 ? " ▲" : " ▼") : "";
  });
}

PEOPLE_SORT_HEADERS.forEach(({ id, key }) => {
  document.getElementById(id).addEventListener("click", () => {
    if (peopleSortKey === key) { peopleSortDir *= -1; } else { peopleSortKey = key; peopleSortDir = 1; }
    renderPeopleTable();
  });
});

document.getElementById("peopleFilterInput").addEventListener("input", () => renderPeopleTable());
document.getElementById("peopleNotCelebratedFilter").addEventListener("change", () => renderPeopleTable());

// ---------- people table ----------
function renderPeopleTable() {
  const bodyEl = document.getElementById("peopleTableBody");
  updatePeopleSortIndicators();

  if (!people.length) {
    bodyEl.innerHTML = `<tr><td colspan="7" class="journal-empty">No people tracked yet — add one above.</td></tr>`;
    return;
  }

  const visible = getVisiblePeople();
  if (!visible.length) {
    bodyEl.innerHTML = `<tr><td colspan="7" class="journal-empty">No people match your filter.</td></tr>`;
    return;
  }

  bodyEl.innerHTML = visible.map((p) => {
    const businessName = businessNameFor(p.business_id);
    const location = [p.city, p.state, p.country].filter(Boolean).join(", ");
    const links = [
      p.linkedin_url ? `<a class="job-careers-link" href="${p.linkedin_url}" target="_blank" rel="noopener noreferrer">LinkedIn</a>` : "",
      p.instagram_url ? `<a class="job-careers-link" href="${p.instagram_url}" target="_blank" rel="noopener noreferrer">Instagram</a>` : "",
    ].filter(Boolean).join(" · ");
    const celebratedCell = p.birthday
      ? `<input type="checkbox" class="celebrated-checkbox" title="Celebrated their ${currentYear()} birthday" ${celebratedThisYear(p) ? "checked" : ""} />`
      : `<span class="job-table-empty">—</span>`;

    return `
      <tr data-person-id="${p.id}">
        <td>
          <button type="button" class="job-company-name-btn">${p.name}</button>
          ${p.title ? `<div class="job-table-sub">${p.title}</div>` : ""}
        </td>
        <td>${businessName ? businessName : `<span class="job-table-empty">—</span>`}</td>
        <td>${location || `<span class="job-table-empty">—</span>`}</td>
        <td>${p.birthday || `<span class="job-table-empty">—</span>`}</td>
        <td class="job-table-pmf">${celebratedCell}</td>
        <td>${links || `<span class="job-table-empty">—</span>`}</td>
        <td class="job-table-actions"><button type="button" class="job-company-remove" title="Remove person">&times;</button></td>
      </tr>
    `;
  }).join("");

  bindPeopleRowEvents();
}

function bindPeopleRowEvents() {
  document.querySelectorAll("#peopleTableBody .job-company-name-btn").forEach((btn) => {
    btn.addEventListener("click", () => openPersonDrawer(btn.closest("[data-person-id]").dataset.personId));
  });
  document.querySelectorAll("#peopleTableBody .job-company-remove").forEach((btn) => {
    btn.addEventListener("click", () => removePerson(btn.closest("[data-person-id]").dataset.personId));
  });
  document.querySelectorAll("#peopleTableBody .celebrated-checkbox").forEach((checkbox) => {
    checkbox.addEventListener("change", () => updateCelebrated(checkbox));
  });
}

async function updateCelebrated(checkbox) {
  if (checkbox.dataset.busy) return;
  checkbox.dataset.busy = "1";
  checkbox.disabled = true;

  const personId = checkbox.closest("[data-person-id]").dataset.personId;
  const newYear = checkbox.checked ? currentYear() : null;
  const { error } = await sb.from("people").update({ birthday_celebrated_year: newYear }).eq("id", personId);
  if (error) {
    alert("Failed to update: " + error.message);
    checkbox.checked = !checkbox.checked;
  } else {
    const person = people.find((p) => String(p.id) === personId);
    if (person) person.birthday_celebrated_year = newYear;
  }

  checkbox.disabled = false;
  delete checkbox.dataset.busy;
}

// ---------- add / remove ----------
document.getElementById("addPersonForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const nameInput = document.getElementById("newPersonName");
  const name = nameInput.value.trim();
  if (!name) return;

  const { error } = await sb.from("people").insert({ name });
  if (error) { alert("Failed to add person: " + error.message); return; }

  nameInput.value = "";
  await loadCrmData();
});

async function removePerson(personId) {
  personId = String(personId);
  const person = people.find((p) => String(p.id) === personId);
  if (!confirm(`Remove ${person.name}?`)) return;

  const { error } = await sb.from("people").delete().eq("id", personId);
  if (error) { alert("Failed to remove person: " + error.message); return; }
  if (String(openPersonId) === personId) closePersonDrawer();
  await loadCrmData();
  // Drop their contact badge from the Businesses subtab too.
  if (typeof loadBusinessesData === "function") loadBusinessesData();
  if (typeof todayLoadedOnce !== "undefined" && todayLoadedOnce) loadTodayData();
}

// ---------- person detail rail ----------
function openPersonDrawer(personId) {
  const person = people.find((p) => String(p.id) === String(personId));
  if (!person) return;
  openPersonId = person.id;

  document.getElementById("personDrawerTitle").textContent = person.name;
  document.getElementById("personBusiness").innerHTML = businessSelectHtml(person.business_id);
  document.getElementById("personTitle").value = person.title || "";
  document.getElementById("personLinkedin").value = person.linkedin_url || "";
  document.getElementById("personInstagram").value = person.instagram_url || "";
  document.getElementById("personEmail").value = person.email || "";
  document.getElementById("personPhone").value = person.phone || "";
  document.getElementById("personCity").value = person.city || "";
  document.getElementById("personState").value = person.state || "";
  document.getElementById("personCountry").value = person.country || "";
  document.getElementById("personBirthday").value = person.birthday || "";

  personNotes = [];
  personPrayers = [];
  document.getElementById("personNotesList").innerHTML = `<div class="journal-empty">Loading…</div>`;
  document.getElementById("personPrayerList").innerHTML = "";
  document.getElementById("personNoteText").value = "";
  document.getElementById("personNoteDate").value = todayLocalStr();
  document.getElementById("personPrayerText").value = "";
  document.getElementById("personPrayerDate").value = "";
  document.getElementById("personPrayerDate").min = todayLocalStr();
  loadPersonHistory(person.id);

  document.getElementById("personDrawer").classList.add("open");
  document.getElementById("personBackdrop").classList.add("open");
}

function closePersonDrawer() {
  openPersonId = null;
  personNotes = [];
  personPrayers = [];
  document.getElementById("personDrawer").classList.remove("open");
  document.getElementById("personBackdrop").classList.remove("open");
}

document.getElementById("personDrawerCloseBtn").addEventListener("click", closePersonDrawer);
document.getElementById("personBackdrop").addEventListener("click", closePersonDrawer);
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && openPersonId != null) closePersonDrawer(); });

document.getElementById("personRemoveBtn").addEventListener("click", () => {
  if (openPersonId != null) removePerson(openPersonId);
});

document.getElementById("personDetailsForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (openPersonId == null) return;

  const update = {
    business_id: document.getElementById("personBusiness").value || null,
    title: document.getElementById("personTitle").value.trim() || null,
    linkedin_url: document.getElementById("personLinkedin").value.trim() || null,
    instagram_url: document.getElementById("personInstagram").value.trim() || null,
    email: document.getElementById("personEmail").value.trim() || null,
    phone: document.getElementById("personPhone").value.trim() || null,
    city: document.getElementById("personCity").value.trim() || null,
    state: document.getElementById("personState").value.trim() || null,
    country: document.getElementById("personCountry").value.trim() || null,
    birthday: document.getElementById("personBirthday").value.trim() || null,
  };

  const { error } = await sb.from("people").update(update).eq("id", openPersonId);
  if (error) { alert("Failed to save contact details: " + error.message); return; }
  await loadCrmData();
  // The rail can be opened from the Today dashboard's birthdays — keep that in sync.
  if (typeof todayLoadedOnce !== "undefined" && todayLoadedOnce) loadTodayData();
});

// ---------- person notes + prayer requests (per-person history in the rail) ----------

const escCrm = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// "Oct 5" this year, "Oct 5, 2025" otherwise — notes are a long-running log.
function fmtCrmDate(dateStr) {
  const d = new Date(dateStr + "T00:00:00");
  const opts = { month: "short", day: "numeric" };
  if (d.getFullYear() !== currentYear()) opts.year = "numeric";
  return d.toLocaleDateString(undefined, opts);
}

function refreshTodayIfLoaded() {
  if (typeof todayLoadedOnce !== "undefined" && todayLoadedOnce) loadTodayData();
}

async function loadPersonHistory(personId) {
  const [notesRes, prayersRes] = await Promise.all([
    sb.from("person_notes").select("*").eq("person_id", personId)
      .order("note_date", { ascending: false }).order("created_at", { ascending: false }),
    sb.from("prayer_requests").select("*").eq("person_id", personId).order("pray_on", { ascending: true }),
  ]);
  if (String(openPersonId) !== String(personId)) return; // rail moved on while loading
  const error = notesRes.error || prayersRes.error;
  if (error) {
    document.getElementById("personNotesList").innerHTML = `<div class="journal-empty">Error loading: ${escCrm(error.message)}</div>`;
    return;
  }
  personNotes = notesRes.data;
  personPrayers = prayersRes.data;
  renderPersonNotes();
  renderPersonPrayers();
}

function renderPersonNotes() {
  const el = document.getElementById("personNotesList");
  el.innerHTML = personNotes.length
    ? `<ul class="person-history">${personNotes.map((n) => `
        <li data-id="${n.id}">
          <div class="person-history-head">
            <span class="person-history-date">${fmtCrmDate(n.note_date)}</span>
            <button type="button" class="plan-item-remove person-note-remove" title="Delete note">&times;</button>
          </div>
          <div class="person-history-body">${escCrm(n.body)}</div>
        </li>`).join("")}</ul>`
    : `<div class="journal-empty">No notes yet.</div>`;
  el.querySelectorAll(".person-note-remove").forEach((btn) => {
    btn.addEventListener("click", () => removePersonNote(btn.closest("[data-id]").dataset.id));
  });
}

function renderPersonPrayers() {
  const el = document.getElementById("personPrayerList");
  const todayStr = todayLocalStr();
  // Open requests by date first, then answered ones (most recently answered first).
  const open = personPrayers.filter((r) => !r.answered_at);
  const answered = personPrayers.filter((r) => r.answered_at).sort((a, b) => b.answered_at.localeCompare(a.answered_at));
  const itemHtml = (r) => `
    <li data-id="${r.id}" class="${r.answered_at ? "done" : ""} ${!r.answered_at && r.pray_on <= todayStr ? "due" : ""}">
      <div class="person-history-head">
        <label class="person-prayer-check">
          <input type="checkbox" ${r.answered_at ? "checked" : ""} title="Mark as answered" />
          <span class="person-history-date">${fmtCrmDate(r.pray_on)}${r.answered_at ? ` · answered ${fmtCrmDate(toLocalDateStr(new Date(r.answered_at)))}` : ""}</span>
        </label>
        <button type="button" class="plan-item-remove person-prayer-remove" title="Delete request">&times;</button>
      </div>
      <div class="person-history-body">${escCrm(r.request)}</div>
    </li>`;
  el.innerHTML = personPrayers.length
    ? `<ul class="person-history">${[...open, ...answered].map(itemHtml).join("")}</ul>`
    : `<div class="journal-empty">No prayer requests yet.</div>`;
  el.querySelectorAll(".person-prayer-check input").forEach((cb) => {
    cb.addEventListener("change", () => setPrayerAnswered(cb.closest("[data-id]").dataset.id, cb.checked));
  });
  el.querySelectorAll(".person-prayer-remove").forEach((btn) => {
    btn.addEventListener("click", () => removePrayerRequest(btn.closest("[data-id]").dataset.id));
  });
}

document.getElementById("personNoteForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (openPersonId == null) return;
  const body = document.getElementById("personNoteText").value.trim();
  const note_date = document.getElementById("personNoteDate").value;
  if (!body || !note_date) return;
  const { error } = await sb.from("person_notes").insert({ person_id: openPersonId, body, note_date });
  if (error) { alert("Failed to add note: " + error.message); return; }
  document.getElementById("personNoteText").value = "";
  document.getElementById("personNoteDate").value = todayLocalStr();
  await loadPersonHistory(openPersonId);
});

document.getElementById("personPrayerForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (openPersonId == null) return;
  const request = document.getElementById("personPrayerText").value.trim();
  const pray_on = document.getElementById("personPrayerDate").value;
  if (!request || !pray_on) return;
  const { error } = await sb.from("prayer_requests").insert({ person_id: openPersonId, request, pray_on });
  if (error) { alert("Failed to add prayer request: " + error.message); return; }
  document.getElementById("personPrayerText").value = "";
  document.getElementById("personPrayerDate").value = "";
  await loadPersonHistory(openPersonId);
  refreshTodayIfLoaded();
});

async function removePersonNote(noteId) {
  if (!confirm("Delete this note?")) return;
  const { error } = await sb.from("person_notes").delete().eq("id", noteId);
  if (error) { alert("Failed to delete note: " + error.message); return; }
  await loadPersonHistory(openPersonId);
}

async function removePrayerRequest(requestId) {
  if (!confirm("Delete this prayer request?")) return;
  const { error } = await sb.from("prayer_requests").delete().eq("id", requestId);
  if (error) { alert("Failed to delete prayer request: " + error.message); return; }
  await loadPersonHistory(openPersonId);
  refreshTodayIfLoaded();
}

// Shared with the Today dashboard's prayer list.
async function setPrayerAnswered(requestId, answered) {
  const { error } = await sb.from("prayer_requests")
    .update({ answered_at: answered ? new Date().toISOString() : null }).eq("id", requestId);
  if (error) { alert("Failed to update: " + error.message); return error; }
  if (openPersonId != null) await loadPersonHistory(openPersonId);
  refreshTodayIfLoaded();
  return null;
}
