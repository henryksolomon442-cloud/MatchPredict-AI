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
    this.keepaliveTimer = null;
    this.connectionGeneration = 0;
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
    const generation = ++this.connectionGeneration;
    return new Promise((resolve, reject) => {
      let settled = false;
      const socket = new WebSocket(wsUrl);
      this.ws = socket;

      socket.on("open", () => {
        if (generation !== this.connectionGeneration || socket !== this.ws) return;
        this.ready = true;
        this.isVirtual = true;
        this.status = "ready_demo_only";
        settled = true;
        if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
        // Deriv WebSocket sessions can be closed when left idle. Send the API ping
        // regularly so a healthy demo session stays alive between trade signals.
        this.keepaliveTimer = setInterval(() => {
          if (socket === this.ws && this.ready && socket.readyState === WebSocket.OPEN) {
            try { socket.send(JSON.stringify({ ping: 1 })); }
            catch (error) { console.warn("Deriv demo keepalive send failed:", error.message); }
          }
        }, 25000);
        if (typeof this.keepaliveTimer.unref === "function") this.keepaliveTimer.unref();
        console.log("Deriv authenticated demo WebSocket is ready; keepalive enabled.");
        resolve(this);
      });

      socket.on("message", raw => {
        if (generation !== this.connectionGeneration || socket !== this.ws) return;
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch { return; }
        const reqId = msg.req_id;
        if (reqId && this.pending.has(reqId)) {
          const item = this.pending.get(reqId);
          this.pending.delete(reqId);
          clearTimeout(item.timer);
          const apiError = msg.error || (Array.isArray(msg.errors) ? msg.errors[0] : null);
          if (apiError) {
            const error = new Error(apiError.message || apiError.code || "Deriv API error");
            error.code = apiError.code || null;
            error.details = apiError.details || null;
            error.derivEchoReq = msg.echo_req || null;
            item.reject(error);
          } else item.resolve(msg);
        }
      });

      socket.on("error", error => {
        if (generation !== this.connectionGeneration || socket !== this.ws) return;
        this.status = "connection_error";
        console.error("Deriv demo WebSocket error:", error.message);
        if (!settled) {
          settled = true;
          reject(new Error("Deriv demo WebSocket connection failed"));
        }
      });

      socket.on("close", (code, reason) => {
        if (generation !== this.connectionGeneration || socket !== this.ws) return;
        if (this.keepaliveTimer) { clearInterval(this.keepaliveTimer); this.keepaliveTimer = null; }
        this.ready = false;
        this.isVirtual = false;
        if (this.status !== "blocked_non_demo_account" && this.status !== "blocked_non_demo_endpoint")
          this.status = "disconnected";
        console.warn("Deriv demo WebSocket closed:", code, reason ? reason.toString().slice(0, 160) : "(no reason)");
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

  request(payload, timeoutMs = 2500) {
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

  async watchSettlement(contractId, result) {
    // Poll the purchased demo contract until Deriv reports its final settlement.
    // This records the actual outcome; ORDER_CONFIRMED alone is not a win.
    const startedAt = Date.now();
    const maxWaitMs = 30000;
    while (Date.now() - startedAt < maxWaitMs) {
      await new Promise(resolve => setTimeout(resolve, 500));
      if (!this.ready || !this.isVirtual) {
        result.settlement = { status: "unavailable", reason: "DEMO_CONNECTION_LOST", checkedAt: Date.now() };
        console.warn("[DerivDemoExecutor] Settlement tracking unavailable", JSON.stringify({ contractId, reason: "DEMO_CONNECTION_LOST" }));
        return;
      }
      try {
        const msg = await this.request({ proposal_open_contract: 1, contract_id: contractId }, 2500);
        const contract = msg.proposal_open_contract;
        if (!contract) continue;
        const sold = contract.is_sold === 1 || contract.is_sold === true;
        const status = String(contract.status || "").toLowerCase();
        if (sold || status === "won" || status === "lost" || status === "sold") {
          const profit = Number(contract.profit);
          result.settlement = {
            status: status || (profit > 0 ? "won" : profit < 0 ? "lost" : "sold"),
            isSold: sold,
            profit: Number.isFinite(profit) ? profit : null,
            buyPrice: Number.isFinite(Number(contract.buy_price)) ? Number(contract.buy_price) : result.stake,
            payout: Number.isFinite(Number(contract.sell_price)) ? Number(contract.sell_price) : null,
            entryTick: contract.entry_tick ?? null,
            exitTick: contract.exit_tick ?? null,
            entryTickDisplayValue: contract.entry_tick_display_value ?? null,
            exitTickDisplayValue: contract.exit_tick_display_value ?? null,
            settledAt: Date.now(),
            durationMs: Date.now() - startedAt
          };
          console.log("[DerivDemoExecutor] Demo contract settled", JSON.stringify({
            contractId, symbol: result.symbol, matchDigit: result.matchDigit,
            status: result.settlement.status, profit: result.settlement.profit,
            entryTick: result.settlement.entryTickDisplayValue,
            exitTick: result.settlement.exitTickDisplayValue,
            durationMs: result.settlement.durationMs
          }));
          return;
        }
      } catch (error) {
        // Transient polling failures should not cancel the already purchased contract.
        console.warn("[DerivDemoExecutor] Settlement poll failed", JSON.stringify({
          contractId, error: error.message
        }));
      }
    }
    result.settlement = { status: "timeout", reason: "SETTLEMENT_NOT_CONFIRMED_WITHIN_30S", checkedAt: Date.now() };
    console.warn("[DerivDemoExecutor] Settlement tracking timed out", JSON.stringify({ contractId }));
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
    // Keep the user's end-to-end target under 7 seconds. Allow at most 4 seconds
    // from DigitEdge's prediction to the start of the buy request, leaving room
    // for Deriv's buy response. If the signal is already too old, do not trade.
    const sourceGeneratedAt = Number(signal.sourceGeneratedAt);
    if (!Number.isFinite(sourceGeneratedAt) || sourceGeneratedAt > startedAt + 1000) {
      return { ok: false, status: "blocked", reason: "INVALID_SOURCE_TIMESTAMP" };
    }
    if (startedAt - sourceGeneratedAt >= 4000) {
      return {
        ok: false, status: "blocked", reason: "LATENCY_BUDGET_EXCEEDED",
        endToEndMs: startedAt - sourceGeneratedAt, maxBeforeBuyMs: 4000
      };
    }

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

    let proposalMsg;
    try {
      proposalMsg = await this.request(proposalReq, 2500);
    } catch (error) {
      console.error("[DerivDemoExecutor] Proposal request failed", JSON.stringify({
        stage: "proposal", symbol: signal.symbol, contractType, currency: this.currency,
        duration: this.durationTicks, amount: stake, barrier: proposalReq.barrier ?? null,
        errorCode: error.code || null, error: error.message, details: error.details || null,
        echoReq: error.derivEchoReq || null
      }));
      error.message = "Proposal request failed: " + error.message;
      throw error;
    }
    if (!proposalMsg.proposal || !proposalMsg.proposal.id)
      throw new Error("Deriv did not return a valid price proposal");
    if (Date.now() > signal.expiresAt)
      throw new Error("Signal expired while waiting for proposal; no order was bought");

    const askPrice = Number(proposalMsg.proposal.ask_price);
    if (!Number.isFinite(askPrice) || askPrice <= 0)
      throw new Error("Deriv returned an invalid proposal price");

    // A consensus score is not a calibrated win probability. Until the system
    // proves an out-of-sample edge, compare the quote against the fair-odds
    // baseline rather than treating 4/4 agreement as an advantage.
    const quotedPayout = Number(proposalMsg.proposal.payout);
    const baselineWinProbability = contractType === "DIGITMATCH" ? 0.10 : 0.50;
    if (!Number.isFinite(quotedPayout) || quotedPayout <= 0) {
      return {
        ok: false, status: "blocked", reason: "MISSING_VALID_QUOTED_PAYOUT",
        askPrice, quotedPayout: Number.isFinite(quotedPayout) ? quotedPayout : null
      };
    }
    const breakEvenProbability = askPrice / quotedPayout;
    const baselineExpectedProfit = baselineWinProbability * quotedPayout - askPrice;
    if (baselineExpectedProfit <= 0) {
      console.warn("[DerivDemoExecutor] Trade blocked: no demonstrated positive baseline expectancy", JSON.stringify({
        symbol: signal.symbol, contractType, matchDigit: signal.matchDigit,
        askPrice, quotedPayout, baselineWinProbability, breakEvenProbability,
        baselineExpectedProfit
      }));
      return {
        ok: false, status: "blocked", reason: "NO_POSITIVE_BASELINE_EXPECTED_VALUE",
        askPrice, quotedPayout, baselineWinProbability, breakEvenProbability,
        baselineExpectedProfit
      };
    }

    const ageBeforeBuy = Date.now() - sourceGeneratedAt;
    // Do not start a purchase if the remaining round trip could push the
    // prediction-to-execution path beyond the 7-second target.
    if (ageBeforeBuy >= 4000) {
      return {
        ok: false, status: "blocked", reason: "LATENCY_BUDGET_EXCEEDED",
        endToEndMs: ageBeforeBuy, maxBeforeBuyMs: 4000
      };
    }

    let buyMsg;
    const passthrough = { source: "MatchSyncEngine", signal_id: signal.id || "", mode: "DEMO_ONLY" };
    try {
      buyMsg = await this.request({
        buy: proposalMsg.proposal.id,
        price: askPrice,
        passthrough
      }, 2500);
    } catch (error) {
      console.error("[DerivDemoExecutor] Buy request failed", JSON.stringify({
        stage: "buy", symbol: signal.symbol, contractType, currency: this.currency,
        proposalIdPresent: Boolean(proposalMsg.proposal.id), askPrice,
        errorCode: error.code || null, error: error.message, details: error.details || null,
        echoReq: error.derivEchoReq || null
      }));
      // Deriv's current WebSocket API also supports buying directly with
      // contract parameters. If a proposal ID is explicitly rejected as
      // unknown, retry once using that documented form; an explicit
      // InvalidContractProposal response means no contract was purchased.
      if (error.code === "InvalidContractProposal" || /unknown contract proposal/i.test(error.message || "")) {
        const parameters = {
          amount: stake,
          basis: "stake",
          contract_type: contractType,
          currency: this.currency,
          duration: this.durationTicks,
          duration_unit: "t",
          underlying_symbol: signal.symbol
        };
        if (contractType === "DIGITMATCH") parameters.barrier = String(signal.matchDigit);
        console.warn("[DerivDemoExecutor] Retrying once with direct demo contract parameters", JSON.stringify({
          symbol: signal.symbol, contractType, duration: this.durationTicks, stake
        }));
        try {
          buyMsg = await this.request({ buy: 1, price: askPrice, parameters, passthrough }, 2500);
        } catch (retryError) {
          console.error("[DerivDemoExecutor] Direct-parameter buy failed", JSON.stringify({
            stage: "direct_buy", symbol: signal.symbol, contractType,
            errorCode: retryError.code || null, error: retryError.message,
            details: retryError.details || null, echoReq: retryError.derivEchoReq || null
          }));
          retryError.message = "Direct-parameter buy failed: " + retryError.message;
          throw retryError;
        }
      } else {
        error.message = "Buy request failed: " + error.message;
        throw error;
      }
    }
    if (!buyMsg.buy || !buyMsg.buy.contract_id)
      throw new Error("Deriv did not confirm a purchased contract");

    const result = {
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
      endToEndMs: Date.now() - sourceGeneratedAt,
      createdAt: Date.now(),
      settlement: { status: "pending" }
    };
    // Run in the background so signal acceptance and order placement stay fast.
    this.watchSettlement(result.contractId, result).catch(error => {
      result.settlement = { status: "error", reason: error.message, checkedAt: Date.now() };
      console.error("[DerivDemoExecutor] Settlement watcher failed", JSON.stringify({
        contractId: result.contractId, error: error.message
      }));
    });
    return result;
  }

  close() {
    this.ready = false;
    this.isVirtual = false;
    this.connectionGeneration++;
    if (this.keepaliveTimer) { clearInterval(this.keepaliveTimer); this.keepaliveTimer = null; }
    if (this.ws) this.ws.close();
  }
}

module.exports = { DerivDemoExecutor };
