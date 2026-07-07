from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any


PROJECT_ROOT = Path(__file__).resolve().parents[1]
SCANNER_ROOT = PROJECT_ROOT.parent


def _read_env_file(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.exists():
        return values
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def load_env_defaults() -> None:
    """Load .env files without overwriting already-set environment variables."""
    candidates = [
        PROJECT_ROOT / ".env",
        SCANNER_ROOT / ".env",
    ]
    for path in candidates:
        for key, value in _read_env_file(path).items():
            os.environ.setdefault(key, value)


@dataclass(frozen=True)
class AppConfig:
    project_root: Path
    scanner_root: Path
    database_path: Path
    strategy_config_path: Path
    reference_results_dir: Path
    host: str
    port: int
    mode: str
    auto_execution_enabled: bool
    dhan_client_id: str | None
    dhan_access_token: str | None
    dhan_token_state_path: Path
    dhan_pin: str | None
    dhan_totp_secret: str | None
    dhan_api_key: str | None
    dhan_api_secret: str | None
    dhan_client_id_present: bool
    dhan_access_token_present: bool
    dhan_pin_present: bool
    dhan_totp_secret_present: bool
    dhan_api_key_present: bool
    dhan_api_secret_present: bool
    alerts_app_enabled: bool
    alerts_telegram_enabled: bool
    telegram_bot_token: str | None
    telegram_chat_id: str | None
    telegram_bot_token_present: bool
    telegram_chat_id_present: bool
    database_url: str | None
    database_url_present: bool
    sync_to_neon: bool
    cloud_readonly: bool
    cloud_worker_id: str
    cloud_stale_after_minutes: int


def _bool_env(name: str, default: bool = False) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "y", "on"}


def get_config() -> AppConfig:
    load_env_defaults()
    project_root = Path(os.environ.get("TRADING_OS_ROOT", str(PROJECT_ROOT))).resolve()
    database_path = Path(os.environ.get("TRADING_OS_DB", str(project_root / "data" / "trading_os.db"))).resolve()
    strategy_config_path = project_root / "config" / "strategy.json"
    reference_results_dir = SCANNER_ROOT / "strategy4_pdd_precision_final_results"
    dhan_client_id = os.environ.get("DHAN_CLIENT_ID") or None
    dhan_access_token = os.environ.get("DHAN_ACCESS_TOKEN") or None
    dhan_pin = os.environ.get("DHAN_PIN") or None
    dhan_totp_secret = os.environ.get("DHAN_TOTP_SECRET") or None
    dhan_api_key = os.environ.get("DHAN_API_KEY") or None
    dhan_api_secret = os.environ.get("DHAN_API_SECRET") or None
    telegram_bot_token = os.environ.get("TELEGRAM_BOT_TOKEN") or None
    telegram_chat_id = os.environ.get("TELEGRAM_CHAT_ID") or None
    database_url = os.environ.get("DATABASE_URL") or os.environ.get("POSTGRES_URL") or None
    dhan_token_state_path = Path(
        os.environ.get("DHAN_TOKEN_STATE", str(project_root / "data" / "dhan" / "token_state.json"))
    ).resolve()
    return AppConfig(
        project_root=project_root,
        scanner_root=SCANNER_ROOT,
        database_path=database_path,
        strategy_config_path=strategy_config_path,
        reference_results_dir=reference_results_dir,
        host=os.environ.get("TRADING_OS_HOST", "127.0.0.1"),
        port=int(os.environ.get("TRADING_OS_PORT", "8765")),
        mode=os.environ.get("TRADING_OS_MODE", "paper").strip().lower(),
        auto_execution_enabled=_bool_env("AUTO_EXECUTION_ENABLED", False),
        dhan_client_id=dhan_client_id,
        dhan_access_token=dhan_access_token,
        dhan_token_state_path=dhan_token_state_path,
        dhan_pin=dhan_pin,
        dhan_totp_secret=dhan_totp_secret,
        dhan_api_key=dhan_api_key,
        dhan_api_secret=dhan_api_secret,
        dhan_client_id_present=bool(dhan_client_id),
        dhan_access_token_present=bool(dhan_access_token),
        dhan_pin_present=bool(dhan_pin),
        dhan_totp_secret_present=bool(dhan_totp_secret),
        dhan_api_key_present=bool(dhan_api_key),
        dhan_api_secret_present=bool(dhan_api_secret),
        alerts_app_enabled=_bool_env("ALERTS_APP_ENABLED", True),
        alerts_telegram_enabled=_bool_env("ALERTS_TELEGRAM_ENABLED", False),
        telegram_bot_token=telegram_bot_token,
        telegram_chat_id=telegram_chat_id,
        telegram_bot_token_present=bool(telegram_bot_token),
        telegram_chat_id_present=bool(telegram_chat_id),
        database_url=database_url,
        database_url_present=bool(database_url),
        sync_to_neon=_bool_env("TRADING_OS_SYNC_TO_NEON", False),
        cloud_readonly=_bool_env("TRADING_OS_CLOUD_READONLY", False),
        cloud_worker_id=os.environ.get("TRADING_OS_WORKER_ID", "local-d-drive-worker").strip()
        or "local-d-drive-worker",
        cloud_stale_after_minutes=int(os.environ.get("TRADING_OS_CLOUD_STALE_AFTER_MINUTES", "180")),
    )


def load_strategy_config(config: AppConfig | None = None) -> dict[str, Any]:
    cfg = config or get_config()
    with cfg.strategy_config_path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def safe_public_config(config: AppConfig | None = None) -> dict[str, Any]:
    cfg = config or get_config()
    return {
        "project_root": str(cfg.project_root),
        "database_path": str(cfg.database_path),
        "reference_results_dir": str(cfg.reference_results_dir),
        "host": cfg.host,
        "port": cfg.port,
        "mode": cfg.mode,
        "auto_execution_enabled": cfg.auto_execution_enabled,
        "dhan_client_id_present": cfg.dhan_client_id_present,
        "dhan_access_token_present": cfg.dhan_access_token_present,
        "dhan_managed_token_present": cfg.dhan_token_state_path.exists(),
        "dhan_pin_present": cfg.dhan_pin_present,
        "dhan_totp_secret_present": cfg.dhan_totp_secret_present,
        "dhan_api_key_present": cfg.dhan_api_key_present,
        "dhan_api_secret_present": cfg.dhan_api_secret_present,
        "alerts_app_enabled": cfg.alerts_app_enabled,
        "alerts_telegram_enabled": cfg.alerts_telegram_enabled,
        "telegram_bot_token_present": cfg.telegram_bot_token_present,
        "telegram_chat_id_present": cfg.telegram_chat_id_present,
        "database_url_present": cfg.database_url_present,
        "sync_to_neon": cfg.sync_to_neon,
        "cloud_readonly": cfg.cloud_readonly,
        "cloud_worker_id": cfg.cloud_worker_id,
        "cloud_stale_after_minutes": cfg.cloud_stale_after_minutes,
    }
