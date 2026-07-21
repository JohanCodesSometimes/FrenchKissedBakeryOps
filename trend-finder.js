"use strict";

const CATEGORIES = ["pastries", "cakes", "cookies", "drinks", "seasonal", "packaging", "other"];
const STATUSES = ["active", "watching", "testing", "adopted", "archived"];
const SORTS = ["opportunity", "recent", "oldest", "engagement", "relevance"];
const DATA_ORIGINS = ["manual", "demo", "provider"];
const TEST_OUTCOMES = ["repeat", "adopt", "revise", "dismiss"];
const PATCH_FIELDS = new Set([
  "description", "category", "engagementScore", "relevanceScore", "opportunityScore",
  "trendStatus", "suggestedProduct", "suggestedAction", "hashtags", "sourceUrl",
  "expectedIngredientCost", "plannedQuantity", "testDate", "targetSellingPrice", "testNotes",
  "actualQuantityProduced", "actualQuantitySold", "actualRevenue", "resultNotes", "testOutcome",
]);

function normalizeTrendInput(input, options = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw validationError("A JSON object is required");
  const now = options.now || new Date().toISOString();
  const title = requiredText(input.title, "Title", 160);
  const firstSeenAt = timestamp(input.firstSeenAt, "First seen date", now);
  const lastSeenAt = timestamp(input.lastSeenAt, "Last seen date", now);
  if (Date.parse(lastSeenAt) < Date.parse(firstSeenAt)) throw validationError("Last seen date cannot be before first seen date");
  const trend = {
    id: options.id,
    title,
    description: optionalText(input.description, 2000),
    category: allowed(input.category || "other", CATEGORIES, "Category"),
    sourcePlatform: optionalText(input.sourcePlatform || "Manual curation", 80),
    sourceUrl: sourceUrl(input.sourceUrl),
    hashtags: normalizeHashtags(input.hashtags),
    engagementScore: score(input.engagementScore, "Engagement score", 0),
    relevanceScore: score(input.relevanceScore, "Relevance score", 0),
    opportunityScore: score(input.opportunityScore, "Opportunity score", 0),
    trendStatus: allowed(input.trendStatus || "active", STATUSES, "Status"),
    suggestedProduct: optionalText(input.suggestedProduct, 500),
    suggestedAction: optionalText(input.suggestedAction, 1000),
    analysisReasoning: optionalText(input.analysisReasoning, 1000),
    expectedIngredientCost: nullableMoney(input.expectedIngredientCost, "Expected ingredient cost"),
    plannedQuantity: nullableQuantity(input.plannedQuantity, "Planned quantity", false),
    testDate: nullableDate(input.testDate, "Test date"),
    targetSellingPrice: nullableMoney(input.targetSellingPrice, "Target selling price"),
    testNotes: optionalText(input.testNotes, 2000),
    actualQuantityProduced: nullableQuantity(input.actualQuantityProduced, "Actual quantity produced", true),
    actualQuantitySold: nullableQuantity(input.actualQuantitySold, "Actual quantity sold", true),
    actualRevenue: nullableMoney(input.actualRevenue, "Actual revenue"),
    resultNotes: optionalText(input.resultNotes, 2000),
    testOutcome: nullableAllowed(input.testOutcome, TEST_OUTCOMES, "Final outcome"),
    dataOrigin: allowed(options.dataOrigin || input.dataOrigin || "manual", DATA_ORIGINS, "Data origin"),
    firstSeenAt,
    lastSeenAt,
    createdAt: options.createdAt || now,
    updatedAt: options.updatedAt || now,
  };
  const planValues = [trend.expectedIngredientCost, trend.plannedQuantity, trend.testDate, trend.targetSellingPrice];
  if (planValues.some((value) => value !== null && value !== "") && planValues.some((value) => value === null || value === "")) {
    throw validationError("Complete expected cost, planned quantity, test date, and target selling price");
  }
  if (trend.actualQuantityProduced !== null && trend.actualQuantitySold !== null && trend.actualQuantitySold > trend.actualQuantityProduced) {
    throw validationError("Actual quantity sold cannot exceed actual quantity produced");
  }
  return trend;
}

function normalizeTrendPatch(input, existing, options = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw validationError("A JSON object is required");
  const keys = Object.keys(input);
  if (!keys.length) throw validationError("At least one editable field is required");
  const unsupported = keys.filter((key) => !PATCH_FIELDS.has(key));
  if (unsupported.length) throw validationError(`Unsupported trend field: ${unsupported[0]}`);
  const patch = {};
  if ("description" in input) patch.description = optionalText(input.description, 2000);
  if ("category" in input) patch.category = allowed(input.category, CATEGORIES, "Category");
  if ("engagementScore" in input) patch.engagementScore = score(input.engagementScore, "Engagement score");
  if ("relevanceScore" in input) patch.relevanceScore = score(input.relevanceScore, "Relevance score");
  if ("opportunityScore" in input) patch.opportunityScore = score(input.opportunityScore, "Opportunity score");
  if ("trendStatus" in input) patch.trendStatus = allowed(input.trendStatus, STATUSES, "Status");
  if ("suggestedProduct" in input) patch.suggestedProduct = optionalText(input.suggestedProduct, 500);
  if ("suggestedAction" in input) patch.suggestedAction = optionalText(input.suggestedAction, 1000);
  if ("hashtags" in input) patch.hashtags = normalizeHashtags(input.hashtags);
  if ("sourceUrl" in input) patch.sourceUrl = sourceUrl(input.sourceUrl);
  const planFields = ["expectedIngredientCost", "plannedQuantity", "testDate", "targetSellingPrice"];
  if (planFields.some((field) => field in input)) {
    for (const field of planFields) {
      if (!(field in input) || input[field] === "" || input[field] === null || input[field] === undefined) {
        throw validationError("Complete expected cost, planned quantity, test date, and target selling price");
      }
    }
  }
  if ("expectedIngredientCost" in input) patch.expectedIngredientCost = nullableMoney(input.expectedIngredientCost, "Expected ingredient cost");
  if ("plannedQuantity" in input) patch.plannedQuantity = nullableQuantity(input.plannedQuantity, "Planned quantity", false);
  if ("testDate" in input) patch.testDate = nullableDate(input.testDate, "Test date");
  if ("targetSellingPrice" in input) patch.targetSellingPrice = nullableMoney(input.targetSellingPrice, "Target selling price");
  if ("testNotes" in input) patch.testNotes = optionalText(input.testNotes, 2000);
  if ("actualQuantityProduced" in input) patch.actualQuantityProduced = nullableQuantity(input.actualQuantityProduced, "Actual quantity produced", true);
  if ("actualQuantitySold" in input) patch.actualQuantitySold = nullableQuantity(input.actualQuantitySold, "Actual quantity sold", true);
  if ("actualRevenue" in input) patch.actualRevenue = nullableMoney(input.actualRevenue, "Actual revenue");
  if ("resultNotes" in input) patch.resultNotes = optionalText(input.resultNotes, 2000);
  if ("testOutcome" in input) patch.testOutcome = nullableAllowed(input.testOutcome, TEST_OUTCOMES, "Final outcome");
  const produced = patch.actualQuantityProduced ?? existing.actualQuantityProduced;
  const sold = patch.actualQuantitySold ?? existing.actualQuantitySold;
  if (produced !== null && produced !== undefined && sold !== null && sold !== undefined && sold > produced) {
    throw validationError("Actual quantity sold cannot exceed actual quantity produced");
  }
  return { ...existing, ...patch, updatedAt: options.now || new Date().toISOString() };
}

function parseTrendQuery(searchParams) {
  const allowedParams = new Set(["category", "status", "search", "limit", "sort"]);
  for (const key of searchParams.keys()) {
    if (!allowedParams.has(key)) throw validationError(`Unsupported query parameter: ${key}`);
  }
  const category = searchParams.get("category") || "";
  const status = searchParams.get("status") || "";
  const search = optionalText(searchParams.get("search"), 120).toLowerCase();
  const sort = searchParams.get("sort") || "opportunity";
  if (category) allowed(category, CATEGORIES, "Category");
  if (status) allowed(status, STATUSES, "Status");
  allowed(sort, SORTS, "Sort order");
  const rawLimit = searchParams.get("limit");
  const limit = rawLimit === null ? 100 : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw validationError("Limit must be an integer from 1 to 200");
  return { category, status, search, sort, limit };
}

function filterAndSortTrends(trends, query) {
  const filtered = trends.filter((trend) => {
    if (query.category && trend.category !== query.category) return false;
    if (query.status && trend.trendStatus !== query.status) return false;
    if (!query.search) return true;
    const haystack = [trend.title, trend.description, trend.suggestedProduct, ...(trend.hashtags || [])]
      .join(" ").toLowerCase();
    return haystack.includes(query.search);
  });
  const comparisons = {
    opportunity: (a, b) => number(b.opportunityScore) - number(a.opportunityScore) || newestFirst(a, b),
    recent: newestFirst,
    oldest: (a, b) => Date.parse(a.lastSeenAt || 0) - Date.parse(b.lastSeenAt || 0),
    engagement: (a, b) => number(b.engagementScore) - number(a.engagementScore) || newestFirst(a, b),
    relevance: (a, b) => number(b.relevanceScore) - number(a.relevanceScore) || newestFirst(a, b),
  };
  return filtered.sort(comparisons[query.sort]).slice(0, query.limit);
}

function findDuplicate(trends, candidate, excludeId = "") {
  const titleKey = key(candidate.title);
  const urlKey = (candidate.sourceUrl || "").toLowerCase();
  return trends.find((trend) => trend.id !== excludeId && (
    key(trend.title) === titleKey || (urlKey && (trend.sourceUrl || "").toLowerCase() === urlKey)
  ));
}

function analyzeTrend(trend, context = {}) {
  const text = [trend.title, trend.description, ...(trend.hashtags || [])].join(" ").toLowerCase();
  const bakeryHits = hits(text, ["bakery", "bake", "pastry", "croissant", "cake", "cookie", "bread", "dessert", "frost", "chocolate", "cream", "dough", "latte"]);
  const visualHits = hits(text, ["color", "layer", "mini", "glaze", "swirl", "stuffed", "flight", "box", "reveal", "aesthetic", "viral"]);
  const difficultHits = hits(text, ["laminated", "sculpted", "multi-day", "tempered", "intricate", "custom mold"]);
  const premiumHits = hits(text, ["premium", "gift", "box", "flight", "limited", "filled", "mini", "custom"]);
  const inventoryNames = (context.inventory || []).map((item) => String(item.ingredientName || "").toLowerCase()).filter(Boolean);
  const availableHits = inventoryNames.filter((name) => name.length >= 3 && text.includes(name)).length;
  const month = Number(String(context.now || new Date().toISOString()).slice(5, 7));
  const seasonal = seasonFit(text, month);

  const categoryFit = trend.category === "packaging" ? 18 : trend.category === "other" ? 8 : 28;
  const relevanceScore = clamp(Math.round(25 + categoryFit + Math.min(32, bakeryHits * 7) + Math.min(15, availableHits * 5)));
  const visual = clamp(45 + Math.min(45, visualHits * 9));
  const ease = clamp(78 - difficultHits * 18);
  const availability = inventoryNames.length ? clamp(45 + availableHits * 15) : 55;
  const margin = clamp(52 + premiumHits * 9);
  const engagement = score(trend.engagementScore, "Engagement score", 0);
  const opportunityScore = clamp(Math.round(
    relevanceScore * 0.35 + engagement * 0.2 + visual * 0.15 + ease * 0.1 + availability * 0.1 + margin * 0.1 + seasonal,
  ));
  const recommendation = recommendationFor(trend, opportunityScore);
  const reasoning = `Bakery fit ${relevanceScore}/100; visual appeal ${visual}/100; production ease ${ease}/100; ingredient readiness ${availability}/100; margin signal ${margin}/100; engagement ${engagement}/100${seasonal ? `; seasonality ${seasonal > 0 ? "+" : ""}${seasonal}` : ""}.`;
  return {
    ...trend,
    relevanceScore,
    opportunityScore,
    suggestedProduct: recommendation.product,
    suggestedAction: recommendation.action,
    analysisReasoning: reasoning,
    updatedAt: context.now || new Date().toISOString(),
  };
}

function buildTrendSummary(trends, now = new Date()) {
  const weekAgo = now.getTime() - 7 * 24 * 60 * 60 * 1000;
  const visible = trends.filter((trend) => trend.trendStatus !== "archived");
  return {
    activeTrends: visible.filter((trend) => trend.trendStatus === "active").length,
    highOpportunityTrends: visible.filter((trend) => number(trend.opportunityScore) >= 75).length,
    newThisWeek: visible.filter((trend) => Date.parse(trend.firstSeenAt) >= weekAgo).length,
    averageOpportunityScore: visible.length
      ? Math.round(visible.reduce((total, trend) => total + number(trend.opportunityScore), 0) / visible.length)
      : 0,
  };
}

function recommendationFor(trend, opportunity) {
  const name = trend.title.replace(/\s+(trend|challenge)$/i, "").trim();
  const products = {
    pastries: `${name} weekend pastry`,
    cakes: `${name} mini celebration cake`,
    cookies: `${name} limited cookie`,
    drinks: `${name} bakery drink special`,
    seasonal: `${name} seasonal bake`,
    packaging: `${name} presentation box`,
    other: `${name} small-batch special`,
  };
  const action = opportunity >= 75
    ? "Run a 12-unit weekend test, photograph it, record ingredient cost and sell-through, then decide whether to repeat."
    : opportunity >= 50
      ? "Watch for one week and cost a small prototype before committing production time."
      : "Keep archived as inspiration unless customer requests or stronger engagement make it more relevant.";
  return { product: products[trend.category], action };
}

function normalizeHashtags(value) {
  const values = Array.isArray(value) ? value : String(value || "").split(/[\s,]+/);
  const normalized = values.map((item) => String(item).trim()).filter(Boolean).map((item) => {
    const tag = item.replace(/^#+/, "").replace(/[^\p{L}\p{N}_-]/gu, "").slice(0, 60);
    return tag ? `#${tag}` : "";
  }).filter(Boolean);
  return [...new Set(normalized)].slice(0, 20);
}

function sourceUrl(value) {
  const text = optionalText(value, 1000);
  if (!text) return "";
  let parsed;
  try { parsed = new URL(text); } catch { throw validationError("Source URL must be a valid http or https URL"); }
  if (!["http:", "https:"].includes(parsed.protocol)) throw validationError("Source URL must use http or https");
  return parsed.toString();
}

function timestamp(value, label, fallback) {
  if (!value) return fallback;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw validationError(`${label} is invalid`);
  return new Date(time).toISOString();
}

function score(value, label, fallback) {
  if ((value === undefined || value === null || value === "") && fallback !== undefined) return fallback;
  const result = Number(value);
  if (!Number.isFinite(result) || result < 0 || result > 100) throw validationError(`${label} must be from 0 to 100`);
  return Math.round(result);
}

function nullableMoney(value, label) {
  if (value === undefined || value === null || value === "") return null;
  const result = Number(value);
  if (!Number.isFinite(result) || result < 0 || result > 100_000_000) throw validationError(`${label} must be a valid non-negative amount`);
  return Math.round((result + Number.EPSILON) * 100) / 100;
}

function nullableQuantity(value, label, allowZero) {
  if (value === undefined || value === null || value === "") return null;
  const result = Number(value);
  const minimum = allowZero ? 0 : 1;
  if (!Number.isInteger(result) || result < minimum || result > 1_000_000) {
    throw validationError(`${label} must be a whole number${allowZero ? " of 0 or more" : " of 1 or more"}`);
  }
  return result;
}

function nullableDate(value, label) {
  if (value === undefined || value === null || value === "") return null;
  const text = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(Date.parse(`${text}T00:00:00Z`))) {
    throw validationError(`${label} must be a valid date`);
  }
  return text;
}

function nullableAllowed(value, values, label) {
  if (value === undefined || value === null || value === "") return "";
  return allowed(value, values, label);
}

function allowed(value, values, label) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!values.includes(normalized)) throw validationError(`${label} is invalid`);
  return normalized;
}

function requiredText(value, label, maximum) {
  const text = optionalText(value, maximum);
  if (!text) throw validationError(`${label} is required`);
  return text;
}

function optionalText(value, maximum) {
  const text = String(value ?? "").trim();
  if (text.length > maximum) throw validationError(`Text must be ${maximum} characters or fewer`);
  return text;
}

function seasonFit(text, month) {
  const seasons = [
    { words: ["valentine", "heart"], months: [1, 2] },
    { words: ["spring", "easter"], months: [3, 4, 5] },
    { words: ["summer", "lemon", "berry"], months: [6, 7, 8] },
    { words: ["fall", "pumpkin", "apple", "halloween"], months: [9, 10, 11] },
    { words: ["holiday", "christmas", "gingerbread"], months: [11, 12] },
  ];
  const match = seasons.find((season) => season.words.some((word) => text.includes(word)));
  return match ? (match.months.includes(month) ? 8 : -5) : 0;
}

function hits(text, words) { return words.reduce((total, word) => total + (text.includes(word) ? 1 : 0), 0); }
function newestFirst(a, b) { return Date.parse(b.lastSeenAt || 0) - Date.parse(a.lastSeenAt || 0); }
function number(value) { return Number(value || 0); }
function key(value) { return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); }
function clamp(value) { return Math.max(0, Math.min(100, value)); }
function validationError(message) { const error = new Error(message); error.statusCode = 400; return error; }

module.exports = {
  CATEGORIES, STATUSES, SORTS, TEST_OUTCOMES, analyzeTrend, buildTrendSummary, filterAndSortTrends,
  findDuplicate, normalizeTrendInput, normalizeTrendPatch, parseTrendQuery,
};
