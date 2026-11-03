// /api/google-ads-data.js
// Google Ads REST API (no SDK) → normalized daily campaign rows.
// Adapted from the working reference implementation. Known gotchas baked in:
//   - OAuth Client ID must be type "Aplicación web" (a Desktop client can't
//     register the OAuth Playground redirect URI → redirect_uri_mismatch).
//   - API version is env-configurable: Google deprecates versions roughly
//     every ~3 quarters.
//   - Never send pageSize (PAGE_SIZE_NOT_SUPPORTED); paginate via nextPageToken.
//   - Query is snake_case, response is camelCase (cost_micros → costMicros).
//   - Numeric fields are STRINGS; cost_micros / 1,000,000 = currency.
//   - The useful error detail is nested in error.details[].errors[].message.
//   - DURING has no THIS_YEAR literal; custom ranges use BETWEEN.
//   - Performance Max shows up in FROM campaign automatically.

import { createHandler, requireEnv, num, httpError } from "../lib/common.js";

const API_VERSION = () => process.env.GOOGLE_ADS_API_VERSION || "v23";
const stripDashes = (v) => String(v || "").replace(/-/g, "");
let tokenCache = { accessToken: null, expiresAt: 0 };

async function getAccessToken() {
  const now = Date.now();
  if (tokenCache.accessToken && now < tokenCache.expiresAt - 60_000) return tokenCache.accessToken;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_ADS_CLIENT_ID,
      client_secret: process.env.GOOGLE_ADS_CLIENT_SECRET,
      refresh_token: process.env.GOOGLE_ADS_REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
  });
  const json = await res.json();
  if (!res.ok) {
    throw httpError(502, `Fallo al refrescar el token OAuth: ${json.error_description || json.error || JSON.stringify(json)}`);
  }
  tokenCache = { accessToken: json.access_token, expiresAt: now + json.expires_in * 1000 };
  return tokenCache.accessToken;
}

function extractDetail(json) {
  const top = json?.error?.message || "Error desconocido de Google Ads API";
  const nested = (json?.error?.details || []).flatMap((d) => d.errors || []);
  const msgs = nested.map((e) => `${e.errorCode ? JSON.stringify(e.errorCode) + ": " : ""}${e.message}`);
  return msgs.length ? `${top} — ${msgs.join(" | ")}` : top;
}

async function gaqlSearch(query) {
  const accessToken = await getAccessToken();
  const customerId = stripDashes(process.env.GOOGLE_ADS_CUSTOMER_ID);
  const url = `https://googleads.googleapis.com/${API_VERSION()}/customers/${customerId}/googleAds:search`;
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${accessToken}`,
    "developer-token": process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
  };
  if (process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID) {
    headers["login-customer-id"] = stripDashes(process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID);
  }
  let rows = [];
  let pageToken;
  do {
    const body = pageToken ? { query, pageToken } : { query }; // no pageSize, on purpose
    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw httpError(502, extractDetail(json));
    rows = rows.concat(json.results || []);
    pageToken = json.nextPageToken;
  } while (pageToken);
  return rows;
}

async function fetchGoogle({ since, until }) {
  requireEnv([
    "GOOGLE_ADS_DEVELOPER_TOKEN",
    "GOOGLE_ADS_CLIENT_ID",
    "GOOGLE_ADS_CLIENT_SECRET",
    "GOOGLE_ADS_REFRESH_TOKEN",
    "GOOGLE_ADS_CUSTOMER_ID",
  ]);
  const [raw, account] = await Promise.all([
    gaqlSearch(`
      SELECT
        segments.date,
        campaign.id,
        campaign.name,
        campaign.advertising_channel_type,
        metrics.cost_micros,
        metrics.impressions,
        metrics.clicks,
        metrics.conversions,
        metrics.conversions_value
      FROM campaign
      WHERE segments.date BETWEEN '${since}' AND '${until}'
      ORDER BY segments.date ASC
    `),
    gaqlSearch(`SELECT customer.currency_code FROM customer LIMIT 1`),
  ]);
  const rows = raw.map((r) => ({
    date: r.segments.date,
    campaignId: r.campaign.id,
    campaign: r.campaign.name,
    channelType: r.campaign.advertisingChannelType,
    spend: num(r.metrics.costMicros) / 1_000_000,
    impressions: num(r.metrics.impressions),
    clicks: num(r.metrics.clicks),
    conversions: num(r.metrics.conversions),
    revenue: num(r.metrics.conversionsValue),
  }));
  return {
    currency: account[0]?.customer?.currencyCode || null,
    rows,
    meta: { apiVersion: API_VERSION() },
  };
}

export default createHandler({ platform: "Google Ads", fetcher: fetchGoogle });
export { fetchGoogle };
