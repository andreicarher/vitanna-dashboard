// Desgloses de audiencia de Meta para el periodo completo. Cada desglose falla
// de forma independiente; nunca se suman alcances únicos entre campañas.
import {createHandler,requireEnv,mapLimit,num,httpError} from '../lib/common.js';
const DIMENSIONS={age:'age',gender:'gender',region:'region',device:'impression_device',platform:'publisher_platform'};
async function metaQuery(range,dimension,includeActions=true){
 const account=String(process.env.META_AD_ACCOUNT_ID).replace(/^act_/,'');
 const fields=['campaign_id','campaign_name','account_currency','spend','impressions',...(includeActions?['actions','action_values']:[])].join(',');
 const params=new URLSearchParams({level:'campaign',time_range:JSON.stringify(range),breakdowns:dimension,fields,limit:'500',access_token:process.env.META_ACCESS_TOKEN});
 let url=`https://graph.facebook.com/${process.env.META_API_VERSION||'v26.0'}/act_${account}/insights?${params}`,pages=0; const rows=[];
 while(url){if(++pages>100)throw httpError(502,'Meta: demasiadas páginas en el desglose.'); const response=await fetch(url),json=await response.json().catch(()=>({}));if(!response.ok||json.error)throw httpError(502,json.error?.message||`Meta HTTP ${response.status}`);if(!Array.isArray(json.data))throw httpError(502,'Meta devolvió un desglose incompleto.');rows.push(...json.data);url=json.paging?.next||null;}
 return rows;
}
const action=(arr,type)=>Array.isArray(arr)?num(arr.find(x=>x.action_type===type)?.value):null;
function aggregate(raw,dimension,includeActions){
 const groups=new Map(); let currency=null;
 for(const r of raw){if(/amazon/i.test(r.campaign_name||''))continue;if(r.account_currency){if(currency&&currency!==r.account_currency)throw httpError(502,'Meta devolvió monedas inconsistentes.');currency=r.account_currency;}
  const key=String(r[dimension]||'Sin datos');let g=groups.get(key);if(!g){g={name:key,spend:0,impressions:0,purchases:0,value:0,hasPurchases:includeActions,hasValue:includeActions};groups.set(key,g);}
  g.spend+=num(r.spend);g.impressions+=num(r.impressions);const p=action(r.actions,process.env.META_PURCHASE_ACTION||'offsite_conversion.fb_pixel_purchase'),v=action(r.action_values,process.env.META_PURCHASE_ACTION||'offsite_conversion.fb_pixel_purchase');if(p===null)g.hasPurchases=false;else g.purchases+=p;if(v===null)g.hasValue=false;else g.value+=v;
 }
 return {currency,rows:[...groups.values()].map(({hasPurchases,hasValue,...g})=>({...g,purchases:hasPurchases?g.purchases:null,value:hasValue?g.value:null})).sort((a,b)=>b.spend-a.spend)};
}
async function fetchAudience(range){
 requireEnv(['META_ACCESS_TOKEN','META_AD_ACCOUNT_ID']);
 const entries=Object.entries(DIMENSIONS);
 const reports=await mapLimit(entries,2,async([,dim])=>{try{return {status:'ok',...aggregate(await metaQuery(range,dim),dim,true)};}catch(first){try{return {status:'partial',...aggregate(await metaQuery(range,dim,false),dim,false),detail:`Meta no devolvió compras para este desglose: ${first.message}`};}catch(second){return {status:'error',detail:second.message};}}});
 return {reports:Object.fromEntries(entries.map(([key],i)=>[key,reports[i]])),note:'Inversión e impresiones reportadas por Meta para el periodo; campañas Amazon excluidas por nombre. Las compras, cuando están disponibles, son atribuidas por Meta.'};
}
export default createHandler({platform:'Audiencias Meta',fetcher:fetchAudience});
export {fetchAudience,aggregate};
