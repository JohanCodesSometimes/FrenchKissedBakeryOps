function buildSalesSummary(sales, now = new Date()) {
  const todayKey = localDateKey(now);
  const monthKey = todayKey.slice(0, 7);
  const weekStart = new Date(now);
  weekStart.setHours(0, 0, 0, 0);
  weekStart.setDate(now.getDate() - now.getDay());

  const todaySales = sales.filter((sale) => sale.date === todayKey);
  const weekSales = sales.filter((sale) => dateFromKey(sale.date) >= weekStart);
  const monthSales = sales.filter((sale) => sale.date.startsWith(monthKey));
  const totalRevenue = sum(sales, "saleAmount");
  const totalTransactions = sales.length;

  return {
    todaySales: sum(todaySales, "saleAmount"),
    weekSales: sum(weekSales, "saleAmount"),
    monthSales: sum(monthSales, "saleAmount"),
    averageTicket: totalTransactions ? round(totalRevenue / totalTransactions) : 0,
    totalTransactions,
  };
}

function dateFromKey(key) {
  return new Date(`${key}T00:00:00`);
}

function localDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function sum(items, key) {
  return round(items.reduce((total, item) => total + Number(item[key] || 0), 0));
}

function round(value) {
  return Math.round(Number(value) * 100) / 100;
}

module.exports = { buildSalesSummary };
