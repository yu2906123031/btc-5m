/**
 * Strategy registry with explicit initialization.
 */

import type { IStrategy, StrategyKey, StrategyDescription } from "./types.js";
import { ALL_STRATEGY_KEYS } from "./types.js";
import { S1Enhanced } from "./s1.js";
import { S2Regular } from "./s2.js";
import { S3Sweep } from "./s3.js";
import { S4Reversal } from "./s4.js";
import { S5ProbChase } from "./s5.js";

const strategies: Map<StrategyKey, IStrategy> = new Map();
let initialized = false;

const strategyFactories: Array<() => IStrategy> = [
  () => new S1Enhanced(),
  () => new S2Regular(),
  () => new S3Sweep(),
  () => new S4Reversal(),
  () => new S5ProbChase(),
];

export function initStrategies(): void {
  if (initialized) return;
  
  const initializedKeys: StrategyKey[] = [];
  const failed: Array<{ key: string; error: string }> = [];
  
  for (const create of strategyFactories) {
    try {
      const strategy = create();
      strategies.set(strategy.key, strategy);
      initializedKeys.push(strategy.key);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      failed.push({ key: create.toString().slice(0, 50), error: errorMsg });
      console.error(`[StrategyRegistry] Failed to initialize strategy: ${errorMsg}`);
    }
  }
  
  if (failed.length > 0) {
    console.error(`[StrategyRegistry] Initialization complete with ${failed.length} failure(s):`, failed);
    throw new Error(`Failed to initialize ${failed.length} strategy(s). Check logs for details.`);
  }
  
  console.log(`[StrategyRegistry] Successfully initialized ${initializedKeys.length} strategies: ${initializedKeys.join(', ')}`);
  initialized = true;
}

/**
 * Returns initialization status for all strategies.
 * Useful for health checks and debugging.
 */
export function getStrategyInitStatus(): { 
  initialized: boolean;
  registered: StrategyKey[];
  missing: StrategyKey[];
} {
  const registered: StrategyKey[] = [];
  const missing: StrategyKey[] = [];
  
  for (const key of ALL_STRATEGY_KEYS) {
    if (strategies.has(key)) {
      registered.push(key);
    } else {
      missing.push(key);
    }
  }
  
  return { initialized, registered, missing };
}

export function registerAllStrategies(): void {
  initStrategies();
}

export function getStrategy(key: StrategyKey): IStrategy | undefined {
  return strategies.get(key);
}

export function getAllStrategies(): IStrategy[] {
  return ALL_STRATEGY_KEYS
    .map((key) => strategies.get(key))
    .filter((s): s is IStrategy => s != null);
}

export function getAllStrategyKeys(): StrategyKey[] {
  return ALL_STRATEGY_KEYS.filter((key) => strategies.has(key));
}

export function getAllDescriptions(): StrategyDescription[] {
  return getAllStrategies().map((s) => s.getDescription());
}
