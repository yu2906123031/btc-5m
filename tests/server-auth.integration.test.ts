import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomInt } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket } from "ws";

const cwd = process.cwd();
const serverEntry = "server.ts";

function getPort(): number {
  return randomInt(36000, 49000);
}

async function waitForServer(baseUrl: string, child: ChildProcessWithoutNullStreams): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode != null) {
      throw new Error(`server exited early with code ${child.exitCode}`);
    }
    try {
      const response = await fetch(`${baseUrl}/`);
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw new Error(`server did not start in time: ${String(lastError)}`);
}

async function stopServer(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode != null) return;
  child.kill("SIGINT");
  await Promise.race([
    once(child, "exit"),
    delay(5000).then(() => {
      child.kill("SIGKILL");
    }),
  ]);
}

async function startServer(
  env: Record<string, string | undefined>,
  options: { appMode?: "full" | "headless" } = {},
) {
  const port = getPort();
  const child = spawn(process.execPath, ["--import", "tsx", serverEntry], {
    cwd,
    env: {
      ...process.env,
      APP_MODE: options.appMode || "headless",
      APP_BIND_HOST: "127.0.0.1",
      APP_PORT: String(port),
      APP_DISABLE_EXTERNAL_IO: "true",
      LIVE_TRADING_ENABLED: "false",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForServer(baseUrl, child);

  return {
    child,
    baseUrl,
    wsUrl: `ws://127.0.0.1:${port}`,
    getLogs: () => ({ stdout, stderr }),
  };
}

test("fixed APP_API_TOKEN protects API routes and unsafe origins", async (t) => {
  const server = await startServer({
    APP_API_TOKEN: "integration-secret",
    POLYMARKET_PRIVATE_KEY: "",
  }, { appMode: "full" });
  t.after(async () => {
    await stopServer(server.child);
  });

  const publicConfigRes = await fetch(`${server.baseUrl}/api/public-config`);
  assert.equal(publicConfigRes.status, 200);
  assert.deepEqual(await publicConfigRes.json(), {
    tokenRequired: true,
    bindHost: "127.0.0.1",
    liveTradingEnabled: false,
  });

  const unauthorizedRes = await fetch(`${server.baseUrl}/api/readiness`);
  assert.equal(unauthorizedRes.status, 401);

  const authorizedRes = await fetch(`${server.baseUrl}/api/readiness`, {
    headers: {
      Authorization: "Bearer integration-secret",
    },
  });
  assert.equal(authorizedRes.status, 503);

  const badOriginRes = await fetch(`${server.baseUrl}/api/backtest/toggle`, {
    method: "POST",
    headers: {
      Authorization: "Bearer integration-secret",
      Origin: "https://evil.example",
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  assert.equal(badOriginRes.status, 403);

  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(server.wsUrl);
    let sawMessage = false;
    ws.once("message", () => {
      sawMessage = true;
    });
    ws.once("close", (code, reason) => {
      try {
        assert.equal(sawMessage, false);
        assert.equal(code === 1006 || code === 1008, true);
        if (code === 1008) {
          assert.equal(reason.toString(), "unauthorized");
        }
        resolve();
      } catch (error) {
        reject(error);
      }
    });
    ws.once("error", () => {
      // Some runtimes emit error before close for rejected handshakes.
    });
  });

  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(`${server.wsUrl}/?mode=low`, ["json", "token.integration-secret"], {
      headers: {
        Origin: server.baseUrl,
      },
    });
    let sawMessage = false;
    ws.once("message", () => {
      sawMessage = true;
      ws.close();
    });
    ws.once("close", (code) => {
      try {
        assert.equal(sawMessage, true);
        assert.equal(code === 1000 || code === 1005, true);
        resolve();
      } catch (error) {
        reject(error);
      }
    });
    ws.once("error", reject);
  });
});

test("auto-derived local browser access keeps public config token flag off", async (t) => {
  const privateKey = `0x${"11".repeat(32)}`;
  const server = await startServer({
    APP_API_TOKEN: "auto",
    POLYMARKET_PRIVATE_KEY: privateKey,
  });
  t.after(async () => {
    await stopServer(server.child);
  });

  const publicConfigRes = await fetch(`${server.baseUrl}/api/public-config`, {
    headers: {
      Origin: server.baseUrl,
    },
  });
  assert.equal(publicConfigRes.status, 200);
  assert.deepEqual(await publicConfigRes.json(), {
    tokenRequired: false,
    bindHost: "127.0.0.1",
    liveTradingEnabled: false,
  });

  const readinessRes = await fetch(`${server.baseUrl}/api/readiness`, {
    headers: {
      Origin: server.baseUrl,
    },
  });
  assert.equal(readinessRes.status, 503);

  const { stderr } = server.getLogs();
  assert.equal(stderr.includes("POLYMARKET_PRIVATE_KEY invalid"), false);
});
