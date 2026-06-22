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
        items: [{ itemName: "Flour", quantity: 1, unit: "lb", unitPrice: 10, totalPrice: 10, category: "Ingredients", updateInventory: true }],
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
      parseStatus: "too_blurry", storeName: "", receiptDate: "", subtotal: 0, tax: 0, total: 0, items: [],
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
