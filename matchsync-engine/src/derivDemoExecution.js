const WebSocket = require("ws");

class DerivDemoExecutor {
  constructor({ appId, token, maxStake = 0.35, contractMode = "EVEN_ODD", durationTicks = 1 }) {
    this.appId = appId;
    this.token = token;
    this.maxStake = maxStake;
    this.contractMode = contractMode;
    this.durationTicks = durationTicks;
    this.ws = null;
    this.ready = false;
    this.isVirtual = false;
    this.currency = null;
    this.nextReqId = 1;
    this.pending = new Map();
    this.status = "not_configured";
  }
  connect() {
    if (!this.appId || !this.token) { this.status = "missing_credentials"; return; }
    this.status = "connecting";
    this.ws = new WebSocket("wss://ws.derivws.com/websockets/v3?app_id=" + encodeURIComponent(this.appId));
    this.ws.on("open", async () => {
      try {
        const auth = await this.request({ authorize: this.token }, 7000);
        // Fail closed: this executor is explicitly for virtual/demo accounts only.
        this.isVirtual = auth.is_virtual === 1 || auth.is_virtual === true;
        if (!this.isVirtual) {
          this.status = "blocked_non_demo_account";
          this.ready = false;
          console.error("Demo executor blocked: account is not confirmed virtual.");
          this.ws.close();
          return;
        }
        this.currency = auth.currency;
        this.ready = true;
        this.status = "ready_demo_only";
        console.log("Deriv demo execution connection authorized for virtual account.");
      } catch (e) {
        this.status = "authorization_error";
        console.error("Deriv demo authorization failed:", e.message);
        if (this.ws) this.ws.close();
      }
    });
    this.ws.on("message", raw => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.req_id && this.pending.has(msg.req_id)) {
        const item = this.pending.get(msg.req_id);
        this.pending.delete(msg.req_id);
        clearTimeout(item.timer);
        if (msg.error) item.reject(new Error(msg.error.message || msg.error.code || "Deriv API error"));
        else item.resolve(msg);
      }
    });
    this.ws.on("error", e => {
      this.status = "connection_error";
      console.error("Deriv demo WebSocket error:", e.message);
    });
    this.ws.on("close", () => {
      this.ready = false;
      if (this.status !== "blocked_non_demo_account") this.status = "disconnected";
      for (const [id, item] of this.pending) {
        clearTimeout(item.timer);
        item.reject(new Error("Deriv connection closed"));
        this.pending.delete(id);
      }
    });
  }
  request(payload, timeoutMs = 3500) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN)
      return Promise.reject(new Error("Deriv demo connection is not open"));
    const req_id = this.nextReqId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(req_id);
        reject(new Error("Deriv request timed out"));
      }, timeoutMs);
      this.pending.set(req_id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ ...payload, req_id }));
    });
  }
  async execute(signal, requestedStake) {
    if (!this.ready || !this.isVirtual)
      return { ok: false, reason: "DEMO_EXECUTOR_NOT_READY", status: this.status };
    if (!signal || !Number.isFinite(signal.expiresAt) || Date.now() > signal.expiresAt)
      return { ok: false, reason: "STALE_OR_MISSING_SIGNAL" };
    if (!Number.isInteger(signal.matchDigit) || signal.matchDigit < 0 || signal.matchDigit > 9)
      return { ok: false, reason: "INVALID_MATCH_DIGIT" };
    if (!["EVEN", "ODD"].includes(signal.evenOdd))
      return { ok: false, reason: "INVALID_EVEN_ODD" };
    const stake = Number(requestedStake);
    if (!Number.isFinite(stake) || stake <= 0 || stake > this.maxStake)
      return { ok: false, reason: "STAKE_OUT_OF_ALLOWED_RANGE", maxStake: this.maxStake };
    const startedAt = Date.now();
    const contractType = this.contractMode === "MATCH_DIGIT" ? "DIGITMATCH" :
      (signal.evenOdd === "EVEN" ? "DIGITEVEN" : "DIGITODD");
    const proposalReq = {
      proposal: 1, amount: stake, basis: "stake", contract_type: contractType,
      currency: this.currency, duration: this.durationTicks, duration_unit: "t",
      underlying_symbol: signal.symbol
    };
    if (contractType === "DIGITMATCH") proposalReq.barrier = String(signal.matchDigit);
    const proposalMsg = await this.request(proposalReq, 3500);
    if (!proposalMsg.proposal || !proposalMsg.proposal.id)
      throw new Error("Deriv did not return a valid price proposal");
    const buyMsg = await this.request({
      buy: proposalMsg.proposal.id,
      price: Number(proposalMsg.proposal.ask_price),
      passthrough: { source: "MatchSyncEngine", signal_id: signal.id || "", mode: "DEMO_ONLY" }
    }, 3500);
    if (!buyMsg.buy || !buyMsg.buy.contract_id)
      throw new Error("Deriv did not confirm a purchased contract");
    return {
      ok: true, mode: "DEMO_ONLY", status: "ORDER_CONFIRMED",
      contractId: buyMsg.buy.contract_id, transactionId: buyMsg.buy.transaction_id || null,
      symbol: signal.symbol, contractType, matchDigit: signal.matchDigit,
      evenOdd: signal.evenOdd, stake, currency: this.currency,
      executionMs: Date.now() - startedAt, createdAt: Date.now()
    };
  }
  close() { this.ready = false; if (this.ws) this.ws.close(); }
}
module.exports = { DerivDemoExecutor };
