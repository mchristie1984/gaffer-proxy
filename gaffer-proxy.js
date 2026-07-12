// ============================================================
// THE GAFFER — FPL proxy server (Year 1, component A)
// ============================================================
// The FPL API blocks browser calls (CORS), so the app talks to
// this tiny service instead. Read-only, no keys, no auth needed.
//
// RUN LOCALLY:
//   npm init -y && npm install express node-fetch@2 cors
//   node gaffer-proxy.js
//   -> http://localhost:3000/api/bootstrap-static
//
// DEPLOY FREE (Render.com):
//   1. Push this file + package.json to a GitHub repo
//   2. Render -> New Web Service -> connect repo
//   3. Build: npm install   Start: node gaffer-proxy.js
//   4. Your app's BASE_URL becomes https://<yourservice>.onrender.com
// ============================================================

const express = require("express");
const fetch = require("node-fetch");
const cors = require("cors");

const app = express();
app.use(cors());

const FPL = "https://fantasy.premierleague.com/api";
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 min — plenty for weekly decisions
const cache = new Map();

async function proxied(path) {
  const hit = cache.get(path);
  if (hit && Date.now() - hit.t < CACHE_TTL_MS) return hit.data;
  const res = await fetch(`${FPL}${path}`, {
    headers: { "User-Agent": "gaffer-year1/1.0" },
  });
  if (!res.ok) throw new Error(`FPL ${res.status} on ${path}`);
  const data = await res.json();
  cache.set(path, { t: Date.now(), data });
  return data;
}

// Whitelisted, read-only endpoints — everything the engine needs
const routes = {
  "/api/bootstrap-static": () => "/bootstrap-static/",              // all players, teams, events, prices, DC stats
  "/api/fixtures":         () => "/fixtures/",                       // full schedule incl. doubles/blanks as they emerge
  "/api/entry/:id":        (p) => `/entry/${p.id}/`,                 // team summary
  "/api/entry/:id/history": (p) => `/entry/${p.id}/history/`,        // season history + chips used
  "/api/entry/:id/transfers": (p) => `/entry/${p.id}/transfers/`,    // full transfer log
  "/api/entry/:id/event/:gw/picks": (p) => `/entry/${p.id}/event/${p.gw}/picks/`, // past GW squads
  "/api/element-summary/:id": (p) => `/element-summary/${p.id}/`,    // per-player GW history
  "/api/league/:id":       (p) => `/leagues-classic/${p.id}/standings/`, // mini-league
  "/api/event/:gw/live":   (p) => `/event/${p.gw}/live/`,            // live GW points
};

for (const [route, build] of Object.entries(routes)) {
  app.get(route, async (req, res) => {
    try {
      res.json(await proxied(build(req.params)));
    } catch (e) {
      res.status(502).json({ error: e.message });
    }
  });
}

// ------------------------------------------------------------
// NEWS INGESTION (Year 1 plan §7): tiered RSS aggregation.
// Requires: npm install rss-parser
// The app classifies these items via its AI layer into bounded
// xMins adjustments — collection here, judgement there.
// ------------------------------------------------------------
const Parser = require("rss-parser");
const rss = new Parser({ timeout: 8000 });

const NEWS_SOURCES = [
  // tier 1: official / primary
  { url: "https://www.premierleague.com/news/rss", tier: 1, name: "Premier League" },
  // tier 2: reliable journalism
  { url: "https://feeds.bbci.co.uk/sport/football/rss.xml", tier: 2, name: "BBC Sport" },
  { url: "https://www.skysports.com/rss/12040", tier: 2, name: "Sky Sports" },
  // tier 3: specialist FPL / injury tracking (add per preference)
  { url: "https://www.fantasyfootballscout.co.uk/feed/", tier: 3, name: "FF Scout" },
];
const NEWS_WINDOW_H = 72;

app.get("/api/news", async (_, res) => {
  const hit = cache.get("/api/news");
  if (hit && Date.now() - hit.t < CACHE_TTL_MS) return res.json(hit.data);
  const cutoff = Date.now() - NEWS_WINDOW_H * 3600 * 1000;
  const items = [];
  await Promise.all(
    NEWS_SOURCES.map(async (s) => {
      try {
        const feed = await rss.parseURL(s.url);
        for (const it of feed.items || []) {
          const ts = it.pubDate ? Date.parse(it.pubDate) : Date.now();
          if (ts >= cutoff) {
            items.push({
              title: it.title, summary: (it.contentSnippet || "").slice(0, 300),
              link: it.link, published: it.pubDate,
              source: s.name, tier: s.tier,
            });
          }
        }
      } catch (e) {
        items.push({ source: s.name, tier: s.tier, error: e.message });
      }
    })
  );
  // dedupe by title, newest first, tier-1 first on ties
  const seen = new Set();
  const out = items
    .filter((i) => !i.error && !seen.has(i.title) && seen.add(i.title))
    .sort((a, b) => a.tier - b.tier || Date.parse(b.published) - Date.parse(a.published));
  const payload = { window_hours: NEWS_WINDOW_H, count: out.length, items: out };
  cache.set("/api/news", { t: Date.now(), data: payload });
  res.json(payload);
});

app.get("/", (_, res) =>
  res.send("The Gaffer proxy is up. Try /api/bootstrap-static or /api/news")
);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Gaffer proxy listening on ${PORT}`));
