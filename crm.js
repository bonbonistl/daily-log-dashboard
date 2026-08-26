let crmLoadedOnce = false;
let people = []; // [{id, name, title, linkedin_url, instagram_url, email, phone, city, state, country, birthday, birthday_celebrated_year, business_id, created_at}] — birthday is free text (e.g. "8/24"), not a date column, since the year is often unknown
let crmBusinesses = []; // [{id, name}] — lightweight, just for the business select + display
let openPersonId = null; // id of the person currently shown in the side rail, or null if closed

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
  document.querySelectorAll(".job-company-name-btn").forEach((btn) => {
    btn.addEventListener("click", () => openPersonDrawer(btn.closest("[data-person-id]").dataset.personId));
  });
  document.querySelectorAll(".job-company-remove").forEach((btn) => {
    btn.addEventListener("click", () => removePerson(btn));
  });
  document.querySelectorAll(".celebrated-checkbox").forEach((checkbox) => {
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

async function removePerson(btn) {
  const personId = btn.closest("[data-person-id]").dataset.personId;
  const person = people.find((p) => String(p.id) === personId);
  if (!confirm(`Remove ${person.name}?`)) return;

  const { error } = await sb.from("people").delete().eq("id", personId);
  if (error) { alert("Failed to remove person: " + error.message); return; }
  if (String(openPersonId) === personId) closePersonDrawer();
  await loadCrmData();
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

  document.getElementById("personDrawer").classList.add("open");
  document.getElementById("personBackdrop").classList.add("open");
}

function closePersonDrawer() {
  openPersonId = null;
  document.getElementById("personDrawer").classList.remove("open");
  document.getElementById("personBackdrop").classList.remove("open");
}

document.getElementById("personDrawerCloseBtn").addEventListener("click", closePersonDrawer);
document.getElementById("personBackdrop").addEventListener("click", closePersonDrawer);
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && openPersonId != null) closePersonDrawer(); });

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
});
