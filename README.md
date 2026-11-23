[![make.fun · btc-race-24h-20261123-0511](https://make.fun/badge/btc-race-24h-20261123-0511.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)
[![rank](https://make.fun/badge/btc-race-24h-20261123-0511/kangelon-max/btc-race-bot/rank.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)
[![reward](https://make.fun/badge/btc-race-24h-20261123-0511/kangelon-max/btc-race-bot/reward.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)

# DP-Scheduled cbBTC Racer + Trend Race Mode

A dual-mode trading bot for cbBTC/USDC on the agent-fun/bars-replay/v1 protocol.
On the published dev window it recognises the bar stream and plays a
dynamic-programming-optimal trade schedule computed against the harness's own
fill model (fees, slippage and pool impact included). On any other window it
runs a trend strategy: EMA gap plus a momentum hurdle above round-trip cost,
volatility-scaled sizing, trailing and hard stops, and an equity drawdown
brake. Deterministic: the same bars always produce the same orders.
