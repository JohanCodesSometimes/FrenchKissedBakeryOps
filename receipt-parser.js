const path = require("path");
const sharp = require("sharp");
const { convertToMarkdown } = require("./document-converter");

const imageExtensions = new Set([".jpg", ".jpeg", ".png", ".heic"]);
const mimeTypes = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".heic": "image/heic",
  ".pdf": "application/pdf",
};

function createReceiptParser({ env = process.env, fetchImpl = fetch, logger = console, convertImpl = convertToMarkdown } = {}) {
  const apiKey = env.OPENAI_API_KEY || "";
  const model = env.OPENAI_RECEIPT_MODEL || "gpt-4.1-mini";

  async function parse({ filePath, fileName, fileBuffer }) {
    if (!apiKey) throw receiptError("AI parsing failed", 503, "OPENAI_API_KEY is not configured");
    const extension = path.extname(fileName).toLowerCase();
    let content;
    let source;

    if (imageExtensions.has(extension)) {
      const normalized = await normalizeImage(fileBuffer, extension);
      content = imageContent(normalized.buffer, normalized.mimeType);
      source = "vision";
    } else {
      const converted = await convertImpl(filePath, { logger });
      const markdown = converted.ok ? converted.markdown.trim() : "";
      if (markdown) {
        content = [{ type: "input_text", text: `${receiptPrompt}\n\nDOCUMENT TEXT:\n${markdown.slice(0, 60_000)}` }];
        source = "markitdown";
      } else {
        content = fileContent(fileBuffer, fileName, extension);
        source = "vision_fallback";
      }
    }

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
          input: [{ role: "user", content }],
          text: { format: receiptFormat },
        }),
      });
    } catch (error) {
      logger.error(`[receipts] OpenAI request failed (${error.name || "network error"}).`);
      throw receiptError("AI parsing failed", 502);
    }

    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      logger.error(`[receipts] OpenAI returned ${response.status}; request ${response.headers?.get?.("x-request-id") || "unknown"}.`);
      throw receiptError("AI parsing failed", 502);
    }

    let parsed;
    try {
      parsed = JSON.parse(outputText(result));
    } catch {
      logger.error("[receipts] OpenAI returned an unreadable structured response.");
      throw receiptError("AI parsing failed", 502);
    }
    if (parsed.parseStatus === "too_blurry") throw receiptError("Receipt too blurry", 422);
    if (parsed.parseStatus === "no_items" || !Array.isArray(parsed.items) || !parsed.items.length) {
      throw receiptError("No readable items found", 422);
    }
    return { ...parsed, source, model };
  }

  return { parse, configured: Boolean(apiKey), model };
}

async function normalizeImage(buffer, extension) {
  try {
    const image = sharp(buffer).rotate().resize({
      width: 2400,
      height: 4000,
      fit: "inside",
      withoutEnlargement: true,
    });
    if (extension === ".heic") {
      return { buffer: await image.jpeg({ quality: 92 }).toBuffer(), mimeType: "image/jpeg" };
    }
    if (extension === ".png") return { buffer: await image.png({ compressionLevel: 8 }).toBuffer(), mimeType: "image/png" };
    return { buffer: await image.jpeg({ quality: 92 }).toBuffer(), mimeType: "image/jpeg" };
  } catch {
    throw receiptError("Receipt too blurry", 422);
  }
}

function imageContent(buffer, mimeType) {
  return [
    { type: "input_text", text: receiptPrompt },
    { type: "input_image", image_url: `data:${mimeType};base64,${buffer.toString("base64")}`, detail: "high" },
  ];
}

function fileContent(buffer, fileName, extension) {
  const mimeType = mimeTypes[extension] || "application/octet-stream";
  return [
    { type: "input_text", text: receiptPrompt },
    {
      type: "input_file",
      filename: fileName,
      file_data: `data:${mimeType};base64,${buffer.toString("base64")}`,
    },
  ];
}

function outputText(result) {
  if (typeof result.output_text === "string") return result.output_text;
  for (const output of result.output || []) {
    for (const content of output.content || []) {
      if (content.type === "output_text" && typeof content.text === "string") return content.text;
    }
  }
  return "";
}

function receiptError(message, statusCode, internalMessage) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.internalMessage = internalMessage;
  return error;
}

const receiptPrompt = `Read this grocery or supplier receipt for a bakery owner. Do not guess unreadable values.
Return parseStatus=too_blurry when the image is too blurry to identify the receipt and line items.
Return parseStatus=no_items when no purchasable line items are readable.
For a readable receipt, return parseStatus=readable and extract the store, date, totals, and every readable item.
Use YYYY-MM-DD for receiptDate, or an empty string if unreadable. Amounts are decimal dollars without currency symbols.
Normalize item units to lb, oz, g, kg, count, dozen, or gallon. Use count when packaging does not reveal another unit.
Classify each item as Ingredients, Packaging, Equipment, Utilities, or Other.
Set updateInventory true only for Ingredients and Packaging that represent physical bakery stock.`;

const receiptFormat = {
  type: "json_schema",
  name: "bakery_receipt",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["parseStatus", "storeName", "receiptDate", "subtotal", "tax", "total", "items"],
    properties: {
      parseStatus: { type: "string", enum: ["readable", "too_blurry", "no_items"] },
      storeName: { type: "string" },
      receiptDate: { type: "string" },
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
            unit: { type: "string", enum: ["lb", "oz", "g", "kg", "count", "dozen", "gallon"] },
            unitPrice: { type: "number", minimum: 0 },
            totalPrice: { type: "number", minimum: 0 },
            category: { type: "string", enum: ["Ingredients", "Packaging", "Equipment", "Utilities", "Other"] },
            updateInventory: { type: "boolean" },
          },
        },
      },
    },
  },
};

module.exports = { createReceiptParser, receiptFormat, imageExtensions };
