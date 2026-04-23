import test from "node:test";
import assert from "node:assert/strict";

import { S4Reversal } from "../strategies/s4.js";
import { S5ProbChase } from "../strategies/s5.js";
import type { StrategyTickContext } from "../strategies/types.js";

function baseCtx(overrides: Partial<StrategyTickContext> = {}): StrategyTickContext {
  return {
    rem: 120,
    upPct: 50,
    dnPct: 50,
    diff: 0,
    now: 0,
    prevUpPct: 50,
    ...overrides,
  };
}

test("S4 excludes the 1-second boundary from entry window", () => {
  const strategy = new S4Reversal();
  const signal = strategy.checkEntry(baseCtx({ rem: 1, upPct: 65, prevUpPct: 25 }));
  assert.equal(signal, null);
});

test("S5 enters long when fair probability bias exceeds threshold", () => {
  const strategy = new S5ProbChase();
  strategy.finalizeTick?.(20);
  const signal = strategy.checkEntry(baseCtx({ rem: 90, diff: 30, upPct: 70, dnPct: 30 }));
  assert.deepEqual(signal, { direction: "up" });
});

test("S5 exits long when fair probability bias closes", () => {
  const strategy = new S5ProbChase();
  strategy.finalizeTick?.(20);
  const entry = strategy.checkEntry(baseCtx({ rem: 90, diff: 30, upPct: 70, dnPct: 30 }));
  assert.deepEqual(entry, { direction: "up" });
  strategy.onEntryFilled?.(baseCtx({ rem: 90, diff: 30, upPct: 70, dnPct: 30, now: 1_000 }), entry.direction);
  const exit = strategy.checkExit(baseCtx({ rem: 85, diff: 30, upPct: 91, dnPct: 9, now: 2_000 }), "up");
  assert.deepEqual(exit, { signal: "tp", reason: "bias closed" });
});
