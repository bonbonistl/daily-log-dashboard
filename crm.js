let crmLoadedOnce = false;
let people = []; // [{id, name, title, linkedin_url, instagram_url, email, phone, city, state, country, birthday, business_id, created_at}]
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

// ---------- people table ----------
function renderPeopleTable() {
  const bodyEl = document.getElementById("peopleTableBody");
  if (!people.length) {
    bodyEl.innerHTML = `<tr><td colspan="6" class="journal-empty">No people tracked yet — add one above.</td></tr>`;
    return;
  }

  bodyEl.innerHTML = people.map((p) => {
    const businessName = businessNameFor(p.business_id);
    const location = [p.city, p.state, p.country].filter(Boolean).join(", ");
    const links = [
      p.linkedin_url ? `<a class="job-careers-link" href="${p.linkedin_url}" target="_blank" rel="noopener noreferrer">LinkedIn</a>` : "",
      p.instagram_url ? `<a class="job-careers-link" href="${p.instagram_url}" target="_blank" rel="noopener noreferrer">Instagram</a>` : "",
    ].filter(Boolean).join(" · ");

    return `
      <tr data-person-id="${p.id}">
        <td>
          <button type="button" class="job-company-name-btn">${p.name}</button>
          ${p.title ? `<div class="job-table-sub">${p.title}</div>` : ""}
        </td>
        <td>${businessName ? businessName : `<span class="job-table-empty">—</span>`}</td>
        <td>${location || `<span class="job-table-empty">—</span>`}</td>
        <td>${p.birthday ? fmtShort(p.birthday) : `<span class="job-table-empty">—</span>`}</td>
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
    birthday: document.getElementById("personBirthday").value || null,
  };

  const { error } = await sb.from("people").update(update).eq("id", openPersonId);
  if (error) { alert("Failed to save contact details: " + error.message); return; }
  await loadCrmData();
});
