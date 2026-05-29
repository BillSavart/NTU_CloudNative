# Observability

這個資料夾放的是本專案額外的 Observability 設定。它主要是給 IT / 維運人員確認系統健康狀態，不是給一般使用者看的業務報表 Dashboard。

目前範圍包含 **Metrics、Logs、Traces**：

- Metrics：Prometheus 收集指標，Grafana 顯示 dashboard。
- Logs：Grafana Alloy 收集 Docker / Kubernetes logs，送到 Loki。
- Traces：Access API 與 Reporting API 透過 OpenTelemetry 送 trace 到 Alloy，再寫入 Tempo。

## 這一層做什麼

- 監控 Access API 的刷卡流量、授權/拒絕次數、事件佇列狀態。
- 監控 Reporting API 的 HTTP request 數量、延遲、Kafka consumer 與 Redis recovery consumer 狀態。
- 透過 exporters 監控 Redis、PostgreSQL、Kafka。
- 透過 Loki + Alloy 集中查詢服務 logs。
- 透過 Tempo + Alloy 接收 OpenTelemetry traces。
- 透過 k6 對 Reporting API 或 full-stack 流程產生壓力，並把結果寫回 Prometheus。
- 透過 Grafana dashboard 讓系統健康狀態更容易觀察。
- 以 Docker Compose override 的方式啟用，不影響原本只跑 base stack 的流程。

## 相關檔案

```text
observability/
|-- README.md
|-- docker-compose.observability.yml
|-- k6/
|   |-- full-stack.js
|   `-- reporting-api.js
|-- prometheus/
|   `-- prometheus.yml
`-- grafana/
    `-- provisioning/
        |-- datasources/
        |   |-- loki.yml
        |   |-- prometheus.yml
        |   `-- tempo.yml
        `-- dashboards/
            |-- dashboards.yml
            `-- json/
                `-- observability-dashboard.json

infra/
|-- alloy/
|   |-- config.alloy
|   `-- k8s-config.alloy
|-- loki/
|   `-- loki-config.yaml
`-- tempo/
    `-- tempo-config.yaml

reporting-api/
|-- app/
|   `-- observability.py
`-- requirements-observability.txt

scripts/
|-- run-k6-full-stack-load-test.sh
|-- run-k6-full-stack-load-test.ps1
|-- run-k6-chaos-test.sh
|-- run-k6-chaos-test.ps1
|-- run-k6-reporting-load-test.sh
`-- run-k6-reporting-load-test.ps1
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

這會啟動 Access API、Reporting API、PostgreSQL、Redis、Kafka、Prometheus、Grafana、Loki、Tempo、Alloy，以及 Redis/PostgreSQL/Kafka exporters。

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

### 5. 產生測試流量或壓力測試

先打基本 health / metrics endpoints：

```powershell
curl.exe http://localhost:8080/ping
curl.exe http://localhost:8000/api/health/
curl.exe http://localhost:8000/metrics
```

這些 request 會讓 Reporting API request count、latency 等 metrics 有資料。

若要產生較接近實際系統的刷卡事件，請使用下方「產生刷卡事件 PowerShell 範例」。

若要針對 Reporting API 執行 k6 壓力測試，請使用下方「k6 Reporting API 壓力測試」。

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
access_api_runtime_alloc_bytes
access_api_runtime_sys_bytes
access_api_runtime_goroutines
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

### 4. 歷史資料 Fake Data

如果觀察重點是 Reporting API / frontend 的查詢與 dashboard，而不是即時 Access API 流量，可以直接寫入一年營運感資料：

```powershell
.\scripts\fake_data.ps1
```

小規模驗證：

```powershell
.\scripts\fake_data.ps1 -EmployeeCount 140 -OperatingDays 7 -AttendanceEmployees 50 -MovementPct 65 -MaxMovesPerDay 3
```

Dashboard 影響：

- Reporting API 與 frontend 可查到跨一年的歷史出勤資料。
- 員工、部門、權限資料會符合 `TSMC -> fab_1..fab_22 -> RD/IT/PE/EE` 結構。

## k6 壓力測試

k6 壓力測試會透過 Docker Compose profile 啟動，預設不會隨一般 stack 自動執行。測試會：

- 使用 `rd_1_manager / demo123` 登入，並帶 `rememberMe: true`。
- Reporting-only 模式會查詢報表中心、部門分析與異常合規 endpoints。
- Full-stack 模式會同時打 Access API 刷卡寫入/狀態/最近事件、Reporting API dashboard/summary/report center/events/departments/employees/attendance/compliance 查詢，以及 frontend Nginx `/api` proxy；Reporting API 查詢會輪詢覆蓋，不會在每個 iteration 同時爆打所有報表 endpoint。
- 將 k6 metrics 透過 Prometheus remote write 寫入 `http://prometheus:9090/api/v1/write`。
- 在 Grafana `Access Control Observability` dashboard 顯示 k6 requests/sec、p95 latency、failed rate 與 checks rate。

建議先跑 full-stack，因為它會讓 Access API、Reporting API、事件管線與 k6 panels 都有壓測資料：

macOS/Linux:

```bash
./scripts/run-k6-full-stack-load-test.sh
```

Windows PowerShell:

```powershell
.\scripts\run-k6-full-stack-load-test.ps1
```

Full-stack 腳本預設 `K6_CLEANUP=true`，會用唯一 `K6_EMPLOYEE_PREFIX` 隔離測試員工，並在壓測前後清掉同 prefix 的 PostgreSQL rows、Redis state/dedupe keys 與 Redis recovery stream entries。即使 k6 threshold fail，中途退出也會進入收尾清理。若要手動補清理：

```bash
./scripts/cleanup-k6-load-test-data.sh <K6_EMPLOYEE_PREFIX>
```

```powershell
.\scripts\cleanup-k6-load-test-data.ps1 -EmployeePrefix <K6_EMPLOYEE_PREFIX>
```

### k6 Chaos 測試

Chaos 測試用同一套 full-stack workload，但會在測試期間故意製造短暫故障：

- 先停止 `reporting-api` 一段時間，讓 frontend proxy 與 reporting 查詢短暫失敗。
- 恢復 `reporting-api` 後，重啟一個 Kafka broker（預設 `kafka-1`），觀察 Kafka/exporter 與 reporting consumer 是否恢復。
- 使用唯一 `K6_EMPLOYEE_PREFIX` 產生測試事件，結束後多輪清理 PostgreSQL 與 Redis，不污染 demo seed 資料。

macOS/Linux:

```bash
./scripts/run-k6-chaos-test.sh
```

Windows PowerShell:

```powershell
.\scripts\run-k6-chaos-test.ps1
```

常用 chaos 參數：

| 目的 | macOS/Linux | PowerShell |
| --- | --- | --- |
| 調整 VUs | `K6_VUS=20 ./scripts/run-k6-chaos-test.sh` | `.\scripts\run-k6-chaos-test.ps1 -Vus 20` |
| 拉長壓測時間 | `K6_STEADY=5m ./scripts/run-k6-chaos-test.sh` | `.\scripts\run-k6-chaos-test.ps1 -Steady 5m` |
| 調整開始故障時間 | `CHAOS_START_DELAY_SECONDS=60 ./scripts/run-k6-chaos-test.sh` | `.\scripts\run-k6-chaos-test.ps1 -ChaosStartDelaySeconds 60` |
| 調整 Reporting API 停機秒數 | `CHAOS_REPORTING_DOWN_SECONDS=30 ./scripts/run-k6-chaos-test.sh` | `.\scripts\run-k6-chaos-test.ps1 -ReportingDownSeconds 30` |
| 指定 Kafka broker | `CHAOS_KAFKA_BROKER=kafka-2 ./scripts/run-k6-chaos-test.sh` | `.\scripts\run-k6-chaos-test.ps1 -KafkaBroker kafka-2` |
| 調整可接受 failure rate | `K6_FAILED_RATE_THRESHOLD=0.40 ./scripts/run-k6-chaos-test.sh` | `.\scripts\run-k6-chaos-test.ps1 -FailedRateThreshold 0.40` |

Chaos 測試期間看到 k6 failed rate、checks rate 下降，或 `Event Pipeline` 的 running/processed 線有缺口，是預期現象。判斷重點是：

- k6 結束後 `reporting-api` 與 Kafka broker 已恢復。
- `Event Pipeline` 的 `processed/sec` 在恢復後繼續出現。
- cleanup 最後顯示 `remaining_access_events = 0`、`remaining_employees = 0`。

如果 chaos 或 full-stack 中途被強制關閉，使用同一個 prefix 補清：

```bash
./scripts/cleanup-k6-load-test-data.sh <K6_EMPLOYEE_PREFIX>
```

```powershell
.\scripts\cleanup-k6-load-test-data.ps1 -EmployeePrefix <K6_EMPLOYEE_PREFIX>
```

若只想測 reporting 查詢面，再跑 reporting-only：

macOS/Linux:

```bash
./scripts/run-k6-reporting-load-test.sh
```

Windows PowerShell:

```powershell
.\scripts\run-k6-reporting-load-test.ps1
```

常用調整參數：

| 目的 | macOS/Linux | PowerShell |
| --- | --- | --- |
| 調整 VUs | `K6_VUS=50 ./scripts/run-k6-full-stack-load-test.sh` | `.\scripts\run-k6-full-stack-load-test.ps1 -Vus 50` |
| 拉長穩定壓測時間 | `K6_STEADY=5m ./scripts/run-k6-full-stack-load-test.sh` | `.\scripts\run-k6-full-stack-load-test.ps1 -Steady 5m` |
| 調整 p95 threshold | `K6_P95_THRESHOLD_MS=3000 ./scripts/run-k6-full-stack-load-test.sh` | `.\scripts\run-k6-full-stack-load-test.ps1 -P95ThresholdMs 3000` |
| 區分測試批次 | `K6_TEST_ID=full-stack-50vus ./scripts/run-k6-full-stack-load-test.sh` | `.\scripts\run-k6-full-stack-load-test.ps1 -TestId full-stack-50vus` |
| 更換登入帳號 | `K6_LOGIN_ID=employee ./scripts/run-k6-full-stack-load-test.sh` | `.\scripts\run-k6-full-stack-load-test.ps1 -LoginId employee` |

完整可調環境變數：

```text
K6_VUS=20
K6_RAMP_UP=30s
K6_STEADY=2m
K6_RAMP_DOWN=30s
K6_LOGIN_ID=rd_1_manager
K6_LOGIN_PASSWORD=demo123
K6_P95_THRESHOLD_MS=15000
K6_FAILED_RATE_THRESHOLD=0.05
K6_CHECK_RATE_THRESHOLD=0.95
K6_THINK_TIME_SECONDS=1
K6_TEST_ID=full-stack-demo
K6_EMPLOYEE_PREFIX=K61700000000
K6_GATES=8
```

Grafana 觀察路徑：

```text
http://localhost:3000
Dashboards -> NTU Cloud Native -> Access Control Observability
```

Dashboard 右上方的 `k6_testid` 變數可切換不同壓測批次。k6 panels 會用目前 Grafana 時間範圍統計整次壓測；若一開始是空的，請先確認已跑過壓測、時間範圍涵蓋壓測時間、`k6_testid` 已切到本次 `K6_TEST_ID`，並確認 Prometheus 是透過 observability override 啟動，因為 k6 remote write 需要 `--web.enable-remote-write-receiver`，p95 latency panel 使用的 native histogram 也需要 `--enable-feature=native-histograms`。

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
- 單筆刷卡驗證或前端查詢時觀察流量是否符合預期。
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
- 資料量變大時，檢查查詢是否需要優化。

### Access Decision Ratio

觀察刷卡被拒絕的比例。

- Denied ratio 越高，代表刷卡被拒絕比例越高。
- 在 anti-passback 測試中，連續兩次 `IN` 會讓 denied ratio 上升，這是預期行為。

用途：

- 驗證 anti-passback 規則是否生效。
- 觀察異常拒絕是否突然增加。
- 若 denied ratio 異常偏高，可能是狀態資料錯誤、Redis 狀態異常，或使用者操作行為異常。

### Login Activity

觀察 Reporting API 登入 endpoint 的 request rate。

- `login status 200/sec`：登入成功的流量。
- `login status 401/sec` 或其他非 2xx 狀態：登入失敗或異常回應的流量。

用途：

- 對應題目要求中的 `user login activity`。
- 在 shift change 或 demo 壓測期間，觀察登入流量是否出現尖峰。
- 若登入失敗率突然上升，可以搭配 Reporting API logs 或 `/api/health/` 判斷是帳密錯誤、DB 問題，還是 API 服務異常。

### Reporting API Memory

觀察 Reporting API Python process 的記憶體使用量。

- `Reporting resident memory`：實際常駐記憶體，通常最適合用來看服務是否吃掉過多 RAM。
- `Reporting virtual memory`：process 可見的虛擬記憶體範圍，通常會比 resident memory 大。

用途：

- 對應題目要求中的 `system load`。
- 跑 fake data、報表查詢或 k6 壓測時，觀察 Reporting API 是否有記憶體持續上升的跡象。

### Access API Runtime Load

觀察 Access API Go process 的 runtime 負載。

- `Access goroutines`：目前 Go goroutine 數量。
- `Access heap alloc MiB`：Go heap 目前配置量。
- `Access sys memory MiB`：Go runtime 從 OS 取得的記憶體量。

用途：

- 對應題目要求中的 `system load`。
- 在 shift change 刷卡尖峰或 k6 full-stack 壓測期間，觀察 Access API 是否因大量 request 出現 goroutine 或記憶體異常上升。

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
| Logs | 已使用 Alloy 收集 Docker / Kubernetes logs，集中送到 Loki |
| Traces | Access API 與 Reporting API 已使用 OpenTelemetry，透過 Alloy 送到 Tempo |

在 Grafana 查看 logs：

```text
Explore -> datasource 選 Loki
```

常用 LogQL：

```text
{service="reporting-api"}
{service="access-api"}
{container=~".*reporting-api.*"}
```

Docker 仍可直接查看 logs：

```powershell
docker compose -f docker-compose.yml -f observability/docker-compose.observability.yml logs reporting-api
docker compose -f docker-compose.yml -f observability/docker-compose.observability.yml logs access-api
```

在 Grafana 查看 traces：

```text
Explore -> datasource 選 Tempo
```

目前 trace 來源包含 Access API HTTP request、Reporting API HTTP request，以及 Reporting consumer 寫入 access event 的背景處理。Access API 會把 `traceparent` / `tracestate` 放進 Kafka headers 與 Redis Stream payload，Reporting API consumer 會接續這個 trace context，因此可以從單次刷卡 request 追到後續事件落庫流程。

## Docker 與上雲版本差異

目前 Logs / Traces 採用同一套可延伸架構：

```text
Docker Compose:
container logs -> Alloy -> Loki -> Grafana
Access API / Reporting API OTLP traces -> Alloy -> Tempo -> Grafana

Kubernetes / cloud:
pod logs -> Alloy DaemonSet -> Loki -> Grafana
Access API / Reporting API OTLP traces -> Alloy Service -> Tempo -> Grafana
```

已補成 Docker 與 Kubernetes / cloud 都可使用的項目：

| 項目 | Docker 狀態 | Kubernetes / cloud 狀態 | 備註 |
| --- | --- | --- | --- |
| k6 full-stack load test | Docker Compose profile | Kubernetes Job `k8s/k6-full-stack-job.yaml` | 上雲可直接在 cluster 內跑，也可改用外部 runner 或 Grafana Cloud k6 |
| Grafana dashboard JSON | Docker 掛載同一份 dashboard | Kubernetes 透過 Kustomize 產生 `grafana-dashboard-json` ConfigMap | 避免 Docker 與 k8s dashboard 分岔 |
| Prometheus alert rules | Docker/base Prometheus 已有 | Kubernetes 透過 Kustomize 產生 `prometheus-alert-rules` ConfigMap | 共用 `infra/prometheus/alert_rules.yml` |
| 刷卡測試頁 simulator | Docker Compose service | Kubernetes Deployment / Service `simulator` | k8s 版 nginx proxy 會指向 `access-api:80` |
| 跨 Kafka/Redis 的 trace context | 已透過 payload/header 帶 `traceparent` | 已透過 payload/header 帶 `traceparent` | 涵蓋 Access API HTTP span 與 Reporting consumer persist span |

仍需依實際雲端環境調整的項目：

| 項目 | 現況 | 上雲建議 |
| --- | --- | --- |
| Loki / Tempo 儲存 | Docker 使用 volume；k8s demo 使用 `emptyDir` | production 改 PVC 或雲端 object storage，避免 Pod 重建後資料消失 |
| PostgreSQL / Redis / Kafka | repo 內提供 demo manifests | production 優先考慮 managed service 或 operator |
| 對外網址 | 本機使用 `localhost`，Kubernetes demo 使用 Ingress hostname | 上雲後改成正式 DNS、TLS、Ingress Controller 或 Load Balancer |

## Frontend

Docker Compose 會啟動 frontend container：

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
