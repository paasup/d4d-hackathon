import asyncio
import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import config
from agent import EdgeAgent


def make_agents(n: int) -> list[EdgeAgent]:
    # 위치 생성만 별도 시드로 고정 — 재기동해도 매번 같은 좌표를 배정해 대시보드에서
    # 마커가 재기동 때마다 이동한 것처럼 보이지 않게 한다.
    position_rng = random.Random(42)
    agents = []
    for i in range(1, n + 1):
        edge_id = f"GOP-{i:02d}"
        lat = position_rng.uniform(*config.LAT_RANGE)
        lon = position_rng.uniform(*config.LON_RANGE)
        agents.append(EdgeAgent(edge_id, lat, lon))
    return agents


async def run_agent_safe(agent: EdgeAgent):
    try:
        await agent.run()
    except Exception as e:
        print(f"[{agent.edge_id}] fatal error, agent stopped: {e}")


async def main():
    agents = make_agents(config.NUM_EDGES)
    print(f"starting {len(agents)} edge agents -> {config.WS_EDGE_URL}")
    await asyncio.gather(*(run_agent_safe(agent) for agent in agents))


if __name__ == "__main__":
    asyncio.run(main())
