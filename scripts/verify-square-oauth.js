const fs = require("fs");
const path = require("path");
const assert = require("node:assert/strict");
const { createSquareService } = require("../square");

async function main() {
  const env = process.env;
  const expectedHost = env.SQUARE_ENVIRONMENT === "production"
    ? "connect.squareup.com"
    : "connect.squareupsandbox.com";
  const connection = {};
  const service = createSquareService({
    env,
    storage: { async saveSquareConnection() {} },
    connection,
    getSales: () => [],
    saveSales: async () => {},
    logActivity: async () => {},
  });

  const first = new URL(await service.startOAuth());
  const second = new URL(await service.startOAuth());
  assert.notEqual(first.searchParams.get("state"), second.searchParams.get("state"), "OAuth state must be unique per request");
  assert.equal(first.hostname, expectedHost, "OAuth hostname must match SQUARE_ENVIRONMENT");
  assert.equal(second.hostname, expectedHost, "OAuth hostname must match SQUARE_ENVIRONMENT");
  assert.equal(first.searchParams.get("redirect_uri"), env.SQUARE_REDIRECT_URI, "redirect_uri must match SQUARE_REDIRECT_URI exactly");
  assert.equal(second.searchParams.get("redirect_uri"), env.SQUARE_REDIRECT_URI, "redirect_uri must match SQUARE_REDIRECT_URI exactly");

  const staleMatches = scanRepo(path.join(__dirname, ".."));
  assert.deepEqual(staleMatches, [], "Found stale Square callback URLs:\n" + staleMatches.join("\n"));

  console.log("Square OAuth verification passed");
  console.log("host=" + first.hostname);
  console.log("redirect_uri=" + first.searchParams.get("redirect_uri"));
  console.log("state_1=" + first.searchParams.get("state").slice(0, 8) + "... state_2=" + second.searchParams.get("state").slice(0, 8) + "...");
}

function scanRepo(root) {
  const matches = [];
  const skipDirs = new Set([".git", "node_modules", "data", "visual-test-data"]);
  const stalePattern = /https?:\/\/(?:localhost|127\.0\.0\.1|[^\s"'<]*railway[^\s"'>]*)[^\s"']*\/api\/square\/oauth\/callback/ig;
  walk(root);
  return matches;

  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!skipDirs.has(entry.name)) walk(path.join(dir, entry.name));
        continue;
      }
      if (!/\.(js|html|css|md|json|sql)$/i.test(entry.name)) continue;
      const file = path.join(dir, entry.name);
      const text = fs.readFileSync(file, "utf8");
      for (const match of text.matchAll(stalePattern)) {
        matches.push(path.relative(root, file) + ": " + match[0]);
      }
    }
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
