from __future__ import annotations

import csv
import json
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from ..auth.dhan_token import DhanTokenManager
from ..config import AppConfig


DHAN_API_BASE_URL = "https://api.dhan.co/v2"
DHAN_INSTRUMENT_MASTER_URL = "https://images.dhan.co/api-data/api-scrip-master-detailed.csv"
DEFAULT_TIMEOUT_SECONDS = 30
INSTRUMENT_CACHE_MAX_AGE_SECONDS = 24 * 60 * 60


class DhanAPIError(RuntimeError):
    """Dhan read-only API failure with sensitive headers stripped."""

    def __init__(self, message: str, *, status_code: int | None = None, payload: Any = None) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.payload = payload

    def public_payload(self) -> dict[str, Any]:
        return {
            "ok": False,
            "error": str(self),
            "status_code": self.status_code,
            "payload": self.payload,
        }


@dataclass(frozen=True)
class DhanRuntimeGuard:
    mode: str
    auto_execution_enabled: bool
    client_id_present: bool
    access_token_present: bool

    def assert_read_allowed(self) -> None:
        if not self.client_id_present or not self.access_token_present:
            raise RuntimeError("Dhan credentials are missing. Read-only Dhan integration cannot start.")

    def assert_order_allowed(self) -> None:
        self.assert_read_allowed()
        if self.mode != "live":
            raise RuntimeError("Dhan order placement blocked because TRADING_OS_MODE is not 'live'.")
        if not self.auto_execution_enabled:
            raise RuntimeError("Dhan order placement blocked because AUTO_EXECUTION_ENABLED is false.")


class DhanHTTPClient:
    def __init__(
        self,
        *,
        access_token: str,
        client_id: str,
        base_url: str = DHAN_API_BASE_URL,
        timeout_seconds: int = DEFAULT_TIMEOUT_SECONDS,
    ) -> None:
        self.access_token = access_token
        self.client_id = client_id
        self.base_url = base_url.rstrip("/")
        self.timeout_seconds = timeout_seconds

    def get(self, path: str) -> Any:
        return self._request("GET", path)

    def post(self, path: str, payload: dict[str, Any]) -> Any:
        return self._request("POST", path, payload)

    def _request(self, method: str, path: str, payload: dict[str, Any] | None = None) -> Any:
        url = path if path.startswith("http") else f"{self.base_url}/{path.lstrip('/')}"
        body = None if payload is None else json.dumps(payload).encode("utf-8")
        request = Request(
            url,
            data=body,
            method=method,
            headers={
                "Accept": "application/json",
                "Content-Type": "application/json",
                "access-token": self.access_token,
                "client-id": self.client_id,
                "dhanClientId": self.client_id,
                "User-Agent": "TradingOS/0.1",
            },
        )
        try:
            with urlopen(request, timeout=self.timeout_seconds) as response:
                text = response.read().decode("utf-8", errors="replace")
                if not text:
                    return None
                return json.loads(text)
        except HTTPError as exc:
            payload_obj = _decode_error_body(exc)
            raise DhanAPIError(
                f"Dhan API returned HTTP {exc.code}",
                status_code=exc.code,
                payload=payload_obj,
            ) from exc
        except URLError as exc:
            raise DhanAPIError(f"Dhan API connection failed: {exc.reason}") from exc
        except TimeoutError as exc:
            raise DhanAPIError("Dhan API request timed out") from exc
        except json.JSONDecodeError as exc:
            raise DhanAPIError("Dhan API returned non-JSON data") from exc


def _decode_error_body(exc: HTTPError) -> Any:
    try:
        text = exc.read().decode("utf-8", errors="replace")
    except Exception:
        return None
    if not text:
        return None
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return text[:500]


class DhanBroker:
    """Read-only Dhan adapter plus hard-guarded live-order placeholder.

    Current scope:
    - holdings, positions, funds, order book, trade book,
    - instrument master lookup,
    - daily historical candles.

    This class intentionally exposes no working order-placement method. The
    guard remains here for the later live phase, but all endpoints wired today
    are read-only.
    """

    def __init__(
        self,
        *,
        guard: DhanRuntimeGuard,
        client: DhanHTTPClient | None = None,
        client_id: str | None = None,
        access_token: str | None = None,
        cache_dir: Path | None = None,
    ) -> None:
        self.guard = guard
        self.client_id = client_id
        self.access_token = access_token
        self.cache_dir = cache_dir
        self.client = client
        if self.client is None and client_id and access_token:
            self.client = DhanHTTPClient(access_token=access_token, client_id=client_id)

    @classmethod
    def from_config(cls, config: AppConfig) -> DhanBroker:
        access_token, _source = DhanTokenManager(config).resolve_access_token()
        return cls(
            guard=DhanRuntimeGuard(
                mode=config.mode,
                auto_execution_enabled=config.auto_execution_enabled,
                client_id_present=config.dhan_client_id_present,
                access_token_present=bool(access_token),
            ),
            client_id=config.dhan_client_id,
            access_token=access_token,
            cache_dir=config.project_root / "data" / "dhan",
        )

    def status(self) -> dict[str, Any]:
        """Check read-only Dhan availability without returning private rows."""
        base = {
            "credentials": {
                "client_id_present": self.guard.client_id_present,
                "access_token_present": self.guard.access_token_present,
            },
            "mode": self.guard.mode,
            "auto_execution_enabled": self.guard.auto_execution_enabled,
            "read_only_guard": "enabled",
            "order_placement": "blocked",
            "endpoints": {},
        }
        if not self.guard.client_id_present or not self.guard.access_token_present:
            base["ok"] = False
            base["message"] = "Dhan credentials are not configured."
            return base

        endpoint_checks = {
            "funds": self.fund_limits,
            "holdings": self.holdings,
            "positions": self.positions,
            "orders": self.order_book,
            "trades": self.trade_book,
        }
        ok = True
        for name, method in endpoint_checks.items():
            try:
                data = method()
                base["endpoints"][name] = _summarize_response(data)
            except DhanAPIError as exc:
                ok = False
                base["endpoints"][name] = exc.public_payload()
            except Exception as exc:  # deliberately sanitized
                ok = False
                base["endpoints"][name] = {"ok": False, "error": str(exc)}
        base["ok"] = ok
        return base

    def holdings(self) -> list[dict[str, Any]]:
        self.guard.assert_read_allowed()
        try:
            data = self._client().get("/holdings")
        except DhanAPIError as exc:
            if _is_no_holdings_error(exc):
                return []
            raise
        return data if isinstance(data, list) else []

    def positions(self) -> list[dict[str, Any]]:
        self.guard.assert_read_allowed()
        data = self._client().get("/positions")
        return data if isinstance(data, list) else []

    def fund_limits(self) -> dict[str, Any]:
        self.guard.assert_read_allowed()
        data = self._client().get("/fundlimit")
        return data if isinstance(data, dict) else {}

    def order_book(self) -> list[dict[str, Any]]:
        self.guard.assert_read_allowed()
        data = self._client().get("/orders")
        return data if isinstance(data, list) else []

    def trade_book(self) -> list[dict[str, Any]]:
        self.guard.assert_read_allowed()
        data = self._client().get("/trades")
        return data if isinstance(data, list) else []

    def historical_daily(
        self,
        *,
        security_id: str,
        from_date: str,
        to_date: str,
        exchange_segment: str = "NSE_EQ",
        instrument: str = "EQUITY",
        oi: bool = False,
    ) -> dict[str, Any]:
        self.guard.assert_read_allowed()
        payload = {
            "securityId": str(security_id),
            "exchangeSegment": exchange_segment,
            "instrument": instrument,
            "expiryCode": 0,
            "oi": oi,
            "fromDate": from_date,
            "toDate": to_date,
        }
        data = self._client().post("/charts/historical", payload)
        return data if isinstance(data, dict) else {}

    def market_ltp(self, instruments_by_segment: dict[str, list[int | str]]) -> dict[str, Any]:
        self.guard.assert_read_allowed()
        payload: dict[str, list[int]] = {}
        for segment, security_ids in instruments_by_segment.items():
            normalized: list[int] = []
            for security_id in security_ids:
                try:
                    normalized.append(int(str(security_id).strip()))
                except (TypeError, ValueError):
                    continue
            if normalized:
                payload[str(segment).upper()] = normalized
        if not payload:
            return {"status": "empty", "data": {}}
        data = self._client().post("/marketfeed/ltp", payload)
        return data if isinstance(data, dict) else {}

    def nse_equity_instruments(
        self,
        *,
        symbol: str | None = None,
        limit: int = 50,
        force_refresh: bool = False,
    ) -> dict[str, Any]:
        path = self._instrument_master_path(force_refresh=force_refresh)
        rows: list[dict[str, Any]] = []
        wanted = symbol.upper().strip() if symbol else None
        with path.open("r", encoding="utf-8-sig", newline="") as handle:
            reader = csv.DictReader(handle)
            for row in reader:
                if not _is_nse_eq_row(row):
                    continue
                normalized = _normalize_instrument_row(row)
                if wanted and wanted not in {
                    normalized["symbol"],
                    normalized["underlying_symbol"],
                    normalized["display_name"].upper(),
                    normalized["name"].upper(),
                }:
                    continue
                rows.append(normalized)
                if len(rows) >= max(1, min(limit, 10000)):
                    break
        return {
            "ok": True,
            "source": "dhan_public_instrument_master",
            "cache_path": str(path),
            "symbol_filter": wanted,
            "count": len(rows),
            "instruments": rows,
        }

    def _instrument_master_path(self, *, force_refresh: bool = False) -> Path:
        cache_dir = self.cache_dir or Path("data") / "dhan"
        cache_dir.mkdir(parents=True, exist_ok=True)
        path = cache_dir / "api-scrip-master-detailed.csv"
        stale = not path.exists() or (time.time() - path.stat().st_mtime) > INSTRUMENT_CACHE_MAX_AGE_SECONDS
        if force_refresh or stale:
            request = Request(DHAN_INSTRUMENT_MASTER_URL, headers={"User-Agent": "TradingOS/0.1"})
            try:
                with urlopen(request, timeout=DEFAULT_TIMEOUT_SECONDS) as response:
                    path.write_bytes(response.read())
            except Exception as exc:
                if path.exists():
                    return path
                raise DhanAPIError(f"Unable to download Dhan instrument master: {exc}") from exc
        return path

    def _client(self) -> DhanHTTPClient:
        if not self.client:
            raise RuntimeError("Dhan HTTP client is not configured.")
        return self.client

    def place_order(self, *_args: Any, **_kwargs: Any) -> None:
        self.guard.assert_order_allowed()
        raise NotImplementedError("Dhan live order placement is intentionally not implemented in this phase.")


def _summarize_response(data: Any) -> dict[str, Any]:
    if isinstance(data, list):
        return {"ok": True, "type": "list", "count": len(data)}
    if isinstance(data, dict):
        return {"ok": True, "type": "object", "keys": sorted(data.keys())}
    return {"ok": True, "type": type(data).__name__}


def _is_no_holdings_error(exc: DhanAPIError) -> bool:
    payload = exc.payload if isinstance(exc.payload, dict) else {}
    return payload.get("errorCode") == "DH-1111" or "No holdings available" in str(payload)


def _is_nse_eq_row(row: dict[str, str]) -> bool:
    exchange = (row.get("EXCH_ID") or row.get("SEM_EXM_EXCH_ID") or "").upper()
    segment = (row.get("SEGMENT") or row.get("SEM_SEGMENT") or "").upper()
    series = (row.get("SERIES") or row.get("SEM_SERIES") or "").upper()
    instrument = (row.get("INSTRUMENT") or row.get("SEM_INSTRUMENT_NAME") or "").upper()
    return exchange == "NSE" and segment == "E" and series == "EQ" and instrument == "EQUITY"


def _normalize_instrument_row(row: dict[str, str]) -> dict[str, Any]:
    symbol = (row.get("UNDERLYING_SYMBOL") or row.get("DISPLAY_NAME") or row.get("SYMBOL_NAME") or "").strip()
    return {
        "exchange": row.get("EXCH_ID") or row.get("SEM_EXM_EXCH_ID"),
        "segment": row.get("SEGMENT") or row.get("SEM_SEGMENT"),
        "security_id": row.get("SECURITY_ID") or row.get("SEM_SMST_SECURITY_ID"),
        "isin": row.get("ISIN"),
        "symbol": symbol.upper(),
        "underlying_symbol": (row.get("UNDERLYING_SYMBOL") or "").strip().upper(),
        "name": row.get("SYMBOL_NAME") or row.get("SM_SYMBOL_NAME") or "",
        "display_name": row.get("DISPLAY_NAME") or row.get("SEM_CUSTOM_SYMBOL") or "",
        "instrument": row.get("INSTRUMENT") or row.get("SEM_INSTRUMENT_NAME"),
        "instrument_type": row.get("INSTRUMENT_TYPE") or row.get("SEM_EXCH_INSTRUMENT_TYPE"),
        "series": row.get("SERIES") or row.get("SEM_SERIES"),
        "lot_size": _float_or_none(row.get("LOT_SIZE") or row.get("SEM_LOT_UNITS")),
    }


def _float_or_none(value: str | None) -> float | None:
    if value in (None, ""):
        return None
    try:
        return float(value)
    except ValueError:
        return None


def build_query(params: dict[str, str]) -> str:
    return urlencode({key: value for key, value in params.items() if value})
