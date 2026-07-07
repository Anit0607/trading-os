from __future__ import annotations

import csv
from collections import Counter
from pathlib import Path
from typing import Any


TARGET_SCENARIO = "PDD 16%/7%: 7 stocks + GOLD | 0.50%"
PRIOR_SCENARIO = "Prior Robust | 0.50%"
ROBUST_FILTER_KEY = "min_avg_turnover_3m=1e+07|min_ret_1m=0|max_roc=5"
INITIAL_CAPITAL = 1_000_000.0


def _read_csv(path: Path) -> list[dict[str, str]]:
    if not path.exists():
        return []
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


def _float(value: Any, default: float | None = None) -> float | None:
    if value in (None, "", "nan", "NaN"):
        return default
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _bool(value: Any) -> bool | None:
    if value is None or value == "":
        return None
    return str(value).strip().lower() in {"true", "1", "yes"}


class ReferenceDataLoader:
    """Reads the final backtest output as a reference/demo data source.

    This is not the final live data layer. It lets the Trading OS boot safely
    before Dhan read-only/live connectors are attached.
    """

    def __init__(self, result_dir: Path) -> None:
        self.result_dir = result_dir

    def metrics(self) -> dict[str, Any]:
        rows = _read_csv(self.result_dir / "scenario_metrics.csv")
        selected = next((row for row in rows if row.get("scenario") == TARGET_SCENARIO), {})
        prior = next((row for row in rows if row.get("scenario") == PRIOR_SCENARIO), {})
        return {
            "selected": self._metric_payload(selected),
            "prior": self._metric_payload(prior),
        }

    def _metric_payload(self, row: dict[str, str]) -> dict[str, Any]:
        return {
            "scenario": row.get("scenario", ""),
            "variant": row.get("variant", ""),
            "final_value": _float(row.get("final_value"), 0.0),
            "cagr": _float(row.get("cagr"), 0.0),
            "max_drawdown_pct": _float(row.get("max_drawdown_pct"), 0.0),
            "monte_carlo_p95_mdd": _float(row.get("worst_case_mdd"), 0.0),
            "sharpe_ratio": _float(row.get("sharpe_ratio"), 0.0),
            "expectancy_ratio": _float(row.get("expectancy_ratio"), 0.0),
            "win_pct": _float(row.get("win_pct"), 0.0),
            "trades": int(_float(row.get("no_of_trades"), 0) or 0),
        }

    def equity(self) -> dict[str, Any]:
        rows = [
            row
            for row in _read_csv(self.result_dir / "equity_curves.csv")
            if row.get("scenario") == TARGET_SCENARIO
        ]
        rows.sort(key=lambda row: row["date"])
        peak = INITIAL_CAPITAL
        max_drawdown = 0.0
        points: list[dict[str, Any]] = []
        for row in rows:
            equity = _float(row.get("equity"), 0.0) or 0.0
            peak = max(peak, equity)
            drawdown = 1.0 - equity / peak if peak else 0.0
            max_drawdown = max(max_drawdown, drawdown)
            points.append({"date": row["date"], "equity": equity, "drawdown": drawdown})
        latest = points[-1] if points else {"date": "", "equity": INITIAL_CAPITAL, "drawdown": 0.0}
        return {
            "latest_date": latest["date"],
            "latest_equity": latest["equity"],
            "equity_peak": peak,
            "current_drawdown": latest["drawdown"],
            "max_drawdown_seen": max_drawdown,
            "series": points[-260:],
        }

    def ranks(self) -> list[dict[str, Any]]:
        rows = [
            row
            for row in _read_csv(self.result_dir / "monthly_rankings_top21.csv")
            if row.get("filter_key") == ROBUST_FILTER_KEY
        ]
        if not rows:
            return []
        latest_month = max(row["execution_month"] for row in rows)
        latest = [row for row in rows if row["execution_month"] == latest_month]
        latest.sort(key=lambda row: int(row["rank"]))
        return [
            {
                "execution_month": row["execution_month"],
                "as_of_month": row["as_of_month"],
                "rank": int(row["rank"]),
                "symbol": row["symbol"],
                "company": row.get("company") or row["symbol"],
                "ltp": _float(row.get("raw_close"), 0.0),
                "roc_12": _float(row.get("roc_12"), 0.0),
                "ret_1m": _float(row.get("ret_1m"), 0.0),
                "avg_turnover_3m": _float(row.get("avg_turnover_3m"), 0.0),
            }
            for row in latest
        ]

    def regime(self) -> dict[str, Any]:
        rows = _read_csv(self.result_dir / "weekly_regime.csv")
        usable = [row for row in rows if row.get("niftybees_close") and row.get("niftybees_sma_30w") and row.get("breadth_30w")]
        if not usable:
            return {
                "as_of": "",
                "risk_on": False,
                "reason": "No usable regime row found",
            }
        row = usable[-1]
        breadth = _float(row.get("breadth_30w"), 0.0) or 0.0
        nifty_above_30w = _bool(row.get("niftybees_above_30w"))
        risk_on = bool(nifty_above_30w and breadth >= 0.50)
        reasons = []
        if not nifty_above_30w:
            reasons.append("NIFTYBEES below 30W SMA")
        if breadth < 0.50:
            reasons.append("Breadth below 50% recovery threshold")
        return {
            "as_of": row.get("week_end", ""),
            "risk_on": risk_on,
            "state": "Risk On" if risk_on else "Risk Off",
            "reason": "; ".join(reasons) if reasons else "NIFTYBEES and breadth are healthy",
            "breadth_30w": breadth,
            "niftybees_close": _float(row.get("niftybees_close"), 0.0),
            "niftybees_sma_30w": _float(row.get("niftybees_sma_30w"), 0.0),
            "niftybees_above_30w": nifty_above_30w,
            "goldbees_above_20w": _bool(row.get("goldbees_above_20w")),
        }

    def trade_summary(self) -> dict[str, Any]:
        rows = [
            row
            for row in _read_csv(self.result_dir / "trade_log.csv")
            if row.get("scenario") == TARGET_SCENARIO
        ]
        by_reason = Counter(row.get("exit_reason", "UNKNOWN") for row in rows)
        latest = sorted(rows, key=lambda row: row.get("exit_date", ""))[-10:]
        return {
            "total_trades": len(rows),
            "by_exit_reason": dict(by_reason),
            "latest_trades": [
                {
                    "symbol": row.get("symbol"),
                    "entry_date": row.get("entry_date"),
                    "exit_date": row.get("exit_date"),
                    "type": "SELL",
                    "quantity": int(_float(row.get("exit_shares"), 0) or 0),
                    "price": _float(row.get("exit_price"), 0.0),
                    "profit": _float(row.get("profit"), 0.0),
                    "return_pct": _float(row.get("return_pct"), 0.0),
                    "exit_reason": row.get("exit_reason"),
                    "status": "FILLED",
                }
                for row in latest
            ],
        }
