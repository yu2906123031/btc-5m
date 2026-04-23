import test from "node:test";
import assert from "node:assert/strict";

import { canExecuteMarketBuy } from "../trade-guard.js";

test("blocks market buy when spread is too wide", () => {
  const ok = canExecuteMarketBuy({
    amount: 1,
    bestBid: 0.58,
    bestAsk: 0.78,
    asks: [{ price: 0.78, size: 5 }],
  });

  assert.equal(ok, false);
});

test("blocks market buy when ask depth cannot fill requested amount", () => {
  const ok = canExecuteMarketBuy({
    amount: 3,
    bestBid: 0.61,
    bestAsk: 0.63,
    asks: [{ price: 0.63, size: 1.2 }, { price: 0.64, size: 0.7 }],
  });

  assert.equal(ok, false);
});

test("allows market buy when spread is reasonable and ask depth is sufficient", () => {
  const ok = canExecuteMarketBuy({
    amount: 2,
    bestBid: 0.61,
    bestAsk: 0.63,
    asks: [{ price: 0.63, size: 1.2 }, { price: 0.64, size: 1.1 }],
  });

  assert.equal(ok, true);
});
