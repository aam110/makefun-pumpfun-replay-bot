// Early-momentum paper bot for the pump.fun replay: buy the first sign of life
// on a new bonding curve, take profit on a real move, cut losers fast, and
// recycle slots that go quiet instead of letting them rot.
//
// Why this shape (measured on the dev window, not assumed):
//   - Most coins die fast: the median coin never reaches 1.15x its first price,
//     and pumps dump hard (final/max price median 0.33). Chasing momentum with
//     wide exits loses several SOL; the winning shape is FEW trades, each with
//     a wide take-profit and a hard stop, so one 2-3x runner pays for the losers.
//   - Entry latency is the central problem: the price 2 slots after a +10%
//     signal is a median +11.5% higher, so the pump is mostly over by fill
//     time. The fix is a TIGHT slippage cap (100 bps): fills only happen when
//     the price has not run away during latency, and a rejection costs nothing,
//     so rejected buys are retried while the signal holds.
//   - The 5-position cap is the scarcest resource. Positions that neither hit
//     TP nor stop would sit forever and block new entries, so a stale exit
//     closes anything open >25,000 slots whose loss is at most 20% — it frees
//     the slot without locking in a deep dump.
//   - An entry cap (25 coins) bounds the total negative-EV drag: every extra
//     round trip past the guardrail minimum costs expected value, so the bot
//     stops entering once it has its 25.
//   - The reference price is the CREATION price (from the CreateEvent), not the
//     first trade: the creator's own buy already moves the price, so measuring
//     from creation catches the move earlier.
//   - The take-profit / stop reference is the EFFECTIVE fill price (SOL paid
//     per token, fees included), because that is what the bot can observe from
//     a fill record. The first version tuned TP/stop against the curve price
//     at fill time, which the bot cannot see; grade-local exposed the gap
//     (+0.239 SOL vs +0.444 predicted), the backtest was fixed to use the
//     effective price (reproducing grade-local to the lamport), and TP/stop
//     were re-tuned to +55% / -30% on the corrected backtest.
//
// Backtest (own faithful replay of the harness, validated to the lamport
// against grade-local on the house equal-weight baseline AND on this bot's
// first version): net PnL +0.363 SOL, max drawdown 0.9%, 50 fills, 25 round
// trips on 25 distinct coins, guardrail passed. PnL without the top 3 coins
// is +0.045 SOL, so the result is not one lucky coin.
//
// Determinism: all price comparisons are exact bigint cross-multiplications
// (no floats, no randomness, no clock). Iteration order is the batch's event
// order and the account's mint-sorted position order, both fixed by the
// harness. Two runs on the same data produce byte-identical action logs.

import { runBot, type Batch, type BotState, type OrderInput } from './vendor/makefun-bot.ts';

// --- strategy constants (backtested) ---
const STAKE_LAMPORTS = 300_000_000n; // 0.30 SOL per entry, capped by 1% of real reserve
const MIN_RT_LAMPORTS = 10_000_000n; // 0.01 SOL: the guardrail's round-trip minimum
const MIN_RQ_LAMPORTS = 1_000_000_000n; // 1 SOL of real reserve before entry
const MIN_TRADES = 3;
// Price ratios as exact fractions (numerator/denominator), compared by
// cross-multiplication so no floating point ever enters a decision.
const ENTRY_NUM = 11n; // entry at >= 1.10x the creation price
const ENTRY_DEN = 10n;
const TP_NUM = 31n; // take profit at +55% over the entry price
const TP_DEN = 20n;
const STOP_NUM = 7n; // hard stop at -30% under the entry price
const STOP_DEN = 10n;
const STALE_NUM = 4n; // stale exit only when the loss is at most 20%
const STALE_DEN = 5n;
const STALE_SLOTS = 25_000;
const ENTRY_CAP = 25;
const SLIPPAGE_BPS = 100;
const MAX_RETRIES = 5;

// --- state ---
/** Creation reserves per mint, from its CreateEvent (the entry reference). */
const creation = new Map<string, { vq: bigint; vt: bigint }>();
/** Mints entered once (one trade per coin; also enforces the entry cap). */
const entered = new Set<string>();
/** Buy retries after a rejection, per mint. */
const retries = new Map<string, number>();
/** Entry reference per held position: what the fill paid, tokens received, fill slot. */
const entryRef = new Map<string, { paid: bigint; tokens: bigint; slot: number }>();

/** True when aq/at >= (bq/bt) * (num/den), by exact bigint cross-multiplication. */
function gteRatio(aq: bigint, at: bigint, bq: bigint, bt: bigint, num: bigint, den: bigint): boolean {
  return aq * bt * den >= bq * at * num;
}

/** True when aq/at <= (bq/bt) * (num/den), by exact bigint cross-multiplication. */
function lteRatio(aq: bigint, at: bigint, bq: bigint, bt: bigint, num: bigint, den: bigint): boolean {
  return aq * bt * den <= bq * at * num;
}

await runBot({
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    const orders: OrderInput[] = [];
    const { caps } = state.hello;
    const tx = state.txFeeLamports();
    let free = state.freeCashLamports();
    const slot = batch.slot;

    // 1. Record creation prices from this batch's CreateEvents.
    for (const e of batch.events) {
      if (e.event === 'CreateEvent' && !creation.has(e.mint)) {
        creation.set(e.mint, { vq: BigInt(e.virtual_quote_reserves), vt: BigInt(e.virtual_token_reserves) });
      }
    }

    // 2. Process fills: entry refs for buy fills, retries for rejected buys.
    for (const f of batch.fills) {
      if (f.side === 'buy' && f.status === 'filled') {
        entryRef.set(f.mint, { paid: BigInt(f.quote_lamports), tokens: BigInt(f.token_amount), slot: f.slot });
      } else if (f.side === 'buy' && f.status === 'rejected') {
        const n = (retries.get(f.mint) ?? 0) + 1;
        retries.set(f.mint, n);
        // Rejections are free: retry while the signal holds.
        if (n <= MAX_RETRIES) entered.delete(f.mint);
      }
    }
    // Drop entry refs for positions no longer held (sold, completed, flattened).
    for (const mint of [...entryRef.keys()]) {
      if (!state.positions.has(mint)) entryRef.delete(mint);
    }

    // 3. Exits. Marks carry the offset reserves (the bot's own impact included),
    // which is the price the harness fills against; fall back to the curve.
    const marks = new Map(batch.marks.map((m) => [m.mint, m]));
    let committed = state.committedPositionCount();
    for (const [mint, holding] of state.positions) {
      const ref = entryRef.get(mint);
      if (ref === undefined) continue;
      const mark = marks.get(mint);
      const curve = state.curves.get(mint);
      let vq: bigint;
      let vt: bigint;
      if (mark !== undefined) {
        vq = BigInt(mark.virtual_quote_reserves);
        vt = BigInt(mark.virtual_token_reserves);
      } else if (curve !== undefined) {
        vq = curve.virtual_quote_reserves;
        vt = curve.virtual_token_reserves;
      } else {
        continue;
      }
      if (vt === 0n) continue;
      const age = slot - ref.slot;
      let sell = false;
      if (lteRatio(vq, vt, ref.paid, ref.tokens, STOP_NUM, STOP_DEN)) sell = true; // hard stop -30%
      else if (gteRatio(vq, vt, ref.paid, ref.tokens, TP_NUM, TP_DEN)) sell = true; // take profit +55%
      else if (age > STALE_SLOTS && gteRatio(vq, vt, ref.paid, ref.tokens, STALE_NUM, STALE_DEN)) sell = true; // stale, loss <= 20%
      if (sell) {
        orders.push({ side: 'sell', mint, token_amount: holding.token_amount, max_slippage_bps: SLIPPAGE_BPS });
        committed -= 1;
      }
    }
    if (orders.length >= caps.max_orders_per_batch) return orders;

    // 4. Entries, in the batch's event order: first +10% over creation with
    // real reserve and a few trades behind it, first 25 signals only.
    for (const e of batch.events) {
      if (e.event !== 'TradeEvent') continue;
      if (orders.length >= caps.max_orders_per_batch || committed >= caps.max_open_positions) break;
      if (entered.size >= ENTRY_CAP) break;
      const mint = e.mint;
      if (entered.has(mint) || state.positions.has(mint)) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete || curve.trades < MIN_TRADES) continue;
      const c0 = creation.get(mint);
      if (c0 === undefined || curve.virtual_token_reserves === 0n) continue;
      if (!gteRatio(curve.virtual_quote_reserves, curve.virtual_token_reserves, c0.vq, c0.vt, ENTRY_NUM, ENTRY_DEN)) continue;
      if (curve.real_quote_reserves < MIN_RQ_LAMPORTS) continue;
      const cap = state.maxBuyLamports(mint);
      const amount = cap < STAKE_LAMPORTS ? cap : STAKE_LAMPORTS;
      if (amount < MIN_RT_LAMPORTS) continue;
      if (free < amount + tx) continue;
      orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: SLIPPAGE_BPS });
      entered.add(mint);
      free -= amount + tx;
      committed += 1;
    }
    return orders;
  },
});
