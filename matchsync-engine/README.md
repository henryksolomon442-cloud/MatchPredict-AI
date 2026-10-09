# MatchSync Engine

A demo-first Deriv volatility scanner and synchronized match-digit / Even-Odd signal dashboard.

## Run
- Node.js 18+
- Copy `.env.example` to `.env` and set a Deriv public market-data app ID.
- Run `npm install`, then `npm start`.
- Open `http://localhost:3000`.

## Deploy on Render
The live Render service uses the repository-root `Dockerfile`, which copies `matchsync-engine/` into the image. Keep it as a separate Render Web Service and set `DERIV_APP_ID` in the service environment. Verify that the dashboard reports fresh live ticks before relying on scanner output.

## Safety / limitations
- PAPER ONLY: this app does not place orders or connect to a trading account.
- A signal expires quickly; this is a freshness check, not a guarantee of execution speed.
- Frequency-based digit ranking is a heuristic, not a validated predictive edge or profit guarantee.
- Do not add Deriv account tokens to this project.

## DigitEdge synchronization API (paper-only)
- The protected `POST /api/ingest-signal` endpoint is designed to receive a fresh DigitEdge prediction and synchronize its symbol, match digit, and Even/Odd side into the dashboard.
- Set a long, unique `SYNC_API_KEY` in the Render service environment (never commit it to GitHub or put it in browser code). Until configured, the endpoint returns `503 SYNC_DISABLED`.
- Send the key in the `x-sync-key` header. JSON body: `{ "symbol": "1HZ50V", "matchDigit": 3, "evenOdd": "ODD", "generatedAt": 1791552000000, "sourceId": "unique-prediction-id", "confidence": 0.62 }`. Replace the example timestamp with the current Unix timestamp in milliseconds.
- Only configured symbols are accepted; the prediction timestamp must be no more than 10 seconds old; the matching market must have a fresh tick; duplicate `sourceId` values are rejected.
- A successful response means the signal was accepted by this service, not that a trade was placed. Execution remains disabled. No Deriv account token or DBot live-order command is used.


## Demo execution bridge
- The server includes a Deriv WebSocket executor that authorizes with `DERIV_DEMO_TOKEN` and fails closed unless Deriv confirms the account is virtual/demo (`is_virtual`).
- To activate demo execution, configure a virtual/demo API token with trading permission as the Render secret `DERIV_DEMO_TOKEN`, configure a long random `SYNC_API_KEY`, and set `DEMO_TRADING_ENABLED=true` plus `DEMO_AUTO_EXECUTE=true`. Never put either secret in GitHub, the dashboard HTML, or a chat message.
- Default stake cap is USD/account-currency 0.35 (the service hard-caps it at 0.35), one-tick duration, Even/Odd contracts, and at least a 10-second cooldown. These limits can still result in losses on demo balances; validate carefully before considering anything beyond demo.
- Only accepted, fresh DigitEdge-ingested signals can trigger auto-execution. The executor requests a price proposal, then buys the returned proposal, and records the Deriv contract ID. Non-demo accounts are blocked.
- A confirmed demo order is a real order on the virtual account, not a paper simulation. It is not a real-money trade. Live-money trading is intentionally not enabled by this bridge.
- The 10-second target is a goal, not a guarantee; verify measured latency from DigitEdge prediction to Deriv order confirmation.
