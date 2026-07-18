(function exposeLiveSales(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.BakeryLiveSales = api;
}(typeof globalThis !== "undefined" ? globalThis : this, () => {
  function mergeSales(currentSales = [], updatedSales = []) {
    const byId = new Map(currentSales.map((sale) => [sale.id, sale]));
    let changed = false;
    for (const sale of updatedSales) {
      const existing = byId.get(sale.id);
      if (!existing || fingerprint(existing) !== fingerprint(sale)) changed = true;
      byId.set(sale.id, sale);
    }
    return {
      changed,
      sales: [...byId.values()].sort((left, right) => saleTime(right).localeCompare(saleTime(left))),
    };
  }

  function fingerprint(sale) {
    return JSON.stringify([
      sale.id,
      sale.date,
      sale.product,
      sale.quantitySold,
      sale.saleAmount,
      sale.tax,
      sale.discount,
      sale.soldAt,
      sale.source,
      sale.squarePaymentId,
      sale.squareOrderId,
      sale.createdAt,
      sale.updatedAt,
    ]);
  }

  function saleTime(sale) {
    return String(sale.soldAt || sale.updatedAt || sale.createdAt || sale.date || "");
  }

  return { mergeSales };
}));
