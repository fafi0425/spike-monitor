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
const { kv }    = require("@vercel/kv");
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

// Spike storage key in Vercel KV
const KV_KEY       = "spike_log";
const SETTINGS_KEY = "dashboard_settings";
const MAX_LOG      = 200;

// Helper: get spike log from KV
async function getSpikeLog() {
  try {
    const log = await kv.get(KV_KEY);
    return Array.isArray(log) ? log : [];
  } catch(e) {
    console.error("KV get error:", e.message);
    return [];
  }
}

// Helper: save spike log to KV
async function saveSpikeLog(log) {
  try {
    await kv.set(KV_KEY, log.slice(0, MAX_LOG));
  } catch(e) {
    console.error("KV set error:", e.message);
  }
}

// Helper: get dashboard settings from KV
async function getSettings() {
  try {
    const s = await kv.get(SETTINGS_KEY);
    return s || { slackEnabled: true, newsEnabled: true };
  } catch(e) {
    return { slackEnabled: true, newsEnabled: true };
  }
}

// Helper: save settings to KV
async function saveSettings(settings) {
  try {
    await kv.set(SETTINGS_KEY, settings);
  } catch(e) {
    console.error("KV settings error:", e.message);
  }
}

// ─── Blocked keywords — gambling, spam, adult, unrelated content ─────────────
const BLOCKED_KEYWORDS = [
  // Gambling
  "casino","gambling","gamble","slot machine","slots","online slots",
  "poker","blackjack","roulette","bingo","lottery","jackpot","freespins",
  "free spins","sportsbook","sportsbetting","sports betting","bet365",
  "betway","draftkings","fanduel","bovada","888casino","betmgm",
  "online casino","live casino","crypto casino","bitcoin casino",
  "nft casino","play casino","casino bonus","casino promo",
  // Spam / irrelevant
  "payday loan","quick loan","forex signal","forex robot","forex ea",
  "make money fast","get rich","investment opportunity","guaranteed profit",
  "sponsored","press release sponsored","promo code","sign up bonus",
  // Job sites
  "indeed.com","glassdoor","linkedin.com/jobs","monster.com",
  // Adult
  "adult","pornography","escort","onlyfans"
];

// ─── Symbol → search keywords map ────────────────────────────────────────────
// Each symbol maps to an array of keywords that MUST appear in news title
const SYMBOL_KEYWORDS = {
  // Forex
  AUD:["AUD","Australian dollar","Australia","RBA"],
  CAD:["CAD","Canadian dollar","Canada","BOC","Bank of Canada"],
  CHF:["CHF","Swiss franc","Switzerland","SNB"],
  EUR:["EUR","Euro","European","ECB","Eurozone"],
  GBP:["GBP","British pound","Sterling","UK","BOE","Bank of England"],
  JPY:["JPY","Japanese yen","Japan","BOJ","Bank of Japan"],
  NZD:["NZD","New Zealand dollar","RBNZ"],
  USD:["USD","US dollar","Federal Reserve","Fed","FOMC"],
  NOK:["NOK","Norwegian krone","Norway","Norges Bank"],
  SEK:["SEK","Swedish krona","Sweden","Riksbank"],
  DKK:["DKK","Danish krone","Denmark"],
  HKD:["HKD","Hong Kong dollar","Hong Kong"],
  SGD:["SGD","Singapore dollar","Singapore","MAS"],
  CNH:["CNH","CNY","Chinese yuan","China","PBOC"],
  MXN:["MXN","Mexican peso","Mexico","Banxico"],
  ZAR:["ZAR","South African rand","South Africa","SARB"],
  TRY:["TRY","Turkish lira","Turkey","CBRT"],
  PLN:["PLN","Polish zloty","Poland","NBP"],
  HUF:["HUF","Hungarian forint","Hungary","MNB"],
  CZK:["CZK","Czech koruna","Czech","CNB"],
  THB:["THB","Thai baht","Thailand","BOT"],
  // Metals
  XAU:["gold","XAU","gold price","gold futures"],
  XAG:["silver","XAG","silver price","silver futures"],
  XPD:["palladium","XPD","palladium price"],
  XPT:["platinum","XPT","platinum price"],
  // Crypto
  BTC:["Bitcoin","BTC"],    ETH:["Ethereum","ETH"],
  ADA:["Cardano","ADA"],    XRP:["XRP","Ripple"],
  SOL:["Solana","SOL"],     BNB:["BNB","Binance"],
  LTC:["Litecoin","LTC"],   DOT:["Polkadot","DOT"],
  DOGE:["Dogecoin","DOGE"], LINK:["Chainlink","LINK"],
  UNI:["Uniswap","UNI"],    XLM:["Stellar","XLM"],
  BCH:["Bitcoin Cash","BCH"],DSH:["Dash","DSH"],
  TRX:["TRON","TRX"],       XTZ:["Tezos","XTZ"],
  AAV:["Aave","AAV"],       BAT:["Basic Attention Token","BAT"],
  KSM:["Kusama","KSM"],     GRT:["The Graph","GRT"],
  MAT:["Polygon","MATIC"],  AVX:["Avalanche","AVAX"],
  AXS:["Axie Infinity","AXS"],CHZ:["Chiliz","CHZ"],
  COM:["Compound","COMP"],  DOG:["Dogecoin","DOGE"],
  SKL:["SKALE","SKL"],      SSS:["SSS"],
  STR:["Stellar","STR"],    THT:["THORChain","RUNE"],
  LUN:["Luna","LUNA"],      MAN:["Decentraland","MANA"],
  LNK:["Chainlink","LINK"], ZRX:["0x protocol","ZRX"],
  ALG:["Algorand","ALGO"],  // Stocks
  AAPL:["Apple","AAPL"],    ABNB:["Airbnb","ABNB"],
  AMZN:["Amazon","AMZN"],   BA:["Boeing","BA"],
  BABA:["Alibaba","BABA"],  BIDU:["Baidu","BIDU"],
  GME:["GameStop","GME"],   GOOGL:["Google","Alphabet","GOOGL"],
  JPM:["JPMorgan","JPM"],   MSFT:["Microsoft","MSFT"],
  MVRS:["Meta","Facebook","MVRS"],NFLX:["Netflix","NFLX"],
  PDD:["Pinduoduo","PDD"],  PFE:["Pfizer","PFE"],
  TSLA:["Tesla","TSLA"],    XOM:["ExxonMobil","XOM"],
  XPEV:["XPeng","XPEV"],    ZM:["Zoom","ZM"],
  // Indices
  AUS200:["ASX","Australia 200","AUS200"],
  DAX:["DAX","Germany","German stock"],
  EUSTX50:["Euro Stoxx","European stocks","EUSTX50"],
  FRA40:["CAC 40","France","French stock"],
  HK50:["Hang Seng","Hong Kong","HK50"],
  JP225:["Nikkei","Japan","JP225"],
  NASDAQ:["Nasdaq","tech stocks","Nasdaq 100"],
  SP500:["S&P 500","S&P500","US stocks","Wall Street"],
  UK100:["FTSE","UK stocks","UK100"],
  US30:["Dow Jones","DJIA","US30"],
  // Futures
  BRENT:["Brent","crude oil","oil price"],
  NGAS:["natural gas","NGAS","gas price"],
  WTI:["WTI","crude oil","West Texas"]
};

// ─── Get keywords for a symbol ────────────────────────────────────────────────
function getSymbolKeywords(symbol) {
  const s = symbol.replace(".std","").toUpperCase();
  // Direct match
  if (SYMBOL_KEYWORDS[s]) return SYMBOL_KEYWORDS[s];
  // Try base currency (first 3 chars for forex)
  const base = s.slice(0,3);
  if (SYMBOL_KEYWORDS[base]) return SYMBOL_KEYWORDS[base];
  // Fallback
  return [s];
}

// ─── Strict news filter — blocks gambling + requires symbol relevance ─────────
function filterNews(items, keywords) {
  return items.filter(item => {
    if (!item || !item.title || !item.url) return false;
    const url   = (item.url   || "").toLowerCase();
    const title = (item.title || "").toLowerCase();
    const combined = title + " " + url;

    // Hard block — any gambling/spam keyword found → reject immediately
    const isBlocked = BLOCKED_KEYWORDS.some(bk =>
      combined.includes(bk.toLowerCase())
    );
    if (isBlocked) return false;

    // Relevance check — title MUST contain at least one symbol keyword
    const isRelevant = keywords.some(kw =>
      title.includes(kw.toLowerCase())
    );
    return isRelevant;
  });
}

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
    const raw   = feed.items
      .filter(i => i.title && i.title.toUpperCase().includes(currency.toUpperCase()))
      .map(i => ({ title: i.title, url: i.link || "https://www.forexfactory.com", source: "Forex Factory" }));
    const items = filterNews(raw, [currency.toLowerCase()]).slice(0, 2);

    // Fallback to NewsAPI if no Forex Factory events
    if (items.length === 0) {
      return fetchNewsAPI(currency + " forex central bank", [currency.toLowerCase()]);
    }
    cache.set(cacheKey, items);
    return items;
  } catch (e) {
    console.error("ForexFactory RSS error:", e.message);
    return fetchNewsAPI(currency + " forex", [currency.toLowerCase()]);
  }
}

// CoinGecko + NewsAPI — crypto news with relevance filtering
async function fetchCryptoNews(coinSymbol) {
  const cacheKey = `cg_${coinSymbol}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  const sym      = coinSymbol.toUpperCase();
  const coinName = COIN_NAMES[sym] || (sym + " crypto");
  const keywords = [sym.toLowerCase(), coinName.toLowerCase().split(" ")[0]];

  // CoinGecko coin id map
  const coinMap = {
    BTC:"bitcoin", ETH:"ethereum", ADA:"cardano", XRP:"ripple",
    SOL:"solana",  BNB:"binancecoin", LTC:"litecoin", DOT:"polkadot",
    DOGE:"dogecoin", LINK:"chainlink", UNI:"uniswap", XLM:"stellar",
    BCH:"bitcoin-cash", DSH:"dash", TRX:"tron", XTZ:"tezos",
    AAV:"aave", BAT:"basic-attention-token",
    KSM:"kusama", GRT:"the-graph", MAT:"matic-network", AVX:"avalanche-2"
  };

  const coinId = coinMap[sym] || sym.toLowerCase();
  try {
    const res   = await axios.get(
      `https://api.coingecko.com/api/v3/news?per_page=10`,
      { timeout: 5000 }
    );
    const raw   = (res.data.data || []).map(n => ({
      title: n.title, url: n.url, source: "CoinGecko"
    }));
    const items = filterNews(raw, keywords).slice(0, 2);
    if (items.length > 0) {
      cache.set(cacheKey, items);
      return items;
    }
    // Fallback to NewsAPI with full coin name
    return fetchNewsAPI(coinName, keywords);
  } catch (e) {
    return fetchNewsAPI(coinName, keywords);
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
async function fetchNewsAPI(query, keywords = null) {
  if (!NEWS_API_KEY) return [{ title: "Configure NEWS_API_KEY in .env for news", url: "#", source: "" }];

  const cacheKey = `napi_${query}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  try {
    const res  = await axios.get("https://newsapi.org/v2/everything", {
      params: { q: query, sortBy: "publishedAt", pageSize: 10, language: "en", apiKey: NEWS_API_KEY },
      timeout: 5000
    });
    const raw   = (res.data.articles || []).map(a => ({
      title:  a.title,
      url:    a.url,
      source: a.source?.name || "NewsAPI"
    }));
    // Filter by keywords if provided, otherwise just block bad domains
    const filterKw = keywords || [query.toLowerCase().split(" ")[0]];
    const items    = filterNews(raw, filterKw).slice(0, 2);
    cache.set(cacheKey, items.length > 0 ? items : []);
    return items;
  } catch (e) {
    console.error("NewsAPI error:", e.message);
    return [];
  }
}

// ─── Unified news dispatcher ──────────────────────────────────────────────────
async function fetchNews(symbol) {
  const { group, base } = classifySymbol(symbol);
  const keywords = getSymbolKeywords(symbol);
  const query    = keywords[0]; // primary search term

  switch (group) {
    case "FOREX":   return fetchForexNews(base);
    case "CRYPTO":  return fetchCryptoNews(base);
    case "STOCKS":  return fetchStockNews(base);
    case "METALS":  return fetchNewsAPI(query, keywords);
    case "INDICES": return fetchNewsAPI(query, keywords);
    case "FUTURES": return fetchNewsAPI(query, keywords);
    default:        return fetchNewsAPI(query, keywords);
  }
}

// ─── Slack message builder ────────────────────────────────────────────────────
async function sendSlackAlert(spikes, reportTime, symbolsLoaded, settings) {
  if (!SLACK_WEBHOOK) { console.warn("No SLACK_WEBHOOK set — skipping Slack"); return; }
  if (!settings.slackEnabled) { console.log("Slack alerts paused by dashboard toggle."); return; }

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
    if (settings.newsEnabled && news.length > 0 && news[0].title && news[0].url && news[0].url !== "#") {
      detailLines += `\n  📰 ${news[0].title}`;
      detailLines += `\n  🔗 ${news[0].url}`;
    } else if (settings.newsEnabled) {
      detailLines += `\n  📰 No related news found`;
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

  // Save to Vercel KV
  const currentLog = await getSpikeLog();
  enriched.forEach(sp => {
    currentLog.unshift({ ...sp, receivedAt: new Date().toISOString() });
  });
  await saveSpikeLog(currentLog);

  // Send consolidated Slack alert
  const settings = await getSettings();
  await sendSlackAlert(enriched, reportTime, symbolsLoaded, settings);

  res.json({ ok: true, processed: enriched.length });
});

// GET /spikes — dashboard polls this for live data
app.get("/spikes", async (req, res) => {
  const log = await getSpikeLog();
  res.json(log.slice(0, 50));
});

// DELETE /spikes/clear — wipe spike log from KV
app.delete("/spikes/clear", async (req, res) => {
  await kv.del(KV_KEY);
  console.log(`[${new Date().toISOString()}] Spike log cleared`);
  res.json({ ok: true, message: "Spike log cleared" });
});

// GET /settings — return current toggle states
app.get("/settings", async (req, res) => {
  const s = await getSettings();
  res.json(s);
});

// POST /settings — update toggle states
app.post("/settings", async (req, res) => {
  const current = await getSettings();
  const updated = { ...current, ...req.body };
  await saveSettings(updated);
  console.log(`[${new Date().toISOString()}] Settings updated:`, updated);
  res.json({ ok: true, settings: updated });
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