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
import { checkDiffStopLoss } from "./helpers.js";

const WINDOW_MAX_REMAINING = 60;
const ENTRY_DIFF = 50;
const ENTRY_PROB_CAP = 95;
const STOP_LOSS_DIFF = 5;

export class S3Sweep implements IStrategy {
  readonly key: StrategyKey = "s3";
  readonly number: StrategyNumber = 3;
  readonly name = "Sweep";

  getDescription(): StrategyDescription {
    return {
      key: this.key,
      number: this.number,
      name: this.name,
      title: "Strategy 3 / Sweep",
      lines: [
        { text: `Last ${WINDOW_MAX_REMAINING}s only` },
        { text: `Entry on large diff impulse above ${ENTRY_DIFF}` },
        { text: `Take profit on extreme probability, stop loss when diff collapses` },
      ],
    };
  }

  updateGuards(_ctx: StrategyTickContext): void {}

  checkEntry(ctx: StrategyTickContext): EntrySignal | null {
    const { rem, upPct, dnPct, diff } = ctx;
    if (upPct == null || dnPct == null || diff == null) return null;
    if (rem > WINDOW_MAX_REMAINING || rem <= 0) return null;
    if (diff > ENTRY_DIFF && upPct < ENTRY_PROB_CAP) return { direction: "up" };
    if (diff < -ENTRY_DIFF && dnPct < ENTRY_PROB_CAP) return { direction: "down" };
    return null;
  }

  checkExit(ctx: StrategyTickContext, direction: StrategyDirection): ExitSignal {
    const { rem, upPct, dnPct, diff } = ctx;
    if (upPct == null || dnPct == null || diff == null) return null;
    const myPct = direction === "up" ? upPct : dnPct;
    if (rem >= 40 && myPct >= 98) return { signal: "tp", reason: "98% take profit" };
    if (rem >= 20 && rem < 40 && myPct >= 99) return { signal: "tp", reason: "99% take profit" };
    if (rem >= 10 && rem < 20 && myPct >= 100) return { signal: "tp", reason: "100% take profit" };
    
    // 使用共享函数检查差价止损
    const slSignal = checkDiffStopLoss(diff, direction, STOP_LOSS_DIFF);
    if (slSignal) return slSignal;
    
    return null;
  }

  resetState(): void {}

  getStatePayload(): Record<string, unknown> {
    return {};
  }
}
