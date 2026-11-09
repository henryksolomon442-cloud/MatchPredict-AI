require("dotenv").config();
const express = require("express");
const WebSocket = require("ws");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 10000;
const APP_ID = process.env.DERIV_APP_ID || "1089";
const SYMBOL = "R_75";
const WINDOW = 100;
const TICKS = [];
const CLIENTS = new Set();
const RESULTS = [];
let upstream;
let connected = false;
let reconnectTimer;
let lastMessageAt = null;
let lastError = null;
let pending = [];
let tickCount = 0;
let latestSignal = { direction: "WAIT", strength: 0, reason: "Waiting for live ticks", at: null };

app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "v75.html")));
app.get("/health", (_req, res) => res.json({ ok: true, app: "V75 RiseFall Engine", symbol: SYMBOL, connected, tickCount }));
app.get("/api/status", (_req, res) => res.json({
  app: "V75 RiseFall Engine", symbol: SYMBOL, connected, tickCount,
  bufferedTicks: TICKS.length, lastMessageAt, lastError,
  latestPrice: TICKS.length ? TICKS[TICKS.length - 1].quote : null,
  latestSignal, evaluated: RESULTS.length,
  accuracy: RESULTS.length ? RESULTS.filter(x => x.correct).length / RESULTS.length : null
}));
app.get("/api/history", (_req, res) => res.json({ ticks: TICKS, results: RESULTS.slice(-100), signal: latestSignal }));
app.get("/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();
  CLIENTS.add(res);
  res.write(`event: snapshot\ndata: ${JSON.stringify({ type: "snapshot", status: statusPayload(), ticks: TICKS.slice(-WINDOW), results: RESULTS.slice(-30) })}\n\n`);
  req.on("close", () => CLIENTS.delete(res));
});
function statusPayload() {
  return { connected, tickCount, bufferedTicks: TICKS.length, lastMessageAt, lastError,
    latestPrice: TICKS.length ? TICKS[TICKS.length - 1].quote : null, latestSignal,
    evaluated: RESULTS.length, accuracy: RESULTS.length ? RESULTS.filter(x => x.correct).length / RESULTS.length : null };
}
function emit(type, data) {
  const packet = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of CLIENTS) client.write(packet);
}
function round(n) { return Number(Number(n).toFixed(5)); }

// Heuristic only: short-horizon direction score, not a claim of predictive probability.
function analyse() {
  if (TICKS.length < 20) return { direction: "WAIT", strength: 0, reason: "Collecting at least 20 ticks", at: Date.now() };
  const q = TICKS.map(t => t.quote);
  const last = q[q.length - 1];
  const move3 = last - q[q.length - 4];
  const move5 = last - q[q.length - 6];
  const move10 = last - q[q.length - 11];
  const diffs = [];
  for (let i = Math.max(1, q.length - 20); i < q.length; i++) diffs.push(Math.abs(q[i] - q[i - 1]));
  const avgStep = diffs.reduce((a, b) => a + b, 0) / Math.max(1, diffs.length);
  const scale = Math.max(avgStep * 2, 0.00001);
  const s3 = move3 / scale, s5 = move5 / (scale * 1.5), s10 = move10 / (scale * 3);
  const score = s3 * 0.45 + s5 * 0.35 + s10 * 0.20;
  const aligned = Math.sign(move3) === Math.sign(move5) && Math.sign(move5) === Math.sign(move10);
  if (!aligned || Math.abs(score) < 1.15) {
    return { direction: "WAIT", strength: round(Math.abs(score)), reason: "Momentum is weak or timeframes disagree", at: Date.now(), price: last };
  }
  return { direction: score > 0 ? "RISE" : "FALL", strength: round(Math.min(Math.abs(score), 5)), reason: "3-, 5- and 10-tick momentum aligned", at: Date.now(), price: last };
}
function onTick(raw) {
  const quote = Number(raw.quote);
  if (!Number.isFinite(quote)) return;
  const tick = { quote, epoch: Number(raw.epoch) || Math.floor(Date.now()/1000), pip_size: raw.pip_size ?? null };
  TICKS.push(tick);
  if (TICKS.length > WINDOW) TICKS.shift();
  tickCount++;
  lastMessageAt = Date.now();

  // Resolve predictions only after exactly two subsequent ticks have arrived.
  pending = pending.filter(p => {
    p.remaining--;
    if (p.remaining > 0) return true;
    const finalPrice = quote;
    const correct = p.direction === "RISE" ? finalPrice > p.price : p.direction === "FALL" ? finalPrice < p.price : null;
    const result = { direction: p.direction, startPrice: p.price, endPrice: finalPrice, correct, startAt: p.at, evaluatedAt: Date.now() };
    RESULTS.push(result);
    if (RESULTS.length > 500) RESULTS.shift();
    emit("evaluation", result);
    return false;
  });

  latestSignal = analyse();
  if (latestSignal.direction !== "WAIT" && !pending.length) {
    pending.push({ direction: latestSignal.direction, price: quote, at: Date.now(), remaining: 2 });
  }
  emit("tick", { tick, status: statusPayload(), signal: latestSignal });
}
function connect() {
  clearTimeout(reconnectTimer);
  const url = `wss://ws.derivws.com/websockets/v3?app_id=${encodeURIComponent(APP_ID)}`;
  upstream = new WebSocket(url);
  upstream.on("open", () => {
    connected = true; lastError = null;
    emit("status", statusPayload());
    upstream.send(JSON.stringify({ ticks: SYMBOL, subscribe: 1 }));
  });
  upstream.on("message", buf => {
    let msg;
    try { msg = JSON.parse(buf.toString()); } catch { return; }
    if (msg.error) { lastError = msg.error.message || "Deriv API error"; emit("status", statusPayload()); return; }
    if (msg.msg_type === "tick" && msg.tick) onTick(msg.tick);
  });
  upstream.on("error", err => { lastError = err.message; });
  upstream.on("close", () => {
    connected = false; emit("status", statusPayload());
    reconnectTimer = setTimeout(connect, 3000);
  });
}
app.listen(PORT, () => { console.log(`V75 RiseFall Engine listening on ${PORT}`); connect(); });
