// Shared sort/filter plumbing for the Businesses, CRM and Paper tables: clickable
// headers + a "Sort by" select kept in sync, a direction toggle, a Clear button,
// a "Showing X of Y" count, and the controls' values remembered in localStorage
// (per-browser convenience only — if storage is unavailable everything still works).

// Missing values (null/undefined) always sort last, regardless of direction.
function compareNullsLast(av, bv, dir) {
  if (av == null && bv == null) return 0;
  if (av == null) return 1;
  if (bv == null) return -1;
  if (av < bv) return -1 * dir;
  if (av > bv) return dir;
  return 0;
}

function readTableState(storageKey) {
  try { return JSON.parse(localStorage.getItem("table:" + storageKey)) || null; } catch { return null; }
}

function writeTableState(storageKey, state) {
  try { localStorage.setItem("table:" + storageKey, JSON.stringify(state)); } catch { /* storage blocked */ }
}

// Repopulate a <select> whose options depend on loaded data, keeping the current
// choice (or the one restored from storage before the options existed).
function fillFilterSelect(selectEl, options) {
  const want = selectEl.dataset.want ?? selectEl.value;
  delete selectEl.dataset.want;
  selectEl.innerHTML = options.map((o) => `<option value="${escAttrTT(o.value)}">${escHtmlTT(o.label)}</option>`).join("");
  selectEl.value = want;
  if (selectEl.value !== want) selectEl.value = options.length ? options[0].value : "";
}

const escHtmlTT = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const escAttrTT = escHtmlTT;

// opts: {
//   storageKey, render,
//   headers: [{id, key}]            — <th> ids; each needs a child #<id>Indicator span
//   sortOptions: [{key, label}]     — everything offered in the Sort by select (header keys + extras)
//   defaultSort: {key, dir}, defaultDir(key) → 1|-1 for when a new key is picked
//   controlIds: [...]               — filter inputs/selects/checkboxes to watch, persist, and clear
//   sortSelectId, sortDirId, clearBtnId, countId
//   onClear()                       — optional extra reset (e.g. the Businesses funnel cards)
// }
function createTableControls(opts) {
  const ctl = {
    sortKey: opts.defaultSort.key,
    sortDir: opts.defaultSort.dir,
  };
  const defaultDir = opts.defaultDir || (() => 1);
  const sortSelect = document.getElementById(opts.sortSelectId);
  const sortDirBtn = document.getElementById(opts.sortDirId);
  const controls = opts.controlIds.map((id) => document.getElementById(id));

  sortSelect.innerHTML = opts.sortOptions.map((o) => `<option value="${o.key}">${escHtmlTT(o.label)}</option>`).join("");

  // Restore remembered state.
  const saved = readTableState(opts.storageKey);
  if (saved) {
    if (opts.sortOptions.some((o) => o.key === saved.sortKey)) {
      ctl.sortKey = saved.sortKey;
      ctl.sortDir = saved.sortDir === -1 ? -1 : 1;
    }
    controls.forEach((el) => {
      if (!saved.controls || !(el.id in saved.controls)) return;
      const v = saved.controls[el.id];
      if (el.type === "checkbox") el.checked = !!v;
      else if (el.tagName === "SELECT") { el.dataset.want = v; el.value = v; }
      else el.value = v;
    });
  }

  ctl.setSort = (key, dir) => {
    ctl.sortKey = key;
    ctl.sortDir = dir ?? defaultDir(key);
    opts.render();
  };

  ctl.isFiltered = () => controls.some((el) => (el.type === "checkbox" ? el.checked : el.value !== ""));

  // Call at the top of each render: syncs indicators/select/direction and saves state.
  ctl.sync = () => {
    opts.headers.forEach(({ id, key }) => {
      document.getElementById(id + "Indicator").textContent =
        key === ctl.sortKey ? (ctl.sortDir === 1 ? " ▲" : " ▼") : "";
    });
    sortSelect.value = ctl.sortKey;
    sortDirBtn.textContent = ctl.sortDir === 1 ? "▲ Asc" : "▼ Desc";
    writeTableState(opts.storageKey, {
      sortKey: ctl.sortKey,
      sortDir: ctl.sortDir,
      controls: Object.fromEntries(controls.map((el) => [el.id, el.type === "checkbox" ? el.checked : el.value])),
    });
  };

  ctl.setCount = (shown, total, extra) => {
    const el = document.getElementById(opts.countId);
    el.textContent = (shown === total ? `${total}` : `Showing ${shown} of ${total}`) + (extra ? ` · ${extra}` : "");
  };

  opts.headers.forEach(({ id, key }) => {
    document.getElementById(id).addEventListener("click", () => {
      if (ctl.sortKey === key) ctl.setSort(key, ctl.sortDir * -1);
      else ctl.setSort(key);
    });
  });
  sortSelect.addEventListener("change", () => ctl.setSort(sortSelect.value));
  sortDirBtn.addEventListener("click", () => ctl.setSort(ctl.sortKey, ctl.sortDir * -1));

  controls.forEach((el) => {
    el.addEventListener(el.type === "text" || el.type === "number" ? "input" : "change", () => opts.render());
  });

  document.getElementById(opts.clearBtnId).addEventListener("click", () => {
    controls.forEach((el) => {
      if (el.type === "checkbox") el.checked = false;
      else if (el.tagName === "SELECT") el.selectedIndex = 0;
      else el.value = "";
    });
    if (opts.onClear) opts.onClear();
    ctl.sortKey = opts.defaultSort.key;
    ctl.sortDir = opts.defaultSort.dir;
    opts.render();
  });

  return ctl;
}
