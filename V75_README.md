# V75 RiseFall Engine

A standalone observation-only service for Deriv's standard Volatility 75 symbol (`R_75`). It subscribes to live ticks, retains the latest 100 ticks, displays experimental RISE/FALL/WAIT momentum signals, and evaluates each issued signal against the price after two subsequent ticks.

## Run

- Node.js 18+
- `npm install`
- `npm start`

Set `DERIV_APP_ID` to a Deriv application ID if required. The default app ID is a public demo application identifier and may be changed if Deriv rejects it.

## Important

No trades are placed. The momentum score is a heuristic, not a calibrated probability. Accuracy shown is historical observed outcomes and is not a guarantee of future performance. A connected feed is not evidence of predictive edge.

## Render

Deploy this branch as a new standalone web service using Node, build command `npm install`, start command `npm start`, region Frankfurt. Do not deploy from `main` or change any existing service.
