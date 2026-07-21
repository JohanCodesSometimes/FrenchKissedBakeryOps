const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const numberFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
const unitOptions = ["lb", "oz", "g", "kg", "count", "dozen", "gallon"];
const receiptUnitOptions = [...unitOptions, "unknown"];
const SALES_POLL_INTERVAL_MS = 12_000;
const SALES_POLL_OVERLAP_MS = 60_000;
const SALES_POLL_MAX_BACKOFF_MS = 60_000;
const SYSTEM_STATUS_TIMEOUT_MS = 4_000;

let appData = null;
let appSettings = null;
let priceHistory = [];
let activityLog = [];
let receiptsData = [];
let customersData = [];
let customerInsights = null;
let activeView = "dashboard-view";
let dashboardRefreshPromise = null;
let salesCursor = "";
let squareStatusData = null;
let healthStatusData = null;
let squareStatusRequest = null;
let ownerStatusUnavailable = false;
const loadedViews = new Set(["dashboard-view"]);
const dialogTriggers = new WeakMap();
const inertPollController = { start: () => Promise.resolve(false), stop() {}, update() {} };
const salesPollController = globalThis.BakeryLiveSales?.createPollController
  ? globalThis.BakeryLiveSales.createPollController({
    poll: pollSalesUpdates,
    onStatus: renderLiveSalesStatus,
    baseDelay: SALES_POLL_INTERVAL_MS,
    maxDelay: SALES_POLL_MAX_BACKOFF_MS,
  })
  : inertPollController;
const contactsPollController = globalThis.BakeryContactsPolling?.createPollController
  ? globalThis.BakeryContactsPolling.createPollController({ poll: refreshCustomers, interval: 30_000 })
  : inertPollController;
let systemStatusController = null;

const viewConfig = {
  "dashboard-view": { title: "Dashboard", action: "Add Sale", dialog: "sale-dialog" },
  "expenses-view": { title: "Expenses", action: "Add Expense", dialog: "expense-dialog" },
  "receipts-view": { title: "Receipts" },
  "inventory-view": { title: "Inventory", action: "Add Item", dialog: "inventory-dialog" },
  "recipes-view": { title: "Recipe Costing", action: "Create Recipe", dialog: "recipe-dialog" },
  "sales-view": { title: "Sales", action: "Add Sale", dialog: "sale-dialog" },
  "customers-view": { title: "Contacts" },
  "trends-view": { title: "Trend Finder" },
  "reports-view": { title: "Monthly Reports" },
  "shopping-view": { title: "Purchasing Intelligence" },
  "activity-view": { title: "Activity Log" },
  "settings-view": { title: "Owner Settings" },
};

try {
  initialize();
} catch (error) {
  logClientInitializationError("ApplicationInitializationError", error);
  globalThis.BakeryAppShell?.showStatusUnavailable("Status checks unavailable");
  globalThis.BakeryAppShell?.unlockInterface();
}

function initialize() {
  bindEvents();
  globalThis.BakeryAppShell?.unlockInterface();
  applySavedTheme();
  document.querySelector("#current-date").textContent = new Date().toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
  document.querySelector("#report-month").value = localDateKey(new Date()).slice(0, 7);
  initializeSystemStatusChecklist();
  void refreshDashboard();
  void refreshSettings({ background: true });
  void salesPollController.start({ immediate: true });
  updateContactsPolling({ refresh: false });
  document.addEventListener("visibilitychange", handlePageVisibility);
  window.addEventListener("pagehide", () => {
    systemStatusController?.stop();
    salesPollController.stop();
    contactsPollController.stop();
  });
  window.addEventListener("pageshow", () => {
    retryLiveSales();
    void retrySystemStatus();
    updateContactsPolling({ refresh: activeView === "customers-view" });
  });
}

function initializeSystemStatusChecklist() {
  try {
    const statusApi = globalThis.BakerySystemStatus;
    if (typeof statusApi?.createController !== "function") throw new ReferenceError("SystemStatusController is unavailable");
    systemStatusController = statusApi.createController({
      timeoutMs: SYSTEM_STATUS_TIMEOUT_MS,
      checks: {
        health: async ({ signal }) => {
          const response = await fetch("/api/health", { cache: "no-store", signal });
          if (!response.ok) throw new Error("Health check failed");
          return response.json();
        },
        square: ({ signal }) => requestSquareStatus({ signal }),
        owner: async () => {
          if (!appData?.ownerStatus) await refreshDashboard({ showError: false });
          if (!appData?.ownerStatus) throw new Error("Owner status is unavailable");
          return appData.ownerStatus;
        },
      },
      onStart(name) {
        if (name === "health") healthStatusData = null;
        if (name === "square") squareStatusData = null;
        if (name === "owner") ownerStatusUnavailable = false;
        renderSystemStatus();
      },
      onResult(name, result) {
        if (name === "health") healthStatusData = result.status === "fulfilled" ? result.value : { unavailable: true };
        if (name === "square") {
          squareStatusData = result.status === "fulfilled" ? result.value : { unavailable: true };
          if (!squareStatusData.unavailable) renderSquareSettingsStatus(squareStatusData);
        }
        if (name === "owner") ownerStatusUnavailable = result.status === "rejected" && !appData?.ownerStatus;
        renderSystemStatus();
      },
      onStateChange() {
        updateSystemStatusRetryButton();
      },
    });
    globalThis.BakeryAppShell?.setStatusRunner((names) => refreshSystemStatus(names));
    renderSystemStatus();
    void refreshSystemStatus();
  } catch (error) {
    logClientInitializationError("SystemStatusInitializationError", error);
    globalThis.BakeryAppShell?.showStatusUnavailable("Status checks unavailable");
  }
}

function logClientInitializationError(kind, error) {
  const name = String(error?.name || "ClientError");
  const message = String(error?.message || "Client initialization failed").slice(0, 240);
  console.error(`[BakeryOps] ${kind}: ${name}: ${message}`);
}

function bindEvents() {
  document.querySelector("#theme-toggle").addEventListener("click", toggleTheme);
  document.querySelector("#recipe-search").addEventListener("input", renderRecipes);
  document.querySelector("#add-ingredient-row").addEventListener("click", () => addIngredientRow());
  document.querySelector("#refresh-report").addEventListener("click", refreshReport);
  document.querySelector("#report-month").addEventListener("change", refreshReport);
  document.querySelector("#refresh-shopping").addEventListener("click", refreshShoppingList);
  document.querySelector("#refresh-customers").addEventListener("click", refreshCustomers);
  document.querySelector("#sales-retry").addEventListener("click", retryLiveSales);
  document.querySelector("#system-status-retry").addEventListener("click", () => { void retrySystemStatus(); });
  document.querySelector("#database-status-retry").addEventListener("click", () => { void retrySystemStatus(["health", "owner"]); });
  document.querySelector("#customer-sort").addEventListener("change", refreshCustomers);
  document.querySelector("#settings-form").addEventListener("submit", saveSettings);
  document.querySelector("#square-disconnect").addEventListener("click", disconnectSquare);
  document.querySelector("#square-sync").addEventListener("click", syncRecentSquareSales);
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
    if (openButton) return openEntryDialog(openButton.dataset.openDialog, null, openButton);

    const closeButton = event.target.closest("[data-close-dialog]");
    if (closeButton) return closeButton.closest("dialog").close();

    const editButton = event.target.closest("[data-edit-type]");
    if (editButton) return editRecord(editButton.dataset.editType, editButton.dataset.recordId, editButton);

    const deleteButton = event.target.closest("[data-delete-type]");
    if (deleteButton) return confirmDeleteRecord(deleteButton.dataset.deleteType, deleteButton.dataset.recordId, deleteButton);

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
      if (event.target === dialog && !dialog.querySelector('[type="submit"]:disabled')) dialog.close();
    });
    dialog.addEventListener("cancel", (event) => {
      if (dialog.querySelector('[type="submit"]:disabled')) event.preventDefault();
    });
    dialog.addEventListener("close", () => {
      const trigger = dialogTriggers.get(dialog);
      dialogTriggers.delete(dialog);
      trigger?.focus?.({ preventScroll: true });
    });
  });
  bindConfirmationDialog();

  bindCrudForm("expense-form", "expenses", "Expense saved");
  bindCrudForm("inventory-form", "inventory", "Inventory item saved");
  bindCrudForm("sale-form", "sales", "Sale saved");
  bindCrudForm("recipe-form", "recipes", "Recipe saved", buildRecipePayload);
}

async function parseReceipt(file) {
  if (!file) return;
  const input = document.querySelector("#receipt-upload");
  const progress = document.querySelector("#receipt-progress");
  const progressBar = document.querySelector("#receipt-progress-bar");
  const progressLabel = document.querySelector("#receipt-progress-label");
  const progressValue = document.querySelector("#receipt-progress-value");
  input.value = "";

  if (!/\.(jpe?g|png)$/i.test(file.name) || file.type && !["image/jpeg", "image/jpg", "image/png"].includes(file.type)) {
    return showNotice("Only JPG, JPEG, and PNG receipt images are supported", "error");
  }
  if (file.size > 15 * 1024 * 1024) return showNotice("Receipt image must be 15 MB or smaller", "error");

  progress.hidden = false;
  progressBar.value = 0;
  progressLabel.textContent = "Uploading receipt";
  progressValue.textContent = "0%";
  try {
    const receipt = await uploadReceipt(file, (percent) => {
      progressBar.value = percent;
      progressValue.textContent = `${percent}%`;
      if (percent === 100) {
        progressBar.removeAttribute("value");
        progressLabel.textContent = "Reading receipt";
        progressValue.textContent = "Working";
      }
    });
    renderReceiptReview(receipt);
    document.querySelector("#receipt-review-panel").hidden = false;
    document.querySelector("#receipt-review-panel").scrollIntoView({ behavior: "smooth", block: "start" });
    showNotice("Receipt ready for review", "success");
  } catch (error) {
    showNotice(error.message, "error");
  } finally {
    progress.hidden = true;
    progressBar.value = 0;
    await refreshReceipts();
  }
}

function uploadReceipt(file, onProgress) {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", "/api/receipts/parse");
    request.setRequestHeader("Content-Type", file.type || (/\.png$/i.test(file.name) ? "image/png" : "image/jpeg"));
    request.setRequestHeader("X-File-Name", encodeURIComponent(file.name));
    request.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100));
    });
    request.addEventListener("load", () => {
      let result = {};
      try { result = JSON.parse(request.responseText || "{}"); }
      catch { return reject(new Error("AI parsing failed")); }
      if (request.status < 200 || request.status >= 300) {
        return reject(new Error(result.error || "AI parsing failed"));
      }
      resolve(result);
    });
    request.addEventListener("error", () => reject(new Error("Receipt upload failed")));
    request.addEventListener("abort", () => reject(new Error("Receipt upload was canceled")));
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

  const warningPanel = document.querySelector("#receipt-review-warnings");
  const warnings = Array.isArray(receipt.warnings) ? receipt.warnings : [];
  warningPanel.hidden = !warnings.length;
  warningPanel.innerHTML = warnings.length
    ? `<strong>Check these extracted details</strong><p>Confidence: ${Math.round(Number(receipt.confidence || 0) * 100)}%</p><ul>${warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join("")}</ul>`
    : "";

  document.querySelector("#receipt-review-items").innerHTML = receipt.items.map((item) => {
    const flags = [item.isDiscount && "Discount", item.isFee && "Fee", item.isDeposit && "Deposit"].filter(Boolean);
    return `
    <tr class="receipt-item-row">
      <td>
        <input name="itemName" type="text" maxlength="160" value="${escapeHtml(item.itemName)}" title="${escapeHtml(item.rawLine || "")}" required />
        <input name="rawLine" type="hidden" value="${escapeHtml(item.rawLine || "")}" />
        <input name="isDiscount" type="hidden" value="${Boolean(item.isDiscount)}" />
        <input name="isFee" type="hidden" value="${Boolean(item.isFee)}" />
        <input name="isDeposit" type="hidden" value="${Boolean(item.isDeposit)}" />
        ${flags.length ? `<span class="receipt-line-flags">${flags.join(" / ")}</span>` : ""}
      </td>
      <td><input name="quantity" type="number" min="0.01" step="0.01" value="${Number(item.quantity)}" required /></td>
      <td><select name="unit">${selectOptions(receiptUnitOptions, item.unit)}</select></td>
      <td><input name="unitPrice" type="number" min="0" step="0.01" value="${Number(item.unitPrice).toFixed(2)}" required /></td>
      <td><input name="totalPrice" type="number" step="0.01" value="${Number(item.totalPrice).toFixed(2)}" required /></td>
      <td><select name="category">${selectOptions(["Ingredients", "Packaging", "Equipment", "Utilities", "Other"], item.category)}</select></td>
      <td><input name="updateInventory" type="checkbox" ${item.updateInventory ? "checked" : ""} aria-label="Update inventory for ${escapeHtml(item.itemName)}" /></td>
    </tr>`;
  }).join("");
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
      rawLine: row.querySelector('[name="rawLine"]').value,
      quantity: row.querySelector('[name="quantity"]').value,
      unit: row.querySelector('[name="unit"]').value,
      unitPrice: row.querySelector('[name="unitPrice"]').value,
      totalPrice: row.querySelector('[name="totalPrice"]').value,
      category: row.querySelector('[name="category"]').value,
      updateInventory: row.querySelector('[name="updateInventory"]').checked,
      isDiscount: row.querySelector('[name="isDiscount"]').value === "true",
      isFee: row.querySelector('[name="isFee"]').value === "true",
      isDeposit: row.querySelector('[name="isDeposit"]').value === "true",
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
  document.querySelector("#receipt-review-warnings").hidden = true;
  document.querySelector("#receipt-review-warnings").innerHTML = "";
}

function selectOptions(options, selected) {
  return options.map((option) => `<option value="${escapeHtml(option)}" ${option === selected ? "selected" : ""}>${escapeHtml(option)}</option>`).join("");
}

function showView(viewId) {
  if (!viewConfig[viewId]) return;
  activeView = viewId;
  document.querySelectorAll(".page-view").forEach((view) => {
    const active = view.id === viewId;
    view.hidden = !active;
    view.classList.toggle("active", active);
  });
  document.querySelectorAll(".nav-list [data-view-target]").forEach((button) => {
    const active = button.dataset.viewTarget === viewId;
    button.classList.toggle("active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });

  const config = viewConfig[viewId];
  document.querySelector("#page-title").textContent = config.title;
  const action = document.querySelector("#page-action");
  action.hidden = !config.action;
  if (config.action) {
    action.textContent = config.action;
    action.dataset.openDialog = config.dialog;
  }
  updateContactsPolling({ refresh: viewId === "customers-view" });
  void loadViewData(viewId);
  window.scrollTo({ top: 0, behavior: "smooth" });
  requestAnimationFrame(() => document.querySelector("#page-title").focus({ preventScroll: true }));
}

async function refreshAllData() {
  await refreshDashboard();
  await loadViewData(activeView, { force: true });
  if (activeView === "dashboard-view") void refreshSystemStatus();
}

async function loadViewData(viewId, { force = false } = {}) {
  if (!force && loadedViews.has(viewId)) return;
  const loaders = {
    "receipts-view": () => refreshReceipts(),
    "inventory-view": () => refreshPriceHistory(),
    "customers-view": () => Promise.resolve(),
    "reports-view": () => refreshReport(),
    "shopping-view": () => refreshShoppingList(),
    "activity-view": () => refreshActivity(),
    "settings-view": () => Promise.allSettled([refreshSettings(), refreshSquareStatus()]),
  };
  const loader = loaders[viewId];
  if (!loader) return loadedViews.add(viewId);
  await loader();
  loadedViews.add(viewId);
}

function updateContactsPolling({ refresh = false } = {}) {
  contactsPollController.update({
    active: activeView === "customers-view",
    visible: !document.hidden,
    refresh,
  });
}

async function refreshCustomers({ background = false } = {}) {
  try {
    const sort = document.querySelector("#customer-sort")?.value || "latestPurchase";
    const [customersResponse, insightsResponse] = await Promise.all([
      fetch(`/api/customers?sort=${encodeURIComponent(sort)}`, { credentials: "same-origin", cache: "no-store" }),
      fetch("/api/customer-insights", { credentials: "same-origin", cache: "no-store" }),
    ]);
    if (!customersResponse.ok || !insightsResponse.ok) throw new Error("Could not load customer contacts");
    customersData = await customersResponse.json();
    customerInsights = await insightsResponse.json();
    renderCustomers();
    clearSectionError("customers-view");
    return true;
  } catch (error) {
    showSectionError("customers-view", "Contacts are temporarily unavailable.", error.message, background);
    return false;
  }
}

function renderCustomers() {
  const topCustomer = customerInsights?.topCustomers?.[0];
  setText("#customer-top-name", topCustomer?.name || "No customers yet");
  setText("#customer-top-spend", topCustomer ? `${money.format(topCustomer.totalSpend)} total spend` : "Sales with contact details will appear here");
  setText("#customer-repeat-count", numberFormat.format(customerInsights?.repeatCustomers || 0));
  setText("#customer-inactive-count", numberFormat.format(customerInsights?.recentlyInactiveCustomers || 0));
  setText("#customer-new-count", numberFormat.format(customerInsights?.newCustomersThisMonth || 0));

  const body = document.querySelector("#customers-body");
  body.innerHTML = customersData.length
    ? customersData.map((customer) => `<tr>
        <td><strong>${escapeHtml(customer.name || "Square Customer")}</strong></td>
        <td>${escapeHtml(customer.email || "Not provided")}</td>
        <td>${escapeHtml(customer.phone || "Not provided")}</td>
        <td>${money.format(customer.totalSpend || 0)}</td>
        <td>${numberFormat.format(customer.visitCount || 0)}</td>
        <td>${customer.latestPurchaseDate ? formatDate(customer.latestPurchaseDate) : "Not available"}</td>
        <td>${escapeHtml(customer.favoriteProduct || "Not enough history")}</td>
      </tr>`).join("")
    : tableEmpty(7, "No customers yet", "Customers will appear when a Square sale includes contact information.");
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
    clearSectionError("receipts-view");
    return true;
  } catch (error) {
    showSectionError("receipts-view", "Receipts could not load.", error.message);
    return false;
  }
}

function formatFileSize(bytes) {
  const size = Number(bytes || 0);
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

async function refreshSquareStatus({ background = false } = {}) {
  try {
    const status = await requestSquareStatus();
    squareStatusData = status;
    renderSquareSettingsStatus(status);
    clearSectionError("settings-view", "square");
    renderSystemStatus();
    return status;
  } catch (error) {
    squareStatusData = { unavailable: true };
    renderSystemStatus();
    showSectionError("settings-view", "Square status is temporarily unavailable.", error.message, background, "square");
    return null;
  }
}

function requestSquareStatus({ signal } = {}) {
  if (squareStatusRequest) return squareStatusRequest;
  const request = fetch("/api/square/status", { cache: "no-store", signal }).then(async (response) => {
    if (!response.ok) throw new Error("Could not load Square status");
    return response.json();
  });
  const sharedRequest = request.finally(() => {
    if (squareStatusRequest === sharedRequest) squareStatusRequest = null;
  });
  squareStatusRequest = sharedRequest;
  return sharedRequest;
}

function renderSquareSettingsStatus(status) {
  const badge = document.querySelector("#square-status-badge");
  const connect = document.querySelector("#square-connect");
  const disconnect = document.querySelector("#square-disconnect");
  const sync = document.querySelector("#square-sync");
  badge.textContent = status.connected ? "Connected" : status.configured ? "Not connected" : "Setup required";
  badge.classList.toggle("connected", status.connected);
  document.querySelector("#square-status-copy").textContent = status.connected
      ? "Completed Square payments will sync into Sales automatically."
      : status.configured
        ? "Connect the bakery owner's Square account to begin syncing sales."
        : "Square setup must be completed before connecting.";
  document.querySelector("#square-environment").textContent = titleCase(status.environment);
  document.querySelector("#square-merchant").textContent = status.merchantId || "Not connected";
  document.querySelector("#square-last-sync").textContent = status.lastSyncAt ? formatDateTime(status.lastSyncAt) : "Never";
  const needsCustomerReconnect = status.connected && !status.customerReadEnabled;
  if (needsCustomerReconnect) {
    document.querySelector("#square-status-copy").textContent = "Reconnect Square once to display customer names and phone numbers.";
  }
  connect.hidden = status.connected && !needsCustomerReconnect;
  connect.textContent = needsCustomerReconnect ? "Reconnect for Customer Details" : "Connect Square";
  connect.setAttribute("aria-disabled", String(!status.configured));
  connect.onclick = status.configured ? null : (event) => event.preventDefault();
  disconnect.hidden = !status.connected;
  sync.hidden = !status.connected;
  sync.disabled = !status.connected;
  if (status.lastError) document.querySelector("#square-status-copy").textContent += " Square reported a recent connection problem.";
}

function refreshSystemStatus(names = ["health", "square", "owner"]) {
  if (!systemStatusController) {
    globalThis.BakeryAppShell?.showStatusUnavailable("Status checks unavailable");
    return Promise.resolve([]);
  }
  return systemStatusController.run(names);
}

function unavailableSystemChecks() {
  const unavailable = [];
  if (healthStatusData?.unavailable) unavailable.push("health");
  if (squareStatusData?.unavailable) unavailable.push("square");
  if (ownerStatusUnavailable) unavailable.push("owner");
  return unavailable;
}

function retrySystemStatus(names = unavailableSystemChecks()) {
  if (!names.length) return Promise.resolve([]);
  return refreshSystemStatus(names);
}

function updateSystemStatusRetryButton() {
  const button = document.querySelector("#system-status-retry");
  if (!button) return;
  const running = Boolean(systemStatusController?.isRunning());
  const unavailable = unavailableSystemChecks();
  button.hidden = !running && unavailable.length === 0;
  button.disabled = running;
  button.textContent = running ? "Checking…" : "Retry checks";
}

function renderSystemStatus() {
  const ownerStatus = appData?.ownerStatus;
  const pending = !healthStatusData || !squareStatusData || (!ownerStatus && !ownerStatusUnavailable);
  const square = !squareStatusData
    ? { label: "Checking…", detail: "Connection check in progress", state: "pending" }
    : squareStatusData.unavailable
      ? { label: "Temporarily unavailable", detail: "Retry the Square check", state: "unavailable", action: "Retry" }
      : squareStatusData.connected
        ? { label: "Connected", detail: "Sales can sync automatically", state: "ready" }
        : { label: squareStatusData.configured ? "Needs connection" : "Needs setup", detail: squareStatusData.configured ? "Connect the bakery Square account" : "Complete Square setup", state: "needs-attention", action: "Connect Square" };
  const receipt = ownerStatusUnavailable
    ? { label: "Temporarily unavailable", detail: "Retry the dashboard check", state: "unavailable", action: "Retry" }
    : !ownerStatus
    ? { label: "Checking…", detail: "Availability check in progress", state: "pending" }
    : ownerStatus.receiptAiAvailable
      ? { label: "Ready", detail: "Receipt images can be read", state: "ready" }
      : { label: "Needs setup", detail: "Manual entry remains available", state: "needs-attention", action: "Open Receipts" };
  const database = !healthStatusData
    ? { label: "Checking…", detail: "Connection check in progress", state: "pending" }
    : healthStatusData.unavailable || !healthStatusData.database?.ready
      ? { label: "Temporarily unavailable", detail: "The application is retrying the database", state: "unavailable", action: "Retry" }
      : { label: "Ready", detail: "Operational data is available", state: "ready" };
  const lastSale = ownerStatusUnavailable
    ? { label: "Temporarily unavailable", detail: "Retry the dashboard check", state: "unavailable" }
    : !ownerStatus
    ? { label: "Checking…", detail: "Sales check in progress", state: "pending" }
    : ownerStatus.lastSquareSale
      ? { label: formatDateTime(ownerStatus.lastSquareSale.receivedAt || ownerStatus.lastSquareSale.date), detail: ownerStatus.lastSquareSale.product || "Square sale received", state: "ready" }
      : { label: "None received yet", detail: "The latest Square sale will appear here", state: "neutral" };
  const inventory = ownerStatusUnavailable
    ? { label: "Temporarily unavailable", detail: "Retry the dashboard check", state: "unavailable", action: "Retry" }
    : !ownerStatus
    ? { label: "Checking…", detail: "Setup check in progress", state: "pending" }
    : ownerStatus.inventoryConfigured
      ? { label: "Ready", detail: `${numberFormat.format(appData.counts.inventory)} items tracked`, state: "ready" }
      : { label: "Needs setup", detail: "Add ingredients to enable stock alerts", state: "needs-attention", action: "Set up Inventory" };

  renderSystemStatusItem("#status-square", square);
  renderSystemStatusItem("#status-receipt-ai", receipt);
  renderSystemStatusItem("#status-database", database);
  renderSystemStatusItem("#status-last-square-sale", lastSale);
  renderSystemStatusItem("#status-inventory", inventory);
  const summary = document.querySelector("#system-status-summary");
  const needsAction = [square, receipt, database, inventory].some((item) => ["needs-attention", "unavailable"].includes(item.state));
  summary.className = `system-status-summary ${pending ? "pending" : needsAction ? "action-required" : ""}`.trim();
  summary.textContent = pending ? "Checks are still in progress." : needsAction ? "Action required: review the items marked below." : "All checked systems are ready.";
  updateSystemStatusRetryButton();
}

function renderSystemStatusItem(selector, status) {
  const item = document.querySelector(selector);
  if (!item) return;
  item.className = `system-status-item ${status.state}`;
  item.querySelector("strong").textContent = status.label;
  item.querySelector("small").textContent = status.detail;
  const action = item.querySelector("button");
  if (action) {
    action.hidden = !status.action;
    if (status.action) action.textContent = status.action;
    if (status.action === "Retry" && selector !== "#status-database") {
      action.removeAttribute("data-view-target");
      const retryNames = selector === "#status-square" ? ["square"] : ["owner"];
      action.onclick = () => { void retrySystemStatus(retryNames); };
    } else if (selector !== "#status-database") {
      const viewTargets = {
        "#status-square": "settings-view",
        "#status-receipt-ai": "receipts-view",
        "#status-inventory": "inventory-view",
      };
      if (viewTargets[selector]) action.dataset.viewTarget = viewTargets[selector];
      action.onclick = null;
    }
  }
}

async function syncRecentSquareSales() {
  const button = document.querySelector("#square-sync");
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = "Syncing...";
  try {
    const response = await fetch("/api/square/sync", { method: "POST" });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Could not sync Square sales");
    showNotice(
      `Square sync complete: ${result.synced} new, ${result.duplicates} duplicates${result.errors ? `, ${result.errors} errors` : ""}`,
      result.errors ? "info" : "success",
    );
    await refreshAllData();
  } catch (error) {
    showNotice(error.message, "error");
  } finally {
    button.textContent = originalText;
    button.disabled = false;
  }
}

function disconnectSquare(event) {
  openConfirmation({
    trigger: event?.currentTarget || document.activeElement,
    title: "Disconnect Square?",
    message: "BakeryOps will stop receiving and syncing new Square sales until you reconnect.",
    impact: "Existing sales, inventory, recipes, receipts, contacts, and other bakery data will remain unchanged.",
    confirmLabel: "Disconnect Square",
    async onConfirm() {
      const response = await fetch("/api/square/disconnect", { method: "POST" });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(ownerErrorMessage(result, "Square could not be disconnected. Please try again."));
      showNotice("Square disconnected", "success");
      await Promise.allSettled([refreshSquareStatus(), refreshActivity({ background: true })]);
    },
  });
}

function handlePageVisibility() {
  updateContactsPolling({ refresh: !document.hidden && activeView === "customers-view" });
  if (document.hidden) return salesPollController.stop();
  retryLiveSales();
}

function retryLiveSales() {
  if (document.hidden) return;
  void salesPollController.retry();
}

async function pollSalesUpdates() {
  if (document.hidden) return;
  if (!appData || !salesCursor) {
    if (!await refreshDashboard({ showError: false })) throw new Error("Dashboard recovery failed");
    return;
  }
  const pollSince = new Date(Date.parse(salesCursor) - SALES_POLL_OVERLAP_MS).toISOString();
  const response = await fetch(`/api/sales/updates?since=${encodeURIComponent(pollSince)}`, {
    credentials: "same-origin",
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`Sales polling failed (${response.status})`);
  const update = await response.json();
  salesCursor = update.cursor || salesCursor;
  if (!update.sales?.length) return;

  const merged = BakeryLiveSales.mergeSales(appData.sales, update.sales);
  if (!merged.changed) return;
  appData.sales = merged.sales;
  appData.salesSummary = update.salesSummary;
  Object.assign(appData.financials, update.financials);
  appData.counts.sales = update.salesCount;
  appData.productPerformance = update.productPerformance;
  appData.updatedAt = update.cursor;
  if (update.inventory) appData.inventory = update.inventory;
  if (update.customers) {
    customersData = sortCustomerRows(update.customers);
    customerInsights = update.customerInsights;
  }
  renderDashboard();
  if (update.inventory) renderInventory();
  if (update.customers) renderCustomers();
  if (update.purchasingIntelligence) renderShoppingList(update.purchasingIntelligence);
  if (update.ownerStatus) appData.ownerStatus = update.ownerStatus;
  renderSystemStatus();
}

function renderLiveSalesStatus({ state, failures = 0, nextDelay = SALES_POLL_INTERVAL_MS }) {
  const badge = document.querySelector("#sales-connection-status");
  const retry = document.querySelector("#sales-retry");
  if (!badge || !retry) return;
  badge.textContent = state === "live" ? "Live" : state === "offline" ? "Offline" : "Reconnecting";
  badge.className = `status-badge ${state}`;
  retry.hidden = state === "live";
  retry.disabled = state === "reconnecting" && nextDelay === 0;
  if (state !== "live") {
    const seconds = Math.max(1, Math.ceil(nextDelay / 1000));
    setText(
      "#sales-refreshed-at",
      state === "offline"
        ? `Offline after ${failures} attempts - retrying in ${seconds}s`
        : `Reconnecting - retrying in ${seconds}s`,
    );
  }
}

function sortCustomerRows(rows) {
  const sort = document.querySelector("#customer-sort")?.value || "latestPurchase";
  return [...rows].sort((left, right) => sort === "totalSpend"
    ? Number(right.totalSpend || 0) - Number(left.totalSpend || 0)
    : String(right.latestPurchaseDate || "").localeCompare(String(left.latestPurchaseDate || "")));
}

function refreshDashboard({ showError = true } = {}) {
  if (document.hidden) return Promise.resolve(false);
  if (dashboardRefreshPromise) return dashboardRefreshPromise;
  const request = (async () => {
    try {
      const response = await fetch("/api/dashboard", { credentials: "same-origin", cache: "no-store" });
      if (!response.ok) throw new Error("Could not load dashboard data");
      appData = await response.json();
      ownerStatusUnavailable = false;
      salesCursor = appData.salesCursor || appData.updatedAt || salesCursor;
      renderAll();
      clearSectionError("dashboard-view");
      renderLiveSalesStatus({ state: "live" });
      renderSystemStatus();
      return true;
    } catch (error) {
      if (showError) showSectionError("dashboard-view", "Dashboard data could not load.", error.message);
      renderSystemStatus();
      return false;
    } finally {
      if (dashboardRefreshPromise === request) dashboardRefreshPromise = null;
    }
  })();
  dashboardRefreshPromise = request;
  return request;
}

function renderAll() {
  renderDashboard();
  renderExpenses();
  renderInventory();
  renderRecipes();
}

function renderDashboard() {
  renderSalesDependentViews();
  setText("#expenses-month", money.format(appData.financials.expensesThisMonth));
  setText("#low-stock-count", appData.inventory.alerts);
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
}

function renderSalesDependentViews() {
  const financials = appData.financials;
  const summary = appData.salesSummary;
  setText("#summary-today", money.format(summary.todaySales));
  setText("#summary-week", money.format(summary.weekSales));
  setText("#summary-month", money.format(summary.monthSales));
  setText("#summary-average", money.format(summary.averageTicket));
  setText("#summary-transactions", numberFormat.format(summary.totalTransactions));
  setText("#sales-refreshed-at", `Updated ${formatDateTime(appData.updatedAt)} - checks every 12 seconds`);
  renderSalesHistory("#dashboard-sales-history", 9, false);
  setText("#revenue-today", money.format(financials.revenueToday));
  setText("#revenue-month", money.format(financials.revenueThisMonth));
  setText("#estimated-profit", money.format(financials.estimatedProfit));
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
    "#dashboard-sales",
    appData.sales.slice(0, 5).map((item) => ({
      title: item.product,
      detail: formatDate(item.date),
      value: money.format(item.saleAmount),
    })),
    "No sales recorded yet",
  );
  renderSales();
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
  const inventory = appData.inventory;
  setText("#inventory-total-items", numberFormat.format(inventory.summary.totalTrackedItems));
  setText("#inventory-alert-total", numberFormat.format(inventory.summary.lowStockCount));
  setText("#inventory-total-value", money.format(inventory.summary.estimatedInventoryValue));
  setText("#inventory-recent-count", numberFormat.format(inventory.summary.recentlyUpdatedCount));
  setText(
    "#inventory-recent-items",
    inventory.recentlyUpdatedItems.length
      ? inventory.recentlyUpdatedItems.slice(0, 3).map((item) => item.ingredientName).join(", ")
      : "No updates yet",
  );

  const alertsBody = document.querySelector("#inventory-alerts-body");
  if (!inventory.all.length) {
    alertsBody.innerHTML = tableEmpty(4, "No inventory items added yet", "Add inventory to begin monitoring stock levels.");
  } else if (!inventory.lowStock.length) {
    alertsBody.innerHTML = tableEmpty(4, "Everything is stocked", "No items are at or below their minimum threshold.");
  } else {
    alertsBody.innerHTML = inventory.lowStock.map((item) => `<tr>
      <td><strong>${escapeHtml(item.ingredientName)}</strong></td>
      <td>${numberFormat.format(item.quantity)} ${escapeHtml(item.unit)}</td>
      <td>${numberFormat.format(item.minimumThreshold)} ${escapeHtml(item.unit)}</td>
      <td>${inventoryStatusBadge(item.status)}</td>
    </tr>`).join("");
  }

  const body = document.querySelector("#inventory-body");
  if (!inventory.all.length) {
    body.innerHTML = tableEmpty(10, "No inventory items added yet", "Add the first item or approve receipt items to begin tracking stock.");
    return;
  }
  body.innerHTML = inventory.all.map((item) => `<tr>
    <td><strong>${escapeHtml(item.ingredientName)}</strong></td>
    <td>${escapeHtml(item.category)}</td>
    <td>${numberFormat.format(item.quantity)}</td>
    <td>${escapeHtml(item.unit)}</td>
    <td>${numberFormat.format(item.minimumThreshold)}</td>
    <td>${money.format(item.costPerUnit)}</td>
    <td>${money.format(item.estimatedTotalValue)}</td>
    <td>${item.lastUpdated ? formatDateTime(item.lastUpdated) : "Not available"}</td>
    <td>${inventoryStatusBadge(item.status)}</td>
    <td>${rowActions("inventory", item.id)}</td>
  </tr>`).join("");
}

function inventoryStatusBadge(status) {
  const className = status === "Out of Stock" ? "danger-pill" : status === "Low Stock" ? "warning-pill" : "good-pill";
  return `<span class="pill ${className}">${escapeHtml(status)}</span>`;
}

function renderRecipes() {
  const body = document.querySelector("#recipe-profitability-body");
  if (!appData) return;
  const query = document.querySelector("#recipe-search").value.trim().toLowerCase();
  const recipes = appData.recipes.filter(
    (recipe) =>
      !query ||
      recipe.recipeName.toLowerCase().includes(query) ||
      recipe.category.toLowerCase().includes(query),
  );
  if (!recipes.length) {
    body.innerHTML = tableEmpty(
      7,
      appData.recipes.length ? "No matching recipes" : "No recipes created yet",
      appData.recipes.length ? "Try another search." : "Create the first recipe to calculate food cost and profit.",
    );
    return;
  }
  body.innerHTML = recipes.map((recipe) => {
    const available = recipe.allCostsAvailable;
    const margin = available ? `${numberFormat.format(recipe.profitMargin)}%` : "Incomplete";
    return `<tr>
      <td><strong>${escapeHtml(recipe.recipeName)}</strong><span class="table-subtext">${escapeHtml(recipe.category)}</span></td>
      <td>${available ? money.format(recipe.costPerUnit) : "Incomplete"}</td>
      <td>${money.format(recipe.sellingPrice)}</td>
      <td>${available ? money.format(recipe.profitPerUnit) : "Incomplete"}</td>
      <td>${margin}</td>
      <td>${recipe.lastUpdated ? formatDateTime(recipe.lastUpdated) : "Not available"}</td>
      <td><div class="table-actions">
        <button class="table-action" type="button" data-view-recipe="${recipe.id}">View</button>
        <button class="table-action" type="button" data-edit-type="recipes" data-record-id="${recipe.id}">Edit</button>
        <button class="table-action" type="button" data-duplicate-recipe="${recipe.id}">Copy</button>
        <button class="table-action danger" type="button" data-delete-type="recipes" data-record-id="${recipe.id}">Delete</button>
      </div></td>
    </tr>`;
  }).join("");
}

function renderSales() {
  setText("#sales-daily", money.format(appData.financials.revenueToday));
  setText("#sales-weekly", money.format(appData.financials.revenueThisWeek));
  setText("#sales-monthly", money.format(appData.financials.revenueThisMonth));
  setText("#sales-average", money.format(appData.salesSummary.averageTicket));
  setText("#sales-transactions", numberFormat.format(appData.salesSummary.totalTransactions));
  const body = document.querySelector("#sales-body");
  if (!appData.sales.length) {
    body.innerHTML = tableEmpty(10, "No sales recorded yet", "Completed Square sales and manual entries will appear here.");
  } else {
    body.innerHTML = appData.sales
      .map(
        (sale) => `<tr><td>${formatDate(sale.date)}</td><td><strong>${escapeHtml(sale.product)}</strong></td><td>${numberFormat.format(sale.quantitySold)}</td><td>${money.format(sale.saleAmount)}</td><td>${money.format(sale.refundedAmount || 0)}</td><td>${saleStatusBadge(sale.status)}</td><td>${money.format(sale.tax || 0)}</td><td>${money.format(sale.discount || 0)}</td><td>${sourceBadge(sale.source)}</td><td>${rowActions("sales", sale.id)}</td></tr>`,
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

function renderSalesHistory(selector, columns, includeActions) {
  const body = document.querySelector(selector);
  if (!appData.sales.length) {
    body.innerHTML = tableEmpty(columns, "No sales recorded yet", "Completed Square sales and manual entries will appear here.");
    return;
  }
  body.innerHTML = appData.sales.map((sale) => `<tr>
    <td>${formatDate(sale.date)}</td><td><strong>${escapeHtml(sale.product)}</strong></td>
    <td>${numberFormat.format(sale.quantitySold)}</td><td>${money.format(sale.saleAmount)}</td>
    <td>${money.format(sale.refundedAmount || 0)}</td><td>${saleStatusBadge(sale.status)}</td>
    <td>${money.format(sale.tax || 0)}</td><td>${money.format(sale.discount || 0)}</td>
    <td>${sourceBadge(sale.source)}</td>${includeActions ? `<td>${rowActions("sales", sale.id)}</td>` : ""}
  </tr>`).join("");
}

function sourceBadge(source) {
  return `<span class="source-badge ${escapeHtml(source || "manual")}">${escapeHtml(titleCase(source || "manual"))}</span>`;
}

function saleStatusBadge(status = "completed") {
  const normalized = String(status || "completed").toLowerCase();
  const className = ["refunded", "canceled", "failed"].includes(normalized)
    ? "danger-pill"
    : normalized === "partially_refunded" || normalized === "pending" ? "warning-pill" : "good-pill";
  return `<span class="pill ${className}">${escapeHtml(titleCase(normalized.replaceAll("_", " ")))}</span>`;
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

function openEntryDialog(dialogId, record = null, trigger = document.activeElement) {
  const dialog = document.querySelector(`#${dialogId}`);
  dialogTriggers.set(dialog, trigger);
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

function editRecord(type, id, trigger) {
  const source = type === "inventory" ? appData.inventory.all : appData[type];
  const record = source.find((item) => item.id === id);
  if (!record) return showNotice("Record not found", "error");
  openEntryDialog(`${type.replace(/s$/, "")}-dialog`, record, trigger);
}

function confirmDeleteRecord(type, id, trigger) {
  const labels = { expenses: "expense", inventory: "inventory item", sales: "sale", recipes: "recipe" };
  const label = labels[type] || "record";
  openConfirmation({
    trigger,
    title: `Delete this ${label}?`,
    message: `This will permanently delete the selected ${label}.`,
    impact: type === "expenses"
      ? "This cannot be undone. A linked receipt will remain in receipt history, but its expense link will be removed."
      : "This action cannot be undone.",
    confirmLabel: `Delete ${titleCase(label)}`,
    async onConfirm() {
      const response = await fetch(`/api/${type}/${encodeURIComponent(id)}`, { method: "DELETE" });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(ownerErrorMessage(result, "The record could not be deleted. Please try again."));
      showNotice("Record deleted", "success");
      await refreshAllData();
    },
  });
}

let confirmationAction = null;
let confirmationTrigger = null;

function bindConfirmationDialog() {
  const dialog = document.querySelector("#confirmation-dialog");
  const form = document.querySelector("#confirmation-form");
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!confirmationAction) return;
    const submit = document.querySelector("#confirmation-submit");
    const controls = dialog.querySelectorAll("button");
    controls.forEach((control) => { control.disabled = true; });
    document.querySelector("#confirmation-error").hidden = true;
    submit.textContent = "Working…";
    try {
      await confirmationAction();
      dialog.close("confirmed");
    } catch (error) {
      const errorBox = document.querySelector("#confirmation-error");
      errorBox.textContent = error.message || "The action could not be completed. Please try again.";
      errorBox.hidden = false;
    } finally {
      controls.forEach((control) => { control.disabled = false; });
      submit.textContent = submit.dataset.label || "Confirm";
    }
  });
  dialog.querySelectorAll("[data-confirmation-cancel]").forEach((button) => {
    button.addEventListener("click", () => dialog.close("cancel"));
  });
  dialog.addEventListener("cancel", (event) => {
    if (document.querySelector("#confirmation-submit").disabled) event.preventDefault();
  });
  dialog.addEventListener("close", () => {
    confirmationAction = null;
    const trigger = confirmationTrigger;
    confirmationTrigger = null;
    trigger?.focus?.({ preventScroll: true });
  });
}

function openConfirmation({ trigger, title, message, impact, confirmLabel, onConfirm }) {
  const dialog = document.querySelector("#confirmation-dialog");
  confirmationTrigger = trigger;
  confirmationAction = onConfirm;
  setText("#confirmation-title", title);
  setText("#confirmation-message", message);
  setText("#confirmation-impact", impact);
  const errorBox = document.querySelector("#confirmation-error");
  errorBox.hidden = true;
  errorBox.textContent = "";
  const submit = document.querySelector("#confirmation-submit");
  submit.dataset.label = confirmLabel;
  submit.textContent = confirmLabel;
  dialog.showModal();
  requestAnimationFrame(() => submit.focus());
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
  const currentName = ingredient?.ingredientName || "";
  const hasCurrent = appData.inventory.all.some(
    (item) => item.ingredientName.toLowerCase() === currentName.toLowerCase(),
  );
  const currentOption = currentName && !hasCurrent
    ? `<option value="${escapeHtml(currentName)}" selected>${escapeHtml(currentName)} (cost unavailable)</option>`
    : "";
  const inventoryOptions = appData.inventory.all
    .map((item) => `<option value="${escapeHtml(item.ingredientName)}"${item.ingredientName.toLowerCase() === currentName.toLowerCase() ? " selected" : ""}>${escapeHtml(item.ingredientName)} - ${money.format(item.costPerUnit)} / ${escapeHtml(item.unit)}</option>`)
    .join("");
  const row = document.createElement("div");
  row.className = "ingredient-row";
  row.innerHTML = `<label>Inventory Ingredient<select name="ingredientName" required><option value="">Select ingredient</option>${currentOption}${inventoryOptions}</select></label><label>Quantity Used<input name="ingredientQuantity" type="number" min="0.0001" step="0.0001" value="${ingredient?.quantity ?? ""}" required /></label><label>Unit Used<select name="ingredientUnit" required><option value="">Unit</option>${unitOptions.map((unit) => `<option${ingredient?.unit === unit ? " selected" : ""}>${unit}</option>`).join("")}</select></label><button class="icon-button remove-ingredient" type="button" data-remove-ingredient aria-label="Remove ingredient">&times;</button>`;
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
      (item) => `<tr><td>${escapeHtml(item.ingredientName)}</td><td>${numberFormat.format(item.quantity)} ${escapeHtml(item.unit)}</td><td>${item.costAvailable ? money.format(item.cost) : "Cost unavailable"}</td></tr>`,
    )
    .join("");
  const costValue = recipe.allCostsAvailable ? money.format(recipe.totalRecipeCost) : "Incomplete";
  const suggestions = recipe.suggestedPrices
    ? `<h3>Suggested Prices</h3><div class="recipe-summary suggested-prices"><div><span>50% Margin</span><strong>${money.format(recipe.suggestedPrices.margin50)}</strong></div><div><span>60% Margin</span><strong>${money.format(recipe.suggestedPrices.margin60)}</strong></div><div><span>70% Margin</span><strong>${money.format(recipe.suggestedPrices.margin70)}</strong></div></div>`
    : "";
  document.querySelector("#recipe-detail-content").innerHTML = `<div class="recipe-summary"><div><span>Batch Yield</span><strong>${numberFormat.format(recipe.yieldQuantity)} ${escapeHtml(recipe.yieldUnit)}</strong></div><div><span>Selling Price</span><strong>${money.format(recipe.sellingPrice)}</strong></div><div><span>Total Recipe Cost</span><strong>${costValue}</strong></div><div><span>Cost Per Item</span><strong>${recipe.allCostsAvailable ? money.format(recipe.costPerUnit) : "Incomplete"}</strong></div><div><span>Gross Profit Per Item</span><strong>${recipe.allCostsAvailable ? money.format(recipe.profitPerUnit) : "Incomplete"}</strong></div><div><span>Profit Margin</span><strong>${recipe.allCostsAvailable ? `${recipe.profitMargin}%` : "Incomplete"}</strong></div></div>${suggestions}<h3>Ingredient Cost Breakdown</h3><div class="table-wrap"><table><thead><tr><th>Ingredient</th><th>Quantity Used</th><th>Cost</th></tr></thead><tbody>${breakdown}</tbody></table></div>${recipe.preparationNotes ? `<div class="notes-block"><h3>Preparation notes</h3><p>${escapeHtml(recipe.preparationNotes)}</p></div>` : ""}`;
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

async function refreshSettings({ background = false } = {}) {
  try {
    const response = await fetch("/api/settings");
    if (!response.ok) throw new Error("Could not load settings");
    appSettings = await response.json();
    const form = document.querySelector("#settings-form");
    Object.entries(appSettings).forEach(([key, value]) => {
      if (form.elements.namedItem(key)) form.elements.namedItem(key).value = value ?? "";
    });
    document.querySelector("#brand-name").textContent = appSettings.businessName || "BakeryOps AI";
    clearSectionError("settings-view", "settings");
    return true;
  } catch (error) {
    showSectionError("settings-view", "Owner settings could not load.", error.message, background, "settings");
    return false;
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
    await Promise.allSettled([refreshActivity({ background: true }), refreshShoppingList({ background: true })]);
  } catch (error) {
    showNotice(error.message, "error");
  } finally {
    submit.disabled = false;
  }
}

async function refreshPriceHistory({ background = false } = {}) {
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
    clearSectionError("inventory-view");
    return true;
  } catch (error) {
    showSectionError("inventory-view", "Price history could not load.", error.message, background);
    return false;
  }
}

async function refreshActivity({ background = false } = {}) {
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
    clearSectionError("activity-view");
    return true;
  } catch (error) {
    showSectionError("activity-view", "Activity could not load.", error.message, background);
    return false;
  }
}

async function refreshReport({ background = false } = {}) {
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
    clearSectionError("reports-view");
    return true;
  } catch (error) {
    showSectionError("reports-view", "This report could not load.", error.message, background);
    return false;
  }
}

async function refreshShoppingList({ background = false } = {}) {
  try {
    const response = await fetch("/api/purchasing-intelligence", { cache: "no-store" });
    if (!response.ok) throw new Error("Could not load purchasing forecast");
    renderShoppingList(await response.json());
    clearSectionError("shopping-view");
    return true;
  } catch (error) {
    showSectionError("shopping-view", "Purchasing intelligence could not load.", error.message, background);
    return false;
  }
}

function renderShoppingList(data) {
  setText("#forecast-inventory-value", money.format(data.forecast.inventoryValue));
  setText("#forecast-running-out", numberFormat.format(data.forecast.ingredientsRunningOutThisWeek));
  setText("#forecast-reorder-cost", money.format(data.forecast.estimatedReorderCost));
  setText(
    "#forecast-restock-days",
    data.forecast.projectedDaysUntilRestockRequired === null
      ? "Not enough data"
      : `${numberFormat.format(data.forecast.projectedDaysUntilRestockRequired)} days`,
  );
  setText("#trend-monthly-spending", money.format(data.costTrends.monthlyIngredientSpending));
  setText("#trend-next-order", money.format(data.costTrends.estimatedNextOrderCost));
  renderCostTrend("#trend-biggest-increase", "#trend-biggest-increase-detail", data.costTrends.biggestPriceIncrease);
  renderCostTrend("#trend-biggest-decrease", "#trend-biggest-decrease-detail", data.costTrends.biggestPriceDecrease);

  const reorderBody = document.querySelector("#reorder-recommendations-body");
  reorderBody.innerHTML = data.reorderRecommendations.length
    ? data.reorderRecommendations.map((item) => `<tr>
        <td><strong>${escapeHtml(item.ingredientName)}</strong></td>
        <td>${numberFormat.format(item.currentQuantity)} ${escapeHtml(item.unit)}</td>
        <td>${item.estimatedDailyUsage > 0 ? `${numberFormat.format(item.estimatedDailyUsage)} ${escapeHtml(item.unit)} / day` : "Not enough data"}</td>
        <td>${item.estimatedDaysRemaining === null ? "Not enough data" : `${numberFormat.format(item.estimatedDaysRemaining)} days`}</td>
        <td>${numberFormat.format(item.recommendedReorderQuantity)} ${escapeHtml(item.unit)}</td>
        <td>${urgencyBadge(item.urgency)}</td>
      </tr>`).join("")
    : tableEmpty(6, "No inventory to forecast yet", "Add inventory, recipes, and Square sales to generate recommendations.");

  const historyBody = document.querySelector("#supplier-price-history-body");
  historyBody.innerHTML = data.supplierPriceHistory.length
    ? data.supplierPriceHistory.map((item) => `<tr>
        <td><strong>${escapeHtml(item.ingredientName)}</strong></td>
        <td>${escapeHtml(item.supplier)}</td>
        <td>${item.previousPrice === null ? "No previous price" : money.format(item.previousPrice)}</td>
        <td>${money.format(item.currentPrice)}</td>
        <td>${item.percentChange === null ? "Not enough history" : formatPercentChange(item.percentChange)}</td>
      </tr>`).join("")
    : tableEmpty(5, "No supplier price history yet", "Receipt approvals and inventory price updates will appear here.");
}

function renderCostTrend(valueSelector, detailSelector, trend) {
  setText(valueSelector, trend ? trend.ingredientName : "No history");
  setText(
    detailSelector,
    trend ? `${formatPercentChange(trend.percentChange)} from ${trend.supplier}` : "Add supplier prices to compare",
  );
}

function formatPercentChange(value) {
  const number = Number(value || 0);
  return `${number > 0 ? "+" : ""}${numberFormat.format(number)}%`;
}

function urgencyBadge(urgency) {
  const className = urgency === "Critical" ? "danger-pill" : urgency === "Low" ? "warning-pill" : "good-pill";
  return `<span class="pill ${className}">${escapeHtml(urgency)}</span>`;
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

function ownerErrorMessage(result, fallback) {
  if (typeof result?.error === "string") return result.error;
  if (typeof result?.error?.message === "string") return result.error.message;
  return fallback;
}

function showSectionError(viewId, title, detail, background = false, source = "default") {
  const view = document.querySelector(`#${viewId}`);
  if (!view) return;
  let error = [...view.children].find((child) => child.classList.contains("section-load-error") && child.dataset.errorSource === source);
  if (!error) {
    error = document.createElement("div");
    error.className = "section-load-error";
    error.dataset.errorSource = source;
    view.prepend(error);
  }
  error.replaceChildren();
  const heading = document.createElement("strong");
  const copy = document.createElement("p");
  heading.textContent = title;
  copy.textContent = detail || "Please try again.";
  error.append(heading, copy);
  if (!background && activeView === viewId) error.setAttribute("role", "alert");
  else error.removeAttribute("role");
}

function clearSectionError(viewId, source = "default") {
  const view = document.querySelector(`#${viewId}`);
  [...(view?.children || [])].find((child) => child.classList.contains("section-load-error") && child.dataset.errorSource === source)?.remove();
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
