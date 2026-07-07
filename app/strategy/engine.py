from __future__ import annotations

import json
from datetime import date, datetime
from pathlib import Path
from typing import Any

from ..broker.paper import PaperBroker
from ..config import AppConfig, load_strategy_config
from ..data.live_prices import LivePriceService
from ..data.market_store import MarketDataStore
from ..data.nse_holidays import holiday_status
from ..data.reference_loader import ReferenceDataLoader
from ..models import DashboardSnapshot, OrderIntent, TargetSleeve, utc_now_iso
from ..notifications import NotificationManager
from ..storage import StateStore
from .rebalance_calendar import first_trading_day, load_holidays, rebalance_day_status


class StrategyEngine:
    def __init__(self, config: AppConfig) -> None:
        self.config = config
        self.strategy = load_strategy_config(config)
        self.reference = ReferenceDataLoader(config.reference_results_dir)
        self.store = StateStore(config.database_path)
        self.paper = PaperBroker(self.store)
        self.market_store = MarketDataStore(config.database_path)
        self.live_prices = LivePriceService(config)

    def dashboard_snapshot(self) -> DashboardSnapshot:
        metrics = self.reference.metrics()
        reference_equity = self.reference.equity()
        signals = self._signals()
        ranks = signals["ranks"]
        regime = signals["regime"]
        trade_summary = self.reference.trade_summary()
        context = self._paper_context(ranks, regime)
        paper_snapshot = context["paper_snapshot"]
        paper_plan = context["paper_plan"]
        pdd = context["pdd"]
        rebalance_status = self.rebalance_status(context=context)
        target_sleeves = self._target_sleeves(ranks, regime, pdd)
        order_plan = self._paper_order_plan(paper_plan)
        alerts = self._alerts(regime, pdd, signals["source"])
        ui = self._ui_contract(
            metrics,
            reference_equity,
            ranks,
            regime,
            pdd,
            trade_summary,
            alerts,
            paper_snapshot,
            paper_plan,
            signals["source"],
            rebalance_status,
        )
        paper_summary = paper_snapshot["summary"]
        return DashboardSnapshot(
            generated_at=utc_now_iso(),
            mode=self.config.mode,
            strategy_name=self.strategy["strategy_name"],
            portfolio={
                "as_of": context["as_of"],
                "value": paper_summary["equity"],
                "peak": paper_summary["equity_peak"],
                "current_drawdown": paper_summary["current_drawdown"],
                "cash": paper_summary["cash"],
                "market_value": paper_summary["market_value"],
                "reference_note": signals["note"],
            },
            regime=regime,
            pdd=pdd,
            ranks=ranks[:21],
            target_sleeves=target_sleeves,
            order_plan=order_plan,
            alerts=alerts,
            metrics=metrics,
            trade_summary=trade_summary,
            paper={
                "portfolio": paper_snapshot,
                "plan": paper_plan,
                "signal_source": signals["source"],
                "rebalance_status": rebalance_status,
                "live_prices": context["live_prices"],
            },
            ui=ui,
        )

    def paper_portfolio_snapshot(self) -> dict[str, Any]:
        signals = self._signals()
        ranks = signals["ranks"]
        regime = signals["regime"]
        context = self._paper_context(ranks, regime)
        return {
            "generated_at": utc_now_iso(),
            "mode": self.config.mode,
            "strategy_name": self.strategy["strategy_name"],
            "portfolio": context["paper_snapshot"],
            "plan": context["paper_plan"],
            "pdd": context["pdd"],
            "regime": regime,
            "ranks": ranks[:21],
            "target_sleeves": [row.__dict__ for row in context["target_sleeves"]],
            "retain_symbols": sorted(context["retain_symbols"]),
            "rebalance_status": self.rebalance_status(context=context),
            "signal_source": signals["source"],
            "signal_note": signals["note"],
            "live_prices": context["live_prices"],
        }

    def execute_paper_rebalance(self, *, force: bool = False, today: str | None = None) -> dict[str, Any]:
        signals = self._signals()
        ranks = signals["ranks"]
        regime = signals["regime"]
        context = self._paper_context(ranks, regime)
        status = self.rebalance_status(today=today, context=context)
        if not force and not status["allowed"]:
            return {
                "ok": True,
                "skipped": True,
                "skip_reason": status["reason"],
                "rebalance_status": status,
                "paper_rebalance": {
                    "ok": True,
                    "mode": "paper",
                    "skipped": True,
                    "skip_reason": status["reason"],
                    "filled_count": 0,
                    "filled_orders": [],
                    "plan": context["paper_plan"],
                    "portfolio": context["paper_snapshot"],
                },
                "next_snapshot": self.paper_portfolio_snapshot(),
            }

        result = self.paper.execute_plan(
            target_sleeves=context["target_sleeves"],
            retain_symbols=context["retain_symbols"],
            market_data=context["market_data"],
            initial_capital=float(self.strategy["initial_capital"]),
            slippage=float(self.strategy.get("slippage_reference") or 0.0),
            as_of=context["as_of"],
        )
        self._mark_rebalance_completed(status, result, force=force)
        return {
            "ok": True,
            "skipped": False,
            "force": force,
            "rebalance_status": status,
            "paper_rebalance": result,
            "next_snapshot": self.paper_portfolio_snapshot(),
        }

    def rebalance_status(self, *, today: str | None = None, context: dict[str, Any] | None = None) -> dict[str, Any]:
        if context is None:
            signals = self._signals()
            context = self._paper_context(signals["ranks"], signals["regime"])
        today_date = date.fromisoformat(today) if today else date.today()
        execution_month = str(context.get("as_of") or today_date.strftime("%Y-%m"))[:7]
        state = self.store.get_value("paper_rebalance_state", {})
        last_completed = state.get("last_completed_month") if isinstance(state, dict) else None
        holidays = load_holidays(self.config.strategy_config_path.parent / "nse_holidays.json")
        status = rebalance_day_status(
            today=today_date,
            execution_month=execution_month,
            last_completed_month=last_completed,
            holidays=holidays,
        )
        status["frequency"] = "monthly"
        status["rule"] = "first_trading_day_of_execution_month"
        status["holiday_calendar"] = "config/nse_holidays.json"
        return status

    def _signals(self) -> dict[str, Any]:
        scanner = self.market_store.latest_scanner_run()
        if scanner and scanner.get("rankings") and scanner.get("regime"):
            return self._scanner_signals(scanner)
        return {
            "source": {
                "name": "reference_csv",
                "status": "fallback",
                "run_id": None,
                "coverage": None,
                "as_of_month": None,
                "execution_month": None,
            },
            "note": "Using reference backtest rankings/regime because no scanner run is available.",
            "ranks": self.reference.ranks(),
            "regime": self.reference.regime(),
        }

    def _scanner_signals(self, scanner: dict[str, Any]) -> dict[str, Any]:
        ranks = [
            {
                "execution_month": row.get("execution_month") or scanner.get("execution_month"),
                "as_of_month": row.get("as_of_month") or scanner.get("as_of_month"),
                "rank": int(row.get("rank") or 0),
                "symbol": str(row.get("symbol") or "").upper(),
                "company": row.get("company") or row.get("symbol"),
                "ltp": float(row.get("close") or 0.0),
                "roc_12": float(row.get("roc_12") or 0.0),
                "ret_1m": float(row.get("ret_1m") or 0.0),
                "avg_turnover_3m": float(row.get("avg_turnover_3m") or 0.0),
                "trade_date": row.get("trade_date"),
            }
            for row in scanner.get("rankings", [])
            if row.get("symbol")
        ]
        ranks.sort(key=lambda row: int(row.get("rank") or 9999))
        raw_regime = scanner.get("regime") or {}
        regime = {
            "as_of": raw_regime.get("as_of_date") or scanner.get("as_of_date") or "",
            "risk_on": bool(raw_regime.get("risk_on")),
            "state": raw_regime.get("state") or ("Risk On" if raw_regime.get("risk_on") else "Risk Off"),
            "reason": raw_regime.get("reason") or "",
            "breadth_30w": raw_regime.get("breadth_30w"),
            "niftybees_close": raw_regime.get("niftybees_close"),
            "niftybees_sma_30w": raw_regime.get("niftybees_sma_30w"),
            "niftybees_above_30w": raw_regime.get("niftybees_above_30w"),
            "goldbees_close": raw_regime.get("goldbees_close"),
            "goldbees_sma_20w": raw_regime.get("goldbees_sma_20w"),
            "goldbees_above_20w": raw_regime.get("goldbees_above_20w"),
        }
        diagnostics = scanner.get("ranking_diagnostics") or {}
        coverage = float(diagnostics.get("required_history_coverage") or 0.0)
        note = (
            f"Using Dhan scanner run {scanner.get('run_id')} "
            f"({coverage * 100:.2f}% required-history coverage)."
        )
        return {
            "source": {
                "name": "dhan_scanner",
                "status": scanner.get("status"),
                "run_id": scanner.get("run_id"),
                "coverage": coverage,
                "as_of_month": scanner.get("as_of_month"),
                "execution_month": scanner.get("execution_month"),
                "production_ready": bool(diagnostics.get("production_ready")),
                "failure_count": scanner.get("sync", {}).get("failure_count"),
            },
            "note": note,
            "ranks": ranks,
            "regime": regime,
        }

    def reset_paper_portfolio(self) -> dict[str, Any]:
        self.paper.reset(initial_capital=float(self.strategy["initial_capital"]))
        self.store.set_value("paper_rebalance_state", {})
        return {"ok": True, "paper": self.paper_portfolio_snapshot()}

    def _mark_rebalance_completed(self, status: dict[str, Any], result: dict[str, Any], *, force: bool) -> None:
        payload = {
            "last_completed_month": status["execution_month"],
            "last_completed_at": utc_now_iso(),
            "last_completed_forced": force,
            "last_filled_count": result.get("filled_count", 0),
            "last_status": status,
        }
        self.store.set_value("paper_rebalance_state", payload)

    def _paper_context(self, ranks: list[dict[str, Any]], regime: dict[str, Any]) -> dict[str, Any]:
        market_data = self._market_data(ranks, regime)
        initial_capital = float(self.strategy["initial_capital"])
        market_data, live_price_status = self._overlay_live_prices(market_data, initial_capital=initial_capital)
        paper_snapshot = self.paper.snapshot(market_data=market_data, initial_capital=initial_capital)
        pdd = self._pdd_state(paper_snapshot["summary"])
        target_sleeves = self._target_sleeves(ranks, regime, pdd)
        retain_symbols = self._retain_symbols(ranks, regime, pdd)
        as_of = ranks[0].get("execution_month") if ranks else datetime.now().strftime("%Y-%m")
        paper_plan = self.paper.plan_rebalance(
            target_sleeves=target_sleeves,
            retain_symbols=retain_symbols,
            market_data=market_data,
            initial_capital=initial_capital,
            slippage=float(self.strategy.get("slippage_reference") or 0.0),
            as_of=str(as_of),
        )
        return {
            "market_data": market_data,
            "paper_snapshot": paper_snapshot,
            "pdd": pdd,
            "target_sleeves": target_sleeves,
            "retain_symbols": retain_symbols,
            "paper_plan": paper_plan,
            "as_of": as_of,
            "live_prices": live_price_status,
        }

    def _pdd_state(self, portfolio: dict[str, Any]) -> dict[str, Any]:
        overlay = self.strategy["pdd_overlay"]
        current_drawdown = float(portfolio.get("current_drawdown") or 0.0)
        stress_trigger = float(overlay["stress_trigger_drawdown"])
        restore = float(overlay["restore_drawdown"])
        stress = current_drawdown >= stress_trigger
        return {
            "full_form": "Portfolio Drawdown",
            "state": "PDD Stress" if stress else "PDD Normal",
            "stress": stress,
            "current_drawdown": current_drawdown,
            "stress_trigger_drawdown": stress_trigger,
            "restore_drawdown": restore,
            "target_stock_slots_if_stress": int(overlay["stress_stock_slots"]),
            "defensive_asset": overlay["stress_defensive_asset"],
            "equity_peak": float(portfolio.get("equity_peak") or 0.0),
            "equity": float(portfolio.get("equity") or 0.0),
            "note": "Paper mode derives PDD from the local virtual portfolio equity curve.",
        }

    def _target_sleeves(self, ranks: list[dict[str, Any]], regime: dict[str, Any], pdd: dict[str, Any]) -> list[TargetSleeve]:
        target_slots = int(self.strategy["target_stock_slots"])
        defensive_asset = self.strategy["defensive_asset"]
        top_symbols = [row["symbol"] for row in ranks[:target_slots]]
        sleeves: list[TargetSleeve] = []

        if not regime.get("risk_on"):
            return [
                TargetSleeve(slot=i, symbol=defensive_asset, role="defensive", reason=regime.get("reason", "Market regime risk-off"))
                for i in range(1, target_slots + 1)
            ]

        if pdd.get("stress"):
            stock_slots = int(self.strategy["pdd_overlay"]["stress_stock_slots"])
            for i, symbol in enumerate(top_symbols[:stock_slots], start=1):
                sleeves.append(TargetSleeve(slot=i, symbol=symbol, role="stock", reason="Top ROC rank in PDD stress mode"))
            sleeves.append(
                TargetSleeve(
                    slot=target_slots,
                    symbol=defensive_asset,
                    role="defensive",
                    reason="PDD stress: released sleeve moved to GOLDBEES",
                )
            )
            return sleeves

        return [
            TargetSleeve(slot=i, symbol=symbol, role="stock", reason="Top 8 ROC rank")
            for i, symbol in enumerate(top_symbols, start=1)
        ]

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

    def _market_data(self, ranks: list[dict[str, Any]], regime: dict[str, Any]) -> dict[str, dict[str, Any]]:
        market: dict[str, dict[str, Any]] = {}
        for row in ranks:
            symbol = str(row.get("symbol") or "").upper().strip()
            if not symbol:
                continue
            market[symbol] = {
                "symbol": symbol,
                "company": row.get("company") or symbol,
                "rank": row.get("rank"),
                "ltp": float(row.get("ltp") or 0.0),
                "roc_12": float(row.get("roc_12") or 0.0),
                "ret_1m": float(row.get("ret_1m") or 0.0),
                "execution_month": row.get("execution_month"),
                "as_of_month": row.get("as_of_month"),
            }

        defensive = str(self.strategy["defensive_asset"]).upper()
        defensive_price = _defensive_price_from_regime(regime)
        market.setdefault(
            defensive,
            {
                "symbol": defensive,
                "company": defensive,
                "rank": None,
                "ltp": defensive_price,
                "roc_12": None,
                "ret_1m": None,
                "execution_month": ranks[0].get("execution_month") if ranks else "",
                "as_of_month": ranks[0].get("as_of_month") if ranks else "",
            },
        )
        return market

    def _overlay_live_prices(
        self,
        market_data: dict[str, dict[str, Any]],
        *,
        initial_capital: float,
    ) -> tuple[dict[str, dict[str, Any]], dict[str, Any]]:
        symbols: list[str] = []
        for holding in self.paper.holdings(initial_capital=initial_capital):
            symbol = str(holding.get("symbol") or "").upper().strip()
            if symbol and symbol not in symbols:
                symbols.append(symbol)
        defensive = str(self.strategy.get("defensive_asset") or "").upper().strip()
        if defensive and defensive in market_data and defensive not in symbols:
            symbols.append(defensive)

        status = self.live_prices.ltp_for_symbols(symbols)
        prices = status.get("prices") if isinstance(status, dict) else {}
        if not isinstance(prices, dict) or not prices:
            return market_data, status if isinstance(status, dict) else {"ok": False, "errors": ["Live LTP unavailable."]}

        overlay = {symbol: dict(row) for symbol, row in market_data.items()}
        for symbol, live in prices.items():
            if not isinstance(live, dict):
                continue
            ltp = live.get("ltp")
            try:
                live_ltp = float(ltp)
            except (TypeError, ValueError):
                continue
            if live_ltp <= 0:
                continue
            current = overlay.setdefault(
                symbol,
                {
                    "symbol": symbol,
                    "company": symbol,
                    "rank": None,
                    "roc_12": None,
                    "ret_1m": None,
                    "execution_month": "",
                    "as_of_month": "",
                },
            )
            current["ltp"] = live_ltp
            current["live_ltp"] = live_ltp
            current["price_source"] = live.get("source") or "dhan_marketfeed_ltp"
            current["security_id"] = live.get("security_id")
            current["segment"] = live.get("segment")
        return overlay, status

    def _paper_order_plan(self, paper_plan: dict[str, Any]) -> list[OrderIntent]:
        return [
            OrderIntent(
                action=row["action"],
                symbol=row["symbol"],
                quantity=row.get("quantity"),
                sleeve=row.get("sleeve"),
                reason=row.get("reason") or "",
                status=row.get("status", "planned"),
            )
            for row in paper_plan.get("orders", [])
        ]

    def _alerts(self, regime: dict[str, Any], pdd: dict[str, Any], signal_source: dict[str, Any]) -> list[dict[str, Any]]:
        alerts: list[dict[str, Any]] = []
        if self.config.auto_execution_enabled:
            alerts.append({"level": "critical", "message": "Auto execution flag is enabled. Verify live safety before continuing."})
        else:
            alerts.append({"level": "safe", "message": "Live order placement is disabled."})
        if not self.config.dhan_access_token_present or not self.config.dhan_client_id_present:
            alerts.append({"level": "warning", "message": "Dhan credentials are not fully detected for this Trading OS runtime."})
        if not regime.get("risk_on"):
            source_label = "Dhan scanner" if signal_source.get("name") == "dhan_scanner" else "Reference"
            alerts.append({"level": "warning", "message": f"{source_label} regime is risk-off: {regime.get('reason')}"})
        if signal_source.get("name") == "dhan_scanner" and signal_source.get("coverage") is not None:
            coverage = float(signal_source.get("coverage") or 0.0)
            level = "ok" if coverage >= 0.85 else "warning"
            alerts.append(
                {
                    "level": level,
                    "message": f"Dhan scanner coverage: {coverage * 100:.2f}% required ROC history",
                }
            )
        if pdd.get("stress"):
            alerts.append({"level": "warning", "message": "Reference PDD stress is active."})
        return alerts

    def _ui_contract(
        self,
        metrics: dict[str, Any],
        equity: dict[str, Any],
        ranks: list[dict[str, Any]],
        regime: dict[str, Any],
        pdd: dict[str, Any],
        trade_summary: dict[str, Any],
        alerts: list[dict[str, Any]],
        paper_snapshot: dict[str, Any],
        paper_plan: dict[str, Any],
        signal_source: dict[str, Any],
        rebalance_status: dict[str, Any],
    ) -> dict[str, Any]:
        selected_metric = metrics.get("selected", {})
        paper_summary = paper_snapshot.get("summary", {})
        portfolio_value = float(paper_summary.get("equity") or self.strategy["initial_capital"])
        day_pnl = 0.0
        day_pnl_pct = 0.0
        total_pnl = float(paper_summary.get("total_pnl") or 0.0)
        total_pnl_pct = float(paper_summary.get("total_pnl_pct") or 0.0)

        holdings = self._ui_holdings(portfolio_value, paper_snapshot.get("holdings", []))
        allocation = self._ui_allocation(portfolio_value, holdings)
        pending = self._ui_pending_actions(paper_plan)
        recent_orders = self._ui_recent_orders(trade_summary, pending, paper_snapshot)
        notifications = self._ui_notifications(alerts, regime, pdd, paper_plan, rebalance_status)
        observability = self._ui_observability(signal_source, rebalance_status, paper_plan, paper_snapshot, regime)

        source_name = signal_source.get("name") or "reference_csv"
        scanner_active = source_name == "dhan_scanner"
        source_label = "Dhan scanner" if scanner_active else "Reference CSV"
        coverage = signal_source.get("coverage")
        coverage_text = f" ({float(coverage) * 100:.1f}% coverage)" if coverage is not None else ""

        return {
            "source": "paper_engine_with_dhan_scanner" if scanner_active else "paper_engine_with_reference_rank_regime_data",
            "mode_label": "PAPER TRADING" if self.config.mode == "paper" else self.config.mode.upper(),
            "top_bar": {
                "system_health": "All Systems Online",
                "data_status": f"Paper + {source_label}",
                "last_update": datetime.now().strftime("%I:%M:%S %p"),
                "portfolio_value": portfolio_value,
                "day_pnl": day_pnl,
                "day_pnl_pct": day_pnl_pct,
                "total_pnl": total_pnl,
                "total_pnl_pct": total_pnl_pct,
                "current_drawdown": -abs(float(pdd.get("current_drawdown") or 0.0)),
                "pdd_state": str(pdd.get("state", "PDD Normal")).upper(),
                "pdd_rule": f"{float(pdd['stress_trigger_drawdown']) * 100:.0f}% / {float(pdd['restore_drawdown']) * 100:.0f}%",
                "market_regime": str(regime.get("state", "Unknown")).upper(),
                "breadth": float(regime.get("breadth_30w") or 0.0),
            },
            "holdings": holdings,
            "allocation": allocation,
            "pending_actions": pending,
            "notifications": notifications,
            "observability": observability,
            "rank_rows": self._ui_rank_rows(ranks),
            "market_health": {
                "breadth": float(regime.get("breadth_30w") or 0.0),
                "breadth_state": "Risk On" if regime.get("breadth_30w", 0) and float(regime.get("breadth_30w") or 0) >= 0.50 else "Risk Watch",
                "nifty_state": "Above" if regime.get("niftybees_above_30w") else "Below",
                "nifty_note": "Risk On" if regime.get("niftybees_above_30w") else "Risk Off",
                "market_regime": regime.get("state", "Unknown"),
                "valid_since": regime.get("as_of", ""),
                "reason": regime.get("reason", ""),
            },
            "pdd_status": {
                "equity_peak": float(paper_summary.get("equity_peak") or portfolio_value),
                "peak_date": "Paper peak",
                "drawdown": abs(float(pdd.get("current_drawdown") or 0.0)),
                "rule": f"{float(pdd['stress_trigger_drawdown']) * 100:.0f}% / {float(pdd['restore_drawdown']) * 100:.0f}%",
                "state": str(pdd.get("state", "PDD Normal")).upper(),
            },
            "recent_orders": recent_orders,
            "footer": {
                "environment": "PAPER TRADING" if self.config.mode == "paper" else self.config.mode.upper(),
                "data_source": f"Paper engine + {source_label}{coverage_text}",
                "auto_sync": True,
            },
            "rebalance_status": rebalance_status,
            "signal_source": signal_source,
            "reference_metrics": {
                "selected_scenario": selected_metric.get("scenario"),
                "reference_cagr": selected_metric.get("cagr"),
                "reference_mdd": selected_metric.get("max_drawdown_pct"),
                "reference_equity_as_of": equity.get("latest_date"),
            },
        }

    def _ui_observability(
        self,
        signal_source: dict[str, Any],
        rebalance_status: dict[str, Any],
        paper_plan: dict[str, Any],
        paper_snapshot: dict[str, Any],
        regime: dict[str, Any],
    ) -> dict[str, Any]:
        project_root = self.config.project_root
        scanner_summary = _read_json_file(project_root / "data" / "scanner" / "last_scanner_run.json")
        daily_sync = _read_json_file(project_root / "data" / "dhan" / "last_daily_sync.json")
        paper_last = _read_json_file(project_root / "data" / "paper" / "last_paper_rebalance.json")
        holiday = holiday_status(self.config)
        notification_status = NotificationManager(self.config, self.store).status()

        coverage = signal_source.get("coverage")
        coverage_text = f"{float(coverage) * 100:.2f}%" if coverage is not None else "--"
        scanner_status = str(scanner_summary.get("status") or signal_source.get("status") or "unknown")
        scanner_failure_count = int(scanner_summary.get("failure_count") or signal_source.get("failure_count") or 0)
        scanner_level = "ok" if scanner_status in {"complete", "completed", "ok"} and scanner_failure_count == 0 else "warning"

        token_ready = bool(daily_sync.get("token_ready"))
        dhan_ok = bool(daily_sync.get("dhan_status_ok"))
        dhan_level = "ok" if token_ready and dhan_ok else "warning"
        order_placement = str(daily_sync.get("order_placement") or "blocked")

        plan_summary = paper_plan.get("summary", {})
        paper_skipped = paper_last.get("skipped")
        paper_level = "info" if paper_skipped else "ok"
        if paper_last and not paper_skipped and int(paper_last.get("filled_count") or 0) == 0:
            paper_level = "info"

        next_rebalance = self._next_rebalance_date(rebalance_status)
        next_level = "ok" if rebalance_status.get("allowed") else "info"
        next_status = "DUE TODAY" if rebalance_status.get("allowed") else "WAITING"

        holiday_level = "ok" if holiday.get("ok") else "warning"
        risk_state = str(regime.get("state") or "Unknown")
        telegram_enabled = bool(notification_status.get("telegram_enabled"))
        telegram_configured = bool(notification_status.get("telegram_configured"))
        alert_level = "ok" if (not telegram_enabled or telegram_configured) else "warning"
        alert_value = "TELEGRAM" if telegram_enabled and telegram_configured else "APP ONLY"
        alert_status = "ACTIVE" if telegram_enabled and telegram_configured else "LOCAL"
        if telegram_enabled and not telegram_configured:
            alert_status = "CONFIG NEEDED"
        latest_alert = (notification_status.get("summary") or {}).get("latest") or {}

        cards = [
            {
                "key": "next_rebalance",
                "label": "Next Rebalance",
                "value": next_rebalance,
                "status": next_status,
                "level": next_level,
                "detail": rebalance_status.get("reason") or "",
            },
            {
                "key": "scanner",
                "label": "Scanner",
                "value": f"Run {signal_source.get('run_id') or scanner_summary.get('run_id') or '--'}",
                "status": scanner_status.replace("_", " ").upper(),
                "level": scanner_level,
                "detail": f"Coverage {coverage_text}; failures {scanner_failure_count}",
            },
            {
                "key": "holiday",
                "label": "NSE Holidays",
                "value": f"{holiday.get('holiday_count', 0)} CM",
                "status": "SYNCED" if holiday.get("ok") else "CHECK",
                "level": holiday_level,
                "detail": f"Last sync {holiday.get('synced_at') or '--'}",
            },
            {
                "key": "dhan_sync",
                "label": "Dhan Sync",
                "value": "READY" if token_ready and dhan_ok else "CHECK",
                "status": f"ORDERS {order_placement.upper()}",
                "level": dhan_level,
                "detail": f"Last sync {daily_sync.get('generated_at') or '--'}",
            },
            {
                "key": "paper_cycle",
                "label": "Paper Cycle",
                "value": "SKIPPED" if paper_skipped else "EXECUTED",
                "status": f"{int(paper_last.get('filled_count') or 0)} fills",
                "level": paper_level,
                "detail": paper_last.get("skip_reason") or paper_last.get("generated_at") or "No paper cycle yet",
            },
            {
                "key": "alerting",
                "label": "Alerting",
                "value": alert_value,
                "status": alert_status,
                "level": alert_level,
                "detail": latest_alert.get("title") or "Notification pipeline ready",
            },
        ]

        return {
            "cards": cards,
            "summary": {
                "risk_state": risk_state,
                "scanner_generated_at": scanner_summary.get("generated_at"),
                "paper_equity": paper_snapshot.get("summary", {}).get("equity"),
                "planned_exits": int(plan_summary.get("sell_count") or 0),
                "planned_entries": int(plan_summary.get("buy_count") or 0),
                "next_rebalance": next_rebalance,
            },
        }

    def _next_rebalance_date(self, rebalance_status: dict[str, Any]) -> str:
        holidays = load_holidays(self.config.strategy_config_path.parent / "nse_holidays.json")
        today = date.fromisoformat(str(rebalance_status.get("today") or date.today().isoformat()))
        execution_month = str(rebalance_status.get("execution_month") or today.strftime("%Y-%m"))[:7]
        first_day = date.fromisoformat(str(rebalance_status.get("first_trading_day")))
        if today <= first_day and rebalance_status.get("last_completed_month") != execution_month:
            return first_day.isoformat()
        return first_trading_day(_month_add(today.strftime("%Y-%m"), 1), holidays).isoformat()

    def _ui_holdings(self, portfolio_value: float, paper_holdings: list[dict[str, Any]]) -> list[dict[str, Any]]:
        rows: list[dict[str, Any]] = []
        sorted_holdings = sorted(
            paper_holdings,
            key=lambda row: (
                1 if str(row.get("role") or "").lower() == "defensive" or row.get("symbol") == self.strategy["defensive_asset"] else 0,
                int(row.get("sleeve") or row.get("rank") or 9999),
                str(row.get("symbol") or ""),
            ),
        )
        for index, holding in enumerate(sorted_holdings, start=1):
            symbol = str(holding.get("symbol") or "").upper()
            is_gold = symbol == self.strategy["defensive_asset"] or str(holding.get("role") or "").lower() == "defensive"
            qty = int(float(holding.get("quantity") or 0))
            ltp = float(holding.get("ltp") or holding.get("last_price") or holding.get("avg_price") or 0.0)
            value = float(holding.get("value") or qty * ltp)
            pnl = float(holding.get("pnl") or 0.0)
            pnl_pct = float(holding.get("pnl_pct") or 0.0)
            rows.append(
                {
                    "slot": index,
                    "symbol": symbol,
                    "name": holding.get("name") or symbol,
                    "sleeve": "GOLD" if is_gold else "EQ",
                    "quantity": qty,
                    "avg_price": float(holding.get("avg_price") or 0.0),
                    "ltp": ltp,
                    "value": value,
                    "pnl": pnl,
                    "pnl_pct": pnl_pct,
                    "weight_pct": value / portfolio_value if portfolio_value else 0.0,
                }
            )
        return rows

    def _ui_allocation(self, portfolio_value: float, holdings: list[dict[str, Any]]) -> dict[str, Any]:
        market_value = sum(float(row["value"]) for row in holdings)
        invested = sum(float(row["value"]) - float(row["pnl"]) for row in holdings)
        total_pnl = market_value - invested
        cash = max(0.0, portfolio_value - market_value)
        gold_value = sum(float(row["value"]) for row in holdings if row["sleeve"] == "GOLD")
        equity_value = max(0.0, market_value - gold_value)
        return {
            "total_invested": invested,
            "market_value": market_value,
            "total_pnl": total_pnl,
            "total_pnl_pct": total_pnl / invested if invested else 0.0,
            "cash_available": cash,
            "cash_pct": cash / portfolio_value if portfolio_value else 0.0,
            "gold_allocation_pct": gold_value / portfolio_value if portfolio_value else 0.0,
            "equity_allocation_pct": equity_value / portfolio_value if portfolio_value else 0.0,
        }

    def _ui_pending_actions(self, paper_plan: dict[str, Any]) -> dict[str, list[dict[str, Any]]]:
        exits = [
            {
                "no": index,
                "symbol": row["symbol"],
                "quantity": row.get("quantity") or 0,
                "reason": row.get("reason") or "Planned paper exit",
            }
            for index, row in enumerate(paper_plan.get("sells", []), start=1)
        ]
        entries = [
            {
                "no": index,
                "symbol": row["symbol"],
                "estimated_quantity": row.get("quantity") or 0,
                "rank": row.get("rank") or 0,
                "reason": row.get("reason") or "Planned paper entry",
            }
            for index, row in enumerate(paper_plan.get("buys", []), start=1)
        ]
        return {"exits": exits, "entries": entries}

    def _ui_notifications(
        self,
        alerts: list[dict[str, Any]],
        regime: dict[str, Any],
        pdd: dict[str, Any],
        paper_plan: dict[str, Any],
        rebalance_status: dict[str, Any],
    ) -> list[dict[str, Any]]:
        plan_summary = paper_plan.get("summary", {})
        items = [
            {"level": "ok", "message": "Paper strategy engine refreshed", "time": datetime.now().strftime("%d-%b-%Y %I:%M %p")},
            {
                "level": "info",
                "message": f"Paper plan: {plan_summary.get('sell_count', 0)} exits, {plan_summary.get('buy_count', 0)} entries",
                "time": "Runtime",
            },
            {"level": "info", "message": f"Market regime: {regime.get('state', 'Unknown')}", "time": regime.get("as_of", "")},
            {"level": "info", "message": f"PDD state: {pdd.get('state', 'Unknown')}", "time": "Current"},
            {
                "level": "ok" if rebalance_status.get("allowed") else "info",
                "message": f"Monthly rebalance guard: {rebalance_status.get('reason')}",
                "time": rebalance_status.get("first_trading_day", "Runtime"),
            },
        ]
        for alert in alerts:
            items.append({"level": alert.get("level", "info"), "message": alert.get("message", ""), "time": "Runtime"})
        return items[:6]

    def _ui_rank_rows(self, ranks: list[dict[str, Any]]) -> list[dict[str, Any]]:
        rows = []
        for row in ranks[:10]:
            rank = int(row["rank"])
            rows.append(
                {
                    "rank": rank,
                    "symbol": row["symbol"],
                    "roc_12": float(row.get("roc_12") or 0.0),
                    "ltp": float(row.get("ltp") or 0.0),
                    "status": "In Top 8" if rank <= 8 else "Candidate",
                }
            )
        return rows

    def _ui_recent_orders(
        self,
        trade_summary: dict[str, Any],
        pending: dict[str, list[dict[str, Any]]],
        paper_snapshot: dict[str, Any],
    ) -> list[dict[str, Any]]:
        rows: list[dict[str, Any]] = []
        paper_orders = list(reversed(paper_snapshot.get("orders", [])[-8:]))
        for order in paper_orders:
            rows.append(
                {
                    "time": str(order.get("created_at") or "")[0:16].replace("T", " "),
                    "type": order.get("action", ""),
                    "symbol": order.get("symbol", ""),
                    "quantity": order.get("quantity") or 0,
                    "price": order.get("price"),
                    "status": order.get("status", "FILLED"),
                }
            )
        if len(rows) >= 8:
            return rows[:8]
        for entry in pending.get("entries", []):
            rows.append(
                {
                    "time": "Planned",
                    "type": "BUY",
                    "symbol": entry["symbol"],
                    "quantity": entry["estimated_quantity"],
                    "price": None,
                    "status": "PAPER",
                }
            )
        for exit_row in pending.get("exits", []):
            rows.append(
                {
                    "time": "Planned",
                    "type": "SELL",
                    "symbol": exit_row["symbol"],
                    "quantity": exit_row["quantity"],
                    "price": None,
                    "status": "PAPER",
                }
            )
        for trade in reversed(trade_summary.get("latest_trades", [])[-max(0, 6 - len(rows)):]):
            rows.append(
                {
                    "time": trade.get("exit_date") or "",
                    "type": trade.get("type", "SELL"),
                    "symbol": trade.get("symbol", ""),
                    "quantity": trade.get("quantity") or 0,
                    "price": trade.get("price"),
                    "status": trade.get("status", "FILLED"),
                }
            )
        return rows[:8]


def _defensive_price_from_regime(regime: dict[str, Any]) -> float:
    """Return a practical GOLDBEES reference price from weekly regime data.

    Some historical files store ETF closes in paise-like units. If the raw
    value is very large, scale it down to a dashboard/order-simulation price.
    This will be replaced by live Dhan EOD candles in the scanner phase.
    """
    raw = regime.get("goldbees_close")
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return 125.0
    if value <= 0:
        return 125.0
    if value > 1000:
        return value / 100.0
    return value


def _read_json_file(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError):
        return {}
    return payload if isinstance(payload, dict) else {}


def _month_add(year_month: str, months: int) -> str:
    year, month = [int(part) for part in year_month.split("-")]
    zero_based = (year * 12 + (month - 1)) + months
    return f"{zero_based // 12:04d}-{zero_based % 12 + 1:02d}"
