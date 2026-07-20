"use strict";

const path = require("path");
const { createStorage } = require("../storage");
const { analyzeTrend, normalizeTrendInput } = require("../trend-finder");

if (process.env.NODE_ENV === "production") {
  console.error("Demo trend seeding is disabled when NODE_ENV=production.");
  process.exitCode = 1;
} else {
  seed().catch((error) => {
    console.error(`Could not seed demo trends: ${error.message}`);
    process.exitCode = 1;
  });
}

async function seed() {
  const dataDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, "..", "data"));
  const storage = await createStorage({ dataDir, env: process.env, logger: console });
  await storage.initialize();
  const existing = await storage.loadFoodTrends();
  const existingIds = new Set(existing.map((trend) => trend.id));
  const now = new Date();
  let inserted = 0;

  for (const [index, sample] of samples.entries()) {
    if (existingIds.has(sample.id)) continue;
    const seenAt = new Date(now.getTime() - index * 24 * 60 * 60 * 1000).toISOString();
    const normalized = normalizeTrendInput(sample, {
      id: sample.id,
      now: seenAt,
      dataOrigin: "demo",
      createdAt: seenAt,
      updatedAt: seenAt,
    });
    await storage.upsertFoodTrend(analyzeTrend(normalized, { now: seenAt, inventory: [] }));
    inserted += 1;
  }
  console.log(`Demo trend seed complete: ${inserted} added, ${samples.length - inserted} already present.`);
}

const samples = [
  {
    id: "10000000-0000-4000-8000-000000000001",
    title: "Pistachio-filled croissant reveal",
    description: "Demo sample inspired by manually observed filled-pastry presentation. The visual cut-open moment may suit a weekend special.",
    category: "pastries", sourcePlatform: "Demo / manually curated", hashtags: ["#pastry", "#croissant"], engagementScore: 78,
  },
  {
    id: "10000000-0000-4000-8000-000000000002",
    title: "Vintage piping mini cakes",
    description: "Demo sample for small celebration cakes with colorful, highly photographic piping.",
    category: "cakes", sourcePlatform: "Demo / manually curated", hashtags: ["#cake", "#vintagecake"], engagementScore: 72,
  },
  {
    id: "10000000-0000-4000-8000-000000000003",
    title: "Stuffed cookie flight",
    description: "Demo sample pairing several mini filled cookies in one tasting box without claiming live platform performance.",
    category: "cookies", sourcePlatform: "Demo / manually curated", hashtags: ["#cookies", "#dessertflight"], engagementScore: 82,
  },
  {
    id: "10000000-0000-4000-8000-000000000004",
    title: "Strawberry matcha cloud drink",
    description: "Demo drink concept with contrasting color layers and a bakery-friendly seasonal fruit variation.",
    category: "drinks", sourcePlatform: "Demo / manually curated", hashtags: ["#matcha", "#bakerydrink"], engagementScore: 69,
  },
  {
    id: "10000000-0000-4000-8000-000000000005",
    title: "Summer lemon berry cruffin",
    description: "Demo seasonal pastry idea combining citrus glaze, berries, and a laminated visual shape.",
    category: "seasonal", sourcePlatform: "Demo / manually curated", hashtags: ["#summerbaking", "#cruffin"], engagementScore: 64,
  },
  {
    id: "10000000-0000-4000-8000-000000000006",
    title: "Build-your-own pastry gift box",
    description: "Demo presentation concept for customers choosing a compact assortment that photographs well.",
    category: "packaging", sourcePlatform: "Demo / manually curated", hashtags: ["#giftbox", "#bakerybox"], engagementScore: 61,
  },
  {
    id: "10000000-0000-4000-8000-000000000007",
    title: "Brown butter espresso cookie",
    description: "Demo premium cookie flavor concept designed for simple small-batch testing and coffee pairing.",
    category: "cookies", sourcePlatform: "Demo / manually curated", hashtags: ["#brownbutter", "#cookie"], engagementScore: 58,
  },
  {
    id: "10000000-0000-4000-8000-000000000008",
    title: "Mini pastry brunch board",
    description: "Demo assortment concept using existing pastry formats in a shareable visual presentation.",
    category: "pastries", sourcePlatform: "Demo / manually curated", hashtags: ["#brunch", "#minipastry"], engagementScore: 66,
  },
];
