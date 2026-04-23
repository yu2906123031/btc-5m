import { createConnection } from "node:net";
import type { AxiosStatic } from "axios";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";

export type OutboundProxyAgent = HttpsProxyAgent<string> | SocksProxyAgent;

export function buildProxyAgent(proxyUrl: string): OutboundProxyAgent {
  const protocol = new URL(proxyUrl).protocol.toLowerCase();
  if (protocol === "socks:" || protocol === "socks4:" || protocol === "socks4a:" || protocol === "socks5:" || protocol === "socks5h:") {
    return new SocksProxyAgent(proxyUrl);
  }
  return new HttpsProxyAgent(proxyUrl);
}

export function applyAxiosProxyDefaults(axiosStatic: AxiosStatic, proxyAgent?: OutboundProxyAgent): void {
  if (!proxyAgent) return;
  axiosStatic.defaults.proxy = false;
  axiosStatic.defaults.httpAgent = proxyAgent;
  axiosStatic.defaults.httpsAgent = proxyAgent;
}

function normalizeHostname(hostname: string): string {
  const trimmed = hostname.trim().toLowerCase();
  return trimmed.startsWith("[") && trimmed.endsWith("]")
    ? trimmed.slice(1, -1)
    : trimmed;
}

export function isLoopbackHostname(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);
  return normalized === "localhost" || normalized === "::1" || normalized.startsWith("127.");
}

export function isLoopbackProxyUrl(proxyUrl: string): boolean {
  try {
    return isLoopbackHostname(new URL(proxyUrl).hostname);
  } catch {
    return false;
  }
}

export function describeOutboundError(error: unknown): string {
  const parts = new Set<string>();
  const seen = new Set<unknown>();
  let current: unknown = error;

  while (current != null && !seen.has(current)) {
    seen.add(current);

    if (current instanceof Error) {
      if (current.message) parts.add(current.message);
      current = (current as Error & { cause?: unknown }).cause;
      continue;
    }

    if (typeof current === "object") {
      const maybeMessage = typeof (current as { message?: unknown }).message === "string"
        ? String((current as { message: string }).message)
        : "";
      const maybeCode = typeof (current as { code?: unknown }).code === "string"
        ? String((current as { code: string }).code)
        : "";
      if (maybeMessage) parts.add(maybeMessage);
      else if (maybeCode) parts.add(maybeCode);
      current = (current as { cause?: unknown }).cause;
      continue;
    }

    if (typeof current === "string" && current) parts.add(current);
    break;
  }

  return Array.from(parts).join(" | ");
}

export function shouldBypassProxyAfterError(error: unknown): boolean {
  const message = describeOutboundError(error).toLowerCase();
  if (!message) return false;

  return [
    "econnrefused",
    "fetch failed",
    "socket hang up",
    "proxy connection ended before receiving connect response",
    "unable to connect to proxy",
    "proxy error",
    "connect timeout",
  ].some((marker) => message.includes(marker));
}

export async function probeLoopbackProxyAvailability(proxyUrl: string, timeoutMs = 300): Promise<boolean | null> {
  let parsed: URL;
  try {
    parsed = new URL(proxyUrl);
  } catch {
    return null;
  }

  if (!isLoopbackHostname(parsed.hostname)) return null;

  const port = Number(parsed.port || (parsed.protocol === "https:" ? 443 : parsed.protocol === "http:" ? 80 : 0));
  if (!Number.isInteger(port) || port <= 0) return null;

  return await new Promise((resolve) => {
    const socket = createConnection({
      host: normalizeHostname(parsed.hostname),
      port,
    });

    let settled = false;
    const finish = (result: boolean) => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };

    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(timeoutMs, () => finish(false));
  });
}
