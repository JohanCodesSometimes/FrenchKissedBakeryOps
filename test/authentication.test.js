const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createAuthPolicy } = require("../authentication");

test("authentication is optional locally and mandatory in production", () => {
  const local = createAuthPolicy({ NODE_ENV: "development" });
  assert.equal(local.required, false);
  assert.equal(local.configured, false);
  assert.equal(local.isAuthorized({ headers: {} }), true);

  const missingProduction = createAuthPolicy({ NODE_ENV: "production" });
  assert.equal(missingProduction.required, true);
  assert.equal(missingProduction.configured, false);
  assert.equal(missingProduction.isAuthorized({ headers: {} }), false);

  const production = createAuthPolicy({ NODE_ENV: "production", BAKERYOPS_USER: "owner", BAKERYOPS_PASSWORD: "correct horse" });
  const authorization = `Basic ${Buffer.from("owner:correct horse").toString("base64")}`;
  assert.equal(production.isAuthorized({ headers: { authorization } }), true);
  assert.equal(production.isAuthorized({ headers: { authorization: `Basic ${Buffer.from("owner:wrong").toString("base64")}` } }), false);
  assert.equal(production.isAuthorized({ headers: { authorization: "Bearer secret" } }), false);
});

test("production without BAKERYOPS_PASSWORD exposes health but fails closed", async (context) => {
  const child = startServer({ NODE_ENV: "production", BAKERYOPS_PASSWORD: "" });
  context.after(() => child.kill("SIGTERM"));
  const port = await waitForPort(child);

  const health = await request(port, "/api/health");
  assert.equal(health.status, 200);
  assert.deepEqual(health.body.authentication, { required: true, configured: false });

  const page = await request(port, "/");
  assert.equal(page.status, 503);
  assert.equal(page.body.error.code, "AUTH_CONFIGURATION_REQUIRED");
});

test("configured Basic authentication protects local APIs without breaking local storage", async (context) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bakeryops-auth-"));
  context.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const child = startServer({
    NODE_ENV: "development",
    BAKERYOPS_USER: "owner",
    BAKERYOPS_PASSWORD: "test-password",
    DATA_DIR: dataDir,
  });
  context.after(() => child.kill("SIGTERM"));
  const port = await waitForPort(child);
  await waitForReady(port);

  const unauthorized = await request(port, "/api/dashboard");
  assert.equal(unauthorized.status, 401);
  assert.match(unauthorized.headers["www-authenticate"], /Basic/);

  const authorization = `Basic ${Buffer.from("owner:test-password").toString("base64")}`;
  const dashboard = await request(port, "/api/dashboard", { Authorization: authorization });
  assert.equal(dashboard.status, 200);
  assert.ok(Array.isArray(dashboard.body.sales));
});

function startServer(overrides) {
  return spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: "0",
      SUPABASE_URL: "",
      SUPABASE_ANON_KEY: "",
      SUPABASE_SERVICE_ROLE_KEY: "",
      SQUARE_ENABLED: "false",
      ...overrides,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

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
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const health = await request(port, "/api/health");
    if (health.body.database?.ready) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Database did not become ready");
}

function request(port, pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    const outgoing = http.get({ hostname: "127.0.0.1", port, path: pathname, headers }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let body = text;
        try { body = JSON.parse(text); } catch {}
        resolve({ status: response.statusCode, headers: response.headers, body });
      });
    });
    outgoing.on("error", reject);
  });
}
