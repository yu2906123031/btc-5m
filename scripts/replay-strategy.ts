import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { IStrategy, StrategyDirection, StrategyTickContext } from "../strategies/types.js";
import { S1Enhanced } from "../strategies/s1.js";
import { S2Regular } from "../strategies/s2.js";
import { S3Sweep } from "../strategies/s3.js";
import { S4Reversal } from "../strategies/s4.js";
import { S5ProbChase } from "../strategies/s5.js";

type StrategyKey = "s1" | "s2" | "s3" | "s4" | "s5";

interface TickRecord {
  type: "tick";
  ts: number;
  windowStart: number;
  diff: number;
  upPct: number;
  rem: number;
}

interface HoldingState {
  direction: StrategyDirection;
  shares: number;
  entryCost: number;
  entryPrice: number;
  entryTs: number;
  entryRem: number;
}

interface ReplayTrade {
  strategy: StrategyKey;
  windowStart: number;
  direction: StrategyDirection;
  entryTs: number;
  entryRem: number;
  entryPrice: number;
  exitTs: number;
  exitRem: number;
  exitPrice: number;
  exitReason: string;
  pnl: number;
}

interface ReplaySummary {
  strategy: StrategyKey;
  windows: number;
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnl: number;
  avgPnl: number;
  openAtEnd: number;
  exitReasons: Record<string, number>;
}

const STRATEGY_FACTORIES: Record<StrategyKey, () => IStrategy> = {
  s1: () => new S1Enhanced(),
  s2: () => new S2Regular(),
  s3: () => new S3Sweep(),
  s4: () => new S4Reversal(),
  s5: () => new S5ProbChase(),
};

function parseArgs(argv: string[]): {
  file: string;
  strategies: StrategyKey[];
  amount: number;
  details: boolean;
} {
  let file = "backtest-data/2026-04-15.jsonl";
  let strategyArg = "all";
  let amount = 1;
  let details = false;

  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    if (value === "--file" && argv[index + 1]) {
      file = argv[++index];
      continue;
    }
    if (value === "--strategy" && argv[index + 1]) {
      strategyArg = argv[++index];
      continue;
    }
    if (value === "--amount" && argv[index + 1]) {
      amount = Number(argv[++index]);
      continue;
    }
    if (value === "--details") {
      details = true;
      continue;
    }
    if (value === "--help" || value === "-h") {
      printHelp();
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${value}`);
  }

  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("--amount must be a positive number");
  }

  const strategies = strategyArg === "all"
    ? Object.keys(STRATEGY_FACTORIES) as StrategyKey[]
    : strategyArg.split(",").map((item) => item.trim()).filter(Boolean) as StrategyKey[];

  if (strategies.length === 0 || strategies.some((key) => !(key in STRATEGY_FACTORIES))) {
    throw new Error(`--strategy must be one of: all, ${Object.keys(STRATEGY_FACTORIES).join(",")}`);
  }

  return { file, strategies, amount, details };
}

function printHelp(): void {
  console.log(
    [
      "Usage: npm run replay:strategy -- --file <jsonl> --strategy <all|s1,s2,...> [--amount 1] [--details]",
      "",
      "Examples:",
      "  npm run replay:strategy -- --file backtest-data/2026-04-15.jsonl --strategy s2",
      "  npm run replay:strategy -- --file backtest-data/2026-04-15.jsonl --strategy all --details",
    ].join("\n"),
  );
}

function loadTicks(file: string): Map<number, TickRecord[]> {
  const raw = readFileSync(resolve(file), "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as TickRecord)
    .filter((row) => row.type === "tick");

  const windows = new Map<number, TickRecord[]>();
  for (const row of raw) {
    const existing = windows.get(row.windowStart);
    if (existing) {
      existing.push(row);
    } else {
      windows.set(row.windowStart, [row]);
    }
  }

  for (const rows of windows.values()) {
    rows.sort((left, right) => left.ts - right.ts);
  }

  return windows;
}

function getOutcomePrice(direction: StrategyDirection, upPct: number): number {
  return direction === "up" ? upPct / 100 : (100 - upPct) / 100;
}

function buildContext(record: TickRecord, prevUpPct: number | null): StrategyTickContext {
  return {
    rem: record.rem,
    upPct: record.upPct,
    dnPct: 100 - record.upPct,
    diff: record.diff,
    now: record.ts,
    prevUpPct,
  };
}

function summarize(strategy: StrategyKey, windows: number, trades: ReplayTrade[], openAtEnd: number): ReplaySummary {
  const wins = trades.filter((trade) => trade.pnl > 0).length;
  const losses = trades.length - wins;
  const totalPnl = trades.reduce((sum, trade) => sum + trade.pnl, 0);
  const exitReasons: Record<string, number> = {};
  for (const trade of trades) {
    exitReasons[trade.exitReason] = (exitReasons[trade.exitReason] ?? 0) + 1;
  }
  return {
    strategy,
    windows,
    trades: trades.length,
    wins,
    losses,
    winRate: trades.length > 0 ? Number(((wins / trades.length) * 100).toFixed(1)) : 0,
    totalPnl: Number(totalPnl.toFixed(4)),
    avgPnl: trades.length > 0 ? Number((totalPnl / trades.length).toFixed(4)) : 0,
    openAtEnd,
    exitReasons,
  };
}

function replayStrategy(strategyKey: StrategyKey, windows: Map<number, TickRecord[]>, amount: number): {
  summary: ReplaySummary;
  trades: ReplayTrade[];
} {
  const trades: ReplayTrade[] = [];
  let openAtEnd = 0;

  for (const [windowStart, rows] of windows) {
    const strategy = STRATEGY_FACTORIES[strategyKey]();
    strategy.resetState();

    let prevUpPct: number | null = null;
    let holding: HoldingState | null = null;

    for (const record of rows) {
      const ctx = buildContext(record, prevUpPct);
      strategy.updateGuards(ctx);

      if (!holding) {
        const entry = strategy.checkEntry(ctx);
        if (entry) {
          const entryPrice = getOutcomePrice(entry.direction, record.upPct);
          holding = {
            direction: entry.direction,
            shares: amount / entryPrice,
            entryCost: amount,
            entryPrice,
            entryTs: record.ts,
            entryRem: record.rem,
          };
          strategy.onEntryFilled?.(ctx, entry.direction);
        }
      } else {
        const exit = strategy.checkExit(ctx, holding.direction);
        if (exit) {
          const exitPrice = getOutcomePrice(holding.direction, record.upPct);
          const pnl = holding.shares * exitPrice - holding.entryCost;
          trades.push({
            strategy: strategyKey,
            windowStart,
            direction: holding.direction,
            entryTs: holding.entryTs,
            entryRem: holding.entryRem,
            entryPrice: Number(holding.entryPrice.toFixed(4)),
            exitTs: record.ts,
            exitRem: record.rem,
            exitPrice: Number(exitPrice.toFixed(4)),
            exitReason: exit.reason,
            pnl: Number(pnl.toFixed(4)),
          });
          holding = null;
        }
      }

      strategy.finalizeTick?.(record.diff);
      prevUpPct = record.upPct;
    }

    if (holding) {
      const last = rows.at(-1);
      if (last) {
        const exitPrice = getOutcomePrice(holding.direction, last.upPct);
        const pnl = holding.shares * exitPrice - holding.entryCost;
        trades.push({
          strategy: strategyKey,
          windowStart,
          direction: holding.direction,
          entryTs: holding.entryTs,
          entryRem: holding.entryRem,
          entryPrice: Number(holding.entryPrice.toFixed(4)),
          exitTs: last.ts,
          exitRem: last.rem,
          exitPrice: Number(exitPrice.toFixed(4)),
          exitReason: "window end snapshot",
          pnl: Number(pnl.toFixed(4)),
        });
        openAtEnd++;
      }
    }
  }

  return {
    summary: summarize(strategyKey, windows.size, trades, openAtEnd),
    trades,
  };
}

function printSummary(summary: ReplaySummary): void {
  console.log(JSON.stringify(summary, null, 2));
}

function printTrades(trades: ReplayTrade[]): void {
  for (const trade of trades) {
    console.log(JSON.stringify(trade));
  }
}

function main(): void {
  const { file, strategies, amount, details } = parseArgs(process.argv.slice(2));
  const windows = loadTicks(file);

  console.log(`[Replay] file=${resolve(file)} windows=${windows.size} amount=${amount}`);
  for (const strategyKey of strategies) {
    const { summary, trades } = replayStrategy(strategyKey, windows, amount);
    printSummary(summary);
    if (details && trades.length > 0) {
      printTrades(trades);
    }
  }
}

main();
