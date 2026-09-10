const path = require("path");

const ALLOWED_UNITS = ["lb", "oz", "g", "kg", "count", "dozen", "gallon", "unknown"];
const ALLOWED_CATEGORIES = ["Ingredients", "Packaging", "Equipment", "Utilities", "Other"];

const receiptSchema = {
  type: "object",
  additionalProperties: false,
  required: ["parseStatus", "storeName", "receiptDate", "subtotal", "tax", "total", "rawTextLines", "confidence", "warnings", "ignoredLines", "items"],
  properties: {
    parseStatus: { type: "string", enum: ["readable", "too_blurry", "no_items"] },
    storeName: { type: "string" },
    receiptDate: { type: "string", description: "YYYY-MM-DD, or an empty string when unreadable" },
    subtotal: { type: "number" },
    tax: { type: "number" },
    total: { type: "number" },
    rawTextLines: { type: "array", items: { type: "string" } },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    warnings: { type: "array", items: { type: "string" } },
    ignoredLines: { type: "array", items: { type: "string" } },
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["itemName", "rawLine", "receivedQuantity", "receivedUnit", "packageCount", "packageSizeQuantity", "packageSizeUnit", "quantityUncertain", "unitPrice", "totalPrice", "category", "updateInventory", "isDiscount", "isFee", "isDeposit"],
        properties: {
          itemName: { type: "string" },
          rawLine: { type: "string" },
          receivedQuantity: { type: "number", description: "Total stock received. Use 0 when it cannot be determined from visible text." },
          receivedUnit: { type: "string", enum: ALLOWED_UNITS },
          packageCount: { type: "number", description: "Number of packages purchased, or 0 when not shown." },
          packageSizeQuantity: { type: "number", description: "Quantity in each package, or 0 when not shown." },
          packageSizeUnit: { type: "string", enum: ALLOWED_UNITS },
          quantityUncertain: { type: "boolean" },
          unitPrice: { type: "number" },
          totalPrice: { type: "number" },
          category: { type: "string", enum: ALLOWED_CATEGORIES },
          updateInventory: { type: "boolean" },
          isDiscount: { type: "boolean" },
          isFee: { type: "boolean" },
          isDeposit: { type: "boolean" },
        },
      },
    },
  },
};

function createReceiptParser({ env = process.env, fetchImpl = globalThis.fetch, logger = console } = {}) {
  const apiKey = String(env.OPENAI_API_KEY || "").trim();
  const model = String(env.OPENAI_RECEIPT_MODEL || "gpt-4.1-mini").trim();
  const development = env.NODE_ENV === "development";

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
        debugFailure(logger, development, "OpenAI request failed");
        throw receiptError("AI parsing failed", 502, "ai_failed");
      }

      if (!response.ok) {
        logger.error(`[receipts] OpenAI returned HTTP ${response.status}; request ${response.headers?.get?.("x-request-id") || "unknown"}.`);
        debugFailure(logger, development, `OpenAI HTTP ${response.status}`);
        throw receiptError("AI parsing failed", 502, "ai_failed");
      }

      let payload;
      try {
        const result = await response.json();
        payload = JSON.parse(extractOutputText(result));
      } catch (error) {
        logger.error(`[receipts] OpenAI response could not be parsed (${error.name || "Error"}).`);
        debugFailure(logger, development, "Response JSON could not be parsed");
        throw receiptError("AI parsing failed", 502, "ai_failed");
      }

      if (payload.parseStatus === "too_blurry") {
        debugReceipt(logger, development, payload, stringList(payload.warnings), "Text could not be read");
        throw receiptError("Receipt too blurry", 422, "too_blurry");
      }

      const normalized = normalizeReceipt(payload);
      debugReceipt(logger, development, payload, normalized.warnings);

      if (payload.parseStatus === "no_items" || !normalized.items.length) {
        debugFailure(logger, development, "No usable line items remained after tolerant validation");
        throw receiptError("No readable items found", 422, "no_items");
      }
      return normalized;
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
  const warnings = stringList(receipt.warnings);
  const rawTextLines = stringList(receipt.rawTextLines);
  const ignoredLines = stringList(receipt.ignoredLines);
  const storeName = String(receipt.storeName || "").trim().slice(0, 120);
  let receiptDate = String(receipt.receiptDate || "").trim();

  if (!storeName) warnings.push("Store name was not readable; enter it before approval.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(receiptDate)) {
    receiptDate = "";
    warnings.push("Receipt date was not readable; enter it before approval.");
  }

  const subtotal = tolerantMoney(receipt.subtotal, "Subtotal", warnings);
  const tax = tolerantMoney(receipt.tax, "Tax", warnings);
  const total = tolerantMoney(receipt.total, "Total", warnings);
  const items = [];

  for (const [index, source] of (Array.isArray(receipt.items) ? receipt.items : []).entries()) {
    const rawLine = String(source?.rawLine || "").trim().slice(0, 300);
    const itemName = String(source?.itemName || rawLine).trim().slice(0, 160);
    if (!itemName) {
      warnings.push(`Dropped line item ${index + 1} because its name was unreadable.`);
      continue;
    }

    let receivedQuantity = Number(source.receivedQuantity ?? source.quantity);
    const quantityUncertain = Boolean(source.quantityUncertain) || !Number.isFinite(receivedQuantity) || receivedQuantity <= 0;
    if (!Number.isFinite(receivedQuantity) || receivedQuantity <= 0) {
      receivedQuantity = 0;
      warnings.push(`${itemName}: received quantity was unclear; correct it before updating inventory.`);
    }

    const receivedUnit = ALLOWED_UNITS.includes(source.receivedUnit) ? source.receivedUnit
      : ALLOWED_UNITS.includes(source.unit) ? source.unit : "unknown";
    if (receivedUnit === "unknown") warnings.push(`${itemName}: received unit was not shown.`);
    const packageCount = optionalPositiveNumber(source.packageCount);
    const packageSizeQuantity = optionalPositiveNumber(source.packageSizeQuantity);
    const packageSizeUnit = ALLOWED_UNITS.includes(source.packageSizeUnit) ? source.packageSizeUnit : "unknown";

    let totalPrice = Number(source.totalPrice);
    if (!Number.isFinite(totalPrice)) {
      totalPrice = 0;
      warnings.push(`${itemName}: total price was unclear and was set to 0.`);
    }

    let unitPrice = Number(source.unitPrice);
    if (!Number.isFinite(unitPrice) || unitPrice < 0 || (unitPrice === 0 && totalPrice !== 0)) {
      unitPrice = packageCount ? Math.abs(totalPrice) / packageCount
        : receivedQuantity > 0 ? Math.abs(totalPrice) / receivedQuantity : 0;
      warnings.push(`${itemName}: unit price was estimated from the line total.`);
    }

    const isDiscount = Boolean(source.isDiscount);
    const isFee = Boolean(source.isFee);
    const isDeposit = Boolean(source.isDeposit);
    const category = ALLOWED_CATEGORIES.includes(source.category) ? source.category : "Other";
    items.push({
      itemName,
      rawLine,
      quantity: roundQuantity(receivedQuantity),
      unit: receivedUnit,
      receivedQuantity: roundQuantity(receivedQuantity),
      receivedUnit,
      packageCount,
      packageSizeQuantity,
      packageSizeUnit,
      quantityUncertain,
      unitPrice: round(unitPrice),
      totalPrice: round(totalPrice),
      category,
      updateInventoryRequested: Boolean(source.updateInventory),
      updateInventory: Boolean(source.updateInventory) && !quantityUncertain && receivedUnit !== "unknown" && !isDiscount && !isFee && !isDeposit,
      isDiscount,
      isFee,
      isDeposit,
    });
  }

  return {
    parseStatus: receipt.parseStatus === "readable" ? "readable" : receipt.parseStatus,
    storeName,
    receiptDate,
    subtotal,
    tax,
    total,
    rawTextLines,
    confidence: Math.max(0, Math.min(1, Number(receipt.confidence) || 0)),
    warnings: [...new Set(warnings)],
    ignoredLines,
    items,
  };
}

function tolerantMoney(value, label, warnings) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    warnings.push(`${label} was not readable and was set to 0.`);
    return 0;
  }
  return round(number);
}

function stringList(value) {
  return Array.isArray(value) ? value.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 500) : [];
}

function optionalPositiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? roundQuantity(number) : null;
}

function round(value) {
  return Math.round(Number(value) * 100) / 100;
}

function roundQuantity(value) {
  return Math.round(Number(value) * 10000) / 10000;
}

function debugReceipt(logger, enabled, payload, warnings = [], reason = "") {
  if (!enabled) return;
  logger.log("[receipts:debug]", {
    parseStatus: payload?.parseStatus || "missing",
    itemCount: Array.isArray(payload?.items) ? payload.items.length : 0,
    warnings,
    rawTextLines: stringList(payload?.rawTextLines).slice(0, 5),
    validationFailureReason: reason || null,
  });
}

function debugFailure(logger, enabled, reason) {
  if (enabled) logger.log("[receipts:debug]", { validationFailureReason: reason });
}

function receiptPrompt() {
  return `Read this real-world grocery, convenience store, or supplier receipt for a bakery owner. Extract only text and numbers that are visible; never invent missing purchases.
First transcribe every visible receipt line in reading order into rawTextLines. Then extract every visible purchasable line item, including convenience store items, groceries, drinks, snacks, bakery supplies, packaging, and ingredients. Do not reject or discard an item because it is not bakery-specific.
Only use parseStatus=too_blurry when the receipt text cannot be read. Only use no_items when there are truly no visible line items. A partially readable receipt with one or more readable purchases is readable.
Use YYYY-MM-DD for receiptDate, or an empty string when the date is unreadable. Store name may also be empty. Use 0 for unreadable subtotal, tax, or total and explain missing or uncertain fields in warnings.
Preserve the visible source text for each item in rawLine. Keep stock received separate from pricing and packaging: packageCount is the number of packages, packageSizeQuantity/packageSizeUnit describe one package, and receivedQuantity/receivedUnit are the total usable stock received. For example, two 5 lb bags are packageCount 2, packageSizeQuantity 5, packageSizeUnit lb, receivedQuantity 10, receivedUnit lb. Use 0 and quantityUncertain=true when the received amount is not supported by visible text. Use unknown when the stock unit is not visible. unitPrice is the visible or calculated price per purchased package; totalPrice is the line total. Never treat a price, line total, or package count as received stock quantity. Never discard readable items simply because they are not inventory ingredients.
Deposits, recycling fees, taxes, discounts, and coupons must not cause parsing failure. Put non-item summary lines in ignoredLines. If represented as items, mark isFee, isDeposit, or isDiscount accurately; discount totalPrice may be negative. Set updateInventory false for discounts, fees, deposits, and non-stock purchases.
Classify ordinary purchases as Ingredients, Packaging, Equipment, Utilities, or Other. Return a confidence from 0 to 1 and concise warnings for uncertain fields.`;
}

function receiptError(message, statusCode, code) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

module.exports = { createReceiptParser, validateImage };
