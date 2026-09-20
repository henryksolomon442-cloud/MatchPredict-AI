# MatchPredict AI V25.1 — Three Payment Methods

This version keeps the V25 analyzer, 2-day free trial, $100/month subscription,
separate pages, Deriv login structure, and persistent subscription database support.

## Payment methods included
1. Flutterwave
2. Pesapal
3. Binance Pay

Trust Wallet and OKX are not included in this version.

## Subscription
- 2-day free trial
- MatchPredict Pro: $100 USD / 30 days
- Analyzer access can be locked after trial expiry when `TRIAL_ENFORCEMENT=true`
- Real charging is active only when `PAYMENTS_ENABLED=true`

## Before public paid launch
1. Configure PostgreSQL and set `DATABASE_URL`.
2. Configure and test Deriv OAuth.
3. Add merchant credentials for Flutterwave, Pesapal, and/or Binance Pay.
4. Test every enabled payment provider.
5. Keep `PAYMENTS_ENABLED=false` until payment verification is confirmed.
6. Keep `TRIAL_ENFORCEMENT=false` until at least one working payment provider can unlock the analyzer.
7. After successful tests, set both switches to `true`.

Never put merchant secrets or API keys in GitHub or public HTML. Keep them in Render environment variables.
