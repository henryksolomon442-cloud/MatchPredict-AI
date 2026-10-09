const crypto = require("crypto");
const { isFresh } = require("./signal");
class PaperExecution {
  constructor({ maxStake = 0.35, cooldownMs = 1000 } = {}) {
    this.maxStake = maxStake; this.cooldownMs = cooldownMs;
    this.lastExecutionAt = 0; this.seenSignalIds = new Set(); this.history = [];
  }
  execute(signal, requestedStake = 0.35) {
    const now = Date.now();
    if (!signal || !isFresh(signal)) return { ok: false, reason: "STALE_OR_MISSING_SIGNAL" };
    if (this.seenSignalIds.has(signal.id)) return { ok: false, reason: "DUPLICATE_SIGNAL" };
    if (now - this.lastExecutionAt < this.cooldownMs) return { ok: false, reason: "COOLDOWN" };
    const stake = Number(requestedStake);
    if (!Number.isFinite(stake) || stake <= 0 || stake > this.maxStake)
      return { ok: false, reason: "STAKE_OUT_OF_ALLOWED_RANGE", maxStake: this.maxStake };
    const record = {
      paperTradeId: crypto.randomUUID(), signalId: signal.id, symbol: signal.symbol,
      matchDigit: signal.matchDigit, evenOdd: signal.evenOdd, stake,
      mode: "PAPER_ONLY", status: "SIMULATED_NOT_SENT_TO_DERIV", createdAt: now
    };
    this.seenSignalIds.add(signal.id); this.lastExecutionAt = now;
    this.history.unshift(record); this.history = this.history.slice(0, 100);
    return { ok: true, record };
  }
  getHistory() { return this.history; }
}
module.exports = { PaperExecution };