let jobMarketLoadedOnce = false;
let jobCompanies = []; // [{id, name, careers_url, notes, created_at}]
let jobOpenings = []; // [{id, company_id, title, url, posted_date, status, applied_date, status_changed_at, notes, created_at}]
let jobContacts = []; // [{id, company_id, name, title, linkedin_url, email, phone, created_at}]
let openCompanyId = null; // id of the company currently shown in the side rail, or null if closed

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

async function loadJobMarketData() {
  if (!jobMarketLoadedOnce) {
    document.getElementById("jobMarketLoading").classList.remove("hidden");
    document.getElementById("jobMarketLoading").textContent = "Loading data…";
    document.getElementById("jobMarketPanel").classList.add("hidden");
  }

  const fetchPromise = Promise.all([
    sb.from("job_companies").select("*").order("name", { ascending: true }),
    sb.from("job_openings").select("*").order("created_at", { ascending: false }),
    sb.from("job_contacts").select("*").order("created_at", { ascending: true }),
  ]);

  let companiesRes, openingsRes, contactsRes;
  try {
    [companiesRes, openingsRes, contactsRes] = await withTimeout(fetchPromise, 15000, "Loading job market data");
  } catch (e) {
    document.getElementById("jobMarketLoading").textContent = e.message;
    document.getElementById("jobMarketLoading").classList.remove("hidden");
    return;
  }

  const error = companiesRes.error || openingsRes.error || contactsRes.error;
  if (error) {
    document.getElementById("jobMarketLoading").textContent = "Error loading data: " + error.message;
    document.getElementById("jobMarketLoading").classList.remove("hidden");
    return;
  }

  jobCompanies = companiesRes.data;
  jobOpenings = openingsRes.data;
  jobContacts = contactsRes.data;

  document.getElementById("jobMarketLoading").classList.add("hidden");
  document.getElementById("jobMarketPanel").classList.remove("hidden");
  jobMarketLoadedOnce = true;
  markUpdated("jobMarketUpdatedAt");
  renderJobMarket();
}

function renderJobMarket() {
  renderJobMarketCards();
  renderJobCompanies();
}

function renderJobMarketCards() {
  const pipelineStatuses = new Set(["applied", "heard_back", "interviewing"]);
  const active = jobOpenings.filter((o) => pipelineStatuses.has(o.status)).length;
  const interviewing = jobOpenings.filter((o) => o.status === "interviewing").length;
  const offered = jobOpenings.filter((o) => o.status === "offered").length;

  document.getElementById("jobMarketCards").innerHTML = [
    { label: "Companies", value: `${jobCompanies.length}`, sub: `${jobOpenings.length} opening(s) tracked` },
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

// ---------- companies table ----------
function renderJobCompanies() {
  const bodyEl = document.getElementById("jobCompaniesTableBody");
  if (!jobCompanies.length) {
    bodyEl.innerHTML = `<tr><td colspan="5" class="journal-empty">No companies tracked yet — add one above.</td></tr>`;
    return;
  }

  bodyEl.innerHTML = jobCompanies.map((c) => {
    const openings = jobOpenings.filter((o) => o.company_id === c.id);
    const contacts = jobContacts.filter((ct) => ct.company_id === c.id);

    const contactsCell = contacts.length
      ? contacts.map((ct) => `<span class="job-connection-badge" title="${escAttr(ct.title) || "Your contact here"}">🤝 ${ct.name}</span>`).join(" ")
      : `<span class="job-table-empty">—</span>`;

    const careersCell = c.careers_url
      ? `<a class="job-careers-link" href="${c.careers_url}" target="_blank" rel="noopener noreferrer">Careers ↗</a>`
      : `<span class="job-table-empty">—</span>`;

    return `
      <tr data-company-id="${c.id}">
        <td><button type="button" class="job-company-name-btn">${c.name}</button></td>
        <td>${contactsCell}</td>
        <td>${careersCell}</td>
        <td>
          <div class="job-openings-list">
            ${openings.length ? openings.map((o) => renderJobOpening(o)).join("") : `<span class="job-table-empty">No openings yet</span>`}
          </div>
          <form class="add-opening-form" data-company-id="${c.id}">
            <input type="text" class="new-opening-title" placeholder="Job title" maxlength="200" required />
            <input type="url" class="new-opening-url" placeholder="URL (optional)" maxlength="500" />
            <input type="date" class="new-opening-posted" title="Date it went live" />
            <button type="submit">Add Opening</button>
          </form>
        </td>
        <td class="job-table-actions"><button type="button" class="job-company-remove" title="Remove company">&times;</button></td>
      </tr>
    `;
  }).join("");

  bindJobCompanyEvents();
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

function bindJobCompanyEvents() {
  document.querySelectorAll(".job-company-name-btn").forEach((btn) => {
    btn.addEventListener("click", () => openCompanyDrawer(btn.closest("[data-company-id]").dataset.companyId));
  });
  document.querySelectorAll(".job-company-remove").forEach((btn) => {
    btn.addEventListener("click", () => removeJobCompany(btn));
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

// ---------- companies ----------
document.getElementById("addCompanyForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const nameInput = document.getElementById("newCompanyName");
  const name = nameInput.value.trim();
  if (!name) return;

  const { error } = await sb.from("job_companies").insert({ name });
  if (error) { alert("Failed to add company: " + error.message); return; }

  nameInput.value = "";
  await loadJobMarketData();
});

async function removeJobCompany(btn) {
  const companyId = btn.closest("[data-company-id]").dataset.companyId;
  const company = jobCompanies.find((c) => String(c.id) === companyId);
  const openingCount = jobOpenings.filter((o) => String(o.company_id) === companyId).length;
  const warning = openingCount ? ` This will also remove ${openingCount} opening(s).` : "";
  if (!confirm(`Remove ${company.name}?${warning}`)) return;

  const { error } = await sb.from("job_companies").delete().eq("id", companyId);
  if (error) { alert("Failed to remove company: " + error.message); return; }
  if (String(openCompanyId) === companyId) closeCompanyDrawer();
  await loadJobMarketData();
}

// ---------- openings ----------
async function addJobOpening(e, form) {
  e.preventDefault();
  const companyId = form.dataset.companyId;
  const titleInput = form.querySelector(".new-opening-title");
  const urlInput = form.querySelector(".new-opening-url");
  const postedInput = form.querySelector(".new-opening-posted");
  const title = titleInput.value.trim();
  if (!title) return;

  const { error } = await sb.from("job_openings").insert({
    company_id: companyId,
    title,
    url: urlInput.value.trim() || null,
    posted_date: postedInput.value || null,
  });
  if (error) { alert("Failed to add opening: " + error.message); return; }
  await loadJobMarketData();
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
  await loadJobMarketData();
}

async function removeJobOpening(btn) {
  const openingId = btn.closest("[data-opening-id]").dataset.openingId;
  const opening = jobOpenings.find((o) => String(o.id) === openingId);
  if (!confirm(`Remove opening "${opening.title}"?`)) return;

  const { error } = await sb.from("job_openings").delete().eq("id", openingId);
  if (error) { alert("Failed to remove opening: " + error.message); return; }
  await loadJobMarketData();
}

// ---------- company detail rail ----------
function openCompanyDrawer(companyId) {
  const company = jobCompanies.find((c) => String(c.id) === String(companyId));
  if (!company) return;
  openCompanyId = company.id;

  document.getElementById("companyDrawerTitle").textContent = company.name;
  document.getElementById("companyCareersUrl").value = company.careers_url || "";
  document.getElementById("companyGeneralNotes").value = company.notes || "";

  renderCompanyContacts();

  document.getElementById("companyDrawer").classList.add("open");
  document.getElementById("companyBackdrop").classList.add("open");
}

function closeCompanyDrawer() {
  openCompanyId = null;
  document.getElementById("companyDrawer").classList.remove("open");
  document.getElementById("companyBackdrop").classList.remove("open");
}

document.getElementById("companyDrawerCloseBtn").addEventListener("click", closeCompanyDrawer);
document.getElementById("companyBackdrop").addEventListener("click", closeCompanyDrawer);
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && openCompanyId != null) closeCompanyDrawer(); });

document.getElementById("companyDetailsForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (openCompanyId == null) return;

  const update = {
    careers_url: document.getElementById("companyCareersUrl").value.trim() || null,
    notes: document.getElementById("companyGeneralNotes").value.trim() || null,
  };

  const { error } = await sb.from("job_companies").update(update).eq("id", openCompanyId);
  if (error) { alert("Failed to save company details: " + error.message); return; }
  await loadJobMarketData();
});

// ---------- contacts (in the rail) ----------
function renderCompanyContacts() {
  const listEl = document.getElementById("companyContactsList");
  if (openCompanyId == null) { listEl.innerHTML = ""; return; }

  const contacts = jobContacts.filter((ct) => ct.company_id === openCompanyId);
  if (!contacts.length) {
    listEl.innerHTML = `<div class="journal-empty">No contacts yet — add one below.</div>`;
    return;
  }

  listEl.innerHTML = contacts.map((ct) => `
    <div class="job-contact-card" data-contact-id="${ct.id}">
      <div class="job-contact-card-header">
        <input type="text" class="job-contact-field" data-field="name" value="${escAttr(ct.name)}" placeholder="Full name" />
        <button type="button" class="job-contact-remove" title="Remove contact">&times;</button>
      </div>
      <input type="text" class="job-contact-field" data-field="title" value="${escAttr(ct.title)}" placeholder="Title" />
      <input type="url" class="job-contact-field" data-field="linkedin_url" value="${escAttr(ct.linkedin_url)}" placeholder="LinkedIn URL" />
      <input type="email" class="job-contact-field" data-field="email" value="${escAttr(ct.email)}" placeholder="Email" />
      <input type="tel" class="job-contact-field" data-field="phone" value="${escAttr(ct.phone)}" placeholder="Phone" />
    </div>
  `).join("");

  document.querySelectorAll(".job-contact-field").forEach((input) => {
    input.addEventListener("change", () => updateContactField(input));
  });
  document.querySelectorAll(".job-contact-remove").forEach((btn) => {
    btn.addEventListener("click", () => removeContact(btn));
  });
}

document.getElementById("addContactForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (openCompanyId == null) return;
  const nameInput = document.getElementById("newContactName");
  const name = nameInput.value.trim();
  if (!name) return;

  const { error } = await sb.from("job_contacts").insert({ company_id: openCompanyId, name });
  if (error) { alert("Failed to add contact: " + error.message); return; }

  nameInput.value = "";
  await loadJobMarketData();
  renderCompanyContacts();
});

async function updateContactField(input) {
  if (input.dataset.busy) return;
  input.dataset.busy = "1";
  input.disabled = true;

  const contactId = input.closest("[data-contact-id]").dataset.contactId;
  const field = input.dataset.field;
  const value = input.value.trim() || null;
  if (field === "name" && !value) { alert("Name can't be blank."); input.disabled = false; delete input.dataset.busy; renderCompanyContacts(); return; }

  const { error } = await sb.from("job_contacts").update({ [field]: value }).eq("id", contactId);
  if (error) { alert("Failed to update contact: " + error.message); input.disabled = false; delete input.dataset.busy; return; }
  await loadJobMarketData();
  renderCompanyContacts();
}

async function removeContact(btn) {
  const contactId = btn.closest("[data-contact-id]").dataset.contactId;
  const contact = jobContacts.find((ct) => String(ct.id) === contactId);
  if (!confirm(`Remove contact "${contact.name}"?`)) return;

  const { error } = await sb.from("job_contacts").delete().eq("id", contactId);
  if (error) { alert("Failed to remove contact: " + error.message); return; }
  await loadJobMarketData();
  renderCompanyContacts();
}
