const assert = require("node:assert/strict");
const test = require("node:test");
const { assessMarkdown, convertToMarkdown } = require("../document-converter");

test("accepts meaningful converted text", async () => {
  const markdown = "# Invoice\n\nVendor: Flour House\nTotal: $125.40\nInvoice date: 2026-06-18";
  const result = await convertToMarkdown("invoice.pdf", {
    runner: async () => ({ stdout: markdown }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.fallbackRequired, false);
  assert.equal(result.textFirst, true);
  assert.equal(result.markdown, markdown);
});

test("requests fallback for empty or failed conversion without leaking error details", async () => {
  const warnings = [];
  const result = await convertToMarkdown("receipt.jpg", {
    logger: { warn(message) { warnings.push(message); } },
    runner: async () => { throw new Error("secret document text"); },
  });
  assert.equal(result.ok, false);
  assert.equal(result.fallbackRequired, true);
  assert.equal(result.markdown, "");
  assert.equal(warnings.length, 1);
  assert.doesNotMatch(warnings[0], /secret document text/);
});

test("quality check rejects short extraction noise", () => {
  assert.equal(assessMarkdown("scan 1").usable, false);
});

test("image uploads continue to vision fallback even if metadata is verbose", async () => {
  const result = await convertToMarkdown("receipt.jpg", {
    runner: async () => ({ stdout: "Camera metadata and image dimensions with enough text to pass the generic quality threshold." }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.fallbackRequired, true);
  assert.equal(result.textFirst, false);
});
