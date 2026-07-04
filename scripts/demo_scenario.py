import time
from datetime import datetime, timezone

import requests

BASE = "http://localhost:8000"
EDGE_ID = "GOP-21"


def force_critical(edge_id: str, ammo_pct: int = 15):
    """특정 에지를 강제로 위기 상태로 만듦 (데모용 직접 주입)"""
    resp = requests.post(f"{BASE}/api/debug/set_ammo", json={"edge_id": edge_id, "ammo_pct": ammo_pct})
    resp.raise_for_status()


def send_command(command: str):
    requests.post(f"{BASE}/api/command", json={
        "edge_id": EDGE_ID,
        "command": command,
        "issued_at": datetime.now(timezone.utc).isoformat(),
    })


def run_scenario():
    print(f"1) {EDGE_ID} 탄약을 15%로 강제 설정 (탄약 경고)...")
    force_critical(EDGE_ID, 15)

    print("2) 알림 발생 확인...")
    alerts = requests.get(f"{BASE}/api/alerts").json()
    print(f"   → {len(alerts)}건 알림:", alerts[-1] if alerts else "없음")

    print("3) 챗봇 질의 시뮬레이션...")
    resp = requests.post(f"{BASE}/api/chat", json={"query": "가장 위험한 에지는?"})
    print("   → 응답:", resp.json()["answer"])

    print("4) RECON_DRONE 하달...")
    send_command("RECON_DRONE")
    print("   → 하달 완료. 약 6초 후 정찰 결과 알림이 브로드캐스트됩니다.")
    time.sleep(7)
    alerts = requests.get(f"{BASE}/api/alerts").json()
    print("   → 정찰 결과 알림 확인:", alerts[-1] if alerts else "없음")

    print("5) RESUPPLY 하달 (대시보드에서 보급 COP 이동 애니메이션 확인)...")
    send_command("RESUPPLY")
    print("   → 하달 완료. 10초 후 보급완료 상태로 전환됩니다 (에지 시뮬레이터 로직).")

    print("6) SILENT_MODE 하달 (무선 침묵 전환)...")
    send_command("SILENT_MODE")

    print("7) ACTIVE_MODE 하달 (무선 침묵 해제)...")
    send_command("ACTIVE_MODE")

    print("8) ALERT_LEVEL_UP 하달 (경계태세 격상)...")
    send_command("ALERT_LEVEL_UP")

    print("9) ALERT_LEVEL_DOWN 하달 (경계태세 격하)...")
    send_command("ALERT_LEVEL_DOWN")


if __name__ == "__main__":
    run_scenario()
