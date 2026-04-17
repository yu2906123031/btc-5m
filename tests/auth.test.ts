import test from "node:test";
import assert from "node:assert/strict";

import {
  deriveApiToken,
  extractToken,
  getAllowedHosts,
  hasExplicitTrustedOrigin,
  hasTrustedOrigin,
  isAuthorized,
  isLoopbackAddress,
  isPlaceholderApiToken,
  normalizeHost,
  resolveApiTokenState,
  shouldPublicConfigRequireToken,
  type ApiAuthConfig,
} from "../auth.js";

const fixedConfig: ApiAuthConfig = {
  bindHost: "127.0.0.1",
  apiToken: "secret-token",
  apiTokenRequired: true,
  apiTokenAutoDerived: false,
};

test("isPlaceholderApiToken detects blank and placeholder values", () => {
  assert.equal(isPlaceholderApiToken(""), true);
  assert.equal(isPlaceholderApiToken(" auto "), true);
  assert.equal(isPlaceholderApiToken("replace_with_a_long_random_token"), true);
  assert.equal(isPlaceholderApiToken("custom-token"), false);
});

test("deriveApiToken and resolveApiTokenState produce deterministic derived tokens", () => {
  const token = deriveApiToken(" 0xabc ");
  assert.match(token, /^pk-[0-9a-f]{64}$/);

  const resolved = resolveApiTokenState("auto", "0xabc");
  assert.deepEqual(resolved, {
    apiToken: token,
    apiTokenAutoDerived: true,
    apiTokenRequired: true,
  });

  assert.deepEqual(resolveApiTokenState("manual-token", "0xabc"), {
    apiToken: "manual-token",
    apiTokenAutoDerived: false,
    apiTokenRequired: true,
  });
});

test("normalizeHost and getAllowedHosts handle ports and IPv6 loopback", () => {
  assert.equal(normalizeHost("LOCALHOST:3456"), "localhost");
  assert.equal(normalizeHost("[::1]:3456"), "::1");

  const hosts = getAllowedHosts("127.0.0.1", "localhost:3456");
  assert.equal(hosts.has("127.0.0.1"), true);
  assert.equal(hosts.has("localhost"), true);
  assert.equal(hosts.has("::1"), true);
});

test("trusted origin helpers allow local origins and reject foreign origins", () => {
  const localHeaders = {
    host: "127.0.0.1:3456",
    origin: "http://localhost:3456",
  };
  assert.equal(hasTrustedOrigin(localHeaders, "127.0.0.1"), true);
  assert.equal(hasExplicitTrustedOrigin(localHeaders, "127.0.0.1"), true);

  const foreignHeaders = {
    host: "127.0.0.1:3456",
    origin: "https://evil.example",
  };
  assert.equal(hasTrustedOrigin(foreignHeaders, "127.0.0.1"), false);
  assert.equal(hasExplicitTrustedOrigin(foreignHeaders, "127.0.0.1"), false);

  assert.equal(hasTrustedOrigin({}, "127.0.0.1"), true);
  assert.equal(hasExplicitTrustedOrigin({}, "127.0.0.1"), false);
});

test("extractToken reads bearer, custom header, and websocket protocol tokens", () => {
  assert.equal(extractToken({ authorization: "Bearer abc123" }), "abc123");
  assert.equal(extractToken({ "x-api-token": "xyz789" }), "xyz789");
  assert.equal(extractToken({ "sec-websocket-protocol": "json, token.ws-secret" }), "ws-secret");
  assert.equal(extractToken({}), "");
});

test("authorization allows explicit token or local auto-derived browser access", () => {
  assert.equal(isLoopbackAddress("127.0.0.1"), true);
  assert.equal(isLoopbackAddress("10.0.0.1"), false);

  assert.equal(
    isAuthorized({ authorization: "Bearer secret-token" }, "203.0.113.10", fixedConfig),
    true,
  );
  assert.equal(isAuthorized({}, "127.0.0.1", fixedConfig), false);

  const autoDerivedConfig: ApiAuthConfig = {
    bindHost: "127.0.0.1",
    apiToken: "derived-token",
    apiTokenRequired: true,
    apiTokenAutoDerived: true,
  };
  const browserHeaders = {
    host: "127.0.0.1:3456",
    origin: "http://127.0.0.1:3456",
  };

  assert.equal(isAuthorized(browserHeaders, "127.0.0.1", autoDerivedConfig), true);
  assert.equal(shouldPublicConfigRequireToken(browserHeaders, "127.0.0.1", autoDerivedConfig), false);
  assert.equal(shouldPublicConfigRequireToken({}, "127.0.0.1", fixedConfig), true);
});
