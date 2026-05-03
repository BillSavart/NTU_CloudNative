# Access API

這是用 Go/Gin 實作的門禁決策服務，負責接收假的刷卡訊號、透過 Redis 做 Anti-Passback 判斷，並把刷卡事件非同步送進 Kafka。

## 啟動方式

從專案根目錄啟動本地 Access API 叢集：

```bash
docker-compose up -d --scale access-api=3 access-lb
```

這會啟動：

```text
Nginx 負載平衡器 -> 3 個 Access API 容器
Redis 主節點 + 2 個複本 + 3 個 Sentinel
Kafka 3 節點 KRaft 叢集
```

負載平衡器入口：

```text
http://localhost:8080
```

Kafka 已開啟本地 demo 用的自動 topic 建立。若想手動建立 topic：

```bash
docker-compose exec kafka-1 /opt/kafka/bin/kafka-topics.sh \
  --bootstrap-server localhost:9092 \
  --create \
  --if-not-exists \
  --topic access-events \
  --partitions 3 \
  --replication-factor 3
```

## 本機 Go 開發注意事項

如果你在 Mac terminal 直接執行 `go run .`，請直連 Redis 的 localhost port：

```bash
cd access-api
REDIS_ADDR=localhost:6379 \
KAFKA_BROKERS=localhost:19092,localhost:29092,localhost:39092 \
go run .
```

不要在主機端直接使用這組 Sentinel 設定：

```bash
REDIS_SENTINEL_ADDRS=localhost:26379,localhost:26380,localhost:26381
REDIS_MASTER_NAME=mymaster
```

原因是 Sentinel 會回傳 Docker network 內部的主節點位址：

```text
redis:6379
```

這個 hostname 在 Access API 容器裡可以解析，但在 Mac 主機端無法解析，所以會出現：

```text
lookup redis: no such host
```

簡單判斷：

```text
docker-compose 跑 Access API -> 使用 Redis Sentinel
本機 go run Access API       -> 使用 REDIS_ADDR=localhost:6379
```

## 系統流程

目前預設事件路徑：

```text
假刷卡訊號 -> 負載平衡器 -> Access API 叢集 -> Redis Anti-Passback -> 非同步發布佇列 -> Kafka topic access-events
```

門禁決策只依賴 Redis。Kafka 發布事件由背景 worker 非同步處理，所以 Kafka 變慢時不會阻塞 HTTP 回應，除非記憶體佇列已滿。

預設也會把事件 mirror 到 Redis Stream：

```text
access:events
```

這是為了方便本地展示時查詢最近事件。

常用 publisher 設定：

```bash
PUBLISHER_ASYNC=true
PUBLISHER_QUEUE_SIZE=100000
PUBLISHER_WORKERS=8
PUBLISHER_BATCH_SIZE=100
PUBLISHER_FLUSH_MS=10
```

背景 worker 會批次寫入 Kafka。`PUBLISHER_BATCH_SIZE` 控制每次最多寫幾筆，`PUBLISHER_FLUSH_MS` 控制 worker 最多等待多久來湊一個批次。

`eventBuffered` 的意義：

```text
true  -> 事件已放進非同步佇列，之後會由背景 worker 寫入 Kafka
false -> 門禁決策已完成，但事件沒有成功排入 Kafka
```

若尖峰測試出現事件遺失，可以提高 `PUBLISHER_QUEUE_SIZE`、提高 `PUBLISHER_WORKERS`，或降低模擬器的 `--time-scale`。

## API 端點

- `GET /ping`：基本服務檢查，會回傳目前 Access API instance ID。
- `GET /healthz`：檢查 Redis 與 Kafka publisher 是否可用。
- `POST /api/access/swipe`：接收假的刷卡訊號並回傳門禁決策。
- `GET /api/access/state/:employeeId`：查詢員工目前 IN/OUT 狀態。
- `POST /api/access/reset/:employeeId`：清除單一員工狀態，方便展示。
- `GET /api/access/events?limit=20`：查詢 Redis Stream mirror 的最近事件。
- `GET /metrics`：Prometheus 格式指標，包含刷卡數、允許/拒絕數、佇列深度、已發布/失敗/遺失事件數。

## 展示流程

重置狀態：

```bash
curl -X POST http://localhost:8080/api/access/reset/E000001
```

第一次進門，應該放行：

```bash
curl -X POST http://localhost:8080/api/access/swipe \
  -H 'Content-Type: application/json' \
  -d '{"employeeId":"E000001","gateId":"GATE_A","direction":"IN"}'
```

重複進門，應該被 Anti-Passback 擋下：

```bash
curl -X POST http://localhost:8080/api/access/swipe \
  -H 'Content-Type: application/json' \
  -d '{"employeeId":"E000001","gateId":"GATE_A","direction":"IN"}'
```

出門，應該放行：

```bash
curl -X POST http://localhost:8080/api/access/swipe \
  -H 'Content-Type: application/json' \
  -d '{"employeeId":"E000001","gateId":"GATE_A","direction":"OUT"}'
```

查詢 Redis mirror events：

```bash
curl 'http://localhost:8080/api/access/events?limit=3'
```

直接讀 Kafka events：

```bash
docker-compose exec kafka-1 /opt/kafka/bin/kafka-console-consumer.sh \
  --bootstrap-server localhost:9092 \
  --topic access-events \
  --from-beginning \
  --max-messages 3
```

## 尖峰流量模擬

執行 90,000 人公司、50 扇門、30 分鐘上班尖峰的壓縮模擬：

```bash
go run ./cmd/swipe-simulator
```

預設會送出約 90,450 筆假刷卡訊號：每位員工一筆主要刷卡，加上 0.5% 重複進門刷卡，用來測 Anti-Passback。模擬器和腳本每次會自動使用新的員工 ID 前綴，避免 Redis 裡前一次壓測留下的 IN 狀態影響結果。30 分鐘尖峰預設用 `TIME_SCALE=10` 壓縮成約 3 分鐘跑完，較適合本機 Docker Desktop。

常用參數：

```bash
go run ./cmd/swipe-simulator \
  --base-url http://127.0.0.1:8080 \
  --employees 90000 \
  --employee-prefix E \
  --gates 50 \
  --duration 30m \
  --time-scale 10 \
  --workers 200 \
  --entry-ratio 0.995 \
  --duplicate-pct 0.005
```

快速小型測試：

```bash
go run ./cmd/swipe-simulator --employees 1000 --employee-prefix TEST --duration 2m --time-scale 120
```

## 驗證腳本

最簡單的一鍵 demo：

```bash
./scripts/demo-access-api.sh
```

這會從 `docker-compose up` 開始，依序啟動 Access API stack、建立 Kafka topic、跑完整 smoke test、跑壓力測試，最後印出常用檢查指令。

正式 90,000 人尖峰模擬：

```bash
./scripts/demo-access-api.sh --full
```

從專案根目錄執行完整 Access API stack smoke test：

```bash
./scripts/verify-access-stack.sh
```

此腳本會檢查：

- Nginx 負載平衡器是否打到多個 Access API 容器。
- Redis Sentinel 是否能回報目前 master。
- Redis 主節點/複本角色是否正常。
- Kafka topic `access-events` 是否為 3 partitions、replication factor 3。
- Anti-Passback 是否回傳 `GRANTED -> DENIED -> GRANTED`。
- Kafka offsets 是否增加，代表事件已寫入 Kafka。
- Access API 指標是否沒有遺失事件。

執行小型壓測：

```bash
./scripts/run-access-load-test.sh
```

執行 90,000 人尖峰模擬：

```bash
./scripts/run-access-load-test.sh --full
```

可用環境變數覆蓋測試參數：

```bash
EMPLOYEES=5000 GATES=20 TIME_SCALE=10 WORKERS=100 ENTRY_RATIO=0.995 DUPLICATE_PCT=0.005 ./scripts/run-access-load-test.sh
```

壓測過程會定期印出完成數、百分比、QPS、錯誤數、平均延遲毫秒數與最大延遲毫秒數。最後 summary 也會顯示 `Under 50ms target`，方便對照作業要求。可調整進度輸出頻率：

```bash
PROGRESS_EVERY=5s ./scripts/run-access-load-test.sh --full
```

## Docker 容器

在 `access-api` 目錄建置 image：

```bash
docker build -t access-api:latest .
```

若要用單一 Docker 容器連本地 Docker Compose 的 Redis Sentinel 與 Kafka：

```bash
docker run --rm -p 8080:8080 \
  -e REDIS_SENTINEL_ADDRS=host.docker.internal:26379,host.docker.internal:26380,host.docker.internal:26381 \
  -e REDIS_MASTER_NAME=mymaster \
  -e KAFKA_BROKERS=host.docker.internal:19092,host.docker.internal:29092,host.docker.internal:39092 \
  access-api:latest
```

## Kubernetes 部署

Kubernetes 部署檔位於專案根目錄的 `k8s/`：

```text
k8s/access-api-deployment.yaml
k8s/access-api-service.yaml
k8s/access-api-hpa.yaml
```

建置並讓 Kubernetes 叢集能取得 `access-api:latest` image 後，套用：

```bash
kubectl apply -f ../k8s/access-api-deployment.yaml
kubectl apply -f ../k8s/access-api-service.yaml
kubectl apply -f ../k8s/access-api-hpa.yaml
```

Deployment 預期 Kubernetes 叢集內有以下 Redis Sentinel 與 Kafka 服務：

```text
REDIS_SENTINEL_ADDRS=redis-sentinel-1:26379,redis-sentinel-2:26379,redis-sentinel-3:26379
REDIS_MASTER_NAME=mymaster
KAFKA_BROKERS=kafka-1:9092,kafka-2:9092,kafka-3:9092
```

若使用 minikube 或 kind，請先把 `access-api:latest` 載入或重新標記到叢集能拉取的位置。HPA 會根據 CPU 與記憶體使用率，把 Access API 從 3 個 pods 自動擴到最多 10 個 pods。
