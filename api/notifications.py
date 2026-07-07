from __future__ import annotations

import json
from http.server import BaseHTTPRequestHandler
from urllib.parse import parse_qs, urlparse

from app.cloud.neon import NeonClient
from app.config import get_config


class handler(BaseHTTPRequestHandler):  # noqa: N801 - Vercel Python runtime contract
    def do_GET(self) -> None:  # noqa: N802
        config = get_config()
        client = NeonClient.from_config(config)
        parsed = urlparse(self.path)
        query = parse_qs(parsed.query)
        limit = _int_query(query, "limit", 50)
        payload: dict[str, object]
        status = client.status()
        if parsed.path.endswith("/status"):
            payload = {
                "ok": bool(status.get("ok")),
                "app_enabled": True,
                "telegram_enabled": False,
                "telegram_configured": False,
                "cloud_readonly": True,
                "summary": {"latest": None, "counts": {}},
                "neon": status,
            }
        elif status.get("ok"):
            payload = {
                "ok": True,
                "status": {
                    "app_enabled": True,
                    "telegram_enabled": False,
                    "telegram_configured": False,
                    "cloud_readonly": True,
                    "neon": status,
                },
                "notifications": client.recent_alerts(limit=limit),
            }
        else:
            payload = {
                "ok": False,
                "status": {"cloud_readonly": True, "neon": status},
                "notifications": [],
                "error": status.get("reason") or "Neon is not configured.",
            }
        self.send_response(200 if payload.get("ok") or parsed.path.endswith("/status") else 503)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(json.dumps(payload, ensure_ascii=False, sort_keys=True, default=str).encode("utf-8"))


def _int_query(query: dict[str, list[str]], key: str, default: int) -> int:
    try:
        return max(1, min(200, int(query.get(key, [str(default)])[0])))
    except (TypeError, ValueError):
        return default
