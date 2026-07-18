const crypto = require("crypto");

function createAuthPolicy(env = process.env) {
  const production = String(env.NODE_ENV || "").toLowerCase() === "production";
  const username = String(env.BAKERYOPS_USER || "owner");
  const password = String(env.BAKERYOPS_PASSWORD || "");
  const configured = Boolean(password);
  const required = production || configured;

  function isAuthorized(req) {
    if (!required) return true;
    if (!configured) return false;
    const header = String(req?.headers?.authorization || "");
    const [scheme, encoded, extra] = header.split(" ");
    if (scheme !== "Basic" || !encoded || extra) return false;
    let supplied;
    try {
      supplied = Buffer.from(encoded, "base64").toString("utf8");
    } catch {
      return false;
    }
    return constantTimeEqual(supplied, `${username}:${password}`);
  }

  return { configured, isAuthorized, production, required };
}

function constantTimeEqual(left, right) {
  const leftHash = crypto.createHash("sha256").update(String(left)).digest();
  const rightHash = crypto.createHash("sha256").update(String(right)).digest();
  return crypto.timingSafeEqual(leftHash, rightHash);
}

module.exports = { constantTimeEqual, createAuthPolicy };
