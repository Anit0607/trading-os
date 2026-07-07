from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any

from ..models import utc_now_iso


class MarketDataStore:
    """SQLite-backed market data tables for Dhan EOD scanner output."""

    def __init__(self, database_path: Path) -> None:
        self.database_path = database_path
        self.database_path.parent.mkdir(parents=True, exist_ok=True)
        self.init_db()

    def connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.database_path)
        conn.row_factory = sqlite3.Row
        return conn

    def init_db(self) -> None:
        with self.connect() as conn:
            conn.executescript(
                """
                create table if not exists market_instruments (
                  symbol text primary key,
                  security_id text not null,
                  exchange text,
                  segment text,
                  series text,
                  instrument text,
                  instrument_type text,
                  name text,
                  display_name text,
                  isin text,
                  lot_size real,
                  is_strategy_universe integer not null default 0,
                  updated_at text not null
                );

                create index if not exists idx_market_instruments_strategy
                  on market_instruments(is_strategy_universe, symbol);

                create table if not exists daily_candles (
                  symbol text not null,
                  security_id text not null,
                  trade_date text not null,
                  open real not null,
                  high real not null,
                  low real not null,
                  close real not null,
                  volume real not null,
                  turnover real not null,
                  source text not null,
                  updated_at text not null,
                  primary key(symbol, trade_date)
                );

                create index if not exists idx_daily_candles_symbol_date
                  on daily_candles(symbol, trade_date);

                create table if not exists scanner_runs (
                  id integer primary key autoincrement,
                  created_at text not null,
                  as_of_date text not null,
                  as_of_month text not null,
                  execution_month text not null,
                  universe_count integer not null,
                  success_count integer not null,
                  failure_count integer not null,
                  status text not null,
                  payload_json text not null
                );

                create table if not exists scanner_rankings (
                  run_id integer not null,
                  rank integer not null,
                  symbol text not null,
                  company text,
                  trade_date text,
                  as_of_month text,
                  execution_month text,
                  close real,
                  roc_12 real,
                  ret_1m real,
                  avg_turnover_3m real,
                  primary key(run_id, rank)
                );

                create index if not exists idx_scanner_rankings_symbol
                  on scanner_rankings(symbol);

                create table if not exists scanner_regime (
                  run_id integer primary key,
                  as_of_date text not null,
                  risk_on integer not null,
                  state text not null,
                  reason text not null,
                  breadth_30w real,
                  count_30w integer,
                  niftybees_close real,
                  niftybees_sma_30w real,
                  niftybees_above_30w integer,
                  goldbees_close real,
                  goldbees_sma_20w real,
                  goldbees_above_20w integer
                );
                """
            )

    def upsert_instruments(self, rows: list[dict[str, Any]]) -> int:
        if not rows:
            return 0
        now = utc_now_iso()
        payload = [
            (
                row["symbol"],
                str(row["security_id"]),
                row.get("exchange"),
                row.get("segment"),
                row.get("series"),
                row.get("instrument"),
                row.get("instrument_type"),
                row.get("name"),
                row.get("display_name"),
                row.get("isin"),
                _float_or_none(row.get("lot_size")),
                1 if row.get("is_strategy_universe") else 0,
                now,
            )
            for row in rows
        ]
        with self.connect() as conn:
            conn.executemany(
                """
                insert into market_instruments(
                  symbol, security_id, exchange, segment, series, instrument,
                  instrument_type, name, display_name, isin, lot_size,
                  is_strategy_universe, updated_at
                )
                values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                on conflict(symbol) do update set
                  security_id = excluded.security_id,
                  exchange = excluded.exchange,
                  segment = excluded.segment,
                  series = excluded.series,
                  instrument = excluded.instrument,
                  instrument_type = excluded.instrument_type,
                  name = excluded.name,
                  display_name = excluded.display_name,
                  isin = excluded.isin,
                  lot_size = excluded.lot_size,
                  is_strategy_universe = excluded.is_strategy_universe,
                  updated_at = excluded.updated_at
                """,
                payload,
            )
        return len(rows)

    def instruments(
        self,
        *,
        strategy_only: bool = False,
        symbols: list[str] | None = None,
        limit: int | None = None,
    ) -> list[dict[str, Any]]:
        clauses: list[str] = []
        params: list[Any] = []
        if strategy_only:
            clauses.append("is_strategy_universe = 1")
        if symbols:
            normalized = [symbol.upper().strip() for symbol in symbols if symbol.strip()]
            if normalized:
                placeholders = ",".join("?" for _ in normalized)
                clauses.append(f"symbol in ({placeholders})")
                params.extend(normalized)
        where = f"where {' and '.join(clauses)}" if clauses else ""
        sql = f"select * from market_instruments {where} order by symbol"
        if limit and limit > 0:
            sql += " limit ?"
            params.append(limit)
        with self.connect() as conn:
            rows = conn.execute(sql, params).fetchall()
        return [_row_dict(row) for row in rows]

    def instrument(self, symbol: str) -> dict[str, Any] | None:
        rows = self.instruments(symbols=[symbol])
        return rows[0] if rows else None

    def instrument_counts(self) -> dict[str, Any]:
        with self.connect() as conn:
            row = conn.execute(
                """
                select
                  count(*) as total,
                  sum(case when is_strategy_universe = 1 then 1 else 0 end) as strategy_universe
                from market_instruments
                """
            ).fetchone()
        return {"total": int(row["total"] or 0), "strategy_universe": int(row["strategy_universe"] or 0)}

    def upsert_daily_candles(self, symbol: str, security_id: str, candles: list[dict[str, Any]]) -> int:
        if not candles:
            return 0
        now = utc_now_iso()
        payload = [
            (
                symbol.upper().strip(),
                str(security_id),
                row["date"],
                float(row["open"]),
                float(row["high"]),
                float(row["low"]),
                float(row["close"]),
                float(row["volume"]),
                float(row.get("turnover") or 0.0),
                row.get("source") or "dhan_historical_daily",
                now,
            )
            for row in candles
        ]
        with self.connect() as conn:
            conn.executemany(
                """
                insert into daily_candles(
                  symbol, security_id, trade_date, open, high, low, close,
                  volume, turnover, source, updated_at
                )
                values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                on conflict(symbol, trade_date) do update set
                  security_id = excluded.security_id,
                  open = excluded.open,
                  high = excluded.high,
                  low = excluded.low,
                  close = excluded.close,
                  volume = excluded.volume,
                  turnover = excluded.turnover,
                  source = excluded.source,
                  updated_at = excluded.updated_at
                """,
                payload,
            )
        return len(candles)

    def latest_candle_date(self, symbol: str) -> str | None:
        with self.connect() as conn:
            row = conn.execute(
                "select max(trade_date) as latest_date from daily_candles where symbol = ?",
                (symbol.upper().strip(),),
            ).fetchone()
        return row["latest_date"] if row and row["latest_date"] else None

    def candles(self, symbol: str, *, end_date: str | None = None, start_date: str | None = None) -> list[dict[str, Any]]:
        clauses = ["symbol = ?"]
        params: list[Any] = [symbol.upper().strip()]
        if start_date:
            clauses.append("trade_date >= ?")
            params.append(start_date)
        if end_date:
            clauses.append("trade_date <= ?")
            params.append(end_date)
        with self.connect() as conn:
            rows = conn.execute(
                f"""
                select symbol, security_id, trade_date, open, high, low, close, volume, turnover
                from daily_candles
                where {' and '.join(clauses)}
                order by trade_date
                """,
                params,
            ).fetchall()
        return [_row_dict(row) for row in rows]

    def candle_stats(self, symbols: list[str] | None = None) -> list[dict[str, Any]]:
        clauses: list[str] = []
        params: list[Any] = []
        if symbols:
            normalized = [symbol.upper().strip() for symbol in symbols if symbol.strip()]
            if normalized:
                placeholders = ",".join("?" for _ in normalized)
                clauses.append(f"symbol in ({placeholders})")
                params.extend(normalized)
        where = f"where {' and '.join(clauses)}" if clauses else ""
        with self.connect() as conn:
            rows = conn.execute(
                f"""
                select symbol, count(*) as candle_count, min(trade_date) as first_date, max(trade_date) as latest_date
                from daily_candles
                {where}
                group by symbol
                order by symbol
                """,
                params,
            ).fetchall()
        return [_row_dict(row) for row in rows]

    def previous_regime_risk_on(self) -> bool | None:
        with self.connect() as conn:
            row = conn.execute(
                """
                select risk_on
                from scanner_regime
                order by run_id desc
                limit 1
                """
            ).fetchone()
        if row is None:
            return None
        return bool(row["risk_on"])

    def save_scanner_run(
        self,
        *,
        payload: dict[str, Any],
        rankings: list[dict[str, Any]],
        regime: dict[str, Any],
    ) -> int:
        with self.connect() as conn:
            cursor = conn.execute(
                """
                insert into scanner_runs(
                  created_at, as_of_date, as_of_month, execution_month,
                  universe_count, success_count, failure_count, status, payload_json
                )
                values (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    utc_now_iso(),
                    payload["as_of_date"],
                    payload["as_of_month"],
                    payload["execution_month"],
                    int(payload["universe_count"]),
                    int(payload["sync"].get("success_count", 0)),
                    int(payload["sync"].get("failure_count", 0)),
                    payload["status"],
                    json.dumps(payload, ensure_ascii=False, sort_keys=True),
                ),
            )
            run_id = int(cursor.lastrowid)
            conn.executemany(
                """
                insert into scanner_rankings(
                  run_id, rank, symbol, company, trade_date, as_of_month,
                  execution_month, close, roc_12, ret_1m, avg_turnover_3m
                )
                values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                [
                    (
                        run_id,
                        int(row["rank"]),
                        row["symbol"],
                        row.get("company"),
                        row.get("trade_date"),
                        row.get("as_of_month"),
                        row.get("execution_month"),
                        _float_or_none(row.get("close")),
                        _float_or_none(row.get("roc_12")),
                        _float_or_none(row.get("ret_1m")),
                        _float_or_none(row.get("avg_turnover_3m")),
                    )
                    for row in rankings
                ],
            )
            conn.execute(
                """
                insert into scanner_regime(
                  run_id, as_of_date, risk_on, state, reason, breadth_30w,
                  count_30w, niftybees_close, niftybees_sma_30w,
                  niftybees_above_30w, goldbees_close, goldbees_sma_20w,
                  goldbees_above_20w
                )
                values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    run_id,
                    regime["as_of_date"],
                    1 if regime.get("risk_on") else 0,
                    regime.get("state") or "",
                    regime.get("reason") or "",
                    _float_or_none(regime.get("breadth_30w")),
                    int(regime.get("count_30w") or 0),
                    _float_or_none(regime.get("niftybees_close")),
                    _float_or_none(regime.get("niftybees_sma_30w")),
                    _bool_int(regime.get("niftybees_above_30w")),
                    _float_or_none(regime.get("goldbees_close")),
                    _float_or_none(regime.get("goldbees_sma_20w")),
                    _bool_int(regime.get("goldbees_above_20w")),
                ),
            )
        return run_id

    def latest_scanner_run(self) -> dict[str, Any] | None:
        with self.connect() as conn:
            row = conn.execute(
                """
                select id, payload_json
                from scanner_runs
                order by id desc
                limit 1
                """
            ).fetchone()
        if row is None:
            return None
        payload = json.loads(row["payload_json"])
        payload["run_id"] = int(row["id"])
        return payload


def _row_dict(row: sqlite3.Row) -> dict[str, Any]:
    return {key: row[key] for key in row.keys()}


def _float_or_none(value: Any) -> float | None:
    if value in (None, ""):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _bool_int(value: Any) -> int:
    return 1 if bool(value) else 0
