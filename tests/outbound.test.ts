import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";

import {
  describeOutboundError,
  isLoopbackHostname,
  isLoopbackProxyUrl,
  probeLoopbackProxyAvailability,
  shouldBypassProxyAfterError,
} from "../outbound.js";

test("loopback proxy helpers detect localhost, 127.x, and IPv6 loopback", () => {
  assert.equal(isLoopbackHostname("localhost"), true);
  assert.equal(isLoopbackHostname("127.0.0.1"), true);
  assert.equal(isLoopbackHostname("[::1]"), true);
  assert.equal(isLoopbackHostname("10.0.0.8"), false);

  assert.equal(isLoopbackProxyUrl("http://127.0.0.1:10809"), true);
  assert.equal(isLoopbackProxyUrl("http://localhost:7890"), true);
  assert.equal(isLoopbackProxyUrl("http://[::1]:9090"), true);
  assert.equal(isLoopbackProxyUrl("http://10.0.0.8:8080"), false);
  assert.equal(isLoopbackProxyUrl("not-a-url"), false);
});

test("proxy bypass detection only triggers for transport-style failures", () => {
  assert.equal(shouldBypassProxyAfterError(new Error("connect ECONNREFUSED 127.0.0.1:10809")), true);
  assert.equal(shouldBypassProxyAfterError(new Error("fetch failed")), true);
  assert.equal(shouldBypassProxyAfterError(new Error("socket hang up")), true);
  assert.equal(shouldBypassProxyAfterError(new Error("Request failed with status code 404")), false);
  assert.equal(shouldBypassProxyAfterError(new Error("Unauthorized")), false);
});

test("describeOutboundError includes nested causes", () => {
  const root = new Error("connect ECONNREFUSED 127.0.0.1:10809");
  const wrapped = new Error("fetch failed", { cause: root });
  assert.equal(describeOutboundError(wrapped), "fetch failed | connect ECONNREFUSED 127.0.0.1:10809");
});

test("probeLoopbackProxyAvailability detects live and dead local proxy ports", async () => {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", (error?: Error) => {
      if (error) reject(error);
      else resolve();
    });
  });

  const address = server.address();
  assert.notEqual(address, null);
  assert.equal(typeof address, "object");
  if (!address || typeof address !== "object") throw new Error("missing test address");

  const proxyUrl = `http://127.0.0.1:${address.port}`;
  assert.equal(await probeLoopbackProxyAvailability(proxyUrl, 150), true);

  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });

  assert.equal(await probeLoopbackProxyAvailability(proxyUrl, 150), false);
});
