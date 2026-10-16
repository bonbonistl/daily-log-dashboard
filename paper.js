let paperLoadedOnce = false;
let paperDocs = []; // [{id, doc_date, type, vendor, details, drive_folder, amount, created_at}]

async function loadPaperData() {
  if (!paperLoadedOnce) {
    document.getElementById("paperLoading").classList.remove("hidden");
    document.getElementById("paperLoading").textContent = "Loading data…";
    document.getElementById("paperPanel").classList.add("hidden");
  }

  let res;
  try {
    res = await withTimeout(
      sb.from("paper_inventory").select("*").order("doc_date", { ascending: false }),
      15000,
      "Loading Paper data"
    );
  } catch (e) {
    document.getElementById("paperLoading").textContent = e.message;
    document.getElementById("paperLoading").classList.remove("hidden");
    return;
  }

  if (res.error) {
    document.getElementById("paperLoading").textContent = "Error loading data: " + res.error.message;
    document.getElementById("paperLoading").classList.remove("hidden");
    return;
  }

  paperDocs = res.data;
  fillPaperFilterSelects();

  document.getElementById("paperLoading").classList.add("hidden");
  document.getElementById("paperPanel").classList.remove("hidden");
  paperLoadedOnce = true;
  markUpdated("paperUpdatedAt");
  renderPaperTable();
}

// ---------- paper table: sort + filter ----------
// Raw (possibly null) values — kept separate from display formatting so missing
// values can be pinned to the end of the list regardless of sort direction.
const PAPER_SORT_VALUE = {
  date: (p) => p.doc_date || null,
  type: (p) => (p.type ? p.type.toLowerCase() : null),
  vendor: (p) => (p.vendor ? p.vendor.toLowerCase() : null),
  details: (p) => (p.details ? p.details.toLowerCase() : null),
  amount: (p) => (p.amount == null ? null : Number(p.amount)),
  folder: (p) => (p.drive_folder ? 1 : 0),
  added: (p) => p.created_at || null,
};

const paperTable = createTableControls({
  storageKey: "paper",
  render: () => renderPaperTable(),
  headers: [
    { id: "paperSortDate", key: "date" },
    { id: "paperSortType", key: "type" },
    { id: "paperSortVendor", key: "vendor" },
    { id: "paperSortDetails", key: "details" },
    { id: "paperSortAmount", key: "amount" },
    { id: "paperSortFolder", key: "folder" },
  ],
  sortOptions: [
    { key: "date", label: "Date" },
    { key: "type", label: "Type" },
    { key: "vendor", label: "Vendor" },
    { key: "details", label: "Details" },
    { key: "amount", label: "Amount" },
    { key: "folder", label: "Has scan" },
    { key: "added", label: "Date added" },
  ],
  defaultSort: { key: "date", dir: -1 },
  defaultDir: (key) => (["date", "amount", "added"].includes(key) ? -1 : 1),
  controlIds: [
    "paperFilterInput", "paperTypeFilter", "paperVendorFilter", "paperFromFilter",
    "paperToFilter", "paperMinFilter", "paperMaxFilter", "paperScanFilter",
  ],
  sortSelectId: "paperSortSelect",
  sortDirId: "paperSortDirBtn",
  clearBtnId: "paperClearFiltersBtn",
  countId: "paperTableCount",
});

// Type + vendor choices come from the loaded documents.
function fillPaperFilterSelects() {
  const distinct = (field) => [...new Set(paperDocs.map((p) => p[field]).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  fillFilterSelect(document.getElementById("paperTypeFilter"), [
    { value: "", label: "Any type" },
    ...distinct("type").map((t) => ({ value: t, label: t })),
  ]);
  fillFilterSelect(document.getElementById("paperVendorFilter"), [
    { value: "", label: "Any vendor" },
    ...distinct("vendor").map((v) => ({ value: v, label: v })),
  ]);
}

function getVisiblePaperDocs() {
  const val = (id) => document.getElementById(id).value;
  const filterText = val("paperFilterInput").trim().toLowerCase();
  const typeFilter = val("paperTypeFilter");
  const vendorFilter = val("paperVendorFilter");
  const from = val("paperFromFilter");
  const to = val("paperToFilter");
  const min = val("paperMinFilter") === "" ? null : Number(val("paperMinFilter"));
  const max = val("paperMaxFilter") === "" ? null : Number(val("paperMaxFilter"));
  const scanFilter = val("paperScanFilter");

  const filtered = paperDocs.filter((p) => {
    if (typeFilter && p.type !== typeFilter) return false;
    if (vendorFilter && p.vendor !== vendorFilter) return false;
    // A date range excludes undated documents; so does an amount range for ones with no amount.
    if (from && !(p.doc_date && p.doc_date >= from)) return false;
    if (to && !(p.doc_date && p.doc_date <= to)) return false;
    if (min != null && !(p.amount != null && Number(p.amount) >= min)) return false;
    if (max != null && !(p.amount != null && Number(p.amount) <= max)) return false;
    if (scanFilter === "yes" && !p.drive_folder) return false;
    if (scanFilter === "no" && p.drive_folder) return false;
    if (!filterText) return true;
    const haystack = `${p.type || ""} ${p.vendor || ""} ${p.details || ""}`.toLowerCase();
    return haystack.includes(filterText);
  });

  const valueFn = PAPER_SORT_VALUE[paperTable.sortKey];
  return filtered.sort((a, b) => compareNullsLast(valueFn(a), valueFn(b), paperTable.sortDir));
}

// ---------- paper table ----------
function formatPaperDate(dateStr) {
  if (!dateStr) return null;
  return new Date(dateStr + "T00:00:00").toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function formatPaperAmount(amount) {
  if (amount == null) return null;
  return Number(amount).toLocaleString(undefined, { style: "currency", currency: "USD" });
}

function renderPaperTable() {
  const bodyEl = document.getElementById("paperTableBody");
  paperTable.sync();
  paperTable.setCount(0, paperDocs.length);

  if (!paperDocs.length) {
    bodyEl.innerHTML = `<tr><td colspan="6" class="journal-empty">No paper tracked yet.</td></tr>`;
    return;
  }

  const visible = getVisiblePaperDocs();
  const total = visible.reduce((sum, p) => sum + (p.amount == null ? 0 : Number(p.amount)), 0);
  paperTable.setCount(visible.length, paperDocs.length, `${formatPaperAmount(total)} total`);
  if (!visible.length) {
    bodyEl.innerHTML = `<tr><td colspan="6" class="journal-empty">No documents match your filter.</td></tr>`;
    return;
  }

  bodyEl.innerHTML = visible.map((p) => {
    const dateDisplay = formatPaperDate(p.doc_date);
    const amountDisplay = formatPaperAmount(p.amount);
    return `
      <tr data-paper-id="${p.id}">
        <td>${dateDisplay || `<span class="job-table-empty">—</span>`}</td>
        <td>${p.type || `<span class="job-table-empty">—</span>`}</td>
        <td>${p.vendor || `<span class="job-table-empty">—</span>`}</td>
        <td>${p.details || `<span class="job-table-empty">—</span>`}</td>
        <td>${amountDisplay || `<span class="job-table-empty">—</span>`}</td>
        <td>${p.drive_folder ? `<a class="job-careers-link" href="${p.drive_folder}" target="_blank" rel="noopener noreferrer">View ↗</a>` : `<span class="job-table-empty">—</span>`}</td>
      </tr>
    `;
  }).join("");
}
