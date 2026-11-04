// Anuncios agregados por periodo. Alcance y CTR único los calcula Meta para
// cada anuncio completo; nunca se suman por día ni entre anuncios.
import {createHandler,requireEnv,mapLimit,num,httpError} from '../lib/common.js';
import {classify,translateObjective} from './meta-detail-data.js';
const VERSION=()=>process.env.META_API_VERSION||'v26.0';
const action=(arr,type)=>Array.isArray(arr)?num(arr.find(x=>x.action_type===type)?.value):null;
const optional=v=>v===undefined||v===null||v===''||!Number.isFinite(Number(v))?null:Number(v);
function imageUrl(v){try{const u=new URL(v);const h=u.hostname.toLowerCase();return u.protocol==='https:'&&(['fbcdn.net','facebook.com','fbsbx.com','instagram.com'].some(d=>h===d||h.endsWith('.'+d)))?u.href:null;}catch{return null;}}
async function insights(range){
 const account=String(process.env.META_AD_ACCOUNT_ID).replace(/^act_/,'');
 const fields='campaign_id,campaign_name,adset_id,adset_name,ad_id,ad_name,objective,spend,impressions,reach,frequency,unique_inline_link_click_ctr,inline_link_clicks,actions,action_values,account_currency';
 const params=new URLSearchParams({level:'ad',time_range:JSON.stringify(range),fields,limit:'500',access_token:process.env.META_ACCESS_TOKEN});let url=`https://graph.facebook.com/${VERSION()}/act_${account}/insights?${params}`,pages=0;const rows=[];
 while(url){if(++pages>100)throw httpError(502,'Meta: demasiadas páginas en anuncios.');const response=await fetch(url),data=await response.json().catch(()=>({}));if(!response.ok||data.error)throw httpError(502,data.error?.message||`Meta HTTP ${response.status}`);if(!Array.isArray(data.data))throw httpError(502,'Meta devolvió anuncios incompletos.');rows.push(...data.data);url=data.paging?.next||null;}return rows;
}
async function thumbnails(ids){
 const chunks=[];for(let i=0;i<ids.length;i+=40)chunks.push(ids.slice(i,i+40));const images={},issues=[];
 await mapLimit(chunks,2,async group=>{try{
  // Meta v26 ya no permite GET /?ids=...; usa solicitudes en lote.
  const batch=group.map(id=>({method:'GET',relative_url:`${id}?fields=${encodeURIComponent('creative{thumbnail_url,image_url}')}`}));
  const body=new URLSearchParams({batch:JSON.stringify(batch),access_token:process.env.META_ACCESS_TOKEN});
  const response=await fetch(`https://graph.facebook.com/${VERSION()}/`,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:body.toString()});
  const data=await response.json().catch(()=>({}));if(!response.ok||data.error)throw new Error(data.error?.message||`HTTP ${response.status}`);if(!Array.isArray(data))throw new Error('Respuesta de imágenes incompleta.');
  for(let i=0;i<group.length;i++){const item=data[i];let parsed={};try{parsed=JSON.parse(item?.body||'{}');}catch{}if(!item||item.code>=400||parsed.error){issues.push(parsed.error?.message||`HTTP ${item?.code||'desconocido'}`);continue;}const c=parsed.creative;images[group[i]]=imageUrl(c?.image_url)||imageUrl(c?.thumbnail_url);}
 }catch(e){issues.push(e.message);}});
 return {images,detail:issues.length?`Algunas imágenes no se pudieron consultar: ${issues[0]}`:null};
}
async function fetchCreative(range){
 requireEnv(['META_ACCESS_TOKEN','META_AD_ACCOUNT_ID']);const raw=(await insights(range)).filter(r=>!/amazon/i.test(r.campaign_name||''));
 const ids=[...new Set(raw.map(r=>String(r.ad_id||'')).filter(id=>/^\d+$/.test(id)))];const media=await thumbnails(ids);const purchase=process.env.META_PURCHASE_ACTION||'offsite_conversion.fb_pixel_purchase';
 const rows=raw.map(r=>({adId:r.ad_id,ad:r.ad_name,campaign:r.campaign_name,adset:r.adset_name,objectiveLabel:translateObjective(r.objective),label:classify(r.ad_id,r.ad_name,r.adset_id,r.adset_name,r.campaign_id,r.campaign_name),spend:num(r.spend),impressions:num(r.impressions),reach:optional(r.reach),frequency:optional(r.frequency),uniqueCtr:optional(r.unique_inline_link_click_ctr),clicks:num(r.inline_link_clicks),purchases:action(r.actions,purchase),purchaseValue:action(r.action_values,purchase),addToCart:action(r.actions,'offsite_conversion.fb_pixel_add_to_cart'),addToCartValue:action(r.action_values,'offsite_conversion.fb_pixel_add_to_cart'),checkout:action(r.actions,'offsite_conversion.fb_pixel_initiate_checkout'),landingPageViews:action(r.actions,'landing_page_view'),image:media.images[String(r.ad_id)]||null}));
 return {currency:raw[0]?.account_currency||null,rows,media:{withImage:rows.filter(r=>r.image).length,total:rows.length,detail:media.detail},note:'Alcance y CTR único por anuncio para todo el periodo. Compras atribuidas por Meta; Amazon excluido por nombre.'};
}
export default createHandler({platform:'Creativos Meta',fetcher:fetchCreative});
export {fetchCreative,imageUrl};
