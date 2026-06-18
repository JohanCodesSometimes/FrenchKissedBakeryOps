const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createStorage } = require("../storage");

test("JSON storage persists receipt metadata and line items", async (context) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bakeryops-receipts-"));
  context.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const logger = { log() {}, warn() {} };
  const storage = await createStorage({ dataDir, env: {}, logger });
  await storage.initialize();
  await storage.saveReceipts([{ id: "receipt-1", fileName: "receipt.jpg", status: "review" }]);
  await storage.saveReceiptItems([{ id: "item-1", receiptId: "receipt-1", itemName: "Flour" }]);

  const reloaded = await (await createStorage({ dataDir, env: {}, logger })).initialize();
  assert.equal(reloaded.receipts[0].fileName, "receipt.jpg");
  assert.equal(reloaded.receiptItems[0].receiptId, "receipt-1");
});
