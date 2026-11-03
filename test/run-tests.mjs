// Run with: npm test
// Exercises every /api function against mocked platform responses, so the
// parsing, pagination, chunking and error paths are verified without real
// credentials. No dependencies.

import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { chunkRange, parseRange } from "../lib/common.js";

let calls = [];
let responder = () => ({ status: 404, body: {} });
globalThis.fetch = async (url, init = {}) => {
  calls.push({ url: String(url), init });
  const { status = 200, body } = await responder(String(url), init);
  return { ok: status >= 200 && status < 300, status, json: async () => body };
};

function mockRes() {
  const r = { statusCode: 200, headers: {}, body: null };
  r.setHeader = (k, v) => (r.headers[k] = v);
  r.status = (s) => ((r.statusCode = s), r);
  r.json = (b) => ((r.body = b), r);
  r.end = () => r;
  return r;
}
const call = async (handler, query = {}, headers = {}) => {
  const res = mockRes();
  await handler({ method: "GET", query, headers }, res);
  return res;
};

let passed = 0;
async function test(name, fn) {
  calls = [];
  try {
    await fn();
    passed++;
    console.log("✓", name);
  } catch (e) {
    console.error("✗", name, "\n ", e.message);
    process.exitCode = 1;
  }
}

// ---------- lib/common ----------
await test("chunkRange parte en ventanas de 30 días sin huecos ni traslapes", () => {
  const w = chunkRange({ since: "2026-01-01", until: "2026-03-15" }, 30);
  assert.deepEqual(w, [
    { since: "2026-01-01", until: "2026-01-30" },
    { since: "2026-01-31", until: "2026-03-01" },
    { since: "2026-03-02", until: "2026-03-15" },
  ]);
});
await test("parseRange rechaza formatos inválidos y rangos invertidos", () => {
  assert.throws(() => parseRange({ since: "01/01/2026", until: "2026-01-02" }));
  assert.throws(() => parseRange({ since: "2026-02-01", until: "2026-01-01" }));
  assert.deepEqual(parseRange({ since: "2026-01-01", until: "2026-01-31" }), { since: "2026-01-01", until: "2026-01-31" });
});

// ---------- Meta ----------
process.env.META_ACCESS_TOKEN = "tok";
process.env.META_AD_ACCOUNT_ID = "act_123";
const meta = (await import("../api/meta-data.js")).default;

await test("Meta: sigue paging.next, parsea strings y toma solo la compra del píxel", async () => {
  responder = (url) => {
    if (url.includes("after=PAGE2")) {
      return { body: { data: [{ date_start: "2026-01-02", campaign_id: "1", campaign_name: "Ventas Web", spend: "50.5", impressions: "1000", inline_link_clicks: "20", account_currency: "MXN" }] } };
    }
    return { body: {
      data: [{ date_start: "2026-01-01", campaign_id: "1", campaign_name: "Ventas Web", spend: "100.25", impressions: "2000", inline_link_clicks: "40", account_currency: "MXN",
        actions: [{ action_type: "omni_purchase", value: "3" }, { action_type: "offsite_conversion.fb_pixel_purchase", value: "2" }],
        action_values: [{ action_type: "omni_purchase", value: "1500.5" }, { action_type: "offsite_conversion.fb_pixel_purchase", value: "1000.5" }] }],
      paging: { next: "https://graph.facebook.com/v26.0/act_123/insights?after=PAGE2" } } };
  };
  const r = await call(meta, { since: "2026-01-01", until: "2026-01-02" });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.rows.length, 2);
  assert.equal(r.body.rows[0].spend, 100.25);
  assert.equal(r.body.rows[0].conversions, 2);
  assert.equal(r.body.rows[0].revenue, 1000.5);
  assert.equal(r.body.currency, "MXN");
  assert.ok(calls[0].url.includes("/act_123/insights"), "no debe duplicar act_");
  assert.ok(!calls[0].url.includes("act_act_"));
});
await test("Meta: expone el detalle real del error", async () => {
  responder = () => ({ status: 400, body: { error: { message: "Invalid OAuth access token", code: 190, fbtrace_id: "abc" } } });
  const r = await call(meta, { since: "2026-02-01", until: "2026-02-02" });
  assert.equal(r.statusCode, 502);
  assert.match(r.body.detail, /Invalid OAuth access token.*code 190.*fbtrace abc/);
});

// ---------- Google ----------
Object.assign(process.env, {
  GOOGLE_ADS_DEVELOPER_TOKEN: "dev", GOOGLE_ADS_CLIENT_ID: "cid", GOOGLE_ADS_CLIENT_SECRET: "sec",
  GOOGLE_ADS_REFRESH_TOKEN: "ref", GOOGLE_ADS_CUSTOMER_ID: "123-456-7890", GOOGLE_ADS_LOGIN_CUSTOMER_ID: "111-222-3333",
});
const google = (await import("../api/google-ads-data.js")).default;

await test("Google: filtra una acción de compra, conserva inversión sin duplicar y pagina", async () => {
  responder = (url, init) => {
    if (url.includes("oauth2")) return { body: { access_token: "at", expires_in: 3600 } };
    const body = JSON.parse(init.body), q = body.query;
    assert.ok(!("pageSize" in body));
    if (q.includes("FROM customer")) return { body: { results: [{ customer: { currencyCode: "MXN" } }] } };
    if (q.includes("FROM conversion_action")) return { body: { results: [{ conversionAction: { resourceName: "customers/1234567890/conversionActions/12", name: "Google Shopping App Purchase", status: "ENABLED" } }] } };
    if (q.includes("segments.conversion_action")) {
      assert.match(q, /conversionActions\/12/);
      assert.ok(!q.includes("cost_micros"));
      return { body: { results: [{ segments: { date:"2026-01-01", conversionAction:"customers/1234567890/conversionActions/12" }, campaign: { id:"9",name:"Pmax" }, metrics: { allConversions:"1.5", allConversionsValue:"900" } }] } };
    }
    assert.ok(!q.includes("metrics.conversions"));
    if (!body.pageToken) return { body: { results: [{ segments: { date: "2026-01-01" }, campaign: { id:"9",name:"Pmax",advertisingChannelType:"PERFORMANCE_MAX" }, metrics: { costMicros:"12500000", impressions:"300", clicks:"12" } }], nextPageToken: "N" } };
    return { body: { results: [{ segments: { date:"2026-01-02" }, campaign: { id:"9",name:"Pmax" }, metrics: { costMicros:"1000000" } }] } };
  };
  const r = await call(google, { since:"2026-01-01",until:"2026-01-02" });
  assert.equal(r.statusCode,200,JSON.stringify(r.body));
  assert.equal(r.body.rows.length,2);
  assert.equal(r.body.rows[0].spend,12.5);
  assert.equal(r.body.rows[0].conversions,1.5);
  assert.equal(r.body.rows[0].revenue,900);
  assert.equal(r.body.rows[1].conversions,0);
  assert.equal(r.body.meta.purchaseAction,"Google Shopping App Purchase");
  const search = calls.find(c=>c.url.includes("googleAds:search"));
  assert.ok(search.url.includes("/customers/1234567890/"));
  assert.equal(search.init.headers["login-customer-id"],"1112223333");
});
await test("Google: no inventa ceros si falta o hay duplicada la acción elegida", async () => {
  for (const found of [[], [{conversionAction:{resourceName:"customers/1/conversionActions/1",name:"Google Shopping App Purchase"}}, {conversionAction:{resourceName:"customers/1/conversionActions/2",name:"Google Shopping App Purchase"}}]]) {
    responder = (url, init) => {
      if (url.includes("oauth2")) return {body:{access_token:"at",expires_in:3600}};
      const q=JSON.parse(init.body).query;
      return {body:{results:q.includes("FROM conversion_action")?found:[]}};
    };
    const r=await call(google,{since:"2026-07-01",until:"2026-07-02"});
    assert.equal(r.statusCode,502);
    assert.match(r.body.detail,/una única acción/);
  }
});
await test("Google: muestra el error anidado, no solo el genérico", async () => {
  responder = (url) => url.includes("oauth2")
    ? { body: { access_token: "at", expires_in: 3600 } }
    : { status: 400, body: { error: { message: "Request contains an invalid argument.", details: [{ errors: [{ errorCode: { queryError: "BAD_FIELD" }, message: "Unrecognized field" }] }] } } };
  const r = await call(google, { since: "2026-03-01", until: "2026-03-02" });
  assert.equal(r.statusCode, 502);
  assert.match(r.body.detail, /Unrecognized field/);
});

// ---------- TikTok ----------
process.env.TIKTOK_ACCESS_TOKEN = "tt";
process.env.TIKTOK_ADVERTISER_ID = "777";
const tiktok = (await import("../api/tiktok-data.js")).default;

await test("TikTok: parte rangos >30 días, pagina y recorta stat_time_day", async () => {
  responder = (url) => {
    if (url.includes("/advertiser/info/")) return { body: { code: 0, data: { list: [{ currency: "MXN", timezone: "America/Mexico_City" }] } } };
    const u = new URL(url);
    const page = +u.searchParams.get("page");
    const start = u.searchParams.get("start_date");
    return { body: { code: 0, message: "OK", data: {
      list: [{ dimensions: { campaign_id: "c1", stat_time_day: `${start} 00:00:00` }, metrics: { campaign_name: "Tráfico - Web", spend: "10.5", impressions: "100", clicks: "5", complete_payment: "1", total_complete_payment_rate: "250" } }],
      page_info: { page, total_page: 2 } } } };
  };
  const r = await call(tiktok, { since: "2026-01-01", until: "2026-02-15" });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  const reports = calls.filter((c) => c.url.includes("/report/integrated/get/"));
  assert.equal(reports.length, 4, "2 ventanas × 2 páginas");
  for (const c of reports) {
    const u = new URL(c.url);
    const days = (Date.parse(u.searchParams.get("end_date")) - Date.parse(u.searchParams.get("start_date"))) / 864e5 + 1;
    assert.ok(days <= 30, `ventana de ${days} días`);
    assert.equal(c.init.headers["Access-Token"], "tt");
  }
  assert.equal(r.body.rows[0].date, "2026-01-01");
  assert.equal(r.body.rows[0].revenue, 250);
  assert.equal(r.body.currency, "MXN");
});
await test("TikTok: HTTP 200 con code≠0 se trata como error", async () => {
  responder = (url) => url.includes("/advertiser/info/")
    ? { body: { code: 0, data: { list: [] } } }
    : { body: { code: 40105, message: "Access token is invalid", request_id: "rq1" } };
  const r = await call(tiktok, { since: "2026-04-01", until: "2026-04-02" });
  assert.equal(r.statusCode, 502);
  assert.match(r.body.detail, /40105.*Access token is invalid.*rq1/);
});

// ---------- Shopify ----------
process.env.SHOPIFY_STORE_DOMAIN = "https://vitanna-test.myshopify.com/";
process.env.SHOPIFY_CLIENT_ID = "sid";
process.env.SHOPIFY_CLIENT_SECRET = "ssec";
const shopify = (await import("../api/shopify-data.js")).default;

await test("Shopify: token por client credentials, agrupa por fecha local de la tienda", async () => {
  let throttledOnce = false;
  responder = (url, init) => {
    if (url.endsWith("/admin/oauth/access_token")) {
      assert.match(String(init.body), /grant_type=client_credentials/);
      return { body: { access_token: "shp", expires_in: 86399 } };
    }
    assert.equal(init.headers["X-Shopify-Access-Token"], "shp");
    const { query, variables } = JSON.parse(init.body);
    if (query.includes("ianaTimezone")) return { body: { data: { shop: { ianaTimezone: "America/Mexico_City", currencyCode: "MXN" } } } };
    if (!throttledOnce) { throttledOnce = true; return { body: { errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }] } }; }
    const m = (v) => ({ shopMoney: { amount: String(v) } });
    if (!variables.cursor) return { body: { data: { orders: { pageInfo: { hasNextPage: true, endCursor: "C2" }, nodes: [
      // 2026-01-02 03:30 UTC = 2026-01-01 21:30 en CDMX → cuenta el día 1
      { createdAt: "2026-01-02T03:30:00Z", test: false, cancelledAt: null, taxesIncluded: true, subtotalPriceSet: m(900), taxLines: [{ priceSet: m(124.14) }], totalRefundedSet: m(100), currentSubtotalPriceSet: m(800), currentTaxLines: [{ priceSet: m(110.34) }] },
      { createdAt: "2026-01-02T18:00:00Z", test: true, cancelledAt: null, totalPriceSet: m(999), totalRefundedSet: m(0) },
    ] } } } };
    return { body: { data: { orders: { pageInfo: { hasNextPage: false }, nodes: [
      { createdAt: "2026-01-02T18:00:00Z", test: false, cancelledAt: null, taxesIncluded: false, subtotalPriceSet: m(400), taxLines: [{ priceSet: m(64) }], totalRefundedSet: m(0), currentSubtotalPriceSet: m(400), currentTaxLines: [{ priceSet: m(64) }] },
      { createdAt: "2026-01-02T19:00:00Z", test: false, cancelledAt: "2026-01-03T00:00:00Z", totalPriceSet: m(700), totalRefundedSet: m(0) },
      // 2026-01-03 06:30 UTC = 00:30 del día 3 en CDMX → fuera de rango
      { createdAt: "2026-01-03T06:30:00Z", test: false, cancelledAt: null, totalPriceSet: m(300), totalRefundedSet: m(0) },
    ] } } } };
  };
  const r = await call(shopify, { since: "2026-01-01", until: "2026-01-02" });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.rows, [
    { date: "2026-01-01", orders: 1, grossSales: 900, refunds: 100, netSales: 689.66 },
    { date: "2026-01-02", orders: 1, grossSales: 464, refunds: 0, netSales: 400 },
  ]);
  assert.deepEqual(r.body.meta.excluded, { test: 1, cancelled: 1 });
  assert.ok(calls.some((c) => c.url === "https://vitanna-test.myshopify.com/admin/api/2026-10/graphql.json"));
});

await test("Shopify: rechaza importes sin datos fiscales en vez de inventar cero", async () => {
  responder = (url, init) => {
    const { query } = JSON.parse(init.body);
    if (query.includes("ianaTimezone")) return { body: { data: { shop: { ianaTimezone: "America/Mexico_City", currencyCode: "MXN" } } } };
    return { body: { data: { orders: { pageInfo: { hasNextPage: false }, nodes: [
      { createdAt: "2026-03-02T18:00:00Z", test: false, cancelledAt: null, taxesIncluded: true,
        subtotalPriceSet: { shopMoney: { amount: "100" } }, totalRefundedSet: { shopMoney: { amount: "0" } },
        currentSubtotalPriceSet: { shopMoney: { amount: "100" } }, taxLines: [], currentTaxLines: null }
    ] } } } };
  };
  const r = await call(shopify, { since: "2026-03-01", until: "2026-03-03" });
  assert.equal(r.statusCode, 502);
  assert.match(r.body.detail, /faltan líneas de impuestos/);
});

// ---------- Auth & config ----------
await test("Con DASHBOARD_KEY definida, sin clave responde 401", async () => {
  process.env.DASHBOARD_KEY = "secreto";
  const r1 = await call(meta, {}, {});
  assert.equal(r1.statusCode, 401);
  delete process.env.DASHBOARD_KEY;
});
await test("Variables faltantes se reportan por nombre", async () => {
  const saved = process.env.TIKTOK_ADVERTISER_ID;
  delete process.env.TIKTOK_ADVERTISER_ID;
  const r = await call(tiktok, { since: "2026-05-01", until: "2026-05-02" });
  assert.equal(r.statusCode, 500);
  assert.match(r.body.detail, /TIKTOK_ADVERTISER_ID/);
  process.env.TIKTOK_ADVERTISER_ID = saved;
});

// ---------- GA4 ----------
const {privateKey} = generateKeyPairSync('rsa',{modulusLength:2048,privateKeyEncoding:{type:'pkcs8',format:'pem'},publicKeyEncoding:{type:'spki',format:'pem'}});
Object.assign(process.env,{GA4_PROPERTY_ID:'12345',GA4_CLIENT_EMAIL:'service@example.test',GA4_PRIVATE_KEY:privateKey});
const ga4 = (await import('../api/ga4-data.js')).default;
await test('GA4: usuarios únicos por periodo y sesiones por canal; sin sumar usuarios diarios', async()=>{
  responder = (url,init)=>{
    if(url.includes('oauth2.googleapis.com')) return {body:{access_token:'fake',expires_in:3600}};
    const body = JSON.parse(init.body);
    assert.deepEqual(body.dateRanges,[{startDate:'2026-06-01',endDate:'2026-06-30'}]);
    assert.ok(url.includes('/properties/12345:runReport'));
    if(body.dimensions.length) return {body:{rows:[{dimensionValues:[{value:'Paid Social'}],metricValues:[{value:'56'}]}],metadata:{subjectToThresholding:true}}};
    return {body:{rows:[{metricValues:[{value:'42'},{value:'90'}]}],metadata:{timeZone:'America/Mexico_City'}}};
  };
  const r = await call(ga4,{since:'2026-06-01',until:'2026-06-30'});
  assert.equal(r.statusCode,200); assert.equal(r.body.activeUsers,42); assert.equal(r.body.sessions,90);
  assert.deepEqual(r.body.channels,[{channel:'Paid Social',sessions:56}]); assert.equal(r.body.meta.thresholded,true);
});
await test('GA4: error de autorización no inventa ceros', async()=>{
  responder=()=>({status:403,body:{error:{message:'Missing permissions'}}});
  const r=await call(ga4,{since:'2026-07-01',until:'2026-07-02'});
  assert.equal(r.statusCode,502); assert.match(r.body.detail,/Missing permissions/);
});
await test('GA4: protege el endpoint con la clave del dashboard', async()=>{
  process.env.DASHBOARD_KEY='secreto';
  const r=await call(ga4,{since:'2026-06-01',until:'2026-06-30'});
  assert.equal(r.statusCode,401); delete process.env.DASHBOARD_KEY;
});

console.log(`\n${passed} pruebas pasaron`);
