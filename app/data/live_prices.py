from __future__ import annotations

import time
from typing import Any

from ..broker.dhan import DhanAPIError, DhanBroker
from ..config import AppConfig
from ..storage import StateStore
from .market_store import MarketDataStore


LIVE_LTP_CACHE_KEY = "live_ltp_cache"
LIVE_LTP_CACHE_MAX_AGE_SECONDS = 5


class LivePriceService:
    """Read-only live LTP overlay for portfolio mark-to-market.

    Strategy selection remains monthly/EOD. This service is only meant to
    refresh current portfolio P&L where a live quote is available.
    """

    def __init__(self, config: AppConfig) -> None:
        self.config = config
        self.market_store = MarketDataStore(config.database_path)
        self.state_store = StateStore(config.database_path)

    def ltp_for_symbols(self, symbols: list[str]) -> dict[str, Any]:
        normalized_symbols = _dedupe_symbols(symbols)
        if not normalized_symbols:
            return {
                "ok": True,
                "source": "dhan_marketfeed_ltp",
                "prices": {},
                "missing": [],
                "errors": [],
            }

        cached = self._cached_prices(normalized_symbols)
        if cached:
            return cached

        instruments: dict[str, dict[str, Any]] = {}
        missing: list[str] = []
        for symbol in normalized_symbols:
            instrument = self.market_store.instrument(symbol)
            if not instrument or not instrument.get("security_id"):
                missing.append(symbol)
                continue
            instruments[symbol] = instrument

        by_segment: dict[str, list[str]] = {}
        symbol_by_segment_security: dict[tuple[str, str], str] = {}
        for symbol, instrument in instruments.items():
            segment = _quote_segment(instrument)
            security_id = str(instrument.get("security_id") or "").strip()
            if not security_id:
                missing.append(symbol)
                continue
            by_segment.setdefault(segment, []).append(security_id)
            symbol_by_segment_security[(segment, security_id)] = symbol

        if not by_segment:
            return {
                "ok": False,
                "source": "dhan_marketfeed_ltp",
                "prices": {},
                "missing": sorted(set(missing)),
                "errors": ["No security IDs available for live LTP lookup."],
            }

        try:
            response = DhanBroker.from_config(self.config).market_ltp(by_segment)
        except DhanAPIError as exc:
            return {
                "ok": False,
                "source": "dhan_marketfeed_ltp",
                "prices": {},
                "missing": sorted(set(missing)),
                "errors": [str(exc)],
                "error_payload": exc.public_payload(),
            }
        except Exception as exc:
            return {
                "ok": False,
                "source": "dhan_marketfeed_ltp",
                "prices": {},
                "missing": sorted(set(missing)),
                "errors": [str(exc)],
            }

        prices: dict[str, dict[str, Any]] = {}
        payload = response.get("data") if isinstance(response, dict) else {}
        if isinstance(payload, dict):
            for segment, segment_rows in payload.items():
                if not isinstance(segment_rows, dict):
                    continue
                for security_id, row in segment_rows.items():
                    if not isinstance(row, dict):
                        continue
                    symbol = symbol_by_segment_security.get((str(segment).upper(), str(security_id)))
                    if not symbol:
                        continue
                    ltp = _float_or_none(row.get("last_price"))
                    if ltp is None or ltp <= 0:
                        continue
                    prices[symbol] = {
                        "symbol": symbol,
                        "ltp": ltp,
                        "security_id": str(security_id),
                        "segment": str(segment).upper(),
                        "source": "dhan_marketfeed_ltp",
                    }

        unresolved = sorted(set(normalized_symbols) - set(prices))
        result = {
            "ok": bool(prices),
            "source": "dhan_marketfeed_ltp",
            "status": response.get("status") if isinstance(response, dict) else None,
            "prices": prices,
            "missing": sorted(set(missing) | set(unresolved)),
            "errors": [] if prices else ["Dhan LTP response did not include usable prices."],
        }
        if prices:
            self._store_cache(prices)
        return result

    def _cached_prices(self, symbols: list[str]) -> dict[str, Any] | None:
        payload = self.state_store.get_value(LIVE_LTP_CACHE_KEY, {})
        if not isinstance(payload, dict):
            return None
        generated_epoch = payload.get("generated_epoch")
        try:
            age_seconds = time.time() - float(generated_epoch)
        except (TypeError, ValueError):
            return None
        if age_seconds > LIVE_LTP_CACHE_MAX_AGE_SECONDS:
            return None
        all_prices = payload.get("prices")
        if not isinstance(all_prices, dict):
            return None
        subset = {symbol: all_prices[symbol] for symbol in symbols if symbol in all_prices}
        if set(subset) != set(symbols):
            return None
        return {
            "ok": True,
            "source": "dhan_marketfeed_ltp_cache",
            "status": "cached",
            "prices": subset,
            "missing": [],
            "errors": [],
            "cache": {
                "age_seconds": age_seconds,
                "max_age_seconds": LIVE_LTP_CACHE_MAX_AGE_SECONDS,
            },
        }

    def _store_cache(self, prices: dict[str, dict[str, Any]]) -> None:
        payload = self.state_store.get_value(LIVE_LTP_CACHE_KEY, {})
        all_prices = payload.get("prices") if isinstance(payload, dict) and isinstance(payload.get("prices"), dict) else {}
        all_prices.update(prices)
        self.state_store.set_value(
            LIVE_LTP_CACHE_KEY,
            {
                "generated_epoch": time.time(),
                "prices": all_prices,
            },
        )


def _quote_segment(instrument: dict[str, Any]) -> str:
    exchange = str(instrument.get("exchange") or "").upper().strip()
    segment = str(instrument.get("segment") or "").upper().strip()
    if exchange == "NSE" and segment in {"E", "EQ", "NSE_EQ"}:
        return "NSE_EQ"
    if exchange == "BSE" and segment in {"E", "EQ", "BSE_EQ"}:
        return "BSE_EQ"
    return "NSE_EQ"


def _dedupe_symbols(symbols: list[str]) -> list[str]:
    output: list[str] = []
    for symbol in symbols:
        normalized = str(symbol or "").upper().strip()
        if normalized and normalized not in output:
            output.append(normalized)
    return output


def _float_or_none(value: object) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None
