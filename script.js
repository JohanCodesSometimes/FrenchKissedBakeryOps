const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const numberFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
const unitOptions = ["lb", "oz", "g", "kg", "count", "dozen", "gallon"];

let appData = null;
let appSettings = null;
let priceHistory = [];
let activityLog = [];
let receiptsData = [];
let activeView = "dashboard-view";

const viewConfig = {
  "dashboard-view": { title: "Dashboard", action: "Add Sale", dialog: "sale-dialog" },
  "expenses-view": { title: "Expenses", action: "Add Expense", dialog: "expense-dialog" },
  "receipts-view": { title: "Receipts" },
  "inventory-view": { title: "Inventory", action: "Add Item", dialog: "inventory-dialog" },
  "recipes-view": { title: "Recipe Library", action: "Create Recipe", dialog: "recipe-dialog" },
  "sales-view": { title: "Sales", action: "Add Sale", dialog: "sale-dialog" },
  "reports-view": { title: "Monthly Reports" },
  "shopping-view": { title: "Shopping List" },
  "activity-view": { title: "Activity Log" },
  "settings-view": { title: "Owner Settings" },
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
  document.querySelector("#report-month").value = localDateKey(new Date()).slice(0, 7);
  bindEvents();
  await refreshAllData();
}

function bindEvents() {
  document.querySelector("#theme-toggle").addEventListener("click", toggleTheme);
  document.querySelector("#recipe-search").addEventListener("input", renderRecipes);
  document.querySelector("#add-ingredient-row").addEventListener("click", () => addIngredientRow());
  document.querySelector("#refresh-report").addEventListener("click", refreshReport);
  document.querySelector("#report-month").addEventListener("change", refreshReport);
  document.querySelector("#refresh-shopping").addEventListener("click", refreshShoppingList);
  document.querySelector("#settings-form").addEventListener("submit", saveSettings);
  document.querySelector("#square-disconnect").addEventListener("click", disconnectSquare);
  document.querySelector("#receipt-upload-button").addEventListener("click", (event) => {
    event.stopPropagation();
    document.querySelector("#receipt-upload").click();
  });
  document.querySelector("#receipt-upload").addEventListener("change", (event) => parseReceipt(event.target.files?.[0]));
  document.querySelector("#receipt-review-form").addEventListener("submit", approveReceipt);
  document.querySelector("#cancel-receipt-review").addEventListener("click", cancelReceiptReview);
  bindReceiptDropZone();
  document.querySelectorAll("[data-import-type]").forEach((button) => {
    button.addEventListener("click", () => document.querySelector(`#${button.dataset.importType}-import`).click());
  });
  ["expenses", "inventory", "sales"].forEach((type) => {
    document.querySelector(`#${type}-import`).addEventListener("change", (event) => importCsv(type, event.target.files?.[0]));
  });

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

    const duplicateButton = event.target.closest("[data-duplicate-recipe]");
    if (duplicateButton) return duplicateRecipe(duplicateButton.dataset.duplicateRecipe);

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

async function parseReceipt(file) {
  if (!file) return;
  const extension = file.name.toLowerCase().match(/\.[^.]+$/)?.[0] || "";
  if (![".jpg", ".jpeg", ".png", ".pdf"].includes(extension)) {
    showNotice("Choose a JPG, JPEG, PNG, or PDF receipt", "error");
    return;
  }
  const input = document.querySelector("#receipt-upload");
  const button = document.querySelector("#receipt-upload-button");
  const progress = document.querySelector("#receipt-progress");
  const progressBar = document.querySelector("#receipt-progress-bar");
  const progressLabel = document.querySelector("#receipt-progress-label");
  const progressValue = document.querySelector("#receipt-progress-value");
  button.disabled = true;
  button.textContent = "Uploading...";
  progress.hidden = false;
  progressBar.value = 0;
  progressLabel.textContent = `Uploading ${file.name}`;
  progressValue.textContent = "0%";
  showNotice("Reading receipt with image analysis. This can take a moment.", "info");
  try {
    const result = await uploadReceipt(file, (percent) => {
      if (percent >= 100) {
        progressBar.removeAttribute("value");
        progressLabel.textContent = "Extracting receipt items";
        progressValue.textContent = "Processing";
      } else {
        progressBar.value = percent;
        progressValue.textContent = `${percent}%`;
      }
    });
    progressBar.removeAttribute("value");
    progressLabel.textContent = "Extracting receipt items";
    progressValue.textContent = "Processing";
    renderReceiptReview(result);
    document.querySelector("#receipt-review-panel").hidden = false;
    document.querySelector("#receipt-review-panel").scrollIntoView({ behavior: "smooth", block: "start" });
    await refreshReceipts();
    showNotice("Receipt ready to review", "success");
  } catch (error) {
    await refreshReceipts();
    showNotice(error.message, "error");
  } finally {
    input.value = "";
    button.disabled = false;
    button.textContent = "Choose Receipt";
    progress.hidden = true;
    progressBar.value = 0;
  }
}

function uploadReceipt(file, onProgress) {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", "/api/receipts/parse");
    request.setRequestHeader("Content-Type", file.type || "application/octet-stream");
    request.setRequestHeader("X-File-Name", encodeURIComponent(file.name));
    request.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) onProgress(Math.min(100, Math.round((event.loaded / event.total) * 100)));
    });
    request.addEventListener("load", () => {
      let result = {};
      try { result = JSON.parse(request.responseText || "{}"); }
      catch { return reject(new Error("AI parsing failed")); }
      if (request.status < 200 || request.status >= 300) return reject(new Error(result.error || "AI parsing failed"));
      resolve(result);
    });
    request.addEventListener("error", () => reject(new Error("Receipt upload failed")));
    request.addEventListener("abort", () => reject(new Error("Receipt upload cancelled")));
    request.send(file);
  });
}

function bindReceiptDropZone() {
  const dropZone = document.querySelector("#receipt-drop-zone");
  const input = document.querySelector("#receipt-upload");
  dropZone.addEventListener("click", () => input.click());
  dropZone.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      input.click();
    }
  });
  ["dragenter", "dragover"].forEach((type) => dropZone.addEventListener(type, (event) => {
    event.preventDefault();
    dropZone.classList.add("drag-over");
  }));
  ["dragleave", "drop"].forEach((type) => dropZone.addEventListener(type, (event) => {
    event.preventDefault();
    dropZone.classList.remove("drag-over");
  }));
  dropZone.addEventListener("drop", (event) => parseReceipt(event.dataTransfer?.files?.[0]));
}

function renderReceiptReview(receipt) {
  const form = document.querySelector("#receipt-review-form");
  form.elements.draftId.value = receipt.draftId;
  form.elements.storeName.value = receipt.storeName || "";
  form.elements.receiptDate.value = receipt.receiptDate || "";
  form.elements.subtotal.value = Number(receipt.subtotal || 0).toFixed(2);
  form.elements.tax.value = Number(receipt.tax || 0).toFixed(2);
  form.elements.total.value = Number(receipt.total || 0).toFixed(2);
  document.querySelector("#receipt-review-items").innerHTML = receipt.items.map((item) => `
    <tr class="receipt-item-row">
      <td><input name="itemName" type="text" maxlength="160" value="${escapeHtml(item.itemName)}" required /></td>
      <td><input name="quantity" type="number" min="0.01" step="0.01" value="${Number(item.quantity)}" required /></td>
      <td><select name="unit">${selectOptions(unitOptions, item.unit)}</select></td>
      <td><input name="unitPrice" type="number" min="0" step="0.01" value="${Number(item.unitPrice).toFixed(2)}" required /></td>
      <td><input name="totalPrice" type="number" min="0" step="0.01" value="${Number(item.totalPrice).toFixed(2)}" required /></td>
      <td><select name="category">${selectOptions(["Ingredients", "Packaging", "Equipment", "Utilities", "Other"], item.category)}</select></td>
      <td><input name="updateInventory" type="checkbox" ${item.updateInventory ? "checked" : ""} aria-label="Update inventory for ${escapeHtml(item.itemName)}" /></td>
    </tr>`).join("");
}

async function approveReceipt(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = form.querySelector('[type="submit"]');
  submit.disabled = true;
  try {
    const summary = Object.fromEntries(new FormData(form).entries());
    const items = [...document.querySelectorAll("#receipt-review-items .receipt-item-row")].map((row) => ({
      itemName: row.querySelector('[name="itemName"]').value,
      quantity: row.querySelector('[name="quantity"]').value,
      unit: row.querySelector('[name="unit"]').value,
      unitPrice: row.querySelector('[name="unitPrice"]').value,
      totalPrice: row.querySelector('[name="totalPrice"]').value,
      category: row.querySelector('[name="category"]').value,
      updateInventory: row.querySelector('[name="updateInventory"]').checked,
    }));
    const response = await fetch("/api/receipts/approve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...summary, items }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Could not save receipt");
    cancelReceiptReview();
    showNotice("Receipt approved and inventory updated", "success");
    await refreshAllData();
  } catch (error) {
    showNotice(error.message, "error");
  } finally {
    submit.disabled = false;
  }
}

function cancelReceiptReview() {
  document.querySelector("#receipt-review-panel").hidden = true;
  document.querySelector("#receipt-review-form").reset();
  document.querySelector("#receipt-review-items").innerHTML = "";
}

function selectOptions(options, selected) {
  return options.map((option) => `<option value="${escapeHtml(option)}" ${option === selected ? "selected" : ""}>${escapeHtml(option)}</option>`).join("");
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
  action.hidden = !config.action;
  if (config.action) {
    action.textContent = config.action;
    action.dataset.openDialog = config.dialog;
  }
  window.scrollTo({ top: 0, behavior: "smooth" });
}

async function refreshAllData() {
  await Promise.all([
    refreshDashboard(),
    refreshSettings(),
    refreshPriceHistory(),
    refreshActivity(),
    refreshReport(),
    refreshShoppingList(),
    refreshSquareStatus(),
    refreshReceipts(),
  ]);
}

async function refreshReceipts() {
  try {
    const response = await fetch("/api/receipts");
    if (!response.ok) throw new Error("Could not load receipts");
    receiptsData = await response.json();
    const body = document.querySelector("#receipts-body");
    body.innerHTML = receiptsData.length
      ? receiptsData.map((receipt) => `<tr>
          <td>${formatDateTime(receipt.uploadedAt)}</td>
          <td><strong>${escapeHtml(receipt.fileName)}</strong><span class="table-subtext">${formatFileSize(receipt.fileSize)}</span></td>
          <td>${escapeHtml(receipt.storeName || "Not read")}</td>
          <td>${receipt.receiptDate ? formatDate(receipt.receiptDate) : "-"}</td>
          <td>${money.format(receipt.total || 0)}</td>
          <td>${numberFormat.format(receipt.itemCount || 0)}</td>
          <td><span class="receipt-status ${escapeHtml(receipt.status)}">${escapeHtml(receipt.status === "failed" ? receipt.errorCode || "Failed" : titleCase(receipt.status))}</span></td>
        </tr>`).join("")
      : tableEmpty(7, "No receipts uploaded yet", "Upload a grocery receipt to begin.");
  } catch (error) {
    showNotice(error.message, "error");
  }
}

function formatFileSize(bytes) {
  const size = Number(bytes || 0);
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

async function refreshSquareStatus() {
  try {
    const response = await fetch("/api/square/status");
    if (!response.ok) throw new Error("Could not load Square status");
    const status = await response.json();
    const badge = document.querySelector("#square-status-badge");
    const connect = document.querySelector("#square-connect");
    const disconnect = document.querySelector("#square-disconnect");
    badge.textContent = status.connected ? "Connected" : status.configured ? "Not connected" : "Setup required";
    badge.classList.toggle("connected", status.connected);
    document.querySelector("#square-status-copy").textContent = status.connected
      ? "Completed Square payments will sync into Sales automatically."
      : status.configured
        ? "Connect the bakery owner's Square account to begin syncing sales."
        : "Add the Square environment variables in Railway before connecting.";
    document.querySelector("#square-environment").textContent = titleCase(status.environment);
    document.querySelector("#square-merchant").textContent = status.merchantId || "Not connected";
    document.querySelector("#square-last-sync").textContent = status.lastSyncAt ? formatDateTime(status.lastSyncAt) : "Never";
    connect.hidden = status.connected;
    connect.setAttribute("aria-disabled", String(!status.configured));
    connect.onclick = status.configured ? null : (event) => event.preventDefault();
    disconnect.hidden = !status.connected;
    if (status.lastError) document.querySelector("#square-status-copy").textContent += ` Last error: ${status.lastError}`;
  } catch (error) {
    showNotice(error.message, "error");
  }
}

async function disconnectSquare() {
  if (!window.confirm("Disconnect Square? Existing synced sales will remain.")) return;
  const button = document.querySelector("#square-disconnect");
  button.disabled = true;
  try {
    const response = await fetch("/api/square/disconnect", { method: "POST" });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Could not disconnect Square");
    showNotice("Square disconnected", "success");
    await Promise.all([refreshSquareStatus(), refreshActivity()]);
  } catch (error) {
    showNotice(error.message, "error");
  } finally {
    button.disabled = false;
  }
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
      return `<article class="recipe-card"><div><span class="category-label">${escapeHtml(recipe.category)}</span><h2>${escapeHtml(recipe.recipeName)}</h2><p>Yields ${numberFormat.format(recipe.yieldQuantity)} ${escapeHtml(recipe.yieldUnit)}</p></div><div class="recipe-metric">${costing}</div><div class="card-actions four-actions"><button class="secondary-button" type="button" data-view-recipe="${recipe.id}">View</button><button class="ghost-button" type="button" data-edit-type="recipes" data-record-id="${recipe.id}">Edit</button><button class="ghost-button" type="button" data-duplicate-recipe="${recipe.id}">Duplicate</button><button class="delete-button" type="button" data-delete-type="recipes" data-record-id="${recipe.id}">Delete</button></div></article>`;
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
      await refreshAllData();
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
    await refreshAllData();
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

async function refreshSettings() {
  try {
    const response = await fetch("/api/settings");
    if (!response.ok) throw new Error("Could not load settings");
    appSettings = await response.json();
    const form = document.querySelector("#settings-form");
    Object.entries(appSettings).forEach(([key, value]) => {
      if (form.elements.namedItem(key)) form.elements.namedItem(key).value = value ?? "";
    });
    document.querySelector("#brand-name").textContent = appSettings.businessName || "BakeryOps AI";
  } catch (error) {
    showNotice(error.message, "error");
  }
}

async function saveSettings(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = form.querySelector('[type="submit"]');
  submit.disabled = true;
  try {
    const response = await fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(Object.fromEntries(new FormData(form).entries())),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Could not save settings");
    appSettings = result;
    document.querySelector("#brand-name").textContent = result.businessName || "BakeryOps AI";
    showNotice("Owner settings saved", "success");
    await Promise.all([refreshActivity(), refreshShoppingList()]);
  } catch (error) {
    showNotice(error.message, "error");
  } finally {
    submit.disabled = false;
  }
}

async function refreshPriceHistory() {
  try {
    const response = await fetch("/api/price-history");
    if (!response.ok) throw new Error("Could not load price history");
    priceHistory = await response.json();
    const body = document.querySelector("#price-history-body");
    body.innerHTML = priceHistory.length
      ? priceHistory
          .slice(0, 100)
          .map(
            (item) => `<tr><td>${formatDateTime(item.recordedAt)}</td><td><strong>${escapeHtml(item.ingredientName)}</strong></td><td>${escapeHtml(item.supplier || "Not set")}</td><td>${money.format(item.costPerUnit)} / ${item.unit}</td><td>${titleCase(item.reason)}</td></tr>`,
          )
          .join("")
      : tableEmpty(5, "No ingredient price history yet", "Prices are recorded when inventory costs are added or changed.");
  } catch (error) {
    showNotice(error.message, "error");
  }
}

async function refreshActivity() {
  try {
    const response = await fetch("/api/activity");
    if (!response.ok) throw new Error("Could not load activity");
    activityLog = await response.json();
    const container = document.querySelector("#activity-list");
    container.innerHTML = activityLog.length
      ? activityLog
          .map(
            (item) => `<article class="activity-row"><span class="activity-dot"></span><div><strong>${escapeHtml(item.description)}</strong><span>${formatDateTime(item.timestamp)}</span></div></article>`,
          )
          .join("")
      : '<div class="empty-state"><strong>No activity yet</strong><p>Record changes will appear here.</p></div>';
  } catch (error) {
    showNotice(error.message, "error");
  }
}

async function refreshReport() {
  const month = document.querySelector("#report-month").value || localDateKey(new Date()).slice(0, 7);
  try {
    const response = await fetch(`/api/reports/monthly?month=${encodeURIComponent(month)}`);
    if (!response.ok) throw new Error("Could not load monthly report");
    const report = await response.json();
    setText("#report-revenue", money.format(report.revenue));
    setText("#report-expenses", money.format(report.expenses));
    setText("#report-profit", money.format(report.estimatedProfit));
    renderCompactList(
      "#report-products",
      report.topProducts.map((item) => ({
        title: item.product,
        detail: `${numberFormat.format(item.quantitySold)} sold`,
        value: money.format(item.revenue),
      })),
      "No sales for this month",
    );
    renderCompactList(
      "#report-categories",
      report.expenseCategories.map((item) => ({
        title: item.category,
        detail: "Recorded expenses",
        value: money.format(item.amount),
      })),
      "No expenses for this month",
    );
  } catch (error) {
    showNotice(error.message, "error");
  }
}

async function refreshShoppingList() {
  try {
    const response = await fetch("/api/shopping-list");
    if (!response.ok) throw new Error("Could not load shopping list");
    const list = await response.json();
    setText("#shopping-total", money.format(list.estimatedTotal));
    const body = document.querySelector("#shopping-body");
    body.innerHTML = list.items.length
      ? list.items
          .map(
            (item) => `<tr><td><strong>${escapeHtml(item.ingredientName)}</strong></td><td>${numberFormat.format(item.currentQuantity)} ${item.unit}</td><td>${numberFormat.format(item.quantityToBuy)} ${item.unit}</td><td>${numberFormat.format(item.targetQuantity)} ${item.unit}</td><td>${escapeHtml(item.supplier || "Not set")}</td><td>${money.format(item.estimatedCost)}</td></tr>`,
          )
          .join("")
      : tableEmpty(6, "No shopping items needed", "Items appear when inventory reaches its minimum threshold.");
  } catch (error) {
    showNotice(error.message, "error");
  }
}

async function duplicateRecipe(id) {
  try {
    const response = await fetch(`/api/recipes/${encodeURIComponent(id)}/duplicate`, { method: "POST" });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Could not duplicate recipe");
    showNotice("Recipe duplicated", "success");
    await Promise.all([refreshDashboard(), refreshActivity()]);
  } catch (error) {
    showNotice(error.message, "error");
  }
}

async function importCsv(type, file) {
  if (!file) return;
  const input = document.querySelector(`#${type}-import`);
  try {
    const rows = parseCsv(await file.text());
    if (rows.length < 2) throw new Error("CSV has no data rows");
    const headers = rows[0].map(normalizeHeader);
    const records = rows
      .slice(1)
      .filter((row) => row.some((cell) => cell.trim()))
      .map((row) => mapCsvRecord(type, Object.fromEntries(headers.map((header, index) => [header, row[index] || ""]))));
    const response = await fetch(`/api/import/${type}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ records }),
    });
    const result = await response.json();
    if (!response.ok && !result.imported) throw new Error(result.error || result.errors?.[0]?.error || "Import failed");
    const rejected = result.rejected ? `, ${result.rejected} rejected` : "";
    showNotice(`${result.imported} rows imported${rejected}`, result.rejected ? "info" : "success");
    await refreshAllData();
  } catch (error) {
    showNotice(error.message, "error");
  } finally {
    input.value = "";
  }
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n") {
      row.push(cell.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      cell = "";
    } else cell += char;
  }
  if (cell || row.length) {
    row.push(cell.replace(/\r$/, ""));
    rows.push(row);
  }
  if (rows[0]?.[0]) rows[0][0] = rows[0][0].replace(/^\uFEFF/, "");
  return rows;
}

function normalizeHeader(value) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function mapCsvRecord(type, row) {
  if (type === "expenses") {
    return {
      date: row.date,
      vendor: row.vendor,
      category: row.category === "Miscellaneous" ? "Other" : row.category,
      amount: row.amount,
      notes: row.notes,
    };
  }
  if (type === "inventory") {
    return {
      ingredientName: row.ingredientname,
      quantity: row.quantity,
      unit: row.unit?.toLowerCase(),
      minimumThreshold: row.minimumthreshold,
      supplier: row.supplier,
      costPerUnit: row.costperunit,
    };
  }
  return {
    date: row.date,
    product: row.product,
    quantitySold: row.quantitysold,
    saleAmount: row.saleamount,
  };
}

function formatDateTime(value) {
  return new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
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
