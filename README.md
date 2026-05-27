# NTU_CloudNative：分散式實體門禁系統

本專案為台積電「Cloud Native Development and Best Practice」課程之學期實作專案。目標是開發一個分散式實體門禁系統，精確記錄 9 萬名員工的進出（In/Out）狀況，並為審計與追蹤生成詳盡報表。

## 📖 專案背景與核心挑戰

本系統設計旨在解決以下核心衝突：
* **高效能決策 (Write-heavy)**：系統需在毫秒級內決定是否開門（Access API 需優化至 50ms 以下）。
* **深度洞察報表 (Read-heavy)**：需同時為執行長 (CEO/CFO) 與經理生成複雜的階層式出勤報表（需優化至 200ms 以下）。

### 系統核心特性
* **防跟隨機制 (Anti-Passback)**：使用者在未「退出」前無法再次「進入」，透過 Redis Cache 進行即時驗證。
* **非同步緩衝與恢復**：進出紀錄會先寫入 Redis Stream 作為 recovery buffer，再透過 Kafka 進入報表寫入路徑；Reporting API 也會讀 Redis Stream 補回中斷期間的資料。
* **系統韌性 (Resilience)**：即使資料庫故障，系統仍須能維持開門功能，並將事件緩衝至資料庫恢復。
* **權限控管與階層報表**：管理員自動擁有其轄下團隊與所有子團隊的數據檢視權限。

## 🛠 關鍵技術架構

* **基礎設施**：Docker、Docker Compose、Kubernetes (K8s)。
* **寫入路徑（Access API）**：Go (Gin) + Redis。
* **事件串流**：Kafka，用於解耦開門決策與報表寫入。
* **讀取路徑（Reporting API）**：Python 3.12 (FastAPI) + PostgreSQL。
* **前端儀表板**：React + TypeScript (Vite 6.0.1) + Bootstrap 5。
* **可觀測性**：Prometheus + Grafana，用於視覺化服務健康度、事件管線與 API 流量。

---

## 🚀 快速上手指南

## 系統需求
請確保您的開發環境已安裝以下工具：
- **Docker** 與 **Docker Compose**
- **Go** (版本 1.26+)
- **Python** (版本 3.12，建議透過 Conda 建置)
- **Node.js** 與 **npm** (或 yarn/pnpm)

## 本地環境架設

### 一鍵 Setup
若要啟動完整 Docker Compose stack、套用 Reporting API migration、清空舊 reporting 資料，並跑不殘留資料的 smoke test：

```bash
./scripts/setup.sh
```

Windows PowerShell:

```powershell
.\scripts\setup.ps1
```

這個腳本會在 smoke test 前後都清空 reporting app tables：`access_events`、`user_department_scopes`、`user_accounts`、`employees`、`departments`。完成後資料庫會保持乾淨，不會留下 fake data 或 smoke test 資料。

若要寫入一年營運感的 TSMC 假資料與 9 萬名員工：

```bash
./scripts/fake_data.sh
```

Windows PowerShell:

```powershell
.\scripts\fake_data.ps1
```

若既有 fake data 缺少 executive 出勤或拒絕通行事件，可以執行 DB 補丁。補丁會把資料安插到既有歷史日期中，不會集中寫在最新時間：

```bash
./scripts/patch_fake_data.sh
```

Windows PowerShell:

```powershell
.\scripts\patch_fake_data.ps1
```

預設帳號密碼為 `demo123`。可用 `FAKE_EMPLOYEE_COUNT`、`FAKE_OPERATING_DAYS`、`FAKE_ATTENDANCE_EMPLOYEES` 調整資料量。
Fake data 會保留主門 `gate_{fab}_A` 作為上下班紀錄，同時在 08:00-24:00 之間產生 B-E 門的日間移動；不會有 00:00-08:00 刷卡，也不會讓員工過夜留在廠內。

### 1. 基礎設施服務 (資料庫與快取)
本專案需要 PostgreSQL、Redis 與 Kafka 才能運作，這些服務已包裝在 Docker 中。
1. 在專案根目錄開啟終端機。
2. 建立 Docker 用環境變數檔：
   ```bash
   cp .env.example .env
   ```
   請將 `.env` 內的 `POSTGRES_PASSWORD`、`REDIS_PASSWORD` 與 `GRAFANA_ADMIN_PASSWORD` 改為你自己的密碼。
3. 在背景啟動服務：
   ```bash
   docker-compose up -d
   ```
   *這將會啟動 PostgreSQL（Port 5432，資料庫 `access_control`）、Redis 主節點/複本/Sentinel、Kafka 3 節點叢集。*

### 環境變數檔案說明（重要）
- 專案根目錄 `.env`：提供給 Docker Compose（啟動 PostgreSQL 容器時使用）。
- `reporting-api/.env`：提供給 FastAPI（應用程式連接資料庫、Kafka 與 CORS 設定使用）。
- 這兩份檔案中的 `POSTGRES_PASSWORD` 必須一致。
- `REDIS_PASSWORD` 會提供給 Redis 主節點、複本、Sentinel 與 Access API，這些服務必須使用同一組密碼。

### 2. Access API（Go）
1. 開啟新的終端機並進入 `access-api` 目錄：
   ```bash
   cd access-api
   ```
2. 下載 Go 模組依賴套件：
   ```bash
   go mod download
   ```
3. 若只想在本機開發 Go API，請直接連 `localhost:6379` 的 Redis，不要使用 Docker 內部 Sentinel hostname：
   ```bash
   REDIS_ADDR=localhost:6379 \
   REDIS_PASSWORD=你的Redis密碼 \
   KAFKA_BROKERS=localhost:19092,localhost:29092,localhost:39092 \
   go run .
   ```
4. 測試 API 運作狀態：
   開啟瀏覽器或在新的終端機輸入以下指令尋找 `ping` 路由，確認伺服器啟動成功：
   ```bash
   curl http://localhost:8080/ping
   ```
   *您應會看見包含 `{"message":"pong","status":"Access API is running"}` 的 JSON 回應。*

Access API 目前採用區域本地 Redis Sentinel 管理的主節點/複本快取做門禁即時決策，並在每次刷卡 request 當下將事件寫入 Redis Stream 作為 recovery source；Kafka 3 節點叢集作為正常非同步事件流：

```text
假刷卡訊號 -> 負載平衡器 -> Access API 叢集 -> Redis Anti-Passback
                                       ├-> Redis Stream access:events
                                       └-> 非同步批次佇列 -> Kafka access-events
```

本地可用 Docker Compose 啟動 3 個 Access API 複本與 Nginx 負載平衡器：

```bash
docker-compose up -d --scale access-api=3 access-lb
```

注意：如果是在 Mac 主機端直接 `go run .`，請使用 `REDIS_ADDR=localhost:6379` 與同一組 `REDIS_PASSWORD`。Redis Sentinel 會回傳 Docker network 內的 `redis:6379`，該 hostname 只有容器內能解析。

若想先把完整 Docker Compose stack 和 Reporting API migration 準備好，並清空舊 reporting 資料，請從專案根目錄執行：

```bash
./scripts/setup.sh
```

Windows PowerShell:

```powershell
.\scripts\setup.ps1
```

若要建立 90,000 名員工和一年歷史出勤紀錄：

```bash
./scripts/fake_data.sh
```

Windows PowerShell:

```powershell
.\scripts\fake_data.ps1
```

正式壓力測試尚未重新設計；目前文件只保留 setup、fake data 與單筆刷卡展示流程。

Access API 也已提供 Dockerfile 與 Kubernetes 部署檔：

```text
access-api/Dockerfile
k8s/access-api-deployment.yaml
k8s/access-api-service.yaml
k8s/access-api-hpa.yaml
```

### 3. Reporting API（Python/FastAPI）
此專案的 Python 需求為 **3.12**。Reporting API 會啟動 Kafka consumer 與 Redis Stream recovery consumer，將 `access-events` 寫入 PostgreSQL，並提供報表查詢 API 的基礎。
1. 開啟新的終端機並進入 `reporting-api` 目錄：
   ```bash
   cd reporting-api
   ```
2. 建立並啟動 Python 3.12 的 Conda 虛擬環境：
   ```bash
   conda create -n tsmc python=3.12 -y
   conda activate tsmc
   ```
3. 安裝所需的 Python 依賴套件：
   ```bash
   pip install -r requirements.txt
   ```
   *(註：使用 `pip` 是為了確保能正確從 PyPI 抓取套件，您也可以視情況混合使用 `conda install`)*
4. 設定環境變數（避免把密碼與 secret key 寫死在程式碼）：
   ```bash
   cp .env.example .env
   ```
   請確認 `POSTGRES_PASSWORD` 與專案根目錄 `.env` 一致。
5. 確保 PostgreSQL 已啟動（若尚未啟動）：
   ```bash
   cd ..
   docker-compose up -d db
   cd reporting-api
   ```
6. 啟動 FastAPI 開發伺服器：
   ```bash
   uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
   ```
7. 測試健康檢查：
   ```bash
   curl http://127.0.0.1:8000/api/health/
   ```
8. 查詢已落庫的刷卡事件與即時統計：
   ```bash
   curl http://127.0.0.1:8000/api/reports/access/summary
   curl 'http://127.0.0.1:8000/api/reports/access/events?limit=20'
   ```

也可以直接用 Docker Compose 啟動：

```bash
docker-compose up -d reporting-api
curl http://127.0.0.1:8000/api/health/
curl http://127.0.0.1:8000/api/reports/access/summary
```

Reporting API 啟動時會自動執行 Alembic migrations。若要手動套用：

```bash
docker-compose exec reporting-api alembic upgrade head
```

若要重新執行完整 stack setup、清空舊 reporting 資料，並確認 smoke test 不殘留資料：

```bash
./scripts/setup.sh
```

Windows PowerShell:

```powershell
.\scripts\setup.ps1
```

若要寫入 90,000 人、一年營運感的假資料：

```bash
./scripts/fake_data.sh
```

Windows PowerShell:

```powershell
.\scripts\fake_data.ps1
```

如需小規模驗證 fake data 產生器，可調低資料量：

```bash
FAKE_EMPLOYEE_COUNT=140 FAKE_OPERATING_DAYS=7 FAKE_ATTENDANCE_EMPLOYEES=50 FAKE_MOVEMENT_PCT=65 FAKE_MAX_MOVES_PER_DAY=3 ./scripts/fake_data.sh
```

Windows PowerShell:

```powershell
.\scripts\fake_data.ps1 -EmployeeCount 140 -OperatingDays 7 -AttendanceEmployees 50 -MovementPct 65 -MaxMovesPerDay 3
```

### 4. 前端（React / Vite）
1. 開啟新的終端機並進入 `frontend` 目錄：
   ```bash
   cd frontend
   ```
2. 安裝必要的 Node.js 依賴套件：
   ```bash
   npm install
   ```
3. 啟動 Vite 開發伺服器：
   ```bash
   npm run dev
   ```

### 5. 可觀測性與 k6 壓力測試（Prometheus / Grafana / k6）
可觀測性環境包含 Prometheus、Grafana、Redis/PostgreSQL/Kafka exporters，以及兩種 k6 壓力測試：Reporting API 查詢壓測、Full-stack 壓測。k6 測試結果會透過 Prometheus remote write 寫入 Prometheus，Grafana dashboard 會顯示 requests/sec、p95 latency、failed rate 與 checks rate。

啟動可觀測性環境：

```bash
docker compose -f docker-compose.yml -f observability/docker-compose.observability.yml up -d prometheus grafana
```

Prometheus：

```text
http://localhost:9090
```

Grafana：

```text
http://localhost:3000
```

Grafana 管理員帳密由專案根目錄 `.env` 的 `GRAFANA_ADMIN_USER` 與 `GRAFANA_ADMIN_PASSWORD` 設定。`.env.example` 只提供 placeholder，請不要把真正密碼寫進 README 或提交到 Git。

目前 Prometheus 會 scrape：

```text
access-lb:8080/metrics
```

也就是 Access API 已提供的 Prometheus 格式指標，例如：

```text
access_api_swipes_total
access_api_swipes_granted_total
access_api_swipes_denied_total
access_api_events_queued_total
access_api_events_buffered_total
access_api_events_published_total
access_api_events_failed_total
access_api_events_retried_total
access_api_events_dropped_total
access_api_event_queue_depth
```

Grafana 已自動 provision Prometheus datasource 與 `Access Control Observability` dashboard。Dashboard 內含 Access API、Reporting API、事件管線、exporters 與 k6 壓力測試 panels。

執行比較完整的 full-stack k6 壓力測試：

```bash
./scripts/run-k6-full-stack-load-test.sh
```

Windows PowerShell:

```powershell
.\scripts\run-k6-full-stack-load-test.ps1
```

Full-stack 壓測會同時打 Access API 刷卡寫入/狀態/最近事件、Reporting API dashboard/summary/report center/events/departments/employees/attendance/compliance 查詢，以及 frontend Nginx `/api` proxy。Reporting API 會輪詢覆蓋這些查詢，不會在每個 iteration 同時爆打全部報表 endpoint；這樣比較適合作為穩定 baseline，真正的 timeout/failure 情境請交給 chaos 測試。這條路徑會產生 Access metrics、Reporting metrics、Kafka/reporting consumer 壓力與 k6 metrics，比只跑 Reporting API 更適合觀察整體系統。腳本會使用唯一 `K6_EMPLOYEE_PREFIX` 產生測試員工，並在壓測前後自動清掉同 prefix 的 PostgreSQL rows、Redis state/dedupe keys 與 Redis recovery stream entries，避免污染 demo seed 資料。

若要測故障復原，可執行 chaos k6 測試：

```bash
./scripts/run-k6-chaos-test.sh
```

Windows PowerShell:

```powershell
.\scripts\run-k6-chaos-test.ps1
```

Chaos 測試會先跑 full-stack workload，然後短暫停止 `reporting-api`，恢復後再短暫重啟一個 Kafka broker（預設 `kafka-1`）。這段期間 Grafana 的 k6 failed rate、checks rate、Event Pipeline、consumer processed/sec 會出現波動是預期現象；重點是服務恢復後 pipeline 能繼續處理。Chaos 腳本也會使用唯一 `K6_EMPLOYEE_PREFIX`，最後多輪清理同 prefix 的 PostgreSQL 與 Redis 測試資料。

若只想測報表查詢，可執行 Reporting API k6 壓力測試：

```bash
./scripts/run-k6-reporting-load-test.sh
```

Windows PowerShell:

```powershell
.\scripts\run-k6-reporting-load-test.ps1
```

可用環境變數或 PowerShell 參數調整壓力測試規模，例如：

```bash
K6_VUS=50 K6_STEADY=5m K6_TEST_ID=reporting-api-50vus ./scripts/run-k6-reporting-load-test.sh
```

```powershell
.\scripts\run-k6-reporting-load-test.ps1 -Vus 50 -Steady 5m -TestId reporting-api-50vus
```

測試預設都會用 `rd_1_manager / demo123` 登入。若 Grafana 有些 panels 顯示 `No data`，請先確認跑的是 full-stack 或 chaos 腳本、Grafana 右上角 `k6_testid` 已切到本次 `K6_TEST_ID`，並且時間範圍包含壓測執行時間；k6 panels 會用目前 Grafana 時間範圍統計整次壓測。一般 full-stack 的預設 p95 threshold 是 `15000ms`，chaos 預設放寬為 `30000ms`，且允許故障視窗內的短暫 failure。若你想手動重跑清理，可執行 `./scripts/cleanup-k6-load-test-data.sh <K6_EMPLOYEE_PREFIX>`。

### 6. 登入與 demo 密碼重設
登入頁面使用「登入帳號」作為欄位名稱；API 仍維持相容舊欄位 `employeeId`，內容可填 username 或 employee id。勾選「記住我」會保存登入帳號並延長 session cookie。

Demo 階段的忘記密碼流程會讓使用者輸入登入帳號與 email，系統只用登入帳號找帳號，不會比對 email 是否正確；只要帳號存在，就會產生一次性更改密碼連結並回傳/寄送到填寫的 email。

## 開發流程
若要在本地完整運行整個應用程式，您需要：
1. 確保 Docker 容器已啟動。
2. 開啟一個終端機執行 Access API（Go）。
3. 開啟一個終端機執行 Reporting API（FastAPI）。
4. 開啟一個終端機執行前端（Vite）。

## 📂 專案結構說明

```text
NTU_CloudNative/
├── docker-compose.yml   # 本地開發資料庫、Redis Sentinel、Kafka、API 與可觀測性服務配置
├── access-api/          # Go: 處理 In/Out 決策、Anti-Passback 邏輯
├── reporting-api/       # FastAPI: Kafka -> DB consumer、報表 API 基礎、使用者/部門權限 schema
├── frontend/            # React + TS: 主管報表視覺化儀表板 
├── observability/       # Prometheus、Grafana、exporters 與 k6 壓力測試設定
├── infra/               # Nginx、Redis Sentinel、Prometheus、Grafana 設定
├── k8s/                 # Kubernetes 部署與 HPA (水平擴展) 設定檔 
└── .gitignore           # 多語言環境過濾配置
```
