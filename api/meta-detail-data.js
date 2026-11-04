// Meta ad-level insights, without reach/frequency aggregation: these unique
// metrics cannot be safely summed across ads or days.
import {createHandler, requireEnv, chunkRange, mapLimit, num, httpError} from '../lib/common.js';
const OVERRIDES = Object.freeze({});
function classify(...values) {
  for(const v of values){if(!v)continue;if(Object.hasOwn(OVERRIDES,v))return OVERRIDES[v];}
  for(const value of values){const s=String(value||'');if(/(?:^|[^\p{L}\p{N}])(RTG|RETARGETING|REMARKETING)(?:$|[^\p{L}\p{N}])/iu.test(s))return 'Retargeting';if(/(?:^|[^\p{L}\p{N}])(PRO|PROSPECTING|PROSPECCIÓN|PROSPECCION)(?:$|[^\p{L}\p{N}])/iu.test(s))return 'Prospecting';}
  return 'Sin clasificar';
}
const translateObjective=v=>({OUTCOME_SALES:'Ventas',OUTCOME_TRAFFIC:'Tráfico',OUTCOME_AWARENESS:'Awareness',OUTCOME_ENGAGEMENT:'Interacción',OUTCOME_LEADS:'Leads'}[v]||(v?`Otro (${v})`:'Sin objetivo'));
function action(arr,name) {const item=(arr||[]).find(x=>x.action_type===name);return item ? num(item.value):null;}
async function windowReport(win){
 const account=String(process.env.META_AD_ACCOUNT_ID).replace(/^act_/,'');
 const params=new URLSearchParams({level:'ad',time_increment:'1',time_range:JSON.stringify(win),limit:'500',access_token:process.env.META_ACCESS_TOKEN,fields:'campaign_id,campaign_name,adset_id,adset_name,ad_id,ad_name,objective,spend,impressions,inline_link_clicks,actions,action_values,account_currency'});
 let url=`https://graph.facebook.com/${process.env.META_API_VERSION||'v26.0'}/act_${account}/insights?${params}`, pages=0;const rows=[];
 while(url){if(++pages>100)throw httpError(502,'Meta: demasiadas páginas; reporte incompleto.');const response=await fetch(url), data=await response.json().catch(()=>({}));if(!response.ok||data.error)throw httpError(502,`Meta: ${data.error?.message||`HTTP ${response.status}`}`);if(!Array.isArray(data.data))throw httpError(502,'Meta: respuesta de anuncios incompleta.');rows.push(...data.data);url=data.paging?.next||null;}
 return rows;
}
async function fetchMetaDetail(range){
 requireEnv(['META_ACCESS_TOKEN','META_AD_ACCOUNT_ID']);
 const raw=(await mapLimit(chunkRange(range,30),2,windowReport)).flat();
 const rows=raw.map(r=>({date:r.date_start,campaignId:r.campaign_id,campaign:r.campaign_name,adsetId:r.adset_id,adset:r.adset_name,adId:r.ad_id,ad:r.ad_name,objective:r.objective||null,objectiveLabel:translateObjective(r.objective),label:classify(r.ad_id,r.ad_name,r.adset_id,r.adset_name,r.campaign_id,r.campaign_name),spend:num(r.spend),impressions:num(r.impressions),clicks:num(r.inline_link_clicks),purchases:action(r.actions,'offsite_conversion.fb_pixel_purchase'),purchaseValue:action(r.action_values,'offsite_conversion.fb_pixel_purchase'),addToCart:action(r.actions,'offsite_conversion.fb_pixel_add_to_cart'),checkout:action(r.actions,'offsite_conversion.fb_pixel_initiate_checkout'),landingPageViews:action(r.actions,'landing_page_view')}));
 return {currency:raw[0]?.account_currency||null,rows,meta:{classification:'RTG/PRO por nombre; sin correspondencia = Sin clasificar.',note:'Datos por anuncio y día; alcance y frecuencia no son sumables.'}};
}
export default createHandler({platform:'Detalle Meta',fetcher:fetchMetaDetail});
export {fetchMetaDetail,classify,translateObjective};
