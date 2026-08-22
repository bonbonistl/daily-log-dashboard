let groceriesLoadedOnce = false;
let groceryFunctions = []; // [{id, name, sort_order}], ordered by sort_order
let groceryOrder = null; // the current cart order row, or null if none exists yet
let groceryOrderItems = []; // [{id, quantity, item: {id, name, function}}]
let groceryInventory = []; // [{id, quantity, item: {id, name, function}}]

async function loadGroceriesData() {
  if (!groceriesLoadedOnce) {
    document.getElementById("groceriesLoading").classList.remove("hidden");
    document.getElementById("groceriesLoading").textContent = "Loading data…";
    document.getElementById("groceriesPanel").classList.add("hidden");
    document.getElementById("inventoryPanel").classList.add("hidden");
  }

  const fetchPromise = Promise.all([
    sb.from("grocery_item_functions").select("*").order("sort_order", { ascending: true }),
    // Prefer the current cart; fall back to the most recent order of any status
    // so something still shows once a cart has been checked out.
    sb.from("grocery_orders").select("*").eq("status", "cart")
      .order("created_at", { ascending: false }).limit(1),
    sb.from("grocery_inventory").select("id, quantity, item:grocery_items(id, name, function)")
      .order("id", { ascending: true }),
  ]);

  let functionsRes, orderRes, inventoryRes;
  try {
    [functionsRes, orderRes, inventoryRes] = await withTimeout(fetchPromise, 15000, "Loading grocery data");
  } catch (e) {
    document.getElementById("groceriesLoading").textContent = e.message;
    document.getElementById("groceriesLoading").classList.remove("hidden");
    return;
  }

  let error = functionsRes.error || orderRes.error || inventoryRes.error;
  if (error) {
    document.getElementById("groceriesLoading").textContent = "Error loading data: " + error.message;
    document.getElementById("groceriesLoading").classList.remove("hidden");
    return;
  }

  groceryFunctions = functionsRes.data;
  groceryOrder = orderRes.data[0] || null;
  groceryInventory = inventoryRes.data;
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
  document.getElementById("inventoryPanel").classList.remove("hidden");
  groceriesLoadedOnce = true;
  markUpdated("groceriesUpdatedAt");
  renderGroceries();
}

function renderGroceries() {
  renderCart();
  renderInventory();
}

// ---------- shared helpers ----------
function functionSelectHtml(selected) {
  return [
    `<option value="" ${selected ? "" : "selected"}>Uncategorized</option>`,
    ...groceryFunctions.map((f) => `<option value="${f.name}" ${f.name === selected ? "selected" : ""}>${f.name}</option>`),
  ].join("");
}

// Splits an arbitrary list of {item: {function}} rows into function-named groups
// (in catalog sort order, "Uncategorized" last), dropping empty groups.
function groupByFunction(rows) {
  const groupNames = [...groceryFunctions.map((f) => f.name), "Uncategorized"];
  return groupNames
    .map((groupName) => ({ groupName, rows: rows.filter((r) => (r.item.function || "Uncategorized") === groupName) }))
    .filter((g) => g.rows.length);
}

function bindFunctionSelects() {
  document.querySelectorAll(".grocery-function-select").forEach((select) => {
    select.addEventListener("change", () => updateGroceryItemFunction(select));
  });
}

async function updateGroceryItemFunction(select) {
  if (select.dataset.busy) return;
  select.dataset.busy = "1";
  select.disabled = true;
  const itemId = select.closest("[data-item-id]").dataset.itemId;
  const fn = select.value || null;
  const { error } = await sb.from("grocery_items").update({ function: fn }).eq("id", itemId);
  if (error) { alert("Failed to update: " + error.message); }
  await loadGroceriesData();
}

// ---------- cart ----------
function renderCart() {
  const heading = groceryOrder ? `Cart — ${groceryOrder.retailer}` : "Cart";
  document.getElementById("groceriesHeading").textContent = heading;
  document.getElementById("markReceivedBtn").classList.toggle("hidden", !groceryOrder);

  renderCartCards();

  const groupsEl = document.getElementById("groceriesGroups");
  if (!groceryOrder || !groceryOrderItems.length) {
    groupsEl.innerHTML = `<div class="journal-empty">Nothing in the cart yet — ask Claude to sync it from Instacart.</div>`;
    return;
  }

  groupsEl.innerHTML = groupByFunction(groceryOrderItems).map(({ groupName, rows }) => `
    <div class="checkin-group">
      <h3>${groupName}</h3>
      <div class="rol-checklist">${rows.map((r) => `
        <div class="plan-item" data-item-id="${r.item.id}">
          <label>
            <span>${r.item.name}${r.quantity > 1 ? `<span class="plan-item-macro">qty ${r.quantity}</span>` : ""}</span>
          </label>
          <select class="grocery-function-select">${functionSelectHtml(r.item.function)}</select>
        </div>
      `).join("")}</div>
    </div>
  `).join("");

  bindFunctionSelects();
}

function renderCartCards() {
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

// Rolls the cart's items into inventory (summing onto whatever's already on hand)
// and retires the order so the next Instacart sync starts a fresh cart.
async function markOrderReceived() {
  const btn = document.getElementById("markReceivedBtn");
  if (!groceryOrder || btn.dataset.busy) return;
  btn.dataset.busy = "1";
  btn.disabled = true;

  const existingQtyByItem = new Map(groceryInventory.map((r) => [r.item.id, numOrNull(r.quantity) || 0]));
  const upserts = groceryOrderItems.map((r) => ({
    item_id: r.item.id,
    quantity: (existingQtyByItem.get(r.item.id) || 0) + (numOrNull(r.quantity) || 0),
  }));

  if (upserts.length) {
    const { error: invError } = await sb.from("grocery_inventory").upsert(upserts, { onConflict: "item_id" });
    if (invError) { alert("Failed to update inventory: " + invError.message); btn.disabled = false; delete btn.dataset.busy; return; }
  }

  const { error: orderError } = await sb.from("grocery_orders").update({ status: "received" }).eq("id", groceryOrder.id);
  if (orderError) { alert("Failed to mark received: " + orderError.message); btn.disabled = false; delete btn.dataset.busy; return; }

  await loadGroceriesData();
}

document.getElementById("markReceivedBtn").addEventListener("click", markOrderReceived);

// ---------- inventory ----------
function renderInventory() {
  document.getElementById("newInventoryFunction").innerHTML = functionSelectHtml("");

  const groupsEl = document.getElementById("inventoryGroups");
  if (!groceryInventory.length) {
    groupsEl.innerHTML = `<div class="journal-empty">Nothing in inventory yet — mark a received order, or add something below.</div>`;
    return;
  }

  groupsEl.innerHTML = groupByFunction(groceryInventory).map(({ groupName, rows }) => `
    <div class="checkin-group">
      <h3>${groupName}</h3>
      <div class="rol-checklist">${rows.map((r) => `
        <div class="plan-item" data-item-id="${r.item.id}" data-inventory-id="${r.id}">
          <label>
            <span>${r.item.name}</span>
          </label>
          <div class="qty-stepper">
            <button type="button" class="qty-btn" data-delta="-1" aria-label="Decrease quantity">&minus;</button>
            <span class="qty-value">${r.quantity}</span>
            <button type="button" class="qty-btn" data-delta="1" aria-label="Increase quantity">+</button>
          </div>
          <select class="grocery-function-select">${functionSelectHtml(r.item.function)}</select>
        </div>
      `).join("")}</div>
    </div>
  `).join("");

  bindFunctionSelects();
  document.querySelectorAll("#inventoryGroups .qty-btn").forEach((btn) => {
    btn.addEventListener("click", () => adjustInventoryQty(btn));
  });
}

async function adjustInventoryQty(btn) {
  const row = btn.closest(".plan-item");
  if (row.dataset.busy) return;
  row.dataset.busy = "1";
  const invId = row.dataset.inventoryId;
  const delta = Number(btn.dataset.delta);
  const current = groceryInventory.find((r) => String(r.id) === invId);
  const newQty = (numOrNull(current.quantity) || 0) + delta;

  if (newQty <= 0) {
    const { error } = await sb.from("grocery_inventory").delete().eq("id", invId);
    if (error) { alert("Failed to update: " + error.message); delete row.dataset.busy; return; }
  } else {
    const { error } = await sb.from("grocery_inventory").update({ quantity: newQty }).eq("id", invId);
    if (error) { alert("Failed to update: " + error.message); delete row.dataset.busy; return; }
  }
  await loadGroceriesData();
}

// Lets you log things that just happen to be in the fridge/pantry — never went
// through an Instacart order, so there's no cart item to receive.
document.getElementById("addInventoryForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const nameInput = document.getElementById("newInventoryName");
  const fnSelect = document.getElementById("newInventoryFunction");
  const qtyInput = document.getElementById("newInventoryQty");
  const name = nameInput.value.trim();
  const fn = fnSelect.value || null;
  const qty = Number(qtyInput.value) || 1;
  if (!name) return;

  const { data: existingItem, error: findError } = await sb.from("grocery_items").select("id").eq("name", name).maybeSingle();
  if (findError) { alert("Failed to add: " + findError.message); return; }

  let itemId = existingItem ? existingItem.id : null;
  if (!itemId) {
    const { data: inserted, error: insertError } = await sb.from("grocery_items").insert({ name, function: fn }).select().single();
    if (insertError) { alert("Failed to add: " + insertError.message); return; }
    itemId = inserted.id;
  }

  const existingInv = groceryInventory.find((r) => r.item.id === itemId);
  if (existingInv) {
    const { error } = await sb.from("grocery_inventory")
      .update({ quantity: (numOrNull(existingInv.quantity) || 0) + qty }).eq("id", existingInv.id);
    if (error) { alert("Failed to add: " + error.message); return; }
  } else {
    const { error } = await sb.from("grocery_inventory").insert({ item_id: itemId, quantity: qty });
    if (error) { alert("Failed to add: " + error.message); return; }
  }

  nameInput.value = "";
  qtyInput.value = "1";
  fnSelect.value = "";
  await loadGroceriesData();
});
