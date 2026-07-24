const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const test = require("node:test");

test("two manual sales persist, log activity, poll exactly once, and reconcile authoritatively", async (context) => {
  const dataDir = fs.mkdtempSync(path.join(__dirname, ".bakeryops-live-sale-"));
  context.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const child = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    env: {
      ...process.env,
      NODE_ENV: "development",
      HOST: "127.0.0.1",
      PORT: "0",
      DATA_DIR: dataDir,
      SUPABASE_URL: "",
      SUPABASE_ANON_KEY: "",
      SUPABASE_SERVICE_ROLE_KEY: "",
      SQUARE_ENABLED: "false",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  context.after(() => child.kill("SIGTERM"));
  const port = await waitForPort(child);
  await waitForReady(port);

  const initial = await requestJson(port, "/api/dashboard");
  assert.equal(initial.status, 200);
  const products = [`Owner croissant ${Date.now()}`, `Owner baguette ${Date.now()}`];
  const firstSale = await requestJson(port, "/api/sales", {
    method: "POST",
    body: {
      date: localDateKey(new Date()),
      product: products[0],
      quantitySold: 2,
      saleAmount: 17.5,
    },
  });
  const secondSale = await requestJson(port, "/api/sales", {
    method: "POST",
    body: {
      date: localDateKey(new Date()),
      product: products[1],
      quantitySold: 1,
      saleAmount: 8.25,
    },
  });
  for (const sale of [firstSale, secondSale]) {
    assert.equal(sale.status, 201);
    assert.ok(sale.body.id);
    assert.ok(sale.body.createdAt);
  }
  assert.notEqual(firstSale.body.id, secondSale.body.id);

  const activity = await requestJson(port, "/api/activity");
  assert.equal(activity.status, 200);
  for (const product of products) {
    assert.equal(activity.body.filter((entry) =>
      entry.action === "sales.created" && entry.description === `Sale for ${product} created`,
    ).length, 1);
  }

  const since = new Date(Date.parse(initial.body.salesCursor) - 60_000).toISOString();
  const updates = await requestJson(port, `/api/sales/updates?since=${encodeURIComponent(since)}`);
  assert.equal(updates.status, 200);
  for (const sale of [firstSale, secondSale]) {
    assert.equal(updates.body.sales.filter((item) => item.id === sale.body.id).length, 1);
  }
  assert.equal(updates.body.salesSummary.todaySales, 25.75);
  assert.equal(updates.body.salesSummary.totalTransactions, 2);
  assert.equal(updates.body.salesSummary.averageTicket, 12.88);
  assert.equal(updates.body.financials.revenueToday, 25.75);
  assert.equal(updates.body.salesCount, 2);
  assert.deepEqual(updates.body.productPerformance, [
    { product: products[0], quantitySold: 2, revenue: 17.5 },
    { product: products[1], quantitySold: 1, revenue: 8.25 },
  ]);

  const repeated = await requestJson(port, `/api/sales/updates?since=${encodeURIComponent(since)}`);
  assert.equal(repeated.status, 200);
  for (const sale of [firstSale, secondSale]) {
    assert.equal(repeated.body.sales.filter((item) => item.id === sale.body.id).length, 1);
  }
  assert.equal(repeated.body.salesSummary.todaySales, 25.75);
  assert.equal(repeated.body.salesCount, 2);

  const persisted = JSON.parse(fs.readFileSync(path.join(dataDir, "sales.json"), "utf8"));
  for (const sale of [firstSale, secondSale]) {
    assert.equal(persisted.filter((item) => item.id === sale.body.id).length, 1);
  }

  const reconciled = await requestJson(port, "/api/dashboard");
  assert.equal(reconciled.status, 200);
  for (const sale of [firstSale, secondSale]) {
    assert.equal(reconciled.body.sales.filter((item) => item.id === sale.body.id).length, 1);
  }
  assert.equal(reconciled.body.salesSummary.todaySales, 25.75);
  assert.equal(reconciled.body.salesSummary.totalTransactions, 2);
  assert.equal(reconciled.body.financials.revenueToday, 25.75);
  assert.deepEqual(reconciled.body.productPerformance, updates.body.productPerformance);
});

function waitForPort(child) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Server did not start")), 5_000);
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
      const match = output.match(/BakeryOps AI running on 127\.0\.0\.1:(\d+)/);
      if (!match) return;
      clearTimeout(timeout);
      resolve(Number(match[1]));
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`Server exited before listening (${code})`));
    });
  });
}

async function waitForReady(port) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const health = await requestJson(port, "/api/health");
    if (health.body.database?.ready) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Database did not become ready");
}

function requestJson(port, pathname, { method = "GET", body } = {}) {
  return new Promise((resolve, reject) => {
    const encodedBody = body === undefined ? "" : JSON.stringify(body);
    const request = http.request({
      hostname: "127.0.0.1",
      port,
      path: pathname,
      method,
      headers: encodedBody ? {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(encodedBody),
      } : {},
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        try {
          resolve({
            status: response.statusCode,
            body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
          });
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on("error", reject);
    if (encodedBody) request.write(encodedBody);
    request.end();
  });
}

function localDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
