from __future__ import annotations

from typing import Any

from ..config import AppConfig
from .neon import NeonClient, NeonSyncError, cloud_timestamp


def cloud_readiness(config: AppConfig) -> dict[str, Any]:
    client = NeonClient.from_config(config)
    status = client.status()
    checks = [
        {
            "name": "Cloud readonly mode",
            "ok": config.cloud_readonly,
            "detail": f"TRADING_OS_CLOUD_READONLY={config.cloud_readonly}",
        },
        {
            "name": "Neon DATABASE_URL",
            "ok": client.configured,
            "detail": "configured" if client.configured else status.get("reason") or "missing",
        },
        {
            "name": "Postgres driver",
            "ok": status.get("driver_available") is True,
            "detail": "psycopg available" if status.get("driver_available") else "install requirements.txt",
        },
        {
            "name": "Neon connection",
            "ok": status.get("ok") is True,
            "detail": str(status.get("server_time") or status.get("reason") or ""),
        },
    ]
    snapshot_ok = False
    heartbeat: dict[str, Any] = {}
    if status.get("ok"):
        try:
            latest = client.latest_dashboard_snapshot()
            snapshot_ok = bool(latest.get("ok"))
            heartbeat = client.latest_worker_heartbeat()
        except NeonSyncError as exc:
            status = {**status, "ok": False, "reason": str(exc)}
    checks.append(
        {
            "name": "Latest dashboard snapshot",
            "ok": snapshot_ok,
            "detail": "synced" if snapshot_ok else "waiting for local worker sync",
        }
    )
    return {
        "ok": all(check["ok"] for check in checks[:4]),
        "app": "Trading OS Cloud Dashboard",
        "mode": "cloud_readonly",
        "paper_safe": True,
        "auto_execution_enabled": False,
        "cloud": {
            "readonly": True,
            "neon": status,
            "worker": heartbeat,
        },
        "checks": checks,
    }


def cloud_dashboard(config: AppConfig) -> dict[str, Any]:
    client = NeonClient.from_config(config)
    try:
        latest = client.latest_dashboard_snapshot()
        if not latest.get("ok"):
            return _empty_cloud_dashboard(str(latest.get("reason") or "No synced dashboard snapshot yet."))
        snapshot = latest.get("snapshot")
        if not isinstance(snapshot, dict):
            return _empty_cloud_dashboard("Latest Neon dashboard snapshot is malformed.")
        heartbeat = client.latest_worker_heartbeat()
        alerts = client.recent_alerts(limit=20)
        return _decorate_snapshot(snapshot, latest=latest, heartbeat=heartbeat, alerts=alerts)
    except Exception as exc:  # pragma: no cover - depends on live Neon
        return _empty_cloud_dashboard(str(exc))


def _decorate_snapshot(
    snapshot: dict[str, Any],
    *,
    latest: dict[str, Any],
    heartbeat: dict[str, Any],
    alerts: list[dict[str, Any]],
) -> dict[str, Any]:
    decorated = dict(snapshot)
    ui = dict(decorated.get("ui") or {})
    top_bar = dict(ui.get("top_bar") or {})
    footer = dict(ui.get("footer") or {})
    cloud = {
        "readonly": True,
        "source": "neon_mirror",
        "snapshot_created_at": latest.get("created_at"),
        "worker": heartbeat,
        "generated_at": cloud_timestamp(),
    }
    stale = bool(heartbeat.get("stale")) or not heartbeat.get("ok")
    status_label = "Cloud mirror stale" if stale else "Cloud mirror live"
    top_bar["data_status"] = status_label
    top_bar["last_update"] = str(latest.get("created_at") or top_bar.get("last_update") or "--")
    footer["environment"] = "CLOUD READ-ONLY"
    footer["data_source"] = "Neon mirror · local worker"
    footer["auto_sync"] = not stale
    ui["top_bar"] = top_bar
    ui["footer"] = footer
    ui["mode_label"] = "CLOUD READ-ONLY"
    ui["cloud"] = cloud
    cloud_alerts = _cloud_alerts(stale=stale, heartbeat=heartbeat, latest=latest)
    decorated["alerts"] = cloud_alerts + list(decorated.get("alerts") or [])
    ui_notifications = list(ui.get("notifications") or [])
    ui["notifications"] = cloud_alerts + ui_notifications
    decorated["ui"] = ui
    decorated["cloud"] = cloud
    decorated["notifications"] = {
        "ok": True,
        "source": "neon_alerts",
        "notifications": alerts,
    }
    return decorated


def _cloud_alerts(*, stale: bool, heartbeat: dict[str, Any], latest: dict[str, Any]) -> list[dict[str, Any]]:
    if stale:
        return [
            {
                "level": "warning",
                "message": (
                    "Local backend worker is stale/offline. Dashboard is showing the last Neon snapshot from "
                    f"{latest.get('created_at') or '--'}."
                ),
                "time": "Cloud",
            }
        ]
    return [
        {
            "level": "ok",
            "message": f"Cloud mirror synced from local worker at {heartbeat.get('last_seen_at') or '--'}.",
            "time": "Cloud",
        }
    ]


def _empty_cloud_dashboard(reason: str) -> dict[str, Any]:
    return {
        "generated_at": cloud_timestamp(),
        "mode": "cloud_readonly",
        "cloud": {
            "readonly": True,
            "source": "neon_mirror",
            "error": reason,
            "generated_at": cloud_timestamp(),
        },
        "alerts": [
            {
                "level": "warning",
                "message": f"Cloud dashboard is waiting for local worker sync: {reason}",
                "time": "Cloud",
            }
        ],
        "ui": {
            "mode_label": "CLOUD READ-ONLY",
            "top_bar": {
                "system_health": "Cloud Read-Only",
                "data_status": "Waiting for Neon sync",
                "last_update": "--",
                "portfolio_value": None,
                "day_pnl": None,
                "total_pnl": None,
                "current_drawdown": None,
                "pdd_state": "--",
                "market_regime": "--",
            },
            "footer": {
                "environment": "CLOUD READ-ONLY",
                "data_source": "Neon mirror · waiting",
                "auto_sync": False,
            },
            "holdings": [],
            "pending_actions": {"entries": [], "exits": []},
            "notifications": [
                {
                    "level": "warning",
                    "message": f"Cloud dashboard is waiting for local worker sync: {reason}",
                    "time": "Cloud",
                }
            ],
        },
        "paper": {"portfolio": {"summary": {}, "holdings": []}},
    }
