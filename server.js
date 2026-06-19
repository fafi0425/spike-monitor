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
const AV_API_KEY    = process.env.AV_API_KEY    || "";   // alphavantage.co (optional, not required)

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

// ─── Trusted financial news domains — ONLY these sources are allowed ────────
const TRUSTED_DOMAINS = [
  "fxstreet.com","forexfactory.com","dailyfx.com","forex.com",
  "coindesk.com","cointelegraph.com","decrypt.co","theblock.co",
  "kitco.com","mining.com","metalsbulletin.com",
  "marketwatch.com","wsj.com","reuters.com","bloomberg.com",
  "ft.com","cnbc.com","investing.com","benzinga.com",
  "seekingalpha.com","finance.yahoo.com","barrons.com",
  "thestreet.com","zerohedge.com","financialpost.com",
  "oilprice.com","naturalgasintel.com","ngas.news",
  "nikkei.com","scmp.com","businesstimes.com.sg",
  "investing.com","ph.investing.com"
];

// ─── Blocked URL paths — non-financial sections of news sites ────────────────
const BLOCKED_PATHS = [
  "tvshowbiz","showbiz","entertainment","celebrity","music",
  "sports","sport","lifestyle","travel","food","health",
  "fashion","beauty","horoscope","astrology","games","dating"
];

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
  const s    = symbol.replace(".std","").toUpperCase();
  const base = s.slice(0,3);
  const quote = s.slice(3,6);

  // Direct match (stocks, indices, futures)
  if (SYMBOL_KEYWORDS[s]) return SYMBOL_KEYWORDS[s];

  // Forex pair — combine keywords for BOTH base AND quote currencies
  const baseKw  = SYMBOL_KEYWORDS[base]  || [base];
  const quoteKw = SYMBOL_KEYWORDS[quote] || [quote];
  return [...new Set([...baseKw, ...quoteKw])];
}

// ─── News filter — 3-layer check ────────────────────────────────────────────
// 1. Must be from a trusted financial domain
// 2. Must not be from a non-financial URL path (showbiz, sports, etc.)
// 3. Must not contain gambling/spam keywords
function filterNews(items) {
  return items.filter(item => {
    if (!item || !item.title || !item.url) return false;
    const url      = (item.url   || "").toLowerCase();
    const title    = (item.title || "").toLowerCase();
    const combined = title + " " + url;

    // Layer 1 — must come from a trusted financial domain
    const isTrusted = TRUSTED_DOMAINS.some(d => url.includes(d));
    if (!isTrusted) return false;

    // Layer 2 — block non-financial URL paths (tvshowbiz, sports, etc.)
    const hasBlockedPath = BLOCKED_PATHS.some(p => url.includes("/" + p));
    if (hasBlockedPath) return false;

    // Layer 3 — block gambling/spam keywords in title or url
    const hasBlockedKw = BLOCKED_KEYWORDS.some(bk =>
      combined.includes(bk.toLowerCase())
    );
    return !hasBlockedKw;
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

// ─── RSS feed URLs ────────────────────────────────────────────────────────────
const RSS_FEEDS = {
  fxstreet:      "https://www.fxstreet.com/rss/news",
  forexfactory:  "https://nfs.faireconomy.media/ff_calendar_thisweek.xml",
  coindesk:      "https://www.coindesk.com/arc/outboundfeeds/rss/",
  cointelegraph: "https://cointelegraph.com/rss",
  kitco:         "https://www.kitco.com/rss/kitconews.rss",
  marketwatch:   "https://feeds.marketwatch.com/marketwatch/topstories",
  investing_news:"https://www.investing.com/rss/news.rss",
  investing_fx:  "https://www.investing.com/rss/news_14.rss",
  investing_comm:"https://www.investing.com/rss/news_4.rss",
  investing_stock:"https://www.investing.com/rss/news_25.rss",
  investing_crypto:"https://www.investing.com/rss/news_301.rss",
};

// ─── Strict relevance filter — used for broad/general RSS sources ──────────────
// Requires at least one keyword to appear in the article TITLE
function filterNewsByKeywords(items, keywords) {
  return filterNews(items).filter(item => {
    const title = (item.title || "").toLowerCase();
    return keywords.some(kw => title.includes(kw.toLowerCase()));
  });
}

// ─── Generic RSS fetcher with keyword filtering ───────────────────────────────
async function fetchRSS(feedUrl, keywords, sourceName) {
  const cacheKey = `rss_${feedUrl}_${keywords[0]}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  try {
    const feed  = await rss.parseURL(feedUrl);
    const raw   = (feed.items || []).map(i => ({
      title:  i.title  || "",
      url:    i.link   || i.url || feedUrl,
      source: sourceName
    }));
    const items = filterNews(raw).slice(0, 2);
    cache.set(cacheKey, items);
    return items;
  } catch(e) {
    console.error(`RSS error (${sourceName}):`, e.message);
    return [];
  }
}

// ─── Forex — FXStreet primary, Forex Factory calendar fallback ───────────────
async function fetchForexNews(currency, pairSymbol) {
  const cacheKey = `forex_${pairSymbol || currency}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  // Get keywords for BOTH currencies in the pair
  const keywords = getSymbolKeywords(pairSymbol || currency);

  // Try FXStreet first
  let items = await fetchRSS(RSS_FEEDS.fxstreet, keywords, "FXStreet");

  // Fallback 1 — Forex Factory calendar events
  if (items.length === 0) {
    try {
      const feed = await rss.parseURL(RSS_FEEDS.forexfactory);
      const raw  = (feed.items || [])
        .filter(i => i.title && i.title.toUpperCase().includes(currency.toUpperCase()))
        .map(i => ({ title: i.title, url: i.link || "https://www.forexfactory.com", source: "Forex Factory" }));
      items = filterNews(raw).slice(0, 2);
    } catch(e) { console.error("Forex Factory fallback error:", e.message); }
  }

  // Fallback 2 — Investing.com forex news (strict keyword filter for broad source)
  if (items.length === 0) {
    const raw = await fetchRSS(RSS_FEEDS.investing_fx, keywords, "Investing.com");
    items = filterNewsByKeywords(raw, keywords);
  }

  // Fallback 3 — Investing.com general news with strict filter
  if (items.length === 0) {
    const raw = await fetchRSS(RSS_FEEDS.investing_news, keywords, "Investing.com");
    items = filterNewsByKeywords(raw, keywords);
  }

  // Fallback 4 — Forex Factory calendar events for this currency
  if (items.length === 0) {
    items = await fetchCalendarEvents(currency);
  }

  cache.set(cacheKey, items);
  return items;
}

// ─── Economic calendar events from Forex Factory ────────────────────────────────
// Used when no news article found — shows scheduled events as context
async function fetchCalendarEvents(currency) {
  const cacheKey = `cal_${currency}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  // Use ALL keywords for the currency, not just the 3-letter code
  // e.g. JPY → ["JPY","Japanese yen","Japan","BOJ","Bank of Japan"]
  // so "BOJ Deputy Gov Himino..." and "BOJ Minutes..." are both caught
  const keywords = SYMBOL_KEYWORDS[currency] || [currency];

  try {
    const feed  = await rss.parseURL(RSS_FEEDS.forexfactory);
    const raw   = (feed.items || [])
      .filter(i => {
        if (!i.title) return false;
        const title = i.title.toUpperCase();
        return keywords.some(kw => title.includes(kw.toUpperCase()));
      })
      .slice(0, 2)
      .map(i => ({
        title:  "📅 [Economic Calendar] " + i.title,
        url:    i.link || "https://www.forexfactory.com/calendar",
        source: "Forex Factory Calendar"
      }));
    cache.set(cacheKey, raw);
    return raw;
  } catch(e) {
    console.error("Calendar fetch error:", e.message);
    return [];
  }
}

// ─── Crypto — CoinDesk primary, CoinTelegraph fallback ───────────────────────
async function fetchCryptoNews(coinSymbol) {
  const cacheKey = `crypto_${coinSymbol}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  const keywords = getSymbolKeywords(coinSymbol);

  // Try CoinDesk first
  let items = await fetchRSS(RSS_FEEDS.coindesk, keywords, "CoinDesk");

  // Fallback 1 — CoinTelegraph
  if (items.length === 0) {
    items = await fetchRSS(RSS_FEEDS.cointelegraph, keywords, "CoinTelegraph");
  }

  // Fallback 2 — Investing.com crypto
  if (items.length === 0) {
    items = await fetchRSS(RSS_FEEDS.investing_crypto, keywords, "Investing.com");
  }

  cache.set(cacheKey, items);
  return items;
}

// ─── Metals — Kitco primary ───────────────────────────────────────────────────
async function fetchMetalsNews(symbol) {
  const cacheKey = `metals_${symbol}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  const keywords = getSymbolKeywords(symbol);

  // Kitco — specialist gold/silver/platinum/palladium news
  let items = await fetchRSS(RSS_FEEDS.kitco, keywords, "Kitco");

  // Fallback 1 — MarketWatch
  if (items.length === 0) {
    items = await fetchRSS(RSS_FEEDS.marketwatch, keywords, "MarketWatch");
  }

  // Fallback 2 — Investing.com commodities
  if (items.length === 0) {
    items = await fetchRSS(RSS_FEEDS.investing_comm, keywords, "Investing.com");
  }

  cache.set(cacheKey, items);
  return items;
}

// ─── Stocks, Indices, Futures — MarketWatch ───────────────────────────────────
async function fetchMarketNews(symbol) {
  const cacheKey = `market_${symbol}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  const sym      = symbol.replace(".std","").toUpperCase();
  const keywords = getSymbolKeywords(symbol);

  // Primary — MarketWatch
  let items = await fetchRSS(RSS_FEEDS.marketwatch, keywords, "MarketWatch");

  // Fallback 1 — Investing.com stocks news (strict keyword filter)
  if (items.length === 0) {
    const raw = await fetchRSS(RSS_FEEDS.investing_stock, keywords, "Investing.com");
    items = filterNewsByKeywords(raw, keywords);
  }

  // Fallback 2 — Investing.com general news (strict keyword filter)
  if (items.length === 0) {
    const raw = await fetchRSS(RSS_FEEDS.investing_news, keywords, "Investing.com");
    items = filterNewsByKeywords(raw, keywords);
  }

  // Fallback 3 — For indices, try FXStreet using the related currency keywords
  // e.g. JP225 → search FXStreet for JPY/BOJ/Japan/Bank of Japan
  if (items.length === 0 && INDEX_CURRENCY[sym]) {
    const relatedCurrency = INDEX_CURRENCY[sym];
    const currencyKeywords = SYMBOL_KEYWORDS[relatedCurrency] || [relatedCurrency];
    items = await fetchRSS(RSS_FEEDS.fxstreet, currencyKeywords, "FXStreet");
    if (items.length > 0)
      console.log(`[${sym}] Found ${items.length} news via FXStreet (${relatedCurrency} keywords)`);
  }

  // Fallback 4 — Forex Factory calendar using full keyword set
  // Catches BOJ headlines, Fed statements, ECB decisions etc.
  if (items.length === 0 && INDEX_CURRENCY[sym]) {
    const relatedCurrency = INDEX_CURRENCY[sym];
    items = await fetchCalendarEvents(relatedCurrency);
    if (items.length > 0)
      console.log(`[${sym}] Showing ${relatedCurrency} calendar events — no news articles found`);
  }

  cache.set(cacheKey, items);
  return items;
}

// ─── NewsAPI fallback (only if RSS returns nothing) ───────────────────────────
async function fetchNewsAPI(query, keywords = null) {
  if (!NEWS_API_KEY) return [];

  const cacheKey = `napi_${query}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  try {
    const res   = await axios.get("https://newsapi.org/v2/everything", {
      params: { q: query, sortBy: "publishedAt", pageSize: 10, language: "en", apiKey: NEWS_API_KEY },
      timeout: 5000
    });
    const raw   = (res.data.articles || []).map(a => ({
      title:  a.title,
      url:    a.url,
      source: a.source?.name || "NewsAPI"
    }));
    const filterKw = keywords || [query.toLowerCase().split(" ")[0]];
    const items    = filterNews(raw).slice(0, 2);
    cache.set(cacheKey, items);
    return items;
  } catch(e) {
    console.error("NewsAPI error:", e.message);
    return [];
  }
}

// ─── Unified news dispatcher ──────────────────────────────────────────────────
async function fetchNews(symbol) {
  const { group, base } = classifySymbol(symbol);

  switch (group) {
    case "FOREX":   return fetchForexNews(base, symbol.replace(".std","").toUpperCase());
    case "CRYPTO":  return fetchCryptoNews(base);
    case "METALS":  return fetchMetalsNews(base);
    case "STOCKS":  return fetchMarketNews(base);
    case "INDICES": return fetchMarketNews(base);
    case "FUTURES": return fetchMarketNews(base);
    default:        return fetchMarketNews(base);
  }
}


async function fetchNews(symbol) {
  const { group, base } = classifySymbol(symbol);
  const keywords = getSymbolKeywords(symbol);
  const query    = keywords[0]; // primary search term

  switch (group) {
    case "FOREX":   return fetchForexNews(base, symbol.replace(".std","").toUpperCase());
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