"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { spawn } = require("node:child_process");
const test = require("node:test");
const {
  analyzeTrend,
  buildTrendSummary,
  filterAndSortTrends,
  findDuplicate,
  normalizeTrendInput,
  normalizeTrendPatch,
  parseTrendQuery,
} = require("../trend-finder");
const { createStorage } = require("../storage");

const root = path.join(__dirname, "..");

test("trend input validation normalizes safe values and rejects invalid URLs", () => {
  const trend = normalizeTrendInput({
    title: "  Filled Croissant  ",
    category: "pastries",
    sourceUrl: "https://www.tiktok.com/@demo/video/123",
    hashtags: "#BakeryTok, croissant #BakeryTok",
    engagementScore: "72",
  }, { id: "10000000-0000-4000-8000-000000000001", now: "2026-07-20T12:00:00.000Z" });
  assert.equal(trend.title, "Filled Croissant");
  assert.deepEqual(trend.hashtags, ["#BakeryTok", "#croissant"]);
  assert.equal(trend.engagementScore, 72);
  assert.equal(trend.dataOrigin, "manual");
  assert.throws(() => normalizeTrendInput({ title: "Bad URL", sourceUrl: "javascript:alert(1)" }), /http or https/);
  assert.throws(() => normalizeTrendInput({ title: "Bad score", engagementScore: 101 }), /0 to 100/);
  assert.throws(() => normalizeTrendInput({ title: "Bad dates", firstSeenAt: "2026-07-20", lastSeenAt: "2026-07-19" }), /cannot be before/);
});

test("trend test plans and results validate numeric, date, and outcome fields", () => {
  const existing = normalizeTrendInput({ title: "Testable trend", category: "cakes" }, {
    id: "10000000-0000-4000-8000-000000000001", now: "2026-07-20T12:00:00.000Z",
  });
  const planned = normalizeTrendPatch({
    trendStatus: "testing", expectedIngredientCost: "18.25", plannedQuantity: "12",
    testDate: "2026-07-25", targetSellingPrice: "7.50", testNotes: "Weekend counter test",
    actualQuantityProduced: "12", actualQuantitySold: "10", actualRevenue: "75",
    resultNotes: "Good response", testOutcome: "repeat",
  }, existing);
  assert.equal(planned.expectedIngredientCost, 18.25);
  assert.equal(planned.plannedQuantity, 12);
  assert.equal(planned.actualQuantitySold, 10);
  assert.equal(planned.testOutcome, "repeat");
  assert.throws(() => normalizeTrendPatch({ expectedIngredientCost: 10 }, existing), /Complete expected cost/);
  assert.throws(() => normalizeTrendPatch({ expectedIngredientCost: -1, plannedQuantity: 5, testDate: "2026-07-25", targetSellingPrice: 5 }, existing), /non-negative/);
  assert.throws(() => normalizeTrendPatch({ expectedIngredientCost: 1, plannedQuantity: 5, testDate: "not-a-date", targetSellingPrice: 5 }, existing), /valid date/);
  assert.throws(() => normalizeTrendPatch({ actualQuantityProduced: 5, actualQuantitySold: 6 }, existing), /cannot exceed/);
  assert.throws(() => normalizeTrendPatch({ testOutcome: "secret" }, existing), /Final outcome is invalid/);
});

test("trend filters, sorting, summaries, duplicates, and update allowlist are deterministic", () => {
  const base = {
    description: "", sourcePlatform: "Manual", sourceUrl: "", hashtags: [], engagementScore: 0,
    relevanceScore: 0, suggestedProduct: "", suggestedAction: "", analysisReasoning: "",
    dataOrigin: "manual", firstSeenAt: "2026-07-19T00:00:00.000Z", createdAt: "2026-07-19T00:00:00.000Z",
    updatedAt: "2026-07-19T00:00:00.000Z",
  };
  const trends = [
    { ...base, id: "a", title: "Cookie Flight", category: "cookies", trendStatus: "watching", opportunityScore: 92, lastSeenAt: "2026-07-19T00:00:00.000Z" },
    { ...base, id: "b", title: "Berry Cake", category: "cakes", trendStatus: "active", opportunityScore: 70, lastSeenAt: "2026-07-20T00:00:00.000Z" },
    { ...base, id: "c", title: "Old Box", category: "packaging", trendStatus: "archived", opportunityScore: 90, lastSeenAt: "2026-06-01T00:00:00.000Z" },
  ];
  const query = parseTrendQuery(new URLSearchParams("category=cookies&status=watching&search=flight&sort=opportunity&limit=10"));
  assert.deepEqual(filterAndSortTrends(trends, query).map((trend) => trend.id), ["a"]);
  assert.equal(buildTrendSummary(trends, new Date("2026-07-20T12:00:00Z")).highOpportunityTrends, 1);
  assert.equal(findDuplicate(trends, { title: "cookie-flight", sourceUrl: "" }).id, "a");
  assert.equal(normalizeTrendPatch({ trendStatus: "testing", suggestedAction: "Make twelve." }, trends[0], { now: "2026-07-20T12:00:00Z" }).trendStatus, "testing");
  assert.throws(() => normalizeTrendPatch({ accessToken: "nope" }, trends[0]), /Unsupported trend field/);
  assert.throws(() => parseTrendQuery(new URLSearchParams("limit=1000")), /1 to 200/);
  assert.throws(() => parseTrendQuery(new URLSearchParams("secret=x")), /Unsupported query parameter/);
});

test("local analysis scores bakery fit and produces a practical recommendation", () => {
  const trend = normalizeTrendInput({
    title: "Colorful pistachio stuffed croissant reveal",
    description: "A premium limited pastry with glaze and cream",
    category: "pastries", engagementScore: 80,
  }, { id: "10000000-0000-4000-8000-000000000001", now: "2026-07-20T12:00:00.000Z" });
  const first = analyzeTrend(trend, { now: "2026-07-20T12:00:00.000Z", inventory: [{ ingredientName: "pistachio" }, { ingredientName: "cream" }] });
  const second = analyzeTrend(trend, { now: "2026-07-20T12:00:00.000Z", inventory: [{ ingredientName: "pistachio" }, { ingredientName: "cream" }] });
  assert.deepEqual(first, second);
  assert.ok(first.relevanceScore >= 75);
  assert.ok(first.opportunityScore >= 70);
  assert.match(first.suggestedProduct, /weekend pastry/i);
  assert.match(first.suggestedAction, /12-unit weekend test/i);
  assert.match(first.analysisReasoning, /ingredient readiness/);
});

test("food trends persist in local storage without affecting other collections", async (context) => {
  const dataDir = fs.mkdtempSync(path.join(root, ".test-trends-"));
  context.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const storage = await createStorage({ dataDir, env: {}, logger: { log() {}, warn() {} } });
  await storage.initialize();
  const trend = normalizeTrendInput({ title: "Demo Cake", category: "cakes" }, {
    id: "10000000-0000-4000-8000-000000000001", now: "2026-07-20T12:00:00.000Z",
  });
  await storage.upsertFoodTrend(trend);
  await storage.upsertFoodTrend({ ...trend, trendStatus: "testing" });
  assert.equal((await storage.loadFoodTrends()).length, 1);
  assert.equal((await storage.loadFoodTrends())[0].trendStatus, "testing");
  assert.deepEqual(await storage.loadCollection("sales"), []);
});

test("authenticated trend API covers listing, creation, duplicate rejection, analysis, status, archive, and safe errors", async (context) => {
  const port = await availablePort();
  const dataDir = fs.mkdtempSync(path.join(root, ".test-trend-api-"));
  const secret = "trend-test-password";
  const child = spawn(process.execPath, ["server.js"], {
    cwd: root,
    env: {
      ...process.env, NODE_ENV: "development", PORT: String(port), HOST: "127.0.0.1", DATA_DIR: dataDir,
      BAKERYOPS_USER: "owner", BAKERYOPS_PASSWORD: secret,
      SUPABASE_URL: "", SUPABASE_ANON_KEY: "", SUPABASE_SERVICE_ROLE_KEY: "",
      SQUARE_ACCESS_TOKEN: "", OPENAI_API_KEY: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  context.after(() => {
    child.kill();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  await waitForServer(child);
  const base = `http://127.0.0.1:${port}`;
  const auth = { Authorization: `Basic ${Buffer.from(`owner:${secret}`).toString("base64")}` };

  await waitForApplication(base);

  const health = await fetch(`${base}/api/health`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).ok, true);
  const trendAsset = await fetch(`${base}/trend-finder-ui.js`, { headers: auth });
  assert.equal(trendAsset.status, 200);
  assert.match(await trendAsset.text(), /refreshTrends/);
  assert.equal((await fetch(`${base}/api/trends`)).status, 401);
  assert.equal((await fetch(`${base}/api/trends`, { method: "POST" })).status, 401);

  const empty = await fetch(`${base}/api/trends`, { headers: auth });
  assert.equal(empty.status, 200);
  assert.deepEqual((await empty.json()).trends, []);

  const invalid = await jsonFetch(`${base}/api/trends`, auth, "POST", { title: "Unsafe", sourceUrl: "file:///secret" });
  assert.equal(invalid.response.status, 400);
  assert.doesNotMatch(JSON.stringify(invalid.body), new RegExp(secret));

  const created = await jsonFetch(`${base}/api/trends`, auth, "POST", {
    title: "Mini cookie flight", category: "cookies", description: "Colorful stuffed cookies in a premium box",
    sourcePlatform: "TikTok (manually observed)", sourceUrl: "https://www.tiktok.com/@demo/video/1",
    hashtags: ["#cookie"], engagementScore: 84,
  });
  assert.equal(created.response.status, 201);
  const id = created.body.id;
  assert.match(id, /^[0-9a-f-]{36}$/i);

  const duplicate = await jsonFetch(`${base}/api/trends`, auth, "POST", { title: "mini-cookie flight", category: "cookies" });
  assert.equal(duplicate.response.status, 409);
  const blocked = await jsonFetch(`${base}/api/trends/${id}`, auth, "PATCH", { accessToken: "steal" });
  assert.equal(blocked.response.status, 400);

  const analyzed = await jsonFetch(`${base}/api/trends/${id}/analyze`, auth, "POST");
  assert.equal(analyzed.response.status, 200);
  assert.ok(analyzed.body.opportunityScore > 0);
  assert.ok(analyzed.body.suggestedProduct);

  const watching = await jsonFetch(`${base}/api/trends/${id}`, auth, "PATCH", { trendStatus: "watching" });
  assert.equal(watching.body.trendStatus, "watching");
  const filtered = await fetch(`${base}/api/trends?category=cookies&status=watching&sort=opportunity&limit=5`, { headers: auth });
  assert.equal(filtered.status, 200);
  assert.equal((await filtered.json()).trends.length, 1);

  const testing = await jsonFetch(`${base}/api/trends/${id}`, auth, "PATCH", {
    trendStatus: "testing", expectedIngredientCost: 22.5, plannedQuantity: 12,
    testDate: "2026-07-25", targetSellingPrice: 8, testNotes: "Saturday test",
    actualQuantityProduced: 12, actualQuantitySold: 9, actualRevenue: 72,
    resultNotes: "Strong sell-through", testOutcome: "repeat",
  });
  assert.equal(testing.response.status, 200);
  assert.equal(testing.body.expectedIngredientCost, 22.5);
  assert.equal(testing.body.actualQuantitySold, 9);
  const persisted = await fetch(`${base}/api/trends?status=testing`, { headers: auth });
  assert.equal(persisted.status, 200);
  assert.equal((await persisted.json()).trends[0].testOutcome, "repeat");

  const archived = await jsonFetch(`${base}/api/trends/${id}`, auth, "PATCH", { trendStatus: "archived" });
  assert.equal(archived.body.trendStatus, "archived");
  const badId = await jsonFetch(`${base}/api/trends/not-an-id`, auth, "PATCH", { trendStatus: "active" });
  assert.equal(badId.response.status, 400);
  assert.doesNotMatch(JSON.stringify(badId.body), /SUPABASE|SERVICE_ROLE|BAKERYOPS_PASSWORD|trend-test-password/i);
});

test("Trend Finder UI documents manual sources, avoids unsafe stored-text rendering, and includes mobile rules", () => {
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  const ui = fs.readFileSync(path.join(root, "trend-finder-ui.js"), "utf8");
  const css = fs.readFileSync(path.join(root, "styles.css"), "utf8");
  const migration = fs.readFileSync(path.join(root, "supabase", "migrations", "20260720_food_trends.sql"), "utf8");
  const testingMigration = fs.readFileSync(path.join(root, "supabase", "migrations", "20260721_trend_testing.sql"), "utf8");
  const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
  assert.match(html, /data-view-target="trends-view"/);
  assert.match(html, /not live TikTok data/i);
  assert.match(html, /does not extract TikTok data/i);
  assert.doesNotMatch(ui, /\.innerHTML\s*=/);
  assert.match(ui, /replaceChildren/);
  assert.match(css, /@media \(max-width: 700px\)[\s\S]*\.trend-summary-grid/);
  assert.match(migration, /enable row level security/);
  assert.match(migration, /food_trends_opportunity_idx/);
  assert.match(testingMigration, /add column if not exists expected_ingredient_cost/);
  assert.match(testingMigration, /actual_quantity_sold <= actual_quantity_produced/);
  assert.match(fs.readFileSync(path.join(root, "storage.js"), "utf8"), /Trend testing is unavailable until the latest food_trends migration is applied/);
  assert.match(html, /id="trend-test-dialog"/);
  assert.match(ui, /fields\.trendStatus = "testing"/);
  assert.match(server, /path\.join\(root, "trend-finder-ui\.js"\)/);
});

async function jsonFetch(url, auth, method, body) {
  const headers = { ...auth };
  const options = { method, headers };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(body);
  }
  const response = await fetch(url, options);
  return { response, body: await response.json() };
}

function availablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function waitForServer(child) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Server did not start")), 10_000);
    const onData = (chunk) => {
      if (!String(chunk).includes("BakeryOps AI running")) return;
      clearTimeout(timer);
      child.stdout.off("data", onData);
      resolve();
    };
    child.stdout.on("data", onData);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Server exited before startup (${code})`));
    });
  });
}

async function waitForApplication(base) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const response = await fetch(`${base}/api/health`);
    const health = await response.json();
    if (health.database?.ready) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Application data did not become ready");
}
