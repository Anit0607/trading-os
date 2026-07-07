from __future__ import annotations

from dataclasses import asdict, dataclass, field
from datetime import datetime
from typing import Any


def utc_now_iso() -> str:
    return datetime.utcnow().replace(microsecond=0).isoformat() + "Z"


@dataclass
class TargetSleeve:
    slot: int
    symbol: str
    role: str
    reason: str


@dataclass
class OrderIntent:
    action: str
    symbol: str
    quantity: int | None
    sleeve: int | None
    reason: str
    status: str = "planned"


@dataclass
class DashboardSnapshot:
    generated_at: str
    mode: str
    strategy_name: str
    portfolio: dict[str, Any]
    regime: dict[str, Any]
    pdd: dict[str, Any]
    ranks: list[dict[str, Any]]
    target_sleeves: list[TargetSleeve] = field(default_factory=list)
    order_plan: list[OrderIntent] = field(default_factory=list)
    alerts: list[dict[str, Any]] = field(default_factory=list)
    metrics: dict[str, Any] = field(default_factory=dict)
    trade_summary: dict[str, Any] = field(default_factory=dict)
    paper: dict[str, Any] = field(default_factory=dict)
    ui: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        data = asdict(self)
        data["target_sleeves"] = [asdict(row) for row in self.target_sleeves]
        data["order_plan"] = [asdict(row) for row in self.order_plan]
        return data
