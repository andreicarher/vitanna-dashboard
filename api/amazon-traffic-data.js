// Paid campaigns whose NAME mentions Amazon. This is not Amazon Ads and it
// does not report Amazon sales. Auth is unchanged and stays server-side.
import { createHandler, requireEnv, httpError } from '../lib/common.js';
import { fetchMeta } from './meta-data.js';
import { fetchGoogle, gaqlSearch } from './google-ads-data.js';
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
// Google reports reach (metrics.unique_users) and average frequency only per
// campaign, only for Display, Video, Demand Gen and App campaigns, and only for
// ranges of up to 92 days. Unique users of different campaigns can't be added
// (the same person counts twice), so a single figure is shown only when there
// is exactly one Amazon campaign; otherwise each campaign is listed in the note.
async function googleReach({ since, until }, rows) {
  const days = (Date.parse(until) - Date.parse(since)) / 864e5 + 1;
  if (days > 92) return { reach: null, frequency: null, reachNote: 'Google solo calcula alcance y frecuencia para periodos de hasta 92 días.' };
  const ids = [...new Set(rows.map(r => String(r.campaignId || '')).filter(id => /^\d+$/.test(id)))];
  if (!ids.length) return { reach: null, frequency: null };
  const res = await gaqlSearch(`
    SELECT campaign.id, campaign.name, campaign.advertising_channel_type,
      metrics.unique_users, metrics.average_impression_frequency_per_user, metrics.impressions
    FROM campaign
    WHERE segments.date BETWEEN '${since}' AND '${until}' AND campaign.id IN (${ids.join(',')})`);
  const list = res.map(r => ({
    name: r.campaign?.name, type: r.campaign?.advertisingChannelType,
    reach: Number(r.metrics?.uniqueUsers || 0), frequency: Number(r.metrics?.averageImpressionFrequencyPerUser || 0),
    impressions: Number(r.metrics?.impressions || 0),
  })).filter(c => c.impressions > 0);
  const withReach = list.filter(c => c.reach > 0);
  if (!withReach.length) return { reach: null, frequency: null, reachNote: 'Google no devolvió alcance para estas campañas (solo lo calcula para Display, Video, Demand Gen y App, y con un mínimo de impresiones).' };
  if (list.length === 1) return { reach: withReach[0].reach, frequency: withReach[0].frequency || null, reachNote: 'Alcance y frecuencia de Google Ads (usuarios únicos de la campaña en el periodo).' };
  return { reach: null, frequency: null, reachNote: 'Alcance por campaña (no se suma entre campañas): ' + withReach.map(c => `${c.name}: ${Math.round(c.reach).toLocaleString('es-MX')} usuarios, ${c.frequency.toFixed(2)}x`).join('; ') + '.' };
}
async function amazonGoogle(range) {
  const report = await fetchGoogle(range);
  const rows = report.rows.filter(isAmazon);
  let reach = { reach: null, frequency: null };
  try { reach = await googleReach(range, rows); }
  catch (error) { reach = { reach: null, frequency: null, reachNote: 'Alcance de Google no disponible.', detail: error.message }; }
  return {currency:report.currency, ...sumCampaigns(report.rows), reach:reach.reach, frequency:reach.frequency, uniqueLinkClicks:null, uniqueLinkCpc:null, landingPageViews:null,
    ...(reach.detail ? { detail: reach.detail } : {}),
    note:[reach.reachNote, 'Google no reporta clics únicos ni visitas a página de destino; no se sustituyen por clics comunes.'].filter(Boolean).join(' ')};
}
// TikTok comes from the Dataslayer Google Sheet (same source as /api/tiktok-data).
// The Sheet has no unique reach/clicks for an aggregated period (reach isn't
// additive across days or ads), so those stay empty instead of being faked.
async function amazonTikTok(range) {
  if (!process.env.TIKTOK_SHEET_ID) return { status: 'not_connected', note: 'TikTok pendiente de conexión (falta TIKTOK_SHEET_ID en Vercel).' };
  const report = await fetchTikTokSheet(range);
  const rows = report.rows.filter(isAmazon);
  const totals = rows.reduce((a, r) => ({ spend: a.spend + r.spend, impressions: a.impressions + r.impressions, landingPageViews: a.landingPageViews + (r.landingPageViews || 0) }), { spend: 0, impressions: 0, landingPageViews: 0 });
  // Reach in the Sheet is per day and per ad, so the period's unique reach
  // can't be rebuilt. Instead: average DAILY reach over the days with delivery
  // in the filtered period, and average daily frequency = impressions / reach.
  const byDay = new Map();
  for (const r of rows) {
    if (!(r.reach > 0)) continue;
    const d = byDay.get(r.date) || { reach: 0, impressions: 0 };
    d.reach += r.reach; d.impressions += r.impressions;
    byDay.set(r.date, d);
  }
  const days = byDay.size;
  const reachSum = [...byDay.values()].reduce((a, d) => a + d.reach, 0);
  const impSum = [...byDay.values()].reduce((a, d) => a + d.impressions, 0);
  const avgReach = days ? reachSum / days : null;
  const avgFreq = reachSum ? impSum / reachSum : null;
  return {
    currency: report.currency, spend: totals.spend, impressions: totals.impressions,
    reach: avgReach, frequency: avgFreq, reachNote: days ? 'prom. diario' : undefined, frequencyNote: days ? 'prom. diario' : undefined,
    reachDays: days,
    uniqueLinkClicks: null, uniqueLinkCpc: null,
    landingPageViews: rows.length ? totals.landingPageViews : null,
    note: rows.length
      ? `Datos del Google Sheet de Dataslayer. Alcance y frecuencia son el promedio diario de ${days} día${days === 1 ? '' : 's'} con entrega en el periodo filtrado (el alcance de cada día suma los anuncios, así que puede contar dos veces a quien vio más de uno ese día); no son personas únicas del periodo y no se comparan con el alcance de Meta. Los clics únicos no están en el Sheet. Visitas según la medición de TikTok.` + (report.meta?.stale ? ` Datos desactualizados: último día ${report.meta.lastDate}.` : '')
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
export {fetchAmazonTraffic, sumCampaigns, googleReach};
