import asyncio
import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import config
from agent import EdgeAgent


def make_agents(n: int) -> list[EdgeAgent]:
    agents = []
    for i in range(1, n + 1):
        edge_id = f"GOP-{i:02d}"
        lat = random.uniform(*config.LAT_RANGE)
        lon = random.uniform(*config.LON_RANGE)
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
