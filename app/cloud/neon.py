from __future__ import annotations

import hashlib
import json
import sys
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Any

from ..config import AppConfig
from ..models import utc_now_iso

_VENDOR_PATH = Path(__file__).resolve().parents[2] / ".python_packages"
if _VENDOR_PATH.exists() and str(_VENDOR_PATH) not in sys.path:
    sys.path.insert(0, str(_VENDOR_PATH))

try:  # pragma: no cover - exercised only when psycopg is installed/configured
    import psycopg  # type: ignore
except ImportError:  # pragma: no cover
    psycopg = None  # type: ignore


class NeonSyncError(RuntimeError):
    """Raised when the optional Neon cloud mirror cannot complete an operation."""


class NeonClient:
    def __init__(
        self,
        *,
        database_url: str | None,
        worker_id: str,
        stale_after_minutes: int = 180,
    ) -> None:
        self.database_url = database_url
        self.worker_id = worker_id
        self.stale_after_minutes = stale_after_minutes

    @classmethod
    def from_config(cls, config: AppConfig) -> "NeonClient":
        return cls(
            database_url=config.database_url,
            worker_id=config.cloud_worker_id,
            stale_after_minutes=config.cloud_stale_after_minutes,
        )

    @property
    def configured(self) -> bool:
        return bool(self.database_url) and self.database_url.lower().startswith(("postgres://", "postgresql://"))

    @property
    def driver_available(self) -> bool:
        return psycopg is not None

    def status(self) -> dict[str, Any]:
        status = {
            "configured": self.configured,
            "driver_available": self.driver_available,
            "worker_id": self.worker_id,
            "stale_after_minutes": self.stale_after_minutes,
        }
        if not self.configured or not self.driver_available:
            return {**status, "ok": False, "reason": self._disabled_reason()}
        try:
            with self._connect() as conn:
                row = self._fetchone(conn, "select now()::text")
            return {**status, "ok": True, "server_time": row[0] if row else None}
        except Exception as exc:  # pragma: no cover - depends on live Neon
            return {**status, "ok": False, "reason": str(exc)}

    def ensure_schema(self) -> dict[str, Any]:
        self._require_ready()
        statements = [
            """
            create table if not exists dashboard_snapshots (
              id bigserial primary key,
              created_at timestamptz not null default now(),
              source text not null default 'local_worker',
              worker_id text not null,
              snapshot_json jsonb not null
            )
            """,
            "create index if not exists idx_dashboard_snapshots_created_at on dashboard_snapshots(created_at desc)",
            """
            create table if not exists portfolio_daily (
              trade_date date primary key,
              created_at timestamptz not null default now(),
              worker_id text not null,
              portfolio_value numeric,
              total_pnl numeric,
              total_pnl_pct numeric,
              current_drawdown numeric,
              cash numeric,
              equity_allocation_pct numeric,
              gold_allocation_pct numeric,
              payload_json jsonb not null
            )
            """,
            """
            create table if not exists scanner_runs (
              run_id text primary key,
              created_at timestamptz not null default now(),
              worker_id text not null,
              status text,
              as_of_month text,
              execution_month text,
              regime_state text,
              coverage numeric,
              top_ranks_json jsonb not null,
              payload_json jsonb not null
            )
            """,
            """
            create table if not exists rebalance_events (
              event_key text primary key,
              created_at timestamptz not null default now(),
              worker_id text not null,
              event_type text not null,
              execution_month text,
              skipped boolean,
              filled_count integer,
              payload_json jsonb not null
            )
            """,
            """
            create table if not exists alerts (
              id bigserial primary key,
              local_id bigint,
              created_at timestamptz not null default now(),
              worker_id text not null,
              level text,
              channel text,
              event_type text,
              title text,
              message text,
              status text,
              payload_json jsonb not null,
              unique(worker_id, channel, local_id)
            )
            """,
            "create index if not exists idx_alerts_created_at on alerts(created_at desc)",
            """
            create table if not exists worker_heartbeats (
              worker_id text primary key,
              last_seen_at timestamptz not null default now(),
              status text not null,
              payload_json jsonb not null
            )
            """,
        ]
        with self._connect() as conn:
            for statement in statements:
                self._execute(conn, statement)
        return {"ok": True, "tables": 6}

    def push_worker_heartbeat(self, *, status: str = "online", payload: dict[str, Any] | None = None) -> dict[str, Any]:
        self.ensure_schema()
        heartbeat_payload = {"synced_at": utc_now_iso(), **(payload or {})}
        with self._connect() as conn:
            self._execute(
                conn,
                """
                insert into worker_heartbeats(worker_id, last_seen_at, status, payload_json)
                values (%s, now(), %s, %s::jsonb)
                on conflict(worker_id) do update set
                  last_seen_at = excluded.last_seen_at,
                  status = excluded.status,
                  payload_json = excluded.payload_json
                """,
                (self.worker_id, status, _json(heartbeat_payload)),
            )
        return {"ok": True, "worker_id": self.worker_id, "status": status}

    def push_dashboard_snapshot(self, snapshot: dict[str, Any], *, source: str = "local_worker") -> dict[str, Any]:
        self.ensure_schema()
        created_at = _iso_or_none(snapshot.get("generated_at")) or utc_now_iso()
        with self._connect() as conn:
            self._execute(
                conn,
                """
                insert into dashboard_snapshots(created_at, source, worker_id, snapshot_json)
                values (%s::timestamptz, %s, %s, %s::jsonb)
                """,
                (created_at, source, self.worker_id, _json(snapshot)),
            )
        portfolio = self.push_portfolio_daily(snapshot)
        return {"ok": True, "created_at": created_at, "portfolio_daily": portfolio}

    def push_portfolio_daily(self, snapshot: dict[str, Any]) -> dict[str, Any]:
        paper = _dict(snapshot.get("paper"))
        portfolio = _dict(paper.get("portfolio"))
        summary = _dict(portfolio.get("summary"))
        ui = _dict(snapshot.get("ui"))
        allocation = _dict(ui.get("allocation"))
        generated_at = _iso_or_none(snapshot.get("generated_at")) or utc_now_iso()
        trade_date = _date_from_iso(generated_at)
        with self._connect() as conn:
            self._execute(
                conn,
                """
                insert into portfolio_daily(
                  trade_date, created_at, worker_id, portfolio_value, total_pnl,
                  total_pnl_pct, current_drawdown, cash, equity_allocation_pct,
                  gold_allocation_pct, payload_json
                )
                values (%s::date, %s::timestamptz, %s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb)
                on conflict(trade_date) do update set
                  created_at = excluded.created_at,
                  worker_id = excluded.worker_id,
                  portfolio_value = excluded.portfolio_value,
                  total_pnl = excluded.total_pnl,
                  total_pnl_pct = excluded.total_pnl_pct,
                  current_drawdown = excluded.current_drawdown,
                  cash = excluded.cash,
                  equity_allocation_pct = excluded.equity_allocation_pct,
                  gold_allocation_pct = excluded.gold_allocation_pct,
                  payload_json = excluded.payload_json
                """,
                (
                    trade_date,
                    generated_at,
                    self.worker_id,
                    _number(summary.get("equity")),
                    _number(summary.get("total_pnl")),
                    _number(summary.get("total_pnl_pct")),
                    _number(summary.get("current_drawdown")),
                    _number(summary.get("cash")),
                    _number(allocation.get("equity_allocation_pct")),
                    _number(allocation.get("gold_allocation_pct")),
                    _json({"summary": summary, "allocation": allocation, "holdings": portfolio.get("holdings", [])}),
                ),
            )
        return {"ok": True, "trade_date": trade_date}

    def push_scanner_run(self, payload: dict[str, Any]) -> dict[str, Any]:
        if not payload or payload.get("ok") is False and not payload.get("run_id"):
            return {"ok": False, "reason": "No scanner run payload available."}
        self.ensure_schema()
        diagnostics = _dict(payload.get("ranking_diagnostics"))
        regime = _dict(payload.get("regime"))
        run_id = str(payload.get("run_id") or _stable_key("scanner", payload))
        created_at = _iso_or_none(payload.get("generated_at")) or utc_now_iso()
        top_ranks = payload.get("rankings") or payload.get("top_rankings") or []
        with self._connect() as conn:
            self._execute(
                conn,
                """
                insert into scanner_runs(
                  run_id, created_at, worker_id, status, as_of_month, execution_month,
                  regime_state, coverage, top_ranks_json, payload_json
                )
                values (%s, %s::timestamptz, %s, %s, %s, %s, %s, %s, %s::jsonb, %s::jsonb)
                on conflict(run_id) do update set
                  created_at = excluded.created_at,
                  worker_id = excluded.worker_id,
                  status = excluded.status,
                  as_of_month = excluded.as_of_month,
                  execution_month = excluded.execution_month,
                  regime_state = excluded.regime_state,
                  coverage = excluded.coverage,
                  top_ranks_json = excluded.top_ranks_json,
                  payload_json = excluded.payload_json
                """,
                (
                    run_id,
                    created_at,
                    self.worker_id,
                    payload.get("status"),
                    payload.get("as_of_month"),
                    payload.get("execution_month"),
                    regime.get("state"),
                    _number(diagnostics.get("required_history_coverage")),
                    _json(top_ranks[:21] if isinstance(top_ranks, list) else top_ranks),
                    _json(_lean_scanner_payload(payload)),
                ),
            )
        return {"ok": True, "run_id": run_id}

    def push_rebalance_event(self, payload: dict[str, Any], *, event_type: str = "paper_rebalance") -> dict[str, Any]:
        if not payload:
            return {"ok": False, "reason": "No rebalance payload available."}
        self.ensure_schema()
        status = _dict(payload.get("rebalance_status"))
        paper = _dict(payload.get("paper_rebalance"))
        event_key = _stable_key(event_type, payload)
        created_at = _iso_or_none(payload.get("generated_at")) or utc_now_iso()
        with self._connect() as conn:
            self._execute(
                conn,
                """
                insert into rebalance_events(
                  event_key, created_at, worker_id, event_type, execution_month,
                  skipped, filled_count, payload_json
                )
                values (%s, %s::timestamptz, %s, %s, %s, %s, %s, %s::jsonb)
                on conflict(event_key) do update set
                  created_at = excluded.created_at,
                  worker_id = excluded.worker_id,
                  event_type = excluded.event_type,
                  execution_month = excluded.execution_month,
                  skipped = excluded.skipped,
                  filled_count = excluded.filled_count,
                  payload_json = excluded.payload_json
                """,
                (
                    event_key,
                    created_at,
                    self.worker_id,
                    event_type,
                    status.get("execution_month") or payload.get("execution_month"),
                    bool(payload.get("skipped")),
                    int(paper.get("filled_count") or payload.get("filled_count") or 0),
                    _json(payload),
                ),
            )
        return {"ok": True, "event_key": event_key}

    def push_notifications(self, notifications: list[dict[str, Any]]) -> dict[str, Any]:
        if not notifications:
            return {"ok": True, "count": 0}
        self.ensure_schema()
        count = 0
        with self._connect() as conn:
            for row in notifications:
                local_id = row.get("id")
                if local_id is None:
                    continue
                self._execute(
                    conn,
                    """
                    insert into alerts(
                      local_id, created_at, worker_id, level, channel, event_type,
                      title, message, status, payload_json
                    )
                    values (%s, %s::timestamptz, %s, %s, %s, %s, %s, %s, %s, %s::jsonb)
                    on conflict(worker_id, channel, local_id) do update set
                      created_at = excluded.created_at,
                      level = excluded.level,
                      event_type = excluded.event_type,
                      title = excluded.title,
                      message = excluded.message,
                      status = excluded.status,
                      payload_json = excluded.payload_json
                    """,
                    (
                        int(local_id),
                        _iso_or_none(row.get("created_at")) or utc_now_iso(),
                        self.worker_id,
                        row.get("level"),
                        row.get("channel"),
                        row.get("event_type"),
                        row.get("title"),
                        row.get("message"),
                        row.get("status"),
                        _json(_dict(row.get("payload"))),
                    ),
                )
                count += 1
        return {"ok": True, "count": count}

    def latest_dashboard_snapshot(self) -> dict[str, Any]:
        self._require_ready()
        with self._connect() as conn:
            row = self._fetchone(
                conn,
                """
                select id, created_at::text, source, worker_id, snapshot_json::text
                from dashboard_snapshots
                order by created_at desc, id desc
                limit 1
                """,
            )
        if not row:
            return {"ok": False, "reason": "No dashboard snapshot has been synced to Neon yet."}
        snapshot = _loads_json(row[4])
        return {
            "ok": True,
            "id": row[0],
            "created_at": row[1],
            "source": row[2],
            "worker_id": row[3],
            "snapshot": snapshot,
        }

    def latest_worker_heartbeat(self) -> dict[str, Any]:
        self._require_ready()
        with self._connect() as conn:
            row = self._fetchone(
                conn,
                """
                select worker_id, last_seen_at::text, status, payload_json::text,
                       extract(epoch from (now() - last_seen_at))::float
                from worker_heartbeats
                where worker_id = %s
                """,
                (self.worker_id,),
            )
        if not row:
            return {"ok": False, "reason": "No worker heartbeat has been synced yet.", "worker_id": self.worker_id}
        age_seconds = float(row[4] or 0)
        return {
            "ok": True,
            "worker_id": row[0],
            "last_seen_at": row[1],
            "status": row[2],
            "payload": _loads_json(row[3]),
            "age_seconds": age_seconds,
            "stale": age_seconds > self.stale_after_minutes * 60,
            "stale_after_seconds": self.stale_after_minutes * 60,
        }

    def recent_alerts(self, limit: int = 50) -> list[dict[str, Any]]:
        self._require_ready()
        with self._connect() as conn:
            rows = self._fetchall(
                conn,
                """
                select local_id, created_at::text, level, channel, event_type, title, message, status, payload_json::text
                from alerts
                order by created_at desc, id desc
                limit %s
                """,
                (limit,),
            )
        return [
            {
                "id": row[0],
                "created_at": row[1],
                "level": row[2],
                "channel": row[3],
                "event_type": row[4],
                "title": row[5],
                "message": row[6],
                "status": row[7],
                "payload": _loads_json(row[8]),
            }
            for row in rows
        ]

    def _disabled_reason(self) -> str:
        if self.database_url and not self.database_url.lower().startswith(("postgres://", "postgresql://")):
            return "DATABASE_URL is present but is not a Postgres/Neon connection string."
        if not self.configured:
            return "DATABASE_URL is not configured."
        if not self.driver_available:
            return "Python package psycopg is not installed."
        return "Neon client is unavailable."

    def _require_ready(self) -> None:
        if not self.configured:
            raise NeonSyncError("DATABASE_URL is not configured.")
        if not self.driver_available:
            raise NeonSyncError("Python package psycopg is not installed. Install requirements.txt first.")

    def _connect(self):
        self._require_ready()
        conn = psycopg.connect(self.database_url)  # type: ignore[union-attr]
        conn.autocommit = True
        return conn

    @staticmethod
    def _execute(conn: Any, sql: str, params: tuple[Any, ...] | None = None) -> None:
        with conn.cursor() as cursor:
            cursor.execute(sql, params or ())

    @staticmethod
    def _fetchone(conn: Any, sql: str, params: tuple[Any, ...] | None = None) -> tuple[Any, ...] | None:
        with conn.cursor() as cursor:
            cursor.execute(sql, params or ())
            return cursor.fetchone()

    @staticmethod
    def _fetchall(conn: Any, sql: str, params: tuple[Any, ...] | None = None) -> list[tuple[Any, ...]]:
        with conn.cursor() as cursor:
            cursor.execute(sql, params or ())
            return list(cursor.fetchall())


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, default=str)


def _loads_json(value: Any) -> Any:
    if isinstance(value, (dict, list)):
        return value
    if value in (None, ""):
        return {}
    return json.loads(str(value))


def _dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _number(value: Any) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _iso_or_none(value: Any) -> str | None:
    if not value:
        return None
    text = str(value).strip()
    if not text:
        return None
    return text


def _date_from_iso(value: str) -> str:
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).date().isoformat()
    except ValueError:
        return date.today().isoformat()


def _stable_key(prefix: str, payload: dict[str, Any]) -> str:
    digest = hashlib.sha256(_json(payload).encode("utf-8")).hexdigest()[:24]
    return f"{prefix}:{digest}"


def _lean_scanner_payload(payload: dict[str, Any]) -> dict[str, Any]:
    allowed = [
        "ok",
        "run_id",
        "status",
        "as_of_date",
        "as_of_month",
        "execution_month",
        "universe_count",
        "sync",
        "ranking_diagnostics",
        "regime",
        "rankings",
    ]
    lean = {key: payload.get(key) for key in allowed if key in payload}
    if isinstance(lean.get("rankings"), list):
        lean["rankings"] = lean["rankings"][:21]
    return lean


def cloud_timestamp() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")
