const UNIT_DEFINITIONS = {
  lb: { family: "mass", factor: 453.59237 },
  oz: { family: "mass", factor: 28.349523125 },
  g: { family: "mass", factor: 1 },
  kg: { family: "mass", factor: 1000 },
  count: { family: "count", factor: 1 },
  dozen: { family: "count", factor: 12 },
  gallon: { family: "volume", factor: 1 },
};

function normalizeName(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function convertQuantity(quantity, fromUnit, toUnit) {
  const amount = Number(quantity);
  const from = UNIT_DEFINITIONS[fromUnit];
  const to = UNIT_DEFINITIONS[toUnit];
  if (!Number.isFinite(amount) || amount <= 0 || !from || !to || from.family !== to.family) return null;
  return round(amount * from.factor / to.factor);
}

function prepareReceiptReview(parsed, inventory) {
  const inventoryItems = inventory.map(({ id, ingredientName, unit, quantity }) => ({
    id,
    ingredientName,
    unit,
    quantity: Number(quantity || 0),
  }));
  const items = parsed.items.map((item) => {
    const exactMatches = inventoryItems.filter(
      (candidate) => normalizeName(candidate.ingredientName) === normalizeName(item.itemName),
    );
    const compatibleMatches = exactMatches.filter(
      (candidate) => convertQuantity(item.receivedQuantity ?? item.quantity, item.receivedUnit ?? item.unit, candidate.unit) !== null,
    );
    const requestedForInventory = item.updateInventoryRequested ?? item.updateInventory;
    const stockable = Boolean(requestedForInventory) && !item.isDiscount && !item.isFee && !item.isDeposit &&
      ["Ingredients", "Packaging"].includes(item.category);
    const inventoryItemId = compatibleMatches.length === 1 ? compatibleMatches[0].id : "";
    let unresolvedReason = "";
    if (!Number.isFinite(Number(item.receivedQuantity ?? item.quantity)) || Number(item.receivedQuantity ?? item.quantity) <= 0) {
      unresolvedReason = "Enter the quantity actually received.";
    } else if ((item.receivedUnit ?? item.unit) === "unknown") {
      unresolvedReason = "Choose the unit actually received.";
    } else if (compatibleMatches.length > 1) {
      unresolvedReason = "Multiple inventory items have this name; choose the correct one.";
    } else if (!inventoryItemId && stockable) {
      unresolvedReason = "Choose an existing inventory item. Receipt approval never creates stock items.";
    }
    return {
      ...item,
      receivedQuantity: Number(item.receivedQuantity ?? item.quantity),
      receivedUnit: item.receivedUnit ?? item.unit,
      inventoryItemId,
      updateInventory: Boolean(inventoryItemId && stockable),
      unresolvedReason,
    };
  });
  return { ...parsed, items, inventoryItems };
}

function planInventoryAdjustments(inventory, items) {
  const adjustments = [];
  const unresolvedLines = [];
  for (const [index, item] of items.entries()) {
    if (!item.updateInventory) {
      if (!item.isDiscount && !item.isFee && !item.isDeposit && ["Ingredients", "Packaging"].includes(item.category)) {
        unresolvedLines.push({ index, itemName: item.itemName, reason: item.unresolvedReason || "Not applied to inventory." });
      }
      continue;
    }
    const receivedQuantity = Number(item.receivedQuantity ?? item.quantity);
    if (!Number.isFinite(receivedQuantity) || receivedQuantity <= 0) {
      throw validationError(`${item.itemName}: enter a valid received quantity before applying inventory.`);
    }
    const inventoryItemId = String(item.inventoryItemId || "");
    if (!inventoryItemId) throw validationError(`${item.itemName}: choose an existing inventory item.`);
    const inventoryItem = inventory.find((candidate) => candidate.id === inventoryItemId);
    if (!inventoryItem) throw validationError(`${item.itemName}: the selected inventory item no longer exists. Refresh and choose again.`);
    const receivedUnit = item.receivedUnit ?? item.unit;
    const stockQuantity = convertQuantity(receivedQuantity, receivedUnit, inventoryItem.unit);
    if (stockQuantity === null) {
      throw validationError(`${item.itemName}: ${receivedUnit} cannot be converted to ${inventoryItem.unit}. Correct the unit or inventory match.`);
    }
    adjustments.push({
      index,
      item,
      inventoryItem,
      inventoryItemId,
      receivedQuantity,
      receivedUnit,
      stockQuantity,
      stockUnit: inventoryItem.unit,
      beforeQuantity: Number(inventoryItem.quantity || 0),
      afterQuantity: round(Number(inventoryItem.quantity || 0) + stockQuantity),
    });
  }
  return { adjustments, unresolvedLines };
}

function validationError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function round(value) {
  return Math.round(Number(value) * 10000) / 10000;
}

module.exports = { convertQuantity, normalizeName, planInventoryAdjustments, prepareReceiptReview };
