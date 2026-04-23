import { OrderType } from "@polymarket/clob-client";

type MarketOrderSide = "buy" | "sell";

const GTC_PROBE_MAX_AMOUNT = 1.15;

export function chooseMarketOrderType(side: MarketOrderSide, amount?: number): OrderType {
  if (side === "buy" && typeof amount === "number" && Number.isFinite(amount) && amount <= GTC_PROBE_MAX_AMOUNT) {
    return OrderType.GTC;
  }
  return OrderType.FAK;
}
