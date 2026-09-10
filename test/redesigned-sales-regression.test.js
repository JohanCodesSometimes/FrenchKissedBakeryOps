const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const script = fs.readFileSync(path.join(root, "script.js"), "utf8");
const liveSales = fs.readFileSync(path.join(root, "live-sales.js"), "utf8");

const salesRendererTargets = [
  "summary-today",
  "summary-week",
  "summary-month",
  "summary-average",
  "summary-transactions",
  "sales-refreshed-at",
  "revenue-today",
  "revenue-month",
  "estimated-profit",
  "today-order-count",
  "today-average-order",
  "today-best-product",
  "today-comparison",
  "dashboard-sales-history",
  "sales-chart",
  "top-products",
  "dashboard-sales",
  "sales-daily",
  "sales-weekly",
  "sales-monthly",
  "sales-average",
  "sales-transactions",
  "sales-body",
  "performance-body",
];

test("redesigned production HTML has exactly one target for every sales renderer", () => {
  for (const id of salesRendererTargets) {
    const matches = html.match(new RegExp(`\\bid="${id}"`, "g")) || [];
    assert.equal(matches.length, 1, `expected exactly one #${id} target`);
    assert.match(script, new RegExp(`#${id}\\b`), `expected script.js to bind #${id}`);
  }
  assert.equal((html.match(/\bid="sale-form"/g) || []).length, 1);
  assert.equal((html.match(/\bid="sales-view"/g) || []).length, 1);
  assert.equal((html.match(/\bid="dashboard-view"/g) || []).length, 1);
  assert.equal((html.match(/\bid="activity-list"/g) || []).length, 1);
  assert.equal((html.match(/\bid="dashboard-activity"/g) || []).length, 1);
});

test("redesigned sales runtime commits before rendering and isolates every widget", () => {
  const setState = liveSales.indexOf("setState(result.state);");
  const committedRequest = liveSales.indexOf("latestCommittedRequestId = requestId;", setState);
  const render = liveSales.indexOf("render({ state: result.state", committedRequest);
  assert.ok(setState >= 0 && committedRequest > setState && render > committedRequest);
  assert.doesNotMatch(liveSales, /catch \(error\) \{\s*setState\(previous\)/);
  assert.match(liveSales, /function runRenderers\(/);
  assert.match(script, /\["summary",/);
  assert.match(script, /\["dashboard-history",/);
  assert.match(script, /\["sales-chart",/);
  assert.match(script, /\["top-products",/);
  assert.match(script, /\["recent-sales",/);
  assert.match(script, /\["sales-page", renderSales\]/);
  assert.match(script, /reportSalesDiagnostic/);
});

test("sales assets have a release-specific cache key and load before the application", () => {
  const liveAsset = 'live-sales.js?v=2026-07-24-sales-sync-regression';
  const appAsset = 'script.js?v=2026-09-10-receipt-inventory';
  assert.equal(html.split(liveAsset).length - 1, 1);
  assert.equal(html.split(appAsset).length - 1, 1);
  assert.ok(html.indexOf(liveAsset) < html.indexOf(appAsset));
  assert.ok(html.indexOf(appAsset) < html.indexOf("trend-finder-ui.js"));
});

test("optional YouTube discovery remains outside sales initialization", () => {
  const initialize = script.slice(script.indexOf("function initialize()"), script.indexOf("function initializeSystemStatusChecklist()"));
  assert.match(initialize, /void refreshDashboard\(\)/);
  assert.match(initialize, /void refreshDashboardTrends\(\)/);
  assert.doesNotMatch(initialize, /await refreshDashboardTrends/);
  assert.match(script, /Dashboard sales remain unaffected/);
});
