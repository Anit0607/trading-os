from __future__ import annotations

import json
import mimetypes
import csv
import io
import subprocess
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from .auth.dhan_token import DhanTokenError, DhanTokenManager
from .broker.dhan import DhanAPIError, DhanBroker
from .broker.snapshot import BrokerSnapshotService
from .cloud.neon import NeonClient
from .config import get_config, load_strategy_config, safe_public_config
from .data.dhan_scanner import DhanEODScanner
from .data.live_prices import LivePriceService
from .data.nse_holidays import NSEHolidaySyncError, holiday_status, sync_holidays
from .data.reference_loader import ReferenceDataLoader
from .notifications import NotificationManager
from .portfolio.reconciliation import PortfolioReconciler
from .storage import StateStore
from .strategy.engine import StrategyEngine


def _json_bytes(payload: object) -> bytes:
    return json.dumps(payload, ensure_ascii=False, sort_keys=True).encode("utf-8")


APP_VERSION = "20260707-cloud-mirror"


def _vercel_notice_payload() -> dict[str, object]:
    return {
        "ok": True,
        "app": "Trading OS",
        "mode": "cloud_readonly_notice",
        "message": "app/main.py is the local worker entrypoint. Use /api/dashboard or /api/readiness on Vercel.",
    }


class VercelLocalWorkerNoticeHandler(BaseHTTPRequestHandler):
    """Safe Vercel fallback if the Python preset inspects app/main.py.

    The real cloud dashboard uses the read-only handlers in `/api`.
    This local worker server must not run scanner, Dhan, or rebalance work on Vercel.
    """

    def do_GET(self) -> None:  # noqa: N802 - required by BaseHTTPRequestHandler
        payload = _vercel_notice_payload()
        body = _json_bytes(payload)
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def application(environ: object, start_response: object) -> list[bytes]:
    """WSGI-style Vercel fallback for Python preset auto-detection."""
    body = _json_bytes(_vercel_notice_payload())
    start_response(  # type: ignore[operator]
        "200 OK",
        [
            ("Content-Type", "application/json; charset=utf-8"),
            ("Cache-Control", "no-store"),
            ("Content-Length", str(len(body))),
        ],
    )
    return [body]


app = application
handler = VercelLocalWorkerNoticeHandler


class TradingOSHandler(BaseHTTPRequestHandler):
    _config = None
    _store = None
    _engine = None
    _reference = None

    @property
    def config(self):
        if type(self)._config is None:
            type(self)._config = get_config()
        return type(self)._config

    @property
    def store(self):
        if type(self)._store is None:
            type(self)._store = StateStore(self.config.database_path)
        return type(self)._store

    @property
    def engine(self):
        if type(self)._engine is None:
            type(self)._engine = StrategyEngine(self.config)
        return type(self)._engine

    @property
    def reference(self):
        if type(self)._reference is None:
            type(self)._reference = ReferenceDataLoader(self.config.reference_results_dir)
        return type(self)._reference

    @property
    def static_root(self):
        return self.config.project_root / "app" / "static"

    def _dhan(self) -> DhanBroker:
        return DhanBroker.from_config(self.config)

    def _broker_snapshot(self) -> BrokerSnapshotService:
        return BrokerSnapshotService(self.config, self.store)

    def _reconciler(self) -> PortfolioReconciler:
        return PortfolioReconciler(self.config)

    def _token_manager(self) -> DhanTokenManager:
        return DhanTokenManager(self.config)

    def _scanner(self) -> DhanEODScanner:
        return DhanEODScanner(self.config)

    def _live_prices(self) -> LivePriceService:
        return LivePriceService(self.config)

    def _notifier(self) -> NotificationManager:
        return NotificationManager(self.config, self.store)

    def _cloud_client(self) -> NeonClient:
        return NeonClient.from_config(self.config)

    def _dashboard_payload(self, *, save_local: bool = True, sync_cloud: bool = False) -> dict[str, object]:
        snapshot = self.engine.dashboard_snapshot().to_dict()
        reconciliation = self._reconciler().snapshot(snapshot)
        snapshot["reconciliation"] = reconciliation
        self._reconciler().apply_to_dashboard_ui(snapshot, reconciliation)
        if save_local:
            self.store.save_dashboard_snapshot(snapshot)
        if sync_cloud:
            snapshot["cloud_sync"] = self._sync_cloud_bundle(reason="dashboard_refresh", snapshot=snapshot)
        return snapshot

    def _sync_cloud_bundle(
        self,
        *,
        reason: str,
        snapshot: dict[str, object] | None = None,
        scanner_result: dict[str, object] | None = None,
        rebalance_result: dict[str, object] | None = None,
        include_notifications: bool = True,
    ) -> dict[str, object]:
        client = self._cloud_client()
        if not self.config.sync_to_neon:
            return {"ok": False, "skipped": True, "reason": "TRADING_OS_SYNC_TO_NEON is false."}
        if not client.configured:
            return {"ok": False, "skipped": True, "reason": "DATABASE_URL is not configured."}
        if not client.driver_available:
            return {"ok": False, "skipped": True, "reason": "Python package psycopg is not installed."}
        try:
            payload = snapshot or self._dashboard_payload(save_local=True, sync_cloud=False)
            result: dict[str, object] = {
                "ok": True,
                "reason": reason,
                "schema": client.ensure_schema(),
                "heartbeat": client.push_worker_heartbeat(
                    status="online",
                    payload={"reason": reason, "mode": self.config.mode, "app_version": APP_VERSION},
                ),
                "dashboard": client.push_dashboard_snapshot(payload, source=reason),
            }
            scanner_payload = scanner_result or self._scanner().latest()
            if isinstance(scanner_payload, dict):
                result["scanner"] = client.push_scanner_run(scanner_payload)
            if isinstance(rebalance_result, dict):
                result["rebalance"] = client.push_rebalance_event(rebalance_result, event_type="paper_rebalance")
            if include_notifications:
                result["notifications"] = client.push_notifications(self.store.recent_notifications(100))
            self.store.record_event("ok", "cloud_sync", "Cloud mirror sync completed", result)
            return result
        except Exception as exc:
            result = {"ok": False, "error": str(exc), "reason": reason}
            self.store.record_event("warning", "cloud_sync_failed", "Cloud mirror sync failed", result)
            return result

    def _send_json(self, payload: object, status: int = 200) -> None:
        body = _json_bytes(payload)
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _send_file(self, path: Path) -> None:
        if not path.exists() or not path.is_file():
            self.send_error(404)
            return
        content_type = mimetypes.guess_type(str(path))[0] or "application/octet-stream"
        body = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802 - required by BaseHTTPRequestHandler
        parsed = urlparse(self.path)
        path = parsed.path
        query = parse_qs(parsed.query)
        try:
            if path == "/api/health":
                self._send_json(
                    {
                        "ok": True,
                        "app": "Trading OS",
                        "version": APP_VERSION,
                        "config": safe_public_config(self.config),
                    }
                )
                return
            if path == "/api/readiness":
                cfg = self.config
                strategy_exists = cfg.strategy_config_path.exists()
                database_parent_exists = cfg.database_path.parent.exists()
                static_index_exists = (self.static_root / "index.html").exists()
                token_state_exists = cfg.dhan_token_state_path.exists()
                paper_safe = cfg.mode == "paper" and not cfg.auto_execution_enabled
                checks = [
                    {
                        "name": "Paper mode",
                        "ok": cfg.mode == "paper",
                        "detail": f"TRADING_OS_MODE={cfg.mode}",
                    },
                    {
                        "name": "Live order guard",
                        "ok": not cfg.auto_execution_enabled,
                        "detail": f"AUTO_EXECUTION_ENABLED={cfg.auto_execution_enabled}",
                    },
                    {
                        "name": "Strategy config",
                        "ok": strategy_exists,
                        "detail": str(cfg.strategy_config_path),
                    },
                    {
                        "name": "State database path",
                        "ok": database_parent_exists,
                        "detail": str(cfg.database_path),
                    },
                    {
                        "name": "Static dashboard",
                        "ok": static_index_exists,
                        "detail": str(self.static_root / "index.html"),
                    },
                    {
                        "name": "Dhan credentials",
                        "ok": cfg.dhan_client_id_present and (cfg.dhan_access_token_present or token_state_exists),
                        "detail": "client_id present; managed token or env token required",
                    },
                    {
                        "name": "Telegram alerts",
                        "ok": (not cfg.alerts_telegram_enabled)
                        or (cfg.telegram_bot_token_present and cfg.telegram_chat_id_present),
                        "detail": "optional unless Telegram alerts are enabled",
                    },
                    {
                        "name": "Neon cloud mirror",
                        "ok": (not cfg.sync_to_neon) or (self._cloud_client().configured and self._cloud_client().driver_available),
                        "detail": (
                            "disabled"
                            if not cfg.sync_to_neon
                            else "DATABASE_URL present and psycopg available"
                            if self._cloud_client().configured and self._cloud_client().driver_available
                            else "TRADING_OS_SYNC_TO_NEON requires a Postgres DATABASE_URL and psycopg"
                        ),
                    },
                ]
                self._send_json(
                    {
                        "ok": all(check["ok"] for check in checks),
                        "app": "Trading OS",
                        "version": APP_VERSION,
                        "url": f"http://{cfg.host}:{cfg.port}/",
                        "paper_safe": paper_safe,
                        "mode": cfg.mode,
                        "auto_execution_enabled": cfg.auto_execution_enabled,
                        "checks": checks,
                    }
                )
                return
            if path == "/api/strategy":
                self._send_json(load_strategy_config(self.config))
                return
            if path == "/api/dashboard":
                self._send_json(self._dashboard_payload(save_local=True, sync_cloud=self.config.sync_to_neon))
                return
            if path == "/api/cloud/status":
                client = self._cloud_client()
                status = client.status()
                heartbeat = None
                latest = None
                if status.get("ok"):
                    try:
                        heartbeat = client.latest_worker_heartbeat()
                        latest = client.latest_dashboard_snapshot()
                    except Exception as exc:
                        status = {**status, "ok": False, "reason": str(exc)}
                self._send_json(
                    {
                        "ok": bool(status.get("ok")),
                        "enabled": self.config.sync_to_neon,
                        "status": status,
                        "heartbeat": heartbeat,
                        "latest_dashboard": latest,
                    }
                )
                return
            if path == "/api/equity":
                self._send_json(self.reference.equity())
                return
            if path == "/api/events":
                self._send_json({"events": self.store.recent_events(100)})
                return
            if path == "/api/audit":
                limit = _int_query_value(query, "limit", 60)
                self._send_json(
                    _audit_report(
                        config=self.config,
                        store=self.store,
                        engine=self.engine,
                        scanner=self._scanner(),
                        notifier=self._notifier(),
                        limit=limit,
                    )
                )
                return
            if path == "/api/notifications/status":
                self._send_json(self._notifier().status())
                return
            if path == "/api/notifications":
                limit = _int_query_value(query, "limit", 50)
                self._send_json(self._notifier().recent(limit=limit))
                return
            if path == "/api/order-plan":
                snapshot = self.engine.dashboard_snapshot().to_dict()
                self._send_json({"order_plan": snapshot["order_plan"], "mode": self.config.mode})
                return
            if path == "/api/rebalance/dry-run":
                snapshot = self.engine.dashboard_snapshot().to_dict()
                reconciliation = self._reconciler().snapshot(snapshot)
                self._send_json(
                    _dry_run_report(
                        config=self.config,
                        store=self.store,
                        engine=self.engine,
                        scanner=self._scanner(),
                        token_manager=self._token_manager(),
                        dashboard=snapshot,
                        reconciliation=reconciliation,
                    )
                )
                return
            if path == "/api/paper/portfolio":
                self._send_json(self.engine.paper_portfolio_snapshot())
                return
            if path == "/api/live-prices":
                symbols = _list_query_value(query, "symbol")
                if not symbols:
                    paper = self.engine.paper_portfolio_snapshot()
                    symbols = [
                        str(row.get("symbol") or "").upper().strip()
                        for row in paper.get("portfolio", {}).get("holdings", [])
                        if str(row.get("symbol") or "").strip()
                    ]
                self._send_json(self._live_prices().ltp_for_symbols(symbols))
                return
            if path == "/api/paper/order-plan":
                paper = self.engine.paper_portfolio_snapshot()
                self._send_json(
                    {
                        "mode": self.config.mode,
                        "plan": paper["plan"],
                        "portfolio": paper["portfolio"]["summary"],
                        "rebalance_status": self.engine.rebalance_status(),
                    }
                )
                return
            if path == "/api/paper/rebalance-status":
                today = _first_query_value(query, "today")
                self._send_json(self.engine.rebalance_status(today=today))
                return
            if path == "/api/market/holidays":
                self._send_json(holiday_status(self.config))
                return
            if path == "/api/system/tasks":
                self._send_json(_scheduled_task_status())
                return
            if path == "/api/reconciliation":
                snapshot = self.engine.dashboard_snapshot().to_dict()
                self._send_json(self._reconciler().snapshot(snapshot))
                return
            if path == "/api/dhan/broker-snapshot":
                self._send_json(self._broker_snapshot().latest())
                return
            if path == "/api/dhan/status":
                self._send_json(self._dhan().status())
                return
            if path == "/api/dhan/token/status":
                validate = _bool_query_value(query, "validate", False)
                self._send_json(self._token_manager().status(validate=validate))
                return
            if path == "/api/dhan/holdings":
                self._send_json({"ok": True, "holdings": self._dhan().holdings()})
                return
            if path == "/api/dhan/positions":
                self._send_json({"ok": True, "positions": self._dhan().positions()})
                return
            if path == "/api/dhan/funds":
                self._send_json({"ok": True, "funds": self._dhan().fund_limits()})
                return
            if path == "/api/dhan/orders":
                self._send_json({"ok": True, "orders": self._dhan().order_book()})
                return
            if path == "/api/dhan/trades":
                self._send_json({"ok": True, "trades": self._dhan().trade_book()})
                return
            if path == "/api/dhan/instruments/nse-eq":
                symbol = _first_query_value(query, "symbol")
                limit = _int_query_value(query, "limit", 50)
                force_refresh = _bool_query_value(query, "refresh", False)
                self._send_json(
                    self._dhan().nse_equity_instruments(
                        symbol=symbol,
                        limit=limit,
                        force_refresh=force_refresh,
                    )
                )
                return
            if path == "/api/dhan/history/daily":
                security_id = _first_query_value(query, "securityId") or _first_query_value(query, "security_id")
                from_date = _first_query_value(query, "from") or _first_query_value(query, "fromDate")
                to_date = _first_query_value(query, "to") or _first_query_value(query, "toDate")
                if not security_id or not from_date or not to_date:
                    self._send_json(
                        {
                            "ok": False,
                            "error": "securityId, from, and to query parameters are required.",
                        },
                        status=400,
                    )
                    return
                exchange_segment = _first_query_value(query, "exchangeSegment") or "NSE_EQ"
                instrument = _first_query_value(query, "instrument") or "EQUITY"
                data = self._dhan().historical_daily(
                    security_id=security_id,
                    from_date=from_date,
                    to_date=to_date,
                    exchange_segment=exchange_segment,
                    instrument=instrument,
                )
                self._send_json({"ok": True, "candles": data})
                return
            if path == "/api/scanner/latest":
                self._send_json(self._scanner().latest())
                return
            if path == "/api/scanner/instruments":
                limit = _int_query_value(query, "limit", 50)
                self._send_json(self._scanner().instrument_status(limit=limit))
                return
            if path == "/api/scanner/candles":
                symbols = _list_query_value(query, "symbol")
                self._send_json(self._scanner().candle_status(symbols=symbols or None))
                return
            if path == "/" or path == "/index.html":
                self._send_file(self.static_root / "index.html")
                return
            if path.startswith("/static/"):
                requested = path.removeprefix("/static/")
                static_path = (self.static_root / requested).resolve()
                if not str(static_path).startswith(str(self.static_root.resolve())):
                    self.send_error(403)
                    return
                self._send_file(static_path)
                return
            self.send_error(404)
        except DhanAPIError as exc:
            self._send_json(exc.public_payload(), status=502)
        except DhanTokenError as exc:
            self._send_json(exc.public_payload(), status=502)
        except Exception as exc:  # keep local server useful during MVP work
            self._send_json({"ok": False, "error": str(exc)}, status=500)

    def do_POST(self) -> None:  # noqa: N802 - required by BaseHTTPRequestHandler
        parsed = urlparse(self.path)
        path = parsed.path
        try:
            if path == "/api/dhan/token/refresh":
                self._send_json(self._token_manager().refresh())
                return
            if path == "/api/dhan/broker-snapshot/refresh":
                self._send_json(self._broker_snapshot().sync())
                return
            if path == "/api/market/holidays/sync":
                self._send_json(sync_holidays(self.config))
                return
            if path == "/api/notifications/test":
                result = self._notifier().notify(
                    level="info",
                    event_type="notification_test",
                    title="Notification test",
                    message="Trading OS notification pipeline test completed.",
                    payload={"mode": self.config.mode, "order_placement": "blocked"},
                )
                self.store.record_event("info", "notification_test", "Notification test sent", result)
                cloud = self._sync_cloud_bundle(reason="notification_test", include_notifications=True)
                self._send_json({"ok": True, "notification": result, "cloud_sync": cloud})
                return
            if path == "/api/notifications/emit":
                body = self._read_json_body()
                level = str(body.get("level") or "info").strip().lower()
                event_type = str(body.get("event_type") or "manual_alert").strip()
                title = str(body.get("title") or "Trading OS alert").strip()
                message = str(body.get("message") or "").strip()
                payload = body.get("payload") if isinstance(body.get("payload"), dict) else {}
                channels = _body_string_list(body.get("channels"))
                result = self._notifier().notify(
                    level=level,
                    event_type=event_type,
                    title=title,
                    message=message,
                    payload=payload,
                    channels=channels or None,
                )
                self.store.record_event(level, event_type, title, {"message": message, "notification": result})
                cloud = self._sync_cloud_bundle(reason=f"notification:{event_type}", include_notifications=True)
                self._send_json({"ok": True, "notification": result, "cloud_sync": cloud})
                return
            if path == "/api/cloud/sync":
                body = self._read_json_body()
                reason = str(body.get("reason") or "manual").strip() or "manual"
                result = self._sync_cloud_bundle(reason=reason)
                self._send_json(result, status=200 if result.get("ok") or result.get("skipped") else 502)
                return
            if path == "/api/cloud/heartbeat":
                client = self._cloud_client()
                if not self.config.sync_to_neon or not client.configured or not client.driver_available:
                    self._send_json(
                        {
                            "ok": False,
                            "skipped": True,
                            "reason": "Cloud sync requires TRADING_OS_SYNC_TO_NEON=true, DATABASE_URL, and psycopg.",
                        }
                    )
                    return
                result = client.push_worker_heartbeat(
                    status="online",
                    payload={"reason": "manual_heartbeat", "mode": self.config.mode, "app_version": APP_VERSION},
                )
                self._send_json(result)
                return
            if path == "/api/rebalance/dry-run/notify":
                snapshot = self.engine.dashboard_snapshot().to_dict()
                reconciliation = self._reconciler().snapshot(snapshot)
                report = _dry_run_report(
                    config=self.config,
                    store=self.store,
                    engine=self.engine,
                    scanner=self._scanner(),
                    token_manager=self._token_manager(),
                    dashboard=snapshot,
                    reconciliation=reconciliation,
                )
                summary = report.get("summary", {})
                message = (
                    f"Status={summary.get('status')}; gate={summary.get('rebalance_gate')}; "
                    f"orders={summary.get('planned_order_count')}; gaps={summary.get('gap_count')}; "
                    f"broker_cache={summary.get('broker_cache_status')}"
                )
                notification = self._notifier().notify(
                    level=str(summary.get("notification_level") or "info"),
                    event_type="monthly_dry_run",
                    title="Monthly rebalance dry-run report",
                    message=message,
                    payload={
                        "mode": report.get("mode"),
                        "status": summary.get("status"),
                        "order_placement": report.get("live_order_placement"),
                        "pending_entry_count": summary.get("pending_entry_count"),
                        "pending_exit_count": summary.get("pending_exit_count"),
                        "next_rebalance": report.get("rebalance", {}).get("first_trading_day"),
                    },
                )
                self.store.record_event(
                    str(summary.get("notification_level") or "info"),
                    "monthly_dry_run",
                    "Monthly rebalance dry-run report generated",
                    {"summary": summary, "notification": notification},
                )
                self._send_json({"ok": True, "report": report, "notification": notification})
                return
            if path == "/api/dhan/token/consent/start":
                self._send_json(self._token_manager().start_consent_flow())
                return
            if path == "/api/dhan/token/consent/consume":
                body = self._read_json_body()
                token_id = str(body.get("tokenId") or body.get("token_id") or "").strip()
                if not token_id:
                    self._send_json({"ok": False, "error": "tokenId is required."}, status=400)
                    return
                self._send_json({"ok": True, **self._token_manager().consume_consent(token_id)})
                return
            if path == "/api/paper/rebalance":
                body = self._read_json_body()
                force = bool(body.get("force"))
                today = _optional_str(body.get("today"))
                result = self.engine.execute_paper_rebalance(force=force, today=today)
                self.store.record_event(
                    "info",
                    "paper_rebalance",
                    "Paper rebalance skipped" if result.get("skipped") else "Paper rebalance executed",
                    {
                        "filled_count": result["paper_rebalance"].get("filled_count", 0),
                        "skipped": bool(result.get("skipped")),
                        "reason": result.get("skip_reason") or result.get("rebalance_status", {}).get("reason"),
                        "mode": self.config.mode,
                    },
                )
                filled_count = int(result.get("paper_rebalance", {}).get("filled_count") or 0)
                self._notifier().notify(
                    level="info" if result.get("skipped") else "ok",
                    event_type="paper_rebalance",
                    title="Paper rebalance skipped" if result.get("skipped") else "Paper rebalance executed",
                    message=result.get("skip_reason") or f"Paper rebalance filled {filled_count} orders.",
                    payload={
                        "mode": self.config.mode,
                        "skipped": bool(result.get("skipped")),
                        "filled_count": filled_count,
                        "next_rebalance": result.get("rebalance_status", {}).get("first_trading_day"),
                    },
                )
                cloud = self._sync_cloud_bundle(reason="paper_rebalance", rebalance_result=result)
                if isinstance(result, dict):
                    result["cloud_sync"] = cloud
                self._send_json(result)
                return
            if path == "/api/paper/reset":
                body = self._read_json_body()
                if body.get("confirm") != "RESET_PAPER":
                    self._send_json(
                        {
                            "ok": False,
                            "error": "Paper reset requires JSON body {\"confirm\":\"RESET_PAPER\"}.",
                        },
                        status=400,
                    )
                    return
                result = self.engine.reset_paper_portfolio()
                self.store.record_event("warning", "paper_reset", "Paper portfolio reset", {"mode": self.config.mode})
                self._send_json(result)
                return
            if path == "/api/scanner/instruments/sync":
                body = self._read_json_body()
                self._send_json(self._scanner().sync_instruments(force_refresh=bool(body.get("force_refresh"))))
                return
            if path == "/api/scanner/run":
                body = self._read_json_body()
                symbols = _body_symbol_list(body)
                limit = _optional_int(body.get("limit"), 25)
                if limit is not None and limit <= 0:
                    limit = None
                result = self._scanner().run_scan(
                    symbols=symbols,
                    limit=limit,
                    lookback_days=_optional_int(body.get("lookback_days"), 550) or 550,
                    from_date=_optional_str(body.get("from_date")),
                    to_date=_optional_str(body.get("to_date")),
                    as_of_date=_optional_str(body.get("as_of_date")),
                    sleep_seconds=float(body.get("sleep_seconds", 1.0) or 0.0),
                    max_retries=_optional_int(body.get("max_retries"), 3) or 3,
                    force_instruments=bool(body.get("force_instruments")),
                    sync=bool(body.get("sync", True)),
                )
                self.store.record_event(
                    "info",
                    "scanner_run",
                    "Dhan EOD scanner run completed",
                    {
                        "status": result.get("status"),
                        "run_id": result.get("run_id"),
                        "success_count": result.get("sync", {}).get("success_count"),
                        "failure_count": result.get("sync", {}).get("failure_count"),
                    },
                )
                diagnostics = result.get("ranking_diagnostics") or {}
                coverage = float(diagnostics.get("required_history_coverage") or 0.0)
                failure_count = int(result.get("sync", {}).get("failure_count") or 0)
                scanner_status = str(result.get("status") or "unknown")
                scanner_level = "ok" if scanner_status == "complete" and failure_count == 0 else "warning"
                self._notifier().notify(
                    level=scanner_level,
                    event_type="scanner_run",
                    title="Scanner completed" if scanner_level == "ok" else "Scanner needs attention",
                    message=(
                        f"Run {result.get('run_id')} status={scanner_status}; "
                        f"coverage={coverage * 100:.2f}%; failures={failure_count}; "
                        f"regime={result.get('regime', {}).get('state')}"
                    ),
                    payload={
                        "run_id": result.get("run_id"),
                        "status": scanner_status,
                        "coverage": f"{coverage * 100:.2f}%",
                        "failure_count": failure_count,
                        "regime": result.get("regime", {}).get("state"),
                    },
                )
                cloud = self._sync_cloud_bundle(reason="scanner_run", scanner_result=result)
                if isinstance(result, dict):
                    result["cloud_sync"] = cloud
                self._send_json(result)
                return
            self.send_error(404)
        except DhanTokenError as exc:
            self._send_json(exc.public_payload(), status=502)
        except DhanAPIError as exc:
            self._send_json(exc.public_payload(), status=502)
        except NSEHolidaySyncError as exc:
            self._send_json({"ok": False, "error": str(exc)}, status=502)
        except Exception as exc:
            self._send_json({"ok": False, "error": str(exc)}, status=500)

    def _read_json_body(self) -> dict[str, object]:
        length = int(self.headers.get("Content-Length", "0") or 0)
        if length <= 0:
            return {}
        raw = self.rfile.read(length).decode("utf-8", errors="replace")
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            return {}
        return data if isinstance(data, dict) else {}

    def log_message(self, fmt: str, *args: object) -> None:
        # Keep terminal readable; serious logs will be added to logs/ in the next step.
        print(f"[TradingOS] {self.address_string()} - {fmt % args}")


def main() -> None:
    cfg = get_config()
    store = StateStore(cfg.database_path)
    store.record_event(
        "info",
        "boot",
        "Trading OS server started",
        {"mode": cfg.mode, "auto_execution_enabled": cfg.auto_execution_enabled},
    )
    server = ThreadingHTTPServer((cfg.host, cfg.port), TradingOSHandler)
    print(f"Trading OS running at http://{cfg.host}:{cfg.port}")
    print(f"Mode: {cfg.mode} | Auto execution: {cfg.auto_execution_enabled}")
    print(f"State DB: {cfg.database_path}")
    server.serve_forever()


def _first_query_value(query: dict[str, list[str]], name: str) -> str | None:
    values = query.get(name)
    if not values:
        return None
    return values[0]


def _int_query_value(query: dict[str, list[str]], name: str, default: int) -> int:
    raw = _first_query_value(query, name)
    if raw is None:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def _bool_query_value(query: dict[str, list[str]], name: str, default: bool) -> bool:
    raw = _first_query_value(query, name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "y", "on"}


def _list_query_value(query: dict[str, list[str]], name: str) -> list[str]:
    values = query.get(name) or []
    symbols: list[str] = []
    for value in values:
        symbols.extend(part.strip() for part in value.split(",") if part.strip())
    return symbols


def _optional_int(value: object, default: int | None = None) -> int | None:
    if value in (None, ""):
        return default
    try:
        return int(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return default


def _scheduled_task_status() -> dict[str, object]:
    task_names = [
        "TradingOS_Dhan_Daily_Readonly_Sync",
        "TradingOS_Dhan_EOD_Scanner",
        "TradingOS_Paper_Rebalance",
    ]
    tasks = [_query_scheduled_task(name) for name in task_names]
    installed_count = sum(1 for task in tasks if task.get("installed"))
    ok = installed_count == len(task_names)
    return {
        "ok": ok,
        "installed_count": installed_count,
        "expected_count": len(task_names),
        "tasks": tasks,
    }


def _query_scheduled_task(name: str) -> dict[str, object]:
    try:
        completed = subprocess.run(
            ["schtasks", "/Query", "/TN", name, "/FO", "CSV", "/V"],
            check=False,
            capture_output=True,
            text=True,
            timeout=8,
        )
    except (FileNotFoundError, subprocess.SubprocessError, OSError) as exc:
        return {
            "name": name,
            "installed": False,
            "status": "unavailable",
            "error": str(exc),
        }

    if completed.returncode != 0:
        return {
            "name": name,
            "installed": False,
            "status": "missing",
            "error": (completed.stderr or completed.stdout or "").strip(),
        }

    rows = list(csv.DictReader(io.StringIO(completed.stdout)))
    row = rows[0] if rows else {}
    return {
        "name": name,
        "installed": True,
        "status": _task_field(row, "Status"),
        "next_run_time": _task_field(row, "Next Run Time"),
        "last_run_time": _task_field(row, "Last Run Time"),
        "last_result": _task_field(row, "Last Result"),
        "schedule_type": _task_field(row, "Schedule Type"),
        "task_to_run": _task_field(row, "Task To Run"),
    }


def _task_field(row: dict[str, str], key: str) -> str:
    value = row.get(key) or row.get(key.lower()) or ""
    return value.strip()


def _audit_report(
    *,
    config: object,
    store: StateStore,
    engine: StrategyEngine,
    scanner: DhanEODScanner,
    notifier: NotificationManager,
    limit: int = 60,
) -> dict[str, object]:
    paper = _safe_audit_call(lambda: engine.paper_portfolio_snapshot())
    scanner_latest = _safe_audit_call(lambda: scanner.latest())
    broker_snapshot = _safe_audit_call(lambda: BrokerSnapshotService(config, store).latest())
    tasks = _safe_audit_call(_scheduled_task_status)
    notifications = notifier.recent(limit=limit)
    events = store.recent_events(limit)
    paper_orders = store.get_value("paper_orders", [])
    if not isinstance(paper_orders, list):
        paper_orders = []

    portfolio = _audit_dict(paper.get("portfolio"))
    portfolio_summary = _audit_dict(portfolio.get("summary"))
    plan = _audit_dict(paper.get("plan"))
    rebalance = _audit_dict(paper.get("rebalance_status"))
    pdd = _audit_dict(paper.get("pdd"))
    regime = _audit_dict(paper.get("regime"))
    signal_source = _audit_dict(paper.get("signal_source"))
    broker_summary = _audit_dict(broker_snapshot.get("summary"))
    broker_cache = _audit_dict(broker_snapshot.get("cache"))
    scanner_diagnostics = _audit_dict(scanner_latest.get("ranking_diagnostics"))
    scanner_sync = _audit_dict(scanner_latest.get("sync"))
    notification_summary = _audit_dict(_audit_dict(notifications.get("status")).get("summary"))
    notification_counts = _audit_dict(notification_summary.get("counts"))

    scanner_status = scanner_latest.get("status") or signal_source.get("status") or "unknown"
    scanner_coverage = scanner_diagnostics.get("required_history_coverage")
    if scanner_coverage is None:
        scanner_coverage = signal_source.get("coverage")
    scanner_failure_count = scanner_sync.get("failure_count")
    if scanner_failure_count is None:
        scanner_failure_count = signal_source.get("failure_count")

    timeline = _audit_timeline(
        events=events,
        notifications=notifications.get("notifications", []),
        paper_orders=paper_orders,
        scanner_latest=scanner_latest,
        rebalance=rebalance,
    )

    failed_notifications = _audit_count_status(notification_counts, "failed")
    skipped_notifications = _audit_count_status(notification_counts, "skipped")
    delivered_notifications = _audit_count_status(notification_counts, "delivered")

    return {
        "ok": True,
        "generated_at": _now_for_audit(),
        "mode": getattr(config, "mode", "paper"),
        "summary": {
            "scanner_status": scanner_status,
            "scanner_run_id": scanner_latest.get("run_id") or signal_source.get("run_id"),
            "scanner_coverage": scanner_coverage,
            "scanner_failure_count": scanner_failure_count,
            "scanner_as_of_month": scanner_latest.get("as_of_month") or signal_source.get("as_of_month"),
            "scanner_execution_month": scanner_latest.get("execution_month") or signal_source.get("execution_month"),
            "rebalance_allowed": bool(rebalance.get("allowed")),
            "rebalance_reason": rebalance.get("reason"),
            "rebalance_last_completed_month": rebalance.get("last_completed_month"),
            "paper_equity": portfolio_summary.get("equity"),
            "paper_total_pnl_pct": portfolio_summary.get("total_pnl_pct"),
            "paper_drawdown": portfolio_summary.get("current_drawdown") or pdd.get("current_drawdown"),
            "paper_holding_count": portfolio_summary.get("holding_count"),
            "market_regime": regime.get("state"),
            "pdd_state": pdd.get("state"),
            "paper_order_count": len(paper_orders),
            "broker_snapshot_ok": broker_snapshot.get("ok"),
            "broker_snapshot_status": broker_cache.get("status"),
            "broker_snapshot_age_seconds": broker_cache.get("age_seconds"),
            "broker_holding_count": broker_summary.get("holding_count"),
            "broker_available_cash": broker_summary.get("available_cash"),
            "planned_order_count": len(plan.get("orders") or []),
            "target_symbols": plan.get("target_symbols") or [],
            "retain_symbols": plan.get("retain_symbols") or [],
            "task_installed_count": tasks.get("installed_count"),
            "task_expected_count": tasks.get("expected_count"),
            "notifications_delivered": delivered_notifications,
            "notifications_failed": failed_notifications,
            "notifications_skipped": skipped_notifications,
        },
        "scanner": {
            "status": scanner_status,
            "run_id": scanner_latest.get("run_id"),
            "as_of_date": scanner_latest.get("as_of_date"),
            "as_of_month": scanner_latest.get("as_of_month"),
            "execution_month": scanner_latest.get("execution_month"),
            "data_source": scanner_latest.get("data_source"),
            "coverage": scanner_coverage,
            "failure_count": scanner_failure_count,
            "diagnostics": scanner_diagnostics,
            "sync": {
                "success_count": scanner_sync.get("success_count"),
                "failure_count": scanner_sync.get("failure_count"),
                "saved_candle_count": scanner_sync.get("saved_candle_count"),
                "failures": scanner_sync.get("failures") or [],
            },
            "regime": scanner_latest.get("regime") or regime,
            "top_ranks": (scanner_latest.get("rankings") or paper.get("ranks") or [])[:21],
        },
        "broker": broker_snapshot,
        "paper": {
            "generated_at": paper.get("generated_at"),
            "strategy_name": paper.get("strategy_name"),
            "portfolio": portfolio_summary,
            "holdings": portfolio.get("holdings") or [],
            "orders": paper_orders[-25:][::-1],
            "plan": {
                "as_of": plan.get("as_of"),
                "generated_at": plan.get("generated_at"),
                "summary": plan.get("summary") or {},
                "target_symbols": plan.get("target_symbols") or [],
                "retain_symbols": plan.get("retain_symbols") or [],
                "orders": plan.get("orders") or [],
            },
            "pdd": pdd,
            "regime": regime,
            "rebalance_status": rebalance,
            "target_sleeves": paper.get("target_sleeves") or [],
            "signal_source": signal_source,
            "signal_note": paper.get("signal_note"),
        },
        "tasks": tasks,
        "events": events,
        "notifications": notifications.get("notifications", []),
        "notification_status": notifications.get("status", {}),
        "timeline": timeline[:80],
    }


def _dry_run_report(
    *,
    config: object,
    store: StateStore,
    engine: StrategyEngine,
    scanner: DhanEODScanner,
    token_manager: DhanTokenManager,
    dashboard: dict[str, object],
    reconciliation: dict[str, object],
) -> dict[str, object]:
    paper = _audit_dict(dashboard.get("paper"))
    portfolio = _audit_dict(paper.get("portfolio"))
    portfolio_summary = _audit_dict(portfolio.get("summary"))
    plan = _audit_dict(paper.get("plan"))
    rebalance = _audit_dict(paper.get("rebalance_status")) or _audit_dict(engine.rebalance_status())
    pdd = _audit_dict(dashboard.get("pdd"))
    regime = _audit_dict(dashboard.get("regime"))
    scanner_latest = _safe_audit_call(scanner.latest)
    token = _safe_audit_call(lambda: token_manager.status(validate=False))
    broker = _safe_audit_call(lambda: BrokerSnapshotService(config, store).latest())
    tasks = _safe_audit_call(_scheduled_task_status)
    holidays = _safe_audit_call(lambda: holiday_status(config))  # type: ignore[arg-type]
    reconciliation_summary = _audit_dict(reconciliation.get("summary"))
    broker_cache = _audit_dict(broker.get("cache"))
    broker_summary = _audit_dict(broker.get("summary"))

    target_symbols = _dry_run_symbols(
        plan.get("target_symbols"),
        dashboard.get("target_sleeves"),
    )
    retain_symbols = _dry_run_symbols(plan.get("retain_symbols"), reconciliation.get("strategy", {}))
    planned_orders = plan.get("orders") if isinstance(plan.get("orders"), list) else []
    plan_summary = _audit_dict(plan.get("summary"))
    pending_actions = _audit_dict(reconciliation.get("pending_actions"))
    pending_exits = pending_actions.get("exits") if isinstance(pending_actions.get("exits"), list) else []
    pending_entries = pending_actions.get("entries") if isinstance(pending_actions.get("entries"), list) else []
    gap_count = int(reconciliation_summary.get("gap_count") or 0)

    safety_checks = [
        _dry_run_check(
            "paper_mode",
            "Trading OS mode is paper",
            getattr(config, "mode", "paper") == "paper",
            "critical",
            f"mode={getattr(config, 'mode', '--')}",
        ),
        _dry_run_check(
            "auto_execution_disabled",
            "Auto execution is disabled",
            not bool(getattr(config, "auto_execution_enabled", False)),
            "critical",
            f"auto_execution_enabled={getattr(config, 'auto_execution_enabled', False)}",
        ),
        _dry_run_check(
            "live_orders_blocked",
            "Live order placement blocked",
            str(broker.get("order_placement") or "blocked") == "blocked",
            "critical",
            f"order_placement={broker.get('order_placement') or 'blocked'}",
        ),
        _dry_run_check(
            "broker_cache_available",
            "Broker snapshot cache available",
            bool(broker_cache.get("available")),
            "critical",
            str(broker.get("message") or "broker cache"),
        ),
        _dry_run_check(
            "broker_cache_fresh",
            "Broker snapshot fresh within 24h",
            bool(broker_cache.get("available")) and not bool(broker_cache.get("stale")),
            "critical",
            f"cache={broker_cache.get('status') or 'missing'}; age={broker_cache.get('age_seconds')}",
        ),
        _dry_run_check(
            "scanner_data_present",
            "Latest scanner data present",
            bool(scanner_latest.get("run_id") or dashboard.get("ranks")),
            "critical",
            f"run_id={scanner_latest.get('run_id') or '--'}; status={scanner_latest.get('status') or '--'}",
        ),
        _dry_run_check(
            "target_symbols_present",
            "Strategy target symbols present",
            bool(target_symbols),
            "critical",
            ", ".join(target_symbols) or "--",
        ),
        _dry_run_check(
            "paper_portfolio_present",
            "Paper portfolio available",
            float(portfolio_summary.get("equity") or 0.0) > 0,
            "critical",
            f"equity={portfolio_summary.get('equity') or '--'}",
        ),
        _dry_run_check(
            "rebalance_gate",
            "Monthly rebalance gate",
            bool(rebalance.get("allowed")),
            "warning",
            str(rebalance.get("reason") or "Ready"),
        ),
        _dry_run_check(
            "broker_paper_alignment",
            "Broker and paper holdings aligned",
            bool(reconciliation_summary.get("broker_matches_paper")),
            "warning",
            f"gap_count={gap_count}",
        ),
        _dry_run_check(
            "scheduler_installed",
            "Scheduled tasks installed",
            bool(tasks.get("ok")),
            "warning",
            f"{tasks.get('installed_count') or 0}/{tasks.get('expected_count') or 0} tasks",
        ),
        _dry_run_check(
            "token_detected",
            "Dhan token detected",
            bool(token.get("ok") or token.get("env_token_present") or token.get("managed_token_present")),
            "warning",
            f"source={token.get('source') or '--'}",
        ),
        _dry_run_check(
            "holiday_calendar",
            "NSE holiday calendar available",
            holidays.get("ok") is not False,
            "warning",
            str(holidays.get("message") or holidays.get("source") or "holiday cache"),
        ),
    ]
    critical_failures = [check for check in safety_checks if check["severity"] == "critical" and not check["ok"]]
    warning_failures = [check for check in safety_checks if check["severity"] == "warning" and not check["ok"]]

    if critical_failures:
        status = "attention_required"
        notification_level = "warning"
    elif not rebalance.get("allowed"):
        status = "calendar_blocked"
        notification_level = "info"
    elif warning_failures:
        status = "ready_with_warnings"
        notification_level = "warning"
    else:
        status = "ready"
        notification_level = "ok"

    return {
        "ok": True,
        "generated_at": _now_for_audit(),
        "mode": getattr(config, "mode", "paper"),
        "dry_run": True,
        "read_only": True,
        "live_order_placement": "blocked",
        "summary": {
            "status": status,
            "notification_level": notification_level,
            "rebalance_gate": "allowed" if rebalance.get("allowed") else "blocked",
            "critical_failure_count": len(critical_failures),
            "warning_count": len(warning_failures),
            "planned_order_count": len(planned_orders),
            "planned_buy_count": plan_summary.get("buy_count", 0),
            "planned_sell_count": plan_summary.get("sell_count", 0),
            "pending_entry_count": len(pending_entries),
            "pending_exit_count": len(pending_exits),
            "gap_count": gap_count,
            "target_symbol_count": len(target_symbols),
            "paper_equity": portfolio_summary.get("equity"),
            "paper_cash": portfolio_summary.get("cash"),
            "paper_drawdown": portfolio_summary.get("current_drawdown") or pdd.get("current_drawdown"),
            "broker_cache_status": broker_cache.get("status"),
            "broker_cache_age_seconds": broker_cache.get("age_seconds"),
            "broker_holding_count": broker_summary.get("holding_count"),
            "broker_available_cash": broker_summary.get("available_cash"),
            "scanner_run_id": scanner_latest.get("run_id"),
            "scanner_status": scanner_latest.get("status"),
            "market_regime": regime.get("state"),
        },
        "strategy": {
            "name": dashboard.get("strategy_name"),
            "target_symbols": target_symbols,
            "retain_symbols": retain_symbols,
            "market_regime": regime.get("state"),
            "risk_on": regime.get("risk_on"),
            "pdd_state": pdd.get("state"),
        },
        "rebalance": rebalance,
        "scanner": {
            "run_id": scanner_latest.get("run_id"),
            "status": scanner_latest.get("status"),
            "as_of_month": scanner_latest.get("as_of_month"),
            "execution_month": scanner_latest.get("execution_month"),
            "coverage": _audit_dict(scanner_latest.get("ranking_diagnostics")).get("required_history_coverage"),
            "failure_count": _audit_dict(scanner_latest.get("sync")).get("failure_count"),
        },
        "broker": {
            "ok": broker.get("ok"),
            "message": broker.get("message"),
            "cache": broker_cache,
            "summary": broker_summary,
        },
        "paper": {
            "portfolio": portfolio_summary,
            "holdings": portfolio.get("holdings") or [],
        },
        "order_plan": {
            "summary": plan_summary,
            "target_symbols": target_symbols,
            "retain_symbols": retain_symbols,
            "orders": planned_orders,
        },
        "reconciliation": {
            "summary": reconciliation_summary,
            "comparison": reconciliation.get("comparison") or {},
            "pending_actions": pending_actions,
            "notes": reconciliation.get("notes") or [],
        },
        "safety_checks": safety_checks,
        "notes": [
            "Dry-run report only. No live, paper, or broker orders are placed by this endpoint.",
            "Monthly strategy uses daily/monthly state; broker cache freshness threshold is 24 hours.",
            "On real rebalance day, refresh broker snapshot before and after any execution workflow.",
        ],
    }


def _dry_run_check(key: str, label: str, ok: bool, severity: str, detail: str) -> dict[str, object]:
    return {
        "key": key,
        "label": label,
        "ok": bool(ok),
        "severity": severity,
        "level": "ok" if ok else ("danger" if severity == "critical" else "warning"),
        "detail": detail,
    }


def _dry_run_symbols(primary: object, fallback: object = None) -> list[str]:
    symbols: list[str] = []
    if isinstance(primary, list):
        for item in primary:
            if isinstance(item, str):
                symbol = item
            elif isinstance(item, dict):
                symbol = str(item.get("symbol") or "")
            else:
                symbol = ""
            symbol = symbol.upper().strip()
            if symbol and symbol not in symbols:
                symbols.append(symbol)
    if symbols:
        return symbols
    if isinstance(fallback, dict):
        for key in ("target_symbols", "retain_symbols", "symbols"):
            symbols = _dry_run_symbols(fallback.get(key))
            if symbols:
                return symbols
    if isinstance(fallback, list):
        return _dry_run_symbols(fallback)
    return []


def _safe_audit_call(callback) -> dict[str, object]:
    try:
        payload = callback()
        return payload if isinstance(payload, dict) else {"ok": True, "value": payload}
    except Exception as exc:  # audit screen should degrade source-by-source
        return {"ok": False, "error": str(exc)}


def _audit_dict(value: object) -> dict[str, object]:
    return value if isinstance(value, dict) else {}


def _audit_count_status(counts: dict[str, object], status: str) -> int:
    total = 0
    for row in counts.values():
        if isinstance(row, dict):
            total += int(row.get(status) or 0)
    return total


def _audit_timeline(
    *,
    events: list[dict[str, object]],
    notifications: object,
    paper_orders: list[object],
    scanner_latest: dict[str, object],
    rebalance: dict[str, object],
) -> list[dict[str, object]]:
    timeline: list[dict[str, object]] = []
    if scanner_latest.get("run_id"):
        timeline.append(
            {
                "created_at": scanner_latest.get("as_of_date"),
                "level": "warning" if scanner_latest.get("status") != "complete" else "ok",
                "source": "scanner",
                "title": f"Scanner run #{scanner_latest.get('run_id')}",
                "message": f"Status={scanner_latest.get('status')}; execution_month={scanner_latest.get('execution_month')}",
            }
        )
    if rebalance:
        timeline.append(
            {
                "created_at": rebalance.get("today"),
                "level": "ok" if rebalance.get("allowed") else "info",
                "source": "rebalance_gate",
                "title": "Monthly rebalance gate",
                "message": str(rebalance.get("reason") or "Ready"),
            }
        )
    for order in paper_orders:
        if isinstance(order, dict):
            timeline.append(
                {
                    "created_at": order.get("created_at"),
                    "level": "ok" if str(order.get("status") or "").upper() == "FILLED" else "info",
                    "source": "paper_order",
                    "title": f"{order.get('action')} {order.get('symbol')}",
                    "message": f"Qty={order.get('quantity')}; price={order.get('price')}; status={order.get('status')}",
                }
            )
    for event in events:
        timeline.append(
            {
                "created_at": event.get("created_at"),
                "level": event.get("level"),
                "source": event.get("event_type"),
                "title": event.get("message"),
                "message": _audit_event_message(event.get("payload")),
            }
        )
    if isinstance(notifications, list):
        for notification in notifications:
            if isinstance(notification, dict):
                timeline.append(
                    {
                        "created_at": notification.get("created_at"),
                        "level": notification.get("level"),
                        "source": f"{notification.get('channel')}:{notification.get('event_type')}",
                        "title": notification.get("title"),
                        "message": notification.get("message"),
                    }
                )
    timeline.sort(key=lambda row: str(row.get("created_at") or ""), reverse=True)
    return timeline


def _audit_event_message(payload: object) -> str:
    if not isinstance(payload, dict):
        return ""
    preferred = ["status", "run_id", "success_count", "failure_count", "filled_count", "skipped", "reason", "mode"]
    parts = [f"{key}={payload[key]}" for key in preferred if key in payload]
    return "; ".join(parts)


def _now_for_audit() -> str:
    from .models import utc_now_iso

    return utc_now_iso()


def _optional_str(value: object) -> str | None:
    if value in (None, ""):
        return None
    return str(value).strip()


def _body_symbol_list(body: dict[str, object]) -> list[str] | None:
    value = body.get("symbols")
    if value in (None, ""):
        symbol = body.get("symbol")
        return [str(symbol).strip()] if symbol else None
    if isinstance(value, list):
        return [str(item).strip().upper() for item in value if str(item).strip()]
    return [part.strip().upper() for part in str(value).split(",") if part.strip()]


def _body_string_list(value: object) -> list[str] | None:
    if value is None:
        return None
    if isinstance(value, str):
        return [part.strip() for part in value.split(",") if part.strip()]
    if isinstance(value, list):
        return [str(part).strip() for part in value if str(part).strip()]
    return None


if __name__ == "__main__":
    main()
