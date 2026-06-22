const test = require("node:test");
const assert = require("node:assert/strict");
const { createReceiptParser, validateImage } = require("../receipt-parser");

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);

function responseWith(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => "request-test" },
    json: async () => body,
  };
}

test("receipt parser sends image input and returns structured receipt data", async () => {
  let requestBody;
  const parser = createReceiptParser({
    env: { OPENAI_API_KEY: "server-secret", OPENAI_RECEIPT_MODEL: "test-model" },
    fetchImpl: async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return responseWith({ output_text: JSON.stringify({
        parseStatus: "readable", storeName: "Publix", receiptDate: "2026-06-22",
        subtotal: 10, tax: 0.7, total: 10.7,
        rawTextLines: ["FLOUR 10.00"], confidence: 0.95, warnings: [], ignoredLines: [],
        items: [{ itemName: "Flour", rawLine: "FLOUR 10.00", quantity: 1, unit: "lb", unitPrice: 10, totalPrice: 10, category: "Ingredients", updateInventory: true, isDiscount: false, isFee: false, isDeposit: false }],
      }) });
    },
  });

  const result = await parser.parse({ fileName: "receipt.jpg", mimeType: "image/jpeg", fileBuffer: jpeg });
  assert.equal(result.storeName, "Publix");
  assert.equal(result.items[0].itemName, "Flour");
  assert.equal(requestBody.model, "test-model");
  assert.match(requestBody.input[0].content[1].image_url, /^data:image\/jpeg;base64,/);
  assert.equal(requestBody.text.format.type, "json_schema");
});

test("receipt parser returns clear unreadable errors", async () => {
  const parser = createReceiptParser({
    env: { OPENAI_API_KEY: "server-secret" },
    fetchImpl: async () => responseWith({ output_text: JSON.stringify({
      parseStatus: "too_blurry", storeName: "", receiptDate: "", subtotal: 0, tax: 0, total: 0, rawTextLines: [], confidence: 0, warnings: ["Unreadable"], ignoredLines: [], items: [],
    }) }),
  });
  await assert.rejects(
    parser.parse({ fileName: "receipt.jpeg", mimeType: "image/jpeg", fileBuffer: jpeg }),
    (error) => error.statusCode === 422 && error.message === "Receipt too blurry",
  );
});

test("receipt parser rejects mismatched image signatures before calling OpenAI", () => {
  assert.throws(
    () => validateImage("receipt.png", "image/png", jpeg),
    (error) => error.statusCode === 415,
  );
});


test("receipt parser keeps convenience-store items and tolerates missing fields", async () => {
  const parser = createReceiptParser({
    env: { OPENAI_API_KEY: "server-secret", NODE_ENV: "production" },
    fetchImpl: async () => responseWith({ output_text: JSON.stringify({
      parseStatus: "readable",
      storeName: "Circle K",
      receiptDate: "",
      subtotal: 0,
      tax: 0,
      total: 24.5,
      rawTextLines: ["BIG CHIEF JERKY 5.99", "SPRING WATER 1.49", "COUPON -1.00"],
      confidence: 0.82,
      warnings: [],
      ignoredLines: ["VISA 24.50"],
      items: [
        { itemName: "Big Chief Jerky", rawLine: "BIG CHIEF JERKY 5.99", quantity: 1, unit: "unknown", unitPrice: 5.99, totalPrice: 5.99, category: "Other", updateInventory: false, isDiscount: false, isFee: false, isDeposit: false },
        { itemName: "Spring Water", rawLine: "SPRING WATER 1.49", quantity: 0, unit: "count", unitPrice: 1.49, totalPrice: 1.49, category: "Other", updateInventory: false, isDiscount: false, isFee: false, isDeposit: false },
        { itemName: "Coupon", rawLine: "COUPON -1.00", quantity: 1, unit: "unknown", unitPrice: 1, totalPrice: -1, category: "Other", updateInventory: false, isDiscount: true, isFee: false, isDeposit: false },
        { itemName: "", rawLine: "", quantity: 1, unit: "unknown", unitPrice: 0, totalPrice: 0, category: "Other", updateInventory: false, isDiscount: false, isFee: false, isDeposit: false },
      ],
    }) }),
  });

  const result = await parser.parse({ fileName: "circle-k.jpg", mimeType: "image/jpeg", fileBuffer: jpeg });
  assert.equal(result.storeName, "Circle K");
  assert.equal(result.receiptDate, "");
  assert.equal(result.items.length, 3);
  assert.equal(result.items[1].quantity, 1);
  assert.equal(result.items[2].totalPrice, -1);
  assert.equal(result.items[2].isDiscount, true);
  assert.ok(result.warnings.some((warning) => warning.includes("Receipt date")));
  assert.ok(result.warnings.some((warning) => warning.includes("Dropped line item")));
});
