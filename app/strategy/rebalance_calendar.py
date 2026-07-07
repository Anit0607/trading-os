from __future__ import annotations

import json
from datetime import date, timedelta
from pathlib import Path
from typing import Any


def load_holidays(path: Path) -> set[date]:
    """Load NSE holiday dates from a local JSON file.

    Expected shapes:
      {"holidays": ["2026-01-26", "2026-03-04"]}
      {"holidays": [{"date": "2026-01-26", "description": "Republic Day"}]}

    If the file is missing or malformed, return an empty set. The live phase
    should replace this with an official NSE holiday-calendar sync.
    """

    if not path.exists():
        return set()
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return set()
    values = payload.get("holidays") if isinstance(payload, dict) else []
    holidays: set[date] = set()
    for value in values or []:
        if isinstance(value, dict):
            value = value.get("date")
        try:
            holidays.add(date.fromisoformat(str(value)))
        except ValueError:
            continue
    return holidays


def is_trading_day(day: date, holidays: set[date]) -> bool:
    return day.weekday() < 5 and day not in holidays


def first_trading_day(year_month: str, holidays: set[date]) -> date:
    year, month = [int(part) for part in year_month.split("-")]
    day = date(year, month, 1)
    while not is_trading_day(day, holidays):
        day += timedelta(days=1)
    return day


def rebalance_day_status(
    *,
    today: date,
    execution_month: str,
    last_completed_month: str | None,
    holidays: set[date],
) -> dict[str, Any]:
    current_month = today.strftime("%Y-%m")
    first_day = first_trading_day(execution_month, holidays)

    if last_completed_month == execution_month:
        return {
            "allowed": False,
            "reason": f"Monthly rebalance already completed for {execution_month}.",
            "today": today.isoformat(),
            "execution_month": execution_month,
            "first_trading_day": first_day.isoformat(),
            "last_completed_month": last_completed_month,
        }

    if current_month != execution_month:
        return {
            "allowed": False,
            "reason": f"Scanner execution month {execution_month} does not match current month {current_month}.",
            "today": today.isoformat(),
            "execution_month": execution_month,
            "first_trading_day": first_day.isoformat(),
            "last_completed_month": last_completed_month,
        }

    if today != first_day:
        return {
            "allowed": False,
            "reason": f"Today is not the first trading day for {execution_month}.",
            "today": today.isoformat(),
            "execution_month": execution_month,
            "first_trading_day": first_day.isoformat(),
            "last_completed_month": last_completed_month,
        }

    return {
        "allowed": True,
        "reason": f"Today is the first trading day for {execution_month}.",
        "today": today.isoformat(),
        "execution_month": execution_month,
        "first_trading_day": first_day.isoformat(),
        "last_completed_month": last_completed_month,
    }
