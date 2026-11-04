// Historical customer cohorts. Personal identifiers are processed only in
// memory and never returned or logged. Auth is the same as shopify-data.js.
import { createHandler, requireEnv, httpError, addDays } from '../lib/common.js';
import { gql, localDate } from './shopify-data.js';
import { customerCohorts } from '../lib/customer-cohorts.js';

const SCOPE_QUERY = `query CustomerHistoryScopes { currentAppInstallation { accessScopes { handle } } shop { ianaTimezone } }`;
const ORDERS_QUERY = `query CustomerHistory($cursor: String, $q: String!) {
  orders(first: 250, after: $cursor, query: $q, sortKey: CREATED_AT) {
    pageInfo { hasNextPage endCursor }
    nodes { createdAt test cancelledAt displayFinancialStatus email phone customer { id } taxesIncluded currentSubtotalPriceSet { shopMoney { amount } } currentTaxLines { priceSet { shopMoney { amount } } } }
  }
}`;
const MAX_RECORDS = 50000;
const MAX_RUNTIME_MS = 45000;
function netProductAmount(o) {
  const raw=o.currentSubtotalPriceSet?.shopMoney?.amount;
  if (raw===undefined || raw===null || raw==='' || !Number.isFinite(Number(raw)) || typeof o.taxesIncluded!=='boolean' || !Array.isArray(o.currentTaxLines)) return null;
  let tax=0;
  for(const line of o.currentTaxLines){const v=line?.priceSet?.shopMoney?.amount;if(v==null||v===''||!Number.isFinite(Number(v)))return null;tax+=Number(v);}
  const amount=Number(raw)-(o.taxesIncluded?tax:0);
  return Number.isFinite(amount) && amount>=0 ? amount:null;
}
async function fetchCustomerCohorts({since, until}) {
  requireEnv(['SHOPIFY_STORE_DOMAIN']);
  const start = Date.now();
  const data = await gql(SCOPE_QUERY, {});
  const scopes = data.currentAppInstallation?.accessScopes?.map(x => x.handle) || [];
  if (!scopes.includes('read_all_orders') || !scopes.some(x => ['read_orders','write_orders'].includes(x))) {
    throw httpError(502, 'Shopify: no hay acceso confirmado al historial completo de pedidos (read_orders y read_all_orders).');
  }
  const tz = data.shop?.ianaTimezone;
  if (!tz) throw httpError(502, 'Shopify: falta la zona horaria de la tienda.');
  // status:any is required to include closed/archived orders too.
  // Fetch extra UTC calendar day(s), then filter by the store's local date.
  const q = `status:any created_at:<${addDays(until, 2)}`;
  const orders = []; let cursor = null;
  do {
    if (Date.now() - start > MAX_RUNTIME_MS) throw httpError(502, 'Shopify: el historial es demasiado grande para calcularlo en esta solicitud; no se muestran cifras incompletas.');
    const result = await gql(ORDERS_QUERY, {cursor, q});
    const connection = result.orders;
    if (!connection || !Array.isArray(connection.nodes) || !connection.pageInfo || typeof connection.pageInfo.hasNextPage !== 'boolean') throw httpError(502, 'Shopify: la respuesta del historial está incompleta.');
    for (const o of connection.nodes) {
      if (!o.createdAt || Number.isNaN(Date.parse(o.createdAt))) throw httpError(502, 'Shopify: un pedido no tiene fecha válida.');
      if (typeof o.test !== 'boolean' || !Object.hasOwn(o, 'cancelledAt') || !Object.hasOwn(o, 'displayFinancialStatus') || !Object.hasOwn(o, 'email') || !Object.hasOwn(o, 'phone') || !Object.hasOwn(o, 'customer')) throw httpError(502, 'Shopify: faltan campos del historial; no se calculan clientes.');
      orders.push({ localDate: localDate(o.createdAt, tz), test: o.test, cancelledAt: o.cancelledAt,
        financialStatus: o.displayFinancialStatus, email: o.email, phone: o.phone, customerId: o.customer?.id, netSales:netProductAmount(o) });
      if (orders.length > MAX_RECORDS) throw httpError(502, 'Shopify: el historial excede el límite seguro por solicitud; no se muestran cifras incompletas.');
    }
    if (connection.pageInfo.hasNextPage && (!connection.pageInfo.endCursor || connection.pageInfo.endCursor === cursor)) throw httpError(502, 'Shopify: no se pudo paginar el historial completo.');
    cursor = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null;
  } while (cursor);
  const counts = customerCohorts(orders, {since, until, completeHistory:true});
  return { ...counts, meta: { timezone:tz, identification:'ID, correo o teléfono',
    accuracy:'provisional', note:'Identidad y ventas de producto requieren conciliación. Los teléfonos se comparan sin formato, sin inferir códigos de país; pueden existir identidades sin vincular.' } };
}
export default createHandler({platform:'Clientes Shopify',fetcher:fetchCustomerCohorts,ttlMs: 5 * 60 * 1000});
export { fetchCustomerCohorts };
