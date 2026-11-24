# Pump.fun Replay Bot — Early Momentum, Few Trades

A paper trading bot for the [Pump.fun Replay Sprint](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122): it trades 10 SOL of paper money on a 24-hour replay of pump.fun bonding-curve events, scored by net PnL.

[![make.fun](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/aam110/makefun-pumpfun-replay-bot/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/aam110/makefun-pumpfun-replay-bot/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

## Strategy

Most pump.fun coins die fast, and the 2-slot entry latency means a pump is mostly over by fill time. The bot therefore trades rarely and lets winners run:

- **Entry:** buy when a new coin's price first rises 10% above its *creation* price, with at least 1 SOL of real reserve and 3 trades behind it. First 25 signals only — every extra round trip past the guardrail minimum costs expected value.
- **Size:** 0.30 SOL per entry, capped at 1% of the coin's real reserve.
- **Slippage:** 100 bps. Fills only happen when the price has not run away during latency; a rejection costs nothing, so rejected buys are retried up to 5 times while the signal holds.
- **Exits:** take profit at +55%, hard stop at −30%. A stale exit closes anything open longer than 25,000 slots whose loss is at most 20%, recycling the scarce 5-position slots without locking in a deep dump. Take-profit and stop are measured against the effective fill price (SOL paid per token), which is what the bot can observe from a fill record.
- **Determinism:** every price comparison is exact bigint cross-multiplication — no floats, no randomness, no clock. Two runs on the same data produce byte-identical action logs.

## Backtest (dev window)

Own faithful replay of the harness, validated to the lamport against `grade-local` on the house equal-weight baseline and on this bot's first version: **net PnL +0.363 SOL, max drawdown 0.9%, 50 fills, 25 round trips on 25 distinct coins**, guardrail passed. PnL without the top 3 coins is +0.045 SOL.

## Files

- `main.ts` — the bot (entrypoint, Node stdlib only)
- `vendor/makefun-bot.ts` — the make.fun bot SDK shim, vendored
- `LICENSE` — MIT (SPDX identifier)

Bounty page: https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122
