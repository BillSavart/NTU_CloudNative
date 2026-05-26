# Observability

這個資料夾放的是本專案額外的 Observability 設定。它主要是給 IT / 維運人員確認系統健康狀態，不是給一般使用者看的業務報表 Dashboard。

目前範圍以 **Metrics** 為主，使用 Prometheus 收集指標、Grafana 顯示圖表。Logs 目前可透過 Docker logs 查看，Traces 尚未實作。

## 這一層做什麼

- 監控 Access API 的刷卡流量、授權/拒絕次數、事件佇列狀態。
- 監控 Reporting API 的 HTTP request 數量、延遲、Kafka consumer 與 Redis recovery consumer 狀態。
- 透過 exporters 監控 Redis、PostgreSQL、Kafka。
- 透過 Grafana dashboard 讓系統健康狀態更容易觀察。
- 以 Docker Compose override 的方式啟用，不影響原本只跑 base stack 的流程。

## 相關檔案

```text
observability/
|-- README.md
|-- docker-compose.observability.yml
|-- prometheus/
|   `-- prometheus.yml
`-- grafana/
    `-- provisioning/
        |-- datasources/
        |   `-- prometheus.yml
        `-- dashboards/
            |-- dashboards.yml
            `-- json/
                `-- observability-dashboard.json

reporting-api/
|-- app/
|   `-- observability.py
`-- requirements-observability.txt
```

## 完整確認流程

以下指令請在專案根目錄執行：

```powershell
cd <project-root>
```

### 1. 啟動 Stack

```powershell
docker compose -f docker-compose.yml -f observability/docker-compose.observability.yml up -d --build
```

這會啟動 Access API、Reporting API、PostgreSQL、Redis、Kafka、Prometheus、Grafana，以及 Redis/PostgreSQL/Kafka exporters。

### 2. 選擇性確認 Containers

這步不是必要，但 demo 前或修改 compose 後建議看一下：

```powershell
docker compose -f docker-compose.yml -f observability/docker-compose.observability.yml ps
```

重點看：

- 主要服務是否為 `Up`
- `access-api` 是否為 `healthy`
- exporters 是否持續重啟或 `Exited`

### 3. 開 Prometheus Targets

瀏覽器開：

```text
http://localhost:9090/targets
```

預期結果：所有 targets 最後都應該是 `up`。

`up` 的意思是 Prometheus 成功連到該 endpoint，並成功抓到 metrics。這代表監控路徑正常，但不等於業務流程一定完全正確。

### 4. 開 Grafana Dashboard

瀏覽器開：

```text
http://localhost:3000
```

Grafana 帳號密碼來自 `.env`：

```text
GRAFANA_ADMIN_USER=admin
GRAFANA_ADMIN_PASSWORD=...
```

登入後進入：

```text
Dashboards -> NTU Cloud Native -> Access Control Observability
```

如果圖表一開始是空的，通常是因為還沒有 request 或刷卡事件。可以依照下一步產生測試流量。

### 5. 產生測試流量

先打基本 health / metrics endpoints：

```powershell
curl.exe http://localhost:8080/ping
curl.exe http://localhost:8000/api/health/
curl.exe http://localhost:8000/metrics
```

這些 request 會讓 Reporting API request count、latency 等 metrics 有資料。

若要產生較接近實際系統的刷卡事件，請使用下方「產生刷卡事件 PowerShell 範例」。

### 6. 收尾停止 Stack

停止 containers：

```powershell
docker compose -f docker-compose.yml -f observability/docker-compose.observability.yml down
```

如果要連本機資料 volume 一起刪掉：

```powershell
docker compose -f docker-compose.yml -f observability/docker-compose.observability.yml down -v
```

`down -v` 會刪掉本機 PostgreSQL、Redis、Kafka、Prometheus、Grafana volumes。只有在測試資料可以刪除時才使用。

## 產生刷卡事件 PowerShell 範例

以下流程會模擬一名員工刷卡：

1. 重設員工狀態。
2. 第一次 `IN`，預期應為 `GRANTED`。
3. 第二次連續 `IN`，預期因 anti-passback 被 `DENIED`。
4. `OUT`，預期應為 `GRANTED`。

```powershell
# reset state
Invoke-RestMethod `
  -Uri "http://localhost:8080/api/access/reset/OBS001" `
  -Method POST

# first IN
$body = @{
    employeeId = "OBS001"
    gateId = "GATE_A"
    direction = "IN"
} | ConvertTo-Json -Compress

Invoke-RestMethod `
  -Uri "http://localhost:8080/api/access/swipe" `
  -Method POST `
  -ContentType "application/json" `
  -Body $body

# second IN: should be denied by anti-passback
Invoke-RestMethod `
  -Uri "http://localhost:8080/api/access/swipe" `
  -Method POST `
  -ContentType "application/json" `
  -Body $body

# OUT
$body = @{
    employeeId = "OBS001"
    gateId = "GATE_A"
    direction = "OUT"
} | ConvertTo-Json -Compress

Invoke-RestMethod `
  -Uri "http://localhost:8080/api/access/swipe" `
  -Method POST `
  -ContentType "application/json" `
  -Body $body
```

刷卡後可以查 Access API metrics：

```powershell
curl.exe http://localhost:8080/metrics
```

重點指標包含：

```text
access_api_swipes_total
access_api_swipes_granted_total
access_api_swipes_denied_total
access_api_event_queue_depth
```

也可以查 Reporting API 是否收到事件：

```powershell
curl.exe "http://localhost:8000/api/reports/access/events?limit=5"
```

## 其他 Traffic 範例

### 1. Basic Health Requests

這類 request 只用來確認服務是否活著，不代表真的產生門禁事件。

```powershell
curl.exe http://localhost:8080/ping
curl.exe http://localhost:8000/api/health/
curl.exe http://localhost:8000/metrics
```

用途：

- 確認 Access API 可回應。
- 確認 Reporting API、DB、Kafka consumer、Redis recovery 狀態。
- 確認 Reporting API `/metrics` 有輸出 Prometheus metrics。

Dashboard 影響：

- Reporting API request count 會增加。
- Reporting API latency 會有資料。
- 不會產生真實刷卡事件，因此 Access swipes 不一定會增加。

### 2. 單人正常進出

```powershell
Invoke-RestMethod -Uri "http://localhost:8080/api/access/reset/E001" -Method POST

$body = @{ employeeId="E001"; gateId="GATE_A"; direction="IN" } | ConvertTo-Json -Compress
Invoke-RestMethod -Uri "http://localhost:8080/api/access/swipe" -Method POST -ContentType "application/json" -Body $body

$body = @{ employeeId="E001"; gateId="GATE_A"; direction="OUT" } | ConvertTo-Json -Compress
Invoke-RestMethod -Uri "http://localhost:8080/api/access/swipe" -Method POST -ContentType "application/json" -Body $body
```

用途：

- 驗證正常 `IN -> OUT` 流程。
- 應該看到兩次刷卡都被允許。

Dashboard 影響：

- Access swipes/sec 短暫上升。
- Access granted counter 增加。
- Denied ratio 不應明顯上升。

### 3. Anti-passback 異常測試

```powershell
Invoke-RestMethod -Uri "http://localhost:8080/api/access/reset/E002" -Method POST

$body = @{ employeeId="E002"; gateId="GATE_A"; direction="IN" } | ConvertTo-Json -Compress
Invoke-RestMethod -Uri "http://localhost:8080/api/access/swipe" -Method POST -ContentType "application/json" -Body $body
Invoke-RestMethod -Uri "http://localhost:8080/api/access/swipe" -Method POST -ContentType "application/json" -Body $body
```

用途：

- 驗證 anti-passback 規則。
- 第二次連續 `IN` 應該被拒絕。

Dashboard 影響：

- Access denied counter 增加。
- Access Decision Ratio 會上升。

### 4. 多人小流量測試

```powershell
foreach ($i in 1..1000) {
  $body = @{
    employeeId = "LOAD$i"
    gateId = "GATE_$((($i - 1) % 10) + 1)"
    direction = "IN"
  } | ConvertTo-Json -Compress

  Invoke-RestMethod `
    -Uri "http://localhost:8080/api/access/swipe" `
    -Method POST `
    -ContentType "application/json" `
    -Body $body | Out-Null
}
```

用途：

- 不安裝 Go 的情況下，快速產生一批刷卡 request。
- 適合觀察 Grafana Traffic 是否會上升。

Dashboard 影響：

- Access swipes/sec 上升。
- Event Pipeline 可能短暫出現 queue depth。
- Reporting pipeline 應逐步處理事件。

### 5. 本機 Go 版 Swipe Simulator

如果 Windows 本機已經安裝 Go，可以直接使用專案原本的壓測腳本：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\run-access-load-test.ps1
```

這個版本會：

- 使用本機的 `go run` 執行 `access-api/cmd/swipe-simulator`。
- 預設自動啟動 base stack 加上 Observability override。
- 從 Windows host 打 `http://127.0.0.1:8080`。
- 跑完後印出 Access API `/metrics`。
- 跑完後可到 Grafana dashboard 觀察 Traffic、Event Pipeline、Failures 等圖表。

小型自訂測試可先用較小參數，避免一開始就跑太大流量：

```powershell
$env:EMPLOYEES = "5"
$env:GATES = "2"
$env:DURATION = "10s"
$env:TIME_SCALE = "10"
$env:WORKERS = "2"
$env:EMPLOYEE_PREFIX = "TESTGO"

powershell -ExecutionPolicy Bypass -File .\scripts\run-access-load-test.ps1
```

接近 90,000 人尖峰刷卡的 full 版本：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\run-access-load-test.ps1 -Full
```

如果只想測 Access API，不想啟動完整 Observability stack，可以加 `-BaseOnly`：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\run-access-load-test.ps1 -BaseOnly
```

若執行時出現 `go` 無法辨識，代表本機尚未安裝 Go，或安裝後尚未重新開啟 PowerShell。可先確認：

```powershell
go version
```

正常測試結果應看到：

- `Completed swipes` 等於排程刷卡數。
- `Errors` 為 `0`。
- `Under 50ms target` 為 `true`。
- Grafana Traffic、Event Pipeline、Failures 等圖表會在下一次 Prometheus scrape 後更新。

### 6. Docker 版 Swipe Simulator

若不想在 Windows 本機安裝 Go，可以使用 Docker 版 script：

小型版本：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\run-access-load-test-docker.ps1
```

接近 90,000 人尖峰刷卡的 full 版本：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\run-access-load-test-docker.ps1 -Full
```

用途：

- 不需要在 Windows 安裝 Go。
- 使用 Docker network 內部網址 `http://access-lb:8080` 直接打到 Access API load balancer。
- 小型版本適合 demo 前快速確認；full 版本較接近題目 90,000 人尖峰刷卡情境。
- 預設會啟動 base stack 加上 Observability override，因此跑完可直接看 Prometheus / Grafana。

如果只想測 Access API，不想啟動完整 Observability stack，可以加 `-BaseOnly`：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\run-access-load-test-docker.ps1 -BaseOnly
```

Dashboard 影響：

- Traffic 會明顯上升。
- Event Pipeline 可用來觀察 queue depth 是否能回落。
- Failures 正常應接近 0。
- Access Decision Ratio 會受到 duplicate swipes 比例影響。

## 常用頁面

| 工具 | URL | 用途 |
| --- | --- | --- |
| Access API | `http://localhost:8080/ping` | 確認 Access API 是否可用 |
| Access metrics | `http://localhost:8080/metrics` | Access API metrics |
| Reporting API | `http://localhost:8000/api/health/` | 確認 Reporting API、DB、consumer 狀態 |
| Reporting metrics | `http://localhost:8000/metrics` | Reporting API metrics |
| Prometheus | `http://localhost:9090` | Prometheus 查詢頁 |
| Prometheus targets | `http://localhost:9090/targets` | 確認 scrape targets 是否 up |
| Grafana | `http://localhost:3000` | Observability dashboard |

## Dashboard 數據解讀

Grafana dashboard 的目標是協助判斷系統是否健康，以及問題可能出在哪一段。

### Traffic

觀察 Access API 與 Reporting API 的流量。

- `Access swipes/sec`：每秒刷卡 request 數量。
- `Reporting requests/sec`：Reporting API 每秒 HTTP request 數量。

測試刷卡後，`Access swipes/sec` 應該會短暫上升。若前端或報表 API 被呼叫，`Reporting requests/sec` 也會上升。

用途：

- 判斷系統是否有流量進來。
- 壓測時觀察流量是否符合預期。
- 若使用者說系統沒反應，但 Traffic 完全沒有變化，可能 request 根本沒有打到服務。

### Event Pipeline

觀察事件從 Access API 送往後端 pipeline 的狀態。

- `Access publisher queue`：Access API 非同步事件發送佇列目前累積多少事件。
- `kafka running`：Reporting API 的 Kafka consumer 是否正在執行，`1` 代表 running。
- `redis_recovery running`：Reporting API 的 Redis recovery consumer 是否正在執行，`1` 代表 running。

正常情況：

- `Access publisher queue` 應該長時間接近 `0`。
- consumer running 應該是 `1`。

異常解讀：

- queue depth 持續上升：Access API 產生事件比後端發布/處理還快，或 Kafka 有問題。
- consumer running 變成 `0`：Reporting API 背景 consumer 沒有正常執行。

### Failures

觀察事件發布或 consumer 處理失敗。

- `Access publish failures/sec`：Access API 發布事件到 publisher 時的失敗率。
- `Reporting consumer failures/sec`：Reporting API consumer 處理事件失敗率。

正常情況應該接近 `0`。

異常解讀：

- Access publish failures 上升：可能 Kafka 連線、publisher、或事件發送流程有問題。
- Reporting consumer failures 上升：可能事件格式、資料庫寫入、consumer 邏輯有問題。

### Reporting API p95 Latency

觀察 Reporting API 的 p95 延遲。

p95 的意思是：在一段時間內，約 95% request 的延遲低於這個值。它比平均值更能反映大多數使用者實際感受到的延遲。

用途：

- 對照架構目標中的 Reporting API read path `<200ms`。
- 觀察報表查詢是否變慢。
- 壓測或資料量變大時，檢查查詢是否需要優化。

### Access Decision Ratio

觀察刷卡被拒絕的比例。

- Denied ratio 越高，代表刷卡被拒絕比例越高。
- 在 anti-passback 測試中，連續兩次 `IN` 會讓 denied ratio 上升，這是預期行為。

用途：

- 驗證 anti-passback 規則是否生效。
- 觀察異常拒絕是否突然增加。
- 若 denied ratio 異常偏高，可能是狀態資料錯誤、Redis 狀態異常，或使用者操作行為異常。

## Prometheus Targets 怎麼看

Prometheus targets 頁面會列出 Prometheus 正在抓取的監控來源：

| Job | Docker 內部 endpoint | 來源 |
| --- | --- | --- |
| `access-api` | `access-lb:8080/metrics` | Access API metrics |
| `reporting-api` | `reporting-api:8000/metrics` | Reporting API metrics |
| `redis` | `redis-exporter:9121/metrics` | Redis exporter |
| `postgres` | `postgres-exporter:9187/metrics` | PostgreSQL exporter |
| `kafka` | `kafka-exporter:9308/metrics` | Kafka exporter |
| `prometheus` | `prometheus:9090/metrics` | Prometheus 自身 metrics |

這些 endpoint 使用 Docker network 內部服務名稱，例如 `reporting-api:8000`。這些名稱是給 containers 之間互相連線用的，Windows 瀏覽器不一定能直接打開。

從 Windows host 要看 metrics，請使用 localhost port：

```text
http://localhost:8000/metrics
http://localhost:9121/metrics
http://localhost:9187/metrics
http://localhost:9308/metrics
```

如果 target 是 `down`，可以先看：

```powershell
docker compose -f docker-compose.yml -f observability/docker-compose.observability.yml ps
```

再看對應服務 logs：

```powershell
docker compose -f docker-compose.yml -f observability/docker-compose.observability.yml logs kafka-exporter
```

## Key Metrics

Application metrics：

- `access_api_swipes_total`
- `access_api_swipes_granted_total`
- `access_api_swipes_denied_total`
- `access_api_events_failed_total`
- `access_api_event_queue_depth`
- `reporting_api_http_requests_total`
- `reporting_api_http_request_duration_seconds`
- `reporting_api_consumer_running`
- `reporting_api_consumer_failed_total`

Exporter metrics：

- Redis metrics 由 `redis-exporter` 提供。
- PostgreSQL metrics 由 `postgres-exporter` 提供。
- Kafka metrics 由 `kafka-exporter` 提供。

## Labels 與 Discovered Labels

Prometheus labels 用來標示 metrics 來源與分類，例如：

```text
job="reporting-api"
instance="reporting-api:8000"
```

Targets 頁面中的 discovered labels 是 Prometheus scrape target 時的內部資訊。開頭是 `__` 的 labels 通常是 Prometheus 內部使用，例如：

```text
__address__="access-lb:8080"
__metrics_path__="/metrics"
__scheme__="http"
__scrape_interval__="5s"
__scrape_timeout__="5s"
job="access-api"
```

這代表 Prometheus 每 5 秒抓：

```text
http://access-lb:8080/metrics
```

一般觀察 metrics 時，較常使用 `job`、`instance` 等最後保留下來的 labels。

## Exporters

Exporter 是一種轉接服務，負責把其他系統的狀態轉成 Prometheus `/metrics` 格式。

- `redis-exporter` 讀 Redis 狀態。
- `postgres-exporter` 讀 PostgreSQL 狀態。
- `kafka-exporter` 讀 Kafka broker/topic/consumer group 狀態。

Access API 與 Reporting API 是應用程式本身直接提供 `/metrics`。Redis、PostgreSQL、Kafka 則透過 exporters 提供 metrics。

Exporters 設定：

```yaml
restart: on-failure
```

原因是 exporters 依賴目標服務 ready。例如 Kafka container 顯示 `Running` 時，broker listener 不一定已經能連線；若 exporter 啟動太早會失敗。`restart: on-failure` 可以讓 exporter 在短暫啟動順序問題後自動恢復。

這不會掩蓋真正的故障。如果 Redis、PostgreSQL 或 Kafka 持續不可用，Prometheus target 仍會顯示 `down` 或 scrape error，exporter logs 也會持續出現錯誤。

Prometheus 與 Grafana 目前沒有在這個 override 額外設定 restart policy。Local/demo 環境中，主要觀測服務失敗時保持明顯比較容易除錯；若是長時間運行環境，可以考慮加入 `restart: unless-stopped`。

## Logs 與 Traces

目前支援範圍：

| 類型 | 目前狀態 |
| --- | --- |
| Metrics | 已使用 Prometheus + Grafana 實作 |
| Logs | 可透過 Docker logs 查看，尚未集中化 |
| Traces | 尚未實作 |

查看 logs：

```powershell
docker compose -f docker-compose.yml -f observability/docker-compose.observability.yml logs reporting-api
docker compose -f docker-compose.yml -f observability/docker-compose.observability.yml logs access-api
```

後續若要擴充：

- Logs：可加入 Loki + Promtail 或 Grafana Alloy。
- Traces：可加入 OpenTelemetry instrumentation、OpenTelemetry Collector、Tempo 或 Jaeger。

## Frontend

目前 Docker Compose stack 沒有啟動 React frontend。若要跑前端：

```powershell
cd frontend
npm install
npm run dev
```

啟動後開終端機顯示的 Vite URL，通常是：

```text
http://localhost:5173
```

前端主要透過 Reporting API 查看報表資料；刷卡事件仍建議用 Access API 或 demo scripts 產生。

## 環境變數與 Volumes

`.env` 放本機密碼、port 等設定，不要 commit 到 GitHub。

部分服務會在第一次啟動時把設定寫入 Docker volumes。例如 `POSTGRES_PASSWORD`、`GRAFANA_ADMIN_PASSWORD` 若在 volume 已建立後才修改，舊資料可能仍保留。

若要用新的 `.env` 做乾淨重建，可以：

```powershell
docker compose -f docker-compose.yml -f observability/docker-compose.observability.yml down -v
docker compose -f docker-compose.yml -f observability/docker-compose.observability.yml up -d --build
```

請注意：`down -v` 會刪除本機資料。
