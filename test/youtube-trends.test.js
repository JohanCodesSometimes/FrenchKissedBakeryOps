"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  aggregateVideos,
  createYouTubeTrendService,
  normalizeVideo,
} = require("../youtube-trends");

const FIXED_NOW = new Date("2026-07-24T12:00:00.000Z");
const ROOT = path.join(__dirname, "..");

test("missing YouTube configuration is isolated and never calls the provider", async () => {
  let calls = 0;
  const service = createYouTubeTrendService({
    env: {},
    fetchImpl: async () => { calls += 1; throw new Error("should not run"); },
    now: () => FIXED_NOW,
  });
  const result = await service.discover();
  assert.equal(result.available, false);
  assert.equal(result.state, "not_configured");
  assert.deepEqual(result.trends, []);
  assert.equal(calls, 0);
  assert.equal(Object.hasOwn(result, "apiKey"), false);
});

test("YouTube discovery searches bounded topics, batches statistics, normalizes, caches, and never returns the key", async () => {
  const secret = "youtube-secret-key";
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(String(url));
    if (url.pathname.endsWith("/search")) {
      const index = urls.filter((item) => item.includes("/search?")).length;
      return jsonResponse(200, {
        items: [{ id: { videoId: `video-${index}` }, snippet: { title: "search result" } }],
      });
    }
    return jsonResponse(200, {
      items: [1, 2, 3].map((index) => videoFixture(`video-${index}`, {
        title: `${index === 1 ? "Croissant" : "Cake"} bakery trend ${index}`,
        publishedAt: `2026-07-${20 + index}T12:00:00Z`,
        views: 10_000 * index,
        likes: 900 * index,
        comments: 40 * index,
      })),
    });
  };
  const service = createYouTubeTrendService({
    env: { YOUTUBE_API_KEY: secret },
    fetchImpl,
    now: () => FIXED_NOW,
  });
  const first = await service.discover({ inventory: [{ ingredientName: "chocolate" }] });
  const second = await service.discover();
  assert.equal(first.available, true);
  assert.equal(first.trends.length, 2);
  assert.equal(urls.filter((url) => url.includes("/search?")).length, 3);
  assert.equal(urls.filter((url) => url.includes("/videos?")).length, 1);
  assert.equal(second.cached, true);
  assert.equal(urls.length, 4);
  assert.ok(urls.every((url) => url.includes(encodeURIComponent(secret))));
  assert.doesNotMatch(JSON.stringify(first), new RegExp(secret));
  const trend = first.trends[0];
  assert.equal(trend.source, "youtube");
  assert.match(trend.sourceUrl, /^https:\/\/www\.youtube\.com\/watch/);
  assert.ok(Number.isFinite(trend.views));
  assert.ok(Number.isFinite(trend.viewVelocity));
  assert.ok(["Consider", "Test", "Watch", "Not recommended"].includes(trend.recommendation));
  assert.match(trend.analysisReasoning, /Raw views are moderated by age/);
});

test("overlapping YouTube refreshes share one provider request and manual refresh is bounded", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const service = createYouTubeTrendService({
    env: { YOUTUBE_API_KEY: "test-only" },
    now: () => FIXED_NOW,
    fetchImpl: async (url) => {
      calls += 1;
      await gate;
      return url.pathname.endsWith("/search")
        ? jsonResponse(200, { items: [] })
        : jsonResponse(200, { items: [] });
    },
  });
  const first = service.discover({ refresh: true });
  const second = service.discover({ refresh: true });
  release();
  assert.strictEqual(await first, await second);
  assert.equal(calls, 3);
  const limited = await service.discover({ refresh: true });
  assert.equal(limited.refreshLimited, true);
  assert.equal(calls, 3);
});

test("quota, rate, timeout, and malformed provider failures return safe structured degradation", async () => {
  for (const scenario of [
    { response: () => jsonResponse(403, {}), state: "quota_or_permission" },
    { response: () => jsonResponse(429, {}), state: "rate_limited" },
    { response: () => ({ ok: true, status: 200, json: async () => { throw new Error("bad json"); } }), state: "malformed_response" },
    { response: async () => { const error = new Error("aborted"); error.name = "AbortError"; throw error; }, state: "timeout" },
  ]) {
    const service = createYouTubeTrendService({
      env: { YOUTUBE_API_KEY: "never-return-me" },
      now: () => FIXED_NOW,
      fetchImpl: scenario.response,
    });
    const result = await service.discover();
    assert.equal(result.available, false);
    assert.equal(result.state, scenario.state);
    assert.deepEqual(result.trends, []);
    assert.doesNotMatch(JSON.stringify(result), /never-return-me/);
  }
});

test("an expired cache remains available when a later provider refresh fails", async () => {
  let current = new Date(FIXED_NOW);
  let failing = false;
  const service = createYouTubeTrendService({
    env: { YOUTUBE_API_KEY: "cache-fallback-secret" },
    now: () => current,
    minRefreshMs: 1,
    fetchImpl: async (url) => {
      if (failing) return jsonResponse(500, {});
      if (url.pathname.endsWith("/search")) {
        return jsonResponse(200, { items: [{ id: { videoId: "cached-video" } }] });
      }
      return jsonResponse(200, { items: [videoFixture("cached-video", {
        title: "Fresh bakery cookie format",
        publishedAt: "2026-07-23T12:00:00Z",
        views: 20_000,
        likes: 1_500,
        comments: 75,
      })] });
    },
  });
  const fresh = await service.discover();
  assert.equal(fresh.stale, false);
  current = new Date(FIXED_NOW.getTime() + 7 * 60 * 60 * 1000);
  failing = true;
  const fallback = await service.discover({ refresh: true });
  assert.equal(fallback.available, true);
  assert.equal(fallback.cached, true);
  assert.equal(fallback.stale, true);
  assert.equal(fallback.trends.length, 1);
  assert.equal(fallback.error.code, "temporarily_unavailable");
  assert.doesNotMatch(JSON.stringify(fallback), /cache-fallback-secret/);
});

test("normalized scoring favors recent engaged momentum over an old lifetime-view outlier", () => {
  const recent = normalizedFixture("recent", {
    title: "Premium cookie bakery reveal",
    publishedAt: "2026-07-22T12:00:00Z",
    views: 80_000,
    likes: 8_000,
    comments: 500,
  });
  const old = normalizedFixture("old", {
    title: "Cake bakery classic",
    publishedAt: "2021-01-01T12:00:00Z",
    views: 100_000_000,
    likes: 300_000,
    comments: 4_000,
  });
  const trends = aggregateVideos([old, recent], []);
  assert.equal(trends[0].videoId, "recent");
  assert.ok(trends[0].opportunityScore > trends[1].opportunityScore);
});

test("video normalization handles public counters and omits malformed records", () => {
  const normalized = normalizeVideo(videoFixture("abc", {
    title: "Croissant &amp; coffee",
    publishedAt: "2026-07-22T12:00:00Z",
    views: "1234",
    likes: undefined,
    comments: "12",
  }), "pastry trends", FIXED_NOW);
  assert.equal(normalized.title, "Croissant & coffee");
  assert.equal(normalized.likes, 0);
  assert.equal(normalized.comments, 12);
  assert.equal(normalizeVideo({ id: "bad", snippet: {} }, "bakery", FIXED_NOW), null);
});

test("YouTube credentials stay server-only and the owner UI includes source and mobile controls", () => {
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  const client = fs.readFileSync(path.join(ROOT, "trend-finder-ui.js"), "utf8");
  const styles = fs.readFileSync(path.join(ROOT, "styles.css"), "utf8");
  const server = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
  assert.doesNotMatch(html, /YOUTUBE_API_KEY|youtube-secret-key/);
  assert.doesNotMatch(client, /YOUTUBE_API_KEY|youtube-secret-key/);
  assert.match(server, /createYouTubeTrendService/);
  assert.match(html, /id="youtube-provider-status"/);
  assert.match(html, /name="source"/);
  assert.match(styles, /@media \(max-width: 700px\)[\s\S]*\.youtube-signals/);
  const dashboard = html.slice(html.indexOf('id="dashboard-view"'), html.indexOf('id="expenses-view"'));
  for (const heading of ["Today at a glance", "What needs attention", "Sales & profit trends", "Product performance", "Inventory & purchasing", "Recent activity", "Trend opportunities"]) {
    assert.ok(dashboard.indexOf(heading) >= 0, `missing dashboard section: ${heading}`);
  }
  assert.ok(dashboard.indexOf("Today at a glance") < dashboard.indexOf("What needs attention"));
  assert.match(dashboard, /id="sales-connection-status"/);
  assert.match(dashboard, /id="dashboard-sales-history"/);
});

function normalizedFixture(id, values) {
  return normalizeVideo(videoFixture(id, values), "bakery trends", FIXED_NOW);
}

function videoFixture(id, { title, publishedAt, views, likes, comments }) {
  return {
    id,
    snippet: {
      title,
      channelTitle: "Baker Channel",
      publishedAt,
      thumbnails: { medium: { url: `https://i.ytimg.com/vi/${id}/mqdefault.jpg` } },
    },
    statistics: {
      viewCount: String(views),
      ...(likes === undefined ? {} : { likeCount: String(likes) }),
      commentCount: String(comments),
    },
  };
}

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}
