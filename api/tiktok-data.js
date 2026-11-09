// /api/tiktok-data.js
// TikTok Ads → normalized daily rows. Two interchangeable sources, chosen by
// TIKTOK_SOURCE ("sheet" | "api"); defaults to "sheet" when TIKTOK_SHEET_ID is set.
//
// SOURCE "sheet" (current for Vitanna): the Dataslayer query that writes into
// the "Dashboard KPI's Vitanna" Google Sheet, read server-side through gviz.
//  - The Sheet must stay shared as "anyone with the link can view". The ID only
//    lives in a Vercel env var, so the browser never sees it.
//  - Columns are matched by HEADER NAME, not position: Dataslayer can reorder
//    or add metrics and the parser keeps working (or names what's missing).
//  - Date cells arrive from gviz as "Date(2026,10,9)" with a 0-indexed month.
//  - Rows are date × campaign × ad group × ad. Reach and frequency are NOT
//    additive across rows, so they're deliberately left out.
//  - Purchases = "Total Complete Payment" and value = "Total Complete Payment
//    Value". "Results" and "Conversions" are each campaign's OPTIMIZATION
//    event (landing page views, follows…), not purchases — never use them as
//    sales (conversion rate goes over 100% in this data, which proves it).
//  - The Sheet only refreshes when Dataslayer runs. meta.lastDate/meta.stale
//    let the dashboard warn when the data stopped updating.
//
// SOURCE "api": TikTok API for Business v1.3 synchronous report.
// Gotchas:
//  - Errors come back with HTTP 200 and a non-zero `code` in the body. Checking
//    res.ok alone silently treats a failed request as "no data". Always check
//    json.code === 0.
//  - With stat_time_day as a dimension, one request covers at most 30 days.
//    The range is chunked.
//  - `dimensions` and `metrics` are JSON-encoded arrays inside the query string.
//  - stat_time_day comes back as "YYYY-MM-DD 00:00:00" → keep the date part.
//  - Metric values are STRINGS.
//  - API field names don't match the UI labels: "Total complete payment value"
//    in Ads Manager is `total_complete_payment_rate` in the API. Both the
//    conversion and revenue metrics are env-configurable.
//  - Auth goes in the `Access-Token` header, not Authorization: Bearer.

import { createHandler, requireEnv, chunkRange, mapLimit, num, httpError, addDays } from "../lib/common.js";

const BASE = "https://business-api.tiktok.com/open_api/v1.3";
const CONV = () => process.env.TIKTOK_CONVERSION_METRIC || "complete_payment";
const REV = () => process.env.TIKTOK_REVENUE_METRIC || "total_complete_payment_rate";

async function tiktokGet(path, params) {
  const url = `${BASE}${path}?${new URLSearchParams(params)}`;
  const res = await fetch(url, { headers: { "Access-Token": process.env.TIKTOK_ACCESS_TOKEN } });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.code !== 0) {
    throw httpError(502, `TikTok ${json.code ?? res.status}: ${json.message || "respuesta inválida"}${json.request_id ? ` (request_id ${json.request_id})` : ""}`);
  }
  return json.data;
}

async function fetchWindow(win) {
  const rows = [];
  let page = 1;
  let totalPages = 1;
  do {
    const data = await tiktokGet("/report/integrated/get/", {
      advertiser_id: process.env.TIKTOK_ADVERTISER_ID,
      report_type: "BASIC",
      data_level: "AUCTION_CAMPAIGN",
      dimensions: JSON.stringify(["campaign_id", "stat_time_day"]),
      metrics: JSON.stringify(["campaign_name", "spend", "impressions", "clicks", CONV(), REV()]),
      start_date: win.since,
      end_date: win.until,
      page: String(page),
      page_size: "1000",
    });
    rows.push(...(data?.list || []));
    totalPages = data?.page_info?.total_page || 1;
    page++;
  } while (page <= totalPages);
  return rows;
}

async function fetchTikTok(range) {
  requireEnv(["TIKTOK_ACCESS_TOKEN", "TIKTOK_ADVERTISER_ID"]);
  const windows = chunkRange(range, 30);
  const [raw, info] = await Promise.all([
    mapLimit(windows, 2, fetchWindow).then((r) => r.flat()),
    tiktokGet("/advertiser/info/", {
      advertiser_ids: JSON.stringify([process.env.TIKTOK_ADVERTISER_ID]),
      fields: JSON.stringify(["currency", "timezone"]),
    }).catch(() => null), // currency is nice-to-have; don't fail the report over it
  ]);
  const rows = raw.map((r) => ({
    date: String(r.dimensions.stat_time_day).slice(0, 10),
    campaignId: r.dimensions.campaign_id,
    campaign: r.metrics.campaign_name,
    spend: num(r.metrics.spend),
    impressions: num(r.metrics.impressions),
    clicks: num(r.metrics.clicks),
    conversions: num(r.metrics[CONV()]),
    revenue: num(r.metrics[REV()]),
  }));
  const acct = info?.list?.[0];
  return {
    currency: acct?.currency || null,
    rows,
    meta: { source: "api", timezone: acct?.timezone || null, conversionMetric: CONV(), revenueMetric: REV() },
  };
}

// ---------------------------------------------------------------------------
// Google Sheet (Dataslayer) source
// ---------------------------------------------------------------------------
const SHEET_COLUMNS = {
  date: "Date",
  campaign: "Campaign name",
  adGroup: "Ad group name",
  ad: "Ad name",
  spend: "Cost",
  impressions: "Impressions",
  clicks: "Clicks",
  conversions: "Total Complete Payment",
  revenue: "Total Complete Payment Value",
  landingPageViews: "Total Landing Page Views",
  addToCart: "Add to cart events",
  checkouts: "Checkout initiations",
  videoViews: "Video views",
  follows: "Paid follows",
};

// gviz date shapes: "Date(2026,10,9)" (0-indexed month), ISO, or DD/MM/YYYY.
export function parseSheetDate(raw) {
  if (raw == null) return null;
  const str = String(raw).trim();
  let m = str.match(/^Date\((\d+),(\d+),(\d+)/);
  if (m) return `${m[1]}-${String(+m[2] + 1).padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  m = str.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  return null;
}

// Numbers can come typed (number) or formatted ("$1,234.56"); Dataslayer's
// export uses a dot as the decimal separator.
const sheetNum = (v) => (typeof v === "number" ? v : num(String(v ?? "").replace(/[$\s,]/g, "")));

async function fetchSheetTab(sheetId, tab) {
  const url = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:json&headers=1&sheet=${encodeURIComponent(tab)}`;
  const res = await fetch(url);
  const text = await res.text();
  const match = text.match(/setResponse\(([\s\S]*)\);?\s*$/);
  if (!res.ok || !match) {
    throw httpError(502, `No se pudo leer el Google Sheet de TikTok (HTTP ${res.status}). Revisa que siga compartido como "cualquier persona con el enlace puede ver".`);
  }
  const json = JSON.parse(match[1]);
  if (json.status === "error") {
    throw httpError(502, `Google Sheet: ${json.errors?.[0]?.detailed_message || json.errors?.[0]?.message || "error de gviz"} (pestaña "${tab}")`);
  }
  const cols = json.table.cols.map((c) => (c.label || "").trim());
  return { cols, rows: json.table.rows || [] };
}

async function fetchTikTokSheet({ since, until }) {
  requireEnv(["TIKTOK_SHEET_ID"]);
  const tab = process.env.TIKTOK_SHEET_TAB || "Query TikTok 2026";
  const { cols, rows } = await fetchSheetTab(process.env.TIKTOK_SHEET_ID, tab);

  const idx = {};
  const missing = [];
  for (const [key, label] of Object.entries(SHEET_COLUMNS)) {
    idx[key] = cols.indexOf(label);
    if (idx[key] === -1) missing.push(label);
  }
  const required = ["Date", "Campaign name", "Cost", "Impressions", "Clicks", "Total Complete Payment", "Total Complete Payment Value"];
  const missingRequired = missing.filter((m) => required.includes(m));
  if (missingRequired.length) {
    throw httpError(502, `Al Sheet de TikTok le faltan columnas: ${missingRequired.join(", ")}. Revisa la consulta de Dataslayer.`);
  }

  const cell = (r, key) => (idx[key] >= 0 ? r.c?.[idx[key]] : null);
  const val = (r, key) => { const c = cell(r, key); return c ? (c.v ?? c.f) : null; };
  const out = [];
  let lastDate = null;
  for (const r of rows) {
    const c = cell(r, "date");
    const date = parseSheetDate(c?.v) || parseSheetDate(c?.f);
    if (!date) continue; // blank rows below the Dataslayer range
    if (!lastDate || date > lastDate) lastDate = date;
    if (date < since || date > until) continue;
    const campaign = String(val(r, "campaign") ?? "").trim();
    out.push({
      date,
      campaignId: campaign,
      campaign,
      adGroup: String(val(r, "adGroup") ?? ""),
      ad: String(val(r, "ad") ?? ""),
      spend: sheetNum(val(r, "spend")),
      impressions: sheetNum(val(r, "impressions")),
      clicks: sheetNum(val(r, "clicks")),
      conversions: sheetNum(val(r, "conversions")),
      revenue: sheetNum(val(r, "revenue")),
      landingPageViews: sheetNum(val(r, "landingPageViews")),
      addToCart: sheetNum(val(r, "addToCart")),
      checkouts: sheetNum(val(r, "checkouts")),
      videoViews: sheetNum(val(r, "videoViews")),
      follows: sheetNum(val(r, "follows")),
    });
  }

  // "Stale" = the newest row is older than yesterday in Mexico City time.
  const todayMx = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Mexico_City" }).format(new Date());
  const yesterdayMx = addDays(todayMx, -1);
  return {
    currency: process.env.TIKTOK_CURRENCY || "MXN",
    rows: out,
    meta: {
      source: "sheet",
      tab,
      lastDate,
      stale: !lastDate || lastDate < yesterdayMx,
      optionalColumnsMissing: missing.filter((m) => !required.includes(m)),
    },
  };
}

function fetchTikTokAny(range) {
  const source = process.env.TIKTOK_SOURCE || (process.env.TIKTOK_SHEET_ID ? "sheet" : "api");
  return source === "sheet" ? fetchTikTokSheet(range) : fetchTikTok(range);
}

export default createHandler({ platform: "TikTok Ads", fetcher: fetchTikTokAny });
export { fetchTikTok, fetchTikTokSheet };
