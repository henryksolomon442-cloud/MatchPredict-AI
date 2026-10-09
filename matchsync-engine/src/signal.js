const crypto = require("crypto");
function makeSignal(symbol, analysis, ttlMs) {
  const createdAt = Date.now();
  return {
    id: crypto.randomUUID(), source: "MARKET_SCANNER", symbol, volatility: symbol,
    matchDigit: analysis.topDigit, evenOdd: analysis.recentParity,
    confidence: analysis.confidence, score: analysis.score,
    samples: analysis.samples, createdAt, expiresAt: createdAt + ttlMs,
    mode: "PAPER_ONLY"
  };
}
function isFresh(signal) {
  return Boolean(signal && Date.now() < signal.expiresAt);
}
module.exports = { makeSignal, isFresh };