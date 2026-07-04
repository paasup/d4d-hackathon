# d4d-hackathon Helm 차트

`central-backend`(FastAPI + 대시보드 정적 서빙)와 `edge-simulator`(가상 에지 25개) 두 개의
Deployment로 구성됩니다. 둘 다 상태가 프로세스 메모리에만 있어 **replicas는 1로 고정**되어
있습니다 (values.yaml에서 늘리지 마세요 — 여러 개로 늘리면 대시보드가 서로 다른 백엔드 상태를
라운드로빈으로 보게 되거나, 같은 edge_id가 중복 접속합니다).

## 1. 이미지 빌드 & 푸시

Dockerfile은 레포 루트를 빌드 컨텍스트로 사용합니다 (`shared/`를 참조하기 때문).

```bash
docker build -f central-backend/Dockerfile -t <registry>/d4d-central-backend:latest .
docker build -f edge-simulator/Dockerfile -t <registry>/d4d-edge-simulator:latest .
docker push <registry>/d4d-central-backend:latest
docker push <registry>/d4d-edge-simulator:latest
```

로컬 클러스터(kind/minikube)라면 push 대신 이미지를 클러스터로 로드:

```bash
kind load docker-image d4d/central-backend:latest d4d/edge-simulator:latest
```

리포지토리/태그를 바꿨다면 `--set image.centralBackend.repository=...,image.centralBackend.tag=...`
(edge-simulator도 동일) 로 오버라이드하거나 values 파일에 반영하세요.

## 2. (선택) 챗봇 API 키

`values.yaml`의 `centralBackend.apiKey`는 비어 있으면 규칙 기반 응답으로 자동 폴백합니다.
LLM 챗봇을 쓰려면 커밋되지 않는 별도 values 파일을 사용하세요:

```bash
cp values-secret.example.yaml values-secret.yaml   # 값 채우기, 이 파일은 .gitignore 처리됨
```

## 3. 설치

```bash
helm upgrade --install d4d-hackathon . \
  --namespace d4d-hackathon --create-namespace \
  -f values-secret.yaml   # API_KEY 안 쓰면 이 줄 생략
```

릴리스 이름을 `d4d-hackathon`으로 하면 리소스 이름이 `d4d-hackathon-central-backend`처럼
짧고 깔끔하게 나옵니다 (fullname 템플릿이 릴리스 이름에 차트 이름이 포함돼 있으면 중복 접두어를 생략).

드라이런으로 렌더링만 확인하려면:

```bash
helm template d4d-hackathon . --namespace d4d-hackathon
helm lint .
```

## 4. 확인

```bash
kubectl -n d4d-hackathon get pods -w
kubectl -n d4d-hackathon logs -f deploy/d4d-hackathon-edge-simulator
```

대시보드 접속:

```bash
kubectl -n d4d-hackathon port-forward svc/d4d-hackathon-central-backend 8000:8000
# 브라우저에서 http://localhost:8000
```

`centralBackend.service.type=NodePort`(기본값, nodePort 30080)이므로 노드 IP로 직접 접속 가능한
환경이면 `http://<node-ip>:30080`도 됩니다.

## 5. (선택) Ingress

기본은 비활성화입니다. Ingress 컨트롤러(nginx 등)가 있는 클러스터라면:

```bash
helm upgrade --install d4d-hackathon . \
  --namespace d4d-hackathon --create-namespace \
  --set ingress.enabled=true \
  --set ingress.className=nginx \
  --set ingress.host=d4d.paasup.io
```

TLS를 쓰려면 `ingress.tls`에 `secretName`/`hosts`를 채우세요 (values.yaml 주석 예시 참고).
Ingress를 켜면 보통 `centralBackend.service.type=ClusterIP`로 바꾸는 게 맞지만, NodePort로
같이 둬도 동작은 합니다 (그냥 접속 경로가 두 개 생기는 것).

WebSocket(`/ws/edge`, `/ws/command`, `/ws/dashboard`)도 같은 경로(`/`)로 프록시되므로 별도
경로 분리는 필요 없습니다. 다만 일부 Ingress 컨트롤러는 오래 유지되는 커넥션에 대해
읽기 타임아웃을 짧게 잡아두는 경우가 있으니, 대시보드 연결이 자꾸 끊긴다면
`ingress.annotations`에 컨트롤러별 타임아웃 연장 어노테이션
(예: nginx의 `nginx.ingress.kubernetes.io/proxy-read-timeout`)을 추가하세요.

## 삭제

```bash
helm uninstall d4d-hackathon --namespace d4d-hackathon
```

## 참고

- `edge-simulator`는 ConfigMap의 `CENTRAL_WS_BASE_URL`(자동으로 central-backend Service DNS
  이름을 가리키도록 템플릿에서 생성)로 중앙 서버를 찾습니다. 직접 손댈 필요 없습니다.
- 데모 재시작 버튼(`/api/simulator/restart`)은 파드를 재시작하지 않고 인메모리 상태만 초기화합니다.
- 진짜 다중 레플리카가 필요해지면 `central-backend/store.py`를 Redis 등 외부 저장소로 먼저
  바꿔야 합니다 — 그 전까지는 `replicas` 값을 절대 올리지 마세요.
