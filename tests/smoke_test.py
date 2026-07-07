from pathlib import Path
import sys
import gc
import shutil
from datetime import date
from dataclasses import replace

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))

from app.config import get_config, load_strategy_config
from app.auth.dhan_token import generate_totp
from app.broker.dhan import DhanBroker, DhanRuntimeGuard, _is_nse_eq_row, _normalize_instrument_row
from app.broker.paper import PaperBroker
from app.broker.snapshot import BROKER_SNAPSHOT_MAX_AGE_SECONDS, BrokerSnapshotService
from app.cloud.neon import NeonClient
from app.data.dhan_scanner import month_add, normalize_dhan_daily_candles, previous_completed_month, regime_state_with_hysteresis
from app.data.nse_holidays import DEFAULT_SEGMENT, holiday_status
from app.notifications import NotificationManager
from app.portfolio.reconciliation import PortfolioReconciler
from app.storage import StateStore
from app.strategy.engine import StrategyEngine
from app.strategy.rebalance_calendar import first_trading_day, load_holidays, rebalance_day_status


def test_engine_snapshot():
    cfg = get_config()
    strategy = load_strategy_config(cfg)
    assert strategy["target_stock_slots"] == 8
    snapshot = StrategyEngine(cfg).dashboard_snapshot().to_dict()
    assert snapshot["strategy_name"]
    assert snapshot["target_sleeves"]
    assert snapshot["metrics"]["selected"]["cagr"] > 0


def test_dhan_live_order_guard_blocks_paper_mode():
    guard = DhanRuntimeGuard(
        mode="paper",
        auto_execution_enabled=False,
        client_id_present=True,
        access_token_present=True,
    )
    guard.assert_read_allowed()
    try:
        guard.assert_order_allowed()
    except RuntimeError as exc:
        assert "TRADING_OS_MODE" in str(exc)
    else:
        raise AssertionError("Dhan order guard should block paper mode.")


def test_dhan_nse_eq_instrument_normalization():
    row = {
        "EXCH_ID": "NSE",
        "SEGMENT": "E",
        "SECURITY_ID": "2885",
        "ISIN": "INE002A01018",
        "INSTRUMENT": "EQUITY",
        "UNDERLYING_SYMBOL": "RELIANCE",
        "SYMBOL_NAME": "RELIANCE INDUSTRIES LTD",
        "DISPLAY_NAME": "Reliance Industries",
        "INSTRUMENT_TYPE": "ES",
        "SERIES": "EQ",
        "LOT_SIZE": "1.0",
    }
    assert _is_nse_eq_row(row)
    normalized = _normalize_instrument_row(row)
    assert normalized["security_id"] == "2885"
    assert normalized["symbol"] == "RELIANCE"


def test_dhan_market_ltp_payload_normalization():
    class FakeClient:
        def __init__(self):
            self.payload = None

        def post(self, path, payload):
            self.path = path
            self.payload = payload
            return {"status": "success", "data": {"NSE_EQ": {"14428": {"last_price": 120.31}}}}

    client = FakeClient()
    broker = DhanBroker(
        guard=DhanRuntimeGuard(
            mode="paper",
            auto_execution_enabled=False,
            client_id_present=True,
            access_token_present=True,
        ),
        client=client,
    )
    result = broker.market_ltp({"NSE_EQ": ["14428", "bad"]})
    assert client.path == "/marketfeed/ltp"
    assert client.payload == {"NSE_EQ": [14428]}
    assert result["data"]["NSE_EQ"]["14428"]["last_price"] == 120.31


def test_reconciliation_plans_exits_without_broker_call():
    cfg = get_config()
    engine_snapshot = StrategyEngine(cfg).dashboard_snapshot().to_dict()
    reconciler = PortfolioReconciler(cfg)
    reconciler._read_dhan_state = lambda: {  # type: ignore[method-assign]
        "ok": True,
        "source": "test",
        "message": "test dhan state",
        "endpoint_status": {},
        "holdings": [
            {
                "symbol": "OLDSTOCK",
                "security_id": "1",
                "quantity": 10.0,
                "avg_price": 100.0,
                "ltp": 90.0,
                "value": 900.0,
                "pnl": -100.0,
                "raw_keys": [],
            }
        ],
        "funds": {"available_cash": 100000.0},
    }
    reconciliation = reconciler.snapshot(engine_snapshot)
    assert reconciliation["read_only"] is True
    assert reconciliation["pending_actions"]["exits"]
    assert reconciliation["summary"]["available_cash"] == 100000.0


def test_broker_snapshot_cache_round_trip():
    class FakeBroker:
        def holdings(self):
            return [
                {
                    "tradingSymbol": "TESTEQ",
                    "totalQty": 12,
                    "avgCostPrice": 100,
                    "lastTradedPrice": 111,
                }
            ]

        def fund_limits(self):
            return {"availabelBalance": 12345.67, "utilizedAmount": 10}

        def positions(self):
            return []

        def order_book(self):
            return [{"orderId": "1", "tradingSymbol": "TESTEQ"}]

        def trade_book(self):
            return []

    cfg = get_config()
    test_root = cfg.project_root / "data" / "smoke_test_broker_snapshot"
    test_cfg = replace(cfg, project_root=test_root, database_path=test_root / "broker_snapshot.db")
    store = StateStore(test_cfg.database_path)
    service = BrokerSnapshotService(test_cfg, store=store, broker=FakeBroker())
    snapshot = service.sync()
    latest = service.latest()
    assert snapshot["ok"] is True
    assert latest["cache"]["available"] is True
    assert latest["cache"]["status"] == "fresh"
    assert latest["summary"]["holding_count"] == 1
    assert latest["holdings"][0]["symbol"] == "TESTEQ"
    assert latest["funds"]["available_cash"] == 12345.67
    del store
    gc.collect()
    shutil.rmtree(test_root, ignore_errors=True)


def test_paper_broker_executes_once_without_duplicate_buys():
    cfg = get_config()
    store = StateStore(cfg.database_path.with_name("smoke_test_paper.db"))
    broker = PaperBroker(store)
    broker.reset(initial_capital=100000.0)
    target = [{"slot": 1, "symbol": "TESTEQ", "role": "stock", "reason": "test"}]
    market_data = {"TESTEQ": {"symbol": "TESTEQ", "ltp": 100.0, "company": "Test Eq", "rank": 1, "roc_12": 1.2}}
    result = broker.execute_plan(
        target_sleeves=target,
        retain_symbols={"TESTEQ"},
        market_data=market_data,
        initial_capital=100000.0,
        slippage=0.005,
        as_of="2026-05",
    )
    assert result["filled_count"] == 1
    assert result["portfolio"]["summary"]["holding_count"] == 1
    next_plan = broker.plan_rebalance(
        target_sleeves=target,
        retain_symbols={"TESTEQ"},
        market_data=market_data,
        initial_capital=100000.0,
        slippage=0.005,
        as_of="2026-05",
    )
    assert next_plan["summary"]["buy_count"] == 0
    del broker
    del store
    gc.collect()
    try:
        cfg.database_path.with_name("smoke_test_paper.db").unlink(missing_ok=True)
    except TypeError:
        if cfg.database_path.with_name("smoke_test_paper.db").exists():
            cfg.database_path.with_name("smoke_test_paper.db").unlink()


def test_broker_snapshot_cache_threshold_is_daily():
    assert BROKER_SNAPSHOT_MAX_AGE_SECONDS == 24 * 60 * 60


def test_totp_generation_is_stable_for_known_time():
    # RFC 6238 test secret in base32 form for "12345678901234567890".
    assert generate_totp("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", for_time=59, digits=8) == "94287082"


def test_dhan_scanner_helpers():
    assert previous_completed_month("2026-06-29") == "2026-05"
    assert month_add("2026-01", -12) == "2025-01"
    assert month_add("2026-12", 1) == "2027-01"
    candles = normalize_dhan_daily_candles(
        "RELIANCE",
        "2885",
        {
            "timestamp": [1780252200.0],
            "open": [1332.5],
            "high": [1335.5],
            "low": [1318.5],
            "close": [1320.0],
            "volume": [10700603.0],
        },
    )
    assert candles[0]["date"] == "2026-06-01"
    assert candles[0]["turnover"] == 1320.0 * 10700603.0
    risk_on, reason = regime_state_with_hysteresis(
        nifty_above=True,
        breadth=0.55,
        previous_risk_on=False,
        breadth_off=0.35,
        breadth_on=0.50,
    )
    assert risk_on is True
    assert "Recovered" in reason


def test_monthly_rebalance_calendar_helpers():
    assert first_trading_day("2026-06", set()) == date(2026, 6, 1)
    assert first_trading_day("2026-08", set()) == date(2026, 8, 3)  # Aug 1-2 are weekend
    assert first_trading_day("2026-06", {date(2026, 6, 1)}) == date(2026, 6, 2)
    allowed = rebalance_day_status(
        today=date(2026, 6, 1),
        execution_month="2026-06",
        last_completed_month=None,
        holidays=set(),
    )
    assert allowed["allowed"] is True
    not_today = rebalance_day_status(
        today=date(2026, 6, 2),
        execution_month="2026-06",
        last_completed_month=None,
        holidays=set(),
    )
    assert not_today["allowed"] is False
    already_done = rebalance_day_status(
        today=date(2026, 6, 1),
        execution_month="2026-06",
        last_completed_month="2026-06",
        holidays=set(),
    )
    assert already_done["allowed"] is False


def test_nse_holiday_calendar_config_and_parser():
    cfg = get_config()
    status = holiday_status(cfg)
    assert status["segment"] == DEFAULT_SEGMENT
    assert status["holiday_count"] >= 1
    holidays = load_holidays(cfg.project_root / "config" / "nse_holidays.json")
    assert date(2026, 5, 1) in holidays
    assert first_trading_day("2026-05", holidays) == date(2026, 5, 4)


def test_notification_manager_records_local_and_skips_telegram_safely():
    cfg = get_config()
    test_db = cfg.database_path.with_name("smoke_test_notifications.db")
    safe_cfg = replace(
        cfg,
        database_path=test_db,
        alerts_app_enabled=True,
        alerts_telegram_enabled=False,
        telegram_bot_token=None,
        telegram_chat_id=None,
        telegram_bot_token_present=False,
        telegram_chat_id_present=False,
    )
    store = StateStore(test_db)
    manager = NotificationManager(safe_cfg, store)
    result = manager.notify(
        level="info",
        event_type="smoke_test",
        title="Smoke notification",
        message="Notification manager smoke test.",
        payload={"mode": "paper"},
    )
    assert result["ok"] is True
    recent = manager.recent(limit=10)["notifications"]
    assert len(recent) == 2
    statuses = {(row["channel"], row["status"]) for row in recent}
    assert ("app", "delivered") in statuses
    assert ("telegram", "skipped") in statuses
    del manager
    del store
    gc.collect()
    try:
        test_db.unlink(missing_ok=True)
    except TypeError:
        if test_db.exists():
            test_db.unlink()


def test_neon_client_disabled_is_safe_without_database_url():
    client = NeonClient(database_url=None, worker_id="smoke-test-worker")
    status = client.status()
    assert status["configured"] is False
    assert status["ok"] is False
    assert "DATABASE_URL" in status["reason"]


if __name__ == "__main__":
    test_engine_snapshot()
    test_dhan_live_order_guard_blocks_paper_mode()
    test_dhan_nse_eq_instrument_normalization()
    test_dhan_market_ltp_payload_normalization()
    test_reconciliation_plans_exits_without_broker_call()
    test_broker_snapshot_cache_round_trip()
    test_paper_broker_executes_once_without_duplicate_buys()
    test_broker_snapshot_cache_threshold_is_daily()
    test_totp_generation_is_stable_for_known_time()
    test_dhan_scanner_helpers()
    test_monthly_rebalance_calendar_helpers()
    test_nse_holiday_calendar_config_and_parser()
    test_notification_manager_records_local_and_skips_telegram_safely()
    test_neon_client_disabled_is_safe_without_database_url()
    print("smoke test passed")
