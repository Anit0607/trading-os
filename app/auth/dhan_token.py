from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import time
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from ..config import AppConfig


DHAN_API_BASE_URL = "https://api.dhan.co/v2"
DHAN_AUTH_BASE_URL = "https://auth.dhan.co/app"
TOKEN_EXPIRY_BUFFER_SECONDS = 15 * 60


class DhanTokenError(RuntimeError):
    def __init__(self, message: str, *, status_code: int | None = None, payload: Any = None) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.payload = payload

    def public_payload(self) -> dict[str, Any]:
        return {
            "ok": False,
            "error": str(self),
            "status_code": self.status_code,
            "payload": _redact_payload(self.payload),
        }


class DhanTokenManager:
    """Manage app-side Dhan tokens without exposing secrets.

    The Trading OS can run in three auth modes:
    1. use an active managed token from data/dhan/token_state.json,
    2. renew an active token,
    3. optionally generate a fresh token from DHAN_PIN + DHAN_TOTP_SECRET.

    The third mode is opt-in because those are sensitive secrets. They are only
    read from local environment files; they are never logged or returned.
    """

    def __init__(self, config: AppConfig) -> None:
        self.config = config
        self.state_path = config.dhan_token_state_path

    def resolve_access_token(self) -> tuple[str | None, str]:
        state = self._read_state()
        managed_token = state.get("access_token")
        if managed_token and not self._state_is_expiring(state):
            return str(managed_token), "managed_token"
        if self.config.dhan_access_token:
            return self.config.dhan_access_token, "env_token"
        if managed_token:
            return str(managed_token), "managed_token_expiring"
        return None, "none"

    def status(self, *, validate: bool = False) -> dict[str, Any]:
        state = self._read_state()
        token, source = self.resolve_access_token()
        payload = {
            "ok": bool(token and self.config.dhan_client_id),
            "source": source,
            "client_id_present": self.config.dhan_client_id_present,
            "env_token_present": self.config.dhan_access_token_present,
            "managed_token_present": bool(state.get("access_token")),
            "managed_token_expiry": state.get("expires_at"),
            "managed_token_expiring_soon": self._state_is_expiring(state),
            "renew_possible": bool(token and self.config.dhan_client_id),
            "totp_generation_possible": bool(
                self.config.dhan_client_id and self.config.dhan_pin and self.config.dhan_totp_secret
            ),
            "consent_flow_possible": bool(
                self.config.dhan_client_id and self.config.dhan_api_key and self.config.dhan_api_secret
            ),
            "token_state_path": str(self.state_path),
        }
        if validate and token and self.config.dhan_client_id:
            try:
                profile = self.profile(access_token=token)
                payload["profile_ok"] = True
                payload["profile_keys"] = sorted(profile.keys()) if isinstance(profile, dict) else []
            except DhanTokenError as exc:
                payload["ok"] = False
                payload["profile_ok"] = False
                payload["validation_error"] = exc.public_payload()
        return payload

    def profile(self, *, access_token: str | None = None) -> dict[str, Any]:
        token = access_token or self.resolve_access_token()[0]
        if not token or not self.config.dhan_client_id:
            raise DhanTokenError("Dhan client ID/token are not configured.")
        data = self._request(
            "GET",
            f"{DHAN_API_BASE_URL}/profile",
            access_token=token,
            client_id=self.config.dhan_client_id,
        )
        return data if isinstance(data, dict) else {}

    def refresh(self) -> dict[str, Any]:
        """Renew active token, then fall back to optional TOTP generation."""
        token, source = self.resolve_access_token()
        errors: list[dict[str, Any]] = []
        if token and self.config.dhan_client_id:
            try:
                data = self.renew(access_token=token)
                return {
                    "ok": True,
                    "method": "renew",
                    "previous_source": source,
                    "token": self._store_token_payload(data, source="renew"),
                }
            except DhanTokenError as exc:
                errors.append({"method": "renew", **exc.public_payload()})

        if self.config.dhan_client_id and self.config.dhan_pin and self.config.dhan_totp_secret:
            try:
                data = self.generate_with_totp()
                return {
                    "ok": True,
                    "method": "totp_generate",
                    "token": self._store_token_payload(data, source="totp_generate"),
                    "previous_errors": errors,
                }
            except DhanTokenError as exc:
                errors.append({"method": "totp_generate", **exc.public_payload()})

        return {
            "ok": False,
            "message": "Unable to refresh Dhan token. Renew needs an active token; fresh generation needs local DHAN_PIN and DHAN_TOTP_SECRET.",
            "errors": errors,
            "status": self.status(validate=False),
        }

    def renew(self, *, access_token: str) -> dict[str, Any]:
        if not self.config.dhan_client_id:
            raise DhanTokenError("DHAN_CLIENT_ID is not configured.")
        data = self._request(
            "GET",
            f"{DHAN_API_BASE_URL}/RenewToken",
            access_token=access_token,
            client_id=self.config.dhan_client_id,
        )
        return data if isinstance(data, dict) else {}

    def generate_with_totp(self) -> dict[str, Any]:
        if not self.config.dhan_client_id or not self.config.dhan_pin or not self.config.dhan_totp_secret:
            raise DhanTokenError("DHAN_CLIENT_ID, DHAN_PIN, and DHAN_TOTP_SECRET are required for fresh token generation.")
        totp = generate_totp(self.config.dhan_totp_secret)
        query = urlencode({"dhanClientId": self.config.dhan_client_id, "pin": self.config.dhan_pin, "totp": totp})
        data = self._request("POST", f"{DHAN_AUTH_BASE_URL}/generateAccessToken?{query}")
        return data if isinstance(data, dict) else {}

    def start_consent_flow(self) -> dict[str, Any]:
        if not self.config.dhan_client_id or not self.config.dhan_api_key or not self.config.dhan_api_secret:
            raise DhanTokenError("DHAN_CLIENT_ID, DHAN_API_KEY, and DHAN_API_SECRET are required for consent flow.")
        query = urlencode({"client_id": self.config.dhan_client_id})
        data = self._request(
            "POST",
            f"{DHAN_AUTH_BASE_URL}/generate-consent?{query}",
            headers={"app_id": self.config.dhan_api_key, "app_secret": self.config.dhan_api_secret},
        )
        return data if isinstance(data, dict) else {}

    def consume_consent(self, token_id: str) -> dict[str, Any]:
        if not self.config.dhan_api_key or not self.config.dhan_api_secret:
            raise DhanTokenError("DHAN_API_KEY and DHAN_API_SECRET are required for consent consume.")
        query = urlencode({"tokenId": token_id})
        data = self._request(
            "GET",
            f"{DHAN_AUTH_BASE_URL}/consumeApp-consent?{query}",
            headers={"app_id": self.config.dhan_api_key, "app_secret": self.config.dhan_api_secret},
        )
        stored = self._store_token_payload(data if isinstance(data, dict) else {}, source="consent_flow")
        return {"stored": stored, "response_keys": sorted(data.keys()) if isinstance(data, dict) else []}

    def _store_token_payload(self, data: dict[str, Any], *, source: str) -> dict[str, Any]:
        token = _extract_token(data)
        if not token:
            raise DhanTokenError("Dhan auth response did not contain an access token.", payload=data)
        expires_at = _extract_expiry(data)
        state = {
            "access_token": token,
            "source": source,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "expires_at": expires_at,
            "response_keys": sorted(data.keys()),
        }
        self._write_state(state)
        return {
            "stored": True,
            "source": source,
            "expires_at": expires_at,
            "response_keys": sorted(data.keys()),
        }

    def _read_state(self) -> dict[str, Any]:
        if not self.state_path.exists():
            return {}
        try:
            return json.loads(self.state_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return {}

    def _write_state(self, state: dict[str, Any]) -> None:
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        tmp_path = self.state_path.with_suffix(".tmp")
        tmp_path.write_text(json.dumps(state, indent=2, sort_keys=True), encoding="utf-8")
        try:
            os.chmod(tmp_path, 0o600)
        except OSError:
            pass
        tmp_path.replace(self.state_path)

    def _state_is_expiring(self, state: dict[str, Any]) -> bool:
        expires_at = state.get("expires_at")
        if not expires_at:
            return True
        try:
            expiry = datetime.fromisoformat(str(expires_at).replace("Z", "+00:00"))
        except ValueError:
            return True
        if expiry.tzinfo is None:
            expiry = expiry.replace(tzinfo=timezone.utc)
        return datetime.now(timezone.utc) + timedelta(seconds=TOKEN_EXPIRY_BUFFER_SECONDS) >= expiry

    def _request(
        self,
        method: str,
        url: str,
        *,
        access_token: str | None = None,
        client_id: str | None = None,
        headers: dict[str, str] | None = None,
    ) -> Any:
        request_headers = {
            "Accept": "application/json",
            "Content-Type": "application/json",
            "User-Agent": "TradingOS/0.1",
        }
        if access_token:
            request_headers["access-token"] = access_token
        if client_id:
            request_headers["dhanClientId"] = client_id
        if headers:
            request_headers.update(headers)
        request = Request(url, method=method, headers=request_headers)
        try:
            with urlopen(request, timeout=30) as response:
                text = response.read().decode("utf-8", errors="replace")
                return json.loads(text) if text else {}
        except HTTPError as exc:
            payload = _decode_error_body(exc)
            raise DhanTokenError(f"Dhan auth API returned HTTP {exc.code}", status_code=exc.code, payload=payload) from exc
        except URLError as exc:
            raise DhanTokenError(f"Dhan auth API connection failed: {exc.reason}") from exc
        except TimeoutError as exc:
            raise DhanTokenError("Dhan auth API request timed out") from exc
        except json.JSONDecodeError as exc:
            raise DhanTokenError("Dhan auth API returned non-JSON data") from exc


def generate_totp(secret: str, *, for_time: int | None = None, interval: int = 30, digits: int = 6) -> str:
    normalized = "".join(secret.strip().split()).upper()
    padding = "=" * ((8 - len(normalized) % 8) % 8)
    key = base64.b32decode(normalized + padding, casefold=True)
    counter = int((time.time() if for_time is None else for_time) // interval)
    msg = counter.to_bytes(8, "big")
    digest = hmac.new(key, msg, hashlib.sha1).digest()
    offset = digest[-1] & 0x0F
    code = int.from_bytes(digest[offset : offset + 4], "big") & 0x7FFFFFFF
    return str(code % (10**digits)).zfill(digits)


def _extract_token(data: dict[str, Any]) -> str | None:
    for key in ["accessToken", "access_token", "token", "accessTokenId"]:
        value = data.get(key)
        if value:
            return str(value)
    nested = data.get("data")
    if isinstance(nested, dict):
        return _extract_token(nested)
    return None


def _extract_expiry(data: dict[str, Any]) -> str:
    for key in ["expiryTime", "expires_at", "expiry", "validTill", "valid_till"]:
        value = data.get(key)
        if value:
            return _normalize_expiry(value)
    nested = data.get("data")
    if isinstance(nested, dict):
        for key in ["expiryTime", "expires_at", "expiry", "validTill", "valid_till"]:
            value = nested.get(key)
            if value:
                return _normalize_expiry(value)
    return (datetime.now(timezone.utc) + timedelta(hours=23, minutes=30)).isoformat()


def _normalize_expiry(value: Any) -> str:
    if isinstance(value, (int, float)):
        number = float(value)
        if number > 10_000_000_000:
            number = number / 1000
        return datetime.fromtimestamp(number, tz=timezone.utc).isoformat()
    text = str(value)
    try:
        expiry = datetime.fromisoformat(text.replace("Z", "+00:00"))
        if expiry.tzinfo is None:
            expiry = expiry.replace(tzinfo=timezone.utc)
        return expiry.isoformat()
    except ValueError:
        return text


def _decode_error_body(exc: HTTPError) -> Any:
    try:
        text = exc.read().decode("utf-8", errors="replace")
    except Exception:
        return None
    if not text:
        return None
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return text[:500]


def _redact_payload(payload: Any) -> Any:
    if isinstance(payload, dict):
        redacted: dict[str, Any] = {}
        for key, value in payload.items():
            if any(secret_word in key.lower() for secret_word in ["token", "secret", "pin", "password", "totp"]):
                redacted[key] = "***REDACTED***"
            else:
                redacted[key] = _redact_payload(value)
        return redacted
    if isinstance(payload, list):
        return [_redact_payload(item) for item in payload]
    return payload
