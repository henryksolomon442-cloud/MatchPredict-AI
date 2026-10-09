function lastDigit(quote) {
  const digits = String(quote).replace(/\D/g, "");
  return digits.length ? Number(digits[digits.length - 1]) : null;
}

function analyzeMarket(ticks, minSamples) {
  const digits = ticks.map(t => t.digit).filter(Number.isInteger);
  const n = digits.length;
  const counts = Array(10).fill(0);
  for (const digit of digits) counts[digit]++;
  const even = digits.filter(d => d % 2 === 0).length;
  const odd = n - even;
  const ranked = counts.map((count, digit) => ({ digit, count, rate: n ? count / n : 0 }))
    .sort((a, b) => b.rate - a.rate || a.digit - b.digit);
  const recent = digits.slice(-20);
  const recentEven = recent.filter(d => d % 2 === 0).length;
  const recentOdd = recent.length - recentEven;
  const diversity = counts.filter(c => c > 0).length / 10;
  const topRate = n ? ranked[0].rate : 0;
  const imbalance = n ? Math.abs(even - odd) / n : 0;
  const activity = Math.min(1, n / Math.max(minSamples, 1));
  const score = activity * (0.55 * topRate + 0.25 * imbalance + 0.20 * diversity);
  const confidence = Math.max(0, Math.min(0.99,
    0.5 + Math.min(0.20, Math.abs(topRate - 0.10)) +
    Math.min(0.15, imbalance * 0.3) - (n < minSamples ? 0.20 : 0)
  ));
  return {
    samples: n, ready: n >= minSamples, counts,
    topDigit: ranked[0] ? ranked[0].digit : null,
    topDigitRate: Number(topRate.toFixed(4)),
    evenRate: n ? Number((even / n).toFixed(4)) : null,
    oddRate: n ? Number((odd / n).toFixed(4)) : null,
    recentParity: recent.length ? (recentEven >= recentOdd ? "EVEN" : "ODD") : null,
    score: Number(score.toFixed(5)), confidence: Number(confidence.toFixed(3)),
    latestDigit: n ? digits[n - 1] : null
  };
}
module.exports = { lastDigit, analyzeMarket };