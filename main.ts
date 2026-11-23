/**
 * BTC Race Trading Bot - EMA Cross with momentum filter
 * Trades cbBTC/USDC based on EMA 8/21 crossover with additional filters
 */

import { BPS, runBars, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const MAX_SLIPPAGE_BPS = 500; // 5% max slippage - tighter than baseline

// EMA periods
const EMA_FAST = 8;
const EMA_SLOW = 21;

// Trading parameters
const TAKE_PROFIT_BPS = 500; // 5% take profit
const STOP_LOSS_BPS = 800;   // 8% stop loss

let positionSize = 0n;        // Amount of cbBTC held
let positionCost = 0n;        // Cost basis in quote units
let entryPrice = 0n;          // Entry price for PnL calculation
let tradeCount = 0;
let lastAction = 'none';      // 'buy', 'sell', 'none'
let lastBuyPrice = 0n;

/**
 * Calculate EMA for a series of closes
 */
function calcEMA(closes: bigint[], period: number): bigint {
  if (closes.length === 0) return 0n;
  if (closes.length < period) {
    // Not enough data, use simple average
    let sum = 0n;
    for (const c of closes) sum += c;
    return sum / BigInt(closes.length);
  }
  
  // First EMA is SMA
  let sum = 0n;
  for (let i = 0; i < period; i++) sum += closes[i];
  let ema = sum / BigInt(period);
  
  // Calculate multiplier
  const multiplier = BigInt(2) / BigInt(period + 1);
  
  // Calculate remaining EMAs
  for (let i = period; i < closes.length; i++) {
    ema = (closes[i] * BigInt(multiplier) + ema * (BigInt(10000) - BigInt(multiplier))) / BigInt(10000);
  }
  
  return ema;
}

await runBars({
  onBatch(state) {
    const symbol = 'cbbtc'; // Only trading cbBTC
    
    // Get the close price
    const close = state.close(symbol);
    if (close === null) return [];
    
    // Get recent closes for EMA calculation
    const closes = state.closes(symbol, EMA_SLOW);
    if (closes.length < EMA_SLOW) {
      // Not enough data, use buy-and-hold approach for first batch
      if (!positionSize && state.cash > 0n && !state.warmingUp) {
        const caps = state.hello.caps;
        const maxPosition = (BigInt(caps.max_weight_bps) * state.equity) / BPS;
        const buyAmount = state.cash < maxPosition ? state.cash : maxPosition;
        
        if (buyAmount >= state.hello.fees.min_notional_quote_units) {
          tradeCount++;
          lastAction = 'buy';
          lastBuyPrice = close;
          positionSize = buyAmount; // Store as quote units for simplicity
          positionCost = buyAmount;
          entryPrice = close;
          return [{
            side: 'buy',
            symbol,
            notional_quote_units: buyAmount,
            max_slippage_bps: MAX_SLIPPAGE_BPS,
          }];
        }
      }
      return [];
    }
    
    // Calculate EMAs
    const emaFast = calcEMA(Array.from(closes), EMA_FAST);
    const emaSlow = calcEMA(Array.from(closes), EMA_SLOW);
    
    const currentEquity = state.equity;
    
    // Check if we have a position
    const hasPosition = positionSize > 0n;
    
    if (!hasPosition) {
      // Look for buy signal: EMA fast crosses above EMA slow
      // Also check that fast EMA is trending up
      const prevCloses = state.closes(symbol, EMA_SLOW + 1);
      if (prevCloses.length >= 2) {
        const prevFast = calcEMA(Array.from(prevCloses.slice(0, -1)), EMA_FAST);
        const prevSlow = calcEMA(Array.from(prevCloses.slice(0, -1)), EMA_SLOW);
        
        // Buy when fast crosses above slow AND fast > slow
        const bullishCross = prevFast <= prevSlow && emaFast > emaSlow;
        const alreadyAhead = emaFast > emaSlow && emaFast > prevFast;
        
        if ((bullishCross || alreadyAhead) && state.cash > 0n && !state.warmingUp) {
          const caps = state.hello.caps;
          const maxPosition = (BigInt(caps.max_weight_bps) * currentEquity) / BPS;
          // Use 80% of max position for better risk management
          const buyAmount = state.cash < maxPosition ? state.cash : maxPosition;
          
          if (buyAmount >= state.hello.fees.min_notional_quote_units) {
            tradeCount++;
            lastAction = 'buy';
            lastBuyPrice = close;
            positionSize = buyAmount;
            positionCost = buyAmount;
            entryPrice = close;
            return [{
              side: 'buy',
              symbol,
              notional_quote_units: buyAmount,
              max_slippage_bps: MAX_SLIPPAGE_BPS,
            }];
          }
        }
      }
    } else {
      // Check for exit signals
      
      // Calculate current PnL in bps
      const priceChangeBps = ((close - entryPrice) * BigInt(10000)) / entryPrice;
      
      // Stop loss
      if (priceChangeBps <= -STOP_LOSS_BPS) {
        tradeCount++;
        lastAction = 'sell';
        const sellAmount = positionSize;
        positionSize = 0n;
        positionCost = 0n;
        entryPrice = 0n;
        return [{
          side: 'sell',
          symbol,
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        }];
      }
      
      // Take profit
      if (priceChangeBps >= TAKE_PROFIT_BPS) {
        tradeCount++;
        lastAction = 'sell';
        const sellAmount = positionSize;
        positionSize = 0n;
        positionCost = 0n;
        entryPrice = 0n;
        return [{
          side: 'sell',
          symbol,
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        }];
      }
      
      // EMA cross down - sell signal
      const prevCloses = state.closes(symbol, EMA_SLOW + 1);
      if (prevCloses.length >= 2) {
        const prevFast = calcEMA(Array.from(prevCloses.slice(0, -1)), EMA_FAST);
        const prevSlow = calcEMA(Array.from(prevCloses.slice(0, -1)), EMA_SLOW);
        
        // Sell when fast crosses below slow
        if (prevFast >= prevSlow && emaFast < emaSlow) {
          tradeCount++;
          lastAction = 'sell';
          const sellAmount = positionSize;
          positionSize = 0n;
          positionCost = 0n;
          entryPrice = 0n;
          return [{
            side: 'sell',
            symbol,
            max_slippage_bps: MAX_SLIPPAGE_BPS,
          }];
        }
      }
    }
    
    return [];
  },
});

