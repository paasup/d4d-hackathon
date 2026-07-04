# build context must be the repo root (needs shared/, dashboard-web/, docs/)
FROM python:3.13-slim

WORKDIR /app

COPY central-backend/requirements.txt central-backend/requirements.txt
RUN pip install --no-cache-dir -r central-backend/requirements.txt

COPY shared/ shared/
COPY central-backend/ central-backend/
COPY dashboard-web/ dashboard-web/
COPY docs/국방_군수지원_교본.txt docs/국방_군수지원_교본.txt

WORKDIR /app/central-backend
EXPOSE 8000

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
