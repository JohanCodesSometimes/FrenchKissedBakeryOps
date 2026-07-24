const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const test = require("node:test");

test("manual sale persists, logs activity, and flows through live sales updates", async (context) => {
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
  const product = `Owner regression ${Date.now()}`;
  const sale = await requestJson(port, "/api/sales", {
    method: "POST",
    body: {
      date: localDateKey(new Date()),
      product,
      quantitySold: 2,
      saleAmount: 17.5,
    },
  });
  assert.equal(sale.status, 201);
  assert.ok(sale.body.id);
  assert.ok(sale.body.createdAt);

  const activity = await requestJson(port, "/api/activity");
  assert.equal(activity.status, 200);
  assert.ok(activity.body.some((entry) =>
    entry.action === "sales.created" && entry.description === `Sale for ${product} created`,
  ));

  const since = new Date(Date.parse(initial.body.salesCursor) - 60_000).toISOString();
  const updates = await requestJson(port, `/api/sales/updates?since=${encodeURIComponent(since)}`);
  assert.equal(updates.status, 200);
  assert.equal(updates.body.sales.filter((item) => item.id === sale.body.id).length, 1);
  assert.equal(updates.body.salesSummary.todaySales, 17.5);
  assert.equal(updates.body.financials.revenueToday, 17.5);
  assert.equal(updates.body.salesCount, 1);
  assert.deepEqual(updates.body.productPerformance, [
    { product, quantitySold: 2, revenue: 17.5 },
  ]);

  const repeated = await requestJson(port, `/api/sales/updates?since=${encodeURIComponent(since)}`);
  assert.equal(repeated.status, 200);
  assert.equal(repeated.body.sales.filter((item) => item.id === sale.body.id).length, 1);
  assert.equal(repeated.body.salesSummary.todaySales, 17.5);

  const persisted = JSON.parse(fs.readFileSync(path.join(dataDir, "sales.json"), "utf8"));
  assert.equal(persisted.filter((item) => item.id === sale.body.id).length, 1);
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
