const assert = require("node:assert/strict");
const test = require("node:test");
const sharp = require("sharp");
const { createReceiptParser } = require("../receipt-parser");

const readableReceipt = {
  parseStatus: "readable",
  storeName: "Publix",
  receiptDate: "2026-06-18",
  subtotal: 10,
  tax: 0.7,
  total: 10.7,
  items: [{
    itemName: "Bread Flour",
    quantity: 1,
    unit: "lb",
    unitPrice: 10,
    totalPrice: 10,
    category: "Ingredients",
    updateInventory: true,
  }],
};

test("image receipts use vision and structured output", async () => {
  let requestBody;
  const parser = createReceiptParser({
    env: { OPENAI_API_KEY: "test-key", OPENAI_RECEIPT_MODEL: "vision-model" },
    fetchImpl: async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return responseWith(readableReceipt);
    },
  });
  const image = await sharp({ create: { width: 4, height: 4, channels: 3, background: "white" } }).jpeg().toBuffer();
  const parsed = await parser.parse({ filePath: "receipt.jpg", fileName: "receipt.jpg", fileBuffer: image });
  assert.equal(parsed.source, "vision");
  assert.equal(parsed.storeName, "Publix");
  assert.equal(requestBody.model, "vision-model");
  assert.equal(requestBody.input[0].content[1].type, "input_image");
  assert.equal(requestBody.text.format.type, "json_schema");
});

test("text documents use non-empty MarkItDown output before OpenAI", async () => {
  let content;
  const parser = createReceiptParser({
    env: { OPENAI_API_KEY: "test-key" },
    convertImpl: async () => ({ ok: true, markdown: "Publix receipt with flour item and total $10.70" }),
    fetchImpl: async (_url, options) => {
      content = JSON.parse(options.body).input[0].content;
      return responseWith(readableReceipt);
    },
  });
  const parsed = await parser.parse({ filePath: "receipt.pdf", fileName: "receipt.pdf", fileBuffer: Buffer.from("pdf") });
  assert.equal(parsed.source, "markitdown");
  assert.equal(content.length, 1);
  assert.match(content[0].text, /DOCUMENT TEXT/);
});

test("empty MarkItDown output falls back to a file input", async () => {
  let content;
  const parser = createReceiptParser({
    env: { OPENAI_API_KEY: "test-key" },
    convertImpl: async () => ({ ok: false, markdown: "" }),
    fetchImpl: async (_url, options) => {
      content = JSON.parse(options.body).input[0].content;
      return responseWith(readableReceipt);
    },
  });
  const parsed = await parser.parse({ filePath: "receipt.pdf", fileName: "receipt.pdf", fileBuffer: Buffer.from("pdf") });
  assert.equal(parsed.source, "vision_fallback");
  assert.equal(content[1].type, "input_file");
});

test("maps unreadable receipts to a clear error", async () => {
  const parser = createReceiptParser({
    env: { OPENAI_API_KEY: "test-key" },
    fetchImpl: async () => responseWith({ ...readableReceipt, parseStatus: "too_blurry", items: [] }),
  });
  const image = await sharp({ create: { width: 2, height: 2, channels: 3, background: "white" } }).png().toBuffer();
  await assert.rejects(
    parser.parse({ filePath: "receipt.png", fileName: "receipt.png", fileBuffer: image }),
    /Receipt too blurry/,
  );
});

test("maps empty item extraction to a clear error", async () => {
  const parser = createReceiptParser({
    env: { OPENAI_API_KEY: "test-key" },
    convertImpl: async () => ({ ok: true, markdown: "Readable document text without purchasable line items." }),
    fetchImpl: async () => responseWith({ ...readableReceipt, parseStatus: "no_items", items: [] }),
  });
  await assert.rejects(
    parser.parse({ filePath: "receipt.pdf", fileName: "receipt.pdf", fileBuffer: Buffer.from("pdf") }),
    /No readable items found/,
  );
});

test("maps OpenAI failures without returning provider details", async () => {
  const parser = createReceiptParser({
    env: { OPENAI_API_KEY: "test-key" },
    logger: { error() {} },
    convertImpl: async () => ({ ok: true, markdown: "Publix receipt text with several grocery line items." }),
    fetchImpl: async () => ({
      ok: false,
      status: 500,
      headers: { get() { return "request-id"; } },
      async json() { return { error: { message: "provider secret detail" } }; },
    }),
  });
  await assert.rejects(
    parser.parse({ filePath: "receipt.pdf", fileName: "receipt.pdf", fileBuffer: Buffer.from("pdf") }),
    (error) => error.message === "AI parsing failed" && !error.message.includes("provider secret detail"),
  );
});

function responseWith(value) {
  return {
    ok: true,
    headers: { get() { return null; } },
    async json() { return { output_text: JSON.stringify(value) }; },
  };
}
