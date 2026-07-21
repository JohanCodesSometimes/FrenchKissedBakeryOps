"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { createAppShell } = require("../app-shell");

class FakeClassList {
  constructor(initial = []) { this.values = new Set(initial); }
  add(name) { this.values.add(name); }
  remove(name) { this.values.delete(name); }
  contains(name) { return this.values.has(name); }
  toggle(name, force) {
    if (force === undefined) force = !this.values.has(name);
    if (force) this.values.add(name);
    else this.values.delete(name);
    return force;
  }
}

class FakeElement {
  constructor({ id = "", classes = [], dataset = {} } = {}) {
    this.id = id;
    this.classList = new FakeClassList(classes);
    this.className = classes.join(" ");
    this.dataset = { ...dataset };
    this.attributes = new Map();
    this.hidden = false;
    this.disabled = false;
    this.inert = false;
    this.textContent = "";
    this.children = new Map();
    this.style = {
      removeProperty() {},
      setProperty() {},
    };
  }
  appendNamed(tag, element) { this.children.set(tag, element); return element; }
  querySelector(selector) { return this.children.get(selector) || null; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  removeAttribute(name) { this.attributes.delete(name); }
  closest(selector) {
    if (selector.includes("[data-view-target]") && this.dataset.viewTarget) return this;
    if (selector.includes(`#${this.id}`)) return this;
    return null;
  }
}

function createDom() {
  const elements = new Map();
  const add = (element) => { if (element.id) elements.set(element.id, element); return element; };
  const documentElement = new FakeElement({ classes: ["app-loading", "locked"] });
  const body = new FakeElement({ classes: ["modal-open", "no-scroll"] });
  const views = ["dashboard-view", "expenses-view", "settings-view"].map((id, index) => add(new FakeElement({
    id,
    classes: index === 0 ? ["page-view", "active"] : ["page-view"],
  })));
  views.slice(1).forEach((view) => { view.hidden = true; });
  const navButtons = views.map((view, index) => new FakeElement({
    classes: index === 0 ? ["active"] : [],
    dataset: { viewTarget: view.id },
  }));
  navButtons.forEach((button) => { button.disabled = true; button.setAttribute("aria-disabled", "true"); });
  const title = add(new FakeElement({ id: "page-title" }));
  title.textContent = "Dashboard";
  add(new FakeElement({ id: "page-action" }));
  const summary = add(new FakeElement({ id: "system-status-summary", classes: ["system-status-summary", "pending"] }));
  summary.textContent = "Checks have not completed.";
  const retry = add(new FakeElement({ id: "system-status-retry" }));
  const databaseRetry = add(new FakeElement({ id: "database-status-retry" }));
  for (const id of ["status-square", "status-receipt-ai", "status-database", "status-last-square-sale", "status-inventory"]) {
    const row = add(new FakeElement({ id, classes: ["system-status-item"] }));
    const label = row.appendNamed("strong", new FakeElement());
    label.textContent = "Checking…";
    const detail = row.appendNamed("small", new FakeElement());
    detail.textContent = "Check in progress";
  }

  const listeners = new Map();
  const document = {
    documentElement,
    body,
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(listener);
    },
    dispatch(type, event = {}) {
      for (const listener of listeners.get(type) || []) listener(event);
    },
    getElementById(id) { return elements.get(id) || null; },
    querySelector(selector) { return selector.startsWith("#") ? elements.get(selector.slice(1)) || null : null; },
    querySelectorAll(selector) {
      if (selector === ".page-view") return views;
      if (selector === ".nav-list [data-view-target]") return navButtons;
      return [];
    },
  };
  const windowListeners = new Map();
  const window = {
    addEventListener(type, listener) { windowListeners.set(type, listener); },
    dispatch(type, event) { windowListeners.get(type)?.(event); },
    scrollTo() {},
  };
  return { body, document, elements, navButtons, retry, databaseRetry, views, window };
}

function fakeTimers() {
  const timers = [];
  return {
    timers,
    setTimer(callback, delay) {
      const timer = { callback, delay, unref() {} };
      timers.push(timer);
      return timer;
    },
    run(delay) { timers.filter((timer) => timer.delay === delay).forEach((timer) => timer.callback()); },
  };
}

function click(document, target) {
  document.dispatch("click", { target, stopImmediatePropagation() {} });
}

test("navigation switches views synchronously while dashboard data never settles", () => {
  const dom = createDom();
  const timers = fakeTimers();
  const shell = createAppShell({ document: dom.document, window: dom.window, setTimer: timers.setTimer });
  shell.install();
  const dashboardRequest = new Promise(() => {});
  assert.ok(dashboardRequest);
  click(dom.document, dom.navButtons[1]);
  assert.equal(dom.views[1].hidden, false);
  assert.equal(dom.views[0].hidden, true);
  assert.equal(dom.elements.get("page-title").textContent, "Expenses");
});

test("navigation survives a missing or failed SystemStatusController", () => {
  const dom = createDom();
  const timers = fakeTimers();
  const shell = createAppShell({ document: dom.document, window: dom.window, setTimer: timers.setTimer });
  shell.install();
  dom.window.dispatch("error", { target: { src: "/system-status.js" } });
  click(dom.document, dom.navButtons[2]);
  assert.equal(dom.views[2].hidden, false);
  assert.equal(dom.elements.get("system-status-summary").textContent, "Status checks unavailable");
});

test("an HTML response parsed as JSON cannot break navigation", async () => {
  const dom = createDom();
  const timers = fakeTimers();
  const shell = createAppShell({ document: dom.document, window: dom.window, setTimer: timers.setTimer, logger: { error() {} } });
  shell.install();
  shell.setStatusRunner(async () => JSON.parse("<html>Authentication required</html>"));
  click(dom.document, dom.retry);
  await Promise.resolve();
  await Promise.resolve();
  click(dom.document, dom.navButtons[1]);
  assert.equal(dom.views[1].hidden, false);
});

test("the DOM fallback changes every Checking row after four seconds", () => {
  const dom = createDom();
  const timers = fakeTimers();
  createAppShell({ document: dom.document, window: dom.window, setTimer: timers.setTimer }).install();
  timers.run(4_000);
  for (const id of ["status-square", "status-receipt-ai", "status-database", "status-last-square-sale", "status-inventory"]) {
    assert.equal(dom.elements.get(id).querySelector("strong").textContent, "Temporarily unavailable");
  }
  assert.equal(dom.retry.hidden, false);
  assert.equal(dom.retry.disabled, false);
});

test("a thrown status renderer cannot cancel the independent fallback", () => {
  const dom = createDom();
  const timers = fakeTimers();
  const shell = createAppShell({ document: dom.document, window: dom.window, setTimer: timers.setTimer, logger: { error() {} } });
  shell.install();
  shell.setStatusRunner(() => { throw new Error("renderer failed"); });
  click(dom.document, dom.retry);
  timers.run(4_000);
  assert.equal(dom.elements.get("status-square").querySelector("strong").textContent, "Temporarily unavailable");
});

test("retry and emergency unlock never leave navigation disabled or the body locked", () => {
  const dom = createDom();
  const timers = fakeTimers();
  const shell = createAppShell({ document: dom.document, window: dom.window, setTimer: timers.setTimer });
  shell.install();
  click(dom.document, dom.retry);
  assert.equal(dom.body.classList.contains("modal-open"), false);
  assert.equal(dom.body.classList.contains("no-scroll"), false);
  assert.deepEqual(dom.navButtons.map((button) => button.disabled), [false, false, false]);
  click(dom.document, dom.navButtons[1]);
  assert.equal(dom.views[1].hidden, false);
});

test("script load order and the browser global controller export are valid", () => {
  const root = path.join(__dirname, "..");
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  assert.ok(html.indexOf("app-shell.js") < html.indexOf("system-status.js"));
  assert.ok(html.indexOf("system-status.js") < html.indexOf("script.js"));
  const sandbox = { globalThis: {}, setTimeout, clearTimeout, AbortController };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(fs.readFileSync(path.join(root, "system-status.js"), "utf8"), sandbox);
  assert.equal(typeof sandbox.BakerySystemStatus.createController, "function");
});

test("real timer smoke test exits Checking without network activity", { timeout: 6_000 }, async () => {
  const dom = createDom();
  const shell = createAppShell({ document: dom.document, window: dom.window });
  shell.install();
  await new Promise((resolve) => setTimeout(resolve, 4_100));
  assert.equal(dom.elements.get("status-inventory").querySelector("strong").textContent, "Temporarily unavailable");
});
