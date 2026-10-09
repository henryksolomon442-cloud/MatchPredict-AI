const express = require("express");
const path = require("path");
const { DerivPublicFeed } = require("./derivPublic");
const { lastDigit, analyzeMarket } = require("./analyzer");
const { makeSignal, isFresh } = require("./signal");
const { PaperExecution } = require("./paperExecution");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));
const port = Number(process.env.PORT || 3000);
const appId = process.env.DERIV_APP_ID;
const symbols = (process.env.SYMBOLS || "1HZ10V,1HZ25V,1HZ50V,1HZ75V,1HZ100V").split(",").map(s => s.trim()).filter(Boolean);
const windowSize = Math.max(40, Number(process.env.WINDOW || 120));
const minSamples = Math.max(20, Number(process.env.MIN_SAMPLES || 40));
const ttlMs = Math.max(1000, Number(process.env.SIGNAL_TTL_MS || 5000));
const minConfidence = Number(process.env.MIN_CONFIDENCE || 0.65);
const markets = Object.fromEntries(symbols.map(symbol => [symbol, { ticks: [], latestQuote: null, latestEpoch: null }]));
let feedStatus = { connected: false, message: appId ? "Waiting for feed…" : "Set DERIV_APP_ID to connect." };
let latestSignal = null, signalCount = 0, startedAt = Date.now(), feed = null;
const paperExecution = new PaperExecution({
  maxStake: Number(process.env.PAPER_MAX_STAKE || 0.35),
  cooldownMs: Number(process.env.PAPER_COOLDOWN_MS || 1000)
});

function getRankedMarkets() {
  return symbols.map(symbol => {
    const state = markets[symbol];
    return { symbol, latestQuote: state.latestQuote, latestEpoch: state.latestEpoch,
      ...analyzeMarket(state.ticks, minSamples) };
  }).sort((a, b) => b.score - a.score);
}
function handleTick(tick) {
  const symbol = tick.symbol;
  if (!markets[symbol]) return;
  const digit = lastDigit(tick.quote);
  if (!Number.isInteger(digit)) return;
  const market = markets[symbol];
  market.latestQuote = String(tick.quote);
  market.latestEpoch = tick.epoch || Math.floor(Date.now() / 1000);
  market.ticks.push({ digit, quote: String(tick.quote), epoch: market.latestEpoch });
  if (market.ticks.length > windowSize) market.ticks.splice(0, market.ticks.length - windowSize);
  const best = getRankedMarkets().find(m => m.ready);
  if (!best) return;
  const same = latestSignal && latestSignal.symbol === best.symbol &&
    latestSignal.matchDigit === best.topDigit && latestSignal.evenOdd === best.recentParity;
  if (!same && best.confidence >= minConfidence) {
    latestSignal = makeSignal(best.symbol, best, ttlMs);
    signalCount++;
  }
}
app.get("/api/status", (_req, res) => res.json({
  app: "MatchSync Engine", mode: "PAPER_ONLY", tradingEnabled: false,
  uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000), feedStatus, signalCount,
  latestSignal: isFresh(latestSignal) ? latestSignal : null, rankedMarkets: getRankedMarkets(),
  settings: { windowSize, minSamples, ttlMs, minConfidence, symbols }
}));
app.get("/api/signal", (_req, res) => {
  if (!isFresh(latestSignal)) return res.status(404).json({ ok: false, message: "No fresh signal available." });
  res.json({ ok: true, signal: latestSignal, execution: "DISABLED_PAPER_ONLY" });
});
app.get("/api/health", (_req, res) => res.json({ ok: true, mode: "PAPER_ONLY" }));
app.post("/api/paper-execute", (req, res) => {
  const stake = req.body && req.body.stake !== undefined ? req.body.stake : 0.35;
  const result = paperExecution.execute(latestSignal, stake);
  res.status(result.ok ? 200 : 409).json(result);
});
app.get("/api/paper-history", (_req, res) => res.json({ mode: "PAPER_ONLY", history: paperExecution.getHistory() }));
app.post("/api/stop", (_req, res) => {
  if (feed) feed.close();
  feedStatus = { connected: false, message: "Feed stopped by user." };
  res.json({ ok: true, message: "Public feed stopped. No trades were placed." });
});
app.listen(port, () => {
  console.log("MatchSync Engine listening on port " + port);
  if (!appId || appId === "YOUR_APP_ID") {
    feedStatus = { connected: false, message: "Set DERIV_APP_ID in environment to start market feed." };
    return;
  }
  feed = new DerivPublicFeed(appId, symbols, handleTick, status => { feedStatus = status; });
  feed.connect();
});