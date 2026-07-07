from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from ..config import AppConfig, get_config
from ..strategy.rebalance_calendar import load_holidays


NSE_HOLIDAY_URL = "https://www.nseindia.com/api/holiday-master?type=trading"
NSE_HOLIDAY_REFERER = "https://www.nseindia.com/resources/exchange-communication-holidays"
DEFAULT_SEGMENT = "CM"


class NSEHolidaySyncError(RuntimeError):
    pass


def holiday_config_path(config: AppConfig | None = None) -> Path:
    cfg = config or get_config()
    return cfg.project_root / "config" / "nse_holidays.json"


def holiday_status(config: AppConfig | None = None) -> dict[str, Any]:
    path = holiday_config_path(config)
    payload = _read_json(path)
    holidays = sorted(load_holidays(path))
    return {
        "ok": bool(holidays),
        "path": str(path),
        "source": payload.get("source"),
        "source_url": payload.get("source_url"),
        "segment": payload.get("segment", DEFAULT_SEGMENT),
        "synced_at": payload.get("synced_at"),
        "holiday_count": len(holidays),
        "holidays": payload.get("holidays", []),
    }


def sync_holidays(config: AppConfig | None = None, *, segment: str = DEFAULT_SEGMENT) -> dict[str, Any]:
    cfg = config or get_config()
    path = holiday_config_path(cfg)
    payload = fetch_nse_holidays(segment=segment)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return {"ok": True, "path": str(path), **holiday_status(cfg)}


def fetch_nse_holidays(*, segment: str = DEFAULT_SEGMENT) -> dict[str, Any]:
    try:
        raw = _fetch_json(NSE_HOLIDAY_URL)
    except (HTTPError, URLError, TimeoutError, OSError) as exc:
        raise NSEHolidaySyncError(f"Unable to fetch NSE holiday calendar: {exc}") from exc

    if not isinstance(raw, dict):
        raise NSEHolidaySyncError("NSE holiday response was not a JSON object.")

    rows = raw.get(segment)
    if not isinstance(rows, list):
        available = ", ".join(sorted(str(key) for key in raw.keys()))
        raise NSEHolidaySyncError(f"NSE holiday segment {segment!r} not found. Available: {available}")

    holidays = [_normalize_holiday_row(row) for row in rows if isinstance(row, dict)]
    holidays = sorted(holidays, key=lambda item: item["date"])
    return {
        "source": "NSE holiday-master API",
        "source_url": NSE_HOLIDAY_URL,
        "source_referer": NSE_HOLIDAY_REFERER,
        "segment": segment,
        "market": "NSE Capital Market",
        "synced_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        "holidays": holidays,
    }


def _fetch_json(url: str) -> Any:
    request = Request(
        url,
        headers={
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/126.0 Safari/537.36"
            ),
            "Accept": "application/json,text/plain,*/*",
            "Referer": NSE_HOLIDAY_REFERER,
        },
    )
    with urlopen(request, timeout=30) as response:
        body = response.read().decode("utf-8")
    return json.loads(body)


def _normalize_holiday_row(row: dict[str, Any]) -> dict[str, Any]:
    raw_date = str(row.get("tradingDate") or "").strip()
    if not raw_date:
        raise NSEHolidaySyncError(f"NSE holiday row missing tradingDate: {row}")
    date_value = datetime.strptime(raw_date, "%d-%b-%Y").date()
    return {
        "date": date_value.isoformat(),
        "weekday": str(row.get("weekDay") or date_value.strftime("%A")),
        "description": str(row.get("description") or "").strip(),
    }


def _read_json(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return payload if isinstance(payload, dict) else {}
