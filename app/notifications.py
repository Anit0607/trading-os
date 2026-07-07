from __future__ import annotations

import json
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from .config import AppConfig
from .models import utc_now_iso
from .storage import StateStore


class NotificationManager:
    def __init__(self, config: AppConfig, store: StateStore | None = None) -> None:
        self.config = config
        self.store = store or StateStore(config.database_path)

    def status(self) -> dict[str, Any]:
        telegram_configured = bool(self.config.telegram_bot_token and self.config.telegram_chat_id)
        return {
            "app_enabled": self.config.alerts_app_enabled,
            "telegram_enabled": self.config.alerts_telegram_enabled,
            "telegram_configured": telegram_configured,
            "telegram_bot_token_present": self.config.telegram_bot_token_present,
            "telegram_chat_id_present": self.config.telegram_chat_id_present,
            "summary": self.store.notification_summary(),
        }

    def recent(self, limit: int = 50) -> dict[str, Any]:
        return {
            "ok": True,
            "status": self.status(),
            "notifications": self.store.recent_notifications(limit),
        }

    def notify(
        self,
        *,
        level: str,
        event_type: str,
        title: str,
        message: str,
        payload: dict[str, Any] | None = None,
        channels: list[str] | None = None,
    ) -> dict[str, Any]:
        selected_channels = channels or ["app", "telegram"]
        results: list[dict[str, Any]] = []

        if "app" in selected_channels and self.config.alerts_app_enabled:
            results.append(self._record_app(level, event_type, title, message, payload or {}))

        if "telegram" in selected_channels:
            results.append(self._send_telegram(level, event_type, title, message, payload or {}))

        return {
            "ok": all(result["status"] in {"delivered", "skipped"} for result in results),
            "results": results,
            "status": self.status(),
        }

    def _record_app(
        self,
        level: str,
        event_type: str,
        title: str,
        message: str,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        notification_id = self.store.record_notification(
            level=level,
            channel="app",
            event_type=event_type,
            title=title,
            message=message,
            status="delivered",
            payload=payload,
            delivery_result={"method": "local_db"},
            delivered_at=utc_now_iso(),
        )
        return {"channel": "app", "status": "delivered", "id": notification_id}

    def _send_telegram(
        self,
        level: str,
        event_type: str,
        title: str,
        message: str,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        if not self.config.alerts_telegram_enabled:
            notification_id = self.store.record_notification(
                level=level,
                channel="telegram",
                event_type=event_type,
                title=title,
                message=message,
                status="skipped",
                payload=payload,
                delivery_result={"reason": "ALERTS_TELEGRAM_ENABLED is false"},
            )
            return {"channel": "telegram", "status": "skipped", "id": notification_id}

        if not self.config.telegram_bot_token or not self.config.telegram_chat_id:
            notification_id = self.store.record_notification(
                level=level,
                channel="telegram",
                event_type=event_type,
                title=title,
                message=message,
                status="failed",
                payload=payload,
                delivery_result={"reason": "TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID missing"},
            )
            return {"channel": "telegram", "status": "failed", "id": notification_id}

        text = _format_telegram_message(level, title, message, payload)
        result: dict[str, Any]
        status = "failed"
        delivered_at = None
        try:
            result = self._telegram_post(text)
            status = "delivered" if result.get("ok") else "failed"
            delivered_at = utc_now_iso() if status == "delivered" else None
        except (HTTPError, URLError, TimeoutError, OSError, json.JSONDecodeError) as exc:
            result = {"ok": False, "error": str(exc)}

        notification_id = self.store.record_notification(
            level=level,
            channel="telegram",
            event_type=event_type,
            title=title,
            message=message,
            status=status,
            payload=payload,
            delivery_result=_redact_telegram_result(result),
            delivered_at=delivered_at,
        )
        return {"channel": "telegram", "status": status, "id": notification_id}

    def _telegram_post(self, text: str) -> dict[str, Any]:
        assert self.config.telegram_bot_token
        assert self.config.telegram_chat_id
        url = f"https://api.telegram.org/bot{self.config.telegram_bot_token}/sendMessage"
        data = urlencode(
            {
                "chat_id": self.config.telegram_chat_id,
                "text": text[:3900],
                "disable_web_page_preview": "true",
            }
        ).encode("utf-8")
        request = Request(
            url,
            data=data,
            method="POST",
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
        with urlopen(request, timeout=20) as response:
            return json.loads(response.read().decode("utf-8"))


def _format_telegram_message(level: str, title: str, message: str, payload: dict[str, Any]) -> str:
    icon = {
        "critical": "🔴",
        "warning": "🟠",
        "warn": "🟠",
        "ok": "🟢",
        "safe": "🟢",
        "info": "🔵",
    }.get(level.lower(), "🔵")
    lines = [
        f"{icon} Trading OS: {title}",
        message,
    ]
    compact_payload = _compact_payload(payload)
    if compact_payload:
        lines.append("")
        lines.extend(f"{key}: {value}" for key, value in compact_payload.items())
    return "\n".join(lines)


def _compact_payload(payload: dict[str, Any]) -> dict[str, Any]:
    allowed = [
        "mode",
        "run_id",
        "status",
        "coverage",
        "failure_count",
        "regime",
        "token_ready",
        "dhan_status_ok",
        "order_placement",
        "pending_entry_count",
        "pending_exit_count",
        "skipped",
        "filled_count",
        "next_rebalance",
    ]
    return {key: payload[key] for key in allowed if key in payload and payload[key] is not None}


def _redact_telegram_result(result: dict[str, Any]) -> dict[str, Any]:
    if "result" not in result or not isinstance(result["result"], dict):
        return result
    redacted = dict(result)
    message = dict(result["result"])
    if "chat" in message:
        message["chat"] = {"present": True}
    redacted["result"] = message
    return redacted
