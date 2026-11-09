// Paid campaigns whose NAME mentions Amazon. This is not Amazon Ads and it
// does not report Amazon sales. Auth is unchanged and stays server-side.
import { createHandler, requireEnv, httpError } from '../lib/common.js';
import { fetchMeta } from './meta-data.js';
import { fetchGoogle } from './google-ads-data.js';
import { fetchTikTokSheet } from './tiktok-data.js';
const isAmazon = row => /amazon/i.test(row.campaign || '');
function sumCampaigns(rows) {
  return rows.filter(isAmazon).reduce((a,r) => ({spend:a.spend+r.spend, impressions:a.impressions+r.impressions}), {spend:0,impressions:0});
}
function optionalNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}
async function metaAccountReport(range, ids) {
  requireEnv(['META_ACCESS_TOKEN','META_AD_ACCOUNT_ID']);
  const version = process.env.META_API_VERSION || 'v26.0';
  const account = String(process.env.META_AD_ACCOUNT_ID).replace(/^act_/,'');
  const params = new URLSearchParams({
    level:'account', time_range:JSON.stringify(range),
    filtering:JSON.stringify([{field:'campaign.id',operator:'IN',value:ids}]),
    fields:'spend,impressions,reach,frequency,unique_inline_link_clicks,cost_per_unique_inline_link_click,actions,account_currency',
    access_token:process.env.META_ACCESS_TOKEN, limit:'2',
  });
  const response = await fetch(`https://graph.facebook.com/${version}/act_${account}/insights?${params}`);
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.error) throw httpError(502, `Meta: ${data.error?.message || `HTTP ${response.status}`}`);
  if (!Array.isArray(data.data) || data.data.length !== 1 || data.paging?.next) throw httpError(502,'Meta: el reporte agregado de Amazon no tiene una fila válida.');
  return data.data[0];
}
async function amazonMeta(range) {
  const report = await fetchMeta(range);
  const rows = report.rows.filter(isAmazon);
  const totals = sumCampaigns(rows);
  const base = {currency:report.currency, ...totals, reach:null, frequency:null, uniqueLinkClicks:null, uniqueLinkCpc:null, landingPageViews:null};
  if (!rows.length) return {...base, note:'No se identificaron campañas con Amazon en el nombre; verificar la nomenclatura.'};
  const ids = [...new Set(rows.map(r=>r.campaignId).filter(Boolean))];
  if (ids.length !== new Set(rows.map(r=>r.campaignId)).size || !ids.length) return {...base, note:'Faltan IDs de campañas; no se calculan métricas únicas.'};
  try {
    const r = await metaAccountReport(range, ids);
    const spend=optionalNumber(r.spend), impressions=optionalNumber(r.impressions);
    if (spend === null || impressions === null || Math.abs(spend - totals.spend) > Math.max(0.05,totals.spend*0.0005) || impressions !== totals.impressions || (report.currency && r.account_currency && report.currency !== r.account_currency)) throw httpError(502,'El reporte agregado no coincide con las campañas identificadas; no se muestran las métricas únicas.');
    const action = (r.actions || []).find(a => a.action_type === 'landing_page_view');
    return {...base, reach:optionalNumber(r.reach), frequency:optionalNumber(r.frequency),
      uniqueLinkClicks:optionalNumber(r.unique_inline_link_clicks), uniqueLinkCpc:optionalNumber(r.cost_per_unique_inline_link_click),
      landingPageViews:optionalNumber(action?.value),
      note:'Métricas únicas estimadas por Meta para el periodo completo. Visitas según la medición de Meta; pueden no reflejar todas las visitas a Amazon.'};
  } catch (error) { return {...base, note:'Métricas únicas de Meta no disponibles.', detail:error.message}; }
}
async function amazonGoogle(range) {
  const report = await fetchGoogle(range);
  return {currency:report.currency, ...sumCampaigns(report.rows), reach:null, frequency:null, uniqueLinkClicks:null, uniqueLinkCpc:null, landingPageViews:null,
    note:'Alcance, frecuencia, clics únicos y visitas de destino no están disponibles en la consulta actual de Google Ads; no se sustituyen por clics comunes.'};
}
// TikTok comes from the Dataslayer Google Sheet (same source as /api/tiktok-data).
// The Sheet has no unique reach/clicks for an aggregated period (reach isn't
// additive across days or ads), so those stay empty instead of being faked.
async function amazonTikTok(range) {
  if (!process.env.TIKTOK_SHEET_ID) return { status: 'not_connected', note: 'TikTok pendiente de conexión (falta TIKTOK_SHEET_ID en Vercel).' };
  const report = await fetchTikTokSheet(range);
  const rows = report.rows.filter(isAmazon);
  const totals = rows.reduce((a, r) => ({ spend: a.spend + r.spend, impressions: a.impressions + r.impressions, landingPageViews: a.landingPageViews + (r.landingPageViews || 0) }), { spend: 0, impressions: 0, landingPageViews: 0 });
  return {
    currency: report.currency, spend: totals.spend, impressions: totals.impressions,
    reach: null, frequency: null, uniqueLinkClicks: null, uniqueLinkCpc: null,
    landingPageViews: rows.length ? totals.landingPageViews : null,
    note: rows.length
      ? 'Datos del Google Sheet de Dataslayer. Alcance, frecuencia y clics únicos no se pueden sumar por periodo con esta fuente; visitas según la medición de TikTok.' + (report.meta?.stale ? ` Datos desactualizados: último día ${report.meta.lastDate}.` : '')
      : 'No se identificaron campañas de TikTok con Amazon en el nombre en este periodo.',
  };
}
async function fetchAmazonTraffic(range) {
  const results = await Promise.allSettled([amazonMeta(range),amazonGoogle(range),amazonTikTok(range)]);
  const source = r => r.status === 'fulfilled' ? {status:'ok',...r.value} : {status:'error',detail:r.reason?.message || 'Fuente no disponible'};
  return {metaAds:source(results[0]),googleAds:source(results[1]),tiktokAds:results[2].status==='fulfilled' && results[2].value.status==='not_connected' ? results[2].value : source(results[2]),
    classification:'Campañas identificadas por Amazon en el nombre; verificar su destino.', attribution:'No se suman métricas únicas entre canales.'};
}
export default createHandler({platform:'Tráfico a Amazon',fetcher:fetchAmazonTraffic});
export {fetchAmazonTraffic, sumCampaigns};
