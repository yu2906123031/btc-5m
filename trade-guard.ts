export interface OrderBookLevel {
  price: number;
  size: number;
}

export interface MarketBuyGuardInput {
  amount: number;
  bestBid: number;
  bestAsk: number;
  asks: OrderBookLevel[];
  maxSpread?: number;
}

const DEFAULT_MAX_SPREAD = 0.08;
const DEPTH_EPSILON = 1e-9;

export function canExecuteMarketBuy(input: MarketBuyGuardInput): boolean {
  const { amount, bestBid, bestAsk, asks, maxSpread = DEFAULT_MAX_SPREAD } = input;
  if (!Number.isFinite(amount) || amount <= 0) return false;
  if (!Number.isFinite(bestBid) || !Number.isFinite(bestAsk) || bestBid <= 0 || bestAsk <= 0) return false;
  const spread = bestAsk - bestBid;
  if (!Number.isFinite(spread) || spread < 0 || spread > maxSpread) return false;
  let remaining = amount;
  for (const level of asks) {
    if (!Number.isFinite(level.price) || !Number.isFinite(level.size)) continue;
    if (level.price <= 0 || level.size <= 0) continue;
    remaining -= level.size;
    if (remaining <= DEPTH_EPSILON) return true;
  }
  return false;
}
