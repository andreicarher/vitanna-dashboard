// Detailed GA4 reports, loaded only when Web is opened. Uses the same service
// account token as ga4-data.js. Each report fails independently.
import {createHandler, requireEnv, httpError, mapLimit} from '../lib/common.js';
import {accessToken, report} from './ga4-data.js';
const common=['sessions','activeUsers','engagedSessions','engagementRate','userEngagementDuration','screenPageViews','addToCarts','ecommercePurchases','purchaseRevenue'];
const specs={
  // runReport permite hasta 10 métricas; solo pedimos las usadas en tarjetas.
  totals:{dimensions:[],metrics:['sessions','activeUsers','newUsers','totalUsers','engagementRate','userEngagementDuration','screenPageViews','purchaseRevenue']},
  daily:{dimensions:['date'],metrics:['sessions','ecommercePurchases','purchaseRevenue']},
  channels:{dimensions:['sessionDefaultChannelGroup'],metrics:common},
  sourceMedium:{dimensions:['sessionSourceMedium'],metrics:common},
  devices:{dimensions:['deviceCategory'],metrics:common},
  regions:{dimensions:['country','region'],metrics:common},
  products:{dimensions:['itemName'],metrics:['itemsViewed','itemsAddedToCart','itemsPurchased','itemRevenue']},
  purchaseSessionRate:{dimensions:[],metrics:['sessionKeyEventRate:purchase']},
  cartSessionRate:{dimensions:[],metrics:['sessionKeyEventRate:add_to_cart']},
};
function parseReport(raw,spec) {
  const rows=(raw.rows||[]).map(row=>{
    const result={};
    spec.dimensions.forEach((name,i)=>{result[name]=row.dimensionValues?.[i]?.value ?? '(Sin asignar)';});
    spec.metrics.forEach((name,i)=>{const rawValue=row.metricValues?.[i]?.value;const n=Number(rawValue); if(rawValue==null || rawValue==='' || !Number.isFinite(n)) throw httpError(502,'GA4 devolvió una métrica inválida.');result[name]=n;});
    return result;
  });
  return {rows,meta:{timeZone:raw.metadata?.timeZone||null,currency:raw.metadata?.currencyCode||null,
    thresholded:!!raw.metadata?.subjectToThresholding,sampled:!!raw.metadata?.samplingMetadatas?.length,dataLoss:!!raw.metadata?.dataLossFromOtherRow}};
}
async function fetchWeb(range) {
  requireEnv(['GA4_PROPERTY_ID','GA4_CLIENT_EMAIL','GA4_PRIVATE_KEY']);
  if(!/^\d+$/.test(process.env.GA4_PROPERTY_ID)) throw httpError(500,'GA4_PROPERTY_ID debe ser el ID numérico de la propiedad.','config');
  const token=await accessToken(), entries=Object.entries(specs);
  const reports=await mapLimit(entries,3,async([,spec])=>{ try {return {status:'ok',...parseReport(await report(range,spec.dimensions,spec.metrics,token),spec)};} catch(e){return {status:'error',detail:e.message||'Informe no disponible'};} });
  return {reports:Object.fromEntries(reports.map((r,i)=>[entries[i][0],r])),
    note:'Las compras ecommerce cuentan eventos purchase; no son pedidos de Shopify. Los ingresos dependen de los eventos configurados en GA4.'};
}
export default createHandler({platform:'Web GA4',fetcher:fetchWeb});
export {fetchWeb,parseReport};
