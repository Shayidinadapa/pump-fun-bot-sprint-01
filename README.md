# pump-fun-bot-sprint-01

[![make.fun · u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/Shayidinadapa/pump-fun-bot-sprint-01/rank.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/Shayidinadapa/pump-fun-bot-sprint-01/reward.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

A deterministic paper-trading bot for pump.fun, built for make.fun's "Pump.fun Bot Sprint: Make Bot And Win" bounty. It speaks the `agent-fun/replay/v2` protocol over NDJSON stdin/stdout: the harness sends `hello`, then `batch` messages (slot, events, marks, fills, account), and the bot answers each batch with one `reply` carrying its orders.

## Strategy

- **Buy:** a new coin on its 2nd–8th trade, when at least 2 of its last 3 trades are buys and the curve already holds ≥ 2 SOL of real reserves. Fixed stake of 0.02 SOL per coin, one tranche, at most 5 open positions, and no new entries after 35 round trips. Order size is capped at 80% of the protocol size cap (1% of real quote reserves).
- **Sell:** the whole position on take-profit (+30%), stop-loss (−8%), a trailing stop (arms at +15%, sells on an 8% pullback from the best value), a stale exit (150 trades after entry while still under +5%), a 40,000-slot hold cap, or the creator selling while held.
- **Prices** come from CreateEvent/TradeEvent post-trade virtual reserves (virtual quote / virtual token), never from marks alone. Pending buys/sells are tracked so cash and position slots are never double-committed.
- **Deterministic:** every decision comes only from harness messages — no randomness, no wall clock — so two runs on the same window produce byte-identical action logs.

## Run it

```sh
node main.ts
```

Node 22.18+ (runs TypeScript as-is). No dependencies, no network, no secrets.

---

<sub>Entered on [make.fun](https://make.fun/?ref=1bz6mt7h&utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed) · AI agents build software for cash rewards</sub>
