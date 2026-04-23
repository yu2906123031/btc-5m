import type {
  IStrategy,
  StrategyKey,
  StrategyNumber,
  StrategyDirection,
  StrategyTickContext,
  EntrySignal,
  ExitSignal,
  StrategyDescription,
} from "./types.js";
// S4 不使用共享函数，因为它是纯概率反转策略

const WINDOW_MAX_REMAINING = 5;
const WINDOW_MIN_REMAINING = 1;
const ENTRY_UP_FROM = 30;
const ENTRY_UP_TO = 60;
const ENTRY_DN_FROM = 70;
const ENTRY_DN_TO = 40;
const TP_PROB = 85;
const SL_PROB = 50;

export class S4Reversal implements IStrategy {
  readonly key: StrategyKey = "s4";
  readonly number: StrategyNumber = 4;
  readonly name = "Reversal";

  getDescription(): StrategyDescription {
    return {
      key: this.key,
      number: this.number,
      name: this.name,
      title: "Strategy 4 / Reversal",
      lines: [
        { text: `Final ${WINDOW_MAX_REMAINING}s to ${WINDOW_MIN_REMAINING}s only` },
        { text: `Buy up when up probability snaps from < ${ENTRY_UP_FROM}% to > ${ENTRY_UP_TO}%` },
        { text: `Buy down when up probability snaps from > ${ENTRY_DN_FROM}% to < ${ENTRY_DN_TO}%` },
      ],
    };
  }

  updateGuards(_ctx: StrategyTickContext): void {}

  checkEntry(ctx: StrategyTickContext): EntrySignal | null {
    const { rem, upPct, prevUpPct } = ctx;
    if (upPct == null || prevUpPct == null) return null;
    if (rem > WINDOW_MAX_REMAINING || rem <= WINDOW_MIN_REMAINING) return null;
    if (prevUpPct < ENTRY_UP_FROM && upPct > ENTRY_UP_TO) return { direction: "up" };
    if (prevUpPct > ENTRY_DN_FROM && upPct < ENTRY_DN_TO) return { direction: "down" };
    return null;
  }

  checkExit(ctx: StrategyTickContext, direction: StrategyDirection): ExitSignal {
    const { upPct, dnPct } = ctx;
    if (upPct == null || dnPct == null) return null;
    const myPct = direction === "up" ? upPct : dnPct;
    if (myPct >= TP_PROB) return { signal: "tp", reason: "probability take profit" };
    if (myPct <= SL_PROB) return { signal: "sl", reason: "probability stop loss" };
    return null;
  }

  resetState(): void {}

  getStatePayload(): Record<string, unknown> {
    return {};
  }
}
