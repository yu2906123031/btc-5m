# MEMORY

## Current Security State

- Server now binds to `127.0.0.1` by default and supports `APP_BIND_HOST`.
- API and WebSocket access are protected by local-only access by default, or `APP_API_TOKEN` when configured.
- Sensitive Polymarket API credentials are cached in memory only; `.polymarket-creds.json` should no longer be used as a runtime dependency.
- Trading and claim endpoints have simple in-memory rate limiting.
- Strategy initialization is explicit via `initStrategies()` and isolated with per-strategy `try/catch`.
- `buyLockUntil` now has a watchdog to prevent stale strategy lock states.
- Fatal process hooks now terminate on `unhandledRejection` and `uncaughtException`.

## Files Changed In This Audit

- `server.ts`
- `index.html`
- `strategies/registry.ts`
- `strategies/s1.ts`
- `.env.example`
- `.gitignore`
- `package.json`

## Important Config

- `APP_BIND_HOST=127.0.0.1`
- `APP_API_TOKEN=<random-long-secret>`
- `POLYMARKET_PRIVATE_KEY` must be a valid `0x` + 64 hex private key.

## Remaining Risks / Follow-up

- `runClaim()` still uses a custom Safe signing flow and should be reviewed carefully against the current ethers / Safe best practice before changing it.
- `index.html` has been partially hardened for XSS, but the file still contains a lot of legacy inline rendering and mojibake text; it needs a cleaner pass.
- No full compile/test run has been completed because the repo currently has no installed `node_modules`.
- `pendingTradeMeta` is still managed by ad hoc map operations; logical race handling can be improved further if order flow becomes more complex.

## Operational Notes

- Keep `.env`, runtime JSON files, and `backtest-data/` out of version control.
- If this project is moved off localhost, token auth alone is not sufficient; add a reverse proxy, TLS, and stronger operator auth.
- Before live trading, run a syntax/build check after installing dependencies and do a manual browser smoke test.
