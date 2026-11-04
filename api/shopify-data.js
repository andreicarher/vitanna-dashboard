// /api/shopify-data.js
// Shopify Admin GraphQL API → daily sales aggregates (no customer PII leaves
// this function).
//
// Gotchas:
//  - Since 1 Jan 2026 new custom apps can't be created from the store admin.
//    New apps live in the Dev Dashboard and get their token with the
//    client-credentials grant (token lasts ~24h → cached and refreshed here).
//    A legacy custom app's static token still works via SHOPIFY_ACCESS_TOKEN.
//  - Orders older than 60 days need the `read_all_orders` scope, on top of
//    `read_orders`. Without it the query silently returns only recent orders.
//  - GraphQL returns HTTP 200 with an `errors` array on failure, including
//    THROTTLED when the cost bucket is empty → retried with a short wait.
//  - createdAt is UTC. Ad platforms report in the account's local timezone, so
//    orders are bucketed by the store's ianaTimezone, not by UTC date —
//    otherwise evening orders in Mexico land on the next day.

import { createHandler, requireEnv, num, httpError, addDays, isoToUtc } from "../lib/common.js";

const VERSION = () => process.env.SHOPIFY_API_VERSION || "2026-10";
const SHOP = () => String(process.env.SHOPIFY_STORE_DOMAIN || "").replace(/^https?:\/\//, "").replace(/\/$/, "");
let tokenCache = { token: null, expiresAt: 0 };

async function getToken() {
  if (process.env.SHOPIFY_ACCESS_TOKEN) return process.env.SHOPIFY_ACCESS_TOKEN;
  requireEnv(["SHOPIFY_CLIENT_ID", "SHOPIFY_CLIENT_SECRET"]);
  const now = Date.now();
  if (tokenCache.token && now < tokenCache.expiresAt - 5 * 60_000) return tokenCache.token;
  const res = await fetch(`https://${SHOP()}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: process.env.SHOPIFY_CLIENT_ID,
      client_secret: process.env.SHOPIFY_CLIENT_SECRET,
    }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) {
    throw httpError(502, `No se pudo obtener el token de Shopify: ${json.error_description || json.error || `HTTP ${res.status}`}`);
  }
  tokenCache = { token: json.access_token, expiresAt: now + (json.expires_in || 86_400) * 1000 };
  return tokenCache.token;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function gql(query, variables, attempt = 0) {
  const token = await getToken();
  const res = await fetch(`https://${SHOP()}/admin/api/${VERSION()}/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json().catch(() => ({}));
  const throttled = (json.errors || []).some((e) => e.extensions?.code === "THROTTLED");
  if (throttled && attempt < 4) {
    await sleep(1500 * (attempt + 1));
    return gql(query, variables, attempt + 1);
  }
  if (!res.ok || json.errors) {
    const msg = Array.isArray(json.errors) ? json.errors.map((e) => e.message).join(" | ") : json.errors || `HTTP ${res.status}`;
    throw httpError(502, `Shopify: ${msg}`);
  }
  return json.data;
}

const ORDERS_QUERY = `
  query Orders($cursor: String, $q: String!) {
    orders(first: 250, after: $cursor, query: $q, sortKey: CREATED_AT) {
      pageInfo { hasNextPage endCursor }
      nodes {
        createdAt
        test
        cancelledAt
        displayFinancialStatus
        currentTotalPriceSet { shopMoney { amount } }
        taxesIncluded
        subtotalPriceSet { shopMoney { amount } }
        taxLines { priceSet { shopMoney { amount } } }
        totalRefundedSet { shopMoney { amount } }
        currentSubtotalPriceSet { shopMoney { amount } }
        currentTaxLines { priceSet { shopMoney { amount } } }
      }
    }
  }`;

function localDate(isoInstant, timeZone) {
  // en-CA formats as YYYY-MM-DD
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(isoInstant));
}

// Importes de producto a partir del subtotal (sin envío); los impuestos de
// líneas se restan solo si ya están incluidos en el subtotal. Validar con
// pedidos reales, descuentos, impuestos y reembolsos antes de producción.
function requiredAmount(bag, name) {
  const value = bag?.shopMoney?.amount;
  if (value === null || value === undefined || value === '' || !Number.isFinite(Number(value))) {
    throw httpError(502, `Shopify: falta un importe válido (${name}); no se calcula ventas.`);
  }
  return Number(value);
}
function lineTax(lines) {
  if (!Array.isArray(lines)) throw httpError(502, 'Shopify: faltan líneas de impuestos; no se calcula ventas.');
  return lines.reduce((sum, line) => sum + requiredAmount(line.priceSet, 'impuesto'), 0);
}

async function fetchShopify({ since, until }) {
  requireEnv(["SHOPIFY_STORE_DOMAIN"]);
  const { shop } = await gql(`{ shop { ianaTimezone currencyCode } }`, {});
  const tz = shop.ianaTimezone;

  // Widen the UTC query by a day on each side, then filter by local date.
  const q = `status:any created_at:>=${addDays(since, -1)} created_at:<${addDays(until, 2)}`;
  const byDay = new Map();
  let cursor = null;
  let excluded = { test: 0, cancelled: 0, financialStatus: 0 };
  do {
    const data = await gql(ORDERS_QUERY, { cursor, q });
    for (const o of data.orders.nodes) {
      const day = localDate(o.createdAt, tz);
      if (isoToUtc(day) < isoToUtc(since) || isoToUtc(day) > isoToUtc(until)) continue;
      if (o.test) { excluded.test++; continue; }
      if (o.cancelledAt) { excluded.cancelled++; continue; }
      if (!o.displayFinancialStatus) throw httpError(502, 'Shopify: falta el estado de pago; no se calculan ventas.');
      if (!['PAID', 'PARTIALLY_REFUNDED'].includes(o.displayFinancialStatus)) { excluded.financialStatus++; continue; }
      const d = byDay.get(day) || { date: day, orders: 0, grossSales: 0, refunds: 0, netSales: 0, totalSales: 0 };
      d.orders += 1;
      if (typeof o.taxesIncluded !== 'boolean') throw httpError(502, 'Shopify: falta taxesIncluded; no se calcula ventas.');
      const original = requiredAmount(o.subtotalPriceSet, 'subtotal original');
      const current = requiredAmount(o.currentSubtotalPriceSet, 'subtotal actual');
      const originalTax = lineTax(o.taxLines);
      const currentTax = lineTax(o.currentTaxLines);
      // Subtotales de producto, que no incorporan el envío. El subtotal original
      // es tras descuentos y antes de devoluciones; no es "gross sales" Shopify.
      d.grossSales += original + (o.taxesIncluded ? 0 : originalTax);
      // Es el reembolso total del pedido: puede incluir impuestos y envío.
      d.refunds += requiredAmount(o.totalRefundedSet, 'reembolso total');
      d.totalSales += requiredAmount(o.currentTotalPriceSet, 'total actual del pedido');
      d.netSales += current - (o.taxesIncluded ? currentTax : 0);
      byDay.set(day, d);
    }
    cursor = data.orders.pageInfo.hasNextPage ? data.orders.pageInfo.endCursor : null;
  } while (cursor);

  const rows = [...byDay.values()]
    .sort((a, b) => a.date.localeCompare(b.date));
  return { currency: shop.currencyCode, rows, meta: { timezone: tz, apiVersion: VERSION(), excluded } };
}

export default createHandler({ platform: "Shopify", fetcher: fetchShopify });
export { fetchShopify, gql, localDate };
