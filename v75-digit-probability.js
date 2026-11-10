const express = require("express");
const WebSocket = require("ws");

const app = express();
const PORT = process.env.PORT || 10000;
const SYMBOL = "R_75";
const WS_URL = "wss://api.derivws.com/trading/v1/options/ws/public";
const WINDOW = 100;
const TEST_PREDICTIONS = 10000;
const HISTORY_REQUIRED = WINDOW + TEST_PREDICTIONS;
const PAGE_SIZE = 5000;

let ticks = [];
let historyLoaded = false;
let loading = true;
let loadError = null;
let lastMessageAt = null;
let liveConnected = false;
let liveSocket = null;
let liveResults = [];
let livePrediction = null;
let report = null;

function digitFromPrice(price, pipSize) {
  const places = Number.isInteger(Number(pipSize)) ? Math.max(0, Math.min(10, Number(pipSize))) : 2;
  const fixed = Number(price).toFixed(places);
  const match = fixed.match(/(\d)$/);
  if (!match) throw new Error("Cannot extract final digit from price " + price);
  return Number(match[1]);
}

function normalizeProb(p) {
  const sum = p.reduce((a, b) => a + b, 0);
  return p.map(x => x / (sum || 1));
}

function probabilities(windowDigits) {
  const n = windowDigits.length;
  const counts = Array(10).fill(0);
  for (const d of windowDigits) counts[d]++;
  const freq = normalizeProb(counts.map(c => c + 0.5));

  const weighted = Array(10).fill(0);
  let weightTotal = 0;
  for (let i = 0; i < n; i++) {
    const w = Math.pow(0.96, n - 1 - i);
    weighted[windowDigits[i]] += w;
    weightTotal += w;
  }
  const recency = normalizeProb(weighted.map(c => c + 0.5));

  const last = windowDigits[n - 1];
  const trans1 = Array(10).fill(0);
  let trans1Total = 0;
  for (let i = 0; i < n - 1; i++) {
    if (windowDigits[i] === last) {
      trans1[windowDigits[i + 1]]++;
      trans1Total++;
    }
  }
  const markov1 = normalizeProb(trans1.map(c => c + 5 * freq[c === -1 ? 0 : trans1.indexOf(c)]));
  // Rebuild the first-order posterior by digit index; shrink sparse contexts toward frequency.
  const m1 = normalizeProb(trans1.map((c, j) => c + 5 * freq[j]));

  const pairA = windowDigits[n - 2];
  const pairB = windowDigits[n - 1];
  const trans2 = Array(10).fill(0);
  let trans2Total = 0;
  for (let i = 0; i < n - 2; i++) {
    if (windowDigits[i] === pairA && windowDigits[i + 1] === pairB) {
      trans2[windowDigits[i + 2]]++;
      trans2Total++;
    }
  }
  const m2 = normalizeProb(trans2.map((c, j) => c + 3 * m1[j]));

  const blend = normalizeProb(freq.map((v, j) =>
    0.15 * v + 0.20 * recency[j] + 0.40 * m1[j] + 0.25 * m2[j]
  ));

  return {
    frequency: freq,
    recency: recency,
    markov1: m1,
    markov2: m2,
    ensemble: blend,
    context: { lastDigit: last, previousDigit: pairA, transitions1: trans1Total, transitions2: trans2Total }
  };
}

function argmax(p) {
  let best = 0;
  for (let i = 1; i < p.length; i++) if (p[i] > p[best]) best = i;
  return best;
}

function scoreModel(name, probabilitiesList, actualDigits) {
  let correct = 0;
  let logLoss = 0;
  let brier = 0;
  let confidence = 0;
  for (let i = 0; i < probabilitiesList.length; i++) {
    const p = probabilitiesList[i];
    const actual = actualDigits[i];
    if (argmax(p) === actual) correct++;
    const safe = Math.max(1e-12, Math.min(1, p[actual]));
    logLoss -= Math.log(safe);
    confidence += Math.max(...p);
    for (let j = 0; j < 10; j++) {
      const error = p[j] - (j === actual ? 1 : 0);
      brier += error * error;
    }
  }
  const n = actualDigits.length;
  const accuracy = correct / n;
  const z = (correct - n * 0.1) / Math.sqrt(n * 0.1 * 0.9);
  return {
    model: name,
    predictions: n,
    correct: correct,
    accuracy: accuracy,
    accuracyPercent: Number((accuracy * 100).toFixed(3)),
    baselinePercent: 10,
    liftVsUniformPercentPoints: Number(((accuracy - 0.1) * 100).toFixed(3)),
    approximateZVs10Percent: Number(z.toFixed(3)),
    meanLogLoss: Number((logLoss / n).toFixed(5)),
    meanMulticlassBrier: Number((brier / n).toFixed(5)),
    meanTopProbabilityPercent: Number((confidence / n * 100).toFixed(3))
  };
}

function runBacktest(historyTicks) {
  const digits = historyTicks.map(t => t.digit);
  const modelNames = ["frequency", "recency", "markov1", "markov2", "ensemble"];
  const probabilityLists = Object.fromEntries(modelNames.map(n => [n, []]));
  const actuals = [];
  for (let i = WINDOW; i < digits.length; i++) {
    const p = probabilities(digits.slice(i - WINDOW, i));
    for (const name of modelNames) probabilityLists[name].push(p[name]);
    actuals.push(digits[i]);
  }
  const metrics = modelNames.map(name => scoreModel(name, probabilityLists[name], actuals));
  const lastWindow = digits.slice(-WINDOW);
  const current = probabilities(lastWindow);
  return {
    symbol: SYMBOL,
    method: "walk-forward one-tick-ahead; each prediction uses only the preceding 100 digits",
    historyTicks: historyTicks.length,
    warmupTicks: WINDOW,
    predictions: actuals.length,
    expectedPredictions: TEST_PREDICTIONS,
    pipSize: historyTicks[historyTicks.length - 1].pipSize,
    metrics: metrics,
    latest: {
      latestObservedDigit: lastWindow[lastWindow.length - 1],
      candidateDigit: argmax(current.ensemble),
      candidateProbabilityPercent: Number((Math.max(...current.ensemble) * 100).toFixed(3)),
      probabilitiesPercent: current.ensemble.map(v => Number((v * 100).toFixed(3))),
      components: Object.fromEntries(modelNames.filter(n => n !== "ensemble").map(n => [
        n, { digit: argmax(current[n]), probabilityPercent: Number((Math.max(...current[n]) * 100).toFixed(3)) }
      ])),
      context: current.context
    },
    note: "Historical performance is not a guarantee. The 10,000 test outcomes are a holdout sequence; model weights were fixed before evaluation."
  };
}

function requestHistoryPage(count, end) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    const timer = setTimeout(() => {
      try { ws.close(); } catch (_) {}
      reject(new Error("History request timed out"));
    }, 25000);
    ws.on("open", () => ws.send(JSON.stringify({
      ticks_history: SYMBOL,
      count: count,
      end: String(end),
      start: 0,
      style: "ticks",
      req_id: 11
    })));
    ws.on("message", raw => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch (_) { return; }
      if (msg.error) {
        clearTimeout(timer);
        ws.close();
        reject(new Error(msg.error.message || "Deriv history error"));
        return;
      }
      if (msg.msg_type !== "history" || !msg.history) return;
      clearTimeout(timer);
      const prices = msg.history.prices || [];
      const times = msg.history.times || [];
      const pipSize = Number(msg.pip_size ?? 2);
      const rows = prices.map((price, i) => ({
        quote: Number(price),
        epoch: Number(times[i]),
        pipSize: pipSize,
        digit: digitFromPrice(price, pipSize)
      })).filter(x => Number.isFinite(x.epoch) && Number.isFinite(x.quote));
      ws.close();
      resolve(rows);
    });
    ws.on("error", err => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function loadHistory() {
  loading = true;
  loadError = null;
  try {
    const pages = [];
    let end = "latest";
    let total = 0;
    for (let page = 0; page < 6 && total < HISTORY_REQUIRED; page++) {
      const rows = await requestHistoryPage(Math.min(PAGE_SIZE, HISTORY_REQUIRED - total), end);
      if (!rows.length) break;
      pages.push(rows);
      total += rows.length;
      const oldest = Math.min(...rows.map(x => x.epoch));
      if (!Number.isFinite(oldest) || oldest <= 1) break;
      end = String(oldest - 1);
      if (rows.length < Math.min(PAGE_SIZE, HISTORY_REQUIRED - (total - rows.length))) break;
    }
    const combined = pages.flat().sort((a, b) => a.epoch - b.epoch);
    // Remove only exact adjacent page-boundary duplicates, preserving repeated prices at later times.
    const clean = [];
    for (const row of combined) {
      const prev = clean[clean.length - 1];
      if (prev && prev.epoch === row.epoch && prev.quote === row.quote) continue;
      clean.push(row);
    }
    if (clean.length < HISTORY_REQUIRED) {
      throw new Error("Deriv returned " + clean.length + " usable ticks; " + HISTORY_REQUIRED + " are required for 10,000 scored predictions plus 100 warm-up ticks.");
    }
    ticks = clean.slice(-HISTORY_REQUIRED);
    report = runBacktest(ticks);
    historyLoaded = true;
    loading = false;
    connectLive();
  } catch (err) {
    loadError = err.message;
    loading = false;
    console.error("[history]", err.message);
  }
}

function connectLive() {
  if (liveSocket && liveSocket.readyState <= WebSocket.OPEN) return;
  liveSocket = new WebSocket(WS_URL);
  liveSocket.on("open", () => {
    liveConnected = true;
    liveSocket.send(JSON.stringify({ ticks: SYMBOL, subscribe: 1, req_id: 22 }));
  });
  liveSocket.on("message", raw => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (_) { return; }
    if (msg.error) {
      console.error("[live]", msg.error.message);
      return;
    }
    if (msg.msg_type !== "tick" || !msg.tick) return;
    const t = msg.tick;
    const pipSize = Number(t.pip_size ?? (ticks[ticks.length - 1] && ticks[ticks.length - 1].pipSize) ?? 2);
    const quote = Number(t.quote);
    const epoch = Number(t.epoch);
    if (!Number.isFinite(quote) || !Number.isFinite(epoch)) return;
    const last = ticks[ticks.length - 1];
    if (last && epoch === last.epoch && quote === last.quote) return;
    const digit = digitFromPrice(t.quote, pipSize);
    const prior = ticks.slice(-WINDOW).map(x => x.digit);
    if (prior.length === WINDOW) {
      const p = probabilities(prior);
      const predicted = argmax(p.ensemble);
      livePrediction = { predictedDigit: predicted, probabilityPercent: Number((p.ensemble[predicted] * 100).toFixed(3)), issuedAt: Date.now() };
      liveResults.push({ predicted: predicted, actual: digit, correct: predicted === digit, at: epoch });
      if (liveResults.length > 10000) liveResults.shift();
    }
    ticks.push({ quote: quote, epoch: epoch, pipSize: pipSize, digit: digit });
    if (ticks.length > 20000) ticks.shift();
    lastMessageAt = Date.now();
  });
  liveSocket.on("close", () => {
    liveConnected = false;
    setTimeout(connectLive, 5000);
  });
  liveSocket.on("error", err => {
    liveConnected = false;
    console.error("[live socket]", err.message);
  });
}

app.get("/", (_req, res) => res.sendFile(__dirname + "/v75-digit-probability.html"));
app.get("/health", (_req, res) => res.json({ ok: historyLoaded, app: "V75 Next Digit Probability", symbol: SYMBOL, loading: loading, error: loadError }));
app.get("/api/status", (_req, res) => res.json({
  app: "V75 Next Digit Probability",
  symbol: SYMBOL,
  loading: loading,
  historyLoaded: historyLoaded,
  error: loadError,
  historicalTicks: ticks.length,
  backtest: report ? { predictions: report.predictions, expected: report.expectedPredictions, metrics: report.metrics } : null,
  liveConnected: liveConnected,
  lastMessageAt: lastMessageAt,
  livePredictions: liveResults.length,
  liveAccuracy: liveResults.length ? liveResults.filter(x => x.correct).length / liveResults.length : null,
  latestLivePrediction: livePrediction
}));
app.get("/api/report", (_req, res) => {
  if (!report) return res.status(503).json({ ready: false, loading: loading, error: loadError, requiredTicks: HISTORY_REQUIRED });
  res.json(report);
});
app.get("/api/predict", (_req, res) => {
  if (ticks.length < WINDOW) return res.status(503).json({ ready: false });
  const p = probabilities(ticks.slice(-WINDOW).map(x => x.digit));
  res.json({
    symbol: SYMBOL,
    window: WINDOW,
    latestObservedDigit: ticks[ticks.length - 1].digit,
    predictedDigit: argmax(p.ensemble),
    probabilityPercent: Number((Math.max(...p.ensemble) * 100).toFixed(3)),
    probabilitiesPercent: p.ensemble.map(v => Number((v * 100).toFixed(3))),
    context: p.context
  });
});

app.listen(PORT, () => {
  console.log("V75 Next Digit Probability listening on " + PORT);
  loadHistory();
});
