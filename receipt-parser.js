const path = require("path");

const ALLOWED_UNITS = ["lb", "oz", "g", "kg", "count", "dozen", "gallon"];
const ALLOWED_CATEGORIES = ["Ingredients", "Packaging", "Equipment", "Utilities", "Other"];

const receiptSchema = {
  type: "object",
  additionalProperties: false,
  required: ["parseStatus", "storeName", "receiptDate", "subtotal", "tax", "total", "items"],
  properties: {
    parseStatus: { type: "string", enum: ["readable", "too_blurry", "no_items"] },
    storeName: { type: "string" },
    receiptDate: { type: "string", description: "YYYY-MM-DD, or an empty string when unreadable" },
    subtotal: { type: "number", minimum: 0 },
    tax: { type: "number", minimum: 0 },
    total: { type: "number", minimum: 0 },
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["itemName", "quantity", "unit", "unitPrice", "totalPrice", "category", "updateInventory"],
        properties: {
          itemName: { type: "string" },
          quantity: { type: "number", exclusiveMinimum: 0 },
          unit: { type: "string", enum: ALLOWED_UNITS },
          unitPrice: { type: "number", minimum: 0 },
          totalPrice: { type: "number", minimum: 0 },
          category: { type: "string", enum: ALLOWED_CATEGORIES },
          updateInventory: { type: "boolean" },
        },
      },
    },
  },
};

function createReceiptParser({ env = process.env, fetchImpl = globalThis.fetch, logger = console } = {}) {
  const apiKey = String(env.OPENAI_API_KEY || "").trim();
  const model = String(env.OPENAI_RECEIPT_MODEL || "gpt-4.1-mini").trim();

  return {
    configured: Boolean(apiKey),
    async parse({ fileName, mimeType, fileBuffer }) {
      if (!apiKey) throw receiptError("Receipt AI is not configured.", 503, "not_configured");
      const detectedMime = validateImage(fileName, mimeType, fileBuffer);
      let response;
      try {
        response = await fetchImpl("https://api.openai.com/v1/responses", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model,
            input: [{
              role: "user",
              content: [
                { type: "input_text", text: receiptPrompt() },
                { type: "input_image", image_url: `data:${detectedMime};base64,${fileBuffer.toString("base64")}`, detail: "high" },
              ],
            }],
            text: { format: { type: "json_schema", name: "bakery_receipt", strict: true, schema: receiptSchema } },
          }),
        });
      } catch (error) {
        logger.error(`[receipts] OpenAI request failed (${error.name || "Error"}).`);
        throw receiptError("AI parsing failed", 502, "ai_failed");
      }

      if (!response.ok) {
        logger.error(`[receipts] OpenAI returned HTTP ${response.status}; request ${response.headers?.get?.("x-request-id") || "unknown"}.`);
        throw receiptError("AI parsing failed", 502, "ai_failed");
      }

      let payload;
      try {
        const result = await response.json();
        payload = JSON.parse(extractOutputText(result));
      } catch (error) {
        logger.error(`[receipts] OpenAI response could not be parsed (${error.name || "Error"}).`);
        throw receiptError("AI parsing failed", 502, "ai_failed");
      }

      if (payload.parseStatus === "too_blurry") throw receiptError("Receipt too blurry", 422, "too_blurry");
      if (payload.parseStatus === "no_items" || !Array.isArray(payload.items) || !payload.items.length) {
        throw receiptError("No readable items found", 422, "no_items");
      }
      if (!payload.storeName?.trim() || !/^\d{4}-\d{2}-\d{2}$/.test(payload.receiptDate || "")) {
        throw receiptError("Receipt details are unreadable", 422, "unreadable_details");
      }
      return normalizeReceipt(payload);
    },
  };
}

function validateImage(fileName, mimeType, buffer) {
  const extension = path.extname(String(fileName || "")).toLowerCase();
  const isJpeg = buffer?.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const isPng = buffer?.length >= 8 && buffer.subarray(0, 8).equals(pngSignature);
  if ((extension === ".jpg" || extension === ".jpeg") && isJpeg && (!mimeType || mimeType === "image/jpeg" || mimeType === "image/jpg")) return "image/jpeg";
  if (extension === ".png" && isPng && (!mimeType || mimeType === "image/png")) return "image/png";
  throw receiptError("Only JPG, JPEG, and PNG receipt images are supported", 415, "unsupported_type");
}

function extractOutputText(result) {
  if (typeof result.output_text === "string" && result.output_text.trim()) return result.output_text;
  for (const output of result.output || []) {
    for (const content of output.content || []) {
      if (content.type === "output_text" && content.text) return content.text;
    }
  }
  throw new Error("Missing output text");
}

function normalizeReceipt(receipt) {
  const money = (value) => Math.round(Number(value || 0) * 100) / 100;
  return {
    storeName: String(receipt.storeName).trim().slice(0, 120),
    receiptDate: receipt.receiptDate,
    subtotal: money(receipt.subtotal),
    tax: money(receipt.tax),
    total: money(receipt.total),
    items: receipt.items.map((item) => ({
      itemName: String(item.itemName).trim().slice(0, 160),
      quantity: money(item.quantity),
      unit: ALLOWED_UNITS.includes(item.unit) ? item.unit : "count",
      unitPrice: money(item.unitPrice),
      totalPrice: money(item.totalPrice),
      category: ALLOWED_CATEGORIES.includes(item.category) ? item.category : "Other",
      updateInventory: Boolean(item.updateInventory),
    })).filter((item) => item.itemName && item.quantity > 0),
  };
}

function receiptPrompt() {
  return `Read this grocery or supplier receipt for a bakery owner. Extract only text and numbers that are visible; never invent missing values.
Return parseStatus=too_blurry when the receipt cannot be read, or no_items when no purchasable line items are visible.
Use YYYY-MM-DD for receiptDate. Use count when no physical unit is shown. unitPrice is the price for one extracted unit and totalPrice is the line total.
Classify each item as Ingredients, Packaging, Equipment, Utilities, or Other. Set updateInventory true only for Ingredients or Packaging that represent stock the bakery can use. Exclude payment lines, loyalty savings summaries, balances, and subtotals from items.`;
}

function receiptError(message, statusCode, code) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

module.exports = { createReceiptParser, validateImage };
