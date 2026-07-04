from pydantic import BaseModel
from typing import Literal
from datetime import datetime


class EdgeState(BaseModel):
    edge_id: str                # 예: "GOP-21"
    lat: float
    lon: float
    ammo_pct: int                # 0~100
    status: Literal["idle", "resupplying", "resupplied", "alert"]
    posture: Literal["active", "silent"] = "active"
    alert_level: Literal["normal", "heightened"] = "normal"
    timestamp: datetime


class Command(BaseModel):
    edge_id: str
    command: Literal[
        "RESUPPLY",
        "RECON_DRONE",
        "SILENT_MODE",
        "ACTIVE_MODE",
        "ALERT_LEVEL_UP",
        "ALERT_LEVEL_DOWN",
    ]
    issued_at: datetime


class AlertEvent(BaseModel):
    edge_id: str
    level: Literal["warning", "critical"]
    message: str                 # "⚠️ [GOP-21] 탄약 고갈 위기"
    recommended_action: str      # "교본 제3조에 의거..."
    triggered_at: datetime
