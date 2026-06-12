========================================
  SPIKE MONITOR — Local Deployment
  MT5 Spike Detection + News Dashboard
========================================

FILES INCLUDED
──────────────
  SpikeDetector_Multi_MT5.mq5   → MT5 Expert Advisor
  server.js                     → Node.js relay server
  package.json                  → Node.js dependencies
  .env.example                  → Config template (rename to .env)
  public/index.html             → Live dashboard


QUICK START (5 steps)
─────────────────────

STEP 1 — Install Node.js
  Download: https://nodejs.org  (LTS version)
  Install and restart your PC


STEP 2 — Set up the server
  Place this entire folder anywhere, e.g.:
    C:\spike-monitor\

  Rename .env.example to .env
  Open .env and fill in:
    SLACK_WEBHOOK = your Slack webhook URL
    NEWS_API_KEY  = your NewsAPI.org key
    AV_API_KEY    = your Alpha Vantage key


STEP 3 — Get your API keys (all free)
  Slack Webhook : https://api.slack.com/apps
                  Create App → Incoming Webhooks → Add to channel

  NewsAPI.org   : https://newsapi.org/register
                  (covers Metals, Indices, Futures)

  Alpha Vantage : https://www.alphavantage.co/support/#api-key
                  (covers Stocks)

  NOTE: Forex Factory and CoinGecko need NO key — free public feeds


STEP 4 — Start the server
  Open Command Prompt in your spike-monitor folder:

    npm install
    node server.js

  You should see:
    Spike Monitor server running on port 3000
    Dashboard: http://localhost:3000

  Open browser → http://localhost:3000
  Dashboard is live and waiting for spikes.


STEP 5 — Set up the MT5 EA
  1. Copy SpikeDetector_Multi_MT5.mq5
     to: C:\Users\<you>\AppData\Roaming\MetaQuotes\Terminal\<id>\MQL5\Experts\

  2. Open MetaEditor → compile (F7) → 0 errors expected

  3. In MT5:
     Tools → Options → Expert Advisors
     ✅ Allow Algo Trading
     ✅ Allow WebRequest for listed URL
     Add: http://localhost:3000

  4. Attach EA to any chart
     SpikeServerURL input = http://localhost:3000/spike  (already default)


HOW IT WORKS
────────────
  Every 5 minutes the EA scans 151 symbols on H1:
  - LIVE check  : forming candle range vs ATR(20) — alerts once per candle
  - CLOSED check: closed candle range vs ATR(20)  — alerts at candle close

  On spike detected:
  MT5 EA → POST JSON → server.js → fetch news → Slack + dashboard

  Spike Classifications:
    < 1.0×  →  Silent
    1.0-1.5× → Normal  (log only)
    1.6-2.0× → Elevated (log only)
    2.1-3.0× → MINOR SPIKE  ← alerts fire
    3.1×+    → MAJOR SPIKE  ← alerts fire


MOVING TO YOUR SERVER LATER
────────────────────────────
  When ready to deploy to your domain:
  1. Upload this folder to your server
  2. Set up Nginx using spike-monitor.nginx (request from your assistant)
  3. Change SpikeServerURL in EA inputs to: https://yourdomain.com/spike
  4. Whitelist your domain in MT5 WebRequest settings


SUPPORT / QUESTIONS
────────────────────
  Built with Claude — https://claude.ai
