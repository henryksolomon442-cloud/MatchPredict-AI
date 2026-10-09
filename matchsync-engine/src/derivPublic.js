const WebSocket = require("ws");
class DerivPublicFeed {
  constructor(appId, symbols, onTick, onStatus) {
    this.appId = appId; this.symbols = symbols; this.onTick = onTick;
    this.onStatus = onStatus; this.ws = null; this.closedByUser = false;
    this.reconnectTimer = null;
  }
  connect() {
    this.closedByUser = false;
    const url = "wss://api.derivws.com/trading/v1/options/ws/public";
    this.onStatus({ connected: false, message: "Connecting to public tick feed…" });
    this.ws = new WebSocket(url);
    this.ws.on("open", () => {
      this.onStatus({ connected: true, message: "Connected; subscribing to tick streams…" });
      for (const symbol of this.symbols) this.ws.send(JSON.stringify({ ticks: symbol, subscribe: 1 }));
    });
    this.ws.on("message", raw => {
      let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
      const apiError = msg.error || (Array.isArray(msg.errors) ? msg.errors[0] : null);
      if (apiError) {
        this.onStatus({ connected: true, message: "Feed warning: " + (apiError.message || apiError.code || "subscription error") });
        return;
      }
      if (msg.msg_type === "tick" && msg.tick) this.onTick(msg.tick);
    });
    this.ws.on("error", err => this.onStatus({ connected: false, message: "WebSocket error: " + err.message }));
    this.ws.on("close", () => {
      this.onStatus({ connected: false, message: "Feed disconnected." });
      if (!this.closedByUser) this.reconnectTimer = setTimeout(() => this.connect(), 3000);
    });
  }
  close() {
    this.closedByUser = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.ws) this.ws.close();
  }
}
module.exports = { DerivPublicFeed };