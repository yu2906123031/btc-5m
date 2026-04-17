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
import { updateNeutralCooldown, getFavorableDiff, getDirectionProbability } from "./helpers.js";

const ENTRY_DIFF = 35;
const ENTRY_PROB_CAP = 82;
const WINDOW_MAX_REMAINING = 220;
const WINDOW_MIN_REMAINING = 45;

const NEUTRAL_DIFF = 25;
const NEUTRAL_HOLD_MS = 2500;
const OVERHEAT_DIFF = 55;
const OVERHEAT_PROB = 85;

const TRAILING_STOP_RETRACEMENT = 20;
const TRAILING_STOP_MIN_DIFF = 5;
const MIN_HOLD_MS = 3000;
const PROB_PEAK_RETRACEMENT = 8;
const PROB_PEAK_MIN_THRESHOLD = 85;
const FORCE_EXIT_REM = 10;
const TP_LADDER_START = 90;

interface S1State {
  lastDiff: number | null;
  upBlocked: boolean;
  downBlocked: boolean;
  neutralSince: number;
  peakDiff: number | null;
  peakProbability: number | null;
  entryTs: number;
}

function createState(): S1State {
  return {
    lastDiff: null,
    upBlocked: false,
    downBlocked: false,
    neutralSince: 0,
    peakDiff: null,
    peakProbability: null,
    entryTs: 0,
  };
}

function getProbabilityRetracementThreshold(peakProbability: number): number {
  if (peakProbability >= 95) return 5;
  if (peakProbability >= 90) return 6;
  if (peakProbability >= PROB_PEAK_MIN_THRESHOLD) return PROB_PEAK_RETRACEMENT;
  return PROB_PEAK_RETRACEMENT;
}

export class S1Enhanced implements IStrategy {
  readonly key: StrategyKey = "s1";
  readonly number: StrategyNumber = 1;
  readonly name = "Regular+";

  private s: S1State = createState();

  getDescription(): StrategyDescription {
    return {
      key: this.key,
      number: this.number,
      name: this.name,
      title: "Strategy 1 / Regular+",
      lines: [
        { text: `Scan window: ${WINDOW_MAX_REMAINING}s to ${WINDOW_MIN_REMAINING}s` },
        { text: `Entry up: diff crosses above ${ENTRY_DIFF}, up prob < ${ENTRY_PROB_CAP}%` },
        { text: `Entry down: diff crosses below -${ENTRY_DIFF}, down prob < ${ENTRY_PROB_CAP}%` },
        { text: `Take profit: dynamic ladder from ${TP_LADDER_START}% to 100%`, color: "#3fb950", marginTop: true },
        { text: "Take profit: tighter pullback once peak probability exceeds 90%", color: "#3fb950" },
        { text: `Stop loss: diff retraces ${TRAILING_STOP_RETRACEMENT} from peak or falls below ${TRAILING_STOP_MIN_DIFF}`, color: "#f85149" },
        { text: `Force exit in the last ${FORCE_EXIT_REM}s`, color: "#f85149" },
      ],
    };
  }

  updateGuards(ctx: StrategyTickContext): void {
    const { rem, upPct, dnPct, diff, now } = ctx;
    if (diff == null || upPct == null || dnPct == null) {
      this.s.neutralSince = 0;
      return;
    }

    updateNeutralCooldown(this.s, diff, now, NEUTRAL_DIFF, NEUTRAL_HOLD_MS);

    if (rem > WINDOW_MAX_REMAINING || rem <= WINDOW_MIN_REMAINING) return;
    if (Math.abs(diff) <= NEUTRAL_DIFF) return;

    // Only block on extreme overheat (high diff + high prob simultaneously).
    // Removed the probSeen preemptive blocking that was too aggressive —
    // probability typically leads diff in polymarket, so nearly all entries
    // were being blocked before diff could cross the threshold.
    if (diff >= OVERHEAT_DIFF && upPct >= OVERHEAT_PROB) this.s.upBlocked = true;
    if (diff <= -OVERHEAT_DIFF && dnPct >= OVERHEAT_PROB) this.s.downBlocked = true;
  }

  checkEntry(ctx: StrategyTickContext): EntrySignal | null {
    const { rem, upPct, dnPct, diff } = ctx;
    const lastDiff = this.s.lastDiff;
    if (upPct == null || dnPct == null || diff == null || lastDiff == null) return null;
    if (rem > WINDOW_MAX_REMAINING || rem <= WINDOW_MIN_REMAINING) return null;

    if (!this.s.upBlocked && lastDiff < ENTRY_DIFF && diff > ENTRY_DIFF && upPct < ENTRY_PROB_CAP) {
      return { direction: "up" };
    }
    if (!this.s.downBlocked && lastDiff > -ENTRY_DIFF && diff < -ENTRY_DIFF && dnPct < ENTRY_PROB_CAP) {
      return { direction: "down" };
    }
    return null;
  }

  onEntryFilled(ctx: StrategyTickContext, direction: StrategyDirection): void {
    const { diff, upPct, dnPct, now } = ctx;
    this.s.peakDiff = diff != null ? getFavorableDiff(diff, direction) : null;
    this.s.peakProbability = direction === "up" ? upPct : dnPct;
    this.s.entryTs = now;
    this.s.neutralSince = 0;
  }

  checkExit(ctx: StrategyTickContext, direction: StrategyDirection): ExitSignal {
    const { rem, upPct, dnPct, diff, now } = ctx;
    if (upPct == null || dnPct == null || diff == null) return null;

    const myPct = getDirectionProbability(upPct, dnPct, direction);
    if (myPct == null) return null;

    const favorableDiff = getFavorableDiff(diff, direction);
    if (this.s.peakDiff == null || favorableDiff > this.s.peakDiff) this.s.peakDiff = favorableDiff;
    if (this.s.peakProbability == null || myPct > this.s.peakProbability) this.s.peakProbability = myPct;

    if (rem <= FORCE_EXIT_REM && rem > 0) {
      return {
        signal: myPct >= 70 ? "tp" : "sl",
        reason: `force exit with ${rem}s remaining`,
      };
    }

    const span = WINDOW_MAX_REMAINING - FORCE_EXIT_REM;
    const elapsed = Math.max(0, WINDOW_MAX_REMAINING - rem);
    const tpThreshold = Math.min(100, TP_LADDER_START + Math.floor((elapsed / span) * (100 - TP_LADDER_START)));
    if (myPct >= tpThreshold) {
      return { signal: "tp", reason: `ladder take profit at ${myPct}%` };
    }

    if (this.s.peakProbability != null && this.s.peakProbability >= PROB_PEAK_MIN_THRESHOLD) {
      const retracementThreshold = getProbabilityRetracementThreshold(this.s.peakProbability);
      if (myPct <= this.s.peakProbability - retracementThreshold) {
        return { signal: "tp", reason: `probability pullback from ${this.s.peakProbability}%` };
      }
    }

    if (this.s.entryTs > 0 && now - this.s.entryTs < MIN_HOLD_MS) return null;

    if (direction === "up" && diff <= TRAILING_STOP_MIN_DIFF) {
      return { signal: "sl", reason: "diff lost support" };
    }
    if (direction === "down" && diff >= -TRAILING_STOP_MIN_DIFF) {
      return { signal: "sl", reason: "diff lost support" };
    }

    if (this.s.peakDiff != null && this.s.peakDiff - favorableDiff >= TRAILING_STOP_RETRACEMENT) {
      return { signal: "sl", reason: "trailing stop retracement" };
    }

    return null;
  }

  finalizeTick(diff: number | null): void {
    this.s.lastDiff = diff;
  }

  resetState(): void {
    this.s = createState();
  }

  getStatePayload(): Record<string, unknown> {
    return {
      lastDiff: this.s.lastDiff,
      upBlocked: this.s.upBlocked,
      downBlocked: this.s.downBlocked,
      peakDiff: this.s.peakDiff,
      peakProbability: this.s.peakProbability,
    };
  }
}
