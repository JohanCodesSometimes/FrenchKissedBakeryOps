function upsertCustomerFromSale(customers, customerInfo, sale, { createId, now = new Date() } = {}) {
  const identity = normalizeCustomerInfo(customerInfo);
  if (!hasCustomerIdentity(identity)) return { skipped: true, customer: null };

  let customer = findCustomer(customers, identity);
  const timestamp = now.toISOString();
  if (!customer) {
    customer = {
      id: createId(),
      squareCustomerId: identity.squareCustomerId,
      name: identity.name,
      email: identity.email,
      phone: identity.phone,
      firstPurchaseDate: sale.date,
      latestPurchaseDate: sale.date,
      totalSpend: 0,
      visitCount: 0,
      favoriteProduct: "",
      purchaseHistory: {},
      createdAt: timestamp,
    };
    customers.unshift(customer);
  }

  if (identity.squareCustomerId) customer.squareCustomerId = identity.squareCustomerId;
  if (identity.name) customer.name = identity.name;
  if (identity.email) customer.email = identity.email;
  if (identity.phone) customer.phone = identity.phone;

  const saleKey = sale.squarePaymentId || sale.squareOrderId || sale.id;
  if (saleKey) {
    customer.purchaseHistory = { ...(customer.purchaseHistory || {}) };
    customer.purchaseHistory[saleKey] = {
      date: sale.date,
      amount: round(sale.saleAmount),
      products: splitProducts(sale.product),
    };
  }
  recomputeCustomer(customer);
  customer.updatedAt = timestamp;
  return { skipped: false, customer };
}

function recomputeCustomer(customer) {
  const purchases = Object.values(customer.purchaseHistory || {});
  const dates = purchases.map((purchase) => purchase.date).filter(Boolean).sort();
  customer.firstPurchaseDate = dates[0] || customer.firstPurchaseDate || "";
  customer.latestPurchaseDate = dates[dates.length - 1] || customer.latestPurchaseDate || "";
  customer.totalSpend = round(purchases.reduce((total, purchase) => total + Number(purchase.amount || 0), 0));
  customer.visitCount = purchases.length;

  const products = new Map();
  for (const purchase of purchases) {
    for (const product of purchase.products || []) {
      const current = products.get(product) || { count: 0, latestDate: "" };
      current.count += 1;
      if (String(purchase.date || "") > current.latestDate) current.latestDate = purchase.date;
      products.set(product, current);
    }
  }
  customer.favoriteProduct = [...products.entries()]
    .sort((left, right) => right[1].count - left[1].count ||
      String(right[1].latestDate).localeCompare(String(left[1].latestDate)) ||
      left[0].localeCompare(right[0]))[0]?.[0] || "";
}

function findCustomer(customers, identity) {
  if (identity.squareCustomerId) {
    const match = customers.find((customer) => customer.squareCustomerId === identity.squareCustomerId);
    if (match) return match;
  }
  if (identity.email) {
    const email = identity.email.toLowerCase();
    const match = customers.find((customer) => String(customer.email || "").toLowerCase() === email);
    if (match) return match;
  }
  if (identity.phone) {
    const phone = normalizePhone(identity.phone);
    const match = customers.find((customer) => normalizePhone(customer.phone) === phone);
    if (match) return match;
  }
  if (identity.name) {
    const name = normalizeName(identity.name);
    return customers.find((customer) => normalizeName(customer.name) === name) || null;
  }
  return null;
}

function sortCustomers(customers, sort = "latestPurchase") {
  const copy = [...customers];
  if (sort === "totalSpend" || sort === "total_spend") {
    return copy.sort((a, b) => Number(b.totalSpend || 0) - Number(a.totalSpend || 0) ||
      String(b.latestPurchaseDate || "").localeCompare(String(a.latestPurchaseDate || "")));
  }
  return copy.sort((a, b) =>
    String(b.latestPurchaseDate || "").localeCompare(String(a.latestPurchaseDate || "")) ||
    Number(b.totalSpend || 0) - Number(a.totalSpend || 0));
}

function toSafeCustomer(customer) {
  return {
    id: customer.id,
    name: customer.name || "Square Customer",
    email: customer.email || "",
    phone: customer.phone || "",
    firstPurchaseDate: customer.firstPurchaseDate || "",
    latestPurchaseDate: customer.latestPurchaseDate || "",
    totalSpend: round(customer.totalSpend),
    visitCount: Number(customer.visitCount || 0),
    favoriteProduct: customer.favoriteProduct || "",
  };
}

function buildCustomerInsights(customers, now = new Date()) {
  const month = localDateKey(now).slice(0, 7);
  const inactiveCutoff = new Date(now);
  inactiveCutoff.setDate(inactiveCutoff.getDate() - 60);
  const cutoffKey = localDateKey(inactiveCutoff);
  const ranked = sortCustomers(customers, "totalSpend");
  return {
    topCustomers: ranked.slice(0, 5).map(toSafeCustomer),
    repeatCustomers: customers.filter((customer) => Number(customer.visitCount || 0) > 1).length,
    recentlyInactiveCustomers: customers.filter((customer) =>
      customer.latestPurchaseDate && customer.latestPurchaseDate < cutoffKey,
    ).length,
    newCustomersThisMonth: customers.filter((customer) =>
      String(customer.firstPurchaseDate || "").startsWith(month),
    ).length,
  };
}

function normalizeCustomerInfo(info = {}) {
  return {
    squareCustomerId: clean(info.squareCustomerId, 120),
    name: clean(info.name, 200),
    email: clean(info.email, 320).toLowerCase(),
    phone: clean(info.phone, 80),
  };
}

function hasCustomerIdentity(info) {
  return Boolean(info.squareCustomerId || info.name || info.email || info.phone);
}

function splitProducts(value) {
  return [...new Set(String(value || "").split(",").map((item) => item.trim()).filter(Boolean))];
}

function clean(value, limit) {
  return String(value || "").trim().slice(0, limit);
}

function normalizePhone(value) {
  return String(value || "").replace(/\D/g, "");
}

function normalizeName(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function localDateKey(date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function round(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

module.exports = {
  buildCustomerInsights,
  sortCustomers,
  toSafeCustomer,
  upsertCustomerFromSale,
};