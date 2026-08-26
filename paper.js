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

  document.getElementById("paperLoading").classList.add("hidden");
  document.getElementById("paperPanel").classList.remove("hidden");
  paperLoadedOnce = true;
  markUpdated("paperUpdatedAt");
  renderPaperTable();
}

// ---------- paper table: sort + filter ----------
const PAPER_SORT_HEADERS = [
  { id: "paperSortDate", key: "date" },
  { id: "paperSortType", key: "type" },
  { id: "paperSortVendor", key: "vendor" },
  { id: "paperSortDetails", key: "details" },
  { id: "paperSortAmount", key: "amount" },
  { id: "paperSortFolder", key: "folder" },
];
let paperSortKey = "date";
let paperSortDir = -1;

// Raw (possibly null) values — kept separate from display formatting so missing
// values can be pinned to the end of the list regardless of sort direction.
const PAPER_SORT_VALUE = {
  date: (p) => p.doc_date || null,
  type: (p) => (p.type ? p.type.toLowerCase() : null),
  vendor: (p) => (p.vendor ? p.vendor.toLowerCase() : null),
  details: (p) => (p.details ? p.details.toLowerCase() : null),
  amount: (p) => (p.amount == null ? null : Number(p.amount)),
  folder: (p) => (p.drive_folder ? 1 : 0),
};

function getVisiblePaperDocs() {
  const filterText = document.getElementById("paperFilterInput").value.trim().toLowerCase();

  const filtered = paperDocs.filter((p) => {
    if (!filterText) return true;
    const haystack = `${p.type || ""} ${p.vendor || ""} ${p.details || ""}`.toLowerCase();
    return haystack.includes(filterText);
  });

  const valueFn = PAPER_SORT_VALUE[paperSortKey];
  return filtered.sort((a, b) => {
    const av = valueFn(a);
    const bv = valueFn(b);
    // Missing values always sort last, independent of ascending/descending toggling.
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    if (av < bv) return -1 * paperSortDir;
    if (av > bv) return paperSortDir;
    return 0;
  });
}

function updatePaperSortIndicators() {
  PAPER_SORT_HEADERS.forEach(({ id, key }) => {
    document.getElementById(id + "Indicator").textContent =
      key === paperSortKey ? (paperSortDir === 1 ? " ▲" : " ▼") : "";
  });
}

PAPER_SORT_HEADERS.forEach(({ id, key }) => {
  document.getElementById(id).addEventListener("click", () => {
    if (paperSortKey === key) { paperSortDir *= -1; } else { paperSortKey = key; paperSortDir = key === "date" ? -1 : 1; }
    renderPaperTable();
  });
});

document.getElementById("paperFilterInput").addEventListener("input", () => renderPaperTable());

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
  updatePaperSortIndicators();

  if (!paperDocs.length) {
    bodyEl.innerHTML = `<tr><td colspan="6" class="journal-empty">No paper tracked yet.</td></tr>`;
    return;
  }

  const visible = getVisiblePaperDocs();
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
