# MatchPredict AI V22 — Video-Style Platform Build

This is a fresh platform build inspired by the workflow and feel shown in the reference video, without copying its branding or exact design.

## What is included

### Opening platform experience
- Dark professional trading dashboard
- MatchPredict AI branding
- Deriv authentication panel
- Public-mode fallback
- Pricing / access section
- Templates area

### Digits / Match Number engine
- Live Deriv public market-data connection
- Synthetic/volatility market selector
- Historical tick loading
- Live tick subscription
- Match candidate 0–9
- Four-model agreement
- Digit ranking
- Recent last-digit sequence
- Explanation/ranking metrics

### One-click research engine
- Manual next-tick paper test
- Automatic paper-test mode
- 3/4 agreement filter
- Trade history
- Wins/losses/hit-rate tracking
- Session progress bar

### Authentication
Deriv OAuth 2.0 + PKCE structure is included.
The user enters their password only on Deriv's own login page.

Public scanning does not require login.

To activate OAuth after deployment, register:
`https://YOUR-DOMAIN/auth/deriv/callback`

and configure:
- `DERIV_OAUTH_CLIENT_ID`
- `APP_BASE_URL`
- `SESSION_SECRET`

## Easiest way to run on Windows

Double-click:

`START_APP_WINDOWS.bat`

It installs packages if needed, starts the server, and opens:
`http://localhost:3000`

Or from VS Code terminal:

```powershell
npm.cmd install
npm.cmd start
```

## Important scope

The automatic engine in V22 is **paper testing**, not real-money automatic trading.
The current dashboard does not fake account balances or fake profits.

Prediction scores are heuristic rankings from observed tick data, not guaranteed probabilities.
