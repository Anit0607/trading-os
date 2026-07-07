# Trading OS Cloud Mirror Deployment

This phase keeps the trading engine local and uses free cloud services only for the dashboard mirror.

```text
Local D-drive worker → Neon Free Postgres → Vercel Hobby dashboard
GitHub private repo  → Vercel auto-deploy
```

## Local environment

Add these to `D:\Codex_Scanner\trading_os\.env` only after you create the Neon database:

```env
DATABASE_URL=postgresql://...
TRADING_OS_SYNC_TO_NEON=true
TRADING_OS_CLOUD_READONLY=false
TRADING_OS_WORKER_ID=local-d-drive-worker
TRADING_OS_CLOUD_STALE_AFTER_MINUTES=180
```

Keep Dhan and Telegram secrets only in `.env`; never commit them.

## Vercel environment

In Vercel Project Settings → Environment Variables:

```env
DATABASE_URL=postgresql://...
TRADING_OS_CLOUD_READONLY=true
TRADING_OS_SYNC_TO_NEON=false
TRADING_OS_WORKER_ID=local-d-drive-worker
TRADING_OS_CLOUD_STALE_AFTER_MINUTES=180
```

Do not add Dhan credentials to Vercel in this phase. Vercel is read-only and reads Neon only.

## Local sync commands

Manual sync:

```powershell
cd D:\Codex_Scanner\trading_os
.\scripts\sync_neon_mirror.ps1
```

Startup/catch-up worker:

```powershell
cd D:\Codex_Scanner\trading_os
.\scripts\startup_cloud_worker.ps1
```

Install auto-start at Windows login:

```powershell
cd D:\Codex_Scanner\trading_os
.\scripts\install_startup_cloud_worker_task.ps1
```

## Safety rules

- Local worker remains paper/read-only.
- Vercel does not call Dhan.
- Vercel does not run scanner/rebalance.
- Heavy market cache stays local.
- Neon stores only lean reporting snapshots.
