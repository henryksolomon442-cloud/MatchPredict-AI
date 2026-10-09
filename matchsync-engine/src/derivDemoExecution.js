const WebSocket = require("ws");

const API_BASE = "https://api.derivws.com";

class DerivDemoExecutor {
  constructor({ appId, token, maxStake = 0.35, contractMode = "MATCH_DIGIT", durationTicks = 1 }) {
    this.appId = appId;
    this.token = token;
    this.maxStake = maxStake;
    this.contractMode = contractMode;
    this.durationTicks = durationTicks;
    this.ws = null;
    this.ready = false;
    this.isVirtual = false;
    this.currency = null;
    this.accountId = null;
    this.nextReqId = 1;
    this.pending = new Map();
    this.status = "not_configured";
  }

  async connect() {
    if (!this.appId || !this.token) {
      this.status = "missing_credentials";
      throw new Error("DERIV_APP_ID and DERIV_DEMO_TOKEN are required");
    }
    this.status = "checking_demo_account";
    const headers = {
      Authorization: "Bearer " + this.token,
      "Deriv-App-ID": this.appId,
      Accept: "application/json"
    };

    const accountsResponse = await fetch(API_BASE + "/trading/v1/options/accounts", { headers });
    const accountsBody = await accountsResponse.json().catch(() => ({}));
    if (!accountsResponse.ok) {
      this.status = "account_lookup_failed";
      throw new Error("Deriv account lookup failed (HTTP " + accountsResponse.status + ")");
    }
    const rawAccounts = accountsBody.data;
    const accounts = Array.isArray(rawAccounts) ? rawAccounts : (rawAccounts ? [rawAccounts] : []);
    const demoAccount = accounts.find(account => {
      const type = String(account.account_type || account.accountType || "").toLowerCase();
      const loginId = String(account.loginid || account.login_id || "").toUpperCase();
      return type === "demo" || type === "virtual" || account.is_virtual === 1 ||
        account.is_virtual === true || loginId.startsWith("VRTC");
    });

    if (!demoAccount) {
      this.status = "blocked_non_demo_account";
      this.ready = false;
      throw new Error("No verified demo/virtual Options account found; refusing to trade");
    }
    this.accountId = demoAccount.account_id || demoAccount.accountId || demoAccount.id;
    this.currency = demoAccount.currency || demoAccount.currency_code || null;
    if (!this.accountId || !this.currency) {
      this.status = "demo_account_details_incomplete";
      throw new Error("Deriv demo account response is missing account ID or currency");
    }

    const otpResponse = await fetch(
      API_BASE + "/trading/v1/options/accounts/" + encodeURIComponent(this.accountId) + "/otp",
      { method: "POST", headers }
    );
    const otpBody = await otpResponse.json().catch(() => ({}));
    if (!otpResponse.ok || !otpBody.data || typeof otpBody.data.url !== "string") {
      this.status = "otp_failed";
      throw new Error("Deriv did not provide a demo WebSocket URL (HTTP " + otpResponse.status + ")");
    }
    const wsUrl = otpBody.data.url;
    if (!wsUrl.includes("/ws/demo")) {
      this.status = "blocked_non_demo_endpoint";
      throw new Error("Deriv did not return a demo-only WebSocket endpoint; refusing to trade");
    }

    this.status = "connecting_demo_websocket";
    return new Promise((resolve, reject) => {
      let settled = false;
      this.ws = new WebSocket(wsUrl);

      this.ws.on("open", () => {
        this.ready = true;
        this.isVirtual = true;
        this.status = "ready_demo_only";
        settled = true;
        console.log("Deriv authenticated demo WebSocket is ready.");
        resolve(this);
      });

      this.ws.on("message", raw => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch { return; }
        const reqId = msg.req_id;
        if (reqId && this.pending.has(reqId)) {
          const item = this.pending.get(reqId);
          this.pending.delete(reqId);
          clearTimeout(item.timer);
          const apiError = msg.error || (Array.isArray(msg.errors) ? msg.errors[0] : null);
          if (apiError) item.reject(new Error(apiError.message || apiError.code || "Deriv API error"));
          else item.resolve(msg);
        }
      });

      this.ws.on("error", error => {
        this.status = "connection_error";
        console.error("Deriv demo WebSocket error:", error.message);
        if (!settled) {
          settled = true;
          reject(new Error("Deriv demo WebSocket connection failed"));
        }
      });

      this.ws.on("close", () => {
        this.ready = false;
        this.isVirtual = false;
        if (this.status !== "blocked_non_demo_account" && this.status !== "blocked_non_demo_endpoint")
          this.status = "disconnected";
        for (const [id, item] of this.pending) {
          clearTimeout(item.timer);
          item.reject(new Error("Deriv demo connection closed"));
          this.pending.delete(id);
        }
        if (!settled) {
          settled = true;
          reject(new Error("Deriv closed the demo WebSocket before it became ready"));
        }
      });
    });
  }

  request(payload, timeoutMs = 3500) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.ready || !this.isVirtual)
      return Promise.reject(new Error("Deriv demo connection is not ready"));
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
    const contractType = this.contractMode === "EVEN_ODD"
      ? (signal.evenOdd === "EVEN" ? "DIGITEVEN" : "DIGITODD")
      : "DIGITMATCH";
    const proposalReq = {
      proposal: 1,
      amount: stake,
      basis: "stake",
      contract_type: contractType,
      currency: this.currency,
      duration: this.durationTicks,
      duration_unit: "t",
      underlying_symbol: signal.symbol
    };
    if (contractType === "DIGITMATCH") proposalReq.barrier = String(signal.matchDigit);

    const proposalMsg = await this.request(proposalReq, 3500);
    if (!proposalMsg.proposal || !proposalMsg.proposal.id)
      throw new Error("Deriv did not return a valid price proposal");
    if (Date.now() > signal.expiresAt)
      throw new Error("Signal expired while waiting for proposal; no order was bought");

    const askPrice = Number(proposalMsg.proposal.ask_price);
    if (!Number.isFinite(askPrice) || askPrice <= 0)
      throw new Error("Deriv returned an invalid proposal price");

    const buyMsg = await this.request({
      buy: proposalMsg.proposal.id,
      price: askPrice,
      passthrough: { source: "MatchSyncEngine", signal_id: signal.id || "", mode: "DEMO_ONLY" }
    }, 3500);
    if (!buyMsg.buy || !buyMsg.buy.contract_id)
      throw new Error("Deriv did not confirm a purchased contract");

    return {
      ok: true,
      mode: "DEMO_ONLY",
      status: "ORDER_CONFIRMED",
      contractId: buyMsg.buy.contract_id,
      transactionId: buyMsg.buy.transaction_id || null,
      symbol: signal.symbol,
      contractType,
      matchDigit: signal.matchDigit,
      evenOdd: signal.evenOdd,
      stake,
      currency: this.currency,
      executionMs: Date.now() - startedAt,
      createdAt: Date.now()
    };
  }

  close() {
    this.ready = false;
    this.isVirtual = false;
    if (this.ws) this.ws.close();
  }
}

module.exports = { DerivDemoExecutor };
