/* Walk-forward next-tick validation for Matches Pro.
   Uses only ticks before each target tick; no future data enters a prediction.
   Scores are empirical hit rates, never probability promises. */
(function () {
  "use strict";

  function normalize(a) {
    const sum = a.reduce((x, y) => x + y, 0);
    return sum ? a.map(x => x / sum) : a.map(() => 0.1);
  }
  function argmax(a) {
    let best = 0;
    for (let i = 1; i < a.length; i++) if (a[i] > a[best]) best = i;
    return best;
  }
  function predict(data) {
    const n = data.length;
    if (n < 30) return null;
    const counts = Array(10).fill(0), recent = Array(10).fill(0);
    const lastSeen = Array(10).fill(-1);
    const trans = Array.from({ length: 10 }, () => Array(10).fill(0));
    const recentData = data.slice(-Math.min(80, n));
    data.forEach((d, i) => {
      counts[d]++;
      lastSeen[d] = i;
      if (i) trans[data[i - 1]][d]++;
    });
    recentData.forEach(d => recent[d]++);
    const freq = counts.map(c => c / n);
    const rf = recent.map(c => c / recentData.length);
    const rec = lastSeen.map(i => Math.exp(-(n - 1 - i) / Math.max(7, Math.sqrt(n))));
    const prev = data[n - 1], row = trans[prev].reduce((a, b) => a + b, 0);
    const tr = row ? trans[prev].map(c => c / row) : Array(10).fill(0.1);
    const balanced = normalize(freq.map((v, d) => .35 * v + .30 * rf[d] + .20 * tr[d] + .15 * rec[d]));
    const recentM = normalize(rf.map((v, d) => .65 * v + .20 * freq[d] + .15 * tr[d]));
    const transM = normalize(tr.map((v, d) => .70 * v + .20 * rf[d] + .10 * freq[d]));
    const recM = normalize(rec.map((v, d) => .55 * v + .25 * rf[d] + .20 * freq[d]));
    const models = [balanced, recentM, transM, recM];
    const modelPreds = models.map(argmax);
    const votes = Array(10).fill(0);
    modelPreds.forEach(d => votes[d]++);
    const maxVote = Math.max(...votes);
    const ensemble = votes.map((v, d) => ({ d, v, b: balanced[d] }))
      .filter(x => x.v === maxVote).sort((a, b) => b.b - a.b)[0].d;
    return { ensemble, balanced: argmax(balanced), recent: argmax(recentM),
      transition: argmax(transM), recency: argmax(recM) };
  }
  function metric() { return { n: 0, hits: 0 }; }
  function add(m, pred, actual) { m.n++; if (pred === actual) m.hits++; }
  function pct(m) { return m.n ? (100 * m.hits / m.n) : 0; }
  function runOne(ticks, windowSize) {
    const metrics = { ensemble: metric(), balanced: metric(), recent: metric(),
      transition: metric(), recency: metric(), mostFrequent: metric() };
    const minHistory = 100;
    for (let i = minHistory; i < ticks.length; i++) {
      const history = ticks.slice(Math.max(0, i - windowSize), i);
      const p = predict(history);
      if (!p) continue;
      const actual = ticks[i];
      Object.keys(metrics).forEach(k => {
        const guess = k === "mostFrequent"
          ? (() => { const c = Array(10).fill(0); history.forEach(d => c[d]++); return argmax(c); })()
          : p[k];
        add(metrics[k], guess, actual);
      });
    }
    return metrics;
  }
  function render(results, windowSize) {
    const panel = document.getElementById("matchAccuracyResults");
    if (!panel) return;
    const rows = results.map(r => {
      const m = r.metrics;
      const base = m.ensemble.n ? (100 * 0.1).toFixed(1) : "—";
      const methods = ["ensemble", "balanced", "recent", "transition", "recency", "mostFrequent"];
      const best = methods.slice().sort((a, b) => pct(m[b]) - pct(m[a]))[0];
      return `<div style="padding:12px 0;border-top:1px solid #29313b">
        <div style="font-weight:900;margin-bottom:8px">${r.name} <span style="color:#8d96a2;font-size:11px">${r.symbol}</span></div>
        <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px">
          ${methods.map(k => `<div style="background:#0b1016;border:1px solid #252d36;border-radius:9px;padding:9px">
            <div style="font-size:10px;color:#929aa6;text-transform:uppercase">${k=== "mostFrequent"?"MOST-FREQUENT BASELINE":k}</div>
            <b style="font-size:19px;color:${k===best?"#64e8aa":"#f5f7fb"}">${pct(m[k]).toFixed(1)}%</b>
            <div style="font-size:10px;color:#929aa6">${m[k].hits}/${m[k].n} correct</div>
          </div>`).join("")}
        </div>
        <div style="font-size:11px;color:#aab3bd;margin-top:7px">Next-tick baseline for random selection: 10%. Best observed method: <b>${best}</b>. These are historical test results, not future odds.</div>
      </div>`;
    }).join("");
    panel.innerHTML = `<div class="status good">Walk-forward test completed · ${windowSize}-tick lookback · each prediction used only earlier ticks.</div>${rows}`;
  }
  function init() {
    const host = document.getElementById("marketMatrix");
    if (!host || document.getElementById("matchAccuracyPanel")) return;
    const panel = document.createElement("section");
    panel.id = "matchAccuracyPanel";
    panel.className = "section card card-pad";
    panel.style.marginTop = "18px";
    panel.innerHTML = `<div class="panel-title"><div><div class="eyebrow">PREDICTION ACCURACY · OUT-OF-SAMPLE</div><h2 style="margin-top:5px">Next-digit accuracy test</h2><div class="small">Tests whether the chosen Match digit matched the next historical tick. This does not alter predictions or trading.</div></div></div>
      <button class="btn primary" id="runMatchAccuracy" type="button">TEST PREDICTION ACCURACY</button>
      <div id="matchAccuracyResults" style="margin-top:12px"><div class="small">Run the test after market histories have loaded.</div></div>`;
    host.parentNode.insertBefore(panel, host.nextSibling);
    document.getElementById("runMatchAccuracy").addEventListener("click", () => {
      const source = window.MATCH_ACCURACY_DATA?.() || [];
      if (!source.length) {
        document.getElementById("matchAccuracyResults").textContent = "Market history is not ready yet. Wait for ticks to load and try again.";
        return;
      }
      const w = Math.max(100, Number(document.getElementById("matrixWindow")?.value) || 250);
      const results = source.map(s => ({ symbol: s.symbol, name: s.name,
        metrics: runOne(s.ticks, w) })).filter(r => r.metrics.ensemble.n > 0);
      if (!results.length) {
        document.getElementById("matchAccuracyResults").textContent = "At least 101 valid ticks are needed for a walk-forward test.";
        return;
      }
      render(results, w);
    });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
