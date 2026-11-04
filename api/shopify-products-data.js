// Product performance for eligible orders. No customer identifiers leave this endpoint.
import {createHandler, requireEnv, httpError, addDays, isoToUtc} from '../lib/common.js';
import {gql, localDate} from './shopify-data.js';

const INFO=`query ProductReportInfo { currentAppInstallation { accessScopes { handle } } shop { ianaTimezone currencyCode } }`;
const FIELDS=`id title currentQuantity priceAfterAllDiscountsBeforeTaxesSet { shopMoney { amount } } product { id title productType vendor }`;
const ORDERS=`query ProductReport($cursor:String,$q:String!) {
 orders(first:25,after:$cursor,query:$q,sortKey:CREATED_AT) { pageInfo { hasNextPage endCursor } nodes {
 id createdAt test cancelledAt displayFinancialStatus taxesIncluded currentSubtotalPriceSet { shopMoney { amount } } currentTaxLines { priceSet { shopMoney { amount } } }
 lineItems(first:10) { pageInfo { hasNextPage endCursor } nodes { ${FIELDS} } }
 } } }`;
const MORE=`query ProductReportLines($id:ID!,$cursor:String!) { node(id:$id) { ... on Order { lineItems(first:50,after:$cursor) { pageInfo { hasNextPage endCursor } nodes { ${FIELDS} } } } } }`;
const MAX_MS=45000, MAX_ORDERS=50000;
function amount(bag,label){const x=bag?.shopMoney?.amount;if(x===undefined||x===null||x===''||!Number.isFinite(Number(x)))throw httpError(502,`Shopify: importe faltante en ${label}.`);return Number(x);}
function checked(conn){if(!conn||!Array.isArray(conn.nodes)||typeof conn.pageInfo?.hasNextPage!=='boolean')throw httpError(502,'Shopify: respuesta de productos incompleta.');return conn;}
function next(conn,last){if(!conn.pageInfo.hasNextPage)return null;const c=conn.pageInfo.endCursor;if(!c||c===last)throw httpError(502,'Shopify: no se pudo paginar el reporte de productos.');return c;}
async function fetchProducts({since,until}){
 requireEnv(['SHOPIFY_STORE_DOMAIN']);const start=Date.now();
 const info=await gql(INFO,{}), shop=info.shop,scopes=info.currentAppInstallation?.accessScopes?.map(x=>x.handle)||[];
 if(!shop?.ianaTimezone||!shop.currencyCode)throw httpError(502,'Shopify: falta zona horaria o moneda de la tienda.');
 if(!scopes.some(x=>['read_orders','write_orders'].includes(x)))throw httpError(502,'Shopify: falta acceso de lectura a pedidos.');
 if(isoToUtc(since)<Date.now()-59*86400000&&!scopes.includes('read_all_orders'))throw httpError(502,'Shopify: el periodo supera el historial permitido; falta read_all_orders.');
 const q=`status:any created_at:>=${addDays(since,-1)} created_at:<${addDays(until,2)}`;
 const products=new Map();let cursor=null,seenOrders=0,validOrders=0,missingCatalog=0,orderNet=0,totalUnits=0;const excluded={test:0,cancelled:0,financialStatus:0};
 const checkTime=()=>{if(Date.now()-start>MAX_MS)throw httpError(502,'Shopify: el reporte superó el tiempo de consulta; prueba un periodo menor.');};
 do{checkTime();const page=checked((await gql(ORDERS,{cursor,q})).orders);for(const o of page.nodes){
  checkTime();if(++seenOrders>MAX_ORDERS)throw httpError(502,'Shopify: demasiados pedidos; elige un periodo menor.');
  if(!o.createdAt||Number.isNaN(Date.parse(o.createdAt)))throw httpError(502,'Shopify: falta fecha del pedido.');const day=localDate(o.createdAt,shop.ianaTimezone);if(day<since||day>until)continue;
  if(typeof o.test!=='boolean'||!Object.hasOwn(o,'cancelledAt')||!o.displayFinancialStatus)throw httpError(502,'Shopify: pedido con datos incompletos.');
  if(o.test){excluded.test++;continue;}if(o.cancelledAt){excluded.cancelled++;continue;}if(!['PAID','PARTIALLY_REFUNDED'].includes(o.displayFinancialStatus)){excluded.financialStatus++;continue;}
  if(typeof o.taxesIncluded!=='boolean'||!Array.isArray(o.currentTaxLines))throw httpError(502,'Shopify: faltan datos fiscales del pedido.');
  orderNet+=amount(o.currentSubtotalPriceSet,'subtotal')-(o.taxesIncluded?o.currentTaxLines.reduce((sum,t)=>sum+amount(t.priceSet,'impuesto'),0):0);validOrders++;
  let conn=checked(o.lineItems),lineCursor=null;const inOrder=new Set();
  for(;;){for(const l of conn.nodes){if(!Number.isInteger(l.currentQuantity)||l.currentQuantity<0)throw httpError(502,'Shopify: cantidad de producto no disponible.');
   const val=amount(l.priceAfterAllDiscountsBeforeTaxesSet,'venta neta del producto');if(l.currentQuantity===0&&Math.abs(val)<0.001)continue;
   const catalog=l.product, name=String(catalog?.title||l.title||'Producto sin nombre').trim(),id=catalog?.id||`sin-catalogo:${name.toLocaleLowerCase('es-MX')}`;
   if(!catalog?.id)missingCatalog++;const cat=String(catalog?.productType||'Sin categoría').trim()||'Sin categoría',vendor=String(catalog?.vendor||'Sin proveedor').trim()||'Sin proveedor';
   const row=products.get(id)||{id,name,category:cat,vendor,units:0,orders:0,netSales:0};row.units+=l.currentQuantity;row.netSales+=val;if(!inOrder.has(id)){row.orders++;inOrder.add(id);}totalUnits+=l.currentQuantity;products.set(id,row);
  }
  const n=next(conn,lineCursor);if(!n)break;lineCursor=n;checkTime();conn=checked((await gql(MORE,{id:o.id,cursor:n})).node?.lineItems);
  }
 }
 cursor=next(page,cursor);
 }while(cursor);
 const rows=[...products.values()].sort((a,b)=>b.netSales-a.netSales);const productNet=rows.reduce((s,r)=>s+r.netSales,0);
 return {currency:shop.currencyCode,rows,totals:{units:totalUnits,products:rows.length,orders:validOrders,netSales:productNet,orderNet,difference:productNet-orderNet},meta:{timezone:shop.ianaTimezone,excluded,missingCatalog,method:'Precio por línea después de descuentos y devoluciones, antes de impuestos y envío; pedidos por fecha de creación. Incluye suscripciones.',note:'Conciliar el desglose de productos y devoluciones con Shopify Analytics.'}};
}
export default createHandler({platform:'Productos Shopify',fetcher:fetchProducts,ttlMs:5*60*1000});
export {fetchProducts};
