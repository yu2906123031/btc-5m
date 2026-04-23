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
import {
  updateNeutralCooldown,
  checkAtrStopLoss,
  computeAtrStopDistance,
  getDirectionProbability,
  getFavorableDiff,
  pushDiffSample,
} from "./helpers.js";

const ENTRY_DIFF_BASE = 40;
const ENTRY_DIFF_EARLY = 38;
const ENTRY_DIFF_LATE = 42;
const ENTRY_PROB_CAP = 85;
const WINDOW_MAX_REMAINING = 220;
const WINDOW_MIN_REMAINING = 48;
const FALLBACK_STOP_DISTANCE = 26;
const TRAILING_STOP_RETRACEMENT = 18;
const TP_LADDER_FLOOR = 12;
const TP_LADDER_START = 92;
const FORCE_EXIT_REM = 10;
const NEUTRAL_DIFF = 25;
const NEUTRAL_HOLD_MS = 3000;
const NEUTRAL_ENTRY_TOUCH_MS = 8000;
const OVERHEAT_DIFF = 55;
const OVERHEAT_PROB = 80;
const EARLY_WINDOW_REMAINING = 120;
const LATE_WINDOW_REMAINING = 60;
const PROB_PULLBACK_MIN_PEAK = 90;
const PROB_PULLBACK_RETRACEMENT = 8;
const ATR_SAMPLE_WINDOW = 6;

interface S2State {
  lastDiff: number | null;
  upBlocked: boolean;
  downBlocked: boolean;
  neutralSince: number;
  neutralTouchAt: number;
  peakDiff: number | null;
  peakProbability: number | null;
  entryDiff: number | null;
  diffSamples: number[];
}

function createState(): S2State {
  return {
    lastDiff: null,
    upBlocked: false,
    downBlocked: false,
    neutralSince: 0,
    neutralTouchAt: 0,
    peakDiff: null,
    peakProbability: null,
    entryDiff: null,
    diffSamples: [],
  };
}

function getEntryDiff(rem: number): number {
  if (rem >= EARLY_WINDOW_REMAINING) return ENTRY_DIFF_EARLY;
  if (rem <= LATE_WINDOW_REMAINING) return ENTRY_DIFF_LATE;
  return ENTRY_DIFF_BASE;
}

export class S2Regular implements IStrategy {
  readonly key: StrategyKey = "s2";
  readonly number: StrategyNumber = 2;
  readonly name = "Regular";

  private s: S2State = createState();

  getDescription(): StrategyDescription {
    return {
      key: this.key,
      number: this.number,
      name: this.name,
      title: "Strategy 2 / Regular",
      lines: [
        { text: `Scan window: ${WINDOW_MAX_REMAINING}s to ${WINDOW_MIN_REMAINING}s` },
        { text: `Entry diff: ${ENTRY_DIFF_EARLY}/${ENTRY_DIFF_BASE}/${ENTRY_DIFF_LATE} by remaining time, prob < ${ENTRY_PROB_CAP}%` },
        { text: `Entry requires a neutral touch within ${Math.floor(NEUTRAL_ENTRY_TOUCH_MS / 1000)}s` },
        { text: `Take profit: ladder from ${TP_LADDER_START}% to 100% + probability pullback after ${PROB_PULLBACK_MIN_PEAK}%`, color: "#3fb950", marginTop: true },
        { text: `Stop loss: ATR-style dynamic stop + trailing retracement ${TRAILING_STOP_RETRACEMENT}`, color: "#f85149" },
        { text: `Force exit in the last ${FORCE_EXIT_REM}s`, color: "#f85149" },
        { text: "Directional cooling lock resets after diff returns to neutral", color: "#888" },
      ],
    };
  }

  updateGuards(ctx: StrategyTickContext): void {
    const { rem, upPct, dnPct, diff, now } = ctx;
    if (diff == null || upPct == null || dnPct == null) {
      this.s.neutralSince = 0;
      this.s.neutralTouchAt = 0;
      return;
    }

    pushDiffSample({ samples: this.s.diffSamples }, diff, ATR_SAMPLE_WINDOW);

    if (Math.abs(diff) <= NEUTRAL_DIFF) this.s.neutralTouchAt = now;

    // Reset directional cooldown after the market has stayed neutral long enough.
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
    const { rem, upPct, dnPct, diff, now } = ctx;
    const lastDiff = this.s.lastDiff;
    if (upPct == null || dnPct == null || diff == null || lastDiff == null) return null;
    if (rem > WINDOW_MAX_REMAINING || rem <= WINDOW_MIN_REMAINING) return null;
    if (!this.s.neutralTouchAt || now - this.s.neutralTouchAt > NEUTRAL_ENTRY_TOUCH_MS) return null;

    const entryDiff = getEntryDiff(rem);
    if (!this.s.upBlocked && lastDiff <= entryDiff && diff > entryDiff && upPct < ENTRY_PROB_CAP) {
      return { direction: "up" };
    }
    if (!this.s.downBlocked && lastDiff >= -entryDiff && diff < -entryDiff && dnPct < ENTRY_PROB_CAP) {
      return { direction: "down" };
    }
    return null;
  }

  onEntryFilled(ctx: StrategyTickContext, direction: StrategyDirection): void {
    const { diff, upPct, dnPct } = ctx;
    this.s.peakDiff = diff == null ? null : getFavorableDiff(diff, direction);
    this.s.peakProbability = getDirectionProbability(upPct, dnPct, direction);
    this.s.entryDiff = diff;
  }

  checkExit(ctx: StrategyTickContext, direction: StrategyDirection): ExitSignal {
    const { rem, upPct, dnPct, diff } = ctx;
    if (upPct == null || dnPct == null || diff == null) return null;
    const myPct = direction === "up" ? upPct : dnPct;
    const favorableDiff = getFavorableDiff(diff, direction);

    if (this.s.peakDiff == null || favorableDiff > this.s.peakDiff) {
      this.s.peakDiff = favorableDiff;
    }
    if (this.s.peakProbability == null || myPct > this.s.peakProbability) {
      this.s.peakProbability = myPct;
    }

    if (rem <= FORCE_EXIT_REM && rem > 0) {
      return {
        signal: myPct >= 50 ? "tp" : "sl",
        reason: `force exit with ${rem}s remaining`,
      };
    }

    if (rem >= TP_LADDER_FLOOR) {
      const span = WINDOW_MAX_REMAINING - TP_LADDER_FLOOR;
      const elapsed = Math.max(0, WINDOW_MAX_REMAINING - Math.max(rem, TP_LADDER_FLOOR));
      const tpThreshold = Math.min(100, TP_LADDER_START + Math.floor((elapsed / span) * (100 - TP_LADDER_START)));
      if (myPct >= tpThreshold) return { signal: "tp", reason: "ladder take profit" };
    }

    if (
      this.s.peakProbability != null
      && this.s.peakProbability >= PROB_PULLBACK_MIN_PEAK
      && myPct <= this.s.peakProbability - PROB_PULLBACK_RETRACEMENT
    ) {
      return { signal: "tp", reason: `probability pullback from ${this.s.peakProbability}%` };
    }

    const atrStopDistance = computeAtrStopDistance(this.s.diffSamples, FALLBACK_STOP_DISTANCE);
    if (this.s.entryDiff != null) {
      const atrStop = checkAtrStopLoss(diff, direction, this.s.entryDiff, atrStopDistance);
      if (atrStop) return atrStop;
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
    return { ...this.s };
  }
}
