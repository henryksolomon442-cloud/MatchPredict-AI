const crypto = require("crypto");
function makeSignal(symbol, analysis, ttlMs) {
  const createdAt = Date.now();
  return {
    id: crypto.randomUUID(), source: "MARKET_SCANNER", symbol, volatility: symbol,
    matchDigit: analysis.topDigit,
    // Keep displayed parity aligned with the exact predicted digit.
    evenOdd: Number.isInteger(analysis.topDigit) ? (analysis.topDigit % 2 === 0 ? "EVEN" : "ODD") : null,
    confidence: analysis.confidence, score: analysis.score,
    samples: analysis.samples, createdAt, expiresAt: createdAt + ttlMs,
    mode: "MARKET_SCANNER_ONLY"
  };
}
function isFresh(signal) {
  return Boolean(signal && Date.now() < signal.expiresAt);
}
module.exports = { makeSignal, isFresh };