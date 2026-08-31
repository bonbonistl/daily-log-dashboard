let businessesLoadedOnce = false;
let businesses = []; // [{id, name, careers_url, notes, created_at}]
let jobOpenings = []; // [{id, business_id, title, url, posted_date, status, applied_date, status_changed_at, notes, created_at}]
let businessPeople = []; // [{id, name, title, business_id}] — the full CRM roster, used for the table's Contacts column and the rail's link/add-contact controls
let businessCareersChecks = []; // [{id, business_id, checked_at}] — history of "I checked the careers page" clicks, for the currently open drawer only
let openBusinessId = null; // id of the business currently shown in the side rail, or null if closed
let openOpeningId = null; // id of the job opening currently shown in its own side rail, or null if closed

const JOB_STATUSES = [
  { key: "watching", label: "Watching" },
  { key: "applied", label: "Applied" },
  { key: "heard_back", label: "Heard Back" },
  { key: "interviewing", label: "Interviewing" },
  { key: "offered", label: "Offered" },
  { key: "declined", label: "Declined" },
  { key: "auto_declined", label: "Auto-Declined" },
];
const JOB_STATUS_LABELS = Object.fromEntries(JOB_STATUSES.map((s) => [s.key, s.label]));

const escAttr = (s) => (s || "").replace(/"/g, "&quot;");

async function loadBusinessesData() {
  if (!businessesLoadedOnce) {
    document.getElementById("businessesLoading").classList.remove("hidden");
    document.getElementById("businessesLoading").textContent = "Loading data…";
    document.getElementById("businessesPanel").classList.add("hidden");
  }

  const fetchPromise = Promise.all([
    sb.from("businesses").select("*").order("name", { ascending: true }),
    sb.from("job_openings").select("*").order("created_at", { ascending: false }),
    sb.from("people").select("id, name, title, business_id").order("name", { ascending: true }),
  ]);

  let businessesRes, openingsRes, peopleRes;
  try {
    [businessesRes, openingsRes, peopleRes] = await withTimeout(fetchPromise, 15000, "Loading business data");
  } catch (e) {
    document.getElementById("businessesLoading").textContent = e.message;
    document.getElementById("businessesLoading").classList.remove("hidden");
    return;
  }

  const error = businessesRes.error || openingsRes.error || peopleRes.error;
  if (error) {
    document.getElementById("businessesLoading").textContent = "Error loading data: " + error.message;
    document.getElementById("businessesLoading").classList.remove("hidden");
    return;
  }

  businesses = businessesRes.data;
  jobOpenings = openingsRes.data;
  businessPeople = peopleRes.data;

  document.getElementById("businessesLoading").classList.add("hidden");
  document.getElementById("businessesPanel").classList.remove("hidden");
  businessesLoadedOnce = true;
  markUpdated("businessesUpdatedAt");
  renderBusinessesTab();
}

function renderBusinessesTab() {
  renderBusinessesCards();
  renderBusinessesTable();
}

// null = no funnel filter (Companies), otherwise "tracked" or a JOB_STATUSES key
let businessFunnelFilter = null;

const FUNNEL_FILTER_LABELS = {
  tracked: "Tracked",
  applied: "Applied",
  heard_back: "Heard Back",
  interviewing: "Interviewed",
  offered: "Offers",
};

function renderBusinessesCards() {
  const countByStatus = (key) => jobOpenings.filter((o) => o.status === key).length;
  const applied = countByStatus("applied");
  const heardBack = countByStatus("heard_back");
  const interviewing = countByStatus("interviewing");
  const offered = countByStatus("offered");

  document.getElementById("businessesCards").innerHTML = [
    { label: "Companies", value: `${businesses.length}`, sub: "tracked", funnel: null },
    { label: "Tracked", value: `${jobOpenings.length}`, sub: "opening(s)", funnel: "tracked" },
    { label: "Applied", value: `${applied}`, sub: applied ? "in progress" : "none yet", funnel: "applied" },
    { label: "Heard Back", value: `${heardBack}`, sub: heardBack ? "awaiting next step" : "none yet", funnel: "heard_back" },
    { label: "Interviewed", value: `${interviewing}`, sub: interviewing ? "in progress" : "none right now", funnel: "interviewing" },
    { label: "Offers", value: `${offered}`, sub: offered ? "awaiting decision" : "none right now", funnel: "offered" },
  ].map((c) => `
    <button type="button" class="card card-clickable ${businessFunnelFilter === c.funnel ? "card-active" : ""}" data-funnel="${c.funnel || ""}">
      <div class="label">${c.label}</div>
      <div class="value">${c.value}</div>
      <div class="sub">${c.sub}</div>
    </button>
  `).join("");

  document.querySelectorAll("#businessesCards .card-clickable").forEach((btn) => {
    btn.addEventListener("click", () => {
      const funnel = btn.dataset.funnel || null;
      businessFunnelFilter = businessFunnelFilter === funnel ? null : funnel;
      renderBusinessesCards();
      renderBusinessesTable();
    });
  });
}

function jobStatusSelectHtml(selected) {
  return JOB_STATUSES.map((s) => `<option value="${s.key}" ${s.key === selected ? "selected" : ""}>${s.label}</option>`).join("");
}

// ---------- businesses table: sort + filter ----------
const BUSINESS_SORT_HEADERS = [
  { id: "businessSortName", key: "name" },
  { id: "businessSortPmf", key: "pmf" },
  { id: "businessSortContacts", key: "contacts" },
  { id: "businessSortCareers", key: "careers" },
  { id: "businessSortOpenings", key: "openings" },
];
let businessSortKey = "name";
let businessSortDir = 1;

const BUSINESS_SORT_VALUE = {
  name: (b) => b.name.toLowerCase(),
  pmf: (b) => (b.pmf ? 1 : 0),
  contacts: (b) => businessPeople.filter((p) => p.business_id === b.id).length,
  careers: (b) => (b.careers_url ? 1 : 0),
  openings: (b) => jobOpenings.filter((o) => o.business_id === b.id).length,
};

function getVisibleBusinesses() {
  const filterText = document.getElementById("businessFilterInput").value.trim().toLowerCase();
  const pmfOnly = document.getElementById("businessPmfOnlyFilter").checked;

  const filtered = businesses.filter((b) => {
    if (pmfOnly && !b.pmf) return false;
    if (businessFunnelFilter) {
      const bizOpenings = jobOpenings.filter((o) => o.business_id === b.id);
      const inStage = businessFunnelFilter === "tracked"
        ? bizOpenings.length > 0
        : bizOpenings.some((o) => o.status === businessFunnelFilter);
      if (!inStage) return false;
    }
    if (!filterText) return true;
    const contactNames = businessPeople.filter((p) => p.business_id === b.id).map((p) => p.name).join(" ");
    const haystack = `${b.name} ${contactNames} ${b.careers_url || ""} ${b.notes || ""}`.toLowerCase();
    return haystack.includes(filterText);
  });

  const valueFn = BUSINESS_SORT_VALUE[businessSortKey];
  return filtered.sort((a, b) => {
    const av = valueFn(a);
    const bv = valueFn(b);
    if (av < bv) return -1 * businessSortDir;
    if (av > bv) return businessSortDir;
    return a.name.localeCompare(b.name);
  });
}

function updateBusinessSortIndicators() {
  BUSINESS_SORT_HEADERS.forEach(({ id, key }) => {
    document.getElementById(id + "Indicator").textContent =
      key === businessSortKey ? (businessSortDir === 1 ? " ▲" : " ▼") : "";
  });
}

BUSINESS_SORT_HEADERS.forEach(({ id, key }) => {
  document.getElementById(id).addEventListener("click", () => {
    if (businessSortKey === key) { businessSortDir *= -1; } else { businessSortKey = key; businessSortDir = 1; }
    renderBusinessesTable();
  });
});

document.getElementById("businessFilterInput").addEventListener("input", () => renderBusinessesTable());
document.getElementById("businessPmfOnlyFilter").addEventListener("change", () => renderBusinessesTable());

document.getElementById("businessFunnelFilterBadge").addEventListener("click", () => {
  businessFunnelFilter = null;
  renderBusinessesCards();
  renderBusinessesTable();
});

function updateFunnelFilterBadge() {
  const badge = document.getElementById("businessFunnelFilterBadge");
  if (!businessFunnelFilter) {
    badge.classList.add("hidden");
    return;
  }
  badge.textContent = `${FUNNEL_FILTER_LABELS[businessFunnelFilter]} ✕`;
  badge.classList.remove("hidden");
}

// ---------- businesses table ----------
function renderBusinessesTable() {
  const bodyEl = document.getElementById("businessesTableBody");
  updateBusinessSortIndicators();
  updateFunnelFilterBadge();

  if (!businesses.length) {
    bodyEl.innerHTML = `<tr><td colspan="6" class="journal-empty">No businesses tracked yet — add one above.</td></tr>`;
    return;
  }

  const visible = getVisibleBusinesses();
  if (!visible.length) {
    bodyEl.innerHTML = `<tr><td colspan="6" class="journal-empty">No businesses match your filter.</td></tr>`;
    return;
  }

  bodyEl.innerHTML = visible.map((b) => {
    const openings = jobOpenings.filter((o) => o.business_id === b.id);
    const contacts = businessPeople.filter((p) => p.business_id === b.id);

    const contactsCell = contacts.length
      ? contacts.map((p) => `<span class="job-connection-badge">🤝 ${p.name}${p.title ? ` <span class="job-connection-title">— ${p.title}</span>` : ""}</span>`).join(" ")
      : `<span class="job-table-empty">—</span>`;

    const careersCell = b.careers_url
      ? `<a class="job-careers-link" href="${b.careers_url}" target="_blank" rel="noopener noreferrer">Careers ↗</a>`
      : `<span class="job-table-empty">—</span>`;

    return `
      <tr data-business-id="${b.id}">
        <td><button type="button" class="job-company-name-btn">${b.name}</button></td>
        <td class="job-table-pmf"><input type="checkbox" class="pmf-checkbox" title="Product Market Fit — you'd be a good fit there" ${b.pmf ? "checked" : ""} /></td>
        <td>${contactsCell}</td>
        <td>${careersCell}</td>
        <td>
          <div class="job-openings-list">
            ${openings.length ? openings.map((o) => renderJobOpening(o)).join("") : `<span class="job-table-empty">No openings yet</span>`}
          </div>
          <form class="add-opening-form" data-business-id="${b.id}">
            <input type="text" class="new-opening-title" placeholder="Job title" maxlength="200" required />
            <input type="url" class="new-opening-url" placeholder="URL (optional)" maxlength="500" />
            <input type="date" class="new-opening-posted" title="Date it went live" />
            <button type="submit">Add Opening</button>
          </form>
        </td>
        <td class="job-table-actions"><button type="button" class="job-company-remove" title="Remove business">&times;</button></td>
      </tr>
    `;
  }).join("");

  bindBusinessRowEvents();
}

function renderJobOpening(o) {
  const metaParts = [];
  if (o.posted_date) metaParts.push(`posted ${fmtShort(o.posted_date)}`);
  if (o.applied_date) metaParts.push(`applied ${fmtShort(o.applied_date)}`);
  metaParts.push(`updated ${fmtShort(o.status_changed_at.slice(0, 10))}`);

  return `
    <div class="job-opening" data-opening-id="${o.id}">
      <div class="job-opening-main">
        <button type="button" class="job-opening-title-btn">${o.title}</button>
        ${o.url ? `<a class="job-opening-url-link" href="${o.url}" target="_blank" rel="noopener noreferrer" title="Open posting">↗</a>` : ""}
        <span class="job-status-badge status-${o.status}">${JOB_STATUS_LABELS[o.status]}</span>
      </div>
      <div class="job-opening-meta">${metaParts.join(" · ")}</div>
      <div class="job-opening-controls">
        <label class="job-reached-out-label" title="I reached out to a contact about this opportunity">
          <input type="checkbox" class="reached-out-checkbox" ${o.reached_out ? "checked" : ""} /> Reached out
        </label>
        <select class="job-status-select">${jobStatusSelectHtml(o.status)}</select>
        <button type="button" class="job-opening-remove" title="Remove opening">&times;</button>
      </div>
    </div>
  `;
}

function bindBusinessRowEvents() {
  document.querySelectorAll(".job-company-name-btn").forEach((btn) => {
    btn.addEventListener("click", () => openBusinessDrawer(btn.closest("[data-business-id]").dataset.businessId));
  });
  document.querySelectorAll(".job-company-remove").forEach((btn) => {
    btn.addEventListener("click", () => removeBusiness(btn));
  });
  document.querySelectorAll(".pmf-checkbox").forEach((checkbox) => {
    checkbox.addEventListener("change", () => updatePmf(checkbox));
  });
  document.querySelectorAll(".add-opening-form").forEach((form) => {
    form.addEventListener("submit", (e) => addJobOpening(e, form));
  });
  document.querySelectorAll(".job-status-select").forEach((select) => {
    select.addEventListener("change", () => updateJobOpeningStatus(select));
  });
  document.querySelectorAll(".reached-out-checkbox").forEach((checkbox) => {
    checkbox.addEventListener("change", () => updateReachedOut(checkbox));
  });
  document.querySelectorAll(".job-opening-remove").forEach((btn) => {
    btn.addEventListener("click", () => removeJobOpening(btn.closest("[data-opening-id]").dataset.openingId));
  });
  document.querySelectorAll(".job-opening-title-btn").forEach((btn) => {
    btn.addEventListener("click", () => openOpeningDrawer(btn.closest("[data-opening-id]").dataset.openingId));
  });
}

// ---------- businesses ----------
document.getElementById("addBusinessForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const nameInput = document.getElementById("newBusinessName");
  const name = nameInput.value.trim();
  if (!name) return;

  const { error } = await sb.from("businesses").insert({ name });
  if (error) { alert("Failed to add business: " + error.message); return; }

  nameInput.value = "";
  await loadBusinessesData();
});

async function removeBusiness(btn) {
  const businessId = btn.closest("[data-business-id]").dataset.businessId;
  const business = businesses.find((b) => String(b.id) === businessId);
  const openingCount = jobOpenings.filter((o) => String(o.business_id) === businessId).length;
  const linkedContacts = businessPeople.filter((p) => String(p.business_id) === businessId);

  const warning = openingCount ? ` This will also remove ${openingCount} opening(s).` : "";
  if (!confirm(`Remove ${business.name}?${warning}`)) return;

  let deleteContactsToo = false;
  if (linkedContacts.length) {
    const names = linkedContacts.map((p) => p.name).join(", ");
    deleteContactsToo = confirm(
      `${business.name} has ${linkedContacts.length} contact(s) linked: ${names}.\n\n` +
      `Click OK to delete them from your CRM too, or Cancel to keep them — just unlinked from this business.`
    );
  }

  if (deleteContactsToo) {
    const { error: peopleError } = await sb.from("people").delete().in("id", linkedContacts.map((p) => p.id));
    if (peopleError) { alert("Failed to delete contacts: " + peopleError.message); return; }
  }

  const { error } = await sb.from("businesses").delete().eq("id", businessId);
  if (error) { alert("Failed to remove business: " + error.message); return; }
  if (String(openBusinessId) === businessId) closeBusinessDrawer();
  await loadBusinessesData();
}

async function updatePmf(checkbox) {
  if (checkbox.dataset.busy) return;
  checkbox.dataset.busy = "1";
  checkbox.disabled = true;

  const businessId = checkbox.closest("[data-business-id]").dataset.businessId;
  const { error } = await sb.from("businesses").update({ pmf: checkbox.checked }).eq("id", businessId);
  if (error) {
    alert("Failed to update PMF: " + error.message);
    checkbox.checked = !checkbox.checked;
  } else {
    const business = businesses.find((b) => String(b.id) === businessId);
    if (business) business.pmf = checkbox.checked;
  }

  checkbox.disabled = false;
  delete checkbox.dataset.busy;
}

// ---------- openings ----------
async function addJobOpening(e, form) {
  e.preventDefault();
  const businessId = form.dataset.businessId;
  const titleInput = form.querySelector(".new-opening-title");
  const urlInput = form.querySelector(".new-opening-url");
  const postedInput = form.querySelector(".new-opening-posted");
  const title = titleInput.value.trim();
  if (!title) return;

  const { error } = await sb.from("job_openings").insert({
    business_id: businessId,
    title,
    url: urlInput.value.trim() || null,
    posted_date: postedInput.value || null,
  });
  if (error) { alert("Failed to add opening: " + error.message); return; }
  await loadBusinessesData();
}

async function updateJobOpeningStatus(select) {
  if (select.dataset.busy) return;
  select.dataset.busy = "1";
  select.disabled = true;

  const openingId = select.closest("[data-opening-id]").dataset.openingId;
  const opening = jobOpenings.find((o) => String(o.id) === openingId);
  const newStatus = select.value;

  const update = { status: newStatus, status_changed_at: new Date().toISOString() };
  // Applying is the one transition worth dating automatically — saves a manual date entry.
  if (newStatus === "applied" && !opening.applied_date) {
    update.applied_date = todayLocalStr();
  }

  const { error } = await sb.from("job_openings").update(update).eq("id", openingId);
  if (error) { alert("Failed to update status: " + error.message); select.disabled = false; delete select.dataset.busy; return; }
  await loadBusinessesData();
}

async function updateReachedOut(checkbox) {
  if (checkbox.dataset.busy) return;
  checkbox.dataset.busy = "1";
  checkbox.disabled = true;

  const openingId = checkbox.closest("[data-opening-id]").dataset.openingId;
  const { error } = await sb.from("job_openings").update({ reached_out: checkbox.checked }).eq("id", openingId);
  if (error) {
    alert("Failed to update: " + error.message);
    checkbox.checked = !checkbox.checked;
  } else {
    const opening = jobOpenings.find((o) => String(o.id) === openingId);
    if (opening) opening.reached_out = checkbox.checked;
  }

  checkbox.disabled = false;
  delete checkbox.dataset.busy;
}

async function removeJobOpening(openingId) {
  const opening = jobOpenings.find((o) => String(o.id) === String(openingId));
  if (!confirm(`Remove opening "${opening.title}"?`)) return;

  const { error } = await sb.from("job_openings").delete().eq("id", openingId);
  if (error) { alert("Failed to remove opening: " + error.message); return; }
  if (String(openOpeningId) === String(openingId)) closeOpeningDrawer();
  await loadBusinessesData();
}

// ---------- business detail rail ----------
function openBusinessDrawer(businessId) {
  const business = businesses.find((b) => String(b.id) === String(businessId));
  if (!business) return;
  openBusinessId = business.id;

  document.getElementById("businessDrawerTitle").textContent = business.name;
  document.getElementById("businessCareersUrl").value = business.careers_url || "";
  document.getElementById("businessGeneralNotes").value = business.notes || "";

  renderBusinessContacts();
  loadBusinessCareersChecks();

  document.getElementById("businessDrawer").classList.add("open");
  document.getElementById("businessBackdrop").classList.add("open");
}

function closeBusinessDrawer() {
  openBusinessId = null;
  businessCareersChecks = [];
  document.getElementById("businessDrawer").classList.remove("open");
  document.getElementById("businessBackdrop").classList.remove("open");
}

document.getElementById("businessDrawerCloseBtn").addEventListener("click", closeBusinessDrawer);
document.getElementById("businessBackdrop").addEventListener("click", closeBusinessDrawer);
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (openOpeningId != null) closeOpeningDrawer();
  else if (openBusinessId != null) closeBusinessDrawer();
});

document.getElementById("businessDetailsForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (openBusinessId == null) return;

  const update = {
    careers_url: document.getElementById("businessCareersUrl").value.trim() || null,
    notes: document.getElementById("businessGeneralNotes").value.trim() || null,
  };

  const { error } = await sb.from("businesses").update(update).eq("id", openBusinessId);
  if (error) { alert("Failed to save business details: " + error.message); return; }
  await loadBusinessesData();
});

// ---------- opening detail rail ----------
function openOpeningDrawer(openingId) {
  const opening = jobOpenings.find((o) => String(o.id) === String(openingId));
  if (!opening) return;
  openOpeningId = opening.id;

  const business = businesses.find((b) => b.id === opening.business_id);
  document.getElementById("openingDrawerTitle").textContent = opening.title;
  document.getElementById("openingDrawerSubtitle").textContent = business ? business.name : "";
  document.getElementById("openingTitle").value = opening.title || "";
  document.getElementById("openingUrl").value = opening.url || "";
  document.getElementById("openingStatus").innerHTML = jobStatusSelectHtml(opening.status);
  document.getElementById("openingReachedOut").checked = !!opening.reached_out;
  document.getElementById("openingPostedDate").value = opening.posted_date || "";
  document.getElementById("openingAppliedDate").value = opening.applied_date || "";
  document.getElementById("openingNotes").value = opening.notes || "";

  document.getElementById("openingDrawer").classList.add("open");
  document.getElementById("openingBackdrop").classList.add("open");
}

function closeOpeningDrawer() {
  openOpeningId = null;
  document.getElementById("openingDrawer").classList.remove("open");
  document.getElementById("openingBackdrop").classList.remove("open");
}

document.getElementById("openingDrawerCloseBtn").addEventListener("click", closeOpeningDrawer);
document.getElementById("openingBackdrop").addEventListener("click", closeOpeningDrawer);

document.getElementById("openingDetailsForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (openOpeningId == null) return;

  const title = document.getElementById("openingTitle").value.trim();
  if (!title) return;
  const newStatus = document.getElementById("openingStatus").value;
  const opening = jobOpenings.find((o) => String(o.id) === String(openOpeningId));

  const update = {
    title,
    url: document.getElementById("openingUrl").value.trim() || null,
    status: newStatus,
    reached_out: document.getElementById("openingReachedOut").checked,
    posted_date: document.getElementById("openingPostedDate").value || null,
    applied_date: document.getElementById("openingAppliedDate").value || null,
    notes: document.getElementById("openingNotes").value.trim() || null,
  };
  if (opening && opening.status !== newStatus) update.status_changed_at = new Date().toISOString();

  const { error } = await sb.from("job_openings").update(update).eq("id", openOpeningId);
  if (error) { alert("Failed to save opening: " + error.message); return; }
  await loadBusinessesData();
});

document.getElementById("openingRemoveBtn").addEventListener("click", () => {
  if (openOpeningId != null) removeJobOpening(openOpeningId);
});

// ---------- business detail rail: careers page checks ----------
async function loadBusinessCareersChecks() {
  const businessId = openBusinessId;
  const { data, error } = await sb
    .from("business_careers_checks")
    .select("*")
    .eq("business_id", businessId)
    .order("checked_at", { ascending: false });

  if (String(openBusinessId) !== String(businessId)) return; // drawer moved on while this was in flight

  if (error) {
    document.getElementById("businessCareersChecksList").innerHTML =
      `<div class="journal-empty">Failed to load history: ${error.message}</div>`;
    return;
  }

  businessCareersChecks = data;
  renderBusinessCareersChecks();
}

function renderBusinessCareersChecks() {
  const listEl = document.getElementById("businessCareersChecksList");
  listEl.innerHTML = businessCareersChecks.length
    ? `<ul class="careers-check-history">${businessCareersChecks.map((c) => `<li>${new Date(c.checked_at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</li>`).join("")}</ul>`
    : `<div class="journal-empty">Not checked yet.</div>`;
}

document.getElementById("businessLogCareersCheckBtn").addEventListener("click", async (e) => {
  if (openBusinessId == null) return;
  const btn = e.currentTarget;
  btn.disabled = true;

  const { error } = await sb.from("business_careers_checks").insert({ business_id: openBusinessId });
  if (error) { alert("Failed to log check: " + error.message); btn.disabled = false; return; }

  await loadBusinessCareersChecks();
  btn.disabled = false;
});

// ---------- business detail rail: contacts ----------
function renderBusinessContacts() {
  const listEl = document.getElementById("businessContactsList");
  if (openBusinessId == null) { listEl.innerHTML = ""; return; }

  const linked = businessPeople.filter((p) => p.business_id === openBusinessId);
  listEl.innerHTML = linked.length
    ? `<div class="rol-checklist">${linked.map((p) => `
        <div class="plan-item" data-person-id="${p.id}">
          <label><span>${p.name}${p.title ? `<span class="plan-item-macro">${p.title}</span>` : ""}</span></label>
          <button type="button" class="plan-item-remove" title="Unlink from this business">&times;</button>
        </div>
      `).join("")}</div>`
    : `<div class="journal-empty">No contacts linked yet.</div>`;

  document.getElementById("businessLinkPersonSelect").innerHTML = personLinkSelectHtml();

  document.querySelectorAll("#businessContactsList .plan-item-remove").forEach((btn) => {
    btn.addEventListener("click", () => unlinkPersonFromBusiness(btn.closest("[data-person-id]").dataset.personId));
  });
}

function personLinkSelectHtml() {
  const eligible = businessPeople.filter((p) => p.business_id !== openBusinessId);
  if (!eligible.length) return `<option value="">No other people in CRM yet</option>`;
  return [
    `<option value="">Select a person…</option>`,
    ...eligible.map((p) => {
      const currentBiz = p.business_id ? businesses.find((b) => b.id === p.business_id) : null;
      const titlePart = p.title ? ` — ${p.title}` : "";
      return `<option value="${p.id}">${p.name}${titlePart}${currentBiz ? ` (currently at ${currentBiz.name})` : ""}</option>`;
    }),
  ].join("");
}

document.getElementById("businessLinkPersonBtn").addEventListener("click", async () => {
  const select = document.getElementById("businessLinkPersonSelect");
  const personId = select.value;
  if (!personId || openBusinessId == null) return;

  const { error } = await sb.from("people").update({ business_id: openBusinessId }).eq("id", personId);
  if (error) { alert("Failed to link person: " + error.message); return; }
  await loadBusinessesData();
  renderBusinessContacts();
});

async function unlinkPersonFromBusiness(personId) {
  const { error } = await sb.from("people").update({ business_id: null }).eq("id", personId);
  if (error) { alert("Failed to unlink person: " + error.message); return; }
  await loadBusinessesData();
  renderBusinessContacts();
}

document.getElementById("businessNewContactForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (openBusinessId == null) return;
  const nameInput = document.getElementById("businessNewContactName");
  const name = nameInput.value.trim();
  if (!name) return;

  const { error } = await sb.from("people").insert({ name, business_id: openBusinessId });
  if (error) { alert("Failed to add contact: " + error.message); return; }
  nameInput.value = "";
  await loadBusinessesData();
  renderBusinessContacts();
});
