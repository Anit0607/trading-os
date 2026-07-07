# Trading OS Operations Runbook

This runbook is for paper-trading/front-testing operations only. Live order
execution remains disabled unless a later live phase explicitly changes that.

## Daily startup

```powershell
cd D:\Codex_Scanner\trading_os
.\scripts\start_trading_os.ps1
.\scripts\preflight_paper_trading.ps1
```

Open the app:

```text
http://127.0.0.1:8765
```

Expected preflight result:

- `READY`, or
- `READY_WITH_WARNINGS` when the warning is understood, for example monthly
  rebalance is blocked because it is not the first trading day.

Do not rely on the dashboard if preflight returns `BLOCKED`.

## Front-testing workflow

1. Start Trading OS.
2. Run paper preflight.
3. Open Dashboard and confirm portfolio value/P&L is visible.
4. Open Settings and confirm:
   - Environment = `PAPER`,
   - Order Safety = `BLOCKED`,
   - Dhan Token = `READY`,
   - Schedulers = `3/3`.
5. Open Actions before any monthly rebalance day and review planned orders.
6. Open Reports after a scanner/rebalance cycle and review audit evidence.
7. Open Alerts to confirm Telegram/app delivery.

## Monthly rebalance day

The strategy rebalances monthly on the first trading day of the execution
month. The app gate blocks duplicate monthly execution after completion.

On rebalance morning:

```powershell
cd D:\Codex_Scanner\trading_os
.\scripts\preflight_paper_trading.ps1
```

Then open:

```text
http://127.0.0.1:8765/#actions
```

For paper mode, use only the paper workflow. Do not enable live execution.

## Backup

Create a safe local backup that excludes `.env`, Dhan token state, and broker
cache by default:

```powershell
cd D:\Codex_Scanner\trading_os
.\scripts\backup_trading_os.ps1
```

Only use `-IncludeSecrets` if the backup location is private and encrypted:

```powershell
.\scripts\backup_trading_os.ps1 -IncludeSecrets
```

## Health commands

```powershell
.\scripts\status_trading_os.ps1
.\scripts\stop_trading_os.ps1
```

Read-only endpoints:

```text
/api/health
/api/readiness
/api/rebalance/dry-run
/api/audit?limit=60
```

## Safety line

The current production rule is simple: if the system is not paper-safe, stop.
No script in this runbook places live Dhan orders.
