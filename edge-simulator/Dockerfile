# build context must be the repo root (needs shared/)
FROM python:3.13-slim

WORKDIR /app

COPY edge-simulator/requirements.txt edge-simulator/requirements.txt
RUN pip install --no-cache-dir -r edge-simulator/requirements.txt

COPY shared/ shared/
COPY edge-simulator/ edge-simulator/

WORKDIR /app/edge-simulator

CMD ["python", "main.py"]
