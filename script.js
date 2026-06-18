const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const numberFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
const unitOptions = ["lb", "oz", "g", "kg", "count", "dozen", "gallon"];

let appData = null;
let activeView = "dashboard-view";

const viewConfig = {
  "dashboard-view": { title: "Dashboard", action: "Add Sale", dialog: "sale-dialog" },
  "expenses-view": { title: "Expenses", action: "Add Expense", dialog: "expense-dialog" },
  "inventory-view": { title: "Inventory", action: "Add Item", dialog: "inventory-dialog" },
  "recipes-view": { title: "Recipe Library", action: "Create Recipe", dialog: "recipe-dialog" },
  "sales-view": { title: "Sales", action: "Add Sale", dialog: "sale-dialog" },
};

initialize();

async function initialize() {
  applySavedTheme();
  document.querySelector("#current-date").textContent = new Date().toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
  bindEvents();
  await refreshDashboard();
}

function bindEvents() {
  document.querySelector("#theme-toggle").addEventListener("click", toggleTheme);
  document.querySelector("#recipe-search").addEventListener("input", renderRecipes);
  document.querySelector("#add-ingredient-row").addEventListener("click", () => addIngredientRow());

  document.addEventListener("click", async (event) => {
    const navButton = event.target.closest("[data-view-target]");
    if (navButton) return showView(navButton.dataset.viewTarget);

    const openButton = event.target.closest("[data-open-dialog]");
    if (openButton) return openEntryDialog(openButton.dataset.openDialog);

    const closeButton = event.target.closest("[data-close-dialog]");
    if (closeButton) return closeButton.closest("dialog").close();

    const editButton = event.target.closest("[data-edit-type]");
    if (editButton) return editRecord(editButton.dataset.editType, editButton.dataset.recordId);

    const deleteButton = event.target.closest("[data-delete-type]");
    if (deleteButton) return deleteRecord(deleteButton.dataset.deleteType, deleteButton.dataset.recordId);

    const recipeButton = event.target.closest("[data-view-recipe]");
    if (recipeButton) return viewRecipe(recipeButton.dataset.viewRecipe);

    const removeIngredient = event.target.closest("[data-remove-ingredient]");
    if (removeIngredient) {
      removeIngredient.closest(".ingredient-row").remove();
      ensureIngredientRow();
    }
  });

  document.querySelectorAll("dialog").forEach((dialog) => {
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) dialog.close();
    });
  });

  bindCrudForm("expense-form", "expenses", "Expense saved");
  bindCrudForm("inventory-form", "inventory", "Inventory item saved");
  bindCrudForm("sale-form", "sales", "Sale saved");
  bindCrudForm("recipe-form", "recipes", "Recipe saved", buildRecipePayload);
}

function showView(viewId) {
  activeView = viewId;
  document.querySelectorAll(".page-view").forEach((view) => {
    const active = view.id === viewId;
    view.hidden = !active;
    view.classList.toggle("active", active);
  });
  document.querySelectorAll("[data-view-target]").forEach((button) => {
    button.classList.toggle("active", button.dataset.viewTarget === viewId);
  });

  const config = viewConfig[viewId];
  document.querySelector("#page-title").textContent = config.title;
  const action = document.querySelector("#page-action");
  action.textContent = config.action;
  action.dataset.openDialog = config.dialog;
  window.scrollTo({ top: 0, behavior: "smooth" });
}

async function refreshDashboard() {
  try {
    const response = await fetch("/api/dashboard", { credentials: "same-origin" });
    if (!response.ok) throw new Error("Could not load dashboard data");
    appData = await response.json();
    renderAll();
  } catch (error) {
    showNotice(error.message, "error");
  }
}

function renderAll() {
  renderDashboard();
  renderExpenses();
  renderInventory();
  renderRecipes();
  renderSales();
}

function renderDashboard() {
  const financials = appData.financials;
  setText("#revenue-today", money.format(financials.revenueToday));
  setText("#revenue-month", money.format(financials.revenueThisMonth));
  setText("#expenses-month", money.format(financials.expensesThisMonth));
  setText("#estimated-profit", money.format(financials.estimatedProfit));
  setText("#low-stock-count", appData.inventory.alerts);
  renderSalesChart(appData.sales);

  renderCompactList(
    "#top-products",
    appData.productPerformance.slice(0, 5).map((item) => ({
      title: item.product,
      detail: `${numberFormat.format(item.quantitySold)} sold`,
      value: money.format(item.revenue),
    })),
    "No sales recorded yet",
  );
  renderCompactList(
    "#low-stock-list",
    appData.inventory.lowStock.slice(0, 5).map((item) => ({
      title: item.ingredientName,
      detail: `${numberFormat.format(item.quantity)} ${item.unit} remaining`,
      value: "Low",
    })),
    appData.inventory.all.length ? "No low inventory alerts" : "No inventory items added yet",
  );
  renderCompactList(
    "#dashboard-expenses",
    appData.expenses.slice(0, 5).map((item) => ({
      title: item.vendor,
      detail: formatDate(item.date),
      value: money.format(item.amount),
    })),
    "No expenses recorded yet",
  );
  renderCompactList(
    "#dashboard-sales",
    appData.sales.slice(0, 5).map((item) => ({
      title: item.product,
      detail: formatDate(item.date),
      value: money.format(item.saleAmount),
    })),
    "No sales recorded yet",
  );
}

function renderExpenses() {
  setText("#expense-page-total", money.format(appData.financials.expensesThisMonth));
  const body = document.querySelector("#expenses-body");
  if (!appData.expenses.length) {
    body.innerHTML = tableEmpty(6, "No expenses recorded yet", "Add the first expense to begin tracking costs.");
    return;
  }
  body.innerHTML = appData.expenses
    .map(
      (expense) => `<tr><td>${formatDate(expense.date)}</td><td><strong>${escapeHtml(expense.vendor)}</strong></td><td>${escapeHtml(expense.category)}</td><td>${money.format(expense.amount)}</td><td class="notes-cell">${escapeHtml(expense.notes || "")}</td><td>${rowActions("expenses", expense.id)}</td></tr>`,
    )
    .join("");
}

function renderInventory() {
  setText("#inventory-alert-total", appData.inventory.alerts);
  const body = document.querySelector("#inventory-body");
  if (!appData.inventory.all.length) {
    body.innerHTML = tableEmpty(7, "No inventory items added yet", "Add the first ingredient to begin tracking stock.");
    return;
  }
  body.innerHTML = appData.inventory.all
    .map((item) => {
      const low = item.quantity <= item.minimumThreshold;
      return `<tr><td><strong>${escapeHtml(item.ingredientName)}</strong></td><td>${numberFormat.format(item.quantity)} ${item.unit}</td><td>${numberFormat.format(item.minimumThreshold)} ${item.unit}</td><td>${escapeHtml(item.supplier || "Not set")}</td><td>${money.format(item.costPerUnit)} / ${item.unit}</td><td><span class="pill ${low ? "warning-pill" : "good-pill"}">${low ? "Low stock" : "Healthy"}</span></td><td>${rowActions("inventory", item.id)}</td></tr>`;
    })
    .join("");
}

function renderRecipes() {
  const grid = document.querySelector("#recipe-grid");
  if (!appData) return;
  const query = document.querySelector("#recipe-search").value.trim().toLowerCase();
  const recipes = appData.recipes.filter(
    (recipe) =>
      !query ||
      recipe.recipeName.toLowerCase().includes(query) ||
      recipe.category.toLowerCase().includes(query),
  );
  if (!recipes.length) {
    const title = appData.recipes.length ? "No matching recipes" : "No recipes created yet";
    grid.innerHTML = `<article class="panel empty-state"><strong>${title}</strong><p>${appData.recipes.length ? "Try another search." : "Create the first recipe to calculate food cost and margin."}</p></article>`;
    return;
  }
  grid.innerHTML = recipes
    .map((recipe) => {
      const costing = recipe.allCostsAvailable
        ? `<strong>${money.format(recipe.costPerUnit)}</strong><span>cost per ${escapeHtml(recipe.yieldUnit)}</span>`
        : `<strong>Cost incomplete</strong><span>Add matching inventory costs</span>`;
      return `<article class="recipe-card"><div><span class="category-label">${escapeHtml(recipe.category)}</span><h2>${escapeHtml(recipe.recipeName)}</h2><p>Yields ${numberFormat.format(recipe.yieldQuantity)} ${escapeHtml(recipe.yieldUnit)}</p></div><div class="recipe-metric">${costing}</div><div class="card-actions"><button class="secondary-button" type="button" data-view-recipe="${recipe.id}">View</button><button class="ghost-button" type="button" data-edit-type="recipes" data-record-id="${recipe.id}">Edit</button><button class="delete-button" type="button" data-delete-type="recipes" data-record-id="${recipe.id}">Delete</button></div></article>`;
    })
    .join("");
}

function renderSales() {
  setText("#sales-daily", money.format(appData.financials.revenueToday));
  setText("#sales-weekly", money.format(appData.financials.revenueThisWeek));
  setText("#sales-monthly", money.format(appData.financials.revenueThisMonth));
  const body = document.querySelector("#sales-body");
  if (!appData.sales.length) {
    body.innerHTML = tableEmpty(5, "No sales recorded yet", "Add the first sale to begin tracking revenue.");
  } else {
    body.innerHTML = appData.sales
      .map(
        (sale) => `<tr><td>${formatDate(sale.date)}</td><td><strong>${escapeHtml(sale.product)}</strong></td><td>${numberFormat.format(sale.quantitySold)}</td><td>${money.format(sale.saleAmount)}</td><td>${rowActions("sales", sale.id)}</td></tr>`,
      )
      .join("");
  }

  const performanceBody = document.querySelector("#performance-body");
  performanceBody.innerHTML = appData.productPerformance.length
    ? appData.productPerformance
        .map(
          (item) => `<tr><td><strong>${escapeHtml(item.product)}</strong></td><td>${numberFormat.format(item.quantitySold)}</td><td>${money.format(item.revenue)}</td></tr>`,
        )
        .join("")
    : tableEmpty(3, "No sales recorded yet", "Product performance will appear after sales are entered.");
}

function bindCrudForm(formId, collection, successMessage, payloadBuilder = defaultPayload) {
  const form = document.querySelector(`#${formId}`);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const submit = form.querySelector('[type="submit"]');
    submit.disabled = true;
    try {
      const fields = Object.fromEntries(new FormData(form).entries());
      const id = fields.id;
      delete fields.id;
      const payload = payloadBuilder(fields, form);
      const response = await fetch(id ? `/api/${collection}/${encodeURIComponent(id)}` : `/api/${collection}`, {
        method: id ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Could not save record");
      form.closest("dialog").close();
      showNotice(successMessage, "success");
      await refreshDashboard();
    } catch (error) {
      showNotice(error.message, "error");
    } finally {
      submit.disabled = false;
    }
  });
}

function defaultPayload(fields) {
  return fields;
}

function buildRecipePayload(fields) {
  const ingredients = [...document.querySelectorAll("#ingredient-editor .ingredient-row")]
    .map((row) => {
      const ingredientName = row.querySelector('[name="ingredientName"]').value.trim();
      const inventoryItem = appData.inventory.all.find(
        (item) => item.ingredientName.toLowerCase() === ingredientName.toLowerCase(),
      );
      return {
        inventoryId: inventoryItem?.id || "",
        ingredientName,
        quantity: row.querySelector('[name="ingredientQuantity"]').value,
        unit: row.querySelector('[name="ingredientUnit"]').value,
      };
    })
    .filter((ingredient) => ingredient.ingredientName);
  return { ...fields, ingredients };
}

function openEntryDialog(dialogId, record = null) {
  const dialog = document.querySelector(`#${dialogId}`);
  const form = dialog.querySelector("form");
  form.reset();
  form.elements.id.value = record?.id || "";
  const type = dialogId.replace("-dialog", "");
  setText(`#${type}-dialog-title`, record ? `Edit ${titleCase(type)}` : dialogTitle(type));

  if (record) fillForm(form, record);
  const dateInput = form.querySelector('input[type="date"]');
  if (dateInput && !dateInput.value) dateInput.value = localDateKey(new Date());

  if (dialogId === "recipe-dialog") {
    document.querySelector("#ingredient-editor").innerHTML = "";
    const ingredients = record?.ingredients?.length ? record.ingredients : [null];
    ingredients.forEach((ingredient) => addIngredientRow(ingredient));
  }
  dialog.showModal();
  requestAnimationFrame(() => form.querySelector('input:not([type="hidden"]), select, textarea')?.focus());
}

function editRecord(type, id) {
  const source = type === "inventory" ? appData.inventory.all : appData[type];
  const record = source.find((item) => item.id === id);
  if (!record) return showNotice("Record not found", "error");
  openEntryDialog(`${type.replace(/s$/, "")}-dialog`, record);
}

async function deleteRecord(type, id) {
  if (!window.confirm("Delete this record? This cannot be undone.")) return;
  try {
    const response = await fetch(`/api/${type}/${encodeURIComponent(id)}`, { method: "DELETE" });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Could not delete record");
    showNotice("Record deleted", "success");
    await refreshDashboard();
  } catch (error) {
    showNotice(error.message, "error");
  }
}

function fillForm(form, record) {
  for (const [key, value] of Object.entries(record)) {
    if (key === "ingredients") continue;
    const field = form.elements.namedItem(key);
    if (field) field.value = value ?? "";
  }
}

function addIngredientRow(ingredient = null) {
  const editor = document.querySelector("#ingredient-editor");
  const inventoryOptions = appData.inventory.all
    .map((item) => `<option value="${escapeHtml(item.ingredientName)}"></option>`)
    .join("");
  const row = document.createElement("div");
  row.className = "ingredient-row";
  row.innerHTML = `<label>Ingredient<input name="ingredientName" list="inventory-${editor.children.length}" value="${escapeHtml(ingredient?.ingredientName || "")}" required /><datalist id="inventory-${editor.children.length}">${inventoryOptions}</datalist></label><label>Quantity<input name="ingredientQuantity" type="number" min="0.0001" step="0.0001" value="${ingredient?.quantity ?? ""}" required /></label><label>Unit<select name="ingredientUnit" required><option value="">Unit</option>${unitOptions.map((unit) => `<option${ingredient?.unit === unit ? " selected" : ""}>${unit}</option>`).join("")}</select></label><button class="icon-button remove-ingredient" type="button" data-remove-ingredient aria-label="Remove ingredient">&times;</button>`;
  const nameInput = row.querySelector('[name="ingredientName"]');
  nameInput.addEventListener("change", () => {
    const match = appData.inventory.all.find(
      (item) => item.ingredientName.toLowerCase() === nameInput.value.trim().toLowerCase(),
    );
    if (match) row.querySelector('[name="ingredientUnit"]').value = match.unit;
  });
  editor.appendChild(row);
}

function ensureIngredientRow() {
  if (!document.querySelector("#ingredient-editor").children.length) addIngredientRow();
}

function viewRecipe(id) {
  const recipe = appData.recipes.find((item) => item.id === id);
  if (!recipe) return;
  setText("#recipe-detail-title", recipe.recipeName);
  const breakdown = recipe.costBreakdown
    .map(
      (item) => `<tr><td>${escapeHtml(item.ingredientName)}</td><td>${numberFormat.format(item.quantity)} ${item.unit}</td><td>${item.costAvailable ? money.format(item.cost) : "Cost unavailable"}</td></tr>`,
    )
    .join("");
  const costValue = recipe.allCostsAvailable ? money.format(recipe.totalRecipeCost) : "Incomplete";
  document.querySelector("#recipe-detail-content").innerHTML = `<div class="recipe-summary"><div><span>Yield</span><strong>${numberFormat.format(recipe.yieldQuantity)} ${escapeHtml(recipe.yieldUnit)}</strong></div><div><span>Selling Price</span><strong>${money.format(recipe.sellingPrice)}</strong></div><div><span>Total Recipe Cost</span><strong>${costValue}</strong></div><div><span>Cost Per Unit</span><strong>${recipe.allCostsAvailable ? money.format(recipe.costPerUnit) : "Incomplete"}</strong></div><div><span>Profit Per Unit</span><strong>${recipe.allCostsAvailable ? money.format(recipe.profitPerUnit) : "Incomplete"}</strong></div><div><span>Profit Margin</span><strong>${recipe.allCostsAvailable ? `${recipe.profitMargin}%` : "Incomplete"}</strong></div></div><h3>Cost breakdown</h3><div class="table-wrap"><table><thead><tr><th>Ingredient</th><th>Quantity</th><th>Cost</th></tr></thead><tbody>${breakdown}</tbody></table></div>${recipe.preparationNotes ? `<div class="notes-block"><h3>Preparation notes</h3><p>${escapeHtml(recipe.preparationNotes)}</p></div>` : ""}`;
  document.querySelector("#recipe-detail-dialog").showModal();
}

function renderSalesChart(sales) {
  const chart = document.querySelector("#sales-chart");
  if (!sales.length) {
    chart.classList.add("empty-chart");
    chart.innerHTML = '<div class="empty-state"><strong>No sales recorded yet</strong><p>Add a sale to populate revenue analytics.</p></div>';
    return;
  }
  const days = buildDailyRevenue(sales);
  const max = Math.max(...days.map((day) => day.total), 1);
  chart.classList.remove("empty-chart");
  chart.innerHTML = days.map((day) => `<span title="${day.label}: ${money.format(day.total)}" style="height:${day.total ? Math.max((day.total / max) * 100, 8) : 2}%"></span>`).join("");
}

function buildDailyRevenue(sales) {
  const days = [];
  for (let index = 6; index >= 0; index -= 1) {
    const date = new Date();
    date.setDate(date.getDate() - index);
    days.push({ key: localDateKey(date), label: date.toLocaleDateString(undefined, { weekday: "short" }), total: 0 });
  }
  sales.forEach((sale) => {
    const day = days.find((item) => item.key === sale.date);
    if (day) day.total += sale.saleAmount;
  });
  return days;
}

function renderCompactList(selector, items, emptyTitle) {
  const container = document.querySelector(selector);
  if (!items.length) {
    container.innerHTML = `<div class="empty-state"><strong>${emptyTitle}</strong></div>`;
    return;
  }
  container.innerHTML = items.map((item) => `<div class="compact-row"><div><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(item.detail)}</span></div><strong>${escapeHtml(item.value)}</strong></div>`).join("");
}

function rowActions(type, id) {
  return `<div class="row-actions"><button class="table-action" type="button" data-edit-type="${type}" data-record-id="${id}">Edit</button><button class="table-action danger" type="button" data-delete-type="${type}" data-record-id="${id}">Delete</button></div>`;
}

function tableEmpty(columns, title, message = "") {
  return `<tr><td colspan="${columns}"><div class="empty-state table-empty"><strong>${title}</strong>${message ? `<p>${message}</p>` : ""}</div></td></tr>`;
}

function applySavedTheme() {
  if (localStorage.getItem("bakeryops-theme") === "dark") document.body.classList.add("dark");
  updateThemeLabel();
}

function toggleTheme() {
  document.body.classList.toggle("dark");
  localStorage.setItem("bakeryops-theme", document.body.classList.contains("dark") ? "dark" : "light");
  updateThemeLabel();
}

function updateThemeLabel() {
  document.querySelector("#theme-toggle").textContent = document.body.classList.contains("dark") ? "Light mode" : "Dark mode";
}

function showNotice(message, type = "info") {
  const notice = document.querySelector("#app-notice");
  notice.textContent = message;
  notice.className = `notice ${type}`;
  notice.hidden = false;
  clearTimeout(showNotice.timer);
  showNotice.timer = setTimeout(() => (notice.hidden = true), 4500);
}

function dialogTitle(type) {
  return { expense: "Add Expense", inventory: "Add Inventory Item", sale: "Add Sale", recipe: "Create Recipe" }[type];
}

function titleCase(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function setText(selector, value) {
  const element = document.querySelector(selector);
  if (element) element.textContent = value;
}

function formatDate(value) {
  return new Date(`${value}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function localDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function escapeHtml(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}
