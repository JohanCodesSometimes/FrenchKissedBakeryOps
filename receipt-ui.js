(function receiptUiModule(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.BakeryReceiptUi = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createReceiptUi() {
  "use strict";

  function applySavedInventory(appData, result) {
    if (!appData || !result?.inventory) return appData;
    return { ...appData, inventory: result.inventory };
  }

  function outcome(result) {
    return {
      addedItems: Array.isArray(result?.addedItems) ? result.addedItems : [],
      unresolvedLines: Array.isArray(result?.unresolvedLines) ? result.unresolvedLines : [],
      alreadyApplied: Boolean(result?.alreadyApplied),
    };
  }

  return { applySavedInventory, outcome };
});
