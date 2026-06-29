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
// Approved news sources — ONLY articles from these domains are allowed
const TRUSTED_DOMAINS = [
  "forexfactory.com",           // Forex Factory — economic calendar
  "nfs.faireconomy.media",      // Forex Factory RSS feed domain
  "fxstreet.com",               // FXStreet — forex and financial news
  "marketwatch.com",            // MarketWatch — stocks, indices, futures
  "coindesk.com",               // CoinDesk — crypto news
  "investing.com",              // Investing.com — all asset classes
  "ph.investing.com"            // Investing.com Philippines region
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
  // ── Forex: base currencies ──────────────────────────────────────────────────
  AUD:["AUD","Australia","Aussie Dollar","Reserve Bank of Australia","RBA",
       "Australian CPI","Australian Employment","Unemployment Rate",
       "Wage Price Index","Iron Ore","Coal Exports","China Economy","Australian GDP"],
  NZD:["NZD","New Zealand","Kiwi","Reserve Bank of New Zealand","RBNZ",
       "Dairy Prices","Global Dairy Trade","GDT","NZ Employment","NZ CPI","NZ GDP",
       "Agriculture","Milk Exports"],
  JPY:["JPY","Yen","Japan","Bank of Japan","BOJ","Nikkei","JP225",
       "Yield Curve Control","YCC","Japanese CPI","Japanese GDP",
       "Ministry of Finance","MOF","FX Intervention","Carry Trade","Tokyo CPI"],
  USD:["USD","Dollar","United States","Federal Reserve","Fed","FOMC",
       "Non-Farm Payrolls","NFP","CPI","PPI","Core Inflation","GDP",
       "ISM PMI","Retail Sales","Treasury Yields","DXY"],
  EUR:["EUR","Euro","Eurozone","European Central Bank","ECB","ECB Rate Decision",
       "Germany","France","Eurozone CPI","German Bund","DAX","EUSTX50"],
  GBP:["GBP","Pound","United Kingdom","UK","Britain","Bank of England","BOE",
       "BOE Rate Decision","UK CPI","UK GDP","Brexit","FTSE","UK100"],
  CHF:["CHF","Swiss Franc","Switzerland","Swiss National Bank","SNB",
       "Safe Haven","Swiss CPI","Swiss GDP","Banking Sector"],
  CAD:["CAD","Canadian Dollar","Canada","Bank of Canada","BOC",
       "Crude Oil","WTI","Employment Change","CPI","GDP","Energy Exports"],
  SGD:["SGD","Singapore Dollar","Singapore","Monetary Authority of Singapore","MAS",
       "CPI","GDP","Trade Balance","Asian Markets"],
  NOK:["NOK","Norwegian Krone","Norway","Norges Bank",
       "Brent Oil","North Sea Oil","CPI","GDP"],
  SEK:["SEK","Swedish Krona","Sweden","Riksbank","CPI","GDP","Manufacturing"],
  TRY:["TRY","Turkish Lira","Turkey","Central Bank of Turkey","CBRT",
       "Inflation","Erdogan","Interest Rates","Currency Crisis"],
  ZAR:["ZAR","Rand","South Africa","SARB","Gold","Platinum","Mining","Eskom"],
  CNH:["CNH","CNY","Yuan","Renminbi","China","PBOC","People's Bank of China",
       "Chinese GDP","PMI","Trade Balance","Property Market"],
  MXN:["MXN","Peso","Mexico","Banxico","Oil","Inflation","Manufacturing"],
  HKD:["HKD","Hong Kong Dollar","Hong Kong","HKMA","Hang Seng","HK50","China Economy"],
  THB:["THB","Thai Baht","Thailand","Bank of Thailand","BOT","Tourism","CPI","GDP"],
  PLN:["PLN","Polish Zloty","Poland","National Bank of Poland","NBP",
       "CPI","GDP","EU Economy"],
  HUF:["HUF","Hungarian Forint","Hungary","National Bank of Hungary","MNB",
       "Inflation","GDP"],
  CZK:["CZK","Czech Koruna","Czech Republic","Czech National Bank","CNB",
       "CPI","GDP"],
  DKK:["DKK","Danish Krone","Denmark","Danish Central Bank","ECB","Inflation"],

  // ── Metals ──────────────────────────────────────────────────────────────────
  XAU:["Gold","Bullion","XAU","Precious Metals","Central Bank Gold Buying",
       "Safe Haven","Inflation Hedge","Real Yields","Geopolitics"],
  XAG:["Silver","XAG","Precious Metals","Industrial Demand","Solar Industry",
       "Safe Haven"],
  XPD:["Palladium","XPD","Automotive Catalysts","Russia Mining","South Africa Mining"],
  XPT:["Platinum","XPT","Fuel Cells","Automotive Industry","South Africa Mining"],

  // ── Crypto ──────────────────────────────────────────────────────────────────
  BTC:["Bitcoin","BTC","Crypto ETF","Institutional Adoption","Halving",
       "Blockchain","SEC","Risk Sentiment"],
  ETH:["Ethereum","ETH","Staking","Smart Contracts","DeFi","Layer 2"],
  BNB:["BNB","Binance","Exchange Token","BNB Chain"],
  XRP:["XRP","Ripple","SEC Lawsuit","Cross-border Payments"],
  SOL:["Solana","SOL","DeFi","NFTs","Memecoins"],
  ADA:["Cardano","ADA","Charles Hoskinson","Proof of Stake"],
  ALG:["Algorand","ALGO"],
  AVX:["Avalanche","AVAX","AVX","DeFi"],
  AXS:["Axie Infinity","AXS","GameFi","NFT"],
  BAT:["Basic Attention Token","BAT","Brave Browser"],
  BCH:["Bitcoin Cash","BCH"],
  AAV:["Aave","AAV","DeFi","Lending Protocol"],
  DSH:["Dash","DSH","Cryptocurrency"],
  DOG:["Dogecoin","DOGE","Memecoin","Elon Musk"],
  DOT:["Polkadot","DOT","Parachain","Web3"],
  GRT:["The Graph","GRT","Indexing Protocol","DeFi"],
  KSM:["Kusama","KSM","Parachain","Polkadot"],
  LNK:["Chainlink","LINK","Oracle","Smart Contracts"],
  LTC:["Litecoin","LTC","Cryptocurrency"],
  LUN:["Luna","LUNA","Terra"],
  MAN:["Decentraland","MANA","Metaverse","NFT"],
  MAT:["Polygon","MATIC","Layer 2","DeFi"],
  SKL:["SKALE","SKL","Layer 2","Ethereum"],
  SSS:["SSS","Cryptocurrency"],
  STR:["Stellar","XLM","STR","Cross-border Payments"],
  THT:["THORChain","RUNE","THT","DeFi","Cross-chain"],
  TRX:["TRON","TRX","DeFi","Smart Contracts"],
  UNI:["Uniswap","UNI","DeFi","DEX"],
  XLM:["Stellar","XLM","Cross-border Payments","Lumens"],
  XTZ:["Tezos","XTZ","Smart Contracts","Proof of Stake"],
  ZRX:["0x Protocol","ZRX","DEX","DeFi"],
  CHZ:["Chiliz","CHZ","Sports Token","Fan Token"],
  COM:["Compound","COMP","COM","DeFi","Lending"],

  // ── Stocks ───────────────────────────────────────────────────────────────────
  AAPL: ["Apple","AAPL","iPhone","Mac","Services Revenue","App Store"],
  ABNB: ["Airbnb","ABNB","Travel","Vacation Rental"],
  AMZN: ["Amazon","AMZN","AWS","E-commerce","Cloud Computing"],
  BA:   ["Boeing","BA","Aerospace","Aircraft","Defense"],
  BABA: ["Alibaba","BABA","China Tech","E-commerce"],
  BIDU: ["Baidu","BIDU","China Tech","Search Engine","AI"],
  GME:  ["GameStop","GME","Meme Stock","Short Squeeze"],
  GOOGL:["Google","Alphabet","GOOGL","Search","YouTube","AI","Cloud"],
  JPM:  ["JPMorgan","JPM","Banking","Interest Rates","Financial Sector"],
  MSFT: ["Microsoft","MSFT","Azure","AI","OpenAI","Cloud"],
  MVRS: ["Meta","Facebook","MVRS","Metaverse","Social Media","Advertising"],
  NFLX: ["Netflix","NFLX","Streaming","Subscribers","Entertainment"],
  PDD:  ["Pinduoduo","PDD","China E-commerce","Temu"],
  PFE:  ["Pfizer","PFE","Pharmaceutical","Drug","FDA"],
  TSLA: ["Tesla","TSLA","EV","Electric Vehicle","Elon Musk","Battery"],
  XOM:  ["ExxonMobil","XOM","Oil","Energy","WTI","Brent"],
  XPEV: ["XPeng","XPEV","China EV","Electric Vehicle"],
  ZM:   ["Zoom","ZM","Video Conferencing","Remote Work"],

  // ── Indices ──────────────────────────────────────────────────────────────────
  JP225:  ["Japan","Nikkei","BOJ","Yen","Tokyo Stock Exchange","Japanese stocks"],
  DAX:    ["DAX","Germany","German economy","ECB","Manufacturing","Exports"],
  EUSTX50:["Euro Stoxx","EUSTX50","European stocks","ECB","Eurozone economy"],
  FRA40:  ["CAC 40","France","French economy","ECB","Paris","FRA40"],
  HK50:   ["Hang Seng","HK50","Hong Kong","China economy","HKMA"],
  NASDAQ: ["Nasdaq","Technology stocks","AI","Growth stocks","Federal Reserve","Tech"],
  SP500:  ["S&P 500","SP500","US economy","Federal Reserve","Earnings Season","Wall Street"],
  UK100:  ["FTSE","UK100","UK economy","Bank of England","BOE","British stocks"],
  US30:   ["Dow Jones","US30","DJIA","Blue chip stocks","US economy"],
  AUS200: ["ASX","AUS200","Australia","RBA","Mining","Australian stocks"],

  // ── Energies ─────────────────────────────────────────────────────────────────
  BRENT:["Brent","Brent Oil","North Sea Oil","OPEC+","Global Supply","Crude"],
  WTI:  ["WTI","Crude Oil","OPEC","OPEC+","US Inventory","EIA",
         "Middle East","Energy Markets"],
  NGAS: ["Natural Gas","NGAS","LNG","Weather","Storage Inventory","Energy Crisis"],
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

// ─── Priority symbols — these trigger @channel mention in Slack ─────────────
// All other spikes are sent to Slack without the @channel mention
const PRIORITY_SYMBOLS = ["XAUUSD","USDJPY","EURUSD","GBPUSD","GBPJPY"];

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
// RSS feed URLs — approved sources only
const RSS_FEEDS = {
  fxstreet:        "https://www.fxstreet.com/rss/news",
  forexfactory:    "https://nfs.faireconomy.media/ff_calendar_thisweek.xml",
  marketwatch:     "https://feeds.marketwatch.com/marketwatch/topstories",
  coindesk:        "https://www.coindesk.com/arc/outboundfeeds/rss/",
  investing_news:  "https://www.investing.com/rss/news.rss",
  investing_fx:    "https://www.investing.com/rss/news_14.rss",
  investing_comm:  "https://www.investing.com/rss/news_4.rss",
  investing_stock: "https://www.investing.com/rss/news_25.rss",
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

  // Fallback 2 — Investing.com forex RSS (strict keyword filter)
  if (items.length === 0) {
    const raw = await fetchRSS(RSS_FEEDS.investing_fx, keywords, "Investing.com");
    items = filterNewsByKeywords(raw, keywords);
  }

  // Fallback 3 — Investing.com general news (strict keyword filter)
  if (items.length === 0) {
    const raw = await fetchRSS(RSS_FEEDS.investing_news, keywords, "Investing.com");
    items = filterNewsByKeywords(raw, keywords);
  }

  // Fallback 4 — Forex Factory economic calendar events
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

  // Fallback 1 — Investing.com crypto RSS
  if (items.length === 0) {
    items = await fetchRSS(RSS_FEEDS.investing_crypto, keywords, "Investing.com");
  }

  // Fallback 2 — Investing.com general news
  if (items.length === 0) {
    const raw = await fetchRSS(RSS_FEEDS.investing_news, keywords, "Investing.com");
    items = filterNewsByKeywords(raw, keywords);
  }

  cache.set(cacheKey, items);
  return items;
}

// ─── Metals — Kitco primary ───────────────────────────────────────────────────
async function fetchMetalsNews(symbol) {
  const cacheKey = `metals_${symbol}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  const keywords = getSymbolKeywords(symbol);

  // Primary — Investing.com commodities RSS
  let items = await fetchRSS(RSS_FEEDS.investing_comm, keywords, "Investing.com");

  // Fallback 1 — FXStreet (covers gold/metals)
  if (items.length === 0) {
    items = await fetchRSS(RSS_FEEDS.fxstreet, keywords, "FXStreet");
  }

  // Fallback 2 — MarketWatch
  if (items.length === 0) {
    items = await fetchRSS(RSS_FEEDS.marketwatch, keywords, "MarketWatch");
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
async function sendM5Alert(spikes, reportTime, symbolsLoaded, stage, settings) {
  if (!SLACK_WEBHOOK || !settings.slackEnabled) return;

  const isEscalation = stage === "M5_ESCALATION";
  const symbols = spikes.map(sp => sp.symbol.replace(".std","")).join(", ");
  const mention = isEscalation ? "<!channel>\n" : "";

  let lines = "";
  spikes.forEach(sp => {
    lines += `\n• *${sp.symbol.replace(".std","")}* [M5 LIVE]  *${sp.classif}*  ${sp.ratio}x ATR`;
    lines += `\n  Range: ${sp.range}  |  ATR14: ${sp.atr20}  |  @ ${sp.candleTime}`;
    lines += "\n";
  });

  const header = isEscalation
    ? ":rotating_light: *[Spike Checker MT5] M5 ESCALATION*"
    : ":warning: *[Spike Checker MT5] M5 Early Warning — Monitor Screen*";

  const action = isEscalation
    ? ":mega: *Action:* Check open positions on " + symbols + ". Consider widening spreads if applicable."
    : ":eyes: *Action:* Monitor screen closely. Check economic calendar for upcoming events.";

  const text =
    "🚧 *[TEST ONLY]*\n" +
    mention +
    "お疲れ様です。\n" +
    header + "\n\n" +
    "Report generated : " + reportTime + " (MT5 Server Time)\n" +
    "Symbols loaded   : " + symbolsLoaded + "\n\n" +
    action + "\n" +
    "\n*Developing Spikes (M5):*" + lines;

  try {
    await axios.post(SLACK_WEBHOOK, { text }, { timeout: 5000 });
    console.log("M5 " + stage + " Slack sent | " + symbols);
  } catch(e) {
    console.error("Slack M5 error:", e.message);
  }
}

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
    const symClean = sp.symbol.replace(".std","");
    detailLines += `\n• *${symClean}* [${tag}]  *${sp.classif}*  ${sp.ratio}x ATR`;
    detailLines += `\n  Range: ${sp.range}  |  ATR20: ${sp.atr20}  |  @ ${sp.candleTime}`;
    if (settings.newsEnabled && news.length > 0 && news[0].title && news[0].url && news[0].url !== "#") {
      detailLines += `\n  📰 ${news[0].title}`;
      detailLines += `\n  🔗 ${news[0].url}`;
    } else if (settings.newsEnabled) {
      detailLines += `\n  📰 No related news found`;
    }
    detailLines += "\n";
  }

  // Check if any spiking symbol is in the priority watchlist
  // Priority symbols → @channel mention
  // All other symbols → no mention (silent alert)
  const hasPriority = spikes.some(sp => {
    const sym = sp.symbol.replace(".std","").toUpperCase();
    return PRIORITY_SYMBOLS.includes(sym);
  });
  const mention = hasPriority ? "<!channel>\n" : "";

  const text =
    `🚧 *[TEST ONLY]*\n` +
    mention +
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

  const stage = req.body.stage || "H1";
  console.log(`[${new Date().toISOString()}] Stage: ${stage} | ${spikes.length} spike(s) from MT5`);

  // Fetch news only for H1 alerts (M5 warnings dont need news)
  const enriched = await Promise.all(
    spikes.map(async sp => {
      const news = stage === "H1" ? await fetchNews(sp.symbol) : [];
      return { ...sp, news };
    })
  );

  // Save to Vercel KV
  const currentLog = await getSpikeLog();
  enriched.forEach(sp => {
    currentLog.unshift({ ...sp, stage, receivedAt: new Date().toISOString() });
  });
  await saveSpikeLog(currentLog);

  // Route to stage-specific Slack alert
  const settings = await getSettings();
  if (stage === "M5_WARNING" || stage === "M5_ESCALATION") {
    await sendM5Alert(enriched, reportTime, symbolsLoaded, stage, settings);
  } else {
    await sendSlackAlert(enriched, reportTime, symbolsLoaded, settings);
  }

  res.json({ ok: true, stage, processed: enriched.length });
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