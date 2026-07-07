from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any

from .models import utc_now_iso


class StateStore:
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
                create table if not exists kv_store (
                  key text primary key,
                  value text not null,
                  updated_at text not null
                );

                create table if not exists events (
                  id integer primary key autoincrement,
                  created_at text not null,
                  level text not null,
                  event_type text not null,
                  message text not null,
                  payload_json text not null
                );

                create table if not exists dashboard_snapshots (
                  id integer primary key autoincrement,
                  created_at text not null,
                  snapshot_json text not null
                );

                create table if not exists notifications (
                  id integer primary key autoincrement,
                  created_at text not null,
                  level text not null,
                  channel text not null,
                  event_type text not null,
                  title text not null,
                  message text not null,
                  status text not null,
                  payload_json text not null,
                  delivery_result_json text not null,
                  delivered_at text
                );
                """
            )

    def set_value(self, key: str, value: Any) -> None:
        payload = json.dumps(value, ensure_ascii=False, sort_keys=True)
        with self.connect() as conn:
            conn.execute(
                """
                insert into kv_store(key, value, updated_at)
                values (?, ?, ?)
                on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at
                """,
                (key, payload, utc_now_iso()),
            )

    def get_value(self, key: str, default: Any = None) -> Any:
        with self.connect() as conn:
            row = conn.execute("select value from kv_store where key = ?", (key,)).fetchone()
        if row is None:
            return default
        return json.loads(row["value"])

    def record_event(self, level: str, event_type: str, message: str, payload: dict[str, Any] | None = None) -> None:
        with self.connect() as conn:
            conn.execute(
                """
                insert into events(created_at, level, event_type, message, payload_json)
                values (?, ?, ?, ?, ?)
                """,
                (utc_now_iso(), level, event_type, message, json.dumps(payload or {}, ensure_ascii=False, sort_keys=True)),
            )

    def recent_events(self, limit: int = 50) -> list[dict[str, Any]]:
        with self.connect() as conn:
            rows = conn.execute(
                """
                select created_at, level, event_type, message, payload_json
                from events
                order by id desc
                limit ?
                """,
                (limit,),
            ).fetchall()
        events = []
        for row in rows:
            events.append(
                {
                    "created_at": row["created_at"],
                    "level": row["level"],
                    "event_type": row["event_type"],
                    "message": row["message"],
                    "payload": json.loads(row["payload_json"]),
                }
            )
        return events

    def save_dashboard_snapshot(self, snapshot: dict[str, Any]) -> None:
        with self.connect() as conn:
            conn.execute(
                "insert into dashboard_snapshots(created_at, snapshot_json) values (?, ?)",
                (utc_now_iso(), json.dumps(snapshot, ensure_ascii=False, sort_keys=True)),
            )

    def record_notification(
        self,
        *,
        level: str,
        channel: str,
        event_type: str,
        title: str,
        message: str,
        status: str,
        payload: dict[str, Any] | None = None,
        delivery_result: dict[str, Any] | None = None,
        delivered_at: str | None = None,
    ) -> int:
        with self.connect() as conn:
            cursor = conn.execute(
                """
                insert into notifications(
                  created_at, level, channel, event_type, title, message, status,
                  payload_json, delivery_result_json, delivered_at
                )
                values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    utc_now_iso(),
                    level,
                    channel,
                    event_type,
                    title,
                    message,
                    status,
                    json.dumps(payload or {}, ensure_ascii=False, sort_keys=True),
                    json.dumps(delivery_result or {}, ensure_ascii=False, sort_keys=True),
                    delivered_at,
                ),
            )
            return int(cursor.lastrowid)

    def recent_notifications(self, limit: int = 50) -> list[dict[str, Any]]:
        with self.connect() as conn:
            rows = conn.execute(
                """
                select id, created_at, level, channel, event_type, title, message, status,
                       payload_json, delivery_result_json, delivered_at
                from notifications
                order by id desc
                limit ?
                """,
                (limit,),
            ).fetchall()
        notifications = []
        for row in rows:
            notifications.append(
                {
                    "id": row["id"],
                    "created_at": row["created_at"],
                    "level": row["level"],
                    "channel": row["channel"],
                    "event_type": row["event_type"],
                    "title": row["title"],
                    "message": row["message"],
                    "status": row["status"],
                    "payload": json.loads(row["payload_json"]),
                    "delivery_result": json.loads(row["delivery_result_json"]),
                    "delivered_at": row["delivered_at"],
                }
            )
        return notifications

    def notification_summary(self) -> dict[str, Any]:
        with self.connect() as conn:
            rows = conn.execute(
                """
                select channel, status, count(*) as count
                from notifications
                group by channel, status
                """
            ).fetchall()
            latest = conn.execute(
                """
                select created_at, level, channel, event_type, title, status
                from notifications
                order by id desc
                limit 1
                """
            ).fetchone()
        counts: dict[str, dict[str, int]] = {}
        for row in rows:
            channel = row["channel"]
            counts.setdefault(channel, {})[row["status"]] = int(row["count"])
        return {
            "counts": counts,
            "latest": dict(latest) if latest else None,
        }
