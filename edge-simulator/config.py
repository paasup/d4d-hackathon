WS_EDGE_URL = "ws://localhost:8000/ws/edge"
WS_COMMAND_URL = "ws://localhost:8000/ws/command"

NUM_EDGES = 25

LAT_RANGE = (37.5, 38.5)
LON_RANGE = (127.0, 128.0)

SEND_INTERVAL_RANGE = (5, 10)  # seconds
SILENT_SEND_INTERVAL_RANGE = (60, 90)  # seconds, posture="silent"일 때

AMMO_INIT_RANGE = (60, 100)
AMMO_DRAIN_RANGE = (1, 3)  # 기존 (1,5) 대비 평균 소모량 3->2로, 소모 속도 1.5배 감속
AMMO_ALERT_THRESHOLD = 20
RESET_LOW_AMMO_RANGE = (4, 18)  # central-backend의 RESET_LOW_AMMO_VALUES 범위와 일치
