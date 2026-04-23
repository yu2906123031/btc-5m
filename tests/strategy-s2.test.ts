import test from "node:test";
import assert from "node:assert/strict";

import { S2Regular } from "../strategies/s2.js";
import type { StrategyTickContext } from "../strategies/types.js";

function tick(strategy: S2Regular, ctx: StrategyTickContext) {
  strategy.updateGuards(ctx);
  const entry = strategy.checkEntry(ctx);
  strategy.finalizeTick?.(ctx.diff);
  return entry;
}

test("S2 enters on early-window crossover before 168s remaining", () => {
  const strategy = new S2Regular();

  assert.equal(
    tick(strategy, {
      rem: 206,
      upPct: 55,
      dnPct: 45,
      diff: 24.8,
      now: 1_000,
      prevUpPct: 55,
    }),
    null,
  );

  const entry = tick(strategy, {
    rem: 204,
    upPct: 56,
    dnPct: 44,
    diff: 49.45,
    now: 2_000,
    prevUpPct: 55,
  });

  assert.deepEqual(entry, { direction: "up" });
});

test("S2 accepts a crossover when neutral touch happened within 8 seconds", () => {
  const strategy = new S2Regular();

  assert.equal(
    tick(strategy, {
      rem: 210,
      upPct: 39,
      dnPct: 61,
      diff: 4.12,
      now: 1_000,
      prevUpPct: 39,
    }),
    null,
  );

  assert.equal(
    tick(strategy, {
      rem: 206,
      upPct: 38,
      dnPct: 62,
      diff: -29.11,
      now: 5_000,
      prevUpPct: 39,
    }),
    null,
  );

  const entry = tick(strategy, {
    rem: 205,
    upPct: 38,
    dnPct: 62,
    diff: -39.6,
    now: 6_000,
    prevUpPct: 38,
  });

  assert.deepEqual(entry, { direction: "down" });
});

test("S2 still rejects crossovers when neutral touch is too stale", () => {
  const strategy = new S2Regular();

  assert.equal(
    tick(strategy, {
      rem: 120,
      upPct: 41,
      dnPct: 59,
      diff: 24.64,
      now: 1_000,
      prevUpPct: 41,
    }),
    null,
  );

  assert.equal(
    tick(strategy, {
      rem: 110,
      upPct: 75,
      dnPct: 25,
      diff: 36.16,
      now: 11_000,
      prevUpPct: 41,
    }),
    null,
  );

  const entry = tick(strategy, {
    rem: 109,
    upPct: 76,
    dnPct: 24,
    diff: 42.07,
    now: 14_500,
    prevUpPct: 75,
  });

  assert.equal(entry, null);
});

test("S2 force exits in the last 10 seconds", () => {
  const strategy = new S2Regular();

  strategy.onEntryFilled?.(
    {
      rem: 20,
      upPct: 64,
      dnPct: 36,
      diff: 41,
      now: 1_000,
      prevUpPct: 63,
    },
    "up",
  );

  const exit = strategy.checkExit(
    {
      rem: 10,
      upPct: 67,
      dnPct: 33,
      diff: 38,
      now: 2_000,
      prevUpPct: 66,
    },
    "up",
  );

  assert.deepEqual(exit, { signal: "tp", reason: "force exit with 10s remaining" });
});

test("S2 rejects overheated breakouts when probability is already too extended", () => {
  const strategy = new S2Regular();

  assert.equal(
    tick(strategy, {
      rem: 205,
      upPct: 44,
      dnPct: 56,
      diff: 4.5,
      now: 1_000,
      prevUpPct: 44,
    }),
    null,
  );

  assert.equal(
    tick(strategy, {
      rem: 200,
      upPct: 88,
      dnPct: 12,
      diff: 57,
      now: 4_000,
      prevUpPct: 44,
    }),
    null,
  );

  const entry = tick(strategy, {
    rem: 198,
    upPct: 79,
    dnPct: 21,
    diff: 59,
    now: 5_000,
    prevUpPct: 88,
  });

  assert.equal(entry, null);
});

test("S2 exits long positions on probability pullback after late-stage extension", () => {
  const strategy = new S2Regular();

  strategy.onEntryFilled?.(
    {
      rem: 170,
      upPct: 70,
      dnPct: 30,
      diff: 43,
      now: 1_000,
      prevUpPct: 68,
    },
    "up",
  );

  assert.equal(
    strategy.checkExit(
      {
        rem: 150,
        upPct: 93,
        dnPct: 7,
        diff: 58,
        now: 3_000,
        prevUpPct: 91,
      },
      "up",
    ),
    null,
  );

  const exit = strategy.checkExit(
    {
      rem: 145,
      upPct: 84,
      dnPct: 16,
      diff: 50,
      now: 4_000,
      prevUpPct: 93,
    },
    "up",
  );

  assert.deepEqual(exit, { signal: "tp", reason: "probability pullback from 93%" });
});

test("S2 widens stop using volatility after a valid entry instead of fixed diff support", () => {
  const strategy = new S2Regular();

  strategy.onEntryFilled?.(
    {
      rem: 180,
      upPct: 63,
      dnPct: 37,
      diff: 42,
      now: 1_000,
      prevUpPct: 61,
    },
    "up",
  );

  assert.equal(
    strategy.checkExit(
      {
        rem: 170,
        upPct: 61,
        dnPct: 39,
        diff: 26,
        now: 3_000,
        prevUpPct: 63,
      },
      "up",
    ),
    null,
  );

  const exit = strategy.checkExit(
    {
      rem: 165,
      upPct: 59,
      dnPct: 41,
      diff: -8,
      now: 4_000,
      prevUpPct: 61,
    },
    "up",
  );

  assert.deepEqual(exit, { signal: "sl", reason: "atr stop loss" });
});
