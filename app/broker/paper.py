from __future__ import annotations

import math
from copy import deepcopy
from datetime import datetime
from typing import Any

from ..models import utc_now_iso
from ..storage import StateStore


PAPER_STATE_KEY = "paper_portfolio_state"
PAPER_ORDER_KEY = "paper_orders"


class PaperBroker:
    """Persistent virtual broker for front testing.

    This broker is deliberately local-only. It never talks to Dhan and never
    places real orders. It lets the Trading OS exercise the monthly rebalance,
    retain-buffer, PDD/Gold, slippage, whole-share, and compounding mechanics
    before we even think about live execution.
    """

    def __init__(self, store: StateStore) -> None:
        self.store = store

    def mode(self) -> str:
        return "paper"

    def state_exists(self) -> bool:
        return self.store.get_value(PAPER_STATE_KEY) is not None

    def state(self, *, initial_capital: float) -> dict[str, Any]:
        state = self.store.get_value(PAPER_STATE_KEY)
        if isinstance(state, dict):
            state.setdefault("cash", float(initial_capital))
            state.setdefault("holdings", [])
            state.setdefault("equity_peak", float(initial_capital))
            state.setdefault("realized_pnl", 0.0)
            state.setdefault("created_at", utc_now_iso())
            state.setdefault("updated_at", utc_now_iso())
            return state
        return self._initial_state(initial_capital)

    def reset(self, *, initial_capital: float) -> dict[str, Any]:
        state = self._initial_state(initial_capital)
        self._save_state(state)
        self.store.set_value(PAPER_ORDER_KEY, [])
        return state

    def holdings(self, *, initial_capital: float | None = None) -> list[dict[str, Any]]:
        if initial_capital is None:
            legacy = self.store.get_value("paper_holdings", [])
            return legacy if isinstance(legacy, list) else []
        return self.state(initial_capital=initial_capital).get("holdings", [])

    def save_holdings(self, holdings: list[dict[str, Any]], *, initial_capital: float | None = None) -> None:
        if initial_capital is None:
            self.store.set_value("paper_holdings", holdings)
            return
        state = self.state(initial_capital=initial_capital)
        state["holdings"] = holdings
        state["updated_at"] = utc_now_iso()
        self._save_state(state)

    def order_book(self) -> list[dict[str, Any]]:
        orders = self.store.get_value(PAPER_ORDER_KEY, [])
        return orders if isinstance(orders, list) else []

    def snapshot(
        self,
        *,
        market_data: dict[str, dict[str, Any]],
        initial_capital: float,
    ) -> dict[str, Any]:
        state = self.state(initial_capital=initial_capital)
        marked = self._mark_state_to_market(state, market_data)
        self._save_state(marked)
        return self._portfolio_payload(marked)

    def plan_rebalance(
        self,
        *,
        target_sleeves: list[Any],
        retain_symbols: set[str],
        market_data: dict[str, dict[str, Any]],
        initial_capital: float,
        slippage: float,
        as_of: str,
    ) -> dict[str, Any]:
        state = self.snapshot(market_data=market_data, initial_capital=initial_capital)["state"]
        holdings = deepcopy(state.get("holdings", []))
        cash = float(state.get("cash") or 0.0)
        retained = {symbol.upper().strip() for symbol in retain_symbols if symbol}
        desired = _dedupe_desired_sleeves(target_sleeves)
        desired_symbols = {row["symbol"] for row in desired}

        sells: list[dict[str, Any]] = []
        for holding in holdings:
            symbol = str(holding.get("symbol") or "").upper().strip()
            quantity = int(float(holding.get("quantity") or 0))
            if not symbol or quantity <= 0:
                continue
            if symbol not in retained:
                ltp = self._price_for(symbol, market_data, holding)
                fill_price = max(0.0, ltp * (1.0 - slippage))
                gross_value = fill_price * quantity
                cost_value = float(holding.get("avg_price") or 0.0) * quantity
                sells.append(
                    {
                        "action": "SELL",
                        "symbol": symbol,
                        "quantity": quantity,
                        "estimated_price": fill_price,
                        "estimated_value": gross_value,
                        "estimated_realized_pnl": gross_value - cost_value,
                        "sleeve": holding.get("sleeve"),
                        "role": holding.get("role", "stock"),
                        "reason": "Outside Strategy 4 retain list",
                        "status": "planned",
                    }
                )

        held_after_sells = {
            str(row.get("symbol") or "").upper().strip()
            for row in holdings
            if str(row.get("symbol") or "").upper().strip() not in {sell["symbol"] for sell in sells}
            and int(float(row.get("quantity") or 0)) > 0
        }
        missing = [row for row in desired if row["symbol"] not in held_after_sells]
        available_after_sells = cash + sum(float(row["estimated_value"]) for row in sells)
        sleeve_budget = available_after_sells / len(missing) if missing else 0.0

        buys: list[dict[str, Any]] = []
        for row in missing:
            symbol = row["symbol"]
            ltp = self._price_for(symbol, market_data, {})
            fill_price = ltp * (1.0 + slippage) if ltp > 0 else 0.0
            quantity = int(math.floor(sleeve_budget / fill_price)) if fill_price > 0 and sleeve_budget > 0 else 0
            status = "planned" if quantity > 0 else "skipped-insufficient-cash-or-price"
            market = market_data.get(symbol, {})
            buys.append(
                {
                    "action": "BUY",
                    "symbol": symbol,
                    "quantity": quantity,
                    "estimated_price": fill_price,
                    "estimated_value": quantity * fill_price,
                    "cash_budget": sleeve_budget,
                    "sleeve": row.get("slot"),
                    "role": row.get("role"),
                    "rank": market.get("rank"),
                    "roc_12": market.get("roc_12"),
                    "reason": row.get("reason") or "Missing target sleeve",
                    "status": status,
                }
            )

        orders = sells + buys
        return {
            "generated_at": utc_now_iso(),
            "mode": "paper",
            "as_of": as_of,
            "slippage": slippage,
            "retain_symbols": sorted(retained),
            "target_symbols": [row["symbol"] for row in desired],
            "sells": sells,
            "buys": buys,
            "orders": orders,
            "summary": {
                "sell_count": len(sells),
                "buy_count": len([row for row in buys if row["quantity"] > 0]),
                "skipped_buy_count": len([row for row in buys if row["quantity"] <= 0]),
                "estimated_cash_before": cash,
                "estimated_cash_after_sells": available_after_sells,
                "estimated_buy_value": sum(float(row["estimated_value"]) for row in buys),
                "estimated_cash_after": available_after_sells - sum(float(row["estimated_value"]) for row in buys),
            },
        }

    def execute_plan(
        self,
        *,
        target_sleeves: list[Any],
        retain_symbols: set[str],
        market_data: dict[str, dict[str, Any]],
        initial_capital: float,
        slippage: float,
        as_of: str,
        note: str = "paper_rebalance",
    ) -> dict[str, Any]:
        plan = self.plan_rebalance(
            target_sleeves=target_sleeves,
            retain_symbols=retain_symbols,
            market_data=market_data,
            initial_capital=initial_capital,
            slippage=slippage,
            as_of=as_of,
        )
        state = self.state(initial_capital=initial_capital)
        holdings = {
            str(row.get("symbol") or "").upper().strip(): deepcopy(row)
            for row in state.get("holdings", [])
            if str(row.get("symbol") or "").strip()
        }
        cash = float(state.get("cash") or 0.0)
        realized_pnl = float(state.get("realized_pnl") or 0.0)
        filled_orders: list[dict[str, Any]] = []

        for sell in plan["sells"]:
            if sell["status"] != "planned":
                continue
            symbol = sell["symbol"]
            holding = holdings.get(symbol)
            if not holding:
                continue
            quantity = min(int(sell["quantity"]), int(float(holding.get("quantity") or 0)))
            if quantity <= 0:
                continue
            fill_price = float(sell["estimated_price"])
            fill_value = fill_price * quantity
            cost_value = float(holding.get("avg_price") or 0.0) * quantity
            cash += fill_value
            realized = fill_value - cost_value
            realized_pnl += realized
            remaining = int(float(holding.get("quantity") or 0)) - quantity
            if remaining <= 0:
                holdings.pop(symbol, None)
            else:
                holding["quantity"] = remaining
                holdings[symbol] = holding
            filled_orders.append(self._fill_order(sell, fill_price, quantity, fill_value, realized, note))

        for buy in plan["buys"]:
            if buy["status"] != "planned" or int(buy["quantity"]) <= 0:
                continue
            symbol = buy["symbol"]
            quantity = int(buy["quantity"])
            fill_price = float(buy["estimated_price"])
            fill_value = fill_price * quantity
            if fill_value > cash + 1e-9:
                quantity = int(math.floor(cash / fill_price)) if fill_price > 0 else 0
                fill_value = fill_price * quantity
            if quantity <= 0:
                continue
            cash -= fill_value
            market = market_data.get(symbol, {})
            current = holdings.get(symbol)
            if current:
                old_qty = int(float(current.get("quantity") or 0))
                old_cost = float(current.get("avg_price") or 0.0) * old_qty
                new_qty = old_qty + quantity
                current["quantity"] = new_qty
                current["avg_price"] = (old_cost + fill_value) / new_qty if new_qty else fill_price
                current["last_price"] = market.get("ltp") or fill_price
                current["sleeve"] = buy.get("sleeve")
                current["role"] = buy.get("role")
                current["rank"] = market.get("rank")
                current["roc_12"] = market.get("roc_12")
                holdings[symbol] = current
            else:
                holdings[symbol] = {
                    "symbol": symbol,
                    "name": market.get("company") or symbol,
                    "quantity": quantity,
                    "avg_price": fill_price,
                    "last_price": market.get("ltp") or fill_price,
                    "sleeve": buy.get("sleeve"),
                    "role": buy.get("role") or "stock",
                    "rank": market.get("rank"),
                    "roc_12": market.get("roc_12"),
                    "entry_date": as_of,
                    "created_at": utc_now_iso(),
                }
            filled_orders.append(self._fill_order(buy, fill_price, quantity, fill_value, None, note))

        state["cash"] = max(0.0, cash)
        state["realized_pnl"] = realized_pnl
        state["holdings"] = list(holdings.values())
        state["updated_at"] = utc_now_iso()
        state = self._mark_state_to_market(state, market_data)
        self._save_state(state)
        self._append_orders(filled_orders)

        return {
            "ok": True,
            "mode": "paper",
            "generated_at": utc_now_iso(),
            "filled_count": len(filled_orders),
            "filled_orders": filled_orders,
            "plan": plan,
            "portfolio": self._portfolio_payload(state),
        }

    def _initial_state(self, initial_capital: float) -> dict[str, Any]:
        now = utc_now_iso()
        return {
            "created_at": now,
            "updated_at": now,
            "cash": float(initial_capital),
            "initial_capital": float(initial_capital),
            "equity": float(initial_capital),
            "equity_peak": float(initial_capital),
            "realized_pnl": 0.0,
            "holdings": [],
        }

    def _mark_state_to_market(self, state: dict[str, Any], market_data: dict[str, dict[str, Any]]) -> dict[str, Any]:
        state = deepcopy(state)
        holdings: list[dict[str, Any]] = []
        market_value = 0.0
        invested = 0.0
        for raw in state.get("holdings", []):
            holding = deepcopy(raw)
            symbol = str(holding.get("symbol") or "").upper().strip()
            quantity = int(float(holding.get("quantity") or 0))
            if not symbol or quantity <= 0:
                continue
            market = market_data.get(symbol, {})
            ltp = self._price_for(symbol, market_data, holding)
            avg_price = float(holding.get("avg_price") or 0.0)
            value = quantity * ltp
            cost_value = quantity * avg_price
            pnl = value - cost_value
            holding.update(
                {
                    "symbol": symbol,
                    "name": market.get("company") or holding.get("name") or symbol,
                    "quantity": quantity,
                    "last_price": ltp,
                    "ltp": ltp,
                    "value": value,
                    "invested": cost_value,
                    "pnl": pnl,
                    "pnl_pct": pnl / cost_value if cost_value else 0.0,
                    "rank": market.get("rank", holding.get("rank")),
                    "roc_12": market.get("roc_12", holding.get("roc_12")),
                }
            )
            market_value += value
            invested += cost_value
            holdings.append(holding)

        cash = float(state.get("cash") or 0.0)
        equity = cash + market_value
        equity_peak = max(float(state.get("equity_peak") or 0.0), equity)
        drawdown = 1.0 - equity / equity_peak if equity_peak else 0.0
        for holding in holdings:
            holding["weight_pct"] = float(holding["value"]) / equity if equity else 0.0

        state.update(
            {
                "holdings": holdings,
                "cash": cash,
                "market_value": market_value,
                "invested": invested,
                "equity": equity,
                "equity_peak": equity_peak,
                "current_drawdown": max(0.0, drawdown),
                "unrealized_pnl": market_value - invested,
                "total_pnl": equity - float(state.get("initial_capital") or 0.0),
                "updated_at": utc_now_iso(),
            }
        )
        return state

    def _portfolio_payload(self, state: dict[str, Any]) -> dict[str, Any]:
        initial_capital = float(state.get("initial_capital") or 0.0)
        total_pnl = float(state.get("equity") or 0.0) - initial_capital
        orders = self.order_book()
        return {
            "mode": "paper",
            "state": state,
            "holdings": state.get("holdings", []),
            "orders": orders[-100:],
            "summary": {
                "initial_capital": initial_capital,
                "cash": float(state.get("cash") or 0.0),
                "market_value": float(state.get("market_value") or 0.0),
                "invested": float(state.get("invested") or 0.0),
                "equity": float(state.get("equity") or initial_capital),
                "equity_peak": float(state.get("equity_peak") or initial_capital),
                "current_drawdown": float(state.get("current_drawdown") or 0.0),
                "realized_pnl": float(state.get("realized_pnl") or 0.0),
                "unrealized_pnl": float(state.get("unrealized_pnl") or 0.0),
                "total_pnl": total_pnl,
                "total_pnl_pct": total_pnl / initial_capital if initial_capital else 0.0,
                "holding_count": len(state.get("holdings", [])),
            },
        }

    def _price_for(self, symbol: str, market_data: dict[str, dict[str, Any]], fallback: dict[str, Any]) -> float:
        market = market_data.get(symbol.upper().strip(), {})
        for candidate in (market.get("ltp"), market.get("price"), fallback.get("last_price"), fallback.get("ltp"), fallback.get("avg_price")):
            try:
                value = float(candidate)
            except (TypeError, ValueError):
                continue
            if value > 0:
                return value
        return 0.0

    def _fill_order(
        self,
        order: dict[str, Any],
        fill_price: float,
        quantity: int,
        fill_value: float,
        realized_pnl: float | None,
        note: str,
    ) -> dict[str, Any]:
        return {
            "id": f"PAPER-{datetime.now().strftime('%Y%m%d%H%M%S%f')}",
            "created_at": utc_now_iso(),
            "mode": "paper",
            "action": order["action"],
            "symbol": order["symbol"],
            "quantity": quantity,
            "price": fill_price,
            "value": fill_value,
            "realized_pnl": realized_pnl,
            "sleeve": order.get("sleeve"),
            "role": order.get("role"),
            "reason": order.get("reason"),
            "status": "FILLED",
            "note": note,
        }

    def _append_orders(self, filled_orders: list[dict[str, Any]]) -> None:
        if not filled_orders:
            return
        orders = self.order_book()
        orders.extend(filled_orders)
        self.store.set_value(PAPER_ORDER_KEY, orders[-500:])

    def _save_state(self, state: dict[str, Any]) -> None:
        self.store.set_value(PAPER_STATE_KEY, state)


def _dedupe_desired_sleeves(target_sleeves: list[Any]) -> list[dict[str, Any]]:
    desired: list[dict[str, Any]] = []
    seen: set[str] = set()
    for sleeve in target_sleeves:
        row = _row_from_sleeve(sleeve)
        symbol = str(row.get("symbol") or "").upper().strip()
        if not symbol or symbol in seen:
            continue
        seen.add(symbol)
        row["symbol"] = symbol
        desired.append(row)
    return desired


def _row_from_sleeve(sleeve: Any) -> dict[str, Any]:
    if isinstance(sleeve, dict):
        return dict(sleeve)
    return {
        "slot": getattr(sleeve, "slot", None),
        "symbol": getattr(sleeve, "symbol", ""),
        "role": getattr(sleeve, "role", ""),
        "reason": getattr(sleeve, "reason", ""),
    }
