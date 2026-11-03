// /api/meta-data.js
// Meta Marketing API (Insights) → normalized daily campaign rows.
//
// Notes:
//  - Use a System User token from Business Manager: it doesn't expire, unlike
//    a personal user token (~60 days).
//  - Marketing API versions expire on a much shorter clock than Graph API's
//    two years, so the version is env-configurable, never hardcoded inline.
//  - Every numeric field (spend, impressions, actions[].value) comes back as a
//    STRING — always parse.
//  - Purchases and purchase value live inside the `actions` / `action_values`
//    arrays, keyed by action_type. Which action_type counts as "a purchase" is a
//    business decision (omni_purchase vs offsite_conversion.fb_pixel_purchase),
//    so it's configurable via META_PURCHASE_ACTION.
//  - Long ranges with time_increment=1 time out, so the range is split into
//    30-day windows fetched with limited concurrency.

import { createHandler, requireEnv, chunkRange, mapLimit, num, httpError } from "../lib/common.js";

const VERSION = () => process.env.META_API_VERSION || "v26.0";
const PURCHASE_ACTION = () => process.env.META_PURCHASE_ACTION || "offsite_conversion.fb_pixel_purchase";

function metaErrorDetail(json, status) {
  const e = json?.error;
  if (!e) return `HTTP ${status}`;
  const parts = [e.message];
  if (e.error_user_title || e.error_user_msg) parts.push(`${e.error_user_title || ""} ${e.error_user_msg || ""}`.trim());
  parts.push(`code ${e.code}${e.error_subcode ? "/" + e.error_subcode : ""}`);
  if (e.fbtrace_id) parts.push(`fbtrace ${e.fbtrace_id}`);
  return parts.join(" — ");
}

const pick = (arr, type) => num((arr || []).find((a) => a.action_type === type)?.value);

async function fetchWindow(win) {
  const account = String(process.env.META_AD_ACCOUNT_ID).replace(/^act_/, "");
  const params = new URLSearchParams({
    level: "campaign",
    time_increment: "1",
    time_range: JSON.stringify({ since: win.since, until: win.until }),
    fields: "campaign_id,campaign_name,spend,impressions,inline_link_clicks,actions,action_values,account_currency",
    limit: "500",
    access_token: process.env.META_ACCESS_TOKEN,
  });
  let url = `https://graph.facebook.com/${VERSION()}/act_${account}/insights?${params}`;
  const rows = [];
  while (url) {
    const res = await fetch(url);
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.error) throw httpError(502, metaErrorDetail(json, res.status));
    rows.push(...(json.data || []));
    url = json.paging?.next || null; // `next` already carries the token and cursor
  }
  return rows;
}

async function fetchMeta(range) {
  requireEnv(["META_ACCESS_TOKEN", "META_AD_ACCOUNT_ID"]);
  const windows = chunkRange(range, 30);
  const raw = (await mapLimit(windows, 3, fetchWindow)).flat();
  const action = PURCHASE_ACTION();
  const rows = raw.map((r) => ({
    date: r.date_start, // "YYYY-MM-DD" in the ad account's timezone
    campaignId: r.campaign_id,
    campaign: r.campaign_name,
    spend: num(r.spend),
    impressions: num(r.impressions),
    clicks: num(r.inline_link_clicks), // link clicks, comparable to Google/TikTok clicks
    conversions: pick(r.actions, action),
    revenue: pick(r.action_values, action),
  }));
  return {
    currency: raw[0]?.account_currency || null,
    rows,
    meta: { apiVersion: VERSION(), purchaseAction: action },
  };
}

export default createHandler({ platform: "Meta", fetcher: fetchMeta });
export { fetchMeta };
