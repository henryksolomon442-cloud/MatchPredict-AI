const express = require("express");
const crypto = require("crypto");
const syncApiKey = process.env.SYNC_API_KEY || "";
const path = require("path");
const { DerivPublicFeed } = require("./derivPublic");
const { lastDigit, analyzeMarket } = require("./analyzer");
const { makeSignal, isFresh } = require("./signal");
const { PaperExecution } = require("./paperExecution");
const { DerivDemoExecutor } = require("./derivDemoExecution");

const app = express();
app.use(express.json({ limit: "16kb" }));
app.use(express.static(path.join(__dirname, "..", "public")));
const port = Number(process.env.PORT || 3000);
const appId = process.env.DERIV_APP_ID;
const symbols = (process.env.SYMBOLS || "1HZ10V,1HZ25V,1HZ50V,1HZ75V,1HZ100V").split(",").map(s => s.trim()).filter(Boolean);
const windowSize = Math.max(40, Number(process.env.WINDOW || 120));
const minSamples = Math.max(20, Number(process.env.MIN_SAMPLES || 40));
const ttlMs = Math.max(1000, Number(process.env.SIGNAL_TTL_MS || 5000));
const minConfidence = Number(process.env.MIN_CONFIDENCE || 0.55);
const demoTradingEnabled = process.env.DEMO_TRADING_ENABLED === "true";
const demoAutoExecute = process.env.DEMO_AUTO_EXECUTE === "true";
const demoMaxStake = Math.min(0.35, Math.max(0.01, Number(process.env.DEMO_MAX_STAKE || 0.35)));
const demoContractMode = process.env.DEMO_CONTRACT_MODE === "MATCH_DIGIT" ? "MATCH_DIGIT" : "EVEN_ODD";
const demoCooldownMs = Math.max(5000, Number(process.env.DEMO_COOLDOWN_MS || 10000));
const staleAfterMs = Math.max(3000, Number(process.env.STALE_AFTER_MS || 10000));
const markets = Object.fromEntries(symbols.map(symbol => [symbol, { ticks: [], latestQuote: null, latestEpoch: null, lastTickAt: null, tickCount: 0 }]));
let feedStatus = { connected: false, message: appId ? "Waiting for feed…" : "Set DERIV_APP_ID to connect." };
let latestSignal = null, signalCount = 0, startedAt = Date.now(), feed = null, lastTickAt = null;
const receivedSourceIds = new Set();
const demoHistory = [];
let lastDemoExecutionAt = 0;
let demoExecutor = null;
let lastDemoExecution = { status: "disabled", message: "Demo execution is not configured." };
if (demoTradingEnabled && process.env.DERIV_DEMO_TOKEN && appId) {
  demoExecutor = new DerivDemoExecutor({
    appId, token: process.env.DERIV_DEMO_TOKEN, maxStake: demoMaxStake,
    contractMode: demoContractMode, durationTicks: Math.max(1, Number(process.env.DEMO_DURATION_TICKS || 1))
  });
  demoExecutor.connect();
}
const paperExecution = new PaperExecution({
  maxStake: Number(process.env.PAPER_MAX_STAKE || 0.35),
  cooldownMs: Number(process.env.PAPER_COOLDOWN_MS || 1000)
});

function getRankedMarkets() {
  return symbols.map(symbol => {
    const state = markets[symbol];
    const tickAgeMs = state.lastTickAt === null ? null : Date.now() - state.lastTickAt;
    return { symbol, latestQuote: state.latestQuote, latestEpoch: state.latestEpoch,
      lastTickAt: state.lastTickAt, tickAgeMs, tickCount: state.tickCount,
      dataFresh: tickAgeMs !== null && tickAgeMs <= staleAfterMs,
      ...analyzeMarket(state.ticks, minSamples) };
  }).sort((a, b) => b.score - a.score);
}
function handleTick(tick) {
  const symbol = tick.symbol;
  if (!markets[symbol]) return;
  const digit = lastDigit(tick.quote);
  if (!Number.isInteger(digit)) return;
  const now = Date.now();
  const market = markets[symbol];
  market.latestQuote = String(tick.quote);
  market.latestEpoch = tick.epoch || Math.floor(now / 1000);
  market.lastTickAt = now;
  market.tickCount++;
  if (market.tickCount === 1 || market.tickCount % 100 === 0) console.log("Market tick received:", symbol, "count:", market.tickCount);
  lastTickAt = now;
  market.ticks.push({ digit, quote: String(tick.quote), epoch: market.latestEpoch });
  if (market.ticks.length > windowSize) market.ticks.splice(0, market.ticks.length - windowSize);
  const best = getRankedMarkets().find(m => m.ready && m.dataFresh);
  if (!best) return;
  const same = isFresh(latestSignal) && latestSignal.symbol === best.symbol &&
    latestSignal.matchDigit === best.topDigit && latestSignal.evenOdd === best.recentParity;
  if (!same && best.confidence >= minConfidence) {
    latestSignal = makeSignal(best.symbol, best, ttlMs);
    signalCount++;
  }
}
app.get("/api/status", (_req, res) => {
  const now = Date.now();
  const ageMs = lastTickAt === null ? null : now - lastTickAt;
  const liveTickSeen = ageMs !== null && ageMs <= staleAfterMs;
  const signalMarket = latestSignal ? markets[latestSignal.symbol] : null;
  const signalMarketFresh = Boolean(signalMarket && signalMarket.lastTickAt !== null && now - signalMarket.lastTickAt <= staleAfterMs);
  res.set("Cache-Control", "no-store");
  res.json({
    app: "MatchSync Engine", mode: demoTradingEnabled ? "DEMO_EXECUTION_CONFIGURED" : "PAPER_ONLY",
    tradingEnabled: Boolean(demoTradingEnabled && demoAutoExecute && demoExecutor && demoExecutor.ready),
    demoExecution: { enabled: demoTradingEnabled, autoExecute: demoAutoExecute, executorStatus: demoExecutor ? demoExecutor.status : "missing_demo_token_or_disabled", contractMode: demoContractMode, maxStake: demoMaxStake, cooldownMs: demoCooldownMs, lastResult: lastDemoExecution },
    uptimeSeconds: Math.floor((now - startedAt) / 1000),
    feedStatus: { ...feedStatus, liveTickSeen, lastTickAgeMs: ageMs, staleAfterMs }, signalCount,
    digitEdgeSync: { enabled: Boolean(syncApiKey), endpoint: "/api/ingest-signal", mode: demoTradingEnabled ? "DEMO_ONLY" : "PAPER_ONLY" },
    latestSignal: isFresh(latestSignal) && signalMarketFresh ? latestSignal : null,
    rankedMarkets: getRankedMarkets(),
    settings: { windowSize, minSamples, ttlMs, minConfidence, staleAfterMs, symbols }
  });
});
app.get("/api/signal", (_req, res) => {
  const market = latestSignal ? markets[latestSignal.symbol] : null;
  const freshMarket = Boolean(market && market.lastTickAt !== null && Date.now() - market.lastTickAt <= staleAfterMs);
  if (!isFresh(latestSignal) || !freshMarket)
    return res.status(404).json({ ok: false, message: "No fresh signal or live market tick available." });
  res.set("Cache-Control", "no-store");
  res.json({ ok: true, signal: latestSignal, execution: "DISABLED_PAPER_ONLY" });
});
app.post("/api/ingest-signal", async (req, res) => {
  // Server-side key required. This endpoint never places trades.
  if (!syncApiKey) return res.status(503).json({ ok: false, reason: "SYNC_DISABLED", message: "Configure SYNC_API_KEY on the server first." });
  const supplied = req.get("x-sync-key") || "";
  const a = Buffer.from(supplied);
  const b = Buffer.from(syncApiKey);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b))
    return res.status(401).json({ ok: false, reason: "UNAUTHORIZED" });

  const body = req.body || {};
  const symbol = typeof body.symbol === "string" ? body.symbol.trim() : "";
  const matchDigit = Number(body.matchDigit);
  const evenOdd = typeof body.evenOdd === "string" ? body.evenOdd.toUpperCase() : "";
  const generatedAt = Number(body.generatedAt);
  const sourceId = typeof body.sourceId === "string" ? body.sourceId.slice(0, 128) : "";
  const now = Date.now();

  if (!symbols.includes(symbol))
    return res.status(400).json({ ok: false, reason: "INVALID_SYMBOL", allowedSymbols: symbols });
  if (!Number.isInteger(matchDigit) || matchDigit < 0 || matchDigit > 9)
    return res.status(400).json({ ok: false, reason: "INVALID_MATCH_DIGIT" });
  if (!["EVEN", "ODD"].includes(evenOdd))
    return res.status(400).json({ ok: false, reason: "INVALID_EVEN_ODD" });
  if (!Number.isFinite(generatedAt) || generatedAt > now + 1000 || now - generatedAt > 10000)
    return res.status(409).json({ ok: false, reason: "STALE_OR_INVALID_TIMESTAMP", maxAgeMs: 10000 });
  if (sourceId && receivedSourceIds.has(sourceId))
    return res.status(409).json({ ok: false, reason: "DUPLICATE_SOURCE_ID" });

  const market = markets[symbol];
  if (market.lastTickAt === null || now - market.lastTickAt > staleAfterMs)
    return res.status(409).json({ ok: false, reason: "MARKET_TICK_STALE" });

  const confidence = Number(body.confidence);
  latestSignal = {
    id: crypto.randomUUID(), sourceId: sourceId || null, source: "DIGITEDGE_SYNC",
    symbol, volatility: symbol, matchDigit, evenOdd,
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : null,
    createdAt: now, receivedAt: now, sourceGeneratedAt: generatedAt,
    expiresAt: now + ttlMs, mode: demoTradingEnabled ? "DEMO_ONLY" : "PAPER_ONLY"
  };
  if (sourceId) {
    receivedSourceIds.add(sourceId);
    if (receivedSourceIds.size > 1000) receivedSourceIds.delete(receivedSourceIds.values().next().value);
  }
  signalCount++;
  if (demoAutoExecute && demoTradingEnabled) {
    if (!demoExecutor || !demoExecutor.ready) {
      lastDemoExecution = { status: "blocked", reason: "DEMO_EXECUTOR_NOT_READY", executorStatus: demoExecutor ? demoExecutor.status : "missing_demo_token" };
    } else if (now - lastDemoExecutionAt < demoCooldownMs) {
      lastDemoExecution = { status: "blocked", reason: "DEMO_COOLDOWN", retryAfterMs: demoCooldownMs - (now - lastDemoExecutionAt) };
    } else {
      lastDemoExecutionAt = now;
      try {
        const result = await demoExecutor.execute(latestSignal, Math.min(demoMaxStake, Number(body.stake || demoMaxStake)));
        lastDemoExecution = result;
        if (result.ok) {
          demoHistory.unshift(result);
          demoHistory.splice(100);
        }
      } catch (e) {
        lastDemoExecution = { ok: false, status: "execution_error", reason: e.message };
      }
    }
  }
  res.set("Cache-Control", "no-store");
  return res.status(202).json({ ok: true, accepted: true, signal: latestSignal,
    execution: lastDemoExecution, mode: demoTradingEnabled ? "DEMO_ONLY" : "PAPER_ONLY" });
});
app.get("/api/demo-history", (_req, res) => res.json({ mode: "DEMO_ONLY", history: demoHistory }));
app.get("/api/health", (_req, res) => res.json({ ok: true, mode: demoTradingEnabled ? "DEMO_ONLY" : "PAPER_ONLY" }));
app.post("/api/paper-execute", (req, res) => {
  const stake = req.body && req.body.stake !== undefined ? req.body.stake : 0.35;
  const market = latestSignal ? markets[latestSignal.symbol] : null;
  const marketFresh = Boolean(market && market.lastTickAt !== null && Date.now() - market.lastTickAt <= staleAfterMs);
  if (!marketFresh) return res.status(409).json({ ok: false, reason: "NO_FRESH_LIVE_TICK" });
  const result = paperExecution.execute(latestSignal, stake);
  res.status(result.ok ? 200 : 409).json(result);
});
app.get("/api/paper-history", (_req, res) => res.json({ mode: "PAPER_ONLY", history: paperExecution.getHistory() }));
app.post("/api/stop", (_req, res) => {
  if (feed) feed.close();
  if (demoExecutor) demoExecutor.close();
  feedStatus = { connected: false, message: "Feed stopped by user." };
  res.json({ ok: true, message: "Public feed stopped. No trades were placed." });
});
app.listen(port, () => {
  console.log("MatchSync Engine listening on port " + port);
  if (!appId || appId === "YOUR_APP_ID") {
    feedStatus = { connected: false, message: "Public feed can run without an app ID; set a registered DERIV_APP_ID to enable authenticated demo execution." };
  }
  feed = new DerivPublicFeed(appId, symbols, handleTick, status => { feedStatus = status; console.log("Deriv feed status:", status.message); });
  feed.connect();
});