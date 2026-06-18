const themeButton = document.querySelector("#theme-toggle");
const receiptUpload = document.querySelector("#receipt-upload");
const navLinks = document.querySelectorAll(".nav-list a");
const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const savedTheme = localStorage.getItem("bakeryops-theme");
if (savedTheme === "dark") document.body.classList.add("dark");

document.querySelector("#current-date").textContent = new Date().toLocaleDateString(undefined, {
  weekday: "long",
  month: "long",
  day: "numeric",
  year: "numeric",
});

themeButton.addEventListener("click", () => {
  document.body.classList.toggle("dark");
  localStorage.setItem(
    "bakeryops-theme",
    document.body.classList.contains("dark") ? "dark" : "light",
  );
});

navLinks.forEach((link) => {
  link.addEventListener("click", () => {
    navLinks.forEach((item) => item.classList.remove("active"));
    link.classList.add("active");
  });
});

document.addEventListener("click", async (event) => {
  const openButton = event.target.closest("[data-open-dialog]");
  if (openButton) {
    openDialog(openButton.dataset.openDialog);
    return;
  }

  const closeButton = event.target.closest("[data-close-dialog]");
  if (closeButton) {
    closeButton.closest("dialog").close();
    return;
  }

  const deleteButton = event.target.closest("[data-delete-type]");
  if (deleteButton) await deleteRecord(deleteButton);
});

document.querySelectorAll("dialog").forEach((dialog) => {
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
});

receiptUpload.addEventListener("change", () => {
  const file = receiptUpload.files?.[0];
  if (!file) return;
  showNotice(`${file.name} selected. Enter the receipt totals to save an expense.`);
  openDialog("expense-dialog");
});

bindForm("#expense-form", "expenses", "Expense saved");
bindForm("#sale-form", "sales", "Sale saved");
bindForm("#inventory-form", "inventory", "Inventory item saved");
bindForm("#recipe-form", "recipes", "Recipe saved");

refreshDashboard();

function bindForm(selector, collection, successMessage) {
  const form = document.querySelector(selector);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const submitButton = form.querySelector('[type="submit"]');
    submitButton.disabled = true;

    try {
      const payload = Object.fromEntries(new FormData(form).entries());
      const response = await fetch(`/api/${collection}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Could not save record");

      form.closest("dialog").close();
      form.reset();
      setFormDefaults(form);
      showNotice(successMessage, "success");
      await refreshDashboard();
    } catch (error) {
      showNotice(error.message, "error");
    } finally {
      submitButton.disabled = false;
    }
  });
}

async function deleteRecord(button) {
  const type = button.dataset.deleteType;
  const id = button.dataset.deleteId;
  const label = button.dataset.deleteLabel || "this record";
  if (!window.confirm(`Delete ${label}? This cannot be undone.`)) return;

  button.disabled = true;
  try {
    const response = await fetch(`/api/${type}/${encodeURIComponent(id)}`, { method: "DELETE" });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || "Could not delete record");
    showNotice("Record deleted", "success");
    await refreshDashboard();
  } catch (error) {
    button.disabled = false;
    showNotice(error.message, "error");
  }
}

async function refreshDashboard() {
  try {
    const response = await fetch("/api/dashboard", { credentials: "same-origin" });
    if (!response.ok) throw new Error("Could not load dashboard data");
    const dashboard = await response.json();

    updateFinancials(dashboard.financials);
    updateSummaries(dashboard);
    updateSalesChart(dashboard.sales);
    updateProductMetrics(dashboard.productMetrics);
    updateExpenses(dashboard.expenses);
    updateSales(dashboard.sales);
    updateInventory(dashboard.inventory.all);
    updateRecipes(dashboard.recipes);
  } catch (error) {
    showNotice(error.message, "error");
  }
}

function updateFinancials(financials) {
  setText("#revenue-today", money.format(financials.revenueToday));
  setText("#revenue-week", money.format(financials.revenueThisWeek));
  setText("#revenue-month", money.format(financials.revenueThisMonth));
  setText("#expenses-today", money.format(financials.expensesToday));
  setText("#expenses-week", money.format(financials.expensesThisWeek));
  setText("#expenses-month", money.format(financials.expensesThisMonth));
  setText("#net-profit", money.format(financials.netProfit));
  setText("#profit-margin", `${financials.profitMargin}%`);
}

function updateSummaries(dashboard) {
  setText(
    "#sales-summary",
    dashboard.sales.length
      ? `${dashboard.sales.length} sale${dashboard.sales.length === 1 ? "" : "s"} recorded`
      : "No sales recorded yet",
  );
  setText(
    "#expense-summary",
    dashboard.expenses.length
      ? `${dashboard.expenses.length} expense${dashboard.expenses.length === 1 ? "" : "s"} recorded`
      : "No expenses recorded yet",
  );
  const inventoryCount = Object.keys(dashboard.inventory.all).length;
  setText(
    "#inventory-summary",
    inventoryCount
      ? `${inventoryCount} inventory item${inventoryCount === 1 ? "" : "s"} tracked`
      : "No inventory items added yet",
  );
}

function updateExpenses(expenses) {
  const container = document.querySelector("#expenses-list");
  if (!expenses.length) {
    container.innerHTML = emptyState("No expenses recorded yet", "Add an expense manually. Receipt parsing is not enabled yet.");
    return;
  }

  container.innerHTML = expenses
    .map(
      (expense) => `
        <article class="record-row">
          <div><strong>${escapeHtml(expense.vendor)}</strong><span>${formatDate(expense.date)} &middot; ${escapeHtml(expense.category)}</span></div>
          <div class="record-value"><strong>${money.format(expense.total)}</strong><span>Tax ${money.format(expense.tax)}</span></div>
          <button class="delete-button" type="button" data-delete-type="expenses" data-delete-id="${expense.id}" data-delete-label="expense from ${escapeHtml(expense.vendor)}">Delete</button>
        </article>`,
    )
    .join("");
}

function updateSales(sales) {
  const container = document.querySelector("#sales-list");
  if (!sales.length) {
    container.innerHTML = emptyState("No sales recorded yet", "Manual sales will appear here after they are saved.");
    return;
  }

  container.innerHTML = sales
    .map(
      (sale) => `
        <article class="record-row">
          <div><strong>${escapeHtml(sale.productName)}</strong><span>${formatDate(sale.date)} &middot; Quantity ${formatNumber(sale.quantity)}</span></div>
          <div class="record-value"><strong>${money.format(sale.total)}</strong><span>Tax ${money.format(sale.tax)} &middot; Discounts ${money.format(sale.discounts)}</span></div>
          <button class="delete-button" type="button" data-delete-type="sales" data-delete-id="${sale.id}" data-delete-label="sale for ${escapeHtml(sale.productName)}">Delete</button>
        </article>`,
    )
    .join("");
}

function updateInventory(inventory) {
  const body = document.querySelector("#inventory-body");
  const items = Object.values(inventory);
  if (!items.length) {
    body.innerHTML = `<tr><td colspan="6">${emptyState("No inventory items added yet", "Add an ingredient to begin tracking stock.", "table-empty")}</td></tr>`;
    return;
  }

  body.innerHTML = items
    .map((item) => {
      const low = item.currentQuantity <= item.minimumThreshold;
      return `
        <tr>
          <td><strong>${escapeHtml(item.name)}</strong></td>
          <td>${formatNumber(item.currentQuantity)} ${escapeHtml(item.unit)}</td>
          <td>${formatNumber(item.minimumThreshold)} ${escapeHtml(item.unit)}</td>
          <td>${formatNumber(item.averageWeeklyUsage)} ${escapeHtml(item.unit)}</td>
          <td><span class="pill ${low ? "warning-pill" : "good-pill"}">${low ? "Low stock" : "Healthy"}</span></td>
          <td><button class="delete-button" type="button" data-delete-type="inventory" data-delete-id="${item.id}" data-delete-label="${escapeHtml(item.name)}">Delete</button></td>
        </tr>`;
    })
    .join("");
}

function updateRecipes(recipes) {
  const container = document.querySelector("#recipes-list");
  if (!recipes.length) {
    container.innerHTML = emptyState("No recipes created yet", "Add a recipe to track yield, cost, and selling price.");
    return;
  }

  container.innerHTML = recipes
    .map((recipe) => {
      const costPerUnit = recipe.yieldQuantity ? recipe.totalCost / recipe.yieldQuantity : 0;
      const profitPerUnit = recipe.sellingPrice - costPerUnit;
      return `
        <article class="record-row stacked">
          <div><strong>${escapeHtml(recipe.name)}</strong><span>${formatNumber(recipe.yieldQuantity)} ${escapeHtml(recipe.yieldUnit)}${recipe.category ? ` &middot; ${escapeHtml(recipe.category)}` : ""}</span></div>
          <div class="record-value"><strong>${money.format(recipe.sellingPrice)}</strong><span>${money.format(profitPerUnit)} estimated profit/unit</span></div>
          <button class="delete-button" type="button" data-delete-type="recipes" data-delete-id="${recipe.id}" data-delete-label="recipe ${escapeHtml(recipe.name)}">Delete</button>
        </article>`;
    })
    .join("");
}

function updateProductMetrics(metrics) {
  const list = document.querySelector("#product-metrics");
  const products = metrics?.topSelling || [];
  if (!products.length) {
    list.innerHTML = '<li><span>No sales recorded yet</span><strong>$0.00</strong></li>';
    return;
  }

  list.innerHTML = products
    .slice(0, 5)
    .map((product) => `<li><span>${escapeHtml(product.name)}</span><strong>${money.format(product.revenue)}</strong></li>`)
    .join("");
}

function updateSalesChart(sales) {
  const chart = document.querySelector("#sales-chart");
  const marginTrend = document.querySelector("#margin-trend");
  if (!sales.length) {
    chart.classList.add("empty-chart");
    chart.innerHTML = `${emptyState("No sales recorded yet", "Add a sale to populate revenue analytics.")}<button class="secondary-button chart-action" type="button" data-open-dialog="sale-dialog">Add Sale</button>`;
    marginTrend.textContent = "No margin data yet";
    return;
  }

  const days = buildDailyRevenue(sales);
  const max = Math.max(...days.map((day) => day.total), 1);
  chart.classList.remove("empty-chart");
  chart.innerHTML = days
    .map(
      (day) => `<span title="${day.label}: ${money.format(day.total)}" style="height: ${day.total ? Math.max((day.total / max) * 100, 8) : 2}%"></span>`,
    )
    .join("");
  marginTrend.textContent = "Based on manually recorded sales";
}

function buildDailyRevenue(sales) {
  const days = [];
  for (let index = 6; index >= 0; index -= 1) {
    const date = new Date();
    date.setDate(date.getDate() - index);
    const key = localDateKey(date);
    days.push({ key, label: date.toLocaleDateString(undefined, { weekday: "short" }), total: 0 });
  }
  for (const sale of sales) {
    const day = days.find((item) => item.key === sale.date);
    if (day) day.total += sale.total;
  }
  return days;
}

function openDialog(id) {
  const dialog = document.querySelector(`#${id}`);
  const form = dialog.querySelector("form");
  setFormDefaults(form);
  dialog.showModal();
  requestAnimationFrame(() => form.querySelector("input, select, textarea")?.focus());
}

function setFormDefaults(form) {
  const dateInput = form.querySelector('input[type="date"]');
  if (dateInput && !dateInput.value) dateInput.value = localDateKey(new Date());
}

function showNotice(message, type = "info") {
  const notice = document.querySelector("#app-notice");
  notice.textContent = message;
  notice.className = `notice ${type}`;
  notice.hidden = false;
  clearTimeout(showNotice.timer);
  showNotice.timer = setTimeout(() => {
    notice.hidden = true;
  }, 5000);
}

function emptyState(title, message, extraClass = "") {
  return `<div class="empty-state ${extraClass}"><strong>${title}</strong><p>${message}</p></div>`;
}

function setText(selector, value) {
  const element = document.querySelector(selector);
  if (element) element.textContent = value;
}

function formatDate(value) {
  return new Date(`${value}T00:00:00`).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatNumber(value) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value || 0);
}

function localDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
