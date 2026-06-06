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
if (savedTheme === "dark") {
  document.body.classList.add("dark");
}

themeButton?.addEventListener("click", () => {
  document.body.classList.toggle("dark");
  localStorage.setItem(
    "bakeryops-theme",
    document.body.classList.contains("dark") ? "dark" : "light",
  );
});

receiptUpload?.addEventListener("change", (event) => {
  const file = event.target.files?.[0];
  const zone = document.querySelector(".upload-zone");
  if (!file || !zone) return;

  zone.querySelector("strong").textContent = file.name;
  zone.querySelector("span").textContent =
    "Ready for AI parsing: store, date, tax, totals, and item lines";
});

navLinks.forEach((link) => {
  link.addEventListener("click", () => {
    navLinks.forEach((item) => item.classList.remove("active"));
    link.classList.add("active");
  });
});

refreshDashboard();
refreshSquareStatus();
setInterval(refreshDashboard, 5000);
setInterval(refreshSquareStatus, 15000);

async function refreshDashboard() {
  try {
    const response = await fetch("/api/dashboard", { credentials: "same-origin" });
    if (!response.ok) return;

    const dashboard = await response.json();
    updateFinancials(dashboard.financials);
    updateInventory(dashboard.inventory.all);
    updateRecentSales(dashboard.sales);
    updateProductMetrics(dashboard.productMetrics);
    updateSalesChart(dashboard.sales);
  } catch (error) {
    console.warn("Dashboard refresh failed", error);
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

function updateInventory(inventory) {
  const body = document.querySelector("#inventory-body");
  if (!body) return;

  const items = Object.values(inventory);
  if (!items.length) {
    body.innerHTML = `
      <tr>
        <td colspan="6">
          <div class="empty-state table-empty">
            <strong>No inventory items added yet</strong>
            <p>Add ingredients to enable stock alerts and forecasts.</p>
            <button class="secondary-button" type="button">Add Data</button>
          </div>
        </td>
      </tr>
    `;
    return;
  }

  body.innerHTML = items
    .map((item) => {
      const low = item.currentQuantity <= item.minimumThreshold;
      return `
        <tr>
          <td>${item.name}</td>
          <td>${item.currentQuantity} ${item.unit}</td>
          <td>${item.minimumThreshold} ${item.unit}</td>
          <td>${item.averageWeeklyUsage || 0} ${item.unit}</td>
          <td><span class="pill ${low ? "warning-pill" : "good-pill"}">${low ? "Reorder" : "Healthy"}</span></td>
          <td>${low ? `Buy more ${item.name.toLowerCase()}` : "No purchase needed"}</td>
        </tr>
      `;
    })
    .join("");
}

function updateRecentSales(sales) {
  const list = document.querySelector("#recent-sales");
  if (!list) return;

  if (!sales.length) {
    list.innerHTML = '<li><span>No sales synced yet</span><strong>$0.00</strong></li>';
    return;
  }

  list.innerHTML = sales
    .slice(0, 5)
    .map((sale) => {
      const product = sale.products[0];
      const time = new Date(sale.timestamp).toLocaleString();
      return `<li><span>${product?.quantity || 0} ${product?.name || "items"}<br><small>${time}</small></span><strong>${money.format(sale.total)}</strong></li>`;
    })
    .join("");
}

function updateProductMetrics(metrics) {
  const list = document.querySelector("#product-metrics");
  if (!list) return;

  const products = metrics?.topSelling || [];
  if (!products.length) {
    list.innerHTML = '<li><span>No sales synced yet</span><strong>$0.00</strong></li>';
    return;
  }

  list.innerHTML = products
    .slice(0, 5)
    .map((product) => `<li><span>${product.name}</span><strong>${money.format(product.revenue)}</strong></li>`)
    .join("");
}

function updateSalesChart(sales) {
  const chart = document.querySelector("#sales-chart");
  const marginTrend = document.querySelector("#margin-trend");
  if (!chart) return;

  if (!sales.length) {
    chart.classList.add("empty-chart");
    chart.innerHTML = `
      <div class="empty-state">
        <strong>No sales synced yet</strong>
        <p>Connect Square to populate revenue and margin charts.</p>
        <a class="secondary-button link-button" href="/api/square/connect">Connect Square</a>
      </div>
    `;
    if (marginTrend) marginTrend.textContent = "No margin data yet";
    return;
  }

  const days = buildDailyRevenue(sales);
  const max = Math.max(...days.map((day) => day.total), 1);
  chart.classList.remove("empty-chart");
  chart.innerHTML = days
    .map((day) => `<span title="${day.label}: ${money.format(day.total)}" style="height: ${Math.max((day.total / max) * 100, 8)}%"></span>`)
    .join("");
  if (marginTrend) marginTrend.textContent = "Margin trend appears after recipes are created";
}

function buildDailyRevenue(sales) {
  const days = [];
  for (let index = 6; index >= 0; index -= 1) {
    const date = new Date();
    date.setDate(date.getDate() - index);
    const key = date.toISOString().slice(0, 10);
    days.push({
      key,
      label: date.toLocaleDateString(undefined, { weekday: "short" }),
      total: 0,
    });
  }

  for (const sale of sales) {
    const key = sale.timestamp.slice(0, 10);
    const day = days.find((item) => item.key === key);
    if (day) day.total += sale.total;
  }

  return days;
}

function setText(selector, value) {
  const element = document.querySelector(selector);
  if (element) element.textContent = value;
}

async function refreshSquareStatus() {
  try {
    const response = await fetch("/api/square/status", { credentials: "same-origin" });
    if (!response.ok) return;

    const status = await response.json();
    const label = document.querySelector("#square-status");
    const link = document.querySelector("#square-connect");
    if (!label || !link) return;

    label.textContent = status.connected
      ? `Square connected${status.merchantId ? `: ${status.merchantId}` : ""}`
      : "Square not connected";
    link.textContent = status.connected ? "Reconnect Square" : "Connect Square";
  } catch (error) {
    console.warn("Square status refresh failed", error);
  }
}
