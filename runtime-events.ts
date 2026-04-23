export type StrategyRuntimeEventType =
  | "entry_triggered"
  | "buy_fill_confirmed"
  | "sell_signal_triggered"
  | "sell_fill_confirmed"
  | "buy_failed"
  | "sell_failed";

export type StrategyRuntimeEventPayload = Record<string, unknown>;

export function buildStrategyRuntimeEvent(
  eventType: StrategyRuntimeEventType,
  payload: StrategyRuntimeEventPayload = {},
): string {
  return JSON.stringify({
    event_type: eventType,
    ts: Date.now(),
    ...payload,
  });
}

export function logStrategyRuntimeEvent(
  eventType: StrategyRuntimeEventType,
  payload: StrategyRuntimeEventPayload = {},
  logger: (line: string) => void = console.log,
): void {
  logger(buildStrategyRuntimeEvent(eventType, payload));
}
