"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createStorage } = require("../storage");
const { convertQuantity, planInventoryAdjustments, prepareReceiptReview } = require("../receipt-inventory");
const { applySavedInventory, outcome } = require("../receipt-ui");

const flour = {
  id: "flour-id",
  ingredientName: "Flour",
  category: "Ingredients",
  quantity: 10,
  unit: "lb",
  minimumThreshold: 2,
  supplier: "Mill",
  costPerUnit: 1,
  createdAt: "2026-09-01T12:00:00.000Z",
};

test("an existing ingredient receives additional stock instead of being overwritten", () => {
  const plan = planInventoryAdjustments([flour], [{
    itemName: "Flour",
    receivedQuantity: 5,
    receivedUnit: "lb",
    inventoryItemId: flour.id,
    updateInventory: true,
  }]);
  assert.equal(plan.adjustments.length, 1);
  assert.equal(plan.adjustments[0].beforeQuantity, 10);
  assert.equal(plan.adjustments[0].afterQuantity, 15);
  assert.equal(plan.adjustments[0].stockQuantity, 5);
});

test("multiple lines use only known unit conversions", () => {
  const sugar = { ...flour, id: "sugar-id", ingredientName: "Sugar", quantity: 2 };
  const plan = planInventoryAdjustments([flour, sugar], [
    { itemName: "Flour", receivedQuantity: 32, receivedUnit: "oz", inventoryItemId: flour.id, updateInventory: true },
    { itemName: "Sugar", receivedQuantity: 1, receivedUnit: "kg", inventoryItemId: sugar.id, updateInventory: true },
  ]);
  assert.deepEqual(plan.adjustments.map((item) => item.stockQuantity), [2, 2.2046]);
  assert.equal(convertQuantity(1, "dozen", "count"), 12);
  assert.equal(convertQuantity(1, "gallon", "lb"), null);
});

test("ambiguous matches remain unresolved and invalid quantities are blocked", () => {
  const review = prepareReceiptReview({
    items: [{
      itemName: "Flour", receivedQuantity: 0, receivedUnit: "lb", category: "Ingredients",
      updateInventory: true, updateInventoryRequested: true, isDiscount: false, isFee: false, isDeposit: false,
    }],
  }, [flour, { ...flour, id: "flour-2", unit: "kg" }]);
  assert.equal(review.items[0].updateInventory, false);
  assert.match(review.items[0].unresolvedReason, /quantity/i);
  assert.throws(() => planInventoryAdjustments([flour], [{
    itemName: "Flour", receivedQuantity: 0, receivedUnit: "lb", inventoryItemId: flour.id, updateInventory: true,
  }]), /valid received quantity/i);

  const intentionallySkipped = prepareReceiptReview({ items: [{
    itemName: "Flour", receivedQuantity: 1, receivedUnit: "lb", category: "Ingredients",
    updateInventory: false, updateInventoryRequested: false, isDiscount: false, isFee: false, isDeposit: false,
  }] }, [flour]);
  assert.equal(intentionallySkipped.items[0].inventoryItemId, flour.id);
  assert.equal(intentionallySkipped.items[0].updateInventory, false);
});

test("repeated local receipt application cannot add stock twice", async (context) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bakeryops-receipt-idempotency-"));
  context.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const storage = await createStorage({ dataDir, env: {}, logger: { log() {}, warn() {} } });
  await storage.initialize();
  await storage.saveCollection("inventory", [flour]);
  await storage.saveReceipts([{
    id: "receipt-id", fileName: "receipt.jpg", status: "review", uploadedAt: "2026-09-10T12:00:00.000Z",
  }]);
  const approvedReceipt = {
    id: "receipt-id", expenseId: "expense-id", fileName: "receipt.jpg", status: "approved",
    storeName: "Supplier", receiptDate: "2026-09-10", subtotal: 4, tax: 0, total: 4,
    itemCount: 1, uploadedAt: "2026-09-10T12:00:00.000Z", approvedAt: "2026-09-10T12:01:00.000Z",
  };
  const payload = {
    receiptId: "receipt-id",
    expense: { id: "expense-id", date: "2026-09-10", vendor: "Supplier", category: "Ingredients", amount: 4, notes: "", createdAt: approvedReceipt.approvedAt },
    receipt: approvedReceipt,
    items: [{
      id: "receipt-item-id", expenseId: "expense-id", receiptId: "receipt-id", inventoryItemId: flour.id,
      storeName: "Supplier", receiptDate: "2026-09-10", itemName: "Flour", rawLine: "Flour",
      quantity: 2, unit: "lb", receivedQuantity: 2, receivedUnit: "lb", unitPrice: 2, totalPrice: 4,
      category: "Ingredients", updateInventory: true, stockQuantity: 2, stockUnit: "lb", stockUnitPrice: 2,
      adjustmentId: "adjustment-id", createdAt: approvedReceipt.approvedAt,
    }],
    priceHistory: [],
  };
  assert.deepEqual(await storage.applyReceiptApproval(payload), { alreadyApplied: false });
  assert.deepEqual(await storage.applyReceiptApproval(payload), { alreadyApplied: true });
  assert.equal((await storage.loadCollection("inventory"))[0].quantity, 12);
  assert.equal((await storage.loadCollection("expenses")).length, 1);
});

test("Supabase receipt approval uses one atomic RPC and exposes a failed commit", async () => {
  let rpcCalls = 0;
  const client = {
    async rpc(name) {
      rpcCalls += 1;
      assert.equal(name, "apply_receipt_inventory");
      return { data: null, error: { message: "simulated transaction failure" } };
    },
  };
  const storage = await createStorage({
    dataDir: ".",
    env: { SUPABASE_URL: "https://example.supabase.co", SUPABASE_ANON_KEY: "anon", SUPABASE_SERVICE_ROLE_KEY: "service" },
    logger: { log() {}, warn() {} },
    supabaseClient: client,
  });
  await assert.rejects(
    storage.applyReceiptApproval({ receiptId: "receipt-id", expense: {}, receipt: {}, items: [], priceHistory: [] }),
    /simulated transaction failure/,
  );
  assert.equal(rpcCalls, 1);

  const sql = fs.readFileSync(path.join(__dirname, "..", "supabase", "migrations", "20260910_receipt_inventory.sql"), "utf8");
  assert.match(sql, /select status.*for update/s);
  assert.match(sql, /if v_status = 'approved'/);
  assert.match(sql, /receipt_inventory_adjustments/);
});

test("frontend state uses the inventory returned after persistence", () => {
  const before = { inventory: { all: [{ id: flour.id, quantity: 10 }] }, sales: [] };
  const savedInventory = { all: [{ id: flour.id, quantity: 12 }], summary: { totalTrackedItems: 1 } };
  const after = applySavedInventory(before, {
    inventory: savedInventory,
    addedItems: [{ ingredientName: "Flour", addedQuantity: 2, stockUnit: "lb" }],
    unresolvedLines: [{ itemName: "Coupon", reason: "Not applied to inventory." }],
  });
  assert.equal(after.inventory.all[0].quantity, 12);
  assert.equal(before.inventory.all[0].quantity, 10);
  assert.equal(outcome({ addedItems: [{}], unresolvedLines: [{}] }).unresolvedLines.length, 1);
});
