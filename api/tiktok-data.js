// /api/tiktok-data.js
// TikTok API for Business v1.3 synchronous report → normalized daily campaign rows.
//
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

import { createHandler, requireEnv, chunkRange, mapLimit, num, httpError } from "../lib/common.js";

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
    meta: { timezone: acct?.timezone || null, conversionMetric: CONV(), revenueMetric: REV() },
  };
}

export default createHandler({ platform: "TikTok Ads", fetcher: fetchTikTok });
export { fetchTikTok };
