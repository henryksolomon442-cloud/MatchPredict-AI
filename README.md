# MatchPredict AI V23.7 — Clear Signal Labels

V23.7 keeps the V23.6 workflow and makes the two percentages clearer for users.

Normal volatility result:
- MATCH 5
- DIGIT SCORE 78%

Digit Score = how strongly the normal model ranks that digit against the other digits.

10-second live scanner result:
- MATCH 5
- LIVE SIGNAL STRENGTH 96%

Live Signal Strength = how strongly the checks inside the 10-second live scanner agree on the final Match digit.

User flow:
1. SCAN FULL MARKET
2. See BEST VOLATILITY
3. Press ANALYZE BEST MATCH DIGIT
4. Wait 10 seconds
5. Read the final MATCH digit and LIVE SIGNAL STRENGTH

These percentages are internal model-strength scores. They do not guarantee a winning Deriv trade.
