"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { createPollController } = require("../contacts-polling");

const root = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("Contacts polling runs only while Contacts is active and the tab is visible", async () => {
  const timers = new Map();
  let nextId = 1;
  let polls = 0;
  const controller = createPollController({
    poll: async () => { polls += 1; },
    interval: 30_000,
    setTimer(fn, delay) { const id = nextId++; timers.set(id, { fn, delay }); return id; },
    clearTimer(id) { timers.delete(id); },
  });

  controller.update({ active: false, visible: true });
  assert.equal(polls, 0);
  assert.equal(timers.size, 0);
  controller.update({ active: true, visible: true });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(polls, 1, "activation performs an immediate refresh");
  assert.equal(timers.size, 1, "only one next poll is scheduled");
  assert.equal([...timers.values()][0].delay, 30_000);

  controller.update({ active: true, visible: false });
  assert.equal(timers.size, 0, "hidden tabs have no scheduled Contacts poll");
  controller.update({ active: true, visible: true });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(polls, 2, "visibility recovery refreshes immediately");
  assert.equal(timers.size, 1, "visibility recovery does not accumulate intervals");
  controller.update({ active: false, visible: true });
  assert.equal(timers.size, 0, "leaving Contacts stops polling");
  controller.stop();
});

test("navigation groups preserve every page and update accessible current-page state", () => {
  const html = read("index.html");
  const script = read("script.js");
  for (const label of ["Daily Operations", "Intelligence", "Administration"]) assert.match(html, new RegExp(label));
  for (const view of ["dashboard", "expenses", "receipts", "inventory", "sales", "shopping", "recipes", "trends", "customers", "reports", "activity", "settings"]) {
    assert.match(html, new RegExp(`data-view-target="${view}-view"`));
  }
  assert.match(html, /data-view-target="dashboard-view" aria-current="page"/);
  assert.match(script, /button\.setAttribute\("aria-current", "page"\)/);
  assert.match(script, /button\.removeAttribute\("aria-current"\)/);
  assert.match(script, /#page-title.*focus\(\{ preventScroll: true \}\)/);
  assert.doesNotMatch(html, /Railway volume/);
  assert.match(html, /Operational data is securely stored in the application database/);
});

test("dashboard status has pending, ready, setup, and degraded owner states", () => {
  const html = read("index.html");
  const script = read("script.js");
  const server = read("server.js");
  for (const id of ["status-square", "status-receipt-ai", "status-database", "status-last-square-sale", "status-inventory"]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /Checks have not completed/);
  assert.match(script, /Action required: review the items marked below/);
  assert.match(script, /Temporarily unavailable/);
  assert.match(script, /Needs setup/);
  assert.match(script, /Promise\.allSettled\(\[\s*fetch\("\/api\/health"/);
  assert.match(server, /ownerStatus: buildOwnerStatus\(\)/);
  assert.match(server, /receiptAiAvailable: Boolean\(receiptParser\?\.configured\)/);
  assert.match(server, /inventoryConfigured: collections\.inventory\.length > 0/);
  assert.match(server, /lastSquareSale/);
});

test("destructive actions use an accessible processing-safe confirmation dialog", () => {
  const html = read("index.html");
  const script = read("script.js");
  assert.match(html, /<dialog id="confirmation-dialog">/);
  assert.match(html, /id="confirmation-error" role="alert"/);
  assert.doesNotMatch(script, /window\.confirm|\bconfirm\(/);
  assert.match(script, /controls\.forEach\(\(control\) => \{ control\.disabled = true/);
  assert.match(script, /errorBox\.hidden = false/);
  assert.match(script, /dialog\.close\("confirmed"\)/);
  assert.match(script, /trigger\?\.focus\?\.\(\{ preventScroll: true \}\)/);
  assert.match(script, /Existing sales, inventory, recipes, receipts, contacts/);
});

test("startup loads the Dashboard first and isolates secondary section errors", () => {
  const script = read("script.js");
  const initialize = script.slice(script.indexOf("async function initialize"), script.indexOf("function bindEvents"));
  assert.match(initialize, /await refreshDashboard\(\)/);
  assert.match(initialize, /Promise\.allSettled\(\[refreshSettings/);
  assert.doesNotMatch(initialize, /await refreshAllData/);
  assert.match(script, /async function loadViewData/);
  assert.match(script, /"reports-view": \(\) => refreshReport/);
  assert.match(script, /"shopping-view": \(\) => refreshShoppingList/);
  assert.match(script, /showSectionError\("reports-view"/);
  assert.match(script, /showSectionError\("customers-view"/);
  assert.match(script, /showSectionError\("shopping-view"/);
  assert.match(script, /if \(!background && activeView === viewId\) error\.setAttribute\("role", "alert"\)/);
});
