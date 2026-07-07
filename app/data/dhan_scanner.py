from __future__ import annotations

import calendar
import time
from collections import OrderedDict
from datetime import date, datetime, timedelta, timezone
from statistics import mean
from typing import Any
from zoneinfo import ZoneInfo

from ..broker.dhan import DhanAPIError, DhanBroker
from ..config import AppConfig, load_strategy_config
from .market_store import MarketDataStore


IST = ZoneInfo("Asia/Kolkata")
PROXY_SYMBOLS = {"NIFTYBEES", "GOLDBEES"}


class DhanEODScanner:
    """Dhan-backed EOD data engine and scanner.

    This service is read-only from Dhan's perspective. It downloads instrument
    metadata and historical candles, stores them locally, then calculates the
    Strategy 4 scanner state from local data.
    """

    def __init__(self, config: AppConfig) -> None:
        self.config = config
        self.strategy = load_strategy_config(config)
        self.broker = DhanBroker.from_config(config)
        self.store = MarketDataStore(config.database_path)

    def sync_instruments(self, *, force_refresh: bool = False) -> dict[str, Any]:
        data = self.broker.nse_equity_instruments(limit=10000, force_refresh=force_refresh)
        rows = []
        for row in data.get("instruments", []):
            symbol = str(row.get("symbol") or "").upper().strip()
            if not symbol:
                continue
            instrument_type = str(row.get("instrument_type") or "").upper()
            is_strategy_universe = instrument_type == "ES" and symbol not in PROXY_SYMBOLS
            rows.append({**row, "symbol": symbol, "is_strategy_universe": is_strategy_universe})
        saved = self.store.upsert_instruments(rows)
        counts = self.store.instrument_counts()
        return {
            "ok": True,
            "source": data.get("source"),
            "cache_path": data.get("cache_path"),
            "fetched_count": len(rows),
            "saved_count": saved,
            **counts,
        }

    def sync_history(
        self,
        *,
        symbols: list[str] | None = None,
        limit: int | None = 25,
        lookback_days: int = 550,
        from_date: str | None = None,
        to_date: str | None = None,
        sleep_seconds: float = 1.0,
        max_retries: int = 3,
        include_proxies: bool = True,
    ) -> dict[str, Any]:
        if self.store.instrument_counts()["total"] == 0:
            self.sync_instruments()

        selected = self._selected_instruments(symbols=symbols, limit=limit, include_proxies=include_proxies)
        requested_symbols = _requested_symbol_set(symbols=symbols, include_proxies=include_proxies)
        selected_symbols = {str(row["symbol"]).upper() for row in selected}
        missing_symbols = sorted(requested_symbols - selected_symbols) if requested_symbols else []
        today = date.today().isoformat()
        end = to_date or today
        failures: list[dict[str, Any]] = []
        results: list[dict[str, Any]] = []
        success_count = 0
        candle_count = 0

        for index, instrument in enumerate(selected, start=1):
            symbol = str(instrument["symbol"]).upper()
            security_id = str(instrument["security_id"])
            start = from_date or self._incremental_start(symbol=symbol, lookback_days=lookback_days)
            if start > end:
                results.append(
                    {
                        "symbol": symbol,
                        "security_id": security_id,
                        "status": "up_to_date",
                        "from": start,
                        "to": end,
                        "saved_candles": 0,
                    }
                )
                continue
            try:
                payload = self._historical_daily_with_retry(
                    security_id=security_id,
                    from_date=start,
                    to_date=end,
                    max_retries=max_retries,
                    sleep_seconds=sleep_seconds,
                )
                candles = normalize_dhan_daily_candles(symbol=symbol, security_id=security_id, payload=payload)
                saved = self.store.upsert_daily_candles(symbol, security_id, candles)
                latest = candles[-1]["date"] if candles else self.store.latest_candle_date(symbol)
                success_count += 1
                candle_count += saved
                results.append(
                    {
                        "symbol": symbol,
                        "security_id": security_id,
                        "status": "ok",
                        "from": start,
                        "to": end,
                        "saved_candles": saved,
                        "latest_date": latest,
                    }
                )
            except DhanAPIError as exc:
                if _is_dhan_no_data_error(exc) and self.store.latest_candle_date(symbol):
                    results.append(
                        {
                            "symbol": symbol,
                            "security_id": security_id,
                            "status": "no_new_data",
                            "from": start,
                            "to": end,
                            "saved_candles": 0,
                            "latest_date": self.store.latest_candle_date(symbol),
                        }
                    )
                    success_count += 1
                    continue
                failures.append({"symbol": symbol, "security_id": security_id, **exc.public_payload()})
            except Exception as exc:
                failures.append({"symbol": symbol, "security_id": security_id, "ok": False, "error": str(exc)})
            if sleep_seconds > 0 and index < len(selected):
                time.sleep(sleep_seconds)

        return {
            "ok": len(failures) == 0 and not missing_symbols,
            "requested_count": len(selected),
            "success_count": success_count,
            "failure_count": len(failures),
            "saved_candle_count": candle_count,
            "missing_symbols": missing_symbols,
            "results": results,
            "failures": failures,
        }

    def run_scan(
        self,
        *,
        symbols: list[str] | None = None,
        limit: int | None = 25,
        lookback_days: int = 550,
        from_date: str | None = None,
        to_date: str | None = None,
        as_of_date: str | None = None,
        sleep_seconds: float = 1.0,
        max_retries: int = 3,
        force_instruments: bool = False,
        sync: bool = True,
    ) -> dict[str, Any]:
        if force_instruments or self.store.instrument_counts()["total"] == 0:
            instrument_sync = self.sync_instruments(force_refresh=force_instruments)
        else:
            instrument_sync = {"ok": True, **self.store.instrument_counts()}

        history_sync = (
            self.sync_history(
                symbols=symbols,
                limit=limit,
                lookback_days=lookback_days,
                from_date=from_date,
                to_date=to_date,
                sleep_seconds=sleep_seconds,
                max_retries=max_retries,
            )
            if sync
            else {"ok": True, "requested_count": 0, "success_count": 0, "failure_count": 0, "saved_candle_count": 0}
        )

        scan_date = as_of_date or to_date or date.today().isoformat()
        as_of_month = previous_completed_month(scan_date)
        execution_month = month_add(as_of_month, 1)
        ranked = self.rankings(as_of_month=as_of_month)
        ranking_diagnostics = self.ranking_diagnostics(as_of_month=as_of_month)
        regime = self.regime(as_of_date=scan_date)
        status = "ok" if ranked and regime.get("ok") else "insufficient_data"
        if history_sync.get("failure_count"):
            status = "partial"
        if history_sync.get("missing_symbols"):
            status = "partial"
        if ranking_diagnostics.get("required_history_coverage", 0.0) < 0.90:
            status = "partial_coverage"

        payload = {
            "ok": status == "ok",
            "status": status,
            "as_of_date": scan_date,
            "as_of_month": as_of_month,
            "execution_month": execution_month,
            "universe_count": self.store.instrument_counts()["strategy_universe"],
            "instrument_sync": instrument_sync,
            "sync": history_sync,
            "ranking_diagnostics": ranking_diagnostics,
            "rankings": ranked[:21],
            "regime": regime,
            "data_source": "dhan_historical_daily_local_sqlite",
            "notes": [
                "Scanner is read-only and paper-safe.",
                "Prices are raw Dhan historical candles; corporate-action adjustment validation is still required before live use.",
            ],
        }
        run_id = self.store.save_scanner_run(payload=payload, rankings=ranked[:21], regime=regime)
        payload["run_id"] = run_id
        return payload

    def _historical_daily_with_retry(
        self,
        *,
        security_id: str,
        from_date: str,
        to_date: str,
        max_retries: int,
        sleep_seconds: float,
    ) -> dict[str, Any]:
        attempt = 0
        while True:
            try:
                return self.broker.historical_daily(security_id=security_id, from_date=from_date, to_date=to_date)
            except DhanAPIError as exc:
                attempt += 1
                if exc.status_code != 429 or attempt > max_retries:
                    raise
                time.sleep(max(2.0, sleep_seconds) * attempt)

    def rankings(self, *, as_of_month: str) -> list[dict[str, Any]]:
        filters = self.strategy.get("filters", {})
        min_turnover = _float_setting(filters, "min_avg_turnover_3m", 0.0)
        min_ret_1m = _float_setting(filters, "min_ret_1m", -999.0)
        max_roc = _float_setting(filters, "max_roc12", _float_setting(filters, "max_roc", 999.0))
        ref_month = month_add(as_of_month, -12)
        prev_month = month_add(as_of_month, -1)
        turnover_start = month_add(as_of_month, -2) + "-01"
        turnover_end = month_end(as_of_month)
        rows: list[dict[str, Any]] = []

        for instrument in self.store.instruments(strategy_only=True):
            symbol = instrument["symbol"]
            candles = self.store.candles(symbol, end_date=turnover_end)
            if not candles:
                continue
            monthly = monthly_last_candles(candles)
            asof = monthly.get(as_of_month)
            ref = monthly.get(ref_month)
            prev = monthly.get(prev_month)
            if not asof or not ref or not prev:
                continue
            close = float(asof["close"])
            ref_close = float(ref["close"])
            prev_close = float(prev["close"])
            if ref_close <= 0 or prev_close <= 0:
                continue
            roc_12 = close / ref_close - 1.0
            ret_1m = close / prev_close - 1.0
            turn_values = [
                float(row.get("turnover") or 0.0)
                for row in candles
                if turnover_start <= str(row["trade_date"]) <= turnover_end and float(row.get("turnover") or 0.0) > 0
            ]
            avg_turnover_3m = mean(turn_values) if turn_values else 0.0
            if avg_turnover_3m < min_turnover or ret_1m < min_ret_1m or roc_12 > max_roc:
                continue
            rows.append(
                {
                    "rank": 0,
                    "symbol": symbol,
                    "company": instrument.get("display_name") or instrument.get("name") or symbol,
                    "trade_date": asof["trade_date"],
                    "as_of_month": as_of_month,
                    "execution_month": month_add(as_of_month, 1),
                    "close": close,
                    "roc_12": roc_12,
                    "ret_1m": ret_1m,
                    "avg_turnover_3m": avg_turnover_3m,
                    "reference_month": ref_month,
                    "reference_close": ref_close,
                }
            )

        rows.sort(key=lambda row: row["roc_12"], reverse=True)
        for index, row in enumerate(rows, start=1):
            row["rank"] = index
        return rows

    def ranking_diagnostics(self, *, as_of_month: str) -> dict[str, Any]:
        ref_month = month_add(as_of_month, -12)
        prev_month = month_add(as_of_month, -1)
        turnover_start = month_add(as_of_month, -2) + "-01"
        turnover_end = month_end(as_of_month)
        total = 0
        with_any_candles = 0
        with_asof_month = 0
        with_reference_month = 0
        with_previous_month = 0
        with_required_history = 0
        with_turnover_window = 0
        for instrument in self.store.instruments(strategy_only=True):
            total += 1
            candles = self.store.candles(instrument["symbol"], end_date=turnover_end)
            if candles:
                with_any_candles += 1
            monthly = monthly_last_candles(candles)
            has_asof = as_of_month in monthly
            has_ref = ref_month in monthly
            has_prev = prev_month in monthly
            if has_asof:
                with_asof_month += 1
            if has_ref:
                with_reference_month += 1
            if has_prev:
                with_previous_month += 1
            if has_asof and has_ref and has_prev:
                with_required_history += 1
            if any(turnover_start <= str(row["trade_date"]) <= turnover_end for row in candles):
                with_turnover_window += 1
        coverage = with_required_history / total if total else 0.0
        return {
            "as_of_month": as_of_month,
            "reference_month": ref_month,
            "previous_month": prev_month,
            "total_strategy_universe": total,
            "with_any_candles": with_any_candles,
            "with_asof_month": with_asof_month,
            "with_reference_month": with_reference_month,
            "with_previous_month": with_previous_month,
            "with_required_history": with_required_history,
            "with_turnover_window": with_turnover_window,
            "required_history_coverage": coverage,
            "production_ready": coverage >= 0.90,
        }

    def regime(self, *, as_of_date: str) -> dict[str, Any]:
        strategy_instruments = self.store.instruments(strategy_only=True)
        breadth_count = 0
        breadth_above = 0
        for instrument in strategy_instruments:
            candles = self.store.candles(instrument["symbol"], end_date=as_of_date)
            weekly = weekly_last_closes(candles)
            if len(weekly) < 30:
                continue
            close = weekly[-1]["close"]
            sma = mean(row["close"] for row in weekly[-30:])
            breadth_count += 1
            if close > sma:
                breadth_above += 1

        breadth = breadth_above / breadth_count if breadth_count else None
        nifty = self._proxy_weekly("NIFTYBEES", as_of_date=as_of_date, weeks=30)
        gold = self._proxy_weekly("GOLDBEES", as_of_date=as_of_date, weeks=20)
        previous_risk_on = self.store.previous_regime_risk_on()
        thresholds = self.strategy.get("market_regime", {})
        breadth_off = float(thresholds.get("breadth_risk_off_below") or 0.35)
        breadth_on = float(thresholds.get("breadth_risk_on_at_or_above") or 0.50)
        nifty_above = bool(nifty.get("above"))
        risk_on, reason = regime_state_with_hysteresis(
            nifty_above=nifty_above,
            breadth=breadth,
            previous_risk_on=previous_risk_on,
            breadth_off=breadth_off,
            breadth_on=breadth_on,
        )
        return {
            "ok": nifty.get("ok") and breadth is not None,
            "as_of_date": as_of_date,
            "risk_on": risk_on,
            "state": "Risk On" if risk_on else "Risk Off",
            "reason": reason,
            "breadth_30w": breadth,
            "count_30w": breadth_count,
            "niftybees_close": nifty.get("close"),
            "niftybees_sma_30w": nifty.get("sma"),
            "niftybees_above_30w": nifty.get("above"),
            "goldbees_close": gold.get("close"),
            "goldbees_sma_20w": gold.get("sma"),
            "goldbees_above_20w": gold.get("above"),
            "previous_risk_on": previous_risk_on,
        }

    def latest(self) -> dict[str, Any]:
        latest = self.store.latest_scanner_run()
        if latest:
            return {"ok": True, **latest}
        return {"ok": False, "message": "No Dhan scanner run is stored yet."}

    def instrument_status(self, *, limit: int = 50) -> dict[str, Any]:
        counts = self.store.instrument_counts()
        stats = self.store.candle_stats()
        stats_by_symbol = {row["symbol"]: row for row in stats}
        instruments = self.store.instruments(strategy_only=False, limit=limit)
        return {
            "ok": True,
            **counts,
            "sample": [
                {
                    "symbol": row["symbol"],
                    "security_id": row["security_id"],
                    "instrument_type": row.get("instrument_type"),
                    "is_strategy_universe": bool(row.get("is_strategy_universe")),
                    **stats_by_symbol.get(row["symbol"], {}),
                }
                for row in instruments
            ],
        }

    def candle_status(self, *, symbols: list[str] | None = None) -> dict[str, Any]:
        return {"ok": True, "stats": self.store.candle_stats(symbols=symbols)}

    def _selected_instruments(
        self,
        *,
        symbols: list[str] | None,
        limit: int | None,
        include_proxies: bool,
    ) -> list[dict[str, Any]]:
        if symbols:
            wanted = [symbol.upper().strip() for symbol in symbols if symbol.strip()]
            if include_proxies:
                wanted = list(OrderedDict.fromkeys([*wanted, *sorted(PROXY_SYMBOLS)]))
            return self.store.instruments(symbols=wanted)

        rows = self.store.instruments(strategy_only=True, limit=limit if limit and limit > 0 else None)
        if include_proxies:
            proxies = self.store.instruments(symbols=sorted(PROXY_SYMBOLS))
            existing = {row["symbol"] for row in rows}
            rows.extend(row for row in proxies if row["symbol"] not in existing)
        return rows

    def _incremental_start(self, *, symbol: str, lookback_days: int) -> str:
        latest = self.store.latest_candle_date(symbol)
        if latest:
            return (date.fromisoformat(latest) + timedelta(days=1)).isoformat()
        return (date.today() - timedelta(days=lookback_days)).isoformat()

    def _proxy_weekly(self, symbol: str, *, as_of_date: str, weeks: int) -> dict[str, Any]:
        candles = self.store.candles(symbol, end_date=as_of_date)
        weekly = weekly_last_closes(candles)
        if len(weekly) < weeks:
            return {"ok": False, "symbol": symbol, "reason": f"Need {weeks} weekly closes; found {len(weekly)}"}
        close = weekly[-1]["close"]
        sma = mean(row["close"] for row in weekly[-weeks:])
        return {
            "ok": True,
            "symbol": symbol,
            "date": weekly[-1]["date"],
            "close": close,
            "sma": sma,
            "above": close > sma,
        }


def normalize_dhan_daily_candles(symbol: str, security_id: str, payload: dict[str, Any]) -> list[dict[str, Any]]:
    arrays = payload if isinstance(payload, dict) else {}
    timestamps = arrays.get("timestamp") or []
    opens = arrays.get("open") or []
    highs = arrays.get("high") or []
    lows = arrays.get("low") or []
    closes = arrays.get("close") or []
    volumes = arrays.get("volume") or []
    candles: list[dict[str, Any]] = []
    count = min(len(timestamps), len(opens), len(highs), len(lows), len(closes), len(volumes))
    for index in range(count):
        close = float(closes[index])
        volume = float(volumes[index])
        candles.append(
            {
                "symbol": symbol.upper().strip(),
                "security_id": str(security_id),
                "date": datetime.fromtimestamp(float(timestamps[index]), timezone.utc).astimezone(IST).date().isoformat(),
                "open": float(opens[index]),
                "high": float(highs[index]),
                "low": float(lows[index]),
                "close": close,
                "volume": volume,
                "turnover": close * volume,
                "source": "dhan_historical_daily",
            }
        )
    candles.sort(key=lambda row: row["date"])
    return candles


def monthly_last_candles(candles: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    monthly: dict[str, dict[str, Any]] = {}
    for row in candles:
        trade_date = str(row["trade_date"])
        monthly[trade_date[:7]] = row
    return monthly


def weekly_last_closes(candles: list[dict[str, Any]]) -> list[dict[str, Any]]:
    weekly: OrderedDict[tuple[int, int], dict[str, Any]] = OrderedDict()
    for row in candles:
        trade_date = date.fromisoformat(str(row["trade_date"]))
        key = (trade_date.isocalendar().year, trade_date.isocalendar().week)
        weekly[key] = {"date": trade_date.isoformat(), "close": float(row["close"])}
    return list(weekly.values())


def previous_completed_month(as_of_date: str) -> str:
    parsed = date.fromisoformat(as_of_date)
    first_of_month = parsed.replace(day=1)
    previous = first_of_month - timedelta(days=1)
    return previous.strftime("%Y-%m")


def month_add(yyyy_mm: str, months: int) -> str:
    year, month = [int(part) for part in yyyy_mm.split("-")]
    total = year * 12 + (month - 1) + months
    return f"{total // 12:04d}-{(total % 12) + 1:02d}"


def month_end(yyyy_mm: str) -> str:
    year, month = [int(part) for part in yyyy_mm.split("-")]
    return f"{yyyy_mm}-{calendar.monthrange(year, month)[1]:02d}"


def regime_state_with_hysteresis(
    *,
    nifty_above: bool,
    breadth: float | None,
    previous_risk_on: bool | None,
    breadth_off: float,
    breadth_on: float,
) -> tuple[bool, str]:
    reasons: list[str] = []
    if not nifty_above:
        reasons.append("NIFTYBEES below 30W SMA")
    if breadth is None:
        reasons.append("Breadth unavailable")
        return False, "; ".join(reasons)
    if breadth < breadth_off:
        reasons.append(f"Breadth below {breadth_off:.0%} risk-off threshold")
        return False, "; ".join(reasons)
    if previous_risk_on is False:
        if nifty_above and breadth >= breadth_on:
            return True, "Recovered: NIFTYBEES above 30W SMA and breadth at/above recovery threshold"
        reasons.append(f"Breadth below {breadth_on:.0%} recovery threshold")
        return False, "; ".join(reasons)
    if previous_risk_on is True:
        if nifty_above and breadth >= breadth_off:
            return True, "Risk-on maintained by hysteresis"
        return False, "; ".join(reasons) or "Risk-off trigger active"
    if nifty_above and breadth >= breadth_on:
        return True, "NIFTYBEES above 30W SMA and breadth at/above recovery threshold"
    if breadth < breadth_on:
        reasons.append(f"Breadth below {breadth_on:.0%} recovery threshold")
    return False, "; ".join(reasons)


def _float_setting(values: dict[str, Any], key: str, default: float) -> float:
    value = values.get(key)
    if value in (None, ""):
        return default
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _is_dhan_no_data_error(exc: DhanAPIError) -> bool:
    payload = exc.payload if isinstance(exc.payload, dict) else {}
    message = str(payload.get("errorMessage") or payload)
    return exc.status_code == 400 and "no data present" in message.lower()


def _requested_symbol_set(*, symbols: list[str] | None, include_proxies: bool) -> set[str]:
    requested = {symbol.upper().strip() for symbol in symbols or [] if symbol.strip()}
    if include_proxies:
        requested.update(PROXY_SYMBOLS)
    return requested
