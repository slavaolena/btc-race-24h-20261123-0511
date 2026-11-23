/**
 * btc-race-24h trading bot (from scratch)
 *
 * Operates on the *24h* race window: the bot only trades when the running wall-clock window has
 * rolled over, and it carries a fresh daily state per symbol (entry, targets, trailing logic) that
 * resets on the 24h boundary. When running in replay via `vendor/makefun-bars.ts`, the same policy
 * is applied once per bar so a scored run can be backtested deterministically; the wall-clock 24h
 * gating is present for live use via `runLive()`.
 */

import { runBars, type BarsState, type Batch } from './vendor/makefun-bars.ts';

// ---------------------------------------------------------------------------- protocol constants

const PROTOCOL = 'btc-race-24h';

// ---------------------------------------------------------------------------- strategy config (24h race)

/** Symbols watched in this race. The harness provides the real universe in hello; these are only
 * defaults used by the live path before hello arrives. */
const RACE_SYMBOLS = ['BTCUSDT'] as const;

/** Live mode only: longest we wait (ms) for an exchange snapshot before restarting the 24h window. */
const LIVE_SNAP_MAX_AGE_MS = 5 * 60_000; // 5 min

// Live 24h window control
const RACE_WINDOW_MS = 24 * 60 * 60_000; // 24h

// ---------------------------------------------------------------------------- position / risk params (24h horizon)

/** Max quote units any single symbol may spend per 24h cycle at the moment of entry, as a fraction
 * of current equity. Kept conservative for a race-length horizon. */
const MAX_WEIGHT_BPS_PER_SYMBOL = 2_000; // 20%

/**Max notional per entry (quote units). Prevents one oversized fill from eating the entire budget. */
const MAX_ENTRY_NOTIONAL_QUOTE_UNITS = 1_000_000n; // 1M USDC-equivalent cap

/**Slippage bundle: slippage + impact budgeting. Tight for race execution. */
const MAX_SLIPPAGE_BPS = 250; // 2.5%

/**Profit targets measured as bps from a symbol's 24h entry close. Multiple targets allow partial
 * scaling within a single daily cycle. */
const TP1_BPS = 150; // 1.5%
const TP2_BPS = 400; // 4.0%

/**Loss limit for the 24h cycle. Hard exit on breach (protects the race). */
const HARD_STOP_BPS = -450; // -4.5%

/**Trail activates once a position is in profit by this many bps; trails by this many bps. */
const TRAIL_ACTIVATION_BPS = 150;
const TRAIL_OFFSET_BPS = 150;

// ---------------------------------------------------------------------------- types for the in-memory 24h state

/**Per-symbol 24h cycle state kept by the bot. Reset when the race window rolls over. */
interface CycleState {
  /** Has this symbol been entered this 24h cycle? */
  entered: boolean;
  /** Close price (in quote scale) at the moment of the cycle's entry, or 0 if not entered. */
  entryClose: bigint;
  /** Quantity held (in symbol-native scale) for this cycle. */
  qty: bigint;
  /** Fill cost in quote units for this cycle (used only for bookkeeping; fills come from harness). */
  costQuoteUnits: bigint;
  /** Best price seen since entry (used for trail calc). */
  bestCloseSoFar: bigint;
  /** Highest trailing stop close seen before the current best; irrelevant until entered. */
  trailingStopClose: bigint;
  /** Whether a partial sell at TP1 has already been taken this cycle. */
  tp1Taken: boolean;
}

// ---------------------------------------------------------------------------- live vs replay

/**Whether the bot is running in live mode. In replay mode (runBars), this stays false and the
 * 24h gating is evaluated once per bar (deterministic backtestable behavior). Live mode is off by
 * default and can be enabled with `--live` cli arg. */
const LIVE = Deno?.args.includes('--live') ?? false;

// ---------------------------------------------------------------------------- helpers

/**Returns true when the current wall-clock instant is past the next 24h boundary given the provided
 * epoch origin. Used by the live path to enforce a clean reset of per-symbol state. */
function past24hBoundarySince(epochMs: number, nowMs: number): boolean {
  const elapsed = nowMs - epochMs;
  if (elapsed < 0) return false;
  return (elapsed % RACE_WINDOW_MS) === 0n ? true : (elapsed % RACE_WINDOW_MS) < 0n
    ? (RACE_WINDOW_MS - (elapsed % RACE_WINDOW_MS)) > 0n
    : false;
}

/**Straight-line 24h return in bps from entryClose to currentClose. */
function returnBps(entryClose: bigint, currentClose: bigint): bigint {
  if (entryClose === 0n || entryClose <= 0n) return 0n;
  return ((currentClose - entryClose) * 10_000n) / entryClose;
}

/**Build a new client_id that hasn't been used in this run. The harness shim also auto-assigns one
 * if omitted, but assigning ours keeps logs stable across the two-run byte-match requirement. */
function nextClientId(state: BarsState): string {
  // Use the harness-provided sequence so ids are stable and unique per batch.
  return `c${state.seq + 1}n`;
}

// ---------------------------------------------------------------------------- strategy (replay / backtest path)

export async function runBarsStrategy(state: BarsState) {
  // In replay, forget the live 24h wall-clock gating; act on every batch deterministically.
  // We still maintain a 24h-style cycle per symbol: once entered, we manage risk to target until
  // flat, then allow a fresh entry later in the same scored window (which is fine for race replay).
  for (const symbol of RACE_SYMBOLS) {
    const close = state.close(symbol);
    if (close === null) continue;

    // Initialize cycle state lazily on first bar if absent.
    let cycle = state.cycleState.get(symbol);
    if (cycle === null) {
      cycle = {
        entered: false,
        entryClose: 0n,
        qty: 0n,
        costQuoteUnits: 0n,
        bestCloseSoFar: 0n,
        trailingStopClose: 0n,
        tp1Taken: false,
      };
      state.cycleState.set(symbol, cycle);
    }

    const hasPos = cycle.qty > 0n;

    // ---- exit management ----
    if (hasPos) {
      const rBps = returnBps(cycle.entryClose, close);
      const hardHit = rBps <= HARD_STOP_BPS;

      // Trail update
      if (close > cycle.bestCloseSoFar) {
        cycle.bestCloseSoFar = close;
        // Activate trail once in profit enough
        if (!cycle.tp1Taken || rBps >= TRAIL_ACTIVATION_BPS) {
          cycle.trailingStopClose = (close * (10_000n - TRAIL_OFFSET_BPS)) / 10_000n;
        }
      }

      // Hard stop overrides everything.
      if (hardHit) {
        cycle.entered = false;
        cycle.qty = 0n;
        cycle.costQuoteUnits = 0n;
        cycle.bestCloseSoFar = 0n;
        cycle.trailingStopClose = 0n;
        cycle.tp1Taken = false;
        return [{
          side: 'sell',
          client_id: nextClientId(state),
          symbol,
          qty: cycle.qty,
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        }];
      }

      // Profit targets
      if (!cycle.tp1Taken && rBps >= TP1_BPS) {
        // Partial: take half at TP1
        const half = cycle.qty / 2n;
        if (half > 0n) {
          cycle.qty -= half;
          cycle.tp1Taken = true;
          // Rebaseline trailing after partial so it tracks the remaining position.
          cycle.bestCloseSoFar = close;
          cycle.trailingStopClose = (close * (10_000n - TRAIL_OFFSET_BPS)) / 10_000n;
          return [{
            side: 'sell',
            client_id: nextClientId(state),
            symbol,
            qty: half,
            max_slippage_bps: MAX_SLIPPAGE_BPS,
          }];
        }
      }

      if (rBps >= TP2_BPS && cycle.qty > 0n) {
        // Full exit at TP2 if anything remains
        const remaining = cycle.qty;
        cycle.entered = false;
        cycle.qty = 0n;
        cycle.costQuoteUnits = 0n;
        cycle.bestCloseSoFar = 0n;
        cycle.trailingStopClose = 0n;
        cycle.tp1Taken = false;
        return [{
          side: 'sell',
          client_id: nextClientId(state),
          symbol,
          qty: remaining,
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        }];
      }

      // Trailing stop exit: triggered if current close <= trailing stop close.
      if (cycle.qty > 0n && close <= cycle.trailingStopClose) {
        const remaining = cycle.qty;
        cycle.entered = false;
        cycle.qty = 0n;
        cycle.costQuoteUnits = 0n;
        cycle.bestCloseSoFar = 0n;
        cycle.trailingStopClose = 0n;
        cycle.tp1Taken = false;
        return [{
          side: 'sell',
          client_id: nextClientId(state),
          symbol,
          qty: remaining,
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        }];
      }

      continue;
    }

    // ---- entry ---
    // Do not re-enter this cycle if we already took a partial or full exit.
    if (cycle.entered) continue;

    // Entry signal: 24h race context uses a simple momentum filter on the latest bar. We enter if
    // the bar is "green" in quote terms (close > open) and the close is not too far from open in
    // absolute bps, to avoid chasing extreme moves late in the race.
    const open = state.latest.get(symbol)?.o;
    if (open === undefined || open === null) continue;
    const openB = BigInt(open);

    const changeBps = ((close - openB) * 10_000n) / openB;
    if (changeBps <= 0n) continue; // no long entry on non-positive bars

    // Keep entry within a reasonable intraday range band to reduce late-race chase risk.
    if (changeBps > 800n) continue; // skip explosive late bars

    // Budget / caps
    const roomBps = state.weightRoom(symbol);
    if (roomBps <= 0n) continue;

    const capBps = BigInt(state.hello.caps.max_weight_bps);
    const budgetBps = capBps * state.equity;
    const maxByWeight = budgetBps / BPS;

    // Use the smaller of weight room, explicit per-symbol cap, and a notional ceiling.
    const spendByWeight = roomBps < maxByWeight ? roomBps : maxByWeight;
    const spend = spendByWeight < MAX_ENTRY_NOTIONAL_QUOTE_UNITS
      ? spendByWeight
      : MAX_ENTRY_NOTIONAL_QUOTE_UNITS;

    // Min notional guard from hello fees
    const minNotional = BigInt(state.hello.fees.min_notional_quote_units);
    if (spend < minNotional) continue;

    // Convert spend (quote units) to qty using the latest close and symbol scales.
    const symbolInfo = state.symbols.get(symbol);
    if (!symbolInfo) continue;

    const priceScale = BigInt(symbolInfo.price_scale);
    const qtyScale = BigInt(symbolInfo.qty_scale);
    const closeForQty = close; // close is in price scale already
    const qty = (spend * 10n ** qtyScale) / (closeForQty * 10n ** priceScale);
    if (qty <= 0n) continue;

    cycle.entered = true;
    cycle.entryClose = close;
    cycle.qty = qty;
    cycle.costQuoteUnits = spend;
    cycle.bestCloseSoFar = close;
    cycle.trailingStopClose = (close * (10_000n - TRAIL_OFFSET_BPS)) / 10_000n;

    return [{
      side: 'buy',
      client_id: nextClientId(state),
      symbol,
      notional_quote_units: spend,
      max_slippage_bps: MAX_SLIPPAGE_BPS,
    }];
  }

  return [];
}

// ---------------------------------------------------------------------------- main entry point

await runBars({
  onHello(state) {
    if (LIVE) {
      console.error(`[${PROTOCOL}] live mode enabled; gating trades on current wall-clock 24h window`);
    }
    // Attach a private map to state for per-symbol 24h cycle state. This map survives across
    // batches because `runBars` hands us the same state object each callback.
    Object.defineProperty(state, 'cycleState', {
      value: new Map<string, CycleState>(),
      writable: false,
      enumerable: false,
      configurable: true,
    });

    // If live, seed the window origin from the first hello's first_close_ms so the 24h boundary
    // is deterministic relative to the race start, not `Date.now()`.
    const firstClose = state.hello.first_close_ms;
    if (LIVE && typeof firstClose === 'number') {
      state.cycleWindowOrigin = firstClose;
    }
  },

  async onBatch(state, batch) {
    if (LIVE) {
      // Live gating: if we crossed a 24h boundary since the race start, reset all cycle state.
      const now = Date.now();
      const origin = (state as any).cycleWindowOrigin as number | undefined;
      if (origin && past24hBoundarySince(origin, now)) {
        state.cycleState.clear();
      }
      // Also reset state if it has been too long since a snapshot arrived (race data staleness).
      const age = now - batch.t;
      if (age > LIVE_SNAP_MAX_AGE_MS) {
        console.error(`[${PROTOCOL}] batch stale by ${age}ms; clearing cycle state`);
        state.cycleState.clear();
      }
    }

    return runBarsStrategy(state);
  },

  onDone(state, done) {
    // Anything still held at the end is flattened by the harness; we just log the final cycle.
    if (LIVE) {
      console.error(`[${PROTOCOL}] race done; final equity ${state.equity}`);
    }
  },
});

console.error(`[${PROTOCOL}] bot running: live=${LIVE}`);
