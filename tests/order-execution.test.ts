import test from "node:test";
import assert from "node:assert/strict";
import { OrderType } from "@polymarket/clob-client";

import { chooseMarketOrderType } from "../order-execution.js";

test("chooseMarketOrderType upgrades small buy probes to GTC so they can rest on the book", () => {
  assert.equal(chooseMarketOrderType("buy", 1), OrderType.GTC);
});

test("chooseMarketOrderType upgrades buy orders to GTC for 1 USDT probes so they can rest on the book", () => {
  assert.equal(chooseMarketOrderType("buy", 1.15), OrderType.GTC);
});

test("chooseMarketOrderType keeps larger buy orders on FAK for bounded taker execution", () => {
  assert.equal(chooseMarketOrderType("buy", 2), OrderType.FAK);
});

test("chooseMarketOrderType uses FAK for sell orders to allow partial immediate fills", () => {
  assert.equal(chooseMarketOrderType("sell", 1), OrderType.FAK);
});
