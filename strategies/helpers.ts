/**
 * 策略模块共享工具函数
 * 用于减少策略间的代码重复
 */

import type { StrategyDirection, ExitSignal } from "./types.js";

/**
 * 检查是否触发固定差价止损
 * @param diff 当前差价
 * @param direction 持仓方向
 * @param threshold 止损阈值（正数）
 * @returns 止损信号或 null
 */
export function checkDiffStopLoss(
  diff: number,
  direction: StrategyDirection,
  threshold: number
): ExitSignal {
  if (direction === "up" && diff <= threshold) {
    return { signal: "sl", reason: `diff stop loss at ${diff}` };
  }
  if (direction === "down" && diff >= -threshold) {
    return { signal: "sl", reason: `diff stop loss at ${diff}` };
  }
  return null;
}

/**
 * 计算有利方向的差价（持仓方向的绝对值）
 * @param diff 原始差价
 * @param direction 持仓方向
 * @returns 有利差价
 */
export function getFavorableDiff(diff: number, direction: StrategyDirection): number {
  return direction === "up" ? diff : -diff;
}

/**
 * 获取当前方向的概率值
 * @param upPct 上涨概率
 * @param dnPct 下跌概率
 * @param direction 方向
 * @returns 对应方向的概率值
 */
export function getDirectionProbability(
  upPct: number | null,
  dnPct: number | null,
  direction: StrategyDirection
): number | null {
  return direction === "up" ? upPct : dnPct;
}

/**
 * 更新中性差价冷却状态
 * 当差价在中性区间持续一段时间后，重置所有阻塞状态
 * 
 * @param state 策略状态对象引用
 * @param diff 当前差价
 * @param now 当前时间戳（ms）
 * @param neutralDiff 中性差价阈值
 * @param neutralHoldMs 中性持续时间阈值（ms）
 */
export function updateNeutralCooldown(
  state: {
    neutralSince: number;
    upBlocked: boolean;
    downBlocked: boolean;
    upProbSeen?: boolean;
    downProbSeen?: boolean;
  },
  diff: number,
  now: number,
  neutralDiff: number,
  neutralHoldMs: number
): void {
  if (Math.abs(diff) <= neutralDiff) {
    if (!state.neutralSince) {
      state.neutralSince = now;
    } else if (now - state.neutralSince >= neutralHoldMs) {
      // 冷却完成，重置所有阻塞
      state.upBlocked = false;
      state.downBlocked = false;
      if (state.upProbSeen !== undefined) state.upProbSeen = false;
      if (state.downProbSeen !== undefined) state.downProbSeen = false;
      state.neutralSince = 0;
    }
  } else {
    // 差价离开中性区间，重置计时
    state.neutralSince = 0;
  }
}

/**
 * 创建策略状态克隆辅助
 * 用于 resetState 方法
 */
export function cloneState<T extends Record<string, unknown>>(state: T): T {
  return { ...state };
}
