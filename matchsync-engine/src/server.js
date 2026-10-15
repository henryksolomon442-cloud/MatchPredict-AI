const express = require("express");
const crypto = require("crypto");
const syncApiKey = process.env.SYNC_API_KEY || "";
const path = require("path");
const { DerivPublicFeed } = require("./derivPublic");
const { lastDigit, formatQuote, analyzeMarket } = require("./analyzer");
const { makeSignal, isFresh } = require("./signal");
const { PaperExecution } = require("./paperExecution");
const { DerivDemoExecutor } = require("./derivDemoExecution");
const { DerivAccountExecutor } = require("./derivAccountExecution");

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
const realTradingEnabled = process.env.REAL_TRADING_ENABLED === "true";
const demoAutoExecute = process.env.DEMO_AUTO_EXECUTE === "true";
const realAutoExecute = process.env.REAL_AUTO_EXECUTE === "true";
const demoMaxStake = Math.min(0.35, Math.max(0.01, Number(process.env.DEMO_MAX_STAKE || 0.35)));
const realMaxStake = Math.min(0.35, Math.max(0.01, Number(process.env.REAL_MAX_STAKE || 0.01)));
const demoContractMode = process.env.DEMO_CONTRACT_MODE === "EVEN_ODD" ? "EVEN_ODD" : "MATCH_DIGIT";
const realContractMode = process.env.REAL_CONTRACT_MODE === "EVEN_ODD" ? "EVEN_ODD" : "MATCH_DIGIT";
const demoCooldownMs = Math.max(10000, Number(process.env.DEMO_COOLDOWN_MS || 10000));
const realCooldownMs = Math.max(10000, Number(process.env.REAL_COOLDOWN_MS || 10000));
const demoMaxTradesPerDay = Math.max(1, Math.floor(Number(process.env.DEMO_MAX_TRADES_PER_DAY || 20)));
const realMaxTradesPerDay = Math.max(1, Math.floor(Number(process.env.REAL_MAX_TRADES_PER_DAY || 3)));
const demoMaxDailyStake = Math.max(demoMaxStake, Number(process.env.DEMO_MAX_DAILY_STAKE || 7));
const realMaxDailyStake = Math.max(realMaxStake, Number(process.env.REAL_MAX_DAILY_STAKE || 0.03));
const demoDaily = { date: new Date().toISOString().slice(0, 10), trades: 0, stake: 0 };
const realDaily = { date: new Date().toISOString().slice(0, 10), trades: 0, stake: 0 };
const staleAfterMs = Math.max(3000, Number(process.env.STALE_AFTER_MS || 10000));
const markets = Object.fromEntries(symbols.map(symbol => [symbol, { ticks: [], latestQuote: null, latestDisplayQuote: null, latestDisplayDigit: null, pipSize: null, precisionWarningLogged: false, latestEpoch: null, lastTickAt: null, tickCount: 0 }]));
let feedStatus = { connected: false, message: appId ? "Waiting for feed…" : "Set DERIV_APP_ID to connect." };
let latestSignal = null, signalCount = 0, startedAt = Date.now(), feed = null, lastTickAt = null;
const receivedSourceIds = new Set();
const demoHistory = [];
let lastDemoExecutionAt = 0;
let lastRealExecutionAt = 0;
let demoExecutor = null;
let realExecutor = null;
let lastRealExecution = { status: "disabled", reason: "REAL_EXECUTION_OPT_IN_REQUIRED" };
let realConnectInProgress = false;
let lastDemoExecution = demoTradingEnabled && process.env.DERIV_DEMO_TOKEN && appId
  ? { status: "connecting", message: "Checking the Deriv demo account; waiting for authenticated connection." }
  : { status: "disabled", reason: "DEMO_CONFIGURATION_INCOMPLETE", message: "Demo execution requires DEMO_TRADING_ENABLED=true, DERIV_DEMO_TOKEN, and DERIV_APP_ID." };
let demoConnectInProgress = false;
let syncRequestCount = 0;
let lastSyncRequestAt = null;
let lastSyncHttpStatus = null;
async function connectDemoExecutor() {
  if (!demoExecutor || demoExecutor.ready || demoConnectInProgress) return;
  demoConnectInProgress = true;
  try {
    await demoExecutor.connect();
    lastDemoExecution = {
      status: "ready",
      message: "Deriv demo executor is connected; waiting for a fresh DigitEdge signal.",
      executorStatus: demoExecutor.status
    };
    console.log("Deriv demo executor connected and ready.");
  } catch (error) {
    lastDemoExecution = {
      status: "authorization_error",
      reason: error.message,
      executorStatus: demoExecutor ? demoExecutor.status : "missing_demo_token"
    };
    console.error("Deriv demo executor connection failed:", error.message);
  } finally {
    demoConnectInProgress = false;
  }
}

if (demoTradingEnabled && process.env.DERIV_DEMO_TOKEN && appId) {
  demoExecutor = new DerivDemoExecutor({
    appId, token: process.env.DERIV_DEMO_TOKEN, maxStake: demoMaxStake,
    contractMode: demoContractMode, durationTicks: Math.max(1, Number(process.env.DEMO_DURATION_TICKS || 1))
  });
  connectDemoExecutor();
  // Reconnect after a dropped Deriv demo WebSocket; never enable live-account execution.
  const demoReconnectTimer = setInterval(() => {
    if (demoExecutor && !demoExecutor.ready) connectDemoExecutor();
  }, 5000);
  if (typeof demoReconnectTimer.unref === "function") demoReconnectTimer.unref();
}
if (realTradingEnabled && process.env.DERIV_REAL_TOKEN && appId) {
  realExecutor = new DerivAccountExecutor({ appId, token: process.env.DERIV_REAL_TOKEN, accountMode: "REAL", maxStake: realMaxStake, contractMode: realContractMode, durationTicks: Math.max(1, Number(process.env.REAL_DURATION_TICKS || 1)) });
  async function connectRealExecutor() {
    if (!realExecutor || realExecutor.ready || realConnectInProgress) return;
    realConnectInProgress = true;
    try { await realExecutor.connect(); lastRealExecution = { status: "ready", message: "Real account verified; waiting for a fresh signal.", executorStatus: realExecutor.status }; }
    catch (error) { lastRealExecution = { status: "authorization_error", reason: error.message, executorStatus: realExecutor ? realExecutor.status : "missing_real_token" }; console.error("Deriv real account connection failed:", error.message); }
    finally { realConnectInProgress = false; }
  }
  connectRealExecutor();
  const realReconnectTimer = setInterval(() => { if (realExecutor && !realExecutor.ready) connectRealExecutor(); }, 5000);
  if (typeof realReconnectTimer.unref === "function") realReconnectTimer.unref();
}
const paperExecution = new PaperExecution({
  maxStake: Number(process.env.PAPER_MAX_STAKE || 0.35),
  cooldownMs: Number(process.env.PAPER_COOLDOWN_MS || 1000)
});

function getRankedMarkets() {
  return symbols.map(symbol => {
    const state = markets[symbol];
    const tickAgeMs = state.lastTickAt === null ? null : Date.now() - state.lastTickAt;
    return { symbol, latestQuote: state.latestQuote, latestDisplayQuote: state.latestDisplayQuote,
      latestDisplayDigit: state.latestDisplayDigit, pipSize: state.pipSize, latestEpoch: state.latestEpoch,
      lastTickAt: state.lastTickAt, tickAgeMs, tickCount: state.tickCount,
      dataFresh: tickAgeMs !== null && tickAgeMs <= staleAfterMs,
      ...analyzeMarket(state.ticks, minSamples) };
  }).sort((a, b) => b.score - a.score);
}
function handleTick(tick) {
  const symbol = tick.symbol;
  if (!markets[symbol]) return;
  const pipSize = tick.pip_size ?? tick.pip ?? null;
  const precision = Number(pipSize);
  // Do not silently count a guessed digit if displayed precision is unknown.
  if (pipSize === null || pipSize === undefined || !Number.isInteger(precision) || precision < 0 || precision > 10) {
    if (!markets[symbol].precisionWarningLogged) {
      markets[symbol].precisionWarningLogged = true;
      console.warn("Waiting for Deriv display precision before counting digits:", symbol);
    }
    return;
  }
  const digit = lastDigit(tick.quote, precision);
  if (!Number.isInteger(digit)) return;
  const now = Date.now();
  const market = markets[symbol];
  market.pipSize = precision;
  market.latestQuote = String(tick.quote);
  market.latestDisplayQuote = formatQuote(tick.quote, precision);
  market.latestDisplayDigit = digit;
  market.latestEpoch = tick.epoch || Math.floor(now / 1000);
  market.lastTickAt = now;
  market.tickCount++;
  if (market.tickCount === 1 || market.tickCount % 100 === 0) {
    console.log("Market tick received:", symbol, "count:", market.tickCount,
      "displayQuote:", market.latestDisplayQuote, "lastDisplayDigit:", digit, "pipSize:", precision);
  }
  lastTickAt = now;
  market.ticks.push({ digit, quote: String(tick.quote), epoch: market.latestEpoch });
  if (market.ticks.length > windowSize) market.ticks.splice(0, market.ticks.length - windowSize);
  const best = getRankedMarkets().find(m => m.ready && m.dataFresh);
  if (!best) return;
  const bestParity = Number.isInteger(best.topDigit)
    ? (best.topDigit % 2 === 0 ? "EVEN" : "ODD") : null;
  const digitEdgeSignalActive = isFresh(latestSignal) && latestSignal.source === "DIGITEDGE_SYNC";
  const same = isFresh(latestSignal) && latestSignal.source === "MARKET_SCANNER" &&
    latestSignal.symbol === best.symbol && latestSignal.matchDigit === best.topDigit &&
    latestSignal.evenOdd === bestParity;
  // Never let the background scanner overwrite a fresh DigitEdge prediction.
  if (!digitEdgeSignalActive && !same && best.confidence >= minConfidence) {
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
    app: "MatchSync Engine", mode: (demoTradingEnabled ? "DEMO" : "PAPER") + (realTradingEnabled ? "+REAL_CONFIGURED" : ""),
    tradingEnabled: Boolean(demoTradingEnabled && demoAutoExecute && demoExecutor && demoExecutor.ready),
    demoExecution: { enabled: demoTradingEnabled, autoExecute: demoAutoExecute, executorStatus: demoExecutor ? demoExecutor.status : "missing_demo_token_or_disabled", contractMode: demoContractMode, maxStake: demoMaxStake, cooldownMs: demoCooldownMs, dailyRisk: { ...demoDaily, maxTrades: demoMaxTradesPerDay, maxStakeTotal: demoMaxDailyStake }, lastResult: lastDemoExecution },
    realExecution: { enabled: realTradingEnabled, autoExecute: realAutoExecute, executorStatus: realExecutor ? realExecutor.status : "missing_real_token_or_disabled", contractMode: realContractMode, maxStake: realMaxStake, cooldownMs: realCooldownMs, dailyRisk: { ...realDaily, maxTrades: realMaxTradesPerDay, maxStakeTotal: realMaxDailyStake }, lastResult: lastRealExecution },
    uptimeSeconds: Math.floor((now - startedAt) / 1000),
    feedStatus: { ...feedStatus, liveTickSeen, lastTickAgeMs: ageMs, staleAfterMs }, signalCount,
    digitEdgeSync: { enabled: Boolean(syncApiKey), endpoint: "/api/ingest-signal", mode: demoTradingEnabled ? "DEMO_ONLY" : "PAPER_ONLY", requests: syncRequestCount, lastRequestAt: lastSyncRequestAt, lastHttpStatus: lastSyncHttpStatus },
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
  res.json({ ok: true, signal: latestSignal, execution: "MARKET_SCANNER_ONLY_NO_EXECUTION" });
});
app.use("/api/ingest-signal", (req, res, next) => {
  const requestStartedAt = Date.now();
  res.on("finish", () => {
    syncRequestCount++;
    lastSyncRequestAt = new Date().toISOString();
    lastSyncHttpStatus = res.statusCode;
    console.log("[DigitEdgeSync] HTTP request", JSON.stringify({ method: req.method, status: res.statusCode, elapsedMs: Date.now() - requestStartedAt }));
  });
  next();
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
  console.log("[DigitEdgeSync] Authenticated payload fields", JSON.stringify({
    fields: Object.keys(body).slice(0, 24),
    symbolPresent: ["symbol", "market", "underlying_symbol", "volatilityIndex"].some(k => body[k] !== undefined),
    digitPresent: ["matchDigit", "predictionDigit", "digit", "prediction"].some(k => body[k] !== undefined),
    timestampPresent: ["generatedAt", "sourceGeneratedAt", "createdAt", "timestamp"].some(k => body[k] !== undefined),
    sourceIdPresent: ["sourceId", "signalId", "id"].some(k => body[k] !== undefined)
  }));
  // Accept DigitEdge prediction payloads without requiring it to reshape its signal.
  const rawSymbol = body.symbol ?? body.market ?? body.underlying_symbol ?? body.volatilityIndex;
  const symbol = typeof rawSymbol === "string" ? rawSymbol.trim() : "";
  const rawDigit = body.matchDigit ?? body.predictionDigit ?? body.digit ?? body.prediction;
  const matchDigit = Number(rawDigit);
  const rawEvenOdd = body.evenOdd ?? body.parity;
  const now = Date.now();
  const rawGeneratedAt = body.generatedAt ?? body.sourceGeneratedAt ?? body.createdAt ?? body.timestamp;
  let generatedAt = typeof rawGeneratedAt === "string" && !Number.isFinite(Number(rawGeneratedAt))
    ? Date.parse(rawGeneratedAt) : Number(rawGeneratedAt);
  // Accept Unix seconds as well as JavaScript milliseconds.
  if (Number.isFinite(generatedAt) && generatedAt > 0 && generatedAt < 1e12) generatedAt *= 1000;
  const normalizedEvenOdd = typeof rawEvenOdd === "string" ? rawEvenOdd.trim().toUpperCase() : "";
  // A supplied prediction digit is the single source of truth for parity in
  // both MATCH_DIGIT and EVEN_ODD modes. Use provided parity only if no digit exists.
  const evenOdd = Number.isInteger(matchDigit)
    ? (matchDigit % 2 === 0 ? "EVEN" : "ODD")
    : normalizedEvenOdd;
  const rawSourceId = body.sourceId ?? body.signalId ?? body.id;
  // DigitEdge versions that do not send an explicit ID remain compatible.
  // Derive a stable id from the prediction payload so retries are deduplicated.
  const sourceId = (typeof rawSourceId === "string" || typeof rawSourceId === "number")
    ? String(rawSourceId).slice(0, 128)
    : (Number.isFinite(generatedAt) && symbol && Number.isInteger(matchDigit)
      ? "derived-" + crypto.createHash("sha256")
        .update([symbol, matchDigit, generatedAt, evenOdd].join("|")).digest("hex").slice(0, 48)
      : "");

  const agreement = Number(body.agreement ?? body.modelAgreement ?? body.agreementCount);
  const signalLevel = Number(body.signalLevel);
  const qualifiesFour = agreement === 4;
  const qualifiesThree = agreement === 3 && Number.isFinite(signalLevel) && signalLevel >= 90;
  if (!qualifiesFour && !qualifiesThree)
    return res.status(422).json({
      ok: false,
      accepted: false,
      reason: "UNQUALIFIED_SIGNAL",
      message: "Only 4/4 agreement or 3/4 agreement with model level >= 90 may enter the execution pipeline.",
      agreement: Number.isFinite(agreement) ? agreement : null,
      signalLevel: Number.isFinite(signalLevel) ? signalLevel : null
    });

  if (!symbols.includes(symbol))
    return res.status(400).json({ ok: false, reason: "INVALID_SYMBOL", allowedSymbols: symbols });
  if (!Number.isInteger(matchDigit) || matchDigit < 0 || matchDigit > 9)
    return res.status(400).json({ ok: false, reason: "INVALID_MATCH_DIGIT" });
  if (demoContractMode === "EVEN_ODD" && !["EVEN", "ODD"].includes(evenOdd))
    return res.status(400).json({ ok: false, reason: "INVALID_EVEN_ODD" });
  if (!Number.isFinite(generatedAt) || generatedAt > now + 1000 || now - generatedAt > 10000)
    return res.status(409).json({ ok: false, reason: "STALE_OR_INVALID_TIMESTAMP", maxAgeMs: 10000 });
  if ((demoAutoExecute || realAutoExecute) && !sourceId)
    return res.status(400).json({ ok: false, reason: "SOURCE_ID_REQUIRED_FOR_AUTO_EXECUTION" });
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
    agreement,
    signalLevel: Number.isFinite(signalLevel) ? Math.max(0, Math.min(100, signalLevel)) : null,
    signalReason: typeof body.signalReason === "string" ? body.signalReason.slice(0, 80) : null,
    createdAt: now, receivedAt: now, sourceGeneratedAt: generatedAt,
    expiresAt: now + ttlMs, mode: demoTradingEnabled ? "DEMO_ONLY" : "PAPER_ONLY"
  };
  if (sourceId) {
    receivedSourceIds.add(sourceId);
    if (receivedSourceIds.size > 1000) receivedSourceIds.delete(receivedSourceIds.values().next().value);
  }
  signalCount++;
  console.log("[DigitEdgeSync] Signal accepted", JSON.stringify({ symbol, matchDigit, ageMs: now - generatedAt, mode: demoTradingEnabled ? "DEMO_ONLY" : "PAPER_ONLY" }));
  if (demoAutoExecute && demoTradingEnabled) {
    const utcDate = new Date().toISOString().slice(0, 10);
    if (demoDaily.date !== utcDate) { demoDaily.date = utcDate; demoDaily.trades = 0; demoDaily.stake = 0; }
    const requestedStake = body.stake !== undefined ? Number(body.stake) : demoMaxStake;
    if (demoDaily.trades >= demoMaxTradesPerDay) {
      lastDemoExecution = { status: "blocked", reason: "DAILY_TRADE_LIMIT", maxTrades: demoMaxTradesPerDay };
    } else if (!Number.isFinite(requestedStake) || requestedStake <= 0 || requestedStake > demoMaxStake) {
      lastDemoExecution = { status: "blocked", reason: "INVALID_STAKE", maxStake: demoMaxStake };
    } else if (demoDaily.stake + requestedStake > demoMaxDailyStake) {
      lastDemoExecution = { status: "blocked", reason: "DAILY_STAKE_LIMIT", remainingStake: Math.max(0, demoMaxDailyStake - demoDaily.stake) };
    } else if (!demoExecutor || !demoExecutor.ready) {
      lastDemoExecution = { status: "blocked", reason: "DEMO_EXECUTOR_NOT_READY", executorStatus: demoExecutor ? demoExecutor.status : "missing_demo_token" };
    } else if (now - lastDemoExecutionAt < demoCooldownMs) {
      lastDemoExecution = { status: "blocked", reason: "DEMO_COOLDOWN", retryAfterMs: demoCooldownMs - (now - lastDemoExecutionAt) };
    } else {
      lastDemoExecutionAt = now;
      try {
        const result = await demoExecutor.execute(latestSignal, requestedStake);
        lastDemoExecution = result;
        if (result.ok) {
          demoDaily.trades++;
          demoDaily.stake = Number((demoDaily.stake + result.stake).toFixed(2));
          demoHistory.unshift(result);
          demoHistory.splice(100);
        }
      } catch (e) {
        lastDemoExecution = { ok: false, status: "execution_error", reason: e.message };
      }
    }
  }
  if (realAutoExecute && realTradingEnabled) {
    const utcDate = new Date().toISOString().slice(0, 10);
    if (realDaily.date !== utcDate) { realDaily.date = utcDate; realDaily.trades = 0; realDaily.stake = 0; }
    const requestedStake = body.realStake !== undefined ? Number(body.realStake) : realMaxStake;
    if (realDaily.trades >= realMaxTradesPerDay) lastRealExecution = { status: "blocked", reason: "DAILY_TRADE_LIMIT", maxTrades: realMaxTradesPerDay };
    else if (!Number.isFinite(requestedStake) || requestedStake <= 0 || requestedStake > realMaxStake) lastRealExecution = { status: "blocked", reason: "INVALID_STAKE", maxStake: realMaxStake };
    else if (realDaily.stake + requestedStake > realMaxDailyStake) lastRealExecution = { status: "blocked", reason: "DAILY_STAKE_LIMIT", remainingStake: Math.max(0, realMaxDailyStake - realDaily.stake) };
    else if (!realExecutor || !realExecutor.ready || realExecutor.isVirtual) lastRealExecution = { status: "blocked", reason: "REAL_EXECUTOR_NOT_READY", executorStatus: realExecutor ? realExecutor.status : "missing_real_token" };
    else if (now - lastRealExecutionAt < realCooldownMs) lastRealExecution = { status: "blocked", reason: "REAL_COOLDOWN", retryAfterMs: realCooldownMs - (now - lastRealExecutionAt) };
    else { lastRealExecutionAt = now; try { const result = await realExecutor.execute(latestSignal, requestedStake); lastRealExecution = result; if (result.ok) { realDaily.trades++; realDaily.stake = Number((realDaily.stake + result.stake).toFixed(2)); } } catch (e) { lastRealExecution = { ok: false, status: "execution_error", reason: e.message }; } }
  }
  console.log("[DigitEdgeSync] Execution outcome", JSON.stringify({ demo: { status: lastDemoExecution && lastDemoExecution.status, reason: lastDemoExecution && lastDemoExecution.reason, contractId: lastDemoExecution && lastDemoExecution.contractId }, real: { status: lastRealExecution && lastRealExecution.status, reason: lastRealExecution && lastRealExecution.reason, contractId: lastRealExecution && lastRealExecution.contractId } }));
  res.set("Cache-Control", "no-store");
  return res.status(202).json({ ok: true, accepted: true, signal: latestSignal,
    execution: { demo: lastDemoExecution, real: lastRealExecution }, mode: (demoTradingEnabled ? "DEMO" : "PAPER") + (realTradingEnabled ? "+REAL" : "") });
});
app.get("/api/demo-history", (_req, res) => res.json({ mode: "DEMO", history: demoHistory }));
app.get("/api/real-status", (_req, res) => res.json({ mode: "REAL", enabled: realTradingEnabled, autoExecute: realAutoExecute, executorStatus: realExecutor ? realExecutor.status : "missing_real_token_or_disabled", lastResult: lastRealExecution, dailyRisk: { ...realDaily, maxTrades: realMaxTradesPerDay, maxStakeTotal: realMaxDailyStake } }));
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
app.post("/api/stop", (req, res) => {
  if (!syncApiKey) return res.status(503).json({ ok: false, reason: "ADMIN_KEY_NOT_CONFIGURED" });
  const supplied = req.get("x-sync-key") || "";
  const a = Buffer.from(supplied);
  const b = Buffer.from(syncApiKey);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b))
    return res.status(401).json({ ok: false, reason: "UNAUTHORIZED" });
  if (feed) feed.close();
  if (demoExecutor) demoExecutor.close();
  if (realExecutor) realExecutor.close();
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