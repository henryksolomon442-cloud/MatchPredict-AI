const WebSocket = require("ws");
class DerivPublicFeed {
  constructor(appId, symbols, onTick, onStatus) {
    this.appId = appId; this.symbols = symbols; this.onTick = onTick;
    this.onStatus = onStatus; this.ws = null; this.closedByUser = false;
    this.reconnectTimer = null;
    this.pipSizes = new Map();
    this.subscribedSymbols = new Set();
  }
  connect() {
    this.closedByUser = false;
    const url = "wss://api.derivws.com/trading/v1/options/ws/public";
    this.onStatus({ connected: false, message: "Connecting to public tick feed…" });
    this.ws = new WebSocket(url);
    this.ws.on("open", () => {
      this.onStatus({ connected: true, message: "Connected; loading displayed quote precision…" });
      this.ws.send(JSON.stringify({ active_symbols: "brief" }));
    });
    this.ws.on("message", raw => {
      let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
      const apiError = msg.error || (Array.isArray(msg.errors) ? msg.errors[0] : null);
      if (apiError) {
        this.onStatus({ connected: true, message: "Feed warning: " + (apiError.message || apiError.code || "subscription error") });
        return;
      }
      if (msg.msg_type === "active_symbols" && Array.isArray(msg.active_symbols)) {
        for (const item of msg.active_symbols) {
          const symbol = item.underlying_symbol || item.symbol;
          const precision = item.pip_size ?? item.pip;
          if (symbol && precision !== undefined && precision !== null &&
              Number.isInteger(Number(precision)) && Number(precision) >= 0 && Number(precision) <= 10) {
            this.pipSizes.set(symbol, Number(precision));
          }
        }
        for (const symbol of this.symbols) {
          if (!this.subscribedSymbols.has(symbol) && this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ ticks: symbol, subscribe: 1 }));
            this.subscribedSymbols.add(symbol);
          }
        }
        this.onStatus({ connected: true, message: "Connected; subscribed using market display precision." });
      }
      if (msg.msg_type === "tick" && msg.tick) {
        const symbol = msg.tick.symbol;
        const pipSize = msg.tick.pip_size ?? msg.tick.pip ?? this.pipSizes.get(symbol);
        this.onTick({ ...msg.tick, pip_size: pipSize });
      }
    });
    this.ws.on("error", err => this.onStatus({ connected: false, message: "WebSocket error: " + err.message }));
    this.ws.on("close", () => {
      this.subscribedSymbols.clear();
      this.onStatus({ connected: false, message: "Feed disconnected." });
      if (!this.closedByUser) this.reconnectTimer = setTimeout(() => this.connect(), 3000);
    });
  }
  close() {
    this.closedByUser = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.subscribedSymbols.clear();
    if (this.ws) this.ws.close();
  }
}
module.exports = { DerivPublicFeed };