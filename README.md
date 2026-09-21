# MatchPredict AI V25.2 — Owner Free Access + $50 Monthly

## Subscription
- New users: 2-day free trial
- MatchPredict Pro: **$50 USD / 30 days**
- Payment methods: Flutterwave, Pesapal, Binance Pay
- After the trial, analyzer access can be restricted when `TRIAL_ENFORCEMENT=true`.

## Owner account
Set this Render environment variable:

`OWNER_DERIV_ACCOUNT_ID=<your own Deriv account ID>`

When the logged-in Deriv account ID matches that value:
- the owner gets permanent analyzer access
- trial expiry is ignored for the owner
- payment is not required
- payment buttons are disabled for the owner

Do not put your Deriv account ID into GitHub code. Keep it in Render environment variables.

## Safe launch order
1. Set `OWNER_DERIV_ACCOUNT_ID`.
2. Configure a persistent `DATABASE_URL`.
3. Finish and test at least one payment provider.
4. Keep `PAYMENTS_ENABLED=false` while testing.
5. Keep `TRIAL_ENFORCEMENT=false` until payment verification works.
6. When ready for customers, enable payments and then enable trial enforcement.
