const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const test = require("node:test");
const { boundedRetryDelay, createRecoveryManager } = require("../resilience");
const { createStorage } = require("../storage");

test("recovery delay is exponential, jittered, and bounded", () => {
  assert.equal(boundedRetryDelay(1, { random: () => 0 }), 2_000);
  assert.equal(boundedRetryDelay(2, { random: () => 0 }), 4_000);
  assert.equal(boundedRetryDelay(3, { random: () => 0.5 }), 8_800);
  assert.equal(boundedRetryDelay(20, { random: () => 1 }), 60_000);
});

test("recovery manager keeps retrying without overlapping and returns to ready", async () => {
  const scheduled = [];
  const states = [];
  let attempts = 0;
  const manager = createRecoveryManager({
    connect: async () => {
      attempts += 1;
      if (attempts < 3) throw new Error("Supabase unavailable");
      return { mode: "supabase" };
    },
    onReady: () => states.push("ready"),
    onUnavailable: () => states.push("unavailable"),
    logger: { error() {} },
    random: () => 0,
    now: () => new Date("2026-07-18T12:00:00.000Z"),
    setTimer: (callback, delay) => {
      scheduled.push({ callback, delay });
      return scheduled.length;
    },
    clearTimer: () => {},
  });

  assert.equal(await manager.start(), false);
  assert.equal(manager.status().state, "unavailable");
  assert.equal(scheduled.at(-1).delay, 2_000);
  assert.equal(await manager.retry(), false);
  assert.equal(scheduled.at(-1).delay, 4_000);
  const recovery = manager.retry();
  assert.equal(await manager.retry(), await recovery);
  assert.equal(manager.status().state, "ready");
  assert.equal(attempts, 3);
  assert.deepEqual(states, ["unavailable", "unavailable", "ready"]);
});

test("production storage refuses JSON fallback when Supabase is missing or partial", async () => {
  await assert.rejects(
    createStorage({ dataDir: ".", env: { NODE_ENV: "production" }, logger: { log() {}, warn() {} } }),
    /Production requires complete Supabase configuration/,
  );
  await assert.rejects(
    createStorage({ dataDir: ".", env: { NODE_ENV: "production", SUPABASE_URL: "https://example.test" }, logger: { log() {}, warn() {} } }),
    /Production requires complete Supabase configuration/,
  );
});

test("server source keeps health available and returns structured database 503 responses", () => {
  const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.match(server, /createRecoveryManager/);
  assert.match(server, /DATABASE_UNAVAILABLE/);
  assert.match(server, /Retry-After/);
  assert.match(server, /SIGTERM/);
  assert.match(server, /requestTimeout/);
});

test("HTTP health stays available while production database bootstrap retries", async (context) => {
  const child = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    env: {
      ...process.env,
      NODE_ENV: "production",
      HOST: "127.0.0.1",
      PORT: "0",
      BAKERYOPS_PASSWORD: "test-password",
      SUPABASE_URL: "",
      SUPABASE_ANON_KEY: "",
      SUPABASE_SERVICE_ROLE_KEY: "",
      SQUARE_ENABLED: "false",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  context.after(() => child.kill("SIGTERM"));
  const port = await waitForPort(child);

  const health = await getJson(port, "/api/health");
  assert.equal(health.status, 200);
  assert.equal(health.body.ok, true);
  assert.equal(health.body.database.ready, false);

  const authorization = `Basic ${Buffer.from("owner:test-password").toString("base64")}`;
  const dashboard = await getJson(port, "/api/dashboard", { Authorization: authorization });
  assert.equal(dashboard.status, 503);
  assert.equal(dashboard.body.error.code, "DATABASE_UNAVAILABLE");
  assert.equal(dashboard.body.error.retryable, true);
  assert.ok(Number(dashboard.headers["retry-after"]) >= 1);
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

function getJson(port, pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = http.get({ hostname: "127.0.0.1", port, path: pathname, headers }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        try {
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
          });
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on("error", reject);
  });
}
