/**
 * spike-monitor/server.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Spike Monitor Relay Server
 * Receives spike data from MT5 EA → fetches related news → sends to Slack
 * Also serves the live dashboard HTML and exposes a /spikes API for the UI
 *
 * Setup:
 *   npm install express axios cors rss-parser node-cache dotenv
 *   cp .env.example .env  (fill in your keys)
 *   node server.js
 * ─────────────────────────────────────────────────────────────────────────────
 */

require("dotenv").config();
const express   = require("express");
const axios     = require("axios");
const cors      = require("cors");
const RssParser = require("rss-parser");
const NodeCache = require("node-cache");
const path      = require("path");

const app    = express();
const rss    = new RssParser();
const cache  = new NodeCache({ stdTTL: 300 }); // cache news 5 min

app.use(cors());
app.use(express.json());
app.use(express.static(path.resolve(__dirname, "public")));

// ─── Config ──────────────────────────────────────────────────────────────────
const PORT          = process.env.PORT         || 3000;
const SLACK_WEBHOOK = process.env.SLACK_WEBHOOK || "";
const NEWS_API_KEY  = process.env.NEWS_API_KEY  || "";   // newsapi.org free key
const AV_API_KEY    = process.env.AV_API_KEY    || "";   // alphavantage.co free key

// In-memory spike log (last 200 spikes, newest first)
const spikeLog = [];
const MAX_LOG  = 200;

// ─── Asset class router ───────────────────────────────────────────────────────
// Given a symbol, return which group it belongs to and extract the base currency
function classifySymbol(symbol) {
  const s = symbol.replace(".std", "").toUpperCase();

  const cryptoList = [
    "BTC","ETH","ADA","XRP","SOL","BNB","LTC","DOT","DOGE","LINK",
    "UNI","XLM","AAV","ALG","AVX","AXS","BAT","BCH","CHZ","COM",
    "DSH","ENJ","GRT","KSM","LUN","MAN","MAT","SKL","SSS","STR",
    "THT","TRX","XTZ","ZRX"
  ];
  const stockList  = ["AAPL","ABNB","AMZN","BA","BABA","BIDU","GME","GOOGL",
                      "JPM","MSFT","MVRS","NFLX","PDD","PFE","TSLA","XOM","XPEV","ZM"];
  const metalList  = ["XAUUSD","XAGUSD","XAUEUR","XAGEUR","XAUAUD","XPDUSD","XPTUSD"];
  const indexList  = ["AUS200","DAX","EUSTX50","FRA40","HK50","JP225","NASDAQ","SP500","UK100","US30"];
  const futureList = ["BRENT","NGAS","WTI"];

  if (futureList.includes(s))                           return { group: "FUTURES", base: s };
  if (indexList.includes(s))                            return { group: "INDICES", base: s };
  if (metalList.some(m => s.startsWith(m.slice(0,3)))) return { group: "METALS",  base: s };
  if (stockList.includes(s))                            return { group: "STOCKS",  base: s };
  if (cryptoList.some(c => s.startsWith(c)))            return { group: "CRYPTO",  base: s.slice(0,3) };

  // Default: Forex — extract currencies
  return { group: "FOREX", base: s.slice(0,3), quote: s.slice(3,6) };
}

// ─── News fetchers per asset class ───────────────────────────────────────────

// Forex Factory RSS — free, no key needed
async function fetchForexNews(currency) {
  const cacheKey = `ff_${currency}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  try {
    const feed  = await rss.parseURL("https://nfs.faireconomy.media/ff_calendar_thisweek.xml");
    const items = feed.items
      .filter(i => i.title && i.title.toUpperCase().includes(currency.toUpperCase()))
      .slice(0, 3)
      .map(i => ({ title: i.title, url: i.link || "https://www.forexfactory.com", source: "Forex Factory" }));
    cache.set(cacheKey, items);
    return items;
  } catch (e) {
    console.error("ForexFactory RSS error:", e.message);
    return [];
  }
}

// CoinGecko — free, no key needed
async function fetchCryptoNews(coinSymbol) {
  const cacheKey = `cg_${coinSymbol}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  // Map short symbol → CoinGecko coin id
  const coinMap = {
    BTC:"bitcoin", ETH:"ethereum", ADA:"cardano", XRP:"ripple",
    SOL:"solana",  BNB:"binancecoin", LTC:"litecoin", DOT:"polkadot",
    DOGE:"dogecoin", LINK:"chainlink", UNI:"uniswap", XLM:"stellar",
    BCH:"bitcoin-cash", DSH:"dash", TRX:"tron", XTZ:"tezos",
    AAV:"aave", BAT:"basic-attention-token", ENJ:"enjincoin",
    KSM:"kusama", GRT:"the-graph", MAT:"matic-network",
    SOL:"solana", AVX:"avalanche-2"
  };

  const coinId = coinMap[coinSymbol.toUpperCase()] || coinSymbol.toLowerCase();
  try {
    const res   = await axios.get(
      `https://api.coingecko.com/api/v3/news?per_page=3`,
      { timeout: 5000 }
    );
    const items = (res.data.data || []).slice(0, 3).map(n => ({
      title:  n.title,
      url:    n.url,
      source: "CoinGecko"
    }));
    cache.set(cacheKey, items);
    return items;
  } catch (e) {
    // Fallback: general crypto search via NewsAPI
    return fetchNewsAPI(coinSymbol + " cryptocurrency");
  }
}

// Alpha Vantage — stocks news sentiment (free key)
async function fetchStockNews(ticker) {
  if (!AV_API_KEY) return fetchNewsAPI(ticker + " stock");

  const cacheKey = `av_${ticker}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  try {
    const res  = await axios.get(
      `https://www.alphavantage.co/query?function=NEWS_SENTIMENT&tickers=${ticker}&apikey=${AV_API_KEY}&limit=3`,
      { timeout: 5000 }
    );
    const items = (res.data.feed || []).slice(0, 3).map(n => ({
      title:  n.title,
      url:    n.url,
      source: "Alpha Vantage"
    }));
    cache.set(cacheKey, items);
    return items;
  } catch (e) {
    return fetchNewsAPI(ticker + " stock earnings");
  }
}

// NewsAPI.org — metals, indices, futures + fallback
async function fetchNewsAPI(query) {
  if (!NEWS_API_KEY) return [{ title: "Configure NEWS_API_KEY in .env for news", url: "#", source: "" }];

  const cacheKey = `napi_${query}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  try {
    const res  = await axios.get("https://newsapi.org/v2/everything", {
      params: { q: query, sortBy: "publishedAt", pageSize: 3, language: "en", apiKey: NEWS_API_KEY },
      timeout: 5000
    });
    const items = (res.data.articles || []).slice(0, 3).map(a => ({
      title:  a.title,
      url:    a.url,
      source: a.source?.name || "NewsAPI"
    }));
    cache.set(cacheKey, items);
    return items;
  } catch (e) {
    console.error("NewsAPI error:", e.message);
    return [];
  }
}

// ─── Unified news dispatcher ──────────────────────────────────────────────────
async function fetchNews(symbol) {
  const { group, base } = classifySymbol(symbol);
  const queryMap = {
    FUTURES: { BRENT: "Brent crude oil", NGAS: "natural gas price", WTI: "WTI crude oil" },
    INDICES: {
      SP500:"S&P 500", NASDAQ:"Nasdaq", DAX:"DAX Germany", UK100:"FTSE 100",
      US30:"Dow Jones", JP225:"Nikkei", HK50:"Hang Seng", AUS200:"ASX 200",
      EUSTX50:"Euro Stoxx", FRA40:"CAC 40"
    }
  };

  switch (group) {
    case "FOREX":   return fetchForexNews(base);
    case "CRYPTO":  return fetchCryptoNews(base);
    case "STOCKS":  return fetchStockNews(base);
    case "METALS":
      const metalQ = base.startsWith("XAU") ? "gold price" :
                     base.startsWith("XAG") ? "silver price" :
                     base.startsWith("XPD") ? "palladium price" : "platinum price";
      return fetchNewsAPI(metalQ);
    case "INDICES":
      return fetchNewsAPI(queryMap.INDICES[base] || base);
    case "FUTURES":
      return fetchNewsAPI(queryMap.FUTURES[base] || base);
    default:
      return fetchNewsAPI(base);
  }
}

// ─── Slack message builder ────────────────────────────────────────────────────
async function sendSlackAlert(spikes, reportTime, symbolsLoaded) {
  if (!SLACK_WEBHOOK) { console.warn("No SLACK_WEBHOOK set — skipping Slack"); return; }

  // Count distinct groups
  const groups = [...new Set(spikes.map(sp => classifySymbol(sp.symbol).group))];
  const summary = groups.length >= 3
    ? "Spikes in all Pairs"
    : `Spike in ${groups.map(niceGroup).join(" and ")} Pairs`;

  // Build detail lines with news
  let detailLines = "";
  for (const sp of spikes) {
    const news   = sp.news || [];
    const tag    = sp.tfName === "H1-LIVE" ? "H1 🔴LIVE" : "H1 ✅CLOSED";
    detailLines += `\n• *${sp.symbol}* [${tag}]  *${sp.classif}*  ${sp.ratio}x ATR`;
    detailLines += `\n  Range: ${sp.range}  |  ATR20: ${sp.atr20}  |  @ ${sp.candleTime}`;
    if (news.length > 0) {
      detailLines += `\n  📰 ${news[0].title}`;
      detailLines += `\n  🔗 ${news[0].url}`;
    }
    detailLines += "\n";
  }

  const text =
    `🚧 *[TEST ONLY]*\n` +
    `<!channel>\n` +
    `お疲れ様です。\n` +
    `:rotating_light: *[Spike Checker MT5] Spike Alert*\n\n` +
    `Report generated : ${reportTime} (MT5 Server Time)\n` +
    `Symbols loaded   : ${symbolsLoaded}\n` +
    `${summary}\n` +
    `\n*Spike Details + Related News:*${detailLines}`;

  try {
    await axios.post(SLACK_WEBHOOK, { text }, { timeout: 5000 });
    console.log("Slack alert sent");
  } catch (e) {
    console.error("Slack error:", e.message);
  }
}

function niceGroup(g) {
  const map = { FOREX:"Forex", METALS:"Metals", CRYPTO:"Crypto",
                STOCKS:"Stocks", INDICES:"Indices", FUTURES:"Futures" };
  return map[g] || g;
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// POST /spike — called by MT5 EA for each spike batch
// Body: { reportTime, symbolsLoaded, spikes: [ { symbol, group, tfName, classif, ratio, range, atr20, candleTime }, ... ] }
app.post("/spike", async (req, res) => {
  const { reportTime, symbolsLoaded, spikes } = req.body;

  if (!spikes || !Array.isArray(spikes) || spikes.length === 0) {
    return res.status(400).json({ error: "No spikes in payload" });
  }

  console.log(`[${new Date().toISOString()}] Received ${spikes.length} spike(s) from MT5`);

  // Fetch news for each spike in parallel
  const enriched = await Promise.all(
    spikes.map(async sp => {
      const news = await fetchNews(sp.symbol);
      return { ...sp, news };
    })
  );

  // Add to in-memory log
  enriched.forEach(sp => {
    spikeLog.unshift({ ...sp, receivedAt: new Date().toISOString() });
  });
  if (spikeLog.length > MAX_LOG) spikeLog.length = MAX_LOG;

  // Send consolidated Slack alert
  await sendSlackAlert(enriched, reportTime, symbolsLoaded);

  res.json({ ok: true, processed: enriched.length });
});

// GET /spikes — dashboard polls this for live data
app.get("/spikes", (req, res) => {
  res.json(spikeLog.slice(0, 50));
});

// DELETE /spikes/clear — wipe spike log from dashboard
app.delete("/spikes/clear", (req, res) => {
  spikeLog.length = 0;
  console.log(`[${new Date().toISOString()}] Spike log cleared`);
  res.json({ ok: true, message: "Spike log cleared" });
});

// GET / — serve dashboard
app.get("/", (req, res) => {
  res.sendFile(path.resolve(__dirname, "public", "index.html"));
});

// ── Local dev: start server directly
// ── Vercel:    exports app as serverless handler
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`\nSpike Monitor server running on port ${PORT}`);
    console.log(`Dashboard:     http://localhost:${PORT}`);
    console.log(`Slack webhook: ${SLACK_WEBHOOK ? "configured" : "NOT SET"}`);
    console.log(`NewsAPI key:   ${NEWS_API_KEY   ? "configured" : "NOT SET"}`);
    console.log(`AlphaVantage:  ${AV_API_KEY     ? "configured" : "NOT SET"}\n`);
  });
}

module.exports = app;