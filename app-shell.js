(function appShellModule(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root?.document) {
    root.BakeryAppShell = api.createAppShell({ document: root.document, window: root });
    root.BakeryAppShell.install();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, () => {
  "use strict";

  const STATUS_ROW_SELECTORS = [
    "#status-square",
    "#status-receipt-ai",
    "#status-database",
    "#status-last-square-sale",
    "#status-inventory",
  ];
  const VIEW_CONFIG = {
    "dashboard-view": { title: "Dashboard", action: "Add Sale", dialog: "sale-dialog" },
    "expenses-view": { title: "Expenses", action: "Add Expense", dialog: "expense-dialog" },
    "receipts-view": { title: "Receipts" },
    "inventory-view": { title: "Inventory", action: "Add Item", dialog: "inventory-dialog" },
    "recipes-view": { title: "Recipe Costing", action: "Create Recipe", dialog: "recipe-dialog" },
    "sales-view": { title: "Sales", action: "Add Sale", dialog: "sale-dialog" },
    "customers-view": { title: "Contacts" },
    "trends-view": { title: "Trend Finder" },
    "reports-view": { title: "Monthly Reports" },
    "shopping-view": { title: "Purchasing Intelligence" },
    "activity-view": { title: "Activity Log" },
    "settings-view": { title: "Owner Settings" },
  };

  function createAppShell({
    document,
    window,
    timeoutMs = 4_000,
    setTimer = setTimeout,
    logger = console,
  }) {
    let installed = false;
    let statusRunner = null;

    function unlockInterface() {
      const roots = [document.documentElement, document.body].filter(Boolean);
      const blockingClasses = ["app-loading", "loading", "locked", "modal-open", "dialog-open", "no-scroll"];
      for (const root of roots) blockingClasses.forEach((name) => root.classList?.remove(name));
      document.querySelectorAll?.(".app-shell[inert], main[inert], .sidebar[inert], .nav-list[inert]").forEach((element) => {
        element.removeAttribute("inert");
        element.inert = false;
      });
      document.querySelectorAll?.(".nav-list [data-view-target]").forEach((button) => {
        button.disabled = false;
        button.removeAttribute("aria-disabled");
        button.style?.removeProperty?.("pointer-events");
      });
      document.querySelectorAll?.("[data-startup-overlay], .startup-overlay, .loading-overlay, .app-backdrop").forEach((element) => {
        element.hidden = true;
        element.style?.setProperty?.("pointer-events", "none");
      });
    }

    function showView(viewId) {
      const config = VIEW_CONFIG[viewId];
      if (!config || !document.getElementById?.(viewId)) return false;
      unlockInterface();
      document.querySelectorAll(".page-view").forEach((view) => {
        const active = view.id === viewId;
        view.hidden = !active;
        view.classList.toggle("active", active);
      });
      document.querySelectorAll(".nav-list [data-view-target]").forEach((button) => {
        const active = button.dataset.viewTarget === viewId;
        button.classList.toggle("active", active);
        if (active) button.setAttribute("aria-current", "page");
        else button.removeAttribute("aria-current");
      });
      const title = document.querySelector("#page-title");
      if (title) title.textContent = config.title;
      const action = document.querySelector("#page-action");
      if (action) {
        action.hidden = !config.action;
        if (config.action) {
          action.textContent = config.action;
          action.dataset.openDialog = config.dialog;
        }
      }
      window?.scrollTo?.({ top: 0, behavior: "auto" });
      return true;
    }

    function rowIsPending(row) {
      return /checking/i.test(row?.querySelector?.("strong")?.textContent || "");
    }

    function showStatusUnavailable(message = "Status checks unavailable") {
      let changed = false;
      for (const selector of STATUS_ROW_SELECTORS) {
        const row = document.querySelector(selector);
        if (!row || !rowIsPending(row)) continue;
        row.className = "system-status-item unavailable";
        const label = row.querySelector("strong");
        const detail = row.querySelector("small");
        if (label) label.textContent = "Temporarily unavailable";
        if (detail) detail.textContent = "Retry the status check";
        changed = true;
      }
      const summary = document.querySelector("#system-status-summary");
      if (summary && (changed || /progress|completed/i.test(summary.textContent || ""))) {
        summary.className = "system-status-summary action-required";
        summary.textContent = message;
      }
      const retry = document.querySelector("#system-status-retry");
      if (retry) {
        retry.hidden = false;
        retry.disabled = false;
        retry.textContent = "Retry checks";
      }
      return changed;
    }

    function armStatusFallback() {
      const timer = setTimer(() => {
        try { showStatusUnavailable("Status checks unavailable"); }
        catch (error) { logClientError("StatusFallbackError", error); }
      }, timeoutMs);
      timer?.unref?.();
      return timer;
    }

    function logClientError(kind, error) {
      const name = String(error?.name || kind || "ClientError");
      const message = String(error?.message || "Client initialization failed").slice(0, 240);
      logger?.error?.(`[BakeryOps] ${kind}: ${name}: ${message}`);
    }

    function handleClientError(kind, error) {
      logClientError(kind, error);
      showStatusUnavailable("Status checks unavailable");
      unlockInterface();
    }

    function handleClick(event) {
      const target = event.target?.closest?.("[data-view-target], #system-status-retry, #database-status-retry");
      if (!target) return;
      if (target.dataset?.viewTarget) {
        showView(target.dataset.viewTarget);
        return;
      }
      unlockInterface();
      armStatusFallback();
      if (typeof statusRunner !== "function") {
        showStatusUnavailable("Status checks unavailable");
        return;
      }
      event.stopImmediatePropagation?.();
      try {
        Promise.resolve(statusRunner(target.id === "database-status-retry" ? ["health", "owner"] : undefined))
          .catch((error) => handleClientError("StatusRetryError", error));
      } catch (error) {
        handleClientError("StatusRetryError", error);
      }
    }

    function install() {
      if (installed) return;
      installed = true;
      unlockInterface();
      document.addEventListener("click", handleClick, true);
      document.addEventListener("DOMContentLoaded", unlockInterface, { once: true });
      window?.addEventListener?.("error", (event) => {
        const error = event?.error || new Error(event?.target?.src ? "Required client asset failed to load" : "Client initialization failed");
        handleClientError("ClientError", error);
      });
      window?.addEventListener?.("unhandledrejection", (event) => handleClientError("UnhandledPromiseRejection", event?.reason));
      armStatusFallback();
      setTimer(unlockInterface, Math.min(1_000, timeoutMs));
    }

    return {
      armStatusFallback,
      install,
      setStatusRunner(runner) { statusRunner = typeof runner === "function" ? runner : null; },
      showStatusUnavailable,
      showView,
      unlockInterface,
    };
  }

  return { createAppShell };
});
