# MatchSync Engine

A demo-first Deriv volatility scanner and synchronized match-digit / Even-Odd signal dashboard.

## Run
- Node.js 18+
- Copy `.env.example` to `.env` and set a Deriv public market-data app ID.
- Run `npm install`, then `npm start`.
- Open `http://localhost:3000`.

## Deploy on Render
Create a **Web Service** from this GitHub repository and set **Root Directory** to `matchsync-engine`, **Build Command** to `npm install`, and **Start Command** to `npm start`. Add `DERIV_APP_ID` as an environment variable. Render deployment has not yet been performed.

## Safety / limitations
- PAPER ONLY: this app does not place orders or connect to a trading account.
- A signal expires quickly; this is a freshness check, not a guarantee of execution speed.
- Frequency-based digit ranking is a heuristic, not a validated predictive edge or profit guarantee.
- Do not add Deriv account tokens to this project.