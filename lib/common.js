// /lib/common.js
// Shared helpers for every /api/*-data.js function. Lives outside /api so
// Vercel doesn't turn it into its own endpoint.
//
// Every endpoint returns the same normalized shape so the dashboard can treat
// the three ad platforms identically:
//   { platform, currency, rows: [{ date, campaignId, campaign, spend,
//     impressions, clicks, conversions, revenue }], fetchedAt, range }
// Shopify returns daily aggregates instead (see api/shopify-data.js).

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

export const num = (v) => {
  if (v === undefined || v === null || v === "") return 0;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};

// All date math on "YYYY-MM-DD" strings is done in UTC on purpose: these are
// calendar labels in each platform's account timezone, never instants. Mixing
// local and UTC here is exactly the off-by-one bug documented in the skill.
export const isoToUtc = (s) => {
  const [y, m, d] = s.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
};
export const utcToIso = (ms) => new Date(ms).toISOString().slice(0, 10);
export const addDays = (iso, n) => utcToIso(isoToUtc(iso) + n * DAY_MS);

export function parseRange(query = {}) {
  const today = utcToIso(Date.now());
  const since = query.since || `${today.slice(0, 4)}-01-01`;
  const until = query.until || today;
  if (!ISO.test(since) || !ISO.test(until)) {
    throw httpError(400, "Usa since/until con formato YYYY-MM-DD.");
  }
  if (isoToUtc(since) > isoToUtc(until)) throw httpError(400, "since no puede ser posterior a until.");
  const days = (isoToUtc(until) - isoToUtc(since)) / DAY_MS + 1;
  if (days > 400) throw httpError(400, "El rango máximo es de 400 días.");
  return { since, until };
}

// Splits [since, until] (inclusive) into windows of at most `size` days.
// TikTok caps daily reports at 30 days per request; Meta times out on long
// daily ranges, so both go through this.
export function chunkRange({ since, until }, size) {
  const out = [];
  let start = since;
  while (isoToUtc(start) <= isoToUtc(until)) {
    let end = addDays(start, size - 1);
    if (isoToUtc(end) > isoToUtc(until)) end = until;
    out.push({ since: start, until: end });
    start = addDays(end, 1);
  }
  return out;
}

// Runs fn over items with at most `limit` in flight — keeps us under each
// platform's rate limits without making every chunk wait in line.
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}

export function requireEnv(names) {
  const missing = names.filter((n) => !process.env[n]);
  if (missing.length) {
    throw httpError(500, `Faltan variables de entorno en Vercel: ${missing.join(", ")}`, "config");
  }
}

export function httpError(status, message, kind) {
  const e = new Error(message);
  e.status = status;
  if (kind) e.kind = kind;
  return e;
}

// In-memory cache per warm instance (not durable — Vercel may cold-start a new
// instance). Good enough to protect API quotas from dashboard traffic.
export function makeCache(ttlMs) {
  const store = new Map();
  return {
    get(key) {
      const hit = store.get(key);
      return hit && Date.now() - hit.at < ttlMs ? hit.value : null;
    },
    set(key, value) {
      store.set(key, { at: Date.now(), value });
    },
  };
}

// Wraps a platform fetcher with CORS, optional shared-key auth, caching and
// error reporting that always surfaces the platform's real error detail.
export function createHandler({ platform, fetcher, ttlMs = 15 * 60 * 1000 }) {
  const cache = makeCache(ttlMs);
  return async function handler(req, res) {
    res.setHeader("Access-Control-Allow-Origin", process.env.ALLOWED_ORIGIN || "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "x-dashboard-key");
    if (req.method === "OPTIONS") return res.status(204).end();
    if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

    const key = process.env.DASHBOARD_KEY;
    if (key && req.headers?.["x-dashboard-key"] !== key) {
      return res.status(401).json({ error: "Clave del dashboard incorrecta o ausente." });
    }

    try {
      const range = parseRange(req.query);
      const cacheKey = `${range.since}_${range.until}`;
      const force = req.query?.refresh === "1";
      let data = force ? null : cache.get(cacheKey);
      if (!data) {
        data = { platform, ...(await fetcher(range)), range, fetchedAt: new Date().toISOString() };
        cache.set(cacheKey, data);
      }
      res.setHeader("Cache-Control", "private, max-age=0, no-store");
      return res.status(200).json(data);
    } catch (err) {
      console.error(`[${platform}]`, err);
      const status = err.status && err.status < 500 ? err.status : err.kind === "config" ? 500 : 502;
      return res.status(status).json({
        error: `No se pudo obtener datos de ${platform}`,
        detail: err.message || String(err),
        kind: err.kind || "upstream",
      });
    }
  };
}
