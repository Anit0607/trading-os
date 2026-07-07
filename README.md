# Trading OS

This is the first safe build of the automated NSE ROC12 Trading OS.

It is intentionally started in `paper` mode:

- no real Dhan orders,
- no accidental live execution,
- all writable state on `D:\Codex_Scanner\trading_os`,
- dashboard available locally,
- Dhan read-only endpoints available locally when credentials are present,
- strategy rules stored in `config/strategy.json`.

## Current strategy

`NSE ROC12 Strategy 4 + PDD 16/7 + Gold`

- monthly ROC(12) ranking,
- target top 8 stocks,
- retain while rank <= 13,
- NSE EQ universe,
- 3M average traded value >= INR 1 crore,
- previous completed month return >= 0,
- ROC(12) <= +500%,
- NIFTYBEES 30-week SMA regime filter,
- broad NSE EQ 30-week breadth 35/50 hysteresis,
- PDD = Portfolio Drawdown,
- if PDD reaches 16%, reduce to 7 stock sleeves + 1 GOLDBEES sleeve,
- restore normal 8 stock sleeves when PDD recovers to 7% or lower.

## Run locally

From PowerShell:

```powershell
cd D:\Codex_Scanner\trading_os
.\scripts\start_trading_os.ps1
```

Then open:

```text
http://127.0.0.1:8765
```

Optional helpers:

```powershell
.\scripts\start_trading_os.ps1 -OpenBrowser
.\scripts\status_trading_os.ps1
.\scripts\stop_trading_os.ps1
.\scripts\preflight_paper_trading.ps1
.\scripts\backup_trading_os.ps1
```

The start script uses the bundled Codex Python automatically when it is
available, starts the server in the background, waits for readiness, and writes
server logs to:

```text
D:\Codex_Scanner\trading_os\logs
```

## Project structure

```text
D:\Codex_Scanner\trading_os
  app\
    auth\dhan_token.py      Dhan app-side token manager
    main.py                 local web server and API
    config.py               env/config loading
    storage.py              SQLite state store
    data\reference_loader.py backtest/reference-data reader
    broker\paper.py         persistent paper broker / virtual portfolio
    broker\dhan.py          guarded Dhan read-only adapter
    strategy\engine.py      target portfolio decision engine
    static\                 dashboard UI
  config\strategy.json      trading rules
  data\                     SQLite DB and runtime state
  logs\                     runtime logs
  scripts\                  helper scripts
  docs\                     architecture notes and dashboard concept
```

See `docs\ARCHITECTURE.md` for the full Trading OS rollout plan.
See `docs\OPERATIONS_RUNBOOK.md` for the daily paper-trading runbook.
See `docs\CLOUD_MIRROR_DEPLOYMENT.md` for the zero-cost GitHub + Vercel + Neon mirror setup.

## Live trading safety

Live orders are disabled by design. We will only enable them after:

1. dashboard and paper broker are stable,
2. Dhan read-only reconciliation is working,
3. Dhan static IP/authorization requirements are solved,
4. delivery sell authorization flow is confirmed,
5. tiny-capital live test passes.

## Paper-trading preflight and backup

Before daily front-testing, run:

```powershell
cd D:\Codex_Scanner\trading_os
.\scripts\preflight_paper_trading.ps1
```

It checks:

- local app readiness and paper-safe mode,
- Dhan token availability,
- broker cache availability/freshness,
- latest scanner data,
- paper order plan,
- dry-run status,
- scheduled tasks,
- alert pipeline configuration.

Reports are written to:

```text
D:\Codex_Scanner\trading_os\logs\preflight
```

Create a safe local backup:

```powershell
.\scripts\backup_trading_os.ps1
```

By default, backup excludes `.env`, Dhan token state, and Dhan broker cache.
Use `-IncludeSecrets` only for a private encrypted backup location.

## Dhan read-only integration

The app reads `DHAN_ACCESS_TOKEN` and `DHAN_CLIENT_ID` from either:

```text
D:\Codex_Scanner\trading_os\.env
D:\Codex_Scanner\.env
```

Local read-only endpoints:

```text
/api/dhan/token/status
/api/dhan/broker-snapshot
/api/dhan/broker-snapshot/refresh  (POST)
/api/dhan/status
/api/dhan/holdings
/api/dhan/positions
/api/dhan/funds
/api/dhan/orders
/api/dhan/trades
/api/dhan/instruments/nse-eq?symbol=RELIANCE
/api/dhan/history/daily?securityId=2885&from=2025-01-01&to=2025-12-31
/api/reconciliation
/api/rebalance/dry-run
/api/rebalance/dry-run/notify  (POST, sends configured alerts)
/api/live-prices?symbol=GOLDBEES
/api/paper/portfolio
/api/paper/order-plan
/api/scanner/latest
/api/scanner/instruments
/api/scanner/candles?symbol=RELIANCE,NIFTYBEES
/api/market/holidays
/api/system/tasks
/api/readiness
```

Token refresh check:

```powershell
cd D:\Codex_Scanner\trading_os
.\scripts\refresh_dhan_token.ps1
```

Install the daily read-only sync task, defaulting to 08:30 local time:

```powershell
cd D:\Codex_Scanner\trading_os
.\scripts\install_daily_sync_task.ps1
```

Run the sync manually:

```powershell
.\scripts\daily_dhan_sync.ps1
```

The sync writes logs to `D:\Codex_Scanner\trading_os\logs` and writes the
latest sanitized status to:

```text
D:\Codex_Scanner\trading_os\data\dhan\last_daily_sync.json
```

It also refreshes the cached broker snapshot used by the dashboard and
reconciliation screens:

```text
D:\Codex_Scanner\trading_os\data\dhan\latest_broker_snapshot.json
```

The dashboard reads this local cache by default. Dhan is contacted only by the
daily sync or the **Refresh Broker Snapshot** button on the Portfolio
Reconciliation screen.

The same daily sync also refreshes the NSE Capital Market holiday cache from
NSE's holiday-master API. The local cache is:

```text
D:\Codex_Scanner\trading_os\config\nse_holidays.json
```

Manual holiday refresh:

```powershell
cd D:\Codex_Scanner\trading_os
.\scripts\sync_nse_holidays.ps1
```

Sanitized connectivity check:

```powershell
cd D:\Codex_Scanner\trading_os
.\scripts\check_dhan_readonly.ps1
```

Order placement is still intentionally not implemented. `TRADING_OS_MODE=paper`
and `AUTO_EXECUTION_ENABLED=false` remain the safe defaults.

Open `http://127.0.0.1:8765/#portfolio` or click **Portfolio** / **Holdings**
in the sidebar to view the Portfolio Reconciliation screen.

`/api/reconciliation` performs a read-only three-way comparison:

- Strategy 4 target/retain list,
- local paper portfolio used for front-test P&L,
- cached Dhan broker holdings/funds from the latest broker snapshot.

It returns broker-vs-paper gaps, broker-vs-strategy gaps, paper-vs-strategy
gaps, quantity mismatches, and planned entries/exits as read-only guidance only.
It never places, modifies, or cancels orders.

## Paper trading engine

The app now has a persistent local paper portfolio stored in:

```text
D:\Codex_Scanner\trading_os\data\trading_os.db
```

Paper mode can:

- calculate the current Strategy 4 target sleeves,
- apply the Top 8 / Hold Top 13 retain rule,
- apply the market-regime defensive switch,
- apply the PDD 16% / 7% state from paper equity,
- simulate 0.50% slippage,
- buy whole shares only,
- keep residual cash,
- compound through the local virtual portfolio,
- write simulated orders only.

The dashboard also includes an Operations Status panel for front-testing:

- next monthly rebalance date,
- latest scanner run and coverage,
- NSE holiday-cache status,
- Dhan read-only/token sync status,
- latest paper rebalance cycle result.

## Strategy Control Panel

Open `http://127.0.0.1:8765/#strategy` or click **Strategy** in the sidebar to
view the Strategy Control Panel.

It is a paper-safe command center for:

- Dhan token source, expiry, TOTP readiness, and read-only guard status,
- Dhan broker read-only endpoint health,
- cached broker snapshot freshness with a 24-hour threshold,
- latest Dhan EOD scanner run, coverage, failures, regime, and top ranks,
- monthly paper-rebalance gate and current target/order-plan summary,
- Windows Task Scheduler status for the daily sync, EOD scanner, and paper
  rebalance tasks,
- local guardrails confirming paper mode and blocked live orders.

Safe controls on the panel:

- **Refresh Control Data** only reads current status,
- **Validate Token** performs read-only token validation,
- **Refresh Token** renews the managed Dhan token using local automation,
- **Sync NSE Holidays** refreshes the local NSE holiday file,
- **Run Paper Rebalance** remains disabled unless the monthly first-trading-day
  gate allows it.

## Settings Control Room

Open `http://127.0.0.1:8765/#settings` or click **Settings** in the sidebar to
view runtime readiness in one place:

- paper/live execution mode and read-only order guard,
- Dhan token source, managed-token expiry, TOTP readiness, and broker-cache
  freshness,
- Telegram/app alert configuration and recent delivery status,
- Windows scheduled task installation status,
- important local runtime paths.

Local readiness endpoint:

```text
/api/readiness
```

This endpoint is intentionally read-only and is used by
`scripts\start_trading_os.ps1` and `scripts\status_trading_os.ps1`.

## Monthly action plan

Open `http://127.0.0.1:8765/#actions` or click **Actions** in the sidebar to
view the monthly rebalance action plan.

This is a read-only pre-flight checklist for the Strategy 4 monthly rebalance.
It does not place live, paper, or broker orders. It shows:

- paper-mode and blocked-live-order guardrails,
- live Dhan LTP overlay for paper portfolio P&L, with EOD/scanner fallback,
- rebalance gate status for the current first-trading-day rule,
- latest scanner run, target symbols, retain symbols, market regime, and PDD
  state,
- Dhan broker snapshot cache status and age, using the 24-hour freshness rule,
- current paper portfolio equity/cash and planned order count,
- broker-vs-paper reconciliation gaps and notes.

Safe controls on the screen:

- **Refresh Dry Run** reloads `/api/rebalance/dry-run`,
- **Send Telegram Report** posts `/api/rebalance/dry-run/notify` and sends the
  report through the configured notification channels,
- **Open Audit Trail** opens the deeper audit screen.

## Reports and audit trail

Open `http://127.0.0.1:8765/#reports` or click **Reports** in the sidebar to
view the Reports & Audit Trail screen.

This screen is meant for front-testing evidence. It combines:

- latest scanner run, coverage, regime, failure count, and rebalance gate,
- current paper portfolio equity, cash, drawdown, target sleeves, and retained
  sleeves,
- recent paper orders and latest simulated portfolio snapshot,
- Windows Task Scheduler install/status evidence,
- recent strategy events and notification delivery history,
- one timeline that joins scanner, rebalance, order, and alert activity.

Local audit endpoint:

```text
/api/audit?limit=60
```

## Notifications and alerts

Trading OS now records an in-app notification history in the local SQLite DB and
can optionally deliver the same alerts to Telegram.

Open `http://127.0.0.1:8765/#notifications` or click **Logs** / **Alerts** in
the sidebar to view the Notification Center. It shows delivery counts, the
latest alert timestamp, app/Telegram status, and filterable alert history for
scanner, Dhan sync, rebalance, failed, warning, and Telegram messages.

Local endpoints:

```text
/api/notifications/status
/api/notifications?limit=50
/api/notifications/test
```

Default behavior is safe:

- app/local notification history is enabled,
- Telegram is disabled,
- no external message is sent unless Telegram is explicitly configured.

Optional Telegram settings in `.env`:

```text
ALERTS_APP_ENABLED=true
ALERTS_TELEGRAM_ENABLED=false
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
```

Alerts are emitted by:

- daily Dhan read-only sync,
- Dhan EOD scanner run,
- paper rebalance execution or skip.

The Notification Center includes a **Send Test Telegram Alert** button. It calls
`/api/notifications/test`, records both app and Telegram rows, and is useful
after changing `.env` alert settings.

Manual paper rebalance:

```powershell
cd D:\Codex_Scanner\trading_os
.\scripts\run_paper_rebalance.ps1
```

Paper rebalance execution is guarded:

- the scanner may update every weekday,
- the paper rebalance script may check every weekday,
- simulated trades execute only on the first trading day of the scanner's
  execution month,
- NSE holidays are read from `config\nse_holidays.json`,
- later daily checks are skipped automatically,
- use `-ForceRebalance` only for controlled testing.

Force a paper rebalance test:

```powershell
.\scripts\run_paper_rebalance.ps1 -ForceRebalance
```

Install the automatic weekday paper scanner/rebalance task:

```powershell
cd D:\Codex_Scanner\trading_os
.\scripts\install_paper_rebalance_task.ps1
```

The installed task is:

```text
TradingOS_Paper_Rebalance
```

Default schedule:

```text
Weekdays at 09:35
```

The paper rebalance writes logs to `D:\Codex_Scanner\trading_os\logs` and the
latest sanitized summary to:

```text
D:\Codex_Scanner\trading_os\data\paper\last_paper_rebalance.json
```

Current behavior: the dashboard uses the paper portfolio for holdings/P&L,
uses the latest Dhan scanner run for ROC ranks/regime when available, and keeps
Dhan read-only reconciliation as a separate safety/status signal. Live broker
order placement remains blocked.

## Dhan EOD scanner

The app now has a read-only Dhan EOD scanner layer.

It stores local market data in:

```text
D:\Codex_Scanner\trading_os\data\trading_os.db
```

Scanner tables include:

- NSE EQ instrument master,
- daily OHLCV candles,
- scanner runs,
- scanner rankings,
- scanner regime snapshots.

The scanner currently calculates:

- monthly close,
- ROC(12),
- 1-month return filter,
- 3-month average traded value filter,
- max ROC cap,
- Top ROC rankings,
- NIFTYBEES 30-week SMA state,
- GOLDBEES 20-week SMA state,
- broad NSE EQ breadth above 30-week SMA,
- 35% / 50% breadth hysteresis state.

Run a small scanner validation batch:

```powershell
cd D:\Codex_Scanner\trading_os
.\scripts\run_dhan_scanner.ps1 -Symbols 'RELIANCE,TCS,INFY,HDFCBANK,ICICIBANK,SBIN'
```

Run a full-universe backfill/scan:

```powershell
cd D:\Codex_Scanner\trading_os
.\scripts\run_dhan_scanner.ps1 -FullUniverse
```

Install the automatic weekday Dhan scanner refresh:

```powershell
cd D:\Codex_Scanner\trading_os
.\scripts\install_daily_scanner_task.ps1
```

The installed task is:

```text
TradingOS_Dhan_EOD_Scanner
```

Default schedule:

```text
Weekdays at 08:40
```

Daily automation order:

```text
08:30  TradingOS_Dhan_Daily_Readonly_Sync
08:40  TradingOS_Dhan_EOD_Scanner
09:35  TradingOS_Paper_Rebalance checks monthly guard
```

The monthly strategy rule is:

```text
Rebalance only on the first trading day of the month.
Use the latest completed monthly candle for ROC(12).
Hold existing stocks while they remain in Top 13.
Enter new names only from Top 8.
```

The scanner is deliberately rate-limit aware. The default pause is 1 second per
historical candle request with retries for HTTP 429 rate-limit responses.

The scanner writes logs to:

```text
D:\Codex_Scanner\trading_os\logs\dhan_scanner_YYYYMMDD.log
```

and writes the latest sanitized scanner summary to:

```text
D:\Codex_Scanner\trading_os\data\scanner\last_scanner_run.json
```

Important: scanner output is now the paper engine's preferred signal source.
Reference CSV rankings/regime are used only as fallback when no scanner run is
available. The dashboard displays scanner coverage and status so partial
coverage is visible before any paper or live action.

## Dhan token manager

The local web app now has a guarded Dhan token manager:

- validates token health through `/api/dhan/token/status?validate=true`,
- renews an active token through `/api/dhan/token/refresh`,
- stores a managed token at `D:\Codex_Scanner\trading_os\data\dhan\token_state.json`,
- never prints token values,
- optionally supports fresh-token generation if you configure `DHAN_PIN` and
  `DHAN_TOTP_SECRET` locally.

No extra action is required from you unless you want full unattended token
generation. For that, you would need to add `DHAN_PIN` and `DHAN_TOTP_SECRET`
to your local `.env`; do not share them in chat.

Note: Dhan MCP authentication inside a separate Codex CLI session does not
automatically give this local web app a broker token. The app-side Dhan REST
adapter uses the managed token first, then falls back to `DHAN_ACCESS_TOKEN`
from `.env`.
