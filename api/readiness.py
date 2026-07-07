from __future__ import annotations

import json
from http.server import BaseHTTPRequestHandler

from app.cloud.dashboard import cloud_readiness
from app.config import get_config


class handler(BaseHTTPRequestHandler):  # noqa: N801 - Vercel Python runtime contract
    def do_GET(self) -> None:  # noqa: N802
        payload = cloud_readiness(get_config())
        self.send_response(200 if payload.get("ok") else 503)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(json.dumps(payload, ensure_ascii=False, sort_keys=True, default=str).encode("utf-8"))
