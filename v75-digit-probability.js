const express = require("express");
const WebSocket = require("ws");

const app = express();
const PORT = process.env.PORT || 10000;
const SYMBOL = "R_75";
const WS_URL = "wss://api.derivws.com/trading/v1/options/ws/public";
const WINDOW = 100;
const TEST_PREDICTIONS = 10000;
const HISTORY_REQUIRED = WINDOW + TEST_PREDICTIONS;
const PAGE_SIZE = 1000;

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
let latestTick = null;
let liveTickLogCount = 0;
let historyRetryCount = 0;
let lastHistoryRetryAt = null;
let liveTickCount = 0;
let liveReconnectCount = 0;
const liveModelStats = Object.create(null);

function digitFromPrice(price, pipSize) {
  const places = Number(pipSize);
  if (!Number.isInteger(places) || places < 0 || places > 10) {
    throw new Error("Missing or invalid Deriv pip_size; refusing to guess the final digit.");
  }
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
  // Hierarchical Bayesian backoff: sparse two-digit contexts shrink toward first-order transitions.
  const hierarchical = normalizeProb(trans2.map((c, j) => c + 10 * m1[j]));

  const blend = normalizeProb(freq.map((v, j) =>
    0.15 * v + 0.20 * recency[j] + 0.40 * m1[j] + 0.25 * m2[j]
  ));

  return {
    frequency: freq,
    recency: recency,
    markov1: m1,
    markov2: m2,
    hierarchical: hierarchical,
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

function gammaQ(a, x) {
  if (!(a > 0) || x < 0) return NaN;
  if (x === 0) return 1;
  const gln = logGamma(a);
  if (x < a + 1) {
    let ap = a, sum = 1 / a, del = sum;
    for (let n = 1; n <= 300; n++) { ap++; del *= x / ap; sum += del; if (Math.abs(del) < Math.abs(sum) * 1e-14) break; }
    const p = sum * Math.exp(-x + a * Math.log(x) - gln);
    return Math.max(0, Math.min(1, 1 - p));
  }
  let b = x + 1 - a, c = 1e300, d = 1 / b, h = d;
  for (let i = 1; i <= 300; i++) {
    const an = -i * (i - a); b += 2; d = an * d + b;
    if (Math.abs(d) < 1e-300) d = 1e-300;
    c = b + an / c; if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d; const delta = d * c; h *= delta;
    if (Math.abs(delta - 1) < 1e-14) break;
  }
  return Math.max(0, Math.min(1, Math.exp(-x + a * Math.log(x) - gln) * h));
}
function logGamma(z) {
  const p = [676.5203681218851,-1259.1392167224028,771.32342877765313,-176.61502916214059,12.507343278686905,-0.13857109526572012,9.9843695780195716e-6,1.5056327351493116e-7];
  if (z < 0.5) return Math.log(Math.PI) - Math.log(Math.sin(Math.PI*z)) - logGamma(1-z);
  z -= 1; let x = 0.99999999999980993;
  for (let i=0;i<p.length;i++) x += p[i]/(z+i+1);
  const t=z+p.length-0.5;
  return 0.5*Math.log(2*Math.PI)+(z+0.5)*Math.log(t)-t+Math.log(x);
}
function sequenceDiagnostics(digits) {
  const counts=Array(10).fill(0), transitions=Array.from({length:10},()=>Array(10).fill(0));
  for(let i=0;i<digits.length;i++){counts[digits[i]]++; if(i) transitions[digits[i-1]][digits[i]]++;}
  const n=digits.length, expected=n/10;
  const frequencyChi=counts.reduce((v,c)=>v+(c-expected)**2/expected,0);
  const rows=transitions.map(r=>r.reduce((a,b)=>a+b,0));
  const cols=Array(10).fill(0); for(let i=0;i<10;i++)for(let j=0;j<10;j++)cols[j]+=transitions[i][j];
  let transitionChi=0, transitionCells=0;
  const total=n-1;
  for(let i=0;i<10;i++)for(let j=0;j<10;j++){
    const e=rows[i]*cols[j]/total;
    if(e>0){transitionChi+=(transitions[i][j]-e)**2/e;transitionCells++;}
  }
  const even=digits.filter(d=>d%2===0).length, odd=n-even;
  let runs=0; for(let i=0;i<n;i++)if(i===0||((digits[i]%2)!==(digits[i-1]%2)))runs++;
  const runsMean=1+2*even*odd/n;
  const runsVar=(2*even*odd*(2*even*odd-n))/(n*n*(n-1));
  const runsZ=runsVar>0?(runs-runsMean)/Math.sqrt(runsVar):0;
  return {
    ticks:n, digitCounts:counts,
    frequencyChiSquare:Number(frequencyChi.toFixed(3)),
    frequencyPValue:Number(gammaQ(4.5,frequencyChi/2).toPrecision(5)),
    transitionIndependenceChiSquare:Number(transitionChi.toFixed(3)),
    transitionDegreesOfFreedom:81,
    transitionPValue:Number(gammaQ(40.5,transitionChi/2).toPrecision(5)),
    parityRuns:{runs,expected:Number(runsMean.toFixed(2)),z:Number(runsZ.toFixed(3))}
  };
}
function scoreBarrierStrategies(digits) {
  const actuals=digits.slice(WINDOW);
  const rules=[
    ["UNDER_8",d=>d<8],["OVER_1",d=>d>1],
    ["UNDER_7",d=>d<7],["OVER_2",d=>d>2],
    ["UNDER_6",d=>d<6],["OVER_3",d=>d>3]
  ];
  const results=rules.map(([name,fn])=>{const wins=actuals.filter(fn).length;return {strategy:name,wins,total:actuals.length,winRatePercent:Number((wins/actuals.length*100).toFixed(3))};});
  let differsWins=0;
  for(let i=WINDOW;i<digits.length;i++){
    const counts=Array(10).fill(0);
    for(const d of digits.slice(i-WINDOW,i))counts[d]++;
    let excluded=0;for(let d=1;d<10;d++)if(counts[d]<counts[excluded])excluded=d;
    if(digits[i]!==excluded)differsWins++;
  }
  results.push({strategy:"DIFFERS (exclude least-frequent recent digit)",wins:differsWins,total:actuals.length,winRatePercent:Number((differsWins/actuals.length*100).toFixed(3))});
  return results;
}

function regimeFeatures(windowDigits, p) {
  const counts=Array(10).fill(0);
  for(const d of windowDigits)counts[d]++;
  const n=windowDigits.length;
  const entropy=-counts.reduce((sum,c)=>{if(!c)return sum;const q=c/n;return sum+q*Math.log(q);},0);
  let streak=1;for(let i=n-2;i>=0&&windowDigits[i]===windowDigits[n-1];i--)streak++;
  return {
    entropy,
    topFrequency:Math.max(...counts)/n,
    lastDigitStreak:streak,
    lastDigitTransitionSupport:p.context.transitions1,
    topModelProbability:Math.max(...p.ensemble),
    modelAgreement:["frequency","recency","markov1","markov2","hierarchical"].filter(k=>argmax(p[k])===argmax(p.ensemble)).length
  };
}
function wilsonInterval(wins,n) {
  if(!n)return null;
  const z=1.96, phat=wins/n, den=1+z*z/n;
  const mid=(phat+z*z/(2*n))/den;
  const half=z*Math.sqrt(phat*(1-phat)/n+z*z/(4*n*n))/den;
  return [Number((100*(mid-half)).toFixed(2)),Number((100*(mid+half)).toFixed(2))];
}
function regimeBacktest(historyTicks) {
  const digits=historyTicks.map(t=>t.digit), groups={};
  const add=(key,hit,prob)=>{const g=groups[key]||(groups[key]={n:0,wins:0,logLoss:0,topProb:0});g.n++;if(hit)g.wins++;g.logLoss-=Math.log(Math.max(1e-12,prob));g.topProb+=prob;};
  for(let i=WINDOW;i<digits.length;i++){
    const w=digits.slice(i-WINDOW,i), p=probabilities(w), actual=digits[i], feat=regimeFeatures(w,p);
    const candidate=argmax(p.ensemble), hit=candidate===actual;
    const confidence=feat.topModelProbability;
    const confidenceBand=confidence<0.12?"confidence <12%":confidence<0.15?"confidence 12–15%":"confidence >=15%";
    const entropyBand=feat.entropy<2.20?"low entropy <2.20":"high entropy >=2.20";
    const streakBand=feat.lastDigitStreak>=2?"same-digit streak >=2":"no repeat streak";
    const supportBand=feat.lastDigitTransitionSupport<5?"transition support <5":"transition support >=5";
    const agreementBand=feat.modelAgreement>=4?"model agreement >=4/5":"model agreement <4/5";
    for(const [name,key] of [["confidence",confidenceBand],["entropy",entropyBand],["streak",streakBand],["transition support",supportBand],["model agreement",agreementBand]])add(name+" | "+key,hit,p.ensemble[actual]);
  }
  return Object.entries(groups).map(([condition,g])=>({
    condition,n:g.n,wins:g.wins,hitRatePercent:Number((100*g.wins/g.n).toFixed(3)),
    hitRate95CI:wilsonInterval(g.wins,g.n),
    meanLogLoss:Number((g.logLoss/g.n).toFixed(5)),
    meanTopProbabilityPercent:Number((100*g.topProb/g.n).toFixed(3)),
    randomBaselinePercent:10
  }));
}

function runBacktest(historyTicks) {
  const digits = historyTicks.map(t => t.digit);
  const modelNames = ["frequency", "recency", "markov1", "markov2", "hierarchical", "ensemble", "uniform"];
  const probabilityLists = Object.fromEntries(modelNames.map(n => [n, []]));
  const uniform = Array(10).fill(0.1);
  const actuals = [];
  for (let i = WINDOW; i < digits.length; i++) {
    const p = probabilities(digits.slice(i - WINDOW, i));
    for (const name of modelNames) probabilityLists[name].push(name === "uniform" ? uniform : p[name]);
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
    diagnostics: sequenceDiagnostics(digits),
    regimes: regimeBacktest(historyTicks),
    barrierStrategies: scoreBarrierStrategies(digits),
    latest: {
      latestObservedDigit: lastWindow[lastWindow.length - 1],
      candidateDigit: argmax(current.ensemble),
      candidateProbabilityPercent: Number((Math.max(...current.ensemble) * 100).toFixed(3)),
      probabilitiesPercent: current.ensemble.map(v => Number((v * 100).toFixed(3))),
      components: Object.fromEntries(modelNames.filter(n => n !== "ensemble" && n !== "uniform").map(n => [
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
      const pipSize = Number(msg.pip_size);
      if (!Number.isInteger(pipSize) || pipSize < 0 || pipSize > 10) {
        clearTimeout(timer);
        ws.close();
        reject(new Error("Deriv history response did not provide a valid pip_size; refusing to guess digits."));
        return;
      }
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
    for (let page = 0; page < 15 && total < HISTORY_REQUIRED; page++) {
      const requested = Math.min(PAGE_SIZE, HISTORY_REQUIRED - total);
      console.log("[history] requesting page " + (page + 1) + ", count=" + requested + ", end=" + end);
      const rows = await requestHistoryPage(requested, end);
      console.log("[history] page " + (page + 1) + " returned " + rows.length + " ticks");
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
    console.log("[history] backtest complete: " + report.predictions + " predictions from " + report.historyTicks + " ticks");
    console.log("[history] model metrics: " + JSON.stringify(report.metrics));
    console.log("[history] sequence diagnostics: " + JSON.stringify(report.diagnostics));
    console.log("[history] conditional regime results: " + JSON.stringify(report.regimes));
    console.log("[history] barrier strategy results: " + JSON.stringify(report.barrierStrategies));
    historyLoaded = true;
    loading = false;
    historyRetryCount = 0;
    connectLive();
  } catch (err) {
    loadError = err.message;
    console.error("[history] load failed: " + err.message);
    loading = false;
    const transient = /429|Unexpected server response|timed out|ECONNRESET|ETIMEDOUT|socket hang up/i.test(err.message);
    if (transient) {
      const delay = Math.min(60000, 5000 * Math.pow(2, historyRetryCount));
      historyRetryCount++;
      lastHistoryRetryAt = Date.now();
      console.warn("[history] transient failure; retry " + historyRetryCount + " scheduled in " + delay + "ms");
      setTimeout(() => { if (!historyLoaded) loadHistory(); }, delay);
    }
  }
}

function connectLive() {
  if (liveSocket && liveSocket.readyState <= WebSocket.OPEN) return;
  liveSocket = new WebSocket(WS_URL);
  liveSocket.on("open", () => {
    liveConnected = true;
    liveReconnectCount++;
    console.log("[live] WebSocket connected; subscribing to " + SYMBOL + " (connection " + liveReconnectCount + ")");
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
    const pipSize = Number(t.pip_size);
    if (!Number.isInteger(pipSize) || pipSize < 0 || pipSize > 10) {
      console.error("[live] missing or invalid tick.pip_size; refusing to extract a digit");
      return;
    }
    const quote = Number(t.quote);
    const epoch = Number(t.epoch);
    if (!Number.isFinite(quote) || !Number.isFinite(epoch)) return;
    const last = ticks[ticks.length - 1];
    if (last && epoch === last.epoch && quote === last.quote) return;
    const digit = digitFromPrice(t.quote, pipSize);
    latestTick = { quote: quote, formattedQuote: quote.toFixed(pipSize), pipSize: pipSize, digit: digit, epoch: epoch };
    if (liveTickLogCount < 10) {
      console.log("[live] verified tick quote=" + latestTick.formattedQuote + " pip_size=" + pipSize + " extracted_digit=" + digit + " epoch=" + epoch);
      liveTickLogCount++;
    }
    const prior = ticks.slice(-WINDOW).map(x => x.digit);
    if (prior.length === WINDOW) {
      const p = probabilities(prior);
      const forecasts = {frequency:p.frequency,recency:p.recency,markov1:p.markov1,markov2:p.markov2,hierarchical:p.hierarchical,ensemble:p.ensemble,uniform:Array(10).fill(0.1)};
      for (const [name, forecast] of Object.entries(forecasts)) {
        const predicted = argmax(forecast);
        const state = liveModelStats[name] || (liveModelStats[name]={n:0,correct:0,logLoss:0,brier:0});
        state.n++; if(predicted===digit)state.correct++;
        state.logLoss -= Math.log(Math.max(1e-12,forecast[digit]));
        for(let j=0;j<10;j++){const e=forecast[j]-(j===digit?1:0);state.brier+=e*e;}
      }
      const predicted = argmax(p.ensemble);
      livePrediction = { predictedDigit: predicted, probabilityPercent: Number((p.ensemble[predicted] * 100).toFixed(3)), issuedAt: Date.now() };
      liveResults.push({ predicted: predicted, actual: digit, correct: predicted === digit, at: epoch });
      if (liveResults.length > 10000) liveResults.shift();
    }
    liveTickCount++;
    ticks.push({ quote: quote, epoch: epoch, pipSize: pipSize, digit: digit });
    if (ticks.length > 20000) ticks.shift();
    lastMessageAt = Date.now();
  });
  liveSocket.on("close", (code, reason) => {
    liveConnected = false;
    console.warn("[live] WebSocket closed code=" + code + " reason=" + String(reason || "") + "; reconnecting in 5 seconds");
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
  historyRetryCount: historyRetryCount,
  lastHistoryRetryAt: lastHistoryRetryAt,
  historicalTicks: ticks.length,
  backtest: report ? { predictions: report.predictions, expected: report.expectedPredictions, metrics: report.metrics, diagnostics: report.diagnostics, regimes: report.regimes, barrierStrategies: report.barrierStrategies } : null,
  liveConnected: liveConnected,
  lastMessageAt: lastMessageAt,
  livePredictions: liveResults.length,
  liveTickCount: liveTickCount,
  liveReconnectCount: liveReconnectCount,
  liveModelStats: Object.fromEntries(Object.entries(liveModelStats).map(([name,v])=>[name,{predictions:v.n,accuracyPercent:Number((v.correct/v.n*100).toFixed(3)),meanLogLoss:Number((v.logLoss/v.n).toFixed(5)),meanBrier:Number((v.brier/v.n).toFixed(5))}])),
  liveAccuracy: liveResults.length ? liveResults.filter(x => x.correct).length / liveResults.length : null,
  latestTick: latestTick,
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
