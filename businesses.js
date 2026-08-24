let businessesLoadedOnce = false;
let businesses = []; // [{id, name, careers_url, notes, created_at}]
let jobOpenings = []; // [{id, business_id, title, url, posted_date, status, applied_date, status_changed_at, notes, created_at}]
let businessPeople = []; // [{id, name, business_id}] — read-only display of CRM contacts; manage them from the CRM tab
let openBusinessId = null; // id of the business currently shown in the side rail, or null if closed

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
    sb.from("people").select("id, name, business_id").not("business_id", "is", null),
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

function renderBusinessesCards() {
  const pipelineStatuses = new Set(["applied", "heard_back", "interviewing"]);
  const active = jobOpenings.filter((o) => pipelineStatuses.has(o.status)).length;
  const interviewing = jobOpenings.filter((o) => o.status === "interviewing").length;
  const offered = jobOpenings.filter((o) => o.status === "offered").length;

  document.getElementById("businessesCards").innerHTML = [
    { label: "Businesses", value: `${businesses.length}`, sub: `${jobOpenings.length} opening(s) tracked` },
    { label: "Active Pipeline", value: `${active}`, sub: "applied, heard back, or interviewing" },
    { label: "Interviewing", value: `${interviewing}`, sub: interviewing ? "in progress" : "none right now" },
    { label: "Offers", value: `${offered}`, sub: offered ? "awaiting decision" : "none right now" },
  ].map((c) => `
    <div class="card">
      <div class="label">${c.label}</div>
      <div class="value">${c.value}</div>
      <div class="sub">${c.sub}</div>
    </div>
  `).join("");
}

function jobStatusSelectHtml(selected) {
  return JOB_STATUSES.map((s) => `<option value="${s.key}" ${s.key === selected ? "selected" : ""}>${s.label}</option>`).join("");
}

// ---------- businesses table ----------
function renderBusinessesTable() {
  const bodyEl = document.getElementById("businessesTableBody");
  if (!businesses.length) {
    bodyEl.innerHTML = `<tr><td colspan="5" class="journal-empty">No businesses tracked yet — add one above.</td></tr>`;
    return;
  }

  bodyEl.innerHTML = businesses.map((b) => {
    const openings = jobOpenings.filter((o) => o.business_id === b.id);
    const contacts = businessPeople.filter((p) => p.business_id === b.id);

    const contactsCell = contacts.length
      ? contacts.map((p) => `<span class="job-connection-badge">🤝 ${p.name}</span>`).join(" ")
      : `<span class="job-table-empty">—</span>`;

    const careersCell = b.careers_url
      ? `<a class="job-careers-link" href="${b.careers_url}" target="_blank" rel="noopener noreferrer">Careers ↗</a>`
      : `<span class="job-table-empty">—</span>`;

    return `
      <tr data-business-id="${b.id}">
        <td><button type="button" class="job-company-name-btn">${b.name}</button></td>
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
        <span class="job-opening-title">${o.url ? `<a href="${o.url}" target="_blank" rel="noopener noreferrer">${o.title}</a>` : o.title}</span>
        <span class="job-status-badge status-${o.status}">${JOB_STATUS_LABELS[o.status]}</span>
      </div>
      <div class="job-opening-meta">${metaParts.join(" · ")}</div>
      <div class="job-opening-controls">
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
  document.querySelectorAll(".add-opening-form").forEach((form) => {
    form.addEventListener("submit", (e) => addJobOpening(e, form));
  });
  document.querySelectorAll(".job-status-select").forEach((select) => {
    select.addEventListener("change", () => updateJobOpeningStatus(select));
  });
  document.querySelectorAll(".job-opening-remove").forEach((btn) => {
    btn.addEventListener("click", () => removeJobOpening(btn));
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
  const warning = openingCount ? ` This will also remove ${openingCount} opening(s).` : "";
  if (!confirm(`Remove ${business.name}?${warning}`)) return;

  const { error } = await sb.from("businesses").delete().eq("id", businessId);
  if (error) { alert("Failed to remove business: " + error.message); return; }
  if (String(openBusinessId) === businessId) closeBusinessDrawer();
  await loadBusinessesData();
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

async function removeJobOpening(btn) {
  const openingId = btn.closest("[data-opening-id]").dataset.openingId;
  const opening = jobOpenings.find((o) => String(o.id) === openingId);
  if (!confirm(`Remove opening "${opening.title}"?`)) return;

  const { error } = await sb.from("job_openings").delete().eq("id", openingId);
  if (error) { alert("Failed to remove opening: " + error.message); return; }
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

  document.getElementById("businessDrawer").classList.add("open");
  document.getElementById("businessBackdrop").classList.add("open");
}

function closeBusinessDrawer() {
  openBusinessId = null;
  document.getElementById("businessDrawer").classList.remove("open");
  document.getElementById("businessBackdrop").classList.remove("open");
}

document.getElementById("businessDrawerCloseBtn").addEventListener("click", closeBusinessDrawer);
document.getElementById("businessBackdrop").addEventListener("click", closeBusinessDrawer);
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && openBusinessId != null) closeBusinessDrawer(); });

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
