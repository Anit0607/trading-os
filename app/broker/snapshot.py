from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from ..config import AppConfig
from ..models import utc_now_iso
from ..storage import StateStore
from .dhan import DhanAPIError, DhanBroker


BROKER_SNAPSHOT_KEY = "dhan_broker_snapshot"
BROKER_SNAPSHOT_MAX_AGE_SECONDS = 24 * 60 * 60


class BrokerSnapshotService:
    """Cache Dhan read-only broker state for fast dashboard/reconciliation reads."""

    def __init__(
        self,
        config: AppConfig,
        store: StateStore | None = None,
        broker: DhanBroker | None = None,
    ) -> None:
        self.config = config
        self.store = store or StateStore(config.database_path)
        self.broker = broker or DhanBroker.from_config(config)
        self.cache_path = config.project_root / "data" / "dhan" / "latest_broker_snapshot.json"

    def latest(self) -> dict[str, Any]:
        snapshot = self.store.get_value(BROKER_SNAPSHOT_KEY, None)
        source = "sqlite_kv"
        if not isinstance(snapshot, dict):
            snapshot = self._read_file_snapshot()
            source = "json_file" if isinstance(snapshot, dict) else "missing"
        if not isinstance(snapshot, dict):
            return self._missing_snapshot()
        return self._with_cache_status(snapshot, cache_source=source)

    def sync(self) -> dict[str, Any]:
        endpoint_status: dict[str, Any] = {}
        ok = True

        holdings = self._read_endpoint(
            endpoint_status,
            "holdings",
            self.broker.holdings,
            normalizer=lambda rows: [normalize_broker_holding(row) for row in _list(rows)],
        )
        funds = self._read_endpoint(
            endpoint_status,
            "funds",
            self.broker.fund_limits,
            normalizer=lambda row: normalize_broker_funds(_dict(row)),
        )
        positions = self._read_endpoint(endpoint_status, "positions", self.broker.positions, normalizer=_list)
        orders = self._read_endpoint(endpoint_status, "orders", self.broker.order_book, normalizer=_list)
        trades = self._read_endpoint(endpoint_status, "trades", self.broker.trade_book, normalizer=_list)

        for status in endpoint_status.values():
            if not status.get("ok"):
                ok = False

        generated_at = utc_now_iso()
        message = self._message(ok=ok, holdings=holdings, endpoint_status=endpoint_status)
        snapshot = {
            "ok": ok,
            "generated_at": generated_at,
            "source": "dhan_direct_api",
            "message": message,
            "mode": self.config.mode,
            "auto_execution_enabled": self.config.auto_execution_enabled,
            "read_only_guard": "enabled",
            "order_placement": "blocked",
            "endpoint_status": endpoint_status,
            "endpoints": endpoint_status,
            "holdings": holdings,
            "funds": funds if isinstance(funds, dict) else {"available_cash": 0.0},
            "positions": positions,
            "orders": orders,
            "trades": trades,
            "summary": {
                "holding_count": len(holdings) if isinstance(holdings, list) else 0,
                "position_count": len(positions) if isinstance(positions, list) else 0,
                "order_count": len(orders) if isinstance(orders, list) else 0,
                "trade_count": len(trades) if isinstance(trades, list) else 0,
                "available_cash": (funds or {}).get("available_cash", 0.0) if isinstance(funds, dict) else 0.0,
            },
        }
        snapshot = self._with_cache_status(snapshot, cache_source="live_sync")
        self._write_snapshot(snapshot)
        self.store.record_event(
            "info" if ok else "warning",
            "broker_snapshot",
            "Dhan broker snapshot refreshed" if ok else "Dhan broker snapshot refresh needs attention",
            {
                "ok": ok,
                "holding_count": snapshot["summary"]["holding_count"],
                "available_cash": snapshot["summary"]["available_cash"],
                "failed_endpoints": [
                    name for name, status in endpoint_status.items() if not status.get("ok")
                ],
            },
        )
        return snapshot

    def _read_endpoint(self, endpoint_status: dict[str, Any], name: str, method, *, normalizer) -> Any:
        try:
            data = method()
            normalized = normalizer(data)
            endpoint_status[name] = _summarize_endpoint(normalized)
            return normalized
        except DhanAPIError as exc:
            endpoint_status[name] = exc.public_payload()
            return [] if name != "funds" else {"available_cash": 0.0}
        except Exception as exc:
            endpoint_status[name] = {"ok": False, "error": str(exc)}
            return [] if name != "funds" else {"available_cash": 0.0}

    def _write_snapshot(self, snapshot: dict[str, Any]) -> None:
        self.store.set_value(BROKER_SNAPSHOT_KEY, snapshot)
        self.cache_path.parent.mkdir(parents=True, exist_ok=True)
        self.cache_path.write_text(json.dumps(snapshot, ensure_ascii=False, indent=2, sort_keys=True), encoding="utf-8")

    def _read_file_snapshot(self) -> dict[str, Any] | None:
        if not self.cache_path.exists():
            return None
        try:
            payload = json.loads(self.cache_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None
        return payload if isinstance(payload, dict) else None

    def _with_cache_status(self, snapshot: dict[str, Any], *, cache_source: str) -> dict[str, Any]:
        generated_at = str(snapshot.get("generated_at") or "")
        age_seconds = _age_seconds(generated_at)
        stale = age_seconds is None or age_seconds > BROKER_SNAPSHOT_MAX_AGE_SECONDS
        status = "stale" if stale else "fresh"
        if not generated_at:
            status = "missing"
        snapshot = dict(snapshot)
        snapshot["cache"] = {
            "available": bool(generated_at),
            "source": cache_source,
            "path": str(self.cache_path),
            "generated_at": generated_at or None,
            "age_seconds": age_seconds,
            "max_age_seconds": BROKER_SNAPSHOT_MAX_AGE_SECONDS,
            "stale": stale,
            "status": status,
        }
        return snapshot

    def _missing_snapshot(self) -> dict[str, Any]:
        return {
            "ok": False,
            "generated_at": None,
            "source": "dhan_broker_cache",
            "message": "No cached Dhan broker snapshot yet. Run broker snapshot refresh.",
            "mode": self.config.mode,
            "auto_execution_enabled": self.config.auto_execution_enabled,
            "read_only_guard": "enabled",
            "order_placement": "blocked",
            "endpoint_status": {},
            "endpoints": {},
            "holdings": [],
            "funds": {"available_cash": 0.0},
            "positions": [],
            "orders": [],
            "trades": [],
            "summary": {
                "holding_count": 0,
                "position_count": 0,
                "order_count": 0,
                "trade_count": 0,
                "available_cash": 0.0,
            },
            "cache": {
                "available": False,
                "source": "missing",
                "path": str(self.cache_path),
                "generated_at": None,
                "age_seconds": None,
                "max_age_seconds": BROKER_SNAPSHOT_MAX_AGE_SECONDS,
                "stale": True,
                "status": "missing",
            },
        }

    @staticmethod
    def _message(*, ok: bool, holdings: Any, endpoint_status: dict[str, Any]) -> str:
        if not ok:
            failed = [name for name, status in endpoint_status.items() if not status.get("ok")]
            return f"Dhan broker snapshot refreshed with endpoint failures: {', '.join(failed)}"
        if not holdings:
            return "Dhan connected; no holdings available"
        return "Dhan broker snapshot refreshed"


def normalize_broker_holding(row: dict[str, Any]) -> dict[str, Any]:
    symbol = str(_first(row, ["tradingSymbol", "symbol", "exchangeSymbol", "securitySymbol", "scripName"]) or "").upper().strip()
    quantity = _number(_first(row, ["totalQty", "availableQty", "quantity", "qty", "holdingQty", "dpQty", "t1Qty"]))
    avg_price = _number(_first(row, ["avgCostPrice", "avgPrice", "averagePrice", "buyAvg", "costPrice", "avg_price"]))
    ltp = _number(_first(row, ["lastTradedPrice", "ltp", "lastPrice", "closePrice", "previousClose", "last_price"]))
    value = _number(_first(row, ["currentValue", "marketValue", "value"]))
    if value == 0.0 and quantity and ltp:
        value = quantity * ltp
    invested = quantity * avg_price if quantity and avg_price else 0.0
    pnl = _number(_first(row, ["unrealizedProfit", "pnl", "profitLoss"]))
    if pnl == 0.0 and value and invested:
        pnl = value - invested
    return {
        "symbol": symbol,
        "security_id": str(_first(row, ["securityId", "security_id", "isin"]) or ""),
        "quantity": quantity,
        "avg_price": avg_price,
        "ltp": ltp,
        "value": value,
        "pnl": pnl,
        "raw_keys": sorted(row.keys()),
    }


def normalize_broker_funds(row: dict[str, Any]) -> dict[str, Any]:
    available_cash = _number(
        _first(
            row,
            [
                "availabelBalance",
                "availableBalance",
                "available_balance",
                "withdrawableBalance",
                "clearBalance",
                "sodLimit",
            ],
        )
    )
    utilized = _number(_first(row, ["utilizedAmount", "utilized", "usedMargin", "utilized_amount"]))
    collateral = _number(_first(row, ["collateralAmount", "collateral", "collateral_amount"]))
    return {
        "available_cash": available_cash,
        "utilized_amount": utilized,
        "collateral_amount": collateral,
        "raw_keys": sorted(row.keys()),
    }


def _summarize_endpoint(data: Any) -> dict[str, Any]:
    if isinstance(data, list):
        return {"ok": True, "type": "list", "count": len(data)}
    if isinstance(data, dict):
        summary = {"ok": True, "type": "object", "keys": sorted(data.keys())}
        if "available_cash" in data:
            summary["available_cash"] = data.get("available_cash")
        return summary
    return {"ok": True, "type": type(data).__name__}


def _list(value: Any) -> list[dict[str, Any]]:
    return value if isinstance(value, list) else []


def _dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _first(row: dict[str, Any], keys: list[str]) -> Any:
    for key in keys:
        if key in row and row[key] not in (None, ""):
            return row[key]
    lower = {key.lower(): value for key, value in row.items()}
    for key in keys:
        value = lower.get(key.lower())
        if value not in (None, ""):
            return value
    return None


def _number(value: Any) -> float:
    if value in (None, ""):
        return 0.0
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def _age_seconds(value: str) -> int | None:
    if not value:
        return None
    try:
        normalized = value.replace("Z", "+00:00")
        generated = datetime.fromisoformat(normalized)
        if generated.tzinfo is None:
            generated = generated.replace(tzinfo=timezone.utc)
        return max(0, int((datetime.now(timezone.utc) - generated.astimezone(timezone.utc)).total_seconds()))
    except ValueError:
        return None
