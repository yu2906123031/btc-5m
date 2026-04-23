# BTC 5m Dashboard

A local-first Polymarket BTC 5-minute trading dashboard with live market data, manual order entry, claim support, and strategy automation.

## Features

- Fast manual order entry for UP and DOWN markets
- Live market data from Polymarket, Chainlink, user activity, and Binance
- Full dashboard mode and low-data mode
- Strategy framework with five pluggable strategies
- Claim tracking for redeemable positions
- Backtest data collection toggle
- Local API protection with `APP_API_TOKEN`
- Live-trading readiness endpoint at `/api/readiness`

## Requirements

- Node.js 20+

## Install

```bash
npm install
```

## Configure

Create a local `.env` from the example:

```bash
cp .env.example .env
```

Required values:

- `POLYMARKET_PRIVATE_KEY`
- `POLYMARKET_PROXY_ADDRESS`

Important switches:

- `LIVE_TRADING_ENABLED=true` enables real orders and claim transactions
- `APP_API_TOKEN=auto` derives a stable local API token from the private key
- `APP_MODE=full` enables the web UI

Strategy defaults can be controlled with:

- `STRATEGY_S1_ENABLED` to `STRATEGY_S5_ENABLED`
- `STRATEGY_S1_AMOUNT` to `STRATEGY_S5_AMOUNT`
- `ORDER_DEFAULT_SLIPPAGE`
- `AUTO_CLAIM_ENABLED`

## Run

```bash
npm start
```

Open:

- `http://127.0.0.1:3456`

## Validate

Run tests:

```bash
npm test
```

Run TypeScript checks:

```bash
npm run check
```

## Replay Strategies

Replay captured backtest ticks against one or more strategies:

```bash
npm run replay:strategy -- --file backtest-data/2026-04-15.jsonl --strategy s2
```

Replay all strategies and print trade details:

```bash
npm run replay:strategy -- --file backtest-data/2026-04-15.jsonl --strategy all --details
```

Notes:

- `--strategy` supports `all` or a comma-separated list such as `s1,s2,s5`
- `--amount` overrides the simulated entry size, default is `1`
- Captured ticks are stored under `backtest-data/`

## Main API

- `GET /api/public-config`
- `GET /api/state`
- `GET /api/readiness`
- `GET /api/strategy/descriptions`
- `POST /api/strategy/config`
- `POST /api/order`
- `POST /api/claim`
- `POST /api/backtest/toggle`

## Strategy Notes

- `s1`: Regular+
- `s2`: Regular
- `s3`: Sweep
- `s4`: Reversal
- `s5`: Probability Chase

Each strategy lives under `strategies/` and implements the shared `IStrategy` interface.

## Security Notes

- Keep the service bound to `127.0.0.1` unless you know exactly why you need remote access.
- Do not expose the local trading API directly to the public internet.
- Do not share `.env` or any file containing private keys or derived API credentials.
- Start with very small amounts before increasing risk.

## Sensitive Files

Do not publish these files:

- `.env`
- `.trade-history.json`
- `.strategy-config.json`

## Status

The current codebase supports live-trading readiness checks, auto-derived local API token support, and a conservative default strategy configuration.

