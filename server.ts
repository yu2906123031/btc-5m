/**`r`n * BTC 5m dashboard server`r`n * Start with: npx tsx server.ts`r`n */

import express from "express";
import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from "fs";
import axios from "axios";
import {
  Contract,
  Interface,
  JsonRpcProvider,
  Wallet,
  ZeroAddress,
  formatUnits,
  getBytes,
  TypedDataDomain,
  TypedDataField,
} from "ethers";
import dotenv from "dotenv";
import { ClobClient, Side, OrderType } from "@polymarket/clob-client";
import { SignatureType } from "@polymarket/clob-client/dist/order-utils/model/signature-types.model.js";
import {
  extractToken,
  hasTrustedOrigin,
  isAuthorized,
  resolveApiTokenState,
  shouldPublicConfigRequireToken,
} from "./auth.js";
import {
  applyAxiosProxyDefaults,
  buildProxyAgent,
  describeOutboundError,
  isLoopbackProxyUrl,
  probeLoopbackProxyAvailability,
  shouldBypassProxyAfterError,
} from "./outbound.js";
import { logStrategyRuntimeEvent } from "./runtime-events.js";
import { chooseMarketOrderType } from "./order-execution.js";
import { canExecuteMarketBuy } from "./trade-guard.js";
import { initStrategies, getAllStrategies, getStrategy, getAllDescriptions } from "./strategies/registry.js";
import type { StrategyNumber, StrategyDirection, StrategyLifecycleState, StrategyKey } from "./strategies/types.js";
import { ALL_STRATEGY_KEYS } from "./strategies/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, ".env") });

function terminateOnFatal(kind: string, error: unknown): void {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  console.error(`[Fatal] ${kind}: ${message}`);
  setTimeout(() => process.exit(1), 0);
}

process.on("unhandledRejection", (reason) => {
  terminateOnFatal("unhandledRejection", reason);
});

process.on("uncaughtException", (error) => {
  terminateOnFatal("uncaughtException", error);
});

type AppMode = "full" | "headless";
type ClientDataMode = "full" | "low";

interface StrategyConfig {
  enabled: Record<StrategyKey, boolean>;
  amount: Record<StrategyKey, number>;
  slippage: number;
  autoClaimEnabled: boolean;
  maxRoundEntries: number;
}

interface StrategyConfigUpdate {
  enabled?: Partial<Record<StrategyKey, unknown>>;
  amount?: Partial<Record<StrategyKey, unknown>>;
  slippage?: unknown;
  autoClaimEnabled?: unknown;
  maxRoundEntries?: unknown;
}

interface StrategyRuntimeState {
  state: StrategyLifecycleState;
  activeStrategy: StrategyNumber | null;
  direction: StrategyDirection | null;
  buyAmount: number;
  posBeforeBuy: number;
  posBeforeSell: number;
  waitVerifyAfterSell: boolean;
  cleanupAfterVerify: boolean;
  actionTs: number;
  prevUpPct: number | null;
  buyLockUntil: number;
  positionsReady: boolean;
  roundEntryCount: number;
}

interface TradeHistoryItem {
  id: string;
  ts: number;
  windowStart: number;
  side: "buy" | "sell";
  direction: StrategyDirection;
  amount: number;
  price?: number | null;
  worstPrice?: number | null;
  status: string;
  source: string;
  pnl?: number | null;
  txHash?: string;
  orderId?: string;
  exitReason?: string;
  roundEntry?: string;
}

interface PendingTradeMeta {
  key: string;
  orderId?: string;
  ts: number;
  windowStart: number;
  side: "buy" | "sell";
  direction: StrategyDirection;
  amount: number;
  worstPrice: number;
  source: string;
  exitReason?: string;
  roundEntry?: string;
}

interface PortfolioPosition {
  asset: string;
  title: string;
  outcome: string;
  size: number;
  currentValue: number | null;
  curPrice: number | null;
  conditionId?: string;
  status: "active" | "claimable" | "lost";
}

interface ClientSession {
  dataMode: ClientDataMode;
  lastStateSentAt: number;
  stateTimer: NodeJS.Timeout | null;
  stateDirty: boolean;
  stateIncludeHistory: boolean;
}

interface StatePayloadOptions {
  includeHistory?: boolean;
  simple?: boolean;
}

interface OrderBookLevel {
  price: number;
  size: number;
}

interface OrderBookSnapshotCache {
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  dirty: boolean;
}

function parseBooleanEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  return fallback;
}

function buildIndexHtmlDocument(): string {
  const raw = readFileSync(INDEX_HTML_FILE, "utf-8");
  const replacementUpdateStratUI =
    "function updateStratUI() {\n"
    + "  const el = document.getElementById('strat-state-text');\n"
    + "  if (!el) return;\n"
    + "  const strat = window.strat || {};\n"
    + "  const anyEnabled = strategyKeys.some((key) => stratEnabled[key]);\n"
    + "  const infoEl = document.getElementById('strat-scan-info');\n"
    + "  if (infoEl) {\n"
    + "    const bnDiff = getBnDiff();\n"
    + "    const cooldown = Math.ceil((500 - (Date.now() - _bnDragEndTime)) / 1000);\n"
    + "    const cooldownStr = cooldown > 0 ? ` ${cooldown}s` : '';\n"
    + "    const diffStr = isNaN(bnDiff)\n"
    + "      ? (cooldown > 0 ? `Cooldown${cooldownStr}` : 'BN diff --')\n"
    + "      : `BN diff ${bnDiff >= 0 ? '+' : ''}${Math.round(bnDiff)}`;\n"
    + "    const upStr = isNaN(_signalUpPct) ? '' : ` | UP ${_signalUpPct}% DN ${_signalDnPct}%`;\n"
    + "    infoEl.textContent = diffStr + upStr;\n"
    + "  }\n"
    + "  for (const key of strategyKeys) {\n"
    + "    const n = Number(key.slice(1));\n"
    + "    const lbl = stratChkEls[key]?.closest('label');\n"
    + "    if (!lbl) continue;\n"
    + "    lbl.style.color = strat.activeStrategy === n ? '#f0a500' : '';\n"
    + "  }\n"
    + "  const s = strat.state;\n"
    + "  const sn = strat.activeStrategy ?? '-';\n"
    + "  const dir = strat.direction === 'up' ? 'UP' : strat.direction === 'down' ? 'DOWN' : '--';\n"
    + "  const myPct = strat.direction === 'up' ? _signalUpPct : _signalDnPct;\n"
    + "  if (!anyEnabled && s === 'IDLE') {\n"
    + "    el.className = 'idle';\n"
    + "    el.textContent = 'Strategies disabled';\n"
    + "    return;\n"
    + "  }\n"
    + "  if (isNaN(curBestBid) || isNaN(curBestAsk)) {\n"
    + "    if (s === 'HOLDING') {\n"
    + "      const pctStr = isNaN(myPct) ? '' : ` ${myPct}%`;\n"
    + "      el.className = 'hold';\n"
    + "      el.textContent = `Strategy ${sn} holding ${dir}${pctStr} | waiting for best`;\n"
    + "      return;\n"
    + "    }\n"
    + "    if (s === 'WAIT_FILL') {\n"
    + "      const elapsed = Math.floor((Date.now() - strat.actionTs) / 1000);\n"
    + "      el.className = 'active';\n"
    + "      el.textContent = `Strategy ${sn} waiting fill ${elapsed}s`;\n"
    + "      return;\n"
    + "    }\n"
    + "    if (s === 'RECONCILING_FILL') {\n"
    + "      const elapsed = Math.floor((Date.now() - strat.actionTs) / 1000);\n"
    + "      el.className = 'active';\n"
    + "      el.textContent = `Strategy ${sn} reconciling fill ${elapsed}s`;\n"
    + "      return;\n"
    + "    }\n"
    + "    if (s === 'WAIT_SELL_FILL') {\n"
    + "      el.className = 'active';\n"
    + "      el.textContent = `Strategy ${sn} waiting sell fill`;\n"
    + "      return;\n"
    + "    }\n"
    + "    if (s === 'BUYING') {\n"
    + "      el.className = 'active';\n"
    + "      el.textContent = `Strategy ${sn} buying ${dir}`;\n"
    + "      return;\n"
    + "    }\n"
    + "    if (s === 'SELLING') {\n"
    + "      el.className = 'active';\n"
    + "      el.textContent = `Strategy ${sn} selling`;\n"
    + "      return;\n"
    + "    }\n"
    + "    el.className = 'idle';\n"
    + "    el.textContent = 'Waiting for best bid/ask';\n"
    + "    return;\n"
    + "  }\n"
    + "  if (s === 'IDLE' || s === 'SCANNING') {\n"
    + "    el.className = 'scan';\n"
    + "    el.textContent = 'Scanning...';\n"
    + "    return;\n"
    + "  }\n"
    + "  if (s === 'BUYING') {\n"
    + "    el.className = 'active';\n"
    + "    el.textContent = `Strategy ${sn} buying ${dir}`;\n"
    + "    return;\n"
    + "  }\n"
    + "  if (s === 'WAIT_FILL') {\n"
    + "    const elapsed = Math.floor((Date.now() - strat.actionTs) / 1000);\n"
    + "    el.className = 'active';\n"
    + "    el.textContent = `Strategy ${sn} waiting fill ${elapsed}s`;\n"
    + "    return;\n"
    + "  }\n"
    + "  if (s === 'RECONCILING_FILL') {\n"
    + "    const elapsed = Math.floor((Date.now() - strat.actionTs) / 1000);\n"
    + "    el.className = 'active';\n"
    + "    el.textContent = `Strategy ${sn} reconciling fill ${elapsed}s`;\n"
    + "    return;\n"
    + "  }\n"
    + "  if (s === 'HOLDING') {\n"
    + "    const pctStr = isNaN(myPct) ? '' : ` ${myPct}%`;\n"
    + "    el.className = 'hold';\n"
    + "    el.textContent = `Strategy ${sn} holding ${dir}${pctStr}`;\n"
    + "    return;\n"
    + "  }\n"
    + "  if (s === 'SELLING') {\n"
    + "    el.className = 'active';\n"
    + "    el.textContent = `Strategy ${sn} selling`;\n"
    + "    return;\n"
    + "  }\n"
    + "  if (s === 'WAIT_SELL_FILL') {\n"
    + "    el.className = 'active';\n"
    + "    el.textContent = `Strategy ${sn} waiting sell fill`;\n"
    + "    return;\n"
    + "  }\n"
    + "  if (s === 'DONE') {\n"
    + "    el.className = 'done';\n"
    + "    el.textContent = strat.cleanupAfterVerify ? `Strategy ${sn} cleanup after verify` : `Strategy ${sn} done`;\n"
    + "    return;\n"
    + "  }\n"
    + "}\n\nfunction getBnDiff() {";
  const replacementInitStrategyUI = [
    "async function initStrategyUI() {",
    "  try {",
    "    const res = await apiFetch('/api/strategy/descriptions');",
    "    if (!res.ok) return;",
    "    const descriptions = await res.json();",
    "    const container = document.getElementById('strat-groups');",
    "    if (!container) return;",
    "",
    "    strategyKeys = descriptions.map((d) => d.key);",
    "    for (const key of strategyKeys) {",
    "      if (!(key in stratEnabled)) stratEnabled[key] = false;",
    "      if (!(key in stratAmount)) stratAmount[key] = 1;",
    "    }",
    "",
    "    container.innerHTML = '';",
    "    for (const desc of descriptions) {",
    "      const group = document.createElement('div');",
    "      group.className = 'strat-group';",
    "",
    "      let tipHtml = `<div style=\"color:#f0a500;margin-bottom:4px\">${escapeHtml(desc.title)}</div>`;",
    "      for (const line of desc.lines || []) {",
    "        const style = [];",
    "        if (line.color) style.push(`color:${line.color}`);",
    "        if (line.marginTop) style.push('margin-top:4px');",
    "        const styleAttr = style.length ? ` style=\"${style.join(';')}\"` : '';",
    "        tipHtml += `<div${styleAttr}>${escapeHtml(line.text)}</div>`;",
    "      }",
    "",
    "      group.innerHTML = `",
    "        <label>",
    "          <input type=\"checkbox\" id=\"${desc.key}-chk\" title=\"Only updates the current running strategy config\">",
    "          <span class=\"strat-tip\">Strategy ${escapeHtml(String(desc.number))}: ${escapeHtml(desc.name)}",
    "            <div class=\"tip-box\">${tipHtml}</div>",
    "          </span>",
    "        </label>",
    "        <input type=\"number\" class=\"strat-amt\" id=\"${desc.key}-amt\" value=\"1\" min=\"0.01\" step=\"0.01\" title=\"Only updates the current running strategy config\">",
    "        <span style=\"color:#555\">U</span>",
    "      `;",
    "      container.appendChild(group);",
    "",
    "      stratChkEls[desc.key] = document.getElementById(`${desc.key}-chk`);",
    "      stratAmtEls[desc.key] = document.getElementById(`${desc.key}-amt`);",
    "    }",
    "",
    "    for (const key of strategyKeys) {",
    "      if (stratChkEls[key]) stratChkEls[key].addEventListener('change', saveStrategyConfigFromControls);",
    "      if (stratAmtEls[key]) stratAmtEls[key].addEventListener('change', saveStrategyConfigFromControls);",
    "    }",
    "",
    "    if (_pendingStrategyConfig) {",
    "      applyStrategyConfig(_pendingStrategyConfig);",
    "      _pendingStrategyConfig = null;",
    "    } else {",
    "      applyStrategyConfig({ enabled: stratEnabled, amount: stratAmount, maxRoundEntries });",
    "    }",
    "  } catch (e) {",
    "    console.warn('[initStrategyUI] failed', e?.message || e);",
    "  }",
    "}",
    "",
    "// Initialize strategy config UI.",
    "initStrategyUI();",
  ].join("\n");

  const replacementSignalHintBlock = [
    "const showHint = (msg) => {",
    "  if (!infoEl) return;",
    "  const prev = infoEl.textContent;",
    "  infoEl.textContent = msg;",
    "  setTimeout(() => { infoEl.textContent = prev; }, 2000);",
    "};",
    "const s = strat.state;",
    "if (s === 'BUYING' || s === 'HOLDING' || s === 'SELLING' || s === 'WAIT_FILL' || s === 'RECONCILING_FILL' || s === 'WAIT_SELL_FILL') {",
    "  showHint('Strategy is busy; wait for the current action');",
    "  return;",
    "}",
    "if (minSpan < 10000) {",
    "  const waitSec = Math.ceil((10000 - minSpan) / 1000);",
    "  showHint(`Collecting enough data... ${waitSec}s`);",
    "  return;",
    "}",
    "binanceOffset = calcAlignOffset();",
  ].join("\n");

  let normalizedRaw = raw.replaceAll(INDEX_HTML_WRAPPER, "");
  normalizedRaw = normalizedRaw
    .replace(/\/\/ .*?let strategyKeys = \[\];/m, "let strategyKeys = [];")
    .replace("// 缂佹稒鐗滈弳鎰板箥瑜戦、鎴炵▔椤撶媭娲ｆ慨婵勫灩椤曨喗�?  const s = strat.state;", "const s = strat.state;")
    .replace(/const showHint = \(msg\) => \{[\s\S]*?binanceOffset = calcAlignOffset\(\);/m, replacementSignalHintBlock)
    .replace("showHint('缂佹稒鐗滈弳鎰板箥瑜戦、鎴炵▔椤撱劎绀夐柡鍐У绾墎鈧潧缍婄�?);", "showHint('Strategy is busy; wait for the current action');")
    .replace("showHint(`閻庨潧缍婄紞鍫ュ极閻楀牆绁﹀☉鎾崇Х閸愬鏁嶅畝鈧悺鎴濐�?${waitSec}s`);", "showHint(`Collecting enough data... ${waitSec}s`);")
    .replace("if (isNaN(d)) { $el.textContent = '--; $el.className = 'gray'; return; }", "if (isNaN(d)) { $el.textContent = '--'; $el.className = 'gray'; return; }")
    .replace("$bestBid.textContent = '--;", "$bestBid.textContent = '--';")
    .replace("const label = marker.side === 'buy' ? '�? : '�?;", "const label = marker.side === 'buy' ? 'Buy' : 'Sell';")
    .replace("const probText = marker.prob != null ? `${marker.dir === 'up' ? '�? : '�?}${marker.prob}%` : '';", "const probText = marker.prob != null ? `${marker.dir === 'up' ? 'UP' : 'DN'} ${marker.prob}%` : '';")
    .replace("$bestAsk.textContent = '--;", "$bestAsk.textContent = '--';")
    .replace("$spreadVal.textContent = '--;", "$spreadVal.textContent = '--';")
    .replace("$probUp.textContent = '--;", "$probUp.textContent = '--';")
    .replace("$probDown.textContent = '--;", "$probDown.textContent = '--';")
    .replace("ctx.fillText('--鐢礁鐣ㄩ崷銊ょ瑐閺?, PAD_L + 4, PAD_T + 14);", "ctx.fillText('-- top clipped', PAD_L + 4, PAD_T + 14);")
    .replace("ctx.fillText('--鐢礁鐣ㄩ崷銊ょ瑓閺?, PAD_L + 4, PAD_T + ph - 4);", "ctx.fillText('-- bottom clipped', PAD_L + 4, PAD_T + ph - 4);")
    .replace("$estResult.textContent = price != null ? `�?$${(amount * price).toFixed(2)} USDC` : '--;", "$estResult.textContent = price != null ? `~$${(amount * price).toFixed(2)} USDC` : '--';")
    .replace("ctx.fillText(`${probPct}%濞戔�? w - PAD_R, probLabelY);", "ctx.fillText(`${probPct}%`, w - PAD_R, probLabelY);")
    .replace("ctx.fillText(`--prob${probPct}%`, PAD_L + 4, PAD_T + 28);", "ctx.fillText(`-- prob ${probPct}%`, PAD_L + 4, PAD_T + 28);")
    .replace("ctx.fillText(`--prob${probPct}%`, PAD_L + 4, PAD_T + ph - 18);", "ctx.fillText(`-- prob ${probPct}%`, PAD_L + 4, PAD_T + ph - 18);")
    .replace("ctx.fillText(`Offset{binanceOffset >= 0 ? '+' : ''}${Math.round(binanceOffset)}`", "ctx.fillText(`Offset ${binanceOffset >= 0 ? '+' : ''}${Math.round(binanceOffset)}`")
    .replace("ctx.fillText(`濮掑倻宸煎В鏂剧伐�?{Math.round(probScale)}`", "ctx.fillText(`Prob ${Math.round(probScale)}`")
    .replace(/function updateStratUI\(\) \{[\s\S]*?\n\}\n\nfunction getBnDiff\(\) \{/m, replacementUpdateStratUI)
    .replace(/async function initStrategyUI\(\) \{[\s\S]*?initStrategyUI\(\);/m, replacementInitStrategyUI);
  if (normalizedRaw.trimStart().toLowerCase().startsWith("<!doctype html")) {
    return injectOrderBookRescue(normalizedRaw);
  }
  return injectOrderBookRescue(`${INDEX_HTML_WRAPPER}${normalizedRaw}`);
}

function parseNumberEnv(name: string, fallback: number, minimum?: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  if (minimum != null && value < minimum) return fallback;
  return value;
}

function parseBooleanLike(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "off"].includes(normalized)) return false;
  }
  return null;
}

function parseNumberLike(value: unknown, minimum: number): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(parsed) || parsed < minimum) return null;
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null && !Array.isArray(value);
}

const PORT = parseNumberEnv("APP_PORT", 3456, 1);
const BIND_HOST = process.env.APP_BIND_HOST?.trim() || "127.0.0.1";
const RAW_API_TOKEN = process.env.APP_API_TOKEN?.trim() || "";
const { apiToken: API_TOKEN, apiTokenAutoDerived: API_TOKEN_AUTO_DERIVED, apiTokenRequired: API_TOKEN_REQUIRED } =
  resolveApiTokenState(RAW_API_TOKEN, process.env.POLYMARKET_PRIVATE_KEY);
const EXTERNAL_IO_DISABLED = parseBooleanEnv("APP_DISABLE_EXTERNAL_IO", false);
const MARKET_WS_URL    = "wss://ws-subscriptions-clob.polymarket.com/ws/market";
const CHAINLINK_WS_URL = "wss://ws-live-data.polymarket.com";
const USER_WS_URL      = "wss://ws-subscriptions-clob.polymarket.com/ws/user";
const BINANCE_WS_URL   = "wss://stream.binance.com:9443/ws/btcusdt@aggTrade";
const GAMMA_URL        = "https://gamma-api.polymarket.com";
const CLOB_URL         = "https://clob.polymarket.com";
const POLYGON_RPC_URL  = process.env.POLYGON_RPC_URL?.trim() || "https://polygon-bor-rpc.publicnode.com";

function resolveOutboundProxyUrl(): string {
  const candidates = [
    process.env.APP_PROXY_URL,
    process.env.APP_PROXY,
    process.env.OUTBOUND_PROXY_URL,
    process.env.HTTPS_PROXY,
    process.env.https_proxy,
    process.env.HTTP_PROXY,
    process.env.http_proxy,
    process.env.ALL_PROXY,
    process.env.all_proxy,
  ];
  for (const candidate of candidates) {
    const normalized = candidate?.trim();
    if (normalized) return normalized;
  }
  return "";
}

const OUTBOUND_PROXY_URL = resolveOutboundProxyUrl();
const OUTBOUND_PROXY_IS_LOOPBACK = isLoopbackProxyUrl(OUTBOUND_PROXY_URL);

// 清除系统代理环境变量，避免影响 ClobClient 的 HTTPS 请求
// 系统代理会导致 "400 The plain HTTP request was sent to HTTPS port" 错误
delete process.env.HTTPS_PROXY;
delete process.env.https_proxy;
delete process.env.HTTP_PROXY;
delete process.env.http_proxy;
delete process.env.ALL_PROXY;
delete process.env.all_proxy;

const WS_PROXY_AGENT = OUTBOUND_PROXY_URL ? buildProxyAgent(OUTBOUND_PROXY_URL) : undefined;
applyAxiosProxyDefaults(axios, WS_PROXY_AGENT);
const DIRECT_AXIOS = axios.create();
const PROXIED_AXIOS = WS_PROXY_AGENT
  ? axios.create({
    httpAgent: WS_PROXY_AGENT,
    httpsAgent: WS_PROXY_AGENT,
    proxy: false,
  })
  : DIRECT_AXIOS;
const PROXY_ENV_KEYS = [
  "APP_PROXY_URL",
  "APP_PROXY",
  "OUTBOUND_PROXY_URL",
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
  "ALL_PROXY",
  "all_proxy",
] as const;
let outboundProxyBypassed = false;

function isOutboundProxyActive(): boolean {
  return !!OUTBOUND_PROXY_URL && !outboundProxyBypassed;
}

function getOutboundWsOptions(): { agent?: ReturnType<typeof buildProxyAgent> } {
  return isOutboundProxyActive() && WS_PROXY_AGENT
    ? { agent: WS_PROXY_AGENT }
    : {};
}

function disableOutboundProxy(reason: string): boolean {
  if (!OUTBOUND_PROXY_URL || outboundProxyBypassed) return false;
  outboundProxyBypassed = true;
  for (const key of PROXY_ENV_KEYS) delete process.env[key];
  console.warn(`[Proxy] ${reason}; falling back to direct connections`);
  return true;
}

function maybeDisableProxyFromError(source: string, error: unknown): boolean {
  if (!OUTBOUND_PROXY_IS_LOOPBACK || !isOutboundProxyActive()) return false;
  if (!shouldBypassProxyAfterError(error)) return false;
  const detail = describeOutboundError(error);
  return disableOutboundProxy(`${source} failed through ${OUTBOUND_PROXY_URL}${detail ? ` (${detail})` : ""}`);
}

async function prepareOutboundProxy(): Promise<void> {
  if (!OUTBOUND_PROXY_IS_LOOPBACK || !OUTBOUND_PROXY_URL) return;
  const reachable = await probeLoopbackProxyAvailability(OUTBOUND_PROXY_URL, 250);
  if (reachable === false) {
    disableOutboundProxy(`loopback proxy ${OUTBOUND_PROXY_URL} is unavailable`);
  }
}

const USDC_ADDR        = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
async function externalGetJson<T>(url: string): Promise<T> {
  const client = isOutboundProxyActive() ? PROXIED_AXIOS : DIRECT_AXIOS;
  try {
    const response = await client.get(url, { responseType: "json" });
    return response.data as T;
  } catch (error) {
    if (client === PROXIED_AXIOS && maybeDisableProxyFromError(`HTTP ${url}`, error)) {
      const response = await DIRECT_AXIOS.get(url, { responseType: "json" });
      return response.data as T;
    }
    throw error;
  }
}

const HISTORY_RETENTION_MS = 130000;
const MAX_CHAINLINK_HISTORY_POINTS = 2000;
const MAX_BINANCE_HISTORY_POINTS = 4000;
const MAX_CONFIRMED_TRADE_IDS = 2000;
const CLAIM_CYCLE_DELAY_MS = 30000;
const UNVERIFIED_SELL_BUFFER = 0.05;
const POST_TRADE_CALIBRATION_MS = 18000;
const STRAT_BUY_LOCK_MS = POST_TRADE_CALIBRATION_MS;
const STRATEGY_TICK_MS = 250;
const WAIT_FILL_TIMEOUT_MS = 10000;
const FILL_RECONCILE_TIMEOUT_MS = POST_TRADE_CALIBRATION_MS + 2000;
const BINANCE_ALIGN_WINDOW_MS = 60000;
const BINANCE_ALIGN_MIN_SPAN_MS = 10000;
const BINANCE_ALIGN_BUCKET_MS = 500;
const BINANCE_ALIGN_REFRESH_MS = 30000;
const BINANCE_OFFSET_EPSILON = 0.01;
const FULL_DATA_STATE_INTERVAL_MS = 200;
const LOW_DATA_STATE_INTERVAL_MS = 2000;
const MAX_WS_BUFFERED_BYTES = 512 * 1024;
const MIN_STRATEGY_BUY_AMOUNT = 1;
const TRADE_HISTORY_FILE = resolve(__dirname, ".trade-history.json");
const STRATEGY_CONFIG_FILE = resolve(__dirname, ".strategy-config.json");
const BACKTEST_DATA_DIR = resolve(__dirname, "backtest-data");
const INDEX_HTML_FILE = resolve(__dirname, "index.html");
const TRADE_HISTORY_MAX = 200;
const PENDING_TRADE_META_MAX_AGE_MS = 15 * 60 * 1000;
const INDEX_HTML_WRAPPER =
  "<!doctype html>\n"
  + "<html lang=\"zh-CN\">\n"
  + "<head>\n"
  + "<meta charset=\"UTF-8\">\n"
  + "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\">\n"
  + "<title>BTC 5m Monitor</title>\n"
  + "<script>\n";

const ORDERBOOK_RESCUE_SCRIPT = String.raw`
<script>
(() => {
  if (window.__btc5mBookRescue) return;
  window.__btc5mBookRescue = true;
  document.documentElement.setAttribute("data-book-rescue", "1");
  const byId = (id) => document.getElementById(id);
  const normalizeLevels = (levels) => Array.isArray(levels)
    ? levels.map((level) => ({ price: Number(level?.price), size: Number(level?.size) }))
      .filter((level) => Number.isFinite(level.price) && Number.isFinite(level.size) && level.price > 0 && level.size > 0)
    : [];

  const renderOrders = (bids, asks) => {
    const asksWrap = byId('asks-wrap');
    const bidsWrap = byId('bids-wrap');
    if (!asksWrap || !bidsWrap) return;
    const safeBids = normalizeLevels(bids);
    const safeAsks = normalizeLevels(asks);
    const maxSize = Math.max(...safeBids.map((b) => b.size), ...safeAsks.map((a) => a.size), 1);
    asksWrap.innerHTML = [...safeAsks]
      .sort((a, b) => a.price - b.price)
      .slice(0, 6)
      .sort((a, b) => b.price - a.price)
      .map((a) => '<div class="order-row ask"><div class="depth-bar" style="width:' + ((a.size / maxSize) * 100).toFixed(1) + '%"></div><span class="up-price down">' + Math.round(a.price * 100) + '%</span><span class="qty">' + a.size.toFixed(1) + '</span><span class="dn-price down">' + Math.round((1 - a.price) * 100) + '%</span></div>')
      .join('');
    bidsWrap.innerHTML = [...safeBids]
      .sort((a, b) => b.price - a.price)
      .slice(0, 6)
      .map((b) => '<div class="order-row bid"><div class="depth-bar" style="width:' + ((b.size / maxSize) * 100).toFixed(1) + '%"></div><span class="up-price up">' + Math.round(b.price * 100) + '%</span><span class="qty">' + b.size.toFixed(1) + '</span><span class="dn-price up">' + Math.round((1 - b.price) * 100) + '%</span></div>')
      .join('');
  };

  const applyWsStatus = (msg) => {
    ['market', 'chainlink', 'user', 'binance'].forEach((key) => {
      const el = byId('ws-' + key);
      if (el) el.classList.toggle('on', !!msg[key]);
    });
  };

  const applyState = (msg) => {
    const bid = msg.probabilityReady ? Number(msg.bestBid) : NaN;
    const ask = msg.probabilityReady ? Number(msg.bestAsk) : NaN;
    const bestBid = byId('best-bid');
    const bestAsk = byId('best-ask');
    const spread = byId('spread-val');
    const compactMain = byId('compact-book-main');
    const compactSub = byId('compact-book-sub');
    if (bestBid) bestBid.textContent = Number.isFinite(bid) ? Math.round(bid * 100) + '%' : '--';
    if (bestAsk) bestAsk.textContent = Number.isFinite(ask) ? Math.round(ask * 100) + '%' : '--';
    if (spread) spread.textContent = Number.isFinite(bid) && Number.isFinite(ask) ? Math.round((ask - bid) * 100) + '%' : '--';
    if (compactMain && compactSub) {
      if (Number.isFinite(bid) && Number.isFinite(ask)) {
        compactMain.textContent = 'Bid ' + Math.round(bid * 100) + '% / Ask ' + Math.round(ask * 100) + '%';
        compactSub.textContent = 'Spread ' + Math.round((ask - bid) * 100) + '%';
      }
    }
    renderOrders(msg.bids, msg.asks);
  };

  const connect = () => {
    let token = '';
    try { token = String(localStorage.getItem('btc5m.apiToken') || '').trim(); } catch {}
    const protocols = token ? ['json', 'token.' + token] : ['json'];
    const url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;
    const ws = new WebSocket(url, protocols);
    ws.onopen = () => {
      document.documentElement.setAttribute("data-book-rescue-ws", "open"); ws.send(JSON.stringify({ type: 'clientConfig', dataMode: 'full' }));
    };
    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'state') { document.documentElement.setAttribute("data-book-rescue-state", "1"); document.documentElement.setAttribute("data-book-rescue-bid", String(msg.bestBid)); document.documentElement.setAttribute("data-book-rescue-ready", String(!!msg.probabilityReady)); applyState(msg); }
        if (msg.type === 'wsStatus') applyWsStatus(msg);
        if (msg.type === 'marketDown') renderOrders([], []);
      } catch (err) {
        console.error('[OrderBookRescue] message failed:', err?.message || err);
      }
    };
    ws.onclose = () => { document.documentElement.setAttribute("data-book-rescue-ws", "closed"); setTimeout(connect, 1500); };
    ws.onerror = () => { document.documentElement.setAttribute("data-book-rescue-ws", "error"); try { ws.close(); } catch {} };
  };

  const start = () => {
    document.documentElement.setAttribute("data-book-rescue-start", "1");
    fetch('/api/state', { cache: 'no-store' })
      .then((res) => res.json())
      .then((msg) => { document.documentElement.setAttribute("data-book-rescue-fetch", "ok"); applyState(msg); })
      .catch(() => { document.documentElement.setAttribute("data-book-rescue-fetch", "error"); });
    connect();
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
</script>
`;

function injectOrderBookRescue(html: string): string {
  if (html.includes("</head>")) return html.replace("</head>", `${ORDERBOOK_RESCUE_SCRIPT}</head>`);
  return html.includes("</body>")
    ? html.replace("</body>", `${ORDERBOOK_RESCUE_SCRIPT}</body>`)
    : `${html}${ORDERBOOK_RESCUE_SCRIPT}`;
}
const PRIVATE_KEY   = process.env.POLYMARKET_PRIVATE_KEY || "";
const PROXY_ADDRESS = process.env.POLYMARKET_PROXY_ADDRESS || "";
const LIVE_TRADING_ENABLED = parseBooleanEnv("LIVE_TRADING_ENABLED", false);
const APP_MODE: AppMode = process.env.APP_MODE === "headless" ? "headless" : "full";
const IS_FULL_MODE = APP_MODE === "full";
interface RuntimeReadinessReport {
  ready: boolean;
  liveTradingEnabled: boolean;
  checks: {
    privateKeyConfigured: boolean;
    privateKeyValid: boolean;
    proxyAddressConfigured: boolean;
    clobClientReady: boolean;
    marketWindowReady: boolean;
    probabilityReady: boolean;
    marketWsConnected: boolean;
    chainlinkWsConnected: boolean;
    binanceWsConnected: boolean;
    userWsConnected: boolean;
    positionsReady: boolean;
    claimReady: boolean;
  };
  blockers: string[];
}

function requiresTrustedOrigin(method: string): boolean {
  return !["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase());
}

function isValidPrivateKey(value: string): boolean {
  return /^0x[0-9a-fA-F]{64}$/.test(value);
}

function assertRuntimeConfig(): void {
  if (LIVE_TRADING_ENABLED && PRIVATE_KEY && !isValidPrivateKey(PRIVATE_KEY)) {
    throw new Error("POLYMARKET_PRIVATE_KEY invalid: expected 0x + 64 hex chars");
  }
}

function getRuntimeReadinessReport(): RuntimeReadinessReport {
  const privateKeyConfigured = PRIVATE_KEY.length > 0;
  const privateKeyValid = privateKeyConfigured && isValidPrivateKey(PRIVATE_KEY);
  const proxyAddressConfigured = PROXY_ADDRESS.trim().length > 0;
  const marketWindowReady = Boolean(state.windowStart && state.upTokenId && state.downTokenId) && !isOrderWindowStale();
  const probabilityReady = isProbabilityReady();
  const positionsReady = strategyRuntime.positionsReady;
  const claimReady = LIVE_TRADING_ENABLED && privateKeyValid && proxyAddressConfigured;
  const checks = {
    privateKeyConfigured,
    privateKeyValid,
    proxyAddressConfigured,
    clobClientReady: clobClient != null,
    marketWindowReady,
    probabilityReady,
    marketWsConnected: wsStatus.market,
    chainlinkWsConnected: wsStatus.chainlink,
    binanceWsConnected: wsStatus.binance,
    userWsConnected: wsStatus.user,
    positionsReady,
    claimReady,
  };
  const blockers: string[] = [];

  if (!LIVE_TRADING_ENABLED) blockers.push("LIVE_TRADING_ENABLED is false");
  if (!privateKeyConfigured) blockers.push("POLYMARKET_PRIVATE_KEY is not configured");
  else if (!privateKeyValid) blockers.push("POLYMARKET_PRIVATE_KEY format is invalid");
  if (!checks.clobClientReady) blockers.push("CLOB client is not initialized");
  if (!checks.marketWindowReady) blockers.push("Current market window is not ready");
  if (!checks.probabilityReady) blockers.push("Probability signal is not ready");
  if (!checks.marketWsConnected) blockers.push("Market websocket is disconnected");
  if (!checks.chainlinkWsConnected) blockers.push("Chainlink websocket is disconnected");
  if (!checks.binanceWsConnected) blockers.push("Binance websocket is disconnected");
  if (!checks.userWsConnected) blockers.push("User websocket is disconnected");
  if (proxyAddressConfigured && !positionsReady) blockers.push("Positions are not synchronized yet");

  return {
    ready: blockers.length === 0,
    liveTradingEnabled: LIVE_TRADING_ENABLED,
    checks,
    blockers,
  };
}

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

function getRateLimitKey(headers: Record<string, string | string[] | undefined>, remoteAddress: string | undefined, bucket: string): string {
  const token = extractToken(headers);
  return `${bucket}:${token || remoteAddress || "unknown"}`;
}

function createRateLimitMiddleware(options: { bucket: string; windowMs: number; max: number }) {
  const store = new Map<string, RateLimitEntry>();
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const now = Date.now();
    for (const [entryKey, entry] of store) {
      if (entry.resetAt <= now) store.delete(entryKey);
    }
    const key = getRateLimitKey(req.headers, req.socket.remoteAddress, options.bucket);
    const current = store.get(key);
    if (!current || current.resetAt <= now) {
      store.set(key, { count: 1, resetAt: now + options.windowMs });
      next();
      return;
    }
    if (current.count >= options.max) {
      res.status(429).json({ error: "Too many requests" });
      return;
    }
    current.count += 1;
    next();
  };
}

function createEnvStrategyConfig(): StrategyConfig {
  const enabled = {} as Record<StrategyKey, boolean>;
  const amount = {} as Record<StrategyKey, number>;
  for (const key of ALL_STRATEGY_KEYS) {
    const upper = key.toUpperCase();
    enabled[key] = parseBooleanEnv(`STRATEGY_${upper}_ENABLED`, false);
    amount[key] = parseNumberEnv(`STRATEGY_${upper}_AMOUNT`, 1, MIN_STRATEGY_BUY_AMOUNT);
  }
  return {
    enabled,
    amount,
    slippage: parseNumberEnv("ORDER_DEFAULT_SLIPPAGE", 0.05, 0),
    autoClaimEnabled: parseBooleanEnv("AUTO_CLAIM_ENABLED", true),
    maxRoundEntries: parseNumberEnv("MAX_ROUND_ENTRIES", 1, 1),
  };
}

function cloneStrategyConfig(config: StrategyConfig): StrategyConfig {
  return {
    enabled: { ...config.enabled },
    amount: { ...config.amount },
    slippage: config.slippage,
    autoClaimEnabled: config.autoClaimEnabled,
    maxRoundEntries: config.maxRoundEntries,
  };
}

function loadPersistedStrategyConfig(config: StrategyConfig): void {
  if (!existsSync(STRATEGY_CONFIG_FILE)) return;
  try {
    const raw = JSON.parse(readFileSync(STRATEGY_CONFIG_FILE, "utf-8"));
    if (typeof raw.maxRoundEntries === "number" && raw.maxRoundEntries >= 1) {
      config.maxRoundEntries = Math.floor(raw.maxRoundEntries);
    }
  } catch {
    // ignore
  }
}

function savePersistedStrategyConfig(config: StrategyConfig): void {
  try {
    writeFileSync(STRATEGY_CONFIG_FILE, JSON.stringify({ maxRoundEntries: config.maxRoundEntries }, null, 2));
  } catch (err) {
    console.warn(`[StrategyConfig] 持久化保存失败: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function applyStrategyConfigUpdate(current: StrategyConfig, rawUpdate: unknown): { config?: StrategyConfig; error?: string } {
  if (!isRecord(rawUpdate)) return { error: "Invalid strategy config payload" };
  const next = cloneStrategyConfig(current);

  if ("enabled" in rawUpdate) {
    if (!isRecord(rawUpdate.enabled)) return { error: "Invalid enabled config" };
    for (const key of ALL_STRATEGY_KEYS) {
      if (!(key in rawUpdate.enabled)) continue;
      const parsed = parseBooleanLike(rawUpdate.enabled[key]);
      if (parsed == null) return { error: `${key} enabled must be a boolean` };
      next.enabled[key] = parsed;
    }
  }

  if ("amount" in rawUpdate) {
    if (!isRecord(rawUpdate.amount)) return { error: "Invalid amount config" };
    for (const key of ALL_STRATEGY_KEYS) {
      if (!(key in rawUpdate.amount)) continue;
      const parsed = parseNumberLike(rawUpdate.amount[key], MIN_STRATEGY_BUY_AMOUNT);
      if (parsed == null) return { error: `${key} amount must be >= ${MIN_STRATEGY_BUY_AMOUNT}` }; next.amount[key] = parsed;
    }
  }

  if ("slippage" in rawUpdate) {
    const parsed = parseNumberLike(rawUpdate.slippage, 0);
    if (parsed == null) return { error: "slippage must be >= 0" };
    next.slippage = parsed;
  }

  if ("autoClaimEnabled" in rawUpdate) {
    const parsed = parseBooleanLike(rawUpdate.autoClaimEnabled);
    if (parsed == null) return { error: "autoClaimEnabled must be a boolean" };
    next.autoClaimEnabled = parsed;
  }

  if ("maxRoundEntries" in rawUpdate) {
    const parsed = parseNumberLike(rawUpdate.maxRoundEntries, 1);
    if (parsed == null || !Number.isInteger(parsed)) return { error: "maxRoundEntries must be an integer >= 1" };
    next.maxRoundEntries = parsed;
  }

  return { config: next };
}

let strategyConfig = createEnvStrategyConfig();
loadPersistedStrategyConfig(strategyConfig);
let tradeHistory: TradeHistoryItem[] = loadTradeHistory();
const pendingTradeMeta = new Map<string, PendingTradeMeta>();

function loadTradeHistory(): TradeHistoryItem[] {
  if (!existsSync(TRADE_HISTORY_FILE)) return [];
  try {
    const raw = JSON.parse(readFileSync(TRADE_HISTORY_FILE, "utf-8")) as unknown;
    if (!Array.isArray(raw)) return [];
    const filtered = raw
      .filter((item): item is TradeHistoryItem => isRecord(item)
        && typeof item.id === "string"
        && typeof item.ts === "number"
        && typeof item.windowStart === "number"
        && (item.side === "buy" || item.side === "sell")
        && (item.direction === "up" || item.direction === "down")
        && typeof item.amount === "number"
        && typeof item.status === "string"
        && typeof item.source === "string"
        && (typeof item.price === "number" || typeof item.worstPrice === "number"))
      .slice(0, TRADE_HISTORY_MAX);
    return applyTradeHistoryMetrics(filtered);
  } catch (err) {
    console.warn(`[TradeHistory] load failed: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

function persistTradeHistory(): void {
  writeFileSync(TRADE_HISTORY_FILE, `${JSON.stringify(tradeHistory, null, 2)}\n`, "utf-8");
}

function getTradeHistoryPrice(item: TradeHistoryItem): number | null {
  const candidate = typeof item.price === "number"
    ? item.price
    : typeof item.worstPrice === "number"
      ? item.worstPrice
      : NaN;
  return Number.isFinite(candidate) ? candidate : null;
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function applyTradeHistoryMetrics(items: TradeHistoryItem[]): TradeHistoryItem[] {
  const lots: Record<StrategyDirection, Array<{ amount: number; price: number }>> = {
    up: [],
    down: [],
  };
  const ordered = [...items].sort((a, b) => a.ts - b.ts);
  for (const item of ordered) {
    const price = getTradeHistoryPrice(item);
    item.price = price;
    item.pnl = null;
    if (price == null || !Number.isFinite(item.amount) || item.amount <= 0) continue;
    if (item.side === "buy") {
      lots[item.direction].push({ amount: item.amount, price });
      continue;
    }
    let remaining = item.amount;
    let realizedPnl = 0;
    let matchedAmount = 0;
    const directionLots = lots[item.direction];
    while (remaining > 1e-8 && directionLots.length > 0) {
      const lot = directionLots[0];
      const matched = Math.min(remaining, lot.amount);
      realizedPnl += (price - lot.price) * matched;
      lot.amount -= matched;
      remaining -= matched;
      matchedAmount += matched;
      if (lot.amount <= 1e-8) directionLots.shift();
    }
    if (matchedAmount > 0) {
      item.pnl = roundMoney(realizedPnl);
    }
  }
  return items.sort((a, b) => b.ts - a.ts);
}

function recordTradeHistory(item: Omit<TradeHistoryItem, "id">): void {
  const record: TradeHistoryItem = {
    id: `${item.ts}-${item.side}-${item.direction}-${item.source}-${Math.random().toString(36).slice(2, 8)}`,
    ...item,
  };
  tradeHistory.unshift(record);
  if (tradeHistory.length > TRADE_HISTORY_MAX) {
    tradeHistory = tradeHistory.slice(0, TRADE_HISTORY_MAX);
  }
  tradeHistory = applyTradeHistoryMetrics(tradeHistory);
  try {
    persistTradeHistory();
  } catch (err) {
    console.warn(`[TradeHistory] save failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  broadcastTradeHistory();
}

function cleanupPendingTradeMeta(now = Date.now()): void {
  for (const [key, meta] of pendingTradeMeta) {
    if (now - meta.ts > PENDING_TRADE_META_MAX_AGE_MS) {
      pendingTradeMeta.delete(key);
    }
  }
}

function rememberPendingTradeMeta(meta: Omit<PendingTradeMeta, "key">): void {
  cleanupPendingTradeMeta(meta.ts);
  const key = meta.orderId || `pending-${meta.ts}-${Math.random().toString(36).slice(2, 8)}`;
  pendingTradeMeta.set(key, { key, ...meta });
}

function normalizeTradeSide(value: unknown): "buy" | "sell" | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === "buy") return "buy";
  if (normalized === "sell") return "sell";
  return null;
}

function getDirectionByAssetId(assetId: string): StrategyDirection | null {
  if (assetId === state.upTokenId) return "up";
  if (assetId === state.downTokenId) return "down";
  return null;
}

function parseTradeEventTimestamp(evt: Record<string, unknown>): number {
  const raw = typeof evt.match_time === "string"
    ? evt.match_time
    : typeof evt.last_update === "string"
      ? evt.last_update
      : "";
  const parsed = raw ? Date.parse(raw) : NaN;
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function consumePendingTradeMeta(evt: Record<string, unknown>): PendingTradeMeta | null {
  cleanupPendingTradeMeta();
  const candidateIds: string[] = [];
  if (typeof evt.taker_order_id === "string" && evt.taker_order_id) {
    candidateIds.push(evt.taker_order_id);
  }
  if (Array.isArray(evt.maker_orders)) {
    for (const makerOrder of evt.maker_orders) {
      if (!isRecord(makerOrder) || typeof makerOrder.order_id !== "string" || !makerOrder.order_id) continue;
      candidateIds.push(makerOrder.order_id);
    }
  }
  for (const id of candidateIds) {
    const meta = pendingTradeMeta.get(id);
    if (!meta) continue;
    pendingTradeMeta.delete(id);
    return meta;
  }

  const side = normalizeTradeSide(evt.side);
  const assetId = typeof evt.asset_id === "string" ? evt.asset_id : "";
  const size = typeof evt.size === "number" ? evt.size : Number(evt.size);
  if (!side || !assetId || !Number.isFinite(size)) return null;

  let bestKey: string | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const [key, meta] of pendingTradeMeta) {
    const directionTokenId = meta.direction === "up" ? state.upTokenId : state.downTokenId;
    if (directionTokenId !== assetId || meta.side !== side) continue;
    const score = Math.abs(meta.amount - size) * 1000 + Math.abs(Date.now() - meta.ts) / 1000;
    if (score < bestScore) {
      bestScore = score;
      bestKey = key;
    }
  }
  if (!bestKey) return null;
  const meta = pendingTradeMeta.get(bestKey) || null;
  if (meta) pendingTradeMeta.delete(bestKey);
  return meta;
}

// -----------------------------------------------------------------------------
interface PolymarketCreds {
  key: string; secret: string; passphrase: string; address: string;
}

let inMemoryCreds: PolymarketCreds | null = null;

function adaptSigner(wallet: Wallet) {
  return {
    _signTypedData: (
      domain: Record<string, unknown>,
      types: Record<string, unknown[]>,
      value: Record<string, unknown>
    ) => wallet.signTypedData(
      domain as TypedDataDomain,
      types as Record<string, TypedDataField[]>,
      value
    ),
    getAddress: () => Promise.resolve(wallet.address),
  };
}

async function createClobClient(): Promise<ClobClient | null> {
  const sigType = PROXY_ADDRESS ? SignatureType.POLY_GNOSIS_SAFE : SignatureType.EOA;
  const funder  = PROXY_ADDRESS || undefined;

  if (inMemoryCreds) {
    const signer = PRIVATE_KEY ? adaptSigner(new Wallet(PRIVATE_KEY)) as any : undefined;
    return new ClobClient(CLOB_URL, 137, signer, inMemoryCreds, sigType, funder);
  }

  if (!PRIVATE_KEY) {
    console.warn("[Auth] 未配置 POLYMARKET_PRIVATE_KEY，下单功能不可用");
    return null;
  }

  console.log("[Auth] 首次使用，通过私钥生成 Polymarket API 凭证（仅保存在内存中）...");
  const wallet = new Wallet(PRIVATE_KEY);
  const signer = adaptSigner(wallet) as any;
  const client = new ClobClient(CLOB_URL, 137, signer, undefined, sigType, funder);
  const creds  = await client.createOrDeriveApiKey();
  inMemoryCreds = { key: creds.key, secret: creds.secret, passphrase: creds.passphrase, address: wallet.address };
  return new ClobClient(CLOB_URL, 137, signer, creds, sigType, funder);
}
// -----------------------------------------------------------------------------
const app = express();
app.disable("x-powered-by");
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "same-origin");

  res.setHeader("Cache-Control", "no-store");
  next();
});
app.use(express.json({ limit: "32kb" }));
if (IS_FULL_MODE) {
  app.use(express.static(__dirname, { index: false }));
  app.get("/", (_req, res) => {
    res.type("html").send(buildIndexHtmlDocument());
  });
} else {
  app.get("/", (_req, res) => {
    res.json({
      name: "btc5m-web",
      mode: APP_MODE,
      stateUrl: "/api/state",
    });
  });
}

app.get("/api/public-config", (req, res) => {
  res.json({
    tokenRequired: shouldPublicConfigRequireToken(req.headers, req.socket.remoteAddress, {
      bindHost: BIND_HOST,
      apiToken: API_TOKEN,
      apiTokenRequired: API_TOKEN_REQUIRED,
      apiTokenAutoDerived: API_TOKEN_AUTO_DERIVED,
    }),
    bindHost: BIND_HOST,
    liveTradingEnabled: LIVE_TRADING_ENABLED,
  });
});

app.use("/api", (req, res, next) => {
  // 从 URL 参数中提取 token 并添加到 headers，以便 extractToken 函数能识别
  if (req.url) {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const urlToken = url.searchParams.get("token");
      if (urlToken && typeof req.headers === "object") {
        req.headers["x-api-token"] = urlToken;
      }
    } catch {
      // 忽略 URL 解析错误
    }
  }

  if (!isAuthorized(req.headers, req.socket.remoteAddress, {
    bindHost: BIND_HOST,
    apiToken: API_TOKEN,
    apiTokenRequired: API_TOKEN_REQUIRED,
    apiTokenAutoDerived: API_TOKEN_AUTO_DERIVED,
  })) {
    res.status(API_TOKEN_REQUIRED ? 401 : 403).json({
      error: API_TOKEN_REQUIRED ? "Unauthorized: provide APP_API_TOKEN" : "Local-only endpoint",
    });
    return;
  }
  if (requiresTrustedOrigin(req.method) && !hasTrustedOrigin(req.headers, BIND_HOST)) {
    res.status(403).json({ error: "非法来源，请从本地控制台发起请求" });
    return;
  }
  next();
});


const mutationRateLimiter = createRateLimitMiddleware({ bucket: "mutation", windowMs: 60_000, max: 30 });
const tradeActionRateLimiter = createRateLimitMiddleware({ bucket: "trade", windowMs: 60_000, max: 10 });
const server = createServer(app);
const wss = IS_FULL_MODE ? new WebSocketServer({
  server,
  handleProtocols: (protocols) => {
    if (protocols.has("json")) return "json";
    const first = protocols.values().next();
    return first.done ? false : first.value;
  },
}) : null;
const clientSessions = new Map<WebSocket, ClientSession>();

// -----------------------------------------------------------------------------
let clobClient: ClobClient | null = null;

async function ensureClobClient(): Promise<boolean> {
  if (clobClient) return true;
  try { clobClient = await createClobClient(); return clobClient != null; }
  catch (err) { console.error("[CLOB] initialization failed", err); return false; }
}

// -----------------------------------------------------------------------------
const state = {
  windowStart: 0,
  windowEnd: 0,
  upTokenId: "",
  downTokenId: "",
  conditionId: "",
  bids: new Map<string, string>(),
  asks: new Map<string, string>(),
  bestBid: "-",
  bestAsk: "-",
  lastPrice: "-",
  lastSide: "",
  updatedAt: 0,
  priceToBeat: null as number | null,
  currentPrice: null as number | null,
  binanceOffset: null as number | null,
  priceHistory: [] as Array<{ t: number; price: number }>,
  binanceHistory: [] as Array<{ t: number; price: number }>,
};

const orderBookSnapshotCache: OrderBookSnapshotCache = {
  bids: [],
  asks: [],
  dirty: true,
};

const strategyRuntime: StrategyRuntimeState = {
  state: "IDLE",
  activeStrategy: null,
  direction: null,
  buyAmount: 0,
  posBeforeBuy: 0,
  posBeforeSell: 0,
  waitVerifyAfterSell: false,
  cleanupAfterVerify: false,
  actionTs: 0,
  prevUpPct: null,
  buyLockUntil: 0,
  positionsReady: !PROXY_ADDRESS,
  roundEntryCount: 0,
};

// -----------------------------------------------------------------------------
const wsStatus = { market: false, chainlink: false, user: false, binance: false };
function broadcastWsStatus() { broadcast("wsStatus", wsStatus as unknown as Record<string, unknown>); }
const positions = {
  usdc: null as number | null,
  usdcAllowanceStatus: "unknown" as "approved" | "partially-approved" | "not-approved" | "unknown",
  usdcAllowanceMin: null as number | null,
  usdcAllowanceDetails: [] as Array<{ spender: string; amount: number | null }>,
  otherPositions: [] as PortfolioPosition[],
  localSize: {} as Record<string, number>,
  apiSize: {} as Record<string, number>,
  apiVerified: {} as Record<string, boolean>,
  confirmedIds: new Set<string>(),
  confirmedIdOrder: [] as string[],
  lastTradeAt: null as number | null,
  lastApiSyncAt: null as number | null,
};

// -----------------------------------------------------------------------------
let autoPriceToBeatWindowStart = 0;
function send(ws: WebSocket, type: string, data: Record<string, unknown>): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type, ...data }));
}

function sendTradeHistoryToClient(ws: WebSocket): void {
  send(ws, "tradeHistory", { tradeHistory });
}

function broadcastTradeHistory(): void {
  broadcast("tradeHistory", { tradeHistory });
}

function invalidateOrderBookSnapshot(): void {
  orderBookSnapshotCache.dirty = true;
}

function rebuildOrderBookSnapshot(): void {
  orderBookSnapshotCache.bids = [...state.bids.entries()]
    .map(([price, size]) => ({ price: Number(price), size: Number(size) }))
    .filter((level) => Number.isFinite(level.price) && Number.isFinite(level.size) && level.price > 0 && level.size > 0)
    .sort((a, b) => b.price - a.price)
    .slice(0, 8);
  orderBookSnapshotCache.asks = [...state.asks.entries()]
    .map(([price, size]) => ({ price: Number(price), size: Number(size) }))
    .filter((level) => Number.isFinite(level.price) && Number.isFinite(level.size) && level.price > 0 && level.size > 0)
    .sort((a, b) => a.price - b.price)
    .slice(0, 8);
  orderBookSnapshotCache.dirty = false;
}

function getOrderBookSnapshot(): { bids: OrderBookLevel[]; asks: OrderBookLevel[] } {
  if (orderBookSnapshotCache.dirty) rebuildOrderBookSnapshot();
  return {
    bids: orderBookSnapshotCache.bids,
    asks: orderBookSnapshotCache.asks,
  };
}

function normalizeDecimalString(value: unknown): string | null {
  const numeric = typeof value === "number"
    ? value
    : typeof value === "string"
      ? Number(value)
      : NaN;
  if (!Number.isFinite(numeric)) return null;
  return String(numeric);
}

function normalizeMarketAssetId(payload: Record<string, unknown>): string {
  if (typeof payload.asset_id === "string" && payload.asset_id) return payload.asset_id;
  if (typeof payload.asset === "string" && payload.asset) return payload.asset;
  return "";
}

function normalizeOrderBookLevels(levels: unknown): Array<{ price: string; size: string }> {
  if (!Array.isArray(levels)) return [];
  const normalized: Array<{ price: string; size: string }> = [];
  for (const level of levels) {
    let price: string | null = null;
    let size: string | null = null;
    if (Array.isArray(level)) {
      price = normalizeDecimalString(level[0]);
      size = normalizeDecimalString(level[1]);
    } else if (isRecord(level)) {
      price = normalizeDecimalString(level.price);
      size = normalizeDecimalString(level.size ?? level.quantity ?? level.amount);
    }
    if (!price || !size) continue;
    if (!(Number(price) > 0) || !(Number(size) > 0)) continue;
    normalized.push({ price, size });
  }
  return normalized;
}

function getTopOfBookFromOrderBookState(): { bestBid: string; bestAsk: string } | null {
  let bestBid = Number.NEGATIVE_INFINITY;
  let bestAsk = Number.POSITIVE_INFINITY;

  for (const [price, size] of state.bids) {
    const numericPrice = Number(price);
    const numericSize = Number(size);
    if (!Number.isFinite(numericPrice) || !Number.isFinite(numericSize) || numericPrice <= 0 || numericSize <= 0) continue;
    bestBid = Math.max(bestBid, numericPrice);
  }

  for (const [price, size] of state.asks) {
    const numericPrice = Number(price);
    const numericSize = Number(size);
    if (!Number.isFinite(numericPrice) || !Number.isFinite(numericSize) || numericPrice <= 0 || numericSize <= 0) continue;
    bestAsk = Math.min(bestAsk, numericPrice);
  }

  if (!Number.isFinite(bestBid) || !Number.isFinite(bestAsk) || bestBid <= 0 || bestAsk <= 0) return null;
  return {
    bestBid: String(bestBid),
    bestAsk: String(bestAsk),
  };
}

function applyBestBidAskFromOrderBook(timestamp: unknown): boolean {
  const top = getTopOfBookFromOrderBookState();
  if (!top) return false;
  return applyBestBidAskUpdate(top.bestBid, top.bestAsk, timestamp);
}

function createClientSession(dataMode: ClientDataMode): ClientSession {
  return {
    dataMode,
    lastStateSentAt: 0,
    stateTimer: null,
    stateDirty: false,
    stateIncludeHistory: false,
  };
}

function normalizeClientDataMode(value: unknown): ClientDataMode {
  return value === "low" ? "low" : "full";
}

function resolveClientDataModeFromUrl(urlValue: string | undefined): ClientDataMode {
  if (!urlValue) return "full";
  try {
    const url = new URL(urlValue, `http://localhost:${PORT}`);
    return normalizeClientDataMode(url.searchParams.get("dataMode"));
  } catch {
    return "full";
  }
}

function getClientSession(ws: WebSocket): ClientSession {
  let session = clientSessions.get(ws);
  if (!session) {
    session = createClientSession("full");
    clientSessions.set(ws, session);
  }
  return session;
}

function clearStateTimer(session: ClientSession): void {
  if (session.stateTimer) {
    clearTimeout(session.stateTimer);
    session.stateTimer = null;
  }
}

function getStateIntervalMs(session: ClientSession): number {
  return session.dataMode === "low" ? LOW_DATA_STATE_INTERVAL_MS : FULL_DATA_STATE_INTERVAL_MS;
}

function shouldSendRealtimeEvent(type: string, ws: WebSocket, session: ClientSession): boolean {
  if (session.dataMode === "low" && (type === "chainlinkPrice" || type === "binancePrice")) {
    return false;
  }
  if ((type === "chainlinkPrice" || type === "binancePrice") && ws.bufferedAmount > MAX_WS_BUFFERED_BYTES) {
    return false;
  }
  return true;
}

function broadcast(type: string, data: Record<string, unknown>): void {
  if (!wss) return;
  const msg = JSON.stringify({ type, ...data });
  for (const client of wss.clients) {
    if (client.readyState !== WebSocket.OPEN) continue;
    const session = getClientSession(client);
    if (!shouldSendRealtimeEvent(type, client, session)) continue;
    client.send(msg);
  }
}

function trimHistory<T extends { t: number }>(points: T[], cutoff: number, maxPoints: number): void {
  while (points.length > 0 && points[0].t < cutoff) points.shift();
  if (points.length > maxPoints) points.splice(0, points.length - maxPoints);
}

function rememberBounded(set: Set<string>, order: string[], key: string, maxSize: number): boolean {
  if (set.has(key)) return false;
  set.add(key);
  order.push(key);
  while (order.length > maxSize) {
    const oldest = order.shift();
    if (oldest !== undefined) set.delete(oldest);
  }
  return true;
}

function prunePositionCaches(activeTokenIds: string[]): void {
  const keep = new Set(activeTokenIds.filter(Boolean));
  for (const store of [positions.localSize, positions.apiSize, positions.apiVerified]) {
    for (const key of Object.keys(store)) {
      if (!keep.has(key)) delete store[key];
    }
  }
}

function getDirectionTokenId(direction: StrategyDirection | null): string {
  if (direction === "up") return state.upTokenId;
  if (direction === "down") return state.downTokenId;
  return "";
}

function getDirectionLocalSize(direction: StrategyDirection | null): number {
  const tokenId = getDirectionTokenId(direction);
  return tokenId ? (positions.localSize[tokenId] ?? 0) : 0;
}

function getDirectionApiSize(direction: StrategyDirection | null): number {
  const tokenId = getDirectionTokenId(direction);
  return tokenId ? (positions.apiSize[tokenId] ?? 0) : 0;
}

function buildPortfolioPositions(rawPositions: Array<Record<string, unknown>>): PortfolioPosition[] {
  const currentTokenIds = new Set([state.upTokenId, state.downTokenId].filter(Boolean));
  const items: PortfolioPosition[] = [];

  for (const raw of rawPositions) {
    const asset = typeof raw.asset === "string" ? raw.asset : "";
    const size = parseNumberLike(raw.size, 0.01);
    if (!asset || size == null || currentTokenIds.has(asset)) continue;

    const title = typeof raw.title === "string" && raw.title.trim()
      ? raw.title.trim()
      : `Position ...${asset.slice(-6)}`;
    const outcome = typeof raw.outcome === "string" && raw.outcome.trim()
      ? raw.outcome.trim()
      : "";
    const currentValue = parseNumberLike(raw.currentValue, 0);
    const curPrice = parseNumberLike(raw.curPrice, 0);
    const conditionId = typeof raw.conditionId === "string" && raw.conditionId
      ? raw.conditionId
      : undefined;

    let status: PortfolioPosition["status"] = "active";
    if (curPrice != null && curPrice >= 0.999) status = "claimable";
    else if ((curPrice != null && curPrice <= 0.001) || (currentValue != null && currentValue <= 0.0001)) status = "lost";

    items.push({
      asset,
      title,
      outcome,
      size,
      currentValue,
      curPrice,
      conditionId,
      status,
    });
  }

  return items.slice(0, 12);
}

function isDirectionVerified(direction: StrategyDirection | null): boolean {
  const tokenId = getDirectionTokenId(direction);
  return tokenId ? (positions.apiVerified[tokenId] ?? false) : false;
}

function hasOpenPosition(): boolean {
  return getDirectionLocalSize("up") > 0.01 || getDirectionLocalSize("down") > 0.01;
}

function hasEnoughUsdcForBuy(amount: number): boolean {
  if (positions.usdc == null || !Number.isFinite(amount)) return true;
  return positions.usdc + 1e-6 >= amount;
}

function hasPendingStrategyBuyLock(now = Date.now()): boolean {
  return now < strategyRuntime.buyLockUntil;
}

function getSellableShares(direction: StrategyDirection | null): number {
  const localSize = getDirectionLocalSize(direction);
  if (localSize <= 0) return 0;
  if (isDirectionVerified(direction)) return localSize;
  return Math.max(0, localSize - UNVERIFIED_SELL_BUFFER);
}

function getLatestBinancePrice(): number | null {
  const point = state.binanceHistory[state.binanceHistory.length - 1];
  return point?.price ?? null;
}

function getProbabilitySnapshot(): { upPct: number; dnPct: number } | null {
  if (!isProbabilityReady()) return null;
  const bid = Number(state.bestBid);
  const ask = Number(state.bestAsk);
  if (!Number.isFinite(bid) || !Number.isFinite(ask)) return null;
  const mid = (bid + ask) / 2;
  return {
    upPct: Math.round(mid * 100),
    dnPct: Math.round((1 - mid) * 100),
  };
}

function getStrategyDiff(): number | null {
  const latestBinancePrice = getLatestBinancePrice();
  if (latestBinancePrice == null || state.priceToBeat == null || state.binanceOffset == null) return null;
  return latestBinancePrice - (state.priceToBeat - state.binanceOffset);
}

function calcMedian(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function calcTrimmedMean(values: number[], trimRatio = 0.15): number | null {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const trim = sorted.length >= 8 ? Math.floor(sorted.length * trimRatio) : 0;
  const trimmed = trim > 0 ? sorted.slice(trim, sorted.length - trim) : sorted;
  if (!trimmed.length) return null;
  return trimmed.reduce((sum, value) => sum + value, 0) / trimmed.length;
}

function calculateBinanceOffset(allowLatestFallback = false): number | null {
  if (!state.binanceHistory.length || !state.priceHistory.length) {
    if (!allowLatestFallback) return null;
    const latestBinancePrice = getLatestBinancePrice();
    if (latestBinancePrice == null || state.currentPrice == null) return null;
    return state.currentPrice - latestBinancePrice;
  }

  const now = Date.now();
  const binanceRecent = state.binanceHistory.filter((point) => point.t >= now - BINANCE_ALIGN_WINDOW_MS);
  const chainlinkRecent = state.priceHistory.filter((point) => point.t >= now - BINANCE_ALIGN_WINDOW_MS);
  if (!binanceRecent.length || !chainlinkRecent.length) {
    if (!allowLatestFallback) return null;
    const latestBinancePrice = getLatestBinancePrice();
    if (latestBinancePrice == null || state.currentPrice == null) return null;
    return state.currentPrice - latestBinancePrice;
  }

  const binanceSpan = binanceRecent.length >= 2
    ? binanceRecent[binanceRecent.length - 1].t - binanceRecent[0].t
    : 0;
  const chainlinkSpan = chainlinkRecent.length >= 2
    ? chainlinkRecent[chainlinkRecent.length - 1].t - chainlinkRecent[0].t
    : 0;

  if (Math.min(binanceSpan, chainlinkSpan) < BINANCE_ALIGN_MIN_SPAN_MS) {
    if (!allowLatestFallback) return null;
    return chainlinkRecent[chainlinkRecent.length - 1].price - binanceRecent[binanceRecent.length - 1].price;
  }

  const overlapStart = Math.max(binanceRecent[0].t, chainlinkRecent[0].t);
  const overlapEnd = Math.min(binanceRecent[binanceRecent.length - 1].t, chainlinkRecent[chainlinkRecent.length - 1].t);
  const diffs: number[] = [];

  if (overlapEnd - overlapStart >= BINANCE_ALIGN_BUCKET_MS * 2) {
    let binanceIdx = 0;
    let chainlinkIdx = 0;
    for (let bucketStart = overlapStart; bucketStart <= overlapEnd; bucketStart += BINANCE_ALIGN_BUCKET_MS) {
      const bucketEnd = bucketStart + BINANCE_ALIGN_BUCKET_MS;
      const binanceBucket: number[] = [];
      const chainlinkBucket: number[] = [];

      while (binanceIdx < binanceRecent.length && binanceRecent[binanceIdx].t < bucketStart) binanceIdx++;
      while (chainlinkIdx < chainlinkRecent.length && chainlinkRecent[chainlinkIdx].t < bucketStart) chainlinkIdx++;

      let i = binanceIdx;
      while (i < binanceRecent.length && binanceRecent[i].t < bucketEnd) {
        binanceBucket.push(binanceRecent[i].price);
        i++;
      }
      let j = chainlinkIdx;
      while (j < chainlinkRecent.length && chainlinkRecent[j].t < bucketEnd) {
        chainlinkBucket.push(chainlinkRecent[j].price);
        j++;
      }

      const binanceMedian = calcMedian(binanceBucket);
      const chainlinkMedian = calcMedian(chainlinkBucket);
      if (binanceMedian != null && chainlinkMedian != null) {
        diffs.push(chainlinkMedian - binanceMedian);
      }
    }
  }

  if (!diffs.length) {
    return chainlinkRecent[chainlinkRecent.length - 1].price - binanceRecent[binanceRecent.length - 1].price;
  }
  if (diffs.length < 5) {
    return calcTrimmedMean(diffs, 0);
  }

  const median = calcMedian(diffs);
  if (median == null) return null;
  const absDeviations = diffs.map((diff) => Math.abs(diff - median));
  const mad = calcMedian(absDeviations) ?? 0;
  const threshold = Math.max(10, mad * 3);
  const filtered = diffs.filter((diff) => Math.abs(diff - median) <= threshold);
  const stable = filtered.length >= 3 ? filtered : diffs;
  return calcTrimmedMean(stable, 0.15);
}

function refreshBinanceOffset(reason: string, options: { allowLatestFallback?: boolean; forceLog?: boolean } = {}): boolean {
  const nextOffset = calculateBinanceOffset(options.allowLatestFallback ?? false);
  if (nextOffset == null) return false;

  const prevOffset = state.binanceOffset;
  const changed = prevOffset == null || Math.abs(prevOffset - nextOffset) > BINANCE_OFFSET_EPSILON;
  state.binanceOffset = nextOffset;

  if (!changed) return true;

  if (options.forceLog || prevOffset == null) {
    const prefix = prevOffset == null ? "initialized" : `${reason} updated`;
    console.log(`[BinanceOffset] ${prefix} ${nextOffset >= 0 ? "+" : ""}${nextOffset.toFixed(2)}`);
  }

  broadcastState();
  return true;
}

function maybeInitializeBinanceOffset(): void {
  if (state.binanceOffset != null) return;
  void refreshBinanceOffset("startup", { allowLatestFallback: true, forceLog: true });
}

function resetStrategyRuntime(reason?: string): void {
  strategyRuntime.state = "IDLE";
  strategyRuntime.activeStrategy = null;
  strategyRuntime.direction = null;
  strategyRuntime.buyAmount = 0;
  strategyRuntime.posBeforeBuy = 0;
  strategyRuntime.posBeforeSell = 0;
  strategyRuntime.waitVerifyAfterSell = false;
  strategyRuntime.cleanupAfterVerify = false;
  strategyRuntime.actionTs = 0;
  strategyRuntime.prevUpPct = null;
  strategyRuntime.buyLockUntil = 0;
  strategyRuntime.roundEntryCount = 0;
  for (const s of getAllStrategies()) s.resetState();
  if (reason) console.log(`[Strategy] reset: ${reason}`);
}

function strategyKeyOf(strategy: StrategyNumber): StrategyKey {
  return `s${strategy}` as StrategyKey;
}

function transitionToDone(): void {
  if (strategyRuntime.roundEntryCount < strategyConfig.maxRoundEntries && anyStrategyEnabled()) {
    console.log(`[Strategy${strategyRuntime.activeStrategy ?? ""}] cycle complete, back to scanning (${strategyRuntime.roundEntryCount}/${strategyConfig.maxRoundEntries})`);
    strategyRuntime.state = "SCANNING";
    strategyRuntime.activeStrategy = null;
    strategyRuntime.direction = null;
    strategyRuntime.buyAmount = 0;
    strategyRuntime.posBeforeBuy = 0;
    strategyRuntime.posBeforeSell = 0;
    strategyRuntime.waitVerifyAfterSell = false;
    strategyRuntime.cleanupAfterVerify = false;
    strategyRuntime.actionTs = 0;
  } else {
    strategyRuntime.state = "DONE";
  }
  broadcastState();
}

function anyStrategyEnabled(): boolean {
  return ALL_STRATEGY_KEYS.some((key) => strategyConfig.enabled[key]);
}

function hasConfirmedBuyPosition(): boolean {
  return strategyRuntime.direction != null
    && getDirectionLocalSize(strategyRuntime.direction) > strategyRuntime.posBeforeBuy + 0.01;
}

function canReleaseUnconfirmedBuy(now = Date.now()): boolean {
  if (now - strategyRuntime.actionTs < FILL_RECONCILE_TIMEOUT_MS) return false;
  if (!strategyRuntime.direction) return true;
  if ((positions.lastApiSyncAt ?? 0) <= strategyRuntime.actionTs) return false;
  return getDirectionApiSize(strategyRuntime.direction) <= strategyRuntime.posBeforeBuy + 0.01;
}


function buildStrategyRuntimePayload(): Record<string, unknown> {
  const perStrategy: Record<string, Record<string, unknown>> = {};
  for (const s of getAllStrategies()) {
    perStrategy[s.key] = s.getStatePayload();
  }
  return {
    state: strategyRuntime.state,
    activeStrategy: strategyRuntime.activeStrategy,
    direction: strategyRuntime.direction,
    buyAmount: strategyRuntime.buyAmount,
    posBeforeBuy: strategyRuntime.posBeforeBuy,
    posBeforeSell: strategyRuntime.posBeforeSell,
    waitVerifyAfterSell: strategyRuntime.waitVerifyAfterSell,
    cleanupAfterVerify: strategyRuntime.cleanupAfterVerify,
    actionTs: strategyRuntime.actionTs,
    prevUpPct: strategyRuntime.prevUpPct,
    buyLockUntil: strategyRuntime.buyLockUntil,
    positionsReady: strategyRuntime.positionsReady,
    roundEntryCount: strategyRuntime.roundEntryCount,
    perStrategy,
  };
}

function buildStatePayload(options: boolean | StatePayloadOptions = false): Record<string, unknown> {
  const normalized = typeof options === "boolean" ? { includeHistory: options } : options;
  const includeHistory = normalized.includeHistory === true;
  const simple = normalized.simple === true;
  const { bids, asks } = getOrderBookSnapshot();

  const payload: Record<string, unknown> = {
    windowStart:  state.windowStart,
    windowEnd:    state.windowEnd,
    bestBid:      state.bestBid,
    bestAsk:      state.bestAsk,
    probabilityReady: isProbabilityReady(),
    lastPrice:    state.lastPrice,
    lastSide:     state.lastSide,
    updatedAt:    state.updatedAt,
    priceToBeat:  state.priceToBeat,
    currentPrice: state.currentPrice,
    binanceOffset: state.binanceOffset,
    binanceDiff: getStrategyDiff(),
    usdc:           positions.usdc,
    usdcAllowanceStatus: positions.usdcAllowanceStatus,
    usdcAllowanceMin: positions.usdcAllowanceMin,
    upLocalSize:    positions.localSize[state.upTokenId]   ?? 0,
    downLocalSize:  positions.localSize[state.downTokenId] ?? 0,
    upApiSize:      positions.apiSize[state.upTokenId]     ?? 0,
    downApiSize:    positions.apiSize[state.downTokenId]   ?? 0,
    upApiVerified:  positions.apiVerified[state.upTokenId]   ?? false,
    downApiVerified:positions.apiVerified[state.downTokenId] ?? false,
    lastTradeAt:    positions.lastTradeAt,
    lastApiSyncAt:  positions.lastApiSyncAt,
    runtimeMode:    APP_MODE,
    strategyConfig,
    strategy:       buildStrategyRuntimePayload(),
    ts: Date.now(),
  };
  if (!simple) {
    payload.conditionId = state.conditionId;
    payload.upTokenId = state.upTokenId;
    payload.downTokenId = state.downTokenId;
    payload.bids = bids;
    payload.asks = asks;
    payload.usdcAllowanceDetails = positions.usdcAllowanceDetails;
    payload.otherPositions = positions.otherPositions;
  }
  if (includeHistory && !simple) {
    payload.priceHistory = state.priceHistory;
    payload.binanceHistory = state.binanceHistory;
  }
  return payload;
}

function sendStateToClient(ws: WebSocket, options: { includeHistory?: boolean } = {}): void {
  const session = getClientSession(ws);
  const simple = session.dataMode === "low";
  send(ws, "state", buildStatePayload({
    includeHistory: options.includeHistory === true && !simple,
    simple,
  }));
  session.lastStateSentAt = Date.now();
}

function scheduleStateToClient(ws: WebSocket, includeHistory = false): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  const session = getClientSession(ws);
  session.stateDirty = true;
  session.stateIncludeHistory = session.stateIncludeHistory || includeHistory;
  if (session.stateTimer) return;
  const elapsed = Date.now() - session.lastStateSentAt;
  const waitMs = Math.max(0, getStateIntervalMs(session) - elapsed);
  session.stateTimer = setTimeout(() => {
    const latestSession = clientSessions.get(ws);
    if (!latestSession) return;
    latestSession.stateTimer = null;
    if (!latestSession.stateDirty || ws.readyState !== WebSocket.OPEN) return;
    const nextIncludeHistory = latestSession.stateIncludeHistory;
    latestSession.stateDirty = false;
    latestSession.stateIncludeHistory = false;
    if (ws.bufferedAmount > MAX_WS_BUFFERED_BYTES) {
      latestSession.stateDirty = true;
      latestSession.stateIncludeHistory = nextIncludeHistory;
      scheduleStateToClient(ws, nextIncludeHistory);
      return;
    }
    sendStateToClient(ws, { includeHistory: nextIncludeHistory });
  }, waitMs);
}

function broadcastState(includeHistory = false): void {
  if (!wss) return;
  for (const client of wss.clients) {
    if (client.readyState !== WebSocket.OPEN) continue;
    scheduleStateToClient(client, includeHistory);
  }
}

function applyClientConfig(ws: WebSocket, raw: unknown): void {
  if (!isRecord(raw) || raw.type !== "clientConfig") return;
  const session = getClientSession(ws);
  const nextMode = normalizeClientDataMode(raw.dataMode);
  if (session.dataMode === nextMode) return;
  session.dataMode = nextMode;
  session.stateDirty = false;
  session.stateIncludeHistory = false;
  clearStateTimer(session);
  console.log(`[WS] 瀹㈡埛绔暟鎹ā寮忓垏鎹负 ${nextMode}`);
  send(ws, "clientConfig", { dataMode: nextMode });
  sendStateToClient(ws, { includeHistory: true });
}

async function fetchBookTopOfBook(tokenId: string): Promise<{ bestBid: number; bestAsk: number }> {
  const book = await externalGetJson<{
    bids?: Array<{ price: string | number; size?: string | number }>;
    asks?: Array<{ price: string | number; size?: string | number }>;
  }>(`${CLOB_URL}/book?token_id=${tokenId}`);
  const bids = normalizeOrderBookLevels(book.bids).map((level) => Number(level.price));
  const asks = normalizeOrderBookLevels(book.asks).map((level) => Number(level.price));
  return {
    bestBid: bids.length ? Math.max(...bids) : 0,
    bestAsk: asks.length ? Math.min(...asks) : 0,
  };
}

// -----------------------------------------------------------------------------
let lastMarketLookupError: string | null = null;
async function fetchMarket(windowStart: number): Promise<{
  conditionId: string; upTokenId: string; downTokenId: string;
  windowStart: number; windowEnd: number;
  eventStartTime: string; endDate: string;
} | null> {
  const slug = `btc-updown-5m-${windowStart}`;
  const startedAt = Date.now();
  lastMarketLookupError = null;
  try {
    const events = await externalGetJson<Record<string, unknown>[]>(`${GAMMA_URL}/events?slug=${slug}`);
    if (!events?.length) {
      console.warn(`[Window] market not found slug=${slug} 鑰楁�?${Date.now() - startedAt}ms`);
      console.warn(`[Window] market not found slug=${slug} 鑰楁�?${Date.now() - startedAt}ms`);
      return null;
    }
    const event = events[0];
    const market = ((event.markets || []) as Record<string, unknown>[])[0];
    if (!market) {
      console.warn(`[Window] market missing book slug=${slug} 鑰楁�?${Date.now() - startedAt}ms`);
      return null;
    }
    const tokens   = JSON.parse(market.clobTokenIds as string || "[]") as string[];
    const outcomes = JSON.parse(market.outcomes     as string || "[]") as string[];
    const upIdx    = outcomes.findIndex((o) => o.toLowerCase() === "up");
    return {
      conditionId:    market.conditionId as string,
      upTokenId:      tokens[upIdx >= 0 ? upIdx : 0],
      downTokenId:    tokens[upIdx >= 0 ? 1 - upIdx : 1],
      windowStart,
      windowEnd:      windowStart + 300,
      eventStartTime: market.eventStartTime as string || new Date(windowStart * 1000).toISOString(),
      endDate:        market.endDate        as string || new Date((windowStart + 300) * 1000).toISOString(),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const hint = msg.includes("secure TLS connection was established") || msg.includes("socket hang up")
      ? " (hint: network/VPN/proxy; set HTTPS_PROXY/HTTP_PROXY)"
      : "";
    lastMarketLookupError = `${msg}${hint}`;
    console.error(`[Window] market lookup failed slug=${slug} elapsed=${Date.now() - startedAt}ms reason=${lastMarketLookupError}`);
    return null;
  }
}

// -----------------------------------------------------------------------------
async function fetchCryptoPrice(eventStartTime: string, endDate: string): Promise<void> {
  try {
    const url = `https://polymarket.com/api/crypto/crypto-price?symbol=BTC&eventStartTime=${encodeURIComponent(eventStartTime)}&variant=fiveminute&endDate=${encodeURIComponent(endDate)}`;
    const data = await externalGetJson<{ openPrice?: number }>(url);
    if (data.openPrice != null) state.priceToBeat = data.openPrice;
  } catch { /* ignore */ }
}

// -----------------------------------------------------------------------------
async function syncPositionsFromApi(): Promise<boolean> {
  if (!PROXY_ADDRESS) {
    strategyRuntime.positionsReady = true;
    positions.otherPositions = [];
    return true;
  }
  try {
    const pos = await externalGetJson<Array<Record<string, unknown>>>(
      `https://data-api.polymarket.com/positions?user=${PROXY_ADDRESS}&sizeThreshold=0.01&limit=100&offset=0`
    );
    positions.otherPositions = buildPortfolioPositions(pos);
    const apiMap: Record<string, number> = {};
    for (const raw of pos) {
      const asset = typeof raw.asset === "string" ? raw.asset : "";
      const size = parseNumberLike(raw.size, 0);
      if (!asset || size == null) continue;
      apiMap[asset] = size;
      positions.apiSize[asset] = size;
    }
    for (const tokenId of [state.upTokenId, state.downTokenId]) {
      if (!tokenId) continue;
      if (!(tokenId in apiMap)) positions.apiSize[tokenId] = 0;
      const apiVal   = apiMap[tokenId] ?? 0;
      const localVal = positions.localSize[tokenId] ?? 0;
      const msSinceTrade = Date.now() - (positions.lastTradeAt ?? 0);
      if (msSinceTrade < POST_TRADE_CALIBRATION_MS) continue;
      if (Math.abs(apiVal - localVal) <= 0.5) {
        positions.localSize[tokenId]   = apiVal;
        positions.apiVerified[tokenId] = true;
      }
    }
    positions.lastApiSyncAt = Date.now();
    strategyRuntime.positionsReady = true;
    return true;
  } catch {
    return false;
  }
}

// -----------------------------------------------------------------------------
async function syncUsdcBalance(): Promise<void> {
  if (!PROXY_ADDRESS) return;
  try {
    const provider = new JsonRpcProvider(POLYGON_RPC_URL, 137, { staticNetwork: true });
    const usdc = new Contract(
      USDC_ADDR,
      ["function balanceOf(address owner) view returns (uint256)"],
      provider
    );
    const rawBalance = await usdc.balanceOf(PROXY_ADDRESS);
    const amount = parseFloat(formatUnits(rawBalance, 6));
    positions.usdc = Number.isFinite(amount) ? amount : null;
    positions.usdcAllowanceDetails = [];
    positions.usdcAllowanceMin = null;
    positions.usdcAllowanceStatus = "unknown";
  } catch (e) {
    positions.usdc = null;
    positions.usdcAllowanceDetails = [];
    positions.usdcAllowanceMin = null;
    positions.usdcAllowanceStatus = "unknown";
    console.error("[USDC] balance sync failed:", e instanceof Error ? (e as any).shortMessage ?? e.message : String(e));
  }
}

// -----------------------------------------------------------------------------
function backoffDelay(attempt: number): number {
  const delays = [0, 1000, 2000, 4000, 8000, 30000];
  return delays[Math.min(attempt, delays.length - 1)];
}

// -----------------------------------------------------------------------------
let userWs: WebSocket | null = null;
let userWsPingTimer: ReturnType<typeof setInterval> | null = null;
let userWsAttempt = 0;
let userWsTargetConditionId = "";
let userWsSubscribedConditionId = "";

function sendInitialUserWsSubscription(ws: WebSocket, conditionId: string, creds: PolymarketCreds): void {
  if (ws.readyState !== WebSocket.OPEN || !conditionId) return;
  ws.send(JSON.stringify({
    type: "user",
    markets: [conditionId],
    auth: {
      apiKey: creds.key,
      secret: creds.secret,
      passphrase: creds.passphrase,
    },
  }));
  userWsSubscribedConditionId = conditionId;
  console.log(`[UserWS] subscribed market ...${conditionId.slice(-6)}`);
}

function syncUserWsSubscription(): void {
  if (!userWsTargetConditionId || !userWs || userWs.readyState !== WebSocket.OPEN) return;
  if (!userWsSubscribedConditionId) {
    if (inMemoryCreds) sendInitialUserWsSubscription(userWs, userWsTargetConditionId, inMemoryCreds);
    return;
  }
  if (userWsSubscribedConditionId === userWsTargetConditionId) return;

  const previousConditionId = userWsSubscribedConditionId;
  userWs.send(JSON.stringify({
    markets: [previousConditionId],
    operation: "unsubscribe",
  }));
  userWs.send(JSON.stringify({
    markets: [userWsTargetConditionId],
    operation: "subscribe",
  }));
  userWsSubscribedConditionId = userWsTargetConditionId;
  console.log(`[UserWS] switched market ...${previousConditionId.slice(-6)} -> ...${userWsTargetConditionId.slice(-6)}`);
}

function startUserWs(): void {
  if (!inMemoryCreds) {
    console.log("[UserWS] API credentials not ready, skipping user stream");
    return;
  }
  if (!userWsTargetConditionId) {
    console.log("[UserWS] target market not ready, skipping user stream");
    return;
  }
  if (userWs && (userWs.readyState === WebSocket.OPEN || userWs.readyState === WebSocket.CONNECTING)) {
    return;
  }
  const creds = inMemoryCreds;

  const usedProxy = isOutboundProxyActive();
  const ws = new WebSocket(USER_WS_URL, getOutboundWsOptions());
  userWs = ws;

  ws.on("open", () => {
    if (ws !== userWs) return;
    console.log(userWsAttempt === 0 ? "[UserWS] connected" : "[UserWS] reconnected");
    userWsAttempt = 0;
    userWsSubscribedConditionId = "";
    wsStatus.user = true; broadcastWsStatus();
    sendInitialUserWsSubscription(ws, userWsTargetConditionId, creds);
    userWsPingTimer = setInterval(() => {
      if (ws === userWs && ws.readyState === WebSocket.OPEN) ws.send("PING");
    }, 10000);
  });

  ws.on("message", (data) => {
    if (ws !== userWs) return;
    const msg = data.toString();
    if (msg === "PONG" || msg === "pong") return;
    try {
      const parsed = JSON.parse(msg);
      const events = Array.isArray(parsed) ? parsed : [parsed];
      for (const evt of events) {
        if (!isRecord(evt)) continue;
        if (typeof evt.type === "string" && evt.type.toLowerCase().includes("subscribed")) {
          wsStatus.user = true; broadcastWsStatus();
          continue;
        }
        const payload = isRecord(evt.payload) ? evt.payload : evt;
        if ((payload.type === "TRADE" || payload.event_type === "trade") && payload.status === "MINED") {
          const tradeId = payload.id as string;
          if (!rememberBounded(positions.confirmedIds, positions.confirmedIdOrder, tradeId, MAX_CONFIRMED_TRADE_IDS)) continue;
          const assetId = normalizeMarketAssetId(payload);
          const size = typeof payload.size === "number" ? payload.size : parseFloat(String(payload.size ?? ""));
          const side = normalizeTradeSide(payload.side);
          const price = typeof payload.price === "number" ? payload.price : parseFloat(String(payload.price ?? ""));
          if (!assetId || !side || !Number.isFinite(size) || size <= 0) continue;
          const pendingMeta = consumePendingTradeMeta(payload);
          const direction = pendingMeta?.direction ?? getDirectionByAssetId(assetId);
          const orderId = typeof payload.taker_order_id === "string" && payload.taker_order_id
            ? payload.taker_order_id
            : pendingMeta?.orderId;
          const txHash = typeof payload.transaction_hash === "string" && payload.transaction_hash
            ? payload.transaction_hash
            : undefined;
          if (!(assetId in positions.localSize)) positions.localSize[assetId] = 0;
          positions.localSize[assetId] = side === "buy"
            ? positions.localSize[assetId] + size
            : Math.max(0, positions.localSize[assetId] - size);
          positions.apiVerified[assetId] = false;
          positions.lastTradeAt = parseTradeEventTimestamp(payload);
          if (direction && Number.isFinite(price) && price > 0) {
            recordTradeHistory({
              ts: positions.lastTradeAt,
              windowStart: pendingMeta?.windowStart ?? state.windowStart,
              side,
              direction,
              amount: size,
              price,
              worstPrice: pendingMeta?.worstPrice ?? null,
              status: "MINED",
              source: pendingMeta?.source ?? "manual",
              txHash,
              orderId,
              exitReason: pendingMeta?.exitReason,
              roundEntry: pendingMeta?.roundEntry,
            });
          }
          console.log(
            `[UserWS] MINED ${side.toUpperCase()} ${size} @ ${Number.isFinite(price) ? price : "-"}`
            + ` asset: ...${assetId.slice(-6)}`
            + `${orderId ? ` order:${orderId}` : ""}`
            + `${txHash ? ` tx:${txHash.slice(0, 10)}...` : ""}`
          );
          broadcastState();
        }
      }
    } catch { /* 蹇界�?*/ }
  });

  ws.on("close", (code, reasonBuffer) => {
    if (ws !== userWs) return;
    if (userWsPingTimer) {
      clearInterval(userWsPingTimer);
      userWsPingTimer = null;
    }
    userWs = null;
    userWsSubscribedConditionId = "";
    const delay = backoffDelay(userWsAttempt++);
    const reason = reasonBuffer.toString();
    console.log(`[UserWS] closed code=${code} reason=${reason || "-"} retry in ${delay}ms (attempt ${userWsAttempt})`);
    wsStatus.user = false; broadcastWsStatus();
    if (!stopped) setTimeout(startUserWs, delay);
  });
  ws.on("error", (err) => {
    if (ws !== userWs) return;
    if (usedProxy && maybeDisableProxyFromError("UserWS", err)) {
      try { ws.close(); } catch { /* ignore */ }
    }
    console.error("[UserWS] error:", err.message);
  });
}

// -----------------------------------------------------------------------------
let marketWs: WebSocket | null = null;
let marketPingTimer:   ReturnType<typeof setInterval> | null = null;
let marketRenderTimer: ReturnType<typeof setInterval> | null = null;
let marketValidationTimer: ReturnType<typeof setInterval> | null = null;
let lastBestBidAskTimestamp = 0;
let bestBidAskPausedUntil = 0;
let marketValidationMismatchStreak = 0;
let marketReconnectPending = false;
let marketBestReady = false;

function isProbabilityReady(now = Date.now()): boolean {
  if (!wsStatus.market) return false;
  if (!marketBestReady) return false;
  if (now < bestBidAskPausedUntil) return false;
  const bid = Number(state.bestBid);
  const ask = Number(state.bestAsk);
  return Number.isFinite(bid) && Number.isFinite(ask);
}

function parseEventTimestamp(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

function applyBestBidAskUpdate(
  bestBid: unknown,
  bestAsk: unknown,
  timestamp: unknown,
): boolean {
  const normalizedBestBid = normalizeDecimalString(bestBid);
  const normalizedBestAsk = normalizeDecimalString(bestAsk);
  if (!normalizedBestBid || !normalizedBestAsk) return false;
  if (!(Number(normalizedBestBid) > 0) || !(Number(normalizedBestAsk) > 0)) return false;
  if (Date.now() < bestBidAskPausedUntil) return false;
  const ts = parseEventTimestamp(timestamp);
  if (ts > 0 && ts < lastBestBidAskTimestamp) return false;
  if (ts > 0) lastBestBidAskTimestamp = ts;
  state.bestBid = normalizedBestBid;
  state.bestAsk = normalizedBestAsk;
  marketBestReady = true;
  return true;
}

function clearProbabilityForMs(ms: number, reason: string): void {
  const until = Date.now() + ms;
  if (until > bestBidAskPausedUntil) bestBidAskPausedUntil = until;
  marketBestReady = false;
  lastBestBidAskTimestamp = 0;
  state.bestBid = "-";
  state.bestAsk = "-";
  state.updatedAt = Date.now();
  invalidateOrderBookSnapshot();
  console.warn(`[Probability] ${reason}, clearing probability for ${ms}ms`);
  broadcastState();
}

function requestMarketReconnect(reason: string, options?: { clearProbabilityMs?: number }): void {
  clearProbabilityForMs(options?.clearProbabilityMs ?? 0, reason);
  marketValidationMismatchStreak = 0;
  if (marketReconnectPending) return;
  marketReconnectPending = true;
  console.warn(`[MarketWS] reconnect triggered: ${reason}`);
  if (marketWs) {
    marketWs.close();
    return;
  }
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    void subscribeWindow(Math.max(subscribedWindow, getCurrentWindowStart()));
  }, 1000);
}

async function validateMarketProbability(expectedWindowStart: number, upTokenId: string): Promise<void> {
  if (marketReconnectPending) return;
  if (subscribedWindow !== expectedWindowStart) return;
  if (!marketWs || marketWs.readyState !== WebSocket.OPEN) return;

  try {
    const { bestBid, bestAsk } = await fetchBookTopOfBook(upTokenId);
    if (subscribedWindow !== expectedWindowStart || upTokenId !== state.upTokenId) return;
    if (!(bestBid > 0) || !(bestAsk > 0)) return;

    const wsBid = Number(state.bestBid);
    const wsAsk = Number(state.bestAsk);
    if (!Number.isFinite(wsBid) || !Number.isFinite(wsAsk)) return;

    const restMid = (bestBid + bestAsk) / 2;
    const wsMid = (wsBid + wsAsk) / 2;
    const diffPct = Math.abs(restMid - wsMid) * 100;

    if (diffPct > 15) {
      marketValidationMismatchStreak++;
      console.warn(`[Probability] REST mismatch ${diffPct.toFixed(2)}%, streak ${marketValidationMismatchStreak}/3`);
      if (marketValidationMismatchStreak >= 3) {
        requestMarketReconnect("probability mismatch repeated 3 times");
      }
      return;
    }

    marketValidationMismatchStreak = 0;
  } catch (err) {
    if (subscribedWindow !== expectedWindowStart || upTokenId !== state.upTokenId) return;
    console.warn(`[Probability] REST validation skipped: ${err instanceof Error ? err.message : String(err)}`);
  }
}

let _marketWsConnectedOnce = false;
function startMarketWs(expectedWindowStart: number, upTokenId: string, downTokenId: string, onClose: () => void): WebSocket {
  const usedProxy = isOutboundProxyActive();
  const ws = new WebSocket(MARKET_WS_URL, getOutboundWsOptions());
  ws.on("open", () => {
    if (ws !== marketWs || subscribedWindow !== expectedWindowStart) return;
    console.log(_marketWsConnectedOnce ? "[MarketWS] reconnected" : "[MarketWS] connected");
    _marketWsConnectedOnce = true;
    marketReconnectPending = false;
    marketValidationMismatchStreak = 0;
    marketBestReady = false;
    wsStatus.market = true; broadcastWsStatus();
    ws.send(JSON.stringify({
      assets_ids: [upTokenId, downTokenId],
      type: "market",
      custom_feature_enabled: true,
    }));
    void (async () => {
      try {
        const book = await externalGetJson<{ bids?: unknown; asks?: unknown }>(`${CLOB_URL}/book?token_id=${upTokenId}`);
        if (ws !== marketWs || subscribedWindow !== expectedWindowStart || state.upTokenId !== upTokenId) return;
        const bids = normalizeOrderBookLevels(book.bids);
        const asks = normalizeOrderBookLevels(book.asks);
        if (!bids.length || !asks.length) return;
        state.bids.clear();
        state.asks.clear();
        for (const level of bids) state.bids.set(level.price, level.size);
        for (const level of asks) state.asks.set(level.price, level.size);
        invalidateOrderBookSnapshot();
        applyBestBidAskFromOrderBook(Date.now());
        state.updatedAt = Date.now();
        broadcastState();
      } catch {}
    })();
    marketRenderTimer = setInterval(broadcastState, 1000);
    marketValidationTimer = setInterval(() => {
      void validateMarketProbability(expectedWindowStart, upTokenId);
    }, 5000);
    marketPingTimer   = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send("PING");
    }, 10000);
  });
  ws.on("message", (data) => {
    if (ws !== marketWs || subscribedWindow !== expectedWindowStart || state.upTokenId !== upTokenId) return;
    const msg = data.toString();
    if (msg === "PONG" || msg === "[]") return;
    try {
      const parsed = JSON.parse(msg);
      const events = Array.isArray(parsed) ? parsed : [parsed];
      for (const rawEvent of events) {
        if (!isRecord(rawEvent)) continue;
        const payload = isRecord(rawEvent.payload) ? rawEvent.payload : null;
        const evt = payload ?? rawEvent;
        const eventType = typeof evt.event_type === "string"
          ? evt.event_type.toLowerCase()
          : typeof rawEvent.event_type === "string"
            ? rawEvent.event_type.toLowerCase()
          : typeof evt.type === "string"
            ? evt.type.toLowerCase()
            : typeof rawEvent.type === "string"
              ? rawEvent.type.toLowerCase()
              : "";
        const evtAssetId = normalizeMarketAssetId(evt);
        const rawAssetId = normalizeMarketAssetId(rawEvent);
        const assetId = evtAssetId || rawAssetId;

        if ((evt.bids !== undefined && evt.asks !== undefined) || eventType === "book") {
          if (!assetId || assetId !== upTokenId) continue;
          state.bids.clear();
          state.asks.clear();
          for (const bidLevel of normalizeOrderBookLevels(evt.bids)) {
            state.bids.set(bidLevel.price, bidLevel.size);
          }
          for (const askLevel of normalizeOrderBookLevels(evt.asks)) {
            state.asks.set(askLevel.price, askLevel.size);
          }
          invalidateOrderBookSnapshot();
          applyBestBidAskUpdate(evt.best_bid, evt.best_ask, evt.timestamp) || applyBestBidAskFromOrderBook(evt.timestamp);
          state.updatedAt = Date.now();
          broadcastState();
          continue;
        }

        if (eventType === "best_bid_ask" || (evt.best_bid !== undefined && evt.best_ask !== undefined && !Array.isArray(evt.price_changes))) {
          if (!assetId || assetId !== upTokenId) continue;
          if (!applyBestBidAskUpdate(evt.best_bid, evt.best_ask, evt.timestamp)) continue;
          state.updatedAt = Date.now();
          broadcastState();
          continue;
        }

        if (eventType === "price_change" && Array.isArray(evt.price_changes)) {
          let bookChanged = false;
          let bestChanged = false;
          for (const rawChange of evt.price_changes) {
            if (!isRecord(rawChange)) continue;
            const changeAssetId = normalizeMarketAssetId(rawChange) || assetId;
            if (!changeAssetId || changeAssetId !== upTokenId) continue;

            const price = normalizeDecimalString(rawChange.price);
            const size = normalizeDecimalString(rawChange.size);
            const side = normalizeTradeSide(rawChange.side);
            if (price && size && side) {
              const sizeValue = Number(size);
              const map = side === "buy" ? state.bids : state.asks;
              if (sizeValue > 0) map.set(price, size);
              else map.delete(price);
              bookChanged = true;
            }

            if (applyBestBidAskUpdate(rawChange.best_bid, rawChange.best_ask, rawChange.timestamp ?? evt.timestamp)) {
              bestChanged = true;
            }
          }
          if (bookChanged) invalidateOrderBookSnapshot();
          if (!bestChanged && bookChanged) {
            bestChanged = applyBestBidAskFromOrderBook(evt.timestamp);
          }
          if (!bookChanged && !bestChanged) continue;
          state.updatedAt = Date.now();
          broadcastState();
          continue;
        }

        if (eventType === "last_trade_price") {
          if (!assetId || assetId !== upTokenId) continue;
          const price = normalizeDecimalString(evt.price);
          if (!price) continue;
          const side = normalizeTradeSide(evt.side);
          state.lastPrice = Number(price).toFixed(2);
          if (side) state.lastSide = side.toUpperCase();
          state.updatedAt = Date.now();
          broadcastState();
        }
      }
    } catch { /* 蹇界�?*/ }
  });
  ws.on("close", () => {
    if (ws !== marketWs || subscribedWindow !== expectedWindowStart) return;
    if (marketPingTimer)   clearInterval(marketPingTimer);
    if (marketRenderTimer) clearInterval(marketRenderTimer);
    if (marketValidationTimer) {
      clearInterval(marketValidationTimer);
      marketValidationTimer = null;
    }
    marketBestReady = false;
    state.bestBid = "-";
    state.bestAsk = "-";
    state.updatedAt = Date.now();
    invalidateOrderBookSnapshot();
    console.log("[MarketWS] closed, retrying in 1s");
    wsStatus.market = false; broadcastWsStatus();
    broadcastState();
    broadcast("marketDown", {});
    onClose();
  });
  ws.on("error", (err) => {
    if (usedProxy && maybeDisableProxyFromError("MarketWS", err)) {
      try { ws.close(); } catch { /* ignore */ }
    }
    console.error("[MarketWS] error:", err.message);
  });
  return ws;
}

// -----------------------------------------------------------------------------
let chainlinkWs: WebSocket | null = null;

function startChainlinkWs(expectedWindowStart: number, eventSlug: string, onClose: () => void, attempt = 0): WebSocket {
  const usedProxy = isOutboundProxyActive();
  const ws = new WebSocket(CHAINLINK_WS_URL, getOutboundWsOptions());
  ws.on("open", () => {
    if (ws !== chainlinkWs || subscribedWindow !== expectedWindowStart) return;
    console.log(attempt === 0 ? "[ChainlinkWS] connected" : "[ChainlinkWS] reconnected");
    wsStatus.chainlink = true; broadcastWsStatus();
    ws.send(JSON.stringify({
      action: "subscribe",
      subscriptions: [
        { topic: "crypto_prices_chainlink", type: "update", filters: JSON.stringify({ symbol: "btc/usd" }) },
        { topic: "activity", type: "orders_matched", filters: JSON.stringify({ event_slug: eventSlug }) },
      ],
    }));
  });
  ws.on("message", (data) => {
    if (ws !== chainlinkWs || subscribedWindow !== expectedWindowStart) return;
    try {
      const msg = JSON.parse(data.toString()) as { topic?: string; type?: string; timestamp?: number; payload?: { value?: number; timestamp?: number } };
      if (msg.topic === "crypto_prices_chainlink" && msg.type === "update") {
        const rawVal = msg.payload?.value;
        const val = typeof rawVal === "number" ? rawVal : Number(rawVal);
        if (Number.isFinite(val) && val > 0) {
          state.currentPrice = val;
          if (state.priceToBeat == null && autoPriceToBeatWindowStart !== state.windowStart) {
            state.priceToBeat = val;
            autoPriceToBeatWindowStart = state.windowStart;
          }
          const now = msg.payload?.timestamp ?? msg.timestamp ?? Date.now();
          state.priceHistory.push({ t: now, price: val });
          trimHistory(state.priceHistory, now - HISTORY_RETENTION_MS, MAX_CHAINLINK_HISTORY_POINTS);
          maybeInitializeBinanceOffset();
          broadcast("chainlinkPrice", { t: now, price: val });
          broadcastState();
        }
      }
    } catch { /* 蹇界�?*/ }
  });
  ws.on("close", () => {
    if (ws !== chainlinkWs || subscribedWindow !== expectedWindowStart) return;
    const delay = backoffDelay(attempt);
    console.log(`[ChainlinkWS] closed, retry in ${delay}ms (attempt ${attempt + 1})`);
    wsStatus.chainlink = false; broadcastWsStatus();
    broadcast("chainlinkDown", {});
    onClose();
  });
  ws.on("error", (err) => {
    if (usedProxy && maybeDisableProxyFromError("ChainlinkWS", err)) {
      try { ws.close(); } catch { /* ignore */ }
    }
    console.error("[ChainlinkWS] error:", err.message);
  });
  return ws;
}

// -----------------------------------------------------------------------------
let binanceWs: WebSocket | null = null;
let binanceWsAttempt = 0;

function startBinanceWs(): void {
  const usedProxy = isOutboundProxyActive();
  binanceWs = new WebSocket(BINANCE_WS_URL, getOutboundWsOptions());
  binanceWs.on("open", () => { console.log(binanceWsAttempt === 0 ? "[BinanceWS] connected" : "[BinanceWS] reconnected"); binanceWsAttempt = 0; wsStatus.binance = true; broadcastWsStatus(); });
  binanceWs.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString()) as { p?: string; T?: number };
      const price = parseFloat(msg.p ?? "");
      const t = msg.T ?? Date.now();
      if (!price) return;
      state.binanceHistory.push({ t, price });
      trimHistory(state.binanceHistory, t - HISTORY_RETENTION_MS, MAX_BINANCE_HISTORY_POINTS);
      let updated = false;
      if (state.currentPrice == null) {
        state.currentPrice = price;
        updated = true;
      }
      if (state.priceToBeat == null && state.windowStart > 0 && autoPriceToBeatWindowStart !== state.windowStart) {
        state.priceToBeat = price;
        autoPriceToBeatWindowStart = state.windowStart;
        updated = true;
      }
      maybeInitializeBinanceOffset();
      broadcast("binancePrice", { t, price });
      if (updated) broadcastState();
    } catch { /* 蹇界�?*/ }
  });
  binanceWs.on("close", () => {
    const delay = backoffDelay(binanceWsAttempt++);
    console.log(`[BinanceWS] closed, retry in ${delay}ms (attempt ${binanceWsAttempt})`);
    wsStatus.binance = false; broadcastWsStatus();
    if (!stopped) setTimeout(startBinanceWs, delay);
  });
  binanceWs.on("error", (err) => {
    if (usedProxy && maybeDisableProxyFromError("BinanceWS", err)) {
      try { binanceWs?.close(); } catch { /* ignore */ }
    }
    console.error("[BinanceWS] error:", err.message);
  });
}

// -----------------------------------------------------------------------------
function parseResolvedOutcome(event: Record<string, unknown> | undefined): "up" | "down" | null {
  const market = ((event?.markets as Record<string, unknown>[] | undefined) || [])[0];
  if (!market) return null;

  let outcomes: string[] = [];
  let outcomePrices: string[] = [];

  try { outcomes = JSON.parse(String(market.outcomes || "[]")) as string[]; } catch { /* 蹇界�?*/ }
  try { outcomePrices = JSON.parse(String(market.outcomePrices || "[]")) as string[]; } catch { /* 蹇界�?*/ }

  if (!outcomes.length || outcomes.length !== outcomePrices.length) return null;

  const upIdx = outcomes.findIndex((o) => o.toLowerCase() === "up");
  const downIdx = outcomes.findIndex((o) => o.toLowerCase() === "down");
  if (upIdx < 0 || downIdx < 0) return null;

  const upPrice = Number(outcomePrices[upIdx]);
  const downPrice = Number(outcomePrices[downIdx]);
  if (!Number.isFinite(upPrice) || !Number.isFinite(downPrice)) return null;

  if (upPrice >= 0.999 && downPrice <= 0.001) return "up";
  if (downPrice >= 0.999 && upPrice <= 0.001) return "down";
  return null;
}

async function fetchRecentResults(currentWindow: number, immediate = false): Promise<void> {
  if (!immediate) await new Promise(r => setTimeout(r, 5000));
  if (stopped) return;
  try {
    const slugs = [1,2,3,4].map(i => `btc-updown-5m-${currentWindow - i * 300}`);
    const query = slugs.map(s => `slug=${s}`).join("&");
    const events = await externalGetJson<Record<string, unknown>[]>(`${GAMMA_URL}/events?${query}`);
    const results = slugs.map(slug => {
      const event = events.find((e: Record<string, unknown>) => e.slug === slug) as Record<string, unknown> | undefined;
      const ws = parseInt(slug.split("-").pop()!);
      const timeRange = `${new Date(ws * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}-${new Date((ws + 300) * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
      const result = parseResolvedOutcome(event);
      return { timeRange, result };
    });
    const summary = results
      .map((item) => `${item.timeRange} ${item.result === "up" ? "UP" : item.result === "down" ? "DOWN" : "pending"}`)
      .join(" | ");
    console.log(`[Result] ${summary}`);
    broadcast("recentResults", { results });
  } catch (e) { console.error(`[Result] request failed:`, (e as Error).message); }
}

// -----------------------------------------------------------------------------
let subscribedWindow = 0;
let stopped = false;
let switchTimer:    ReturnType<typeof setTimeout> | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

function disconnectWindowStreams(): void {
  const hadMarketFeed = !!marketWs || wsStatus.market;
  const hadChainlinkFeed = !!chainlinkWs || wsStatus.chainlink;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (marketPingTimer) {
    clearInterval(marketPingTimer);
    marketPingTimer = null;
  }
  if (marketRenderTimer) {
    clearInterval(marketRenderTimer);
    marketRenderTimer = null;
  }
  if (marketValidationTimer) {
    clearInterval(marketValidationTimer);
    marketValidationTimer = null;
  }
  if (marketWs) {
    marketWs.removeAllListeners("close");
    marketWs.close();
    marketWs = null;
  }
  if (chainlinkWs) {
    chainlinkWs.removeAllListeners("close");
    chainlinkWs.close();
    chainlinkWs = null;
  }
  if (wsStatus.market || wsStatus.chainlink) {
    wsStatus.market = false;
    wsStatus.chainlink = false;
    broadcastWsStatus();
  }
  if (hadMarketFeed) broadcast("marketDown", {});
  if (hadChainlinkFeed) broadcast("chainlinkDown", {});
}

function clearWindowRuntimeState(): void {
  state.bids.clear();
  state.asks.clear();
  invalidateOrderBookSnapshot();
  state.bestBid = "-";
  state.bestAsk = "-";
  state.lastPrice = "-";
  state.lastSide = "";
  state.priceToBeat = null;
  state.currentPrice = null;
  state.binanceOffset = null;
  state.updatedAt = Date.now();
  marketBestReady = false;
  marketValidationMismatchStreak = 0;
  bestBidAskPausedUntil = 0;
  strategyRuntime.positionsReady = !PROXY_ADDRESS;
  resetStrategyRuntime();
  broadcastState();
}

function getCurrentWindowStart(now = Date.now()): number {
  return Math.floor(now / 1000 / 300) * 300;
}

async function advanceToLiveWindow(targetWindowStart: number): Promise<void> {
  const switchStartedAt = Date.now();
  let attempt = 0;
  let clearedExpiredWindow = false;
  while (!stopped) {
    const desiredWindow = Math.max(targetWindowStart, getCurrentWindowStart());
    if (attempt === 0) {
      console.log(`[Window] switching ${subscribedWindow || "-"} -> ${desiredWindow}`);
    }
    if (!clearedExpiredWindow && desiredWindow > subscribedWindow) {
      disconnectWindowStreams();
      clearWindowRuntimeState();
      clearedExpiredWindow = true;
    }
    const subscribeStartedAt = Date.now();
    await subscribeWindow(desiredWindow);
    if (subscribedWindow === desiredWindow) {
      console.log(`[Window] switched windowStart=${desiredWindow} in ${Date.now() - switchStartedAt}ms`);
      return;
    }

    const delay = Math.min(1000 * Math.max(++attempt, 1), 5000);
    console.warn(`[Window] retry windowStart=${desiredWindow} in ${delay}ms`);
    await new Promise(r => setTimeout(r, delay));
  }
}

function scheduleNextWindow(windowEnd: number): void {
  if (switchTimer) clearTimeout(switchTimer);
  const msUntilEnd = windowEnd * 1000 - Date.now();
  switchTimer = setTimeout(async () => {
    if (stopped) return;
    await advanceToLiveWindow(windowEnd);
  }, Math.max(0, msUntilEnd));
}

async function subscribeWindow(windowStart: number): Promise<void> {
  const startedAt = Date.now();
  const info = await fetchMarket(windowStart);
  if (!info) {
    broadcast("error", { message: `Market lookup failed windowStart=${windowStart}${lastMarketLookupError ? `: ${lastMarketLookupError}` : ""}` });
    console.warn(`[Window] subscribe failed windowStart=${windowStart} elapsed=${Date.now() - startedAt}ms`);
    const prevWindowStart = subscribedWindow;
    const isNewWindow = subscribedWindow !== windowStart;
    subscribedWindow = windowStart;
    state.windowStart = windowStart;
    state.windowEnd = windowStart + 300;
    state.upTokenId = "";
    state.downTokenId = "";
    state.conditionId = "";
    state.bids.clear();
    state.asks.clear();
    invalidateOrderBookSnapshot();
    state.bestBid = "-";
    state.bestAsk = "-";
    state.lastPrice = "-";
    state.lastSide = "";
    state.binanceOffset = state.binanceOffset ?? null;
    state.updatedAt = Date.now();
    lastBestBidAskTimestamp = 0;
    marketBestReady = false;
    bestBidAskPausedUntil = 0;
    marketValidationMismatchStreak = 0;
    marketReconnectPending = false;
    userWsTargetConditionId = "";

    if (isNewWindow) {
      if (prevWindowStart > 0) fetchRecentResults(windowStart);
      state.priceToBeat = null;
      state.currentPrice = null;
      autoPriceToBeatWindowStart = 0;
      resetStrategyRuntime(`window switched to ${windowStart} (fallback)`);
      prunePositionCaches([]);
    }

    broadcast("window", {
      windowStart: state.windowStart,
      windowEnd: state.windowEnd,
      conditionId: "",
      upTokenId: "",
      downTokenId: "",
    });

    if (marketWs || chainlinkWs || reconnectTimer) {
      disconnectWindowStreams();
    }

    const eventSlug = `btc-updown-5m-${state.windowStart}`;
    let clAttempt = 0;
    const reconnectChainlink = () => {
      if (stopped) return;
      const delay = backoffDelay(clAttempt);
      clAttempt++;
      setTimeout(() => {
        if (stopped) return;
        chainlinkWs = startChainlinkWs(subscribedWindow, eventSlug, reconnectChainlink, clAttempt);
      }, delay);
    };
    chainlinkWs = startChainlinkWs(subscribedWindow, eventSlug, reconnectChainlink, 0);

    scheduleNextWindow(state.windowEnd);
    broadcastState();
    return;
  }

  const isNewWindow = subscribedWindow !== windowStart;
  const prevWindowStart = subscribedWindow;
  subscribedWindow = windowStart;

  state.windowStart = info.windowStart; state.windowEnd   = info.windowEnd;
  state.upTokenId   = info.upTokenId;   state.downTokenId = info.downTokenId;
  state.conditionId = info.conditionId;
  userWsTargetConditionId = info.conditionId;
  state.bids.clear(); state.asks.clear();
  invalidateOrderBookSnapshot();
  state.bestBid = "-"; state.bestAsk = "-";
  state.lastPrice = "-"; state.lastSide = "";
  state.binanceOffset = null;
  state.updatedAt = Date.now();
  lastBestBidAskTimestamp = 0;
  marketBestReady = false;
  bestBidAskPausedUntil = 0;
  marketValidationMismatchStreak = 0;
  marketReconnectPending = false;

  if (isNewWindow) {
    if (prevWindowStart > 0) fetchRecentResults(windowStart);
    state.priceToBeat = null; state.currentPrice = null;
    autoPriceToBeatWindowStart = 0;
    strategyRuntime.positionsReady = !PROXY_ADDRESS;
    resetStrategyRuntime(`window switched to ${windowStart}`);
    prunePositionCaches([info.upTokenId, info.downTokenId]);
    positions.localSize[info.upTokenId]     = 0;
    positions.localSize[info.downTokenId]   = 0;
    positions.apiSize[info.upTokenId]       = 0;
    positions.apiSize[info.downTokenId]     = 0;
    positions.apiVerified[info.upTokenId]   = false;
    positions.apiVerified[info.downTokenId] = false;
    const thisWindow = info.windowStart;
    const tryFetch = () => {
      if (stopped || subscribedWindow !== thisWindow) return;
      fetchCryptoPrice(info.eventStartTime, info.endDate).then(() => {
        if (state.priceToBeat == null && !stopped && subscribedWindow === thisWindow) setTimeout(tryFetch, 1000);
        else broadcastState();
      });
    };
    tryFetch();
    syncPositionsFromApi().then(() => broadcastState());
  }

  broadcast("window", {
    windowStart: info.windowStart, windowEnd: info.windowEnd,
    conditionId: info.conditionId, upTokenId: info.upTokenId, downTokenId: info.downTokenId,
  });

  syncUserWsSubscription();
  if (!userWs) {
    startUserWs();
  }

  if (marketWs || chainlinkWs || reconnectTimer) {
    disconnectWindowStreams();
  }

  marketWs = startMarketWs(info.windowStart, info.upTokenId, info.downTokenId, () => {
    if (stopped) return;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      void subscribeWindow(Math.max(subscribedWindow, getCurrentWindowStart()));
    }, 1000);
  });

  const eventSlug = `btc-updown-5m-${info.windowStart}`;
  let clAttempt = 0;
  const reconnectChainlink = () => {
    if (stopped) return;
    const delay = backoffDelay(clAttempt);
    clAttempt++;
    setTimeout(() => {
      if (stopped) return;
      chainlinkWs = startChainlinkWs(subscribedWindow, `btc-updown-5m-${subscribedWindow}`, reconnectChainlink, clAttempt);
    }, delay);
  };
  chainlinkWs = startChainlinkWs(info.windowStart, eventSlug, reconnectChainlink, 0);

  scheduleNextWindow(info.windowEnd);
}

// -----------------------------------------------------------------------------
interface ClaimPosition {
  conditionId: string; title: string; currentValue: number; size: number;
}
let claimablePositions: ClaimPosition[] = [];
let claimableTotal = 0;
let claimCycleTimer: ReturnType<typeof setTimeout> | null = null;
let claimCycleRunning = false;
let claimNextCheckAt = 0;

function broadcastClaimCooldown(running = false): void {
  broadcast("claimCooldown", { running, nextCheckAt: claimNextCheckAt });
}

function resetClaimableState(): void {
  claimablePositions = [];
  claimableTotal = 0;
  broadcast("claimable", { total: claimableTotal, positions: claimablePositions });
}

async function syncClaimable(options: { clearOnError?: boolean } = {}): Promise<boolean> {
  if (!PROXY_ADDRESS) {
    resetClaimableState();
    return false;
  }
  try {
    const pos = await externalGetJson<Array<{ conditionId: string; title: string; currentValue: number; size: number; curPrice: number }>>(
      `https://data-api.polymarket.com/positions?user=${PROXY_ADDRESS}&sizeThreshold=.01&redeemable=true&limit=100&offset=0`
    );
    claimablePositions = pos.filter(p => p.curPrice === 1).map(p => ({
      conditionId: p.conditionId, title: p.title, currentValue: p.currentValue, size: p.size,
    }));
    claimableTotal = claimablePositions.reduce((s, p) => s + p.currentValue, 0);
    broadcast("claimable", { total: claimableTotal, positions: claimablePositions });
    return true;
  } catch (err) {
    if (options.clearOnError) resetClaimableState();
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Claim] failed to query redeemable positions: ${msg}`);
    return false;
  }
}

function scheduleClaimCycle(delayMs = CLAIM_CYCLE_DELAY_MS): void {
  if (stopped || !PROXY_ADDRESS) {
    if (claimCycleTimer) clearTimeout(claimCycleTimer);
    claimCycleTimer = null;
    claimNextCheckAt = 0;
    broadcastClaimCooldown(false);
    return;
  }
  if (claimCycleTimer) clearTimeout(claimCycleTimer);
  claimNextCheckAt = Date.now() + Math.max(0, delayMs);
  broadcastClaimCooldown(false);
  claimCycleTimer = setTimeout(() => {
    void autoClaimCycle().catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[鑷姩Claim] 鍚庡彴棰嗗彇寮傚�? ${msg}`);
      scheduleClaimCycle();
    });
  }, Math.max(0, delayMs));
}

async function autoClaimCycle(): Promise<void> {
  if (stopped || claimCycleRunning) return;
  claimCycleRunning = true;
  claimNextCheckAt = 0;
  broadcastClaimCooldown(true);
  try {
    const synced = await syncClaimable({ clearOnError: true });
    if (!synced) return;
    if (!strategyConfig.autoClaimEnabled || !PRIVATE_KEY) return;
    if (!claimablePositions.length || claimInProgress) return;
    console.log(`[AutoClaim] found ${claimablePositions.length} redeemable positions`);
    await runClaim({ refreshAfter: false });
  } finally {
    claimCycleRunning = false;
    scheduleClaimCycle();
  }
}

// -----------------------------------------------------------------------------
let claimInProgress = false;

async function runClaim(options: { refreshAfter?: boolean } = {}): Promise<{ title: string; txHash?: string; error?: string }[]> {
  const { refreshAfter = true } = options;
  if (!PROXY_ADDRESS || !PRIVATE_KEY) return [];
  if (claimInProgress) return [];
  if (!claimablePositions.length) return [];
  claimInProgress = true;

  const CTF = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045";
  const ZERO_BYTES32 = "0x0000000000000000000000000000000000000000000000000000000000000000";

  const provider = new JsonRpcProvider("https://polygon-bor-rpc.publicnode.com", 137, { staticNetwork: true });
  provider.on("error", (e: Error) => console.error("[RPC]", e.message));
  const wallet = new Wallet(PRIVATE_KEY, provider);

  const ctfIface = new Interface([
    "function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)"
  ]);
  const safeIface = new Interface([
    "function nonce() view returns (uint256)",
    "function getTransactionHash(address to, uint256 value, bytes calldata data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 nonce) view returns (bytes32)",
    "function execTransaction(address to, uint256 value, bytes calldata data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address payable refundReceiver, bytes memory signatures) public payable returns (bool)",
  ]);
  const safe = new Contract(PROXY_ADDRESS, safeIface, wallet);

  const snapshot = [...claimablePositions];
  const total = snapshot.length;
  const results: { title: string; txHash?: string; error?: string }[] = [];
  console.log(`[Claim] starting ${total} claims: ${snapshot.map((p) => p.title).join(" | ")}`);
  try {
    for (let i = 0; i < snapshot.length; i++) {
      const p = snapshot[i];
      console.log(`[Claim] (${i + 1}/${total}) ${p.title} value:${p.currentValue.toFixed(2)} conditionId:${p.conditionId}`);
      broadcast("claimProgress", { current: i, total, title: p.title, status: "running" });
      try {
        const calldata = ctfIface.encodeFunctionData("redeemPositions", [
          USDC_ADDR, ZERO_BYTES32, p.conditionId, [1, 2]
        ]);
        const nonce = await safe.nonce();
        console.log(`[Claim] nonce:${nonce} building transaction`);
        const txHash = await safe.getTransactionHash(CTF, 0, calldata, 0, 0, 0, 0, ZeroAddress, ZeroAddress, nonce);
        const sig = await wallet.signMessage(getBytes(txHash));
        const v = parseInt(sig.slice(-2), 16) + 4;
        const adjustedSig = sig.slice(0, -2) + v.toString(16).padStart(2, "0");
        console.log("[Claim] submitting transaction");
        const tx = await safe.execTransaction(CTF, 0, calldata, 0, 0, 0, 0, ZeroAddress, ZeroAddress, adjustedSig);
        console.log(`[Claim] waiting for tx ${tx.hash}`);
        const receipt = await Promise.race([
          tx.wait(),
          new Promise<null>((_, reject) => setTimeout(() => reject(new Error("claim transaction timed out after 30s")), 30000)),
        ]);
        if (!receipt) throw new Error("claim transaction timed out after 30s");
        console.log(`[Claim] success ${p.title} -> ${tx.hash}`);
        results.push({ title: p.title, txHash: tx.hash });
        broadcast("claimProgress", { current: i + 1, total, title: p.title, status: "success" });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[Claim] failed ${p.title}: ${msg}`);
        results.push({ title: p.title, error: msg });
        broadcast("claimProgress", { current: i + 1, total, title: p.title, status: "error", error: msg });
      }
    }
  } finally {
    claimInProgress = false;
  }
  console.log(`[Claim] finished success:${results.filter((r) => r.txHash).length} failed:${results.filter((r) => r.error).length}`);
  if (refreshAfter) {
    await syncClaimable({ clearOnError: true });
    await syncUsdcBalance();
    broadcastState();
  }
  return results;
}

function extractOrderError(result: unknown): string {
  const obj = result && typeof result === "object" ? result as Record<string, unknown> : {};
  const candidates = [obj.error, obj.message, obj.errorMsg, obj.errorMessage];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return "";
}

function fmtOrderField(value: unknown): string {
  if (value == null || value === "") return "-";
  return String(value);
}

function getDecimalPlaces(value: string | number): number {
  const text = String(value);
  const [, decimals = ""] = text.split(".");
  return decimals.replace(/0+$/, "").length;
}

function floorToDecimals(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.floor((value + Number.EPSILON) * factor) / factor;
}

function isOrderWindowStale(now = Date.now()): boolean {
  if (!state.windowStart || !state.windowEnd) return true;
  if (state.windowEnd * 1000 <= now) return true;
  return state.windowStart < getCurrentWindowStart(now);
}

function getStrategyRemainingSeconds(now = Date.now()): number {
  return state.windowEnd ? state.windowEnd - Math.floor(now / 1000) : 0;
}

function buildTickContext(rem: number, upPct: number | null, dnPct: number | null, diff: number | null, now: number): import("./strategies/types.js").StrategyTickContext {
  return { rem, upPct, dnPct, diff, now, prevUpPct: strategyRuntime.prevUpPct };
}

function checkEntry(ctx: import("./strategies/types.js").StrategyTickContext): { strategy: StrategyNumber; dir: StrategyDirection } | null {
  for (const s of getAllStrategies()) {
    if (!strategyConfig.enabled[s.key]) continue;
    try {
      const signal = s.checkEntry(ctx);
      if (signal) return { strategy: s.number, dir: signal.direction };
    } catch (err) {
      console.error(`[Strategy${s.number}] checkEntry failed:`, err);
    }
  }
  return null;
}

function checkExit(ctx: import("./strategies/types.js").StrategyTickContext): import("./strategies/types.js").ExitSignal {
  const stratNum = strategyRuntime.activeStrategy;
  const direction = strategyRuntime.direction;
  if (!stratNum || !direction) return null;
  const key = strategyKeyOf(stratNum);
  const s = getStrategy(key);
  if (!s) return null;
  try {
    return s.checkExit(ctx, direction);
  } catch (err) {
    console.error(`[Strategy${stratNum}] checkExit failed:`, err);
    return null;
  }
}

interface PlaceOrderInput {
  direction: StrategyDirection;
  side: "buy" | "sell";
  amount: number;
  slippage?: number;
  source?: string;
  exitReason?: string;
  roundEntry?: string;
}

interface OrderExecutionResult {
  success: boolean;
  statusCode: number;
  body: Record<string, unknown>;
  errorMessage?: string;
}

interface TopOfBookQuote {
  bestBid: number;
  bestAsk: number;
  source: "state-up" | "state-down-derived" | "rest";
}

function getCachedTopOfBookQuote(direction: "up" | "down"): TopOfBookQuote | null {
  if (!isProbabilityReady()) return null;
  const upBestBid = Number(state.bestBid);
  const upBestAsk = Number(state.bestAsk);
  if (!Number.isFinite(upBestBid) || !Number.isFinite(upBestAsk) || upBestBid <= 0 || upBestAsk <= 0) {
    return null;
  }
  if (direction === "up") {
    return { bestBid: upBestBid, bestAsk: upBestAsk, source: "state-up" };
  }
  const downBestBid = 1 - upBestAsk;
  const downBestAsk = 1 - upBestBid;
  if (!Number.isFinite(downBestBid) || !Number.isFinite(downBestAsk) || downBestBid <= 0 || downBestAsk <= 0) {
    return null;
  }
  return { bestBid: downBestBid, bestAsk: downBestAsk, source: "state-down-derived" };
}

async function resolveTopOfBookQuote(tokenId: string, direction: "up" | "down"): Promise<TopOfBookQuote> {
  const cachedQuote = getCachedTopOfBookQuote(direction);
  if (cachedQuote) return cachedQuote;
  const restQuote = await fetchBookTopOfBook(tokenId);
  return { ...restQuote, source: "rest" };
}

function parseOrderDirection(value: unknown): "up" | "down" | null {
  return value === "up" || value === "down" ? value : null;
}

function parseOrderSide(value: unknown): "buy" | "sell" | null {
  return value === "buy" || value === "sell" ? value : null;
}

function parseManualOrderRequest(body: unknown): Omit<PlaceOrderInput, "source"> | null {
  if (!isRecord(body)) return null;
  const direction = parseOrderDirection(body.direction);
  const side = parseOrderSide(body.side);
  const amount = parseNumberLike(body.amount, Number.EPSILON);
  const rawSlippage = body.slippage;
  const slippage = rawSlippage == null || rawSlippage === ""
    ? undefined
    : parseNumberLike(rawSlippage, 0);
  if (!direction || !side || amount == null) return null;
  if (rawSlippage != null && rawSlippage !== "" && slippage == null) return null;
  return { direction, side, amount, slippage };
}

async function placeOrder(input: PlaceOrderInput): Promise<OrderExecutionResult> {
  const { direction, side, amount, source = "manual" } = input;
  const slippageVal = typeof input.slippage === "number" && input.slippage >= 0
    ? input.slippage
    : strategyConfig.slippage;
  const orderTag = `[Order:${source}]`;

  if ((direction !== "up" && direction !== "down") || (side !== "buy" && side !== "sell") || !amount || amount <= 0) {
    return { success: false, statusCode: 400, body: { error: "Invalid order parameters" }, errorMessage: "Invalid order parameters" };
  }
  if (side === "buy" && amount < MIN_STRATEGY_BUY_AMOUNT) {
    return {
      success: false,
      statusCode: 400,
      body: { error: `Buy amount must be at least ${MIN_STRATEGY_BUY_AMOUNT} USDC` },
      errorMessage: `Buy amount must be at least ${MIN_STRATEGY_BUY_AMOUNT} USDC`,
    };
  }
  if (!LIVE_TRADING_ENABLED) {
    return {
      success: false,
      statusCode: 403,
      body: { error: "Live trading is disabled; set LIVE_TRADING_ENABLED=true to allow real orders" },
      errorMessage: "Live trading is disabled",
    };
  }
  if (!(await ensureClobClient())) {
    return {
      success: false,
      statusCode: 500,
      body: { error: "CLOB client is not initialized; check POLYMARKET_PRIVATE_KEY" },
      errorMessage: "CLOB client is not initialized; check POLYMARKET_PRIVATE_KEY",
    };
  }
  if (isOrderWindowStale()) {
    return {
      success: false,
      statusCode: 409,
      body: { error: "Current market window is stale; wait for the next window" },
      errorMessage: "Current market window is stale; wait for the next window",
    };
  }
  if (!isProbabilityReady()) {
    return {
      success: false,
      statusCode: 409,
      body: { error: "Order book probability is temporarily unavailable" },
      errorMessage: "Order book probability is temporarily unavailable",
    };
  }

  const tokenId = direction === "up" ? state.upTokenId : state.downTokenId;
  if (!tokenId) {
    return {
      success: false,
      statusCode: 400,
      body: { error: "Current window market is not ready" },
      errorMessage: "Current window market is not ready",
    };
  }

  let bestBid = 0;
  let bestAsk = 0;
  let topOfBookSource: TopOfBookQuote["source"] = "rest";
  try {
    const quote = await resolveTopOfBookQuote(tokenId, direction);
    ({ bestBid, bestAsk } = quote);
    topOfBookSource = quote.source;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`${orderTag} quote lookup failed:`, reason);
    return {
      success: false,
      statusCode: 500,
      body: { error: "Failed to fetch order book prices", reason },
      errorMessage: `Failed to fetch order book prices: ${reason}`,
    };
  }

  const worstPrice = side === "buy"
    ? Math.min(bestAsk + slippageVal, 0.99)
    : Math.max(bestBid - slippageVal, 0.01);

  try {
    const tickSize = await clobClient!.getTickSize(tokenId);
    const priceDecimals = getDecimalPlaces(tickSize);
    const normalizedAmount = floorToDecimals(amount, 2);
    const normalizedWorstPrice = floorToDecimals(worstPrice, priceDecimals);
    const orderDebug = `book:${topOfBookSource} tickSize:${tickSize} amount:${amount}->${normalizedAmount} worstPrice:${worstPrice}->${normalizedWorstPrice}`;
    if (normalizedAmount <= 0 || normalizedWorstPrice <= 0) {
      console.warn(`${orderTag} normalized params became invalid ${orderDebug}`);
      return {
        success: false,
        statusCode: 400,
        body: { error: "Normalized order parameters are invalid", bestBid, bestAsk, worstPrice: normalizedWorstPrice },
        errorMessage: "Normalized order parameters are invalid",
      };
    }

    const signedOrder = await clobClient!.createMarketOrder(
      { tokenID: tokenId, side: side === "buy" ? Side.BUY : Side.SELL, amount: normalizedAmount, price: normalizedWorstPrice },
      { tickSize, negRisk: false }
    );
    const result = await clobClient!.postOrder(signedOrder, chooseMarketOrderType(side, normalizedAmount));
    const rawStatus = result?.status ?? "unknown";
    const orderError = extractOrderError(result);

    if (result?.status === 400 || orderError) {
      console.warn(`${orderTag} ${side}/${direction} ${normalizedAmount} status:${rawStatus} reason:${orderError || "-"} ${orderDebug}`);
      return {
        success: false,
        statusCode: 400,
        body: { error: orderError || `Order rejected status=${rawStatus}`, result, bestBid, bestAsk, worstPrice: normalizedWorstPrice },
        errorMessage: orderError || `Order rejected status=${rawStatus}`,
      };
    }

    const statusZh = rawStatus === "matched" ? "matched" : rawStatus;
    console.log(`${orderTag} ${side}/${direction} ${normalizedAmount} status:${statusZh} taking:${fmtOrderField(result?.takingAmount)} making:${fmtOrderField(result?.makingAmount)} ${orderDebug}`);
    rememberPendingTradeMeta({
      orderId: typeof result?.orderID === "string" && result.orderID ? result.orderID : undefined,
      ts: Date.now(),
      windowStart: state.windowStart,
      side,
      direction,
      amount: normalizedAmount,
      worstPrice: normalizedWorstPrice,
      source,
      exitReason: input.exitReason,
      roundEntry: input.roundEntry,
    });
    if (!(typeof result?.orderID === "string" && result.orderID)) {
      console.warn(`${orderTag} response missing orderID; MINED reconciliation will fall back to direction/size matching`);
    }
    broadcastState();
    return {
      success: true,
      statusCode: 200,
      body: { success: true, result, bestBid, bestAsk, worstPrice: normalizedWorstPrice },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`${orderTag} failed:`, msg);
    return {
      success: false,
      statusCode: 500,
      body: { error: msg },
      errorMessage: msg,
    };
  }
}

async function strategyBuy(direction: StrategyDirection, amount: number): Promise<void> {
  strategyRuntime.posBeforeBuy = getDirectionLocalSize(direction);
  strategyRuntime.actionTs = Date.now();
  strategyRuntime.buyLockUntil = Date.now() + STRAT_BUY_LOCK_MS;
  strategyRuntime.state = "WAIT_FILL";
  broadcastState();

  const orderResult = await placeOrder({
    direction,
    side: "buy",
    amount,
    slippage: strategyConfig.slippage,
    source: `strategy${strategyRuntime.activeStrategy ?? ""}`,
    roundEntry: `${strategyRuntime.roundEntryCount}/${strategyConfig.maxRoundEntries}`,
  });

  if (!orderResult.success) {
    console.log(`[Strategy${strategyRuntime.activeStrategy ?? ""}] buy failed: ${orderResult.errorMessage || "order failed"}`);
    logStrategyRuntimeEvent("buy_failed", {
      strategy: strategyRuntime.activeStrategy ? `S${strategyRuntime.activeStrategy}` : null,
      direction,
      amount,
      error: orderResult.errorMessage || "order failed",
      liveTradingEnabled: LIVE_TRADING_ENABLED,
    });
    strategyRuntime.buyLockUntil = 0;
    strategyRuntime.state = "SCANNING";
    strategyRuntime.activeStrategy = null;
    broadcastState();
  }
}

async function strategySell(direction: StrategyDirection, exitReason?: string): Promise<void> {
  const totalPos = getDirectionLocalSize(direction);
  const shares = getSellableShares(direction);
  if (shares <= 0) {
    transitionToDone();
    return;
  }

  strategyRuntime.posBeforeSell = totalPos;
  strategyRuntime.waitVerifyAfterSell = !isDirectionVerified(direction);
  strategyRuntime.actionTs = Date.now();
  strategyRuntime.state = "WAIT_SELL_FILL";
  broadcastState();

  const orderResult = await placeOrder({
    direction,
    side: "sell",
    amount: shares,
    slippage: strategyConfig.slippage,
    source: `strategy${strategyRuntime.activeStrategy ?? ""}`,
    exitReason,
    roundEntry: `${strategyRuntime.roundEntryCount}/${strategyConfig.maxRoundEntries}`,
  });

  if (!orderResult.success) {
    console.log(`[Strategy${strategyRuntime.activeStrategy ?? ""}] sell failed: ${orderResult.errorMessage || "order failed"}`);
    logStrategyRuntimeEvent("sell_failed", {
      strategy: strategyRuntime.activeStrategy ? `S${strategyRuntime.activeStrategy}` : null,
      direction,
      reason: exitReason,
      error: orderResult.errorMessage || "order failed",
      liveTradingEnabled: LIVE_TRADING_ENABLED,
    });
    strategyRuntime.waitVerifyAfterSell = false;
    strategyRuntime.state = "HOLDING";
    broadcastState();
  }
}

// -----------------------------------------------------------------------------
let backtestCollecting = false;
let backtestLastTickTs = 0;

function setBacktestCollecting(enabled: boolean): void {
  backtestCollecting = enabled;
  console.log(`[Backtest] collection ${enabled ? "enabled" : "disabled"}`);
  if (enabled) {
    mkdirSync(BACKTEST_DATA_DIR, { recursive: true });
  }
  broadcastBacktestStatus();
}

function broadcastBacktestStatus(): void {
  broadcast("backtestStatus", { collecting: backtestCollecting });
}

function getBacktestFilePath(): string {
  const dateStr = new Date().toISOString().slice(0, 10);
  return resolve(BACKTEST_DATA_DIR, `${dateStr}.jsonl`);
}

function backtestAppend(record: Record<string, unknown>): void {
  try {
    appendFileSync(getBacktestFilePath(), JSON.stringify(record) + "\n");
  } catch (err) {
    console.warn(`[Backtest] write failed: ${(err as Error).message}`);
  }
}

function backtestTick(): void {
  if (!backtestCollecting) return;
  const now = Date.now();
  if (now - backtestLastTickTs < 1000) return;

  const snapshot = getProbabilitySnapshot();
  const diff = getStrategyDiff();
  const rem = getStrategyRemainingSeconds(now);
  if (snapshot == null || diff == null || !state.windowStart) return;

  backtestAppend({
    type: "tick",
    ts: now,
    windowStart: state.windowStart,
    diff: Math.round(diff * 100) / 100,
    upPct: snapshot.upPct,
    rem,
  });
  backtestLastTickTs = now;
}


function runStrategyWatchdogs(now = Date.now()): void {
  if (
    strategyRuntime.buyLockUntil > 0
    && now > strategyRuntime.buyLockUntil + FILL_RECONCILE_TIMEOUT_MS
    && ["BUYING", "WAIT_FILL", "RECONCILING_FILL"].includes(strategyRuntime.state)
  ) {
    console.warn("[Strategy] buyLock watchdog released a stale lock");
    strategyRuntime.buyLockUntil = 0;
    strategyRuntime.state = anyStrategyEnabled() ? "SCANNING" : "IDLE";
    strategyRuntime.activeStrategy = null;
    strategyRuntime.direction = null;
    strategyRuntime.buyAmount = 0;
    strategyRuntime.posBeforeBuy = 0;
    strategyRuntime.actionTs = 0;
    broadcastState();
  }
}

function runStrategyTick(): void {
  const snapshot = getProbabilitySnapshot();
  const upPct = snapshot?.upPct ?? null;
  const dnPct = snapshot?.dnPct ?? null;
  const diff = getStrategyDiff();
  const now = Date.now();
  const rem = getStrategyRemainingSeconds(now);
  const currentPosition = getDirectionLocalSize(strategyRuntime.direction);
  const ctx = buildTickContext(rem, upPct, dnPct, diff, now);
  const finalize = () => {
    strategyRuntime.prevUpPct = upPct;
    for (const s of getAllStrategies()) {
      if (strategyConfig.enabled[s.key] && "finalizeTick" in s && typeof (s as any).finalizeTick === "function") {
        try {
          (s as any).finalizeTick(diff);
        } catch (err) {
          console.error(`[Strategy${s.number}] finalizeTick failed:`, err);
        }
      }
    }
  };

  if (isOrderWindowStale(now)) {
    finalize();
    return;
  }

  if (!strategyRuntime.positionsReady) {
    finalize();
    return;
  }

  for (const s of getAllStrategies()) {
    if (strategyConfig.enabled[s.key]) {
      try {
        s.updateGuards(ctx);
      } catch (err) {
        console.error(`[Strategy${s.number}] updateGuards failed:`, err);
      }
    }
  }

  if (strategyRuntime.cleanupAfterVerify && strategyRuntime.direction) {
    if (!isDirectionVerified(strategyRuntime.direction)) {
      finalize();
      return;
    }
    if (currentPosition < 0.01) {
      strategyRuntime.cleanupAfterVerify = false;
      transitionToDone();
      finalize();
      return;
    }
    strategyRuntime.cleanupAfterVerify = false;
    strategyRuntime.state = "SELLING";
    console.log(`[Strategy${strategyRuntime.activeStrategy ?? ""}] verified residual position ${currentPosition.toFixed(2)}, clearing remainder`);
    broadcastState();
    void strategySell(strategyRuntime.direction, `verified cleanup residual ${currentPosition.toFixed(2)}`);
    finalize();
    return;
  }

  if (strategyRuntime.state === "IDLE") {
    if (upPct == null || diff == null) {
      finalize();
      return;
    }
    if (anyStrategyEnabled()) {
      strategyRuntime.state = "SCANNING";
      broadcastState();
    }
    finalize();
    return;
  }

  if (strategyRuntime.state === "SCANNING") {
    if (!anyStrategyEnabled()) {
      strategyRuntime.state = "IDLE";
      broadcastState();
      finalize();
      return;
    }
    if (hasOpenPosition() || hasPendingStrategyBuyLock(now) || upPct == null || dnPct == null || diff == null) {
      finalize();
      return;
    }
    if (strategyRuntime.roundEntryCount >= strategyConfig.maxRoundEntries) {
      finalize();
      return;
    }
    const entry = checkEntry(ctx);
    if (!entry) {
      finalize();
      return;
    }
    const buyAmount = strategyConfig.amount[strategyKeyOf(entry.strategy)];
    if (!hasEnoughUsdcForBuy(buyAmount)) {
      finalize();
      return;
    }
    const { asks } = getOrderBookSnapshot();
    const bestBid = Number(state.bestBid);
    const bestAsk = Number(state.bestAsk);
    if (!canExecuteMarketBuy({ amount: buyAmount, bestBid, bestAsk, asks })) {
      console.log(`[Strategy${entry.strategy}] entry skipped due to thin/wide order book dir=${entry.dir} amount=${buyAmount} bid=${state.bestBid} ask=${state.bestAsk}`);
      finalize();
      return;
    }
    strategyRuntime.roundEntryCount++;
    strategyRuntime.activeStrategy = entry.strategy;
    strategyRuntime.direction = entry.dir;
    strategyRuntime.buyAmount = buyAmount;
    strategyRuntime.state = "BUYING";
    console.log(`[Strategy${entry.strategy}] entry triggered (${strategyRuntime.roundEntryCount}/${strategyConfig.maxRoundEntries}) dir=${entry.dir} amount=${buyAmount}`);
    logStrategyRuntimeEvent("entry_triggered", {
      strategy: `S${entry.strategy}`,
      direction: entry.dir,
      amount: buyAmount,
      roundEntry: `${strategyRuntime.roundEntryCount}/${strategyConfig.maxRoundEntries}`,
      liveTradingEnabled: LIVE_TRADING_ENABLED,
    });
    broadcastState();
    void strategyBuy(entry.dir, buyAmount);
    finalize();
    return;
  }

  if (strategyRuntime.state === "WAIT_FILL") {
    if (hasConfirmedBuyPosition()) {
      strategyRuntime.buyLockUntil = 0;
      strategyRuntime.state = "HOLDING";
      console.log(`[Strategy${strategyRuntime.activeStrategy ?? ""}] buy fill confirmed`);
      logStrategyRuntimeEvent("buy_fill_confirmed", {
        strategy: strategyRuntime.activeStrategy ? `S${strategyRuntime.activeStrategy}` : null,
        direction: strategyRuntime.direction,
        amount: strategyRuntime.buyAmount,
        liveTradingEnabled: LIVE_TRADING_ENABLED,
      });
      if (strategyRuntime.activeStrategy && strategyRuntime.direction) {
        const activeStrat = getStrategy(strategyKeyOf(strategyRuntime.activeStrategy));
        if (activeStrat?.onEntryFilled) {
          try {
            activeStrat.onEntryFilled(ctx, strategyRuntime.direction);
          } catch (err) {
            console.error(`[Strategy${strategyRuntime.activeStrategy}] onEntryFilled failed:`, err);
          }
        }
      }
      broadcastState();
    } else if (now - strategyRuntime.actionTs > WAIT_FILL_TIMEOUT_MS) {
      console.log(`[Strategy${strategyRuntime.activeStrategy ?? ""}] buy not confirmed within 10s, entering reconcile state`);
      strategyRuntime.state = "RECONCILING_FILL";
      broadcastState();
      finalize();
      return;
    } else {
      finalize();
      return;
    }
  }

  if (strategyRuntime.state === "RECONCILING_FILL") {
    if (hasConfirmedBuyPosition()) {
      strategyRuntime.buyLockUntil = 0;
      strategyRuntime.state = "HOLDING";
      console.log(`[Strategy${strategyRuntime.activeStrategy ?? ""}] delayed fill confirmation succeeded`);
      if (strategyRuntime.activeStrategy && strategyRuntime.direction) {
        const activeStrat = getStrategy(strategyKeyOf(strategyRuntime.activeStrategy));
        if (activeStrat?.onEntryFilled) {
          try {
            activeStrat.onEntryFilled(ctx, strategyRuntime.direction);
          } catch (err) {
            console.error(`[Strategy${strategyRuntime.activeStrategy}] onEntryFilled failed:`, err);
          }
        }
      }
      broadcastState();
    } else if (canReleaseUnconfirmedBuy(now)) {
      console.log(`[Strategy${strategyRuntime.activeStrategy ?? ""}] no position confirmed after reconcile timeout, back to scanning`);
      strategyRuntime.state = "SCANNING";
      strategyRuntime.activeStrategy = null;
      strategyRuntime.direction = null;
      strategyRuntime.buyAmount = 0;
      strategyRuntime.posBeforeBuy = 0;
      strategyRuntime.actionTs = 0;
      strategyRuntime.buyLockUntil = 0;
      broadcastState();
      finalize();
      return;
    } else {
      finalize();
      return;
    }
  }

  if (strategyRuntime.state === "HOLDING") {
    if (currentPosition <= 0) {
      transitionToDone();
      finalize();
      return;
    }
    if (upPct == null || dnPct == null || diff == null) {
      finalize();
      return;
    }
    const exit = checkExit(ctx);
    if (exit && strategyRuntime.direction) {
      console.log(`[Strategy${strategyRuntime.activeStrategy ?? ""}] ${exit.signal} triggered: ${exit.reason}`);
      logStrategyRuntimeEvent("sell_signal_triggered", {
        strategy: strategyRuntime.activeStrategy ? `S${strategyRuntime.activeStrategy}` : null,
        direction: strategyRuntime.direction,
        signal: exit.signal,
        reason: exit.reason,
        liveTradingEnabled: LIVE_TRADING_ENABLED,
      });
      strategyRuntime.state = "SELLING";
      broadcastState();
      void strategySell(strategyRuntime.direction, exit.reason);
    }
    finalize();
    return;
  }

  if (strategyRuntime.state === "WAIT_SELL_FILL") {
    if (currentPosition < strategyRuntime.posBeforeSell - 0.01) {
      if (currentPosition < 0.01) {
        strategyRuntime.waitVerifyAfterSell = false;
        strategyRuntime.cleanupAfterVerify = false;
        console.log(`[Strategy${strategyRuntime.activeStrategy ?? ""}] sell fill confirmed, cycle complete`);
        logStrategyRuntimeEvent("sell_fill_confirmed", {
          strategy: strategyRuntime.activeStrategy ? `S${strategyRuntime.activeStrategy}` : null,
          direction: strategyRuntime.direction,
          remainingPosition: Number(currentPosition.toFixed(4)),
          liveTradingEnabled: LIVE_TRADING_ENABLED,
        });
        transitionToDone();
        finalize();
        return;
      }

      if (strategyRuntime.waitVerifyAfterSell) {
        strategyRuntime.waitVerifyAfterSell = false;
        if (isDirectionVerified(strategyRuntime.direction)) {
          console.log(`[Strategy${strategyRuntime.activeStrategy ?? ""}] post-sell verification complete, residual ${currentPosition.toFixed(2)}, clearing immediately`);
          strategyRuntime.cleanupAfterVerify = false;
          strategyRuntime.state = "SELLING";
          broadcastState();
          if (strategyRuntime.direction) void strategySell(strategyRuntime.direction, `verified cleanup residual ${currentPosition.toFixed(2)}`);
          finalize();
          return;
        }
        strategyRuntime.cleanupAfterVerify = true;
        strategyRuntime.state = "DONE";
        console.log(`[Strategy${strategyRuntime.activeStrategy ?? ""}] sell confirmed, waiting for verification before residual check`);
        broadcastState();
        finalize();
        return;
      }

      strategyRuntime.waitVerifyAfterSell = false;
      strategyRuntime.state = "HOLDING";
      console.log(`[Strategy${strategyRuntime.activeStrategy ?? ""}] sell partially filled, residual ${currentPosition.toFixed(2)} remains`);
      broadcastState();
      finalize();
      return;
    }

    if (now - strategyRuntime.actionTs > WAIT_FILL_TIMEOUT_MS) {
      console.log(`[Strategy${strategyRuntime.activeStrategy ?? ""}] sell timeout, returning to holding`);
      strategyRuntime.waitVerifyAfterSell = false;
      strategyRuntime.state = "HOLDING";
      broadcastState();
    }
    finalize();
    return;
  }

  finalize();
}

function buildApiStatePayload(): Record<string, unknown> {
  return {
    ...buildStatePayload(true),
    tradeHistory,
    wsStatus,
    claimable: {
      total: claimableTotal,
      positions: claimablePositions,
    },
    claimCooldown: {
      running: claimCycleRunning || claimInProgress,
      nextCheckAt: claimNextCheckAt,
    },
  };
}

app.get("/api/state", (_req, res) => {
  res.json(buildApiStatePayload());
});

app.get("/api/readiness", (_req, res) => {
  const report = getRuntimeReadinessReport();
  res.status(report.ready ? 200 : 503).json(report);
});

app.get("/api/strategy/descriptions", (_req, res) => {
  res.json(getAllDescriptions());
});

app.get("/api/backtest/status", (_req, res) => {
  res.json({ collecting: backtestCollecting });
});

app.post("/api/backtest/toggle", mutationRateLimiter, (_req, res) => {
  setBacktestCollecting(!backtestCollecting);
  res.json({ collecting: backtestCollecting });
});

app.post("/api/strategy/config", mutationRateLimiter, (req, res) => {
  const { config, error } = applyStrategyConfigUpdate(strategyConfig, req.body);
  if (!config) {
    res.status(400).json({ error: error || "Invalid config" });
    return;
  }

  strategyConfig = config;
  savePersistedStrategyConfig(config);
  const configSummary = ALL_STRATEGY_KEYS.map((k) => `${k}:${config.enabled[k] ? "on" : "off"}(${config.amount[k]})`).join(" ");
  console.log(`[StrategyConfig] updated ${configSummary} maxRound:${config.maxRoundEntries}`);
  broadcastState();
  res.json({ success: true, strategyConfig });
});

// -----------------------------------------------------------------------------
app.post("/api/claim", tradeActionRateLimiter, async (_req, res) => {
  if (!LIVE_TRADING_ENABLED) {
    res.status(403).json({ error: "Live trading is disabled; set LIVE_TRADING_ENABLED=true to allow claim transactions" }); return;
  }
  if (!PROXY_ADDRESS || !PRIVATE_KEY) {
    res.status(500).json({ error: "Wallet configuration is missing" }); return;
  }
  if (claimInProgress) {
    res.status(429).json({ error: "Claim already in progress" }); return;
  }
  claimNextCheckAt = 0;
  broadcastClaimCooldown(true);
  const synced = await syncClaimable({ clearOnError: true });
  if (!synced) {
    scheduleClaimCycle();
    res.status(503).json({ error: "Failed to query redeemable positions" }); return;
  }
  if (!claimablePositions.length) {
    scheduleClaimCycle();
    res.status(400).json({ error: "No redeemable positions available" }); return;
  }
  const results = await runClaim({ refreshAfter: false });
  scheduleClaimCycle();
  res.json({ results });
});

// -----------------------------------------------------------------------------
app.post("/api/order", tradeActionRateLimiter, async (req, res) => {
  try {
    const input = parseManualOrderRequest(req.body);
    if (!input) {
      res.status(400).json({ error: "Invalid order request body" });
      return;
    }
    const result = await placeOrder({ ...input, source: "manual" });
    res.status(result.statusCode).json(result.body);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[Order:manual] route failed:", msg);
    res.status(500).json({ error: msg || "Internal Server Error" });
  }
});

// -----------------------------------------------------------------------------
if (wss) {
  wss.on("connection", (ws, req) => {
    // 从 URL 参数中提取 token 并添加到 headers，以便 extractToken 函数能识别
    if (req.url) {
      try {
        const url = new URL(req.url, `http://localhost:${PORT}`);
        const urlToken = url.searchParams.get("token");
        if (urlToken && typeof req.headers === "object") {
          req.headers["x-api-token"] = urlToken;
        }
      } catch {
        // 忽略 URL 解析错误
      }
    }

    if (!isAuthorized(req.headers, req.socket.remoteAddress, {
      bindHost: BIND_HOST,
      apiToken: API_TOKEN,
      apiTokenRequired: API_TOKEN_REQUIRED,
      apiTokenAutoDerived: API_TOKEN_AUTO_DERIVED,
    }) || !hasTrustedOrigin(req.headers, BIND_HOST)) {
      ws.close(1008, "unauthorized");
      return;
    }
    const dataMode = resolveClientDataModeFromUrl(req.url);
    clientSessions.set(ws, createClientSession(dataMode));
    console.log(`[WS] client connected, active ${wss!.clients.size} mode=${dataMode}`);
    send(ws, "clientConfig", { dataMode });
    sendStateToClient(ws, { includeHistory: true });
    sendTradeHistoryToClient(ws);
    send(ws, "wsStatus", wsStatus as unknown as Record<string, unknown>);
    send(ws, "claimable", { total: claimableTotal, positions: claimablePositions });
    send(ws, "claimCooldown", { running: claimCycleRunning || claimInProgress, nextCheckAt: claimNextCheckAt });
    send(ws, "backtestStatus", { collecting: backtestCollecting });
    ws.on("message", (raw) => {
      try {
        applyClientConfig(ws, JSON.parse(raw.toString()));
      } catch {
        // Ignore non-JSON or non-config messages.
      }
    });
    ws.on("close", () => {
      const session = clientSessions.get(ws);
      if (session) {
        clearStateTimer(session);
        clientSessions.delete(ws);
      }
      console.log(`[WS] client disconnected, active ${wss!.clients.size}`);
    });
  });
}

// -----------------------------------------------------------------------------
server.listen(PORT, BIND_HOST, async () => {
  if (!EXTERNAL_IO_DISABLED) {
    await prepareOutboundProxy();
  }

  console.log("\nBTC 5m monitor started");
  console.log(`  Mode:          ${APP_MODE}`);
  console.log(`  Bind:          ${BIND_HOST}:${PORT}`);
  console.log(`  State API:     http://${BIND_HOST}:${PORT}/api/state`);
  if (IS_FULL_MODE) {
    console.log(`  Browser:       http://${BIND_HOST}:${PORT}`);
    console.log(`  WS:           ws://${BIND_HOST}:${PORT}`);
  }
  if (API_TOKEN_REQUIRED) {
    console.log(`  API auth:      APP_API_TOKEN enabled${API_TOKEN_AUTO_DERIVED ? " (auto-derived)" : ""}`);
  } else {
    console.log("  API auth:      APP_API_TOKEN not set, local-only access");
  }
  console.log(`  Live trading:  ${LIVE_TRADING_ENABLED ? "enabled" : "disabled"}`);
  if (OUTBOUND_PROXY_URL) {
    console.log(`  Outbound proxy:${isOutboundProxyActive() ? ` ${OUTBOUND_PROXY_URL}` : " bypassed -> direct"}`);
  }
  if (EXTERNAL_IO_DISABLED) {
    console.log("  External IO:   disabled");
  }
  console.log("");
  initStrategies();
  assertRuntimeConfig();
  if (!PRIVATE_KEY) {
    console.warn("[Startup] POLYMARKET_PRIVATE_KEY not set; trading and claim features are disabled");
  }
  if (EXTERNAL_IO_DISABLED) return;

  await ensureClobClient();
  startBinanceWs();
  await syncPositionsFromApi();
  await syncUsdcBalance();

  setInterval(async () => { await syncPositionsFromApi(); broadcastState(); }, 2000);
  setInterval(async () => { await syncUsdcBalance(); broadcastState(); }, 5000);
  setInterval(() => { refreshBinanceOffset("interval", { allowLatestFallback: false }); }, BINANCE_ALIGN_REFRESH_MS);
  setInterval(() => { runStrategyWatchdogs(); runStrategyTick(); backtestTick(); }, STRATEGY_TICK_MS);
  scheduleClaimCycle(0);

  const currentWindow = getCurrentWindowStart();
  fetchRecentResults(currentWindow, true);
  await subscribeWindow(currentWindow);
});

process.on("SIGINT", () => {
  stopped = true;
  if (switchTimer)    clearTimeout(switchTimer);
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (claimCycleTimer) clearTimeout(claimCycleTimer);
  if (marketWs)    marketWs.close();
  if (chainlinkWs) chainlinkWs.close();
  if (userWs)      (userWs as WebSocket).close();
  if (binanceWs)   binanceWs.close();
  server.close();
  process.exit(0);
});












