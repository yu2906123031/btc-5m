import { createHash } from "crypto";

export type HeaderMap = Record<string, string | string[] | undefined>;

export interface ApiTokenState {
  apiToken: string;
  apiTokenAutoDerived: boolean;
  apiTokenRequired: boolean;
}

export interface ApiAuthConfig extends ApiTokenState {
  bindHost: string;
}

export function isPlaceholderApiToken(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return !normalized || normalized === "replace_with_a_long_random_token" || normalized === "auto";
}

export function deriveApiToken(privateKey: string): string {
  const digest = createHash("sha256")
    .update("btc5m-web:app-api-token:")
    .update(privateKey.trim())
    .digest("hex");
  return `pk-${digest}`;
}

export function resolveApiTokenState(rawApiToken: string, privateKey?: string): ApiTokenState {
  const normalizedRawApiToken = rawApiToken.trim();
  const apiToken = isPlaceholderApiToken(normalizedRawApiToken)
    ? (privateKey?.trim() ? deriveApiToken(privateKey) : "")
    : normalizedRawApiToken;
  const apiTokenAutoDerived = apiToken.length > 0 && isPlaceholderApiToken(normalizedRawApiToken);
  return {
    apiToken,
    apiTokenAutoDerived,
    apiTokenRequired: apiToken.length > 0,
  };
}

export function normalizeHost(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return "";
  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    return end >= 0 ? trimmed.slice(1, end) : trimmed;
  }
  const colonCount = [...trimmed].filter((ch) => ch === ":").length;
  if (colonCount === 1) return trimmed.slice(0, trimmed.lastIndexOf(":"));
  return trimmed;
}

export function getAllowedHosts(bindHost: string, hostHeader?: string): Set<string> {
  const hosts = new Set<string>(["127.0.0.1", "localhost", "::1", bindHost.toLowerCase()]);
  const normalizedHostHeader = normalizeHost(hostHeader || "");
  if (normalizedHostHeader) hosts.add(normalizedHostHeader);
  return hosts;
}

export function isLoopbackAddress(value: string | undefined): boolean {
  if (!value) return false;
  return value === "127.0.0.1" || value === "::1" || value === "::ffff:127.0.0.1";
}

function resolveOriginCandidates(headers: HeaderMap): string[] {
  const candidates = [headers.origin, headers.referer];
  return candidates
    .map((value) => Array.isArray(value) ? value[0] : value)
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0);
}

export function hasTrustedOrigin(headers: HeaderMap, bindHost: string): boolean {
  const hostHeader = Array.isArray(headers.host) ? headers.host[0] : headers.host;
  const allowedHosts = getAllowedHosts(bindHost, hostHeader);
  const values = resolveOriginCandidates(headers);
  if (!values.length) return true;
  return values.every((value) => {
    try {
      return allowedHosts.has(normalizeHost(new URL(value).host));
    } catch {
      return false;
    }
  });
}

export function hasExplicitTrustedOrigin(headers: HeaderMap, bindHost: string): boolean {
  const hostHeader = Array.isArray(headers.host) ? headers.host[0] : headers.host;
  const allowedHosts = getAllowedHosts(bindHost, hostHeader);
  const values = resolveOriginCandidates(headers);
  if (!values.length) return false;
  return values.every((value) => {
    try {
      return allowedHosts.has(normalizeHost(new URL(value).host));
    } catch {
      return false;
    }
  });
}

export function extractToken(headers: HeaderMap): string {
  const authHeader = Array.isArray(headers.authorization) ? headers.authorization[0] : headers.authorization;
  if (authHeader?.startsWith("Bearer ")) return authHeader.slice("Bearer ".length).trim();
  const customHeader = Array.isArray(headers["x-api-token"]) ? headers["x-api-token"][0] : headers["x-api-token"];
  if (typeof customHeader === "string" && customHeader.trim()) return customHeader.trim();
  const protocolHeader = Array.isArray(headers["sec-websocket-protocol"])
    ? headers["sec-websocket-protocol"][0]
    : headers["sec-websocket-protocol"];
  if (typeof protocolHeader === "string" && protocolHeader.trim()) {
    const protocols = protocolHeader.split(",").map((value) => value.trim());
    const tokenProtocol = protocols.find((value) => value.startsWith("token."));
    if (tokenProtocol) return tokenProtocol.slice("token.".length);
  }
  return "";
}

export function isLocalAutoDerivedBrowserRequest(
  headers: HeaderMap,
  remoteAddress: string | undefined,
  config: ApiAuthConfig,
): boolean {
  return config.apiTokenAutoDerived && isLoopbackAddress(remoteAddress) && hasExplicitTrustedOrigin(headers, config.bindHost);
}

export function isAuthorized(
  headers: HeaderMap,
  remoteAddress: string | undefined,
  config: ApiAuthConfig,
): boolean {
  if (config.apiTokenRequired) {
    if (extractToken(headers) === config.apiToken) return true;
    return isLocalAutoDerivedBrowserRequest(headers, remoteAddress, config);
  }
  return isLoopbackAddress(remoteAddress);
}

export function shouldPublicConfigRequireToken(
  headers: HeaderMap,
  remoteAddress: string | undefined,
  config: ApiAuthConfig,
): boolean {
  return config.apiTokenRequired && !isLocalAutoDerivedBrowserRequest(headers, remoteAddress, config);
}
