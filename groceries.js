let groceriesLoadedOnce = false;
let groceryFunctions = []; // [{id, name, sort_order}], ordered by sort_order
let groceryOrder = null; // the current cart order row, or null if none exists yet
let groceryOrderItems = []; // [{id, quantity, item: {id, name, function}}]

async function loadGroceriesData() {
  if (!groceriesLoadedOnce) {
    document.getElementById("groceriesLoading").classList.remove("hidden");
    document.getElementById("groceriesLoading").textContent = "Loading data…";
    document.getElementById("groceriesPanel").classList.add("hidden");
  }

  const fetchPromise = Promise.all([
    sb.from("grocery_item_functions").select("*").order("sort_order", { ascending: true }),
    // Prefer the current cart; fall back to the most recent order of any status
    // so something still shows once a cart has been checked out.
    sb.from("grocery_orders").select("*").eq("status", "cart")
      .order("created_at", { ascending: false }).limit(1),
  ]);

  let functionsRes, orderRes;
  try {
    [functionsRes, orderRes] = await withTimeout(fetchPromise, 15000, "Loading grocery data");
  } catch (e) {
    document.getElementById("groceriesLoading").textContent = e.message;
    document.getElementById("groceriesLoading").classList.remove("hidden");
    return;
  }

  let error = functionsRes.error || orderRes.error;
  if (error) {
    document.getElementById("groceriesLoading").textContent = "Error loading data: " + error.message;
    document.getElementById("groceriesLoading").classList.remove("hidden");
    return;
  }

  groceryFunctions = functionsRes.data;
  groceryOrder = orderRes.data[0] || null;
  groceryOrderItems = [];

  if (groceryOrder) {
    const { data, error: itemsError } = await sb.from("grocery_order_items")
      .select("id, quantity, item:grocery_items(id, name, function)")
      .eq("order_id", groceryOrder.id)
      .order("id", { ascending: true });
    if (itemsError) {
      document.getElementById("groceriesLoading").textContent = "Error loading data: " + itemsError.message;
      document.getElementById("groceriesLoading").classList.remove("hidden");
      return;
    }
    groceryOrderItems = data;
  }

  document.getElementById("groceriesLoading").classList.add("hidden");
  document.getElementById("groceriesPanel").classList.remove("hidden");
  groceriesLoadedOnce = true;
  markUpdated("groceriesUpdatedAt");
  renderGroceries();
}

function renderGroceries() {
  const heading = groceryOrder
    ? `Cart — ${groceryOrder.retailer}`
    : "Cart";
  document.getElementById("groceriesHeading").textContent = heading;

  renderGroceriesCards();
  renderGroceriesGroups();
}

function renderGroceriesCards() {
  const cardsEl = document.getElementById("groceriesCards");
  if (!groceryOrder) { cardsEl.innerHTML = ""; return; }

  const itemCount = groceryOrderItems.length;
  const totalQty = groceryOrderItems.reduce((s, r) => s + (numOrNull(r.quantity) || 0), 0);
  const uncategorized = groceryOrderItems.filter((r) => !r.item.function).length;

  cardsEl.innerHTML = [
    { label: "Items", value: `${itemCount}`, sub: `${totalQty} total quantity` },
    { label: "Retailer", value: groceryOrder.retailer, sub: fmtShort(groceryOrder.order_date) },
    { label: "Uncategorized", value: `${uncategorized}`, sub: uncategorized ? "assign a function below" : "all set" },
  ].map((c) => `
    <div class="card">
      <div class="label">${c.label}</div>
      <div class="value">${c.value}</div>
      <div class="sub">${c.sub}</div>
    </div>
  `).join("");
}

function renderGroceriesGroups() {
  const groupsEl = document.getElementById("groceriesGroups");

  if (!groceryOrder || !groceryOrderItems.length) {
    groupsEl.innerHTML = `<div class="journal-empty">Nothing in the cart yet — ask Claude to sync it from Instacart.</div>`;
    return;
  }

  const functionOptions = (selected) => [
    `<option value="" ${selected ? "" : "selected"}>Uncategorized</option>`,
    ...groceryFunctions.map((f) => `<option value="${f.name}" ${f.name === selected ? "selected" : ""}>${f.name}</option>`),
  ].join("");

  const groupNames = [...groceryFunctions.map((f) => f.name), "Uncategorized"];

  groupsEl.innerHTML = groupNames.map((groupName) => {
    const rows = groceryOrderItems.filter((r) => (r.item.function || "Uncategorized") === groupName);
    if (!rows.length) return "";
    const itemsHtml = rows.map((r) => `
      <div class="plan-item" data-order-item-id="${r.id}" data-item-id="${r.item.id}">
        <label>
          <span>${r.item.name}${r.quantity > 1 ? `<span class="plan-item-macro">qty ${r.quantity}</span>` : ""}</span>
        </label>
        <select class="grocery-function-select">${functionOptions(r.item.function)}</select>
      </div>
    `).join("");
    return `
      <div class="checkin-group">
        <h3>${groupName}</h3>
        <div class="rol-checklist">${itemsHtml}</div>
      </div>
    `;
  }).join("");

  document.querySelectorAll(".grocery-function-select").forEach((select) => {
    select.addEventListener("change", () => updateGroceryItemFunction(select));
  });
}

async function updateGroceryItemFunction(select) {
  if (select.dataset.busy) return;
  select.dataset.busy = "1";
  select.disabled = true;
  const itemId = select.closest(".plan-item").dataset.itemId;
  const fn = select.value || null;
  const { error } = await sb.from("grocery_items").update({ function: fn }).eq("id", itemId);
  if (error) { alert("Failed to update: " + error.message); }
  await loadGroceriesData();
}
