"use strict";

const DEFAULT_TOPICS = [
  "bakery trends",
  "pastry trends",
  "cake decorating trends",
  "artisan bread trends",
  "dessert trends",
  "cafe bakery trends",
];
const BAKERY_TERMS = [
  "bakery", "bake", "pastry", "croissant", "cake", "cookie", "bread", "dessert",
  "tart", "macaron", "brioche", "chocolate", "cream", "dough", "cafe",
];

function createYouTubeTrendService(options = {}) {
  const env = options.env || process.env;
  const apiKey = String(env.YOUTUBE_API_KEY || "").trim();
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const now = options.now || (() => new Date());
  const cacheTtlMs = positiveNumber(options.cacheTtlMs, 6 * 60 * 60 * 1000);
  const minRefreshMs = positiveNumber(options.minRefreshMs, 5 * 60 * 1000);
  const timeoutMs = positiveNumber(options.timeoutMs, 8_000);
  const topics = Array.isArray(options.topics) && options.topics.length ? options.topics : DEFAULT_TOPICS;
  let cache = null;
  let lastResult = null;
  let inFlight = null;
  let lastAttemptAt = 0;
  let topicOffset = 0;

  function status() {
    return {
      configured: Boolean(apiKey),
      available: Boolean(apiKey),
      state: apiKey ? (cache ? "ready" : "idle") : "not_configured",
      cached: Boolean(cache),
      retrievedAt: cache?.retrievedAt || null,
    };
  }

  async function discover({ refresh = false, inventory = [] } = {}) {
    if (!apiKey) return unavailable("not_configured", "Add YOUTUBE_API_KEY on the server to enable YouTube discovery.");
    const currentMs = now().getTime();
    if (!refresh && cache && currentMs - Date.parse(cache.retrievedAt) < cacheTtlMs) {
      return { ...cache, cached: true };
    }
    if (inFlight) return inFlight;
    if (currentMs - lastAttemptAt < minRefreshMs && (cache || lastResult)) {
      return {
        ...(lastResult || cache),
        cached: Boolean(cache),
        refreshLimited: Boolean(refresh),
      };
    }

    lastAttemptAt = currentMs;
    inFlight = runDiscovery({ inventory })
      .catch((error) => {
        const normalized = normalizeProviderError(error);
        if (cache) {
          return {
            ...cache,
            cached: true,
            stale: true,
            error: normalized,
          };
        }
        return unavailable(normalized.code, normalized.message, normalized.retryable);
      })
      .then((result) => {
        lastResult = result;
        return result;
      })
      .finally(() => { inFlight = null; });
    return inFlight;
  }

  async function runDiscovery({ inventory }) {
    const selectedTopics = rotateTopics(topics, topicOffset, 3);
    topicOffset = (topicOffset + selectedTopics.length) % topics.length;
    const publishedAfter = new Date(now().getTime() - 90 * 24 * 60 * 60 * 1000).toISOString();
    const searchResponses = await Promise.all(selectedTopics.map((topic) => apiRequest("search", {
      part: "snippet",
      q: topic,
      type: "video",
      order: "relevance",
      maxResults: "4",
      publishedAfter,
      relevanceLanguage: "en",
      safeSearch: "moderate",
    })));
    const candidates = [];
    searchResponses.forEach((response, index) => {
      if (!Array.isArray(response.items)) throw providerError("malformed_response", "YouTube returned an unreadable search response.", false);
      response.items.forEach((item) => {
        const id = item?.id?.videoId;
        if (id) candidates.push({ id, topic: selectedTopics[index] });
      });
    });
    const unique = [...new Map(candidates.map((item) => [item.id, item])).values()];
    if (!unique.length) return storeResult([]);
    const details = await apiRequest("videos", {
      part: "snippet,statistics",
      id: unique.map((item) => item.id).join(","),
      maxResults: "50",
    });
    if (!Array.isArray(details.items)) throw providerError("malformed_response", "YouTube returned unreadable video details.", false);
    const topicById = new Map(unique.map((item) => [item.id, item.topic]));
    const normalized = details.items
      .map((video) => normalizeVideo(video, topicById.get(video.id), now()))
      .filter(Boolean);
    const trends = aggregateVideos(normalized, inventory, now()).slice(0, 12);
    return storeResult(trends);
  }

  function storeResult(trends) {
    cache = {
      available: true,
      configured: true,
      state: "ready",
      cached: false,
      stale: false,
      retrievedAt: now().toISOString(),
      trends,
      source: "YouTube Data API v3",
    };
    return cache;
  }

  async function apiRequest(resource, params) {
    const url = new URL(`https://www.googleapis.com/youtube/v3/${resource}`);
    Object.entries({ ...params, key: apiKey }).forEach(([key, value]) => url.searchParams.set(key, value));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    let response;
    try {
      response = await fetchImpl(url, {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
    } catch (error) {
      if (error?.name === "AbortError") throw providerError("timeout", "YouTube discovery timed out. Curated trends remain available.", true);
      throw providerError("temporarily_unavailable", "YouTube discovery is temporarily unavailable. Curated trends remain available.", true);
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      const code = response.status === 429 ? "rate_limited"
        : response.status === 403 ? "quota_or_permission"
          : response.status >= 500 ? "temporarily_unavailable" : "provider_error";
      throw providerError(code, response.status === 403
        ? "YouTube quota or credentials prevented discovery. Curated trends remain available."
        : response.status === 429
          ? "YouTube is rate limiting discovery. Try again later."
          : "YouTube discovery could not complete. Curated trends remain available.", response.status === 429 || response.status >= 500);
    }
    try {
      return await response.json();
    } catch {
      throw providerError("malformed_response", "YouTube returned an unreadable response. Curated trends remain available.", false);
    }
  }

  return { discover, status };
}

function normalizeVideo(video, topic, now) {
  const snippet = video?.snippet;
  if (!video?.id || !snippet?.title || !snippet?.publishedAt) return null;
  const publishedMs = Date.parse(snippet.publishedAt);
  if (!Number.isFinite(publishedMs)) return null;
  const statistics = video.statistics || {};
  const ageDays = Math.max(1, Math.floor((now.getTime() - publishedMs) / 86_400_000));
  return {
    id: `youtube:${video.id}`,
    videoId: video.id,
    title: decodeEntities(String(snippet.title)).slice(0, 240),
    channel: String(snippet.channelTitle || "YouTube creator").slice(0, 160),
    publishedAt: new Date(publishedMs).toISOString(),
    thumbnailUrl: bestThumbnail(snippet.thumbnails),
    sourceUrl: `https://www.youtube.com/watch?v=${encodeURIComponent(video.id)}`,
    views: safeCount(statistics.viewCount),
    likes: safeCount(statistics.likeCount),
    comments: safeCount(statistics.commentCount),
    ageDays,
    topic: String(topic || "bakery trends"),
    source: "youtube",
  };
}

function aggregateVideos(videos, inventory, retrievedAt = new Date()) {
  const groups = new Map();
  videos.forEach((video) => {
    const classification = classify(video);
    const key = classification.concept;
    const group = groups.get(key) || { classification, videos: [] };
    group.videos.push(video);
    groups.set(key, group);
  });
  return [...groups.values()].map(({ classification, videos: grouped }) => {
    grouped.sort((a, b) => scoreVideoSignal(b) - scoreVideoSignal(a));
    const representative = grouped[0];
    const scores = scoreOpportunity(grouped, classification, inventory);
    return {
      ...representative,
      title: classification.title,
      category: classification.category,
      repeatedTopicCount: grouped.length,
      supportingVideos: grouped.map(({ videoId, title, channel, sourceUrl, views, likes, comments, publishedAt }) => ({
        videoId, title, channel, sourceUrl, views, likes, comments, publishedAt,
      })),
      engagementRate: scores.engagementRate,
      viewVelocity: scores.viewVelocity,
      engagementScore: scores.engagement,
      relevanceScore: scores.bakeryFit,
      opportunityScore: scores.opportunity,
      scoring: scores.dimensions,
      recommendation: scores.recommendation,
      suggestedProduct: classification.product,
      suggestedAction: scores.action,
      analysisReasoning: scores.reasoning,
      inferenceDisclosure: "Complexity, margin potential, and product fit are inferred from public metadata and should be validated with a small test.",
      retrievedAt: retrievedAt.toISOString(),
      dataOrigin: "youtube",
      sourcePlatform: "YouTube",
      trendStatus: "discovered",
    };
  }).sort((a, b) => b.opportunityScore - a.opportunityScore);
}

function scoreOpportunity(videos, classification, inventory) {
  const views = videos.reduce((sum, video) => sum + video.views, 0);
  const interactions = videos.reduce((sum, video) => sum + video.likes + video.comments, 0);
  const velocity = videos.reduce((sum, video) => sum + video.views / video.ageDays, 0);
  const engagementRate = views ? interactions / views : 0;
  const newestAge = Math.min(...videos.map((video) => video.ageDays));
  const text = videos.map((video) => video.title).join(" ").toLowerCase();
  const bakeryFit = clamp(42 + hitCount(text, BAKERY_TERMS) * 8);
  const engagement = clamp(Math.round(Math.log10(velocity + 1) * 16 + Math.min(24, engagementRate * 1_200)));
  const recency = clamp(Math.round(100 - newestAge * 1.1));
  const repetition = clamp(35 + (videos.length - 1) * 25);
  const visual = clamp(45 + hitCount(text, ["decorat", "layer", "glaze", "swirl", "mini", "color", "design", "reveal"]) * 8);
  const complexity = hitCount(text, ["laminated", "sculpt", "intricate", "multi-day", "tempered"]);
  const productionEase = clamp(80 - complexity * 18);
  const marginSignal = clamp(48 + hitCount(text, ["premium", "gift", "box", "mini", "filled", "limited"]) * 9);
  const inventoryNames = (inventory || []).map((item) => String(item.ingredientName || "").toLowerCase()).filter((name) => name.length >= 3);
  const readiness = inventoryNames.length
    ? clamp(42 + inventoryNames.filter((name) => text.includes(name)).length * 14)
    : 52;
  const opportunity = clamp(Math.round(
    bakeryFit * 0.24 + engagement * 0.18 + recency * 0.16 + repetition * 0.12 +
    visual * 0.10 + productionEase * 0.08 + readiness * 0.07 + marginSignal * 0.05,
  ));
  const recommendation = opportunity >= 75 ? "Consider"
    : opportunity >= 60 ? "Test"
      : opportunity >= 42 ? "Watch" : "Not recommended";
  const action = recommendation === "Consider"
    ? "Cost a 12-unit weekend special and validate sell-through before adding it to the regular menu."
    : recommendation === "Test"
      ? "Prototype a small batch, photograph it, and compare ingredient cost with target price."
      : recommendation === "Watch"
        ? "Watch for repeated recent videos and customer requests before committing production time."
        : "Keep as inspiration; current bakery fit and momentum do not justify a production test.";
  return {
    opportunity,
    engagement,
    engagementRate: round(engagementRate * 100, 2),
    viewVelocity: Math.round(velocity),
    recommendation,
    action,
    dimensions: { bakeryFit, engagement, recency, repetition, visual, productionEase, ingredientReadiness: readiness, marginSignal },
    reasoning: `Bakery fit ${bakeryFit}/100; recent velocity ${engagement}/100; recency ${recency}/100; repeated topic signal ${repetition}/100; production ease ${productionEase}/100; ingredient readiness ${readiness}/100. Raw views are moderated by age and engagement so older viral videos do not automatically rank first.`,
  };
}

function classify(video) {
  const text = `${video.title} ${video.topic}`.toLowerCase();
  const matches = [
    ["croissant", "Croissant formats", "pastries"],
    ["macaron", "Macaron flavors and finishes", "pastries"],
    ["brioche", "Brioche formats", "pastries"],
    ["cake", "Modern cake decoration", "cakes"],
    ["cookie", "Premium cookie formats", "cookies"],
    ["bread", "Artisan bread formats", "pastries"],
    ["tart", "Seasonal tart formats", "pastries"],
    ["dessert", "Bakery dessert formats", "other"],
    ["cafe", "Café bakery pairings", "drinks"],
  ];
  const match = matches.find(([keyword]) => text.includes(keyword)) || ["bakery", "Emerging bakery formats", "other"];
  return { concept: match[0], title: match[1], category: match[2], product: `${match[1]} small-batch special` };
}

function scoreVideoSignal(video) {
  return Math.log10(video.views / video.ageDays + 1) + Math.min(1, (video.likes + video.comments) / Math.max(1, video.views) * 50);
}
function rotateTopics(topics, offset, count) {
  return Array.from({ length: Math.min(count, topics.length) }, (_, index) => topics[(offset + index) % topics.length]);
}
function unavailable(code, message, retryable = false) {
  return { available: false, configured: code !== "not_configured", state: code, cached: false, stale: false, retrievedAt: null, trends: [], error: { code, message, retryable } };
}
function normalizeProviderError(error) {
  return error?.providerError || { code: "temporarily_unavailable", message: "YouTube discovery is temporarily unavailable. Curated trends remain available.", retryable: true };
}
function providerError(code, message, retryable) {
  const error = new Error(message);
  error.providerError = { code, message, retryable };
  return error;
}
function bestThumbnail(thumbnails = {}) {
  return thumbnails.medium?.url || thumbnails.high?.url || thumbnails.default?.url || "";
}
function safeCount(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0;
}
function decodeEntities(value) {
  return value.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}
function hitCount(text, terms) { return terms.reduce((sum, term) => sum + (text.includes(term) ? 1 : 0), 0); }
function clamp(value) { return Math.max(0, Math.min(100, value)); }
function round(value, digits) { const factor = 10 ** digits; return Math.round(value * factor) / factor; }
function positiveNumber(value, fallback) { const number = Number(value); return Number.isFinite(number) && number > 0 ? number : fallback; }

module.exports = {
  DEFAULT_TOPICS,
  aggregateVideos,
  createYouTubeTrendService,
  normalizeVideo,
  scoreOpportunity,
};
