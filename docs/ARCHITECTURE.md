# Trading OS Architecture

## Goal

Create a fully automated but observable trading operating system for the selected NSE ROC12 strategy.

The user should not need to click for every entry/exit. The human-in-the-loop role is monitoring:

- what the system is holding,
- what it plans to enter/exit,
- current PnL,
- current drawdown,
- PDD state,
- regime state,
- order/fill status,
- alerts and failures.

## Hosting model

### Development

Run locally from:

```text
D:\Codex_Scanner\trading_os
```

All writable state should stay on D drive:

```text
D:\Codex_Scanner\trading_os\data
D:\Codex_Scanner\trading_os\logs
```

### Production

Production should not depend on a laptop/desktop staying on.

Recommended production path:

1. GitHub private repository for source code.
2. AWS Lightsail or similar VPS for the always-on runtime.
3. Static IP for Dhan order API whitelisting.
4. PostgreSQL or SQLite initially; PostgreSQL later if multi-process/cloud scaling is needed.
5. Mobile-friendly dashboard/PWA exposed securely.
6. Alerts through Telegram/email/push.

## Runtime modes

### paper

Uses live/reference data and virtual orders only.

No Dhan order placement.

### readonly

Reads Dhan holdings, funds, order book, trade book, and market data.

No Dhan order placement.

### live

Places real Dhan orders only if:

- `TRADING_OS_MODE=live`
- `AUTO_EXECUTION_ENABLED=true`
- Dhan credentials are present
- static IP / account authorization prerequisites are solved
- all risk checks pass

## Core services

### Strategy engine

Single source of truth for:

- ROC(12) ranking,
- top 8 target,
- top 13 hold buffer,
- liquidity/recent momentum/extreme ROC filters,
- NIFTYBEES 30-week SMA regime,
- broad NSE EQ 30-week breadth 35/50 hysteresis,
- PDD 16/7 logic,
- GOLDBEES defensive sleeve,
- slot-based compounding.

Execution timing:

- Dhan EOD scanner refreshes daily/weekday.
- Paper rebalance checks daily/weekday.
- Simulated trades execute only on the first trading day of the scanner's
  execution month unless explicitly forced for testing.
- The guard is enforced in both the API and the scheduled script.
- Holiday handling uses `config\nse_holidays.json`, refreshed from NSE's
  holiday-master API by `scripts\sync_nse_holidays.ps1` and during the daily
  Dhan read-only sync.

### Data engine

Responsible for:

- instrument master,
- daily candles,
- weekly candles,
- monthly candles,
- adjusted prices,
- turnover,
- live/latest prices,
- stale data checks.

Current implementation:

- Dhan NSE EQ instrument master ingestion is stored locally in SQLite.
- Dhan historical daily candles are stored locally in SQLite.
- `/api/scanner/run` performs a read-only EOD sync and scan.
- `/api/scanner/latest` returns the last scanner run.
- Scanner results include explicit coverage diagnostics, so partial backfills
  are not treated as production-ready full-universe scans.
- Dhan HTTP 429 rate-limit responses are retried with backoff.
- Dhan "no data present" responses are treated as no-new-data when prior local
  candles already exist.

### Portfolio engine

Responsible for:

- current holdings,
- sleeve state,
- cash,
- current equity,
- equity peak,
- current drawdown,
- PDD stress flag,
- target portfolio,
- diff between current and target.

Current implementation:

- `/api/reconciliation` produces a read-only target-vs-actual plan.
- `/api/paper/portfolio` exposes the local front-test portfolio.
- `/api/paper/order-plan` exposes the next paper-mode diff.
- `/api/paper/rebalance` executes only local simulated orders.
- Dhan holdings/funds/orders/trades are read through the guarded Dhan adapter
  when app-side credentials are valid.
- Dhan token manager can renew active tokens and optionally generate fresh
  tokens from locally configured PIN/TOTP credentials.
- If Dhan scanner data is available, the paper engine uses it for ranks/regime.
  If no scanner run is available, the paper engine falls back to reference CSV
  ranks/regime.
- Dhan read-only reconciliation remains separate from the paper signal source
  and explains any authentication/data issue.

### Broker adapters

Broker interface should support:

- holdings,
- funds,
- order book,
- trade book,
- place order,
- cancel order,
- reconcile fills.

Current adapters:

- Paper broker: persistent local virtual portfolio with whole-share simulated
  orders, 0.50% slippage, residual cash, and compounding.
- Dhan broker: read-only REST adapter for holdings, positions, funds,
  order book, trade book, instrument master, and daily candles. Order
  placement remains blocked.

### Dashboard

Mission-control UI:

- portfolio value,
- drawdown,
- PDD state,
- regime state,
- target sleeves,
- ROC ranks,
- pending plan,
- alerts,
- audit events.

## Execution safety

The live engine must stop instead of trade when:

- Dhan token/client ID missing,
- stale candles,
- security ID mismatch,
- duplicate symbols,
- holdings mismatch,
- cash mismatch,
- order rejection,
- GOLDBEES unavailable,
- PDD/equity peak state missing,
- unexpected open orders exist,
- delivery sell authorization is not available.

## Current rollout status

1. Local paper dashboard. DONE
2. Dhan read-only connector. DONE
3. Paper broker using reference ranks/regime. DONE
4. Dhan EOD scanner and local candle store. DONE
5. Full-universe historical backfill. DONE
6. Paper broker using live Dhan scanner output. DONE
7. Add scheduled daily scanner refresh. DONE
8. Add monthly rebalance guard. DONE
9. Add official NSE holiday calendar sync. DONE
10. Add front-testing observability dashboard. DONE
11. Add active notification delivery. DONE
12. Cloud deployment.
13. Read-only reconciliation against actual Dhan holdings.
14. Tiny-capital live test.
15. Full automated live mode.

## Original rollout notes

1. Local paper dashboard.
2. Dhan read-only connector. ✅
3. Paper broker using reference ranks/regime. âœ…
4. Paper broker using live Dhan prices.
5. Cloud deployment.
6. Read-only reconciliation against actual Dhan holdings.
7. Tiny-capital live test.
8. Full automated live mode.
