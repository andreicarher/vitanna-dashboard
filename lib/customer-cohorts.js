// Internal only: group customer identities on the server. Do not return raw
// customer identifiers or include this module in browser bundles.
const emailKey = (s) => typeof s === 'string' && s.trim() ? `email:${s.trim().toLowerCase()}` : null;
// Compare formatted variants of the same international/national number, but
// do not guess country codes or strip significant digits.
const phoneKey = (s) => typeof s === 'string' && s.replace(/\D/g, '').length >= 7 ? `phone:${s.replace(/\D/g, '')}` : null;
const idKey = (s) => typeof s === 'string' && s.trim() ? `id:${s.trim()}` : null;
const keys = (o) => [...new Set([idKey(o.customerId), emailKey(o.email), phoneKey(o.phone)].filter(Boolean))];

/** Input must contain every valid historical order through until, not just the
 * selected period. localDate is derived by the caller in the store timezone.
 * Returns aggregate counts only; records with no identity are unclassified.
 */
export function customerCohorts(orders, { since, until, completeHistory } = {}) {
  if (completeHistory !== true) throw new Error('Historial completo no verificado; clientes nuevos no disponibles.');
  if (!Array.isArray(orders) || !/^\d{4}-\d{2}-\d{2}$/.test(since || '') || !/^\d{4}-\d{2}-\d{2}$/.test(until || '') || since > until) throw new Error('Datos o rango de clientes inválidos.');
  if (orders.some(o => !o.test && !o.cancelledAt && !o.financialStatus)) throw new Error('Falta el estado de pago; clientes no disponibles.');
  const valid = orders.filter(o => !o.test && !o.cancelledAt && ['PAID', 'PARTIALLY_REFUNDED'].includes(o.financialStatus));
  if (valid.some(o => !/^\d{4}-\d{2}-\d{2}$/.test(o.localDate || ''))) throw new Error('Falta la fecha local de un pedido.');
  const parent = new Map();
  function find(k) { if (!parent.has(k)) parent.set(k, k); let p = k; while (parent.get(p) !== p) p = parent.get(p); while (parent.get(k) !== k) { const next = parent.get(k); parent.set(k, p); k = next; } return p; }
  function union(a, b) { const x = find(a), y = find(b); if (x !== y) parent.set(y, x); }
  const ordered = valid.filter(o => o.localDate <= until).map(o => ({ order: o, keys: keys(o) }));
  for (const { keys: ks } of ordered) for (let i = 1; i < ks.length; i++) union(ks[0], ks[i]);
  const groups = new Map(); let unclassifiedOrders = 0;
  for (const { order: o, keys: ks } of ordered) {
    if (!ks.length) { if (o.localDate >= since) unclassifiedOrders++; continue; }
    const root = find(ks[0]);
    const group = groups.get(root) || { first: o.localDate, inPeriod: false, periodOrders: 0, netRevenue:0, revenueComplete:true };
    if (o.localDate < group.first) group.first = o.localDate;
    if (o.localDate >= since) { group.inPeriod = true; group.periodOrders++; if(Number.isFinite(o.netSales))group.netRevenue+=o.netSales;else group.revenueComplete=false; }
    groups.set(root, group);
  }
  let newCustomers = 0, returningCustomers = 0, ordersNew = 0, ordersReturning = 0, revenueNew = 0, revenueReturning = 0, completeNew=true, completeReturning=true;
  for (const g of groups.values()) if (g.inPeriod) {
    if (g.first >= since) { newCustomers++; ordersNew += g.periodOrders; revenueNew+=g.netRevenue; completeNew &&= g.revenueComplete; }
    else { returningCustomers++; ordersReturning += g.periodOrders; revenueReturning+=g.netRevenue; completeReturning &&= g.revenueComplete; }
  }
  return { newCustomers, returningCustomers, ordersNew, ordersReturning, unclassifiedOrders, netRevenueNew:completeNew?revenueNew:null, netRevenueReturning:completeReturning?revenueReturning:null }; 
}
