from __future__ import annotations

from datetime import datetime
from typing import Any

from ..broker.dhan import DhanAPIError
from ..broker.snapshot import BrokerSnapshotService, normalize_broker_funds, normalize_broker_holding
from ..config import AppConfig, load_strategy_config


class PortfolioReconciler:
    """Compare Dhan read-only portfolio state with Strategy 4 targets.

    This service is intentionally planning-only. It never places, modifies, or
    cancels orders. Its job is to make the dashboard say, "actual vs desired".
    """

    def __init__(self, config: AppConfig) -> None:
        self.config = config
        self.strategy = load_strategy_config(config)
        self.broker_snapshot = BrokerSnapshotService(config)

    def snapshot(self, strategy_snapshot: dict[str, Any]) -> dict[str, Any]:
        ranks = strategy_snapshot.get("ranks", [])
        regime = strategy_snapshot.get("regime", {})
        pdd = strategy_snapshot.get("pdd", {})
        target_sleeves = strategy_snapshot.get("target_sleeves", [])
        desired = self._desired_symbols(target_sleeves)
        retain = self._retain_symbols(ranks, regime, pdd)
        paper_state = self._paper_state(strategy_snapshot)
        dhan_state = self._read_dhan_state()
        holdings = dhan_state["holdings"]
        funds = dhan_state["funds"]

        broker_symbols = {row["symbol"] for row in holdings if row["symbol"] and row["quantity"] > 0}
        paper_symbols = set(paper_state["symbols"])
        desired_symbols = {row["symbol"] for row in desired}

        exits = self._planned_exits(holdings, retain)
        entries = self._planned_entries(desired, broker_symbols, funds, ranks)
        comparison = self._comparison(
            broker_holdings=holdings,
            broker_symbols=broker_symbols,
            desired_symbols=desired_symbols,
            paper_holdings=paper_state["holdings"],
            paper_symbols=paper_symbols,
            retain_symbols=retain,
        )

        return {
            "generated_at": datetime.now().isoformat(timespec="seconds"),
            "mode": self.config.mode,
            "read_only": True,
            "live_order_placement": "blocked",
            "dhan": {
                "ok": dhan_state["ok"],
                "source": dhan_state["source"],
                "message": dhan_state["message"],
                "endpoint_status": dhan_state["endpoint_status"],
                "cache": dhan_state.get("cache", {}),
            },
            "strategy": {
                "name": strategy_snapshot.get("strategy_name"),
                "target_symbols": [row["symbol"] for row in desired],
                "retain_symbols": sorted(retain),
                "risk_on": bool(regime.get("risk_on")),
                "market_regime": regime.get("state"),
                "pdd_state": pdd.get("state"),
                "hold_buffer_rank": self.strategy["hold_buffer_rank"],
            },
            "actual": {
                "holdings": holdings,
                "symbols": sorted(broker_symbols),
                "funds": funds,
            },
            "paper": paper_state,
            "comparison": comparison,
            "pending_actions": {
                "exits": exits,
                "entries": entries,
            },
            "summary": {
                "broker_holding_count": len(broker_symbols),
                "actual_holding_count": len(broker_symbols),
                "paper_holding_count": len(paper_symbols),
                "target_symbol_count": len(desired_symbols),
                "pending_exit_count": len(exits),
                "pending_entry_count": len(entries),
                "available_cash": funds.get("available_cash", 0.0),
                "paper_cash": paper_state["summary"].get("cash", 0.0),
                "paper_equity": paper_state["summary"].get("equity", 0.0),
                "paper_drawdown": paper_state["summary"].get("current_drawdown", 0.0),
                "all_targets_present": desired_symbols.issubset(broker_symbols),
                "paper_targets_present": desired_symbols.issubset(paper_symbols),
                "broker_matches_paper": comparison["broker_vs_paper"]["ok"],
                "paper_matches_strategy": comparison["paper_vs_strategy"]["ok"],
                "quantity_mismatch_count": len(comparison["quantity_mismatches"]),
                "gap_count": comparison["gap_count"],
            },
            "notes": self._notes(dhan_state, exits, entries, paper_state, comparison),
        }

    def apply_to_dashboard_ui(self, dashboard: dict[str, Any], reconciliation: dict[str, Any]) -> None:
        """Add reconciliation signals into the existing UI contract in-place."""
        ui = dashboard.get("ui") or {}
        dhan = reconciliation["dhan"]
        cache = dhan.get("cache") if isinstance(dhan.get("cache"), dict) else {}
        ui["dhan_mirror"] = {
            "ok": bool(dhan.get("ok")),
            "status": cache.get("status") or ("fresh" if dhan.get("ok") else "missing"),
            "available": bool(cache.get("available")),
            "stale": bool(cache.get("stale")),
            "age_seconds": cache.get("age_seconds"),
            "generated_at": cache.get("generated_at"),
            "message": dhan.get("message"),
            "source": dhan.get("source"),
        }
        if dhan["ok"]:
            if self.config.mode == "paper":
                signal_source = ui.get("signal_source") or {}
                signal_name = signal_source.get("name")
                ui.setdefault("top_bar", {})["data_status"] = (
                    "Paper + Dhan scanner + Dhan RO" if signal_name == "dhan_scanner" else "Paper + Dhan RO"
                )
                footer = ui.setdefault("footer", {})
                existing_source = footer.get("data_source") or "Paper engine"
                if "Dhan read-only" not in existing_source:
                    footer["data_source"] = f"{existing_source} + Dhan read-only"
            else:
                ui.setdefault("top_bar", {})["data_status"] = "Dhan read-only"
                ui.setdefault("footer", {})["data_source"] = "Dhan read-only + Strategy reference"
        else:
            ui.setdefault("footer", {})["data_source"] = "Reference backtest - Dhan direct API pending"

        pending = reconciliation["pending_actions"]
        if dhan["ok"] and self.config.mode != "paper":
            ui["pending_actions"] = {
                "exits": [
                    {
                        "no": index,
                        "symbol": row["symbol"],
                        "quantity": row["quantity"],
                        "reason": row["reason"],
                    }
                    for index, row in enumerate(pending["exits"], start=1)
                ],
                "entries": [
                    {
                        "no": index,
                        "symbol": row["symbol"],
                        "estimated_quantity": row.get("estimated_quantity") or 0,
                        "rank": row.get("rank") or 0,
                    }
                    for index, row in enumerate(pending["entries"], start=1)
                ],
            }

        notifications = ui.setdefault("notifications", [])
        notifications.insert(
            0,
            {
                "level": "ok" if dhan["ok"] else "warning",
                "message": f"Reconciliation: {dhan['message']}",
                "time": "Runtime",
            },
        )
        ui["notifications"] = notifications[:6]
        dashboard["ui"] = ui

    def _read_dhan_state(self) -> dict[str, Any]:
        snapshot = self.broker_snapshot.latest()
        holdings = [
            normalize_broker_holding(row)
            for row in snapshot.get("holdings", [])
            if isinstance(row, dict)
        ]
        funds = normalize_broker_funds(snapshot.get("funds", {}) if isinstance(snapshot.get("funds"), dict) else {})
        endpoint_status = snapshot.get("endpoint_status") or snapshot.get("endpoints") or {}
        endpoint_status = endpoint_status if isinstance(endpoint_status, dict) else {}
        cache = snapshot.get("cache") if isinstance(snapshot.get("cache"), dict) else {}
        ok = bool(snapshot.get("ok"))
        message = str(snapshot.get("message") or "Dhan broker cache loaded")
        if cache.get("stale") and ok:
            message = f"{message}; cached broker snapshot is stale"

        return {
            "ok": ok,
            "source": "dhan_broker_cache",
            "message": message,
            "holdings": holdings,
            "funds": funds,
            "endpoint_status": endpoint_status,
            "cache": cache,
        }

    def _desired_symbols(self, target_sleeves: list[dict[str, Any]]) -> list[dict[str, Any]]:
        rows: list[dict[str, Any]] = []
        seen: set[str] = set()
        for sleeve in target_sleeves:
            symbol = str(sleeve.get("symbol") or "").upper().strip()
            if not symbol or symbol in seen:
                continue
            seen.add(symbol)
            rows.append(
                {
                    "symbol": symbol,
                    "slot": sleeve.get("slot"),
                    "role": sleeve.get("role"),
                    "reason": sleeve.get("reason"),
                }
            )
        return rows

    def _retain_symbols(self, ranks: list[dict[str, Any]], regime: dict[str, Any], pdd: dict[str, Any]) -> set[str]:
        defensive = str(self.strategy["defensive_asset"]).upper()
        if not regime.get("risk_on"):
            return {defensive}

        retain_rank = int(self.strategy["hold_buffer_rank"])
        retain = {
            str(row.get("symbol") or "").upper()
            for row in ranks
            if int(row.get("rank") or 9999) <= retain_rank
        }
        if pdd.get("stress"):
            retain.add(defensive)
        return {symbol for symbol in retain if symbol}

    def _planned_exits(self, holdings: list[dict[str, Any]], retain: set[str]) -> list[dict[str, Any]]:
        exits = []
        for row in holdings:
            symbol = row["symbol"]
            if not symbol or row["quantity"] <= 0:
                continue
            if symbol not in retain:
                exits.append(
                    {
                        "symbol": symbol,
                        "quantity": row["quantity"],
                        "value": row["value"],
                        "reason": "Not in Strategy 4 retain list",
                        "read_only": True,
                    }
                )
        return exits

    def _planned_entries(
        self,
        desired: list[dict[str, Any]],
        actual_symbols: set[str],
        funds: dict[str, Any],
        ranks: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        ltp_by_symbol = {str(row.get("symbol") or "").upper(): float(row.get("ltp") or 0.0) for row in ranks}
        ltp_by_symbol.setdefault(str(self.strategy["defensive_asset"]).upper(), 66.12)
        missing = [row for row in desired if row["symbol"] not in actual_symbols]
        available_cash = float(funds.get("available_cash") or 0.0)
        sleeve_cash = available_cash / len(missing) if missing else 0.0
        ranks_by_symbol = {str(row.get("symbol") or "").upper(): int(row.get("rank") or 0) for row in ranks}
        entries = []
        for row in missing:
            symbol = row["symbol"]
            ltp = ltp_by_symbol.get(symbol, 0.0)
            entries.append(
                {
                    "symbol": symbol,
                    "estimated_quantity": int(sleeve_cash // ltp) if ltp > 0 and sleeve_cash > 0 else None,
                    "estimated_cash": sleeve_cash,
                    "reference_ltp": ltp or None,
                    "rank": ranks_by_symbol.get(symbol),
                    "reason": row.get("reason") or "Missing target sleeve",
                    "read_only": True,
                }
            )
        return entries

    def _paper_state(self, strategy_snapshot: dict[str, Any]) -> dict[str, Any]:
        paper = strategy_snapshot.get("paper") if isinstance(strategy_snapshot.get("paper"), dict) else {}
        portfolio = paper.get("portfolio") if isinstance(paper.get("portfolio"), dict) else {}
        summary = portfolio.get("summary") if isinstance(portfolio.get("summary"), dict) else {}
        holdings = [
            _normalize_paper_holding(row)
            for row in portfolio.get("holdings", [])
            if isinstance(row, dict)
        ]
        symbols = sorted({row["symbol"] for row in holdings if row["symbol"] and row["quantity"] > 0})
        return {
            "portfolio": {
                "summary": summary,
                "holdings": holdings,
                "symbols": symbols,
            },
            "summary": summary,
            "holdings": holdings,
            "symbols": symbols,
            "plan": paper.get("plan") if isinstance(paper.get("plan"), dict) else {},
            "rebalance_status": paper.get("rebalance_status") if isinstance(paper.get("rebalance_status"), dict) else {},
            "signal_source": paper.get("signal_source") if isinstance(paper.get("signal_source"), dict) else {},
        }

    def _comparison(
        self,
        *,
        broker_holdings: list[dict[str, Any]],
        broker_symbols: set[str],
        desired_symbols: set[str],
        paper_holdings: list[dict[str, Any]],
        paper_symbols: set[str],
        retain_symbols: set[str],
    ) -> dict[str, Any]:
        broker_vs_strategy = {
            "missing_targets": sorted(desired_symbols - broker_symbols),
            "outside_retain": sorted(broker_symbols - retain_symbols),
        }
        paper_vs_strategy = {
            "missing_targets": sorted(desired_symbols - paper_symbols),
            "outside_retain": sorted(paper_symbols - retain_symbols),
        }
        broker_vs_paper = {
            "missing_in_broker": sorted(paper_symbols - broker_symbols),
            "extra_in_broker": sorted(broker_symbols - paper_symbols),
        }
        quantity_mismatches = _quantity_mismatches(broker_holdings, paper_holdings)
        broker_vs_strategy["ok"] = not broker_vs_strategy["missing_targets"] and not broker_vs_strategy["outside_retain"]
        paper_vs_strategy["ok"] = not paper_vs_strategy["missing_targets"] and not paper_vs_strategy["outside_retain"]
        broker_vs_paper["ok"] = (
            not broker_vs_paper["missing_in_broker"]
            and not broker_vs_paper["extra_in_broker"]
            and not quantity_mismatches
        )
        gap_count = (
            len(broker_vs_strategy["missing_targets"])
            + len(broker_vs_strategy["outside_retain"])
            + len(paper_vs_strategy["missing_targets"])
            + len(paper_vs_strategy["outside_retain"])
            + len(broker_vs_paper["missing_in_broker"])
            + len(broker_vs_paper["extra_in_broker"])
            + len(quantity_mismatches)
        )
        return {
            "broker_vs_strategy": broker_vs_strategy,
            "paper_vs_strategy": paper_vs_strategy,
            "broker_vs_paper": broker_vs_paper,
            "quantity_mismatches": quantity_mismatches,
            "gap_count": gap_count,
        }

    def _notes(
        self,
        dhan_state: dict[str, Any],
        exits: list[dict[str, Any]],
        entries: list[dict[str, Any]],
        paper_state: dict[str, Any],
        comparison: dict[str, Any],
    ) -> list[str]:
        notes = ["Read-only reconciliation only. No live orders can be placed from this service."]
        if self.config.mode == "paper":
            notes.append("Paper portfolio remains the source of truth for front-test P&L; Dhan broker state is read-only evidence.")
        if not dhan_state["ok"]:
            notes.append("Broker reconciliation is using cache only. Refresh the broker snapshot after the app-side Dhan token is valid.")
        if dhan_state.get("cache", {}).get("stale"):
            notes.append("Cached Dhan broker snapshot is stale. Use Refresh Broker Snapshot before relying on broker reconciliation.")
        if dhan_state["ok"] and not dhan_state["holdings"] and paper_state["symbols"]:
            notes.append("Dhan returned no broker holdings, while paper mode has simulated holdings. This is expected if the broker account is not mirroring paper trades.")
        if comparison["gap_count"]:
            notes.append("Resolve reconciliation gaps before enabling any future live-trading phase.")
        if not exits and not entries and dhan_state["ok"]:
            notes.append("Actual holdings already match the current strategy target/retain logic, or there are no holdings to exit.")
        return notes


def _normalize_holding(row: dict[str, Any]) -> dict[str, Any]:
    symbol = str(_first(row, ["tradingSymbol", "symbol", "exchangeSymbol", "securitySymbol", "scripName"]) or "").upper().strip()
    quantity = _number(_first(row, ["totalQty", "availableQty", "quantity", "qty", "holdingQty", "dpQty", "t1Qty"]))
    avg_price = _number(_first(row, ["avgCostPrice", "avgPrice", "averagePrice", "buyAvg", "costPrice"]))
    ltp = _number(_first(row, ["lastTradedPrice", "ltp", "lastPrice", "closePrice", "previousClose"]))
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


def _normalize_paper_holding(row: dict[str, Any]) -> dict[str, Any]:
    symbol = str(row.get("symbol") or "").upper().strip()
    quantity = _number(_first(row, ["quantity", "qty", "totalQty"]))
    avg_price = _number(_first(row, ["avg_price", "avgPrice", "averagePrice"]))
    ltp = _number(_first(row, ["ltp", "last_price", "lastPrice", "close"]))
    value = _number(_first(row, ["value", "market_value", "marketValue"]))
    if value == 0.0 and quantity and ltp:
        value = quantity * ltp
    return {
        "symbol": symbol,
        "quantity": quantity,
        "avg_price": avg_price,
        "ltp": ltp,
        "value": value,
        "pnl": _number(row.get("pnl")),
        "pnl_pct": _number(row.get("pnl_pct")),
        "role": row.get("role") or row.get("sleeve") or "",
        "sleeve": row.get("sleeve"),
    }


def _quantity_mismatches(
    broker_holdings: list[dict[str, Any]],
    paper_holdings: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    broker_qty = {row["symbol"]: float(row.get("quantity") or 0.0) for row in broker_holdings if row.get("symbol")}
    paper_qty = {row["symbol"]: float(row.get("quantity") or 0.0) for row in paper_holdings if row.get("symbol")}
    rows = []
    for symbol in sorted(set(broker_qty) & set(paper_qty)):
        broker_value = broker_qty.get(symbol, 0.0)
        paper_value = paper_qty.get(symbol, 0.0)
        if abs(broker_value - paper_value) < 1e-9:
            continue
        rows.append(
            {
                "symbol": symbol,
                "broker_quantity": broker_value,
                "paper_quantity": paper_value,
                "difference": broker_value - paper_value,
            }
        )
    return rows


def _normalize_funds(row: dict[str, Any]) -> dict[str, Any]:
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
    utilized = _number(_first(row, ["utilizedAmount", "utilized", "usedMargin"]))
    collateral = _number(_first(row, ["collateralAmount", "collateral"]))
    return {
        "available_cash": available_cash,
        "utilized_amount": utilized,
        "collateral_amount": collateral,
        "raw_keys": sorted(row.keys()),
    }


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


def _is_no_holdings_error(exc: DhanAPIError) -> bool:
    payload = exc.payload if isinstance(exc.payload, dict) else {}
    return payload.get("errorCode") == "DH-1111" or "No holdings available" in str(payload)
