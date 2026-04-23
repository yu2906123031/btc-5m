import test from "node:test";
import assert from "node:assert/strict";

import { buildStrategyRuntimeEvent } from "../runtime-events.js";

test("buildStrategyRuntimeEvent emits stable JSON for strategy entry notifications", () => {
  const line = buildStrategyRuntimeEvent("entry_triggered", {
    strategy: "S2",
    direction: "up",
    amount: 1,
    roundEntry: "1/1",
  });

  const event = JSON.parse(line) as Record<string, unknown>;
  assert.equal(event.event_type, "entry_triggered");
  assert.equal(event.strategy, "S2");
  assert.equal(event.direction, "up");
  assert.equal(event.amount, 1);
  assert.equal(event.roundEntry, "1/1");
  assert.equal(typeof event.ts, "number");
});

test("buildStrategyRuntimeEvent includes exit and error context for sell failures", () => {
  const line = buildStrategyRuntimeEvent("sell_failed", {
    strategy: "S2",
    direction: "down",
    reason: "stop loss",
    error: "order rejected",
  });

  const event = JSON.parse(line) as Record<string, unknown>;
  assert.equal(event.event_type, "sell_failed");
  assert.equal(event.strategy, "S2");
  assert.equal(event.direction, "down");
  assert.equal(event.reason, "stop loss");
  assert.equal(event.error, "order rejected");
  assert.equal(typeof event.ts, "number");
});
