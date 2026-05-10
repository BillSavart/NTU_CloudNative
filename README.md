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
* **可觀測性**：Prometheus + Grafana，用於視覺化換班尖峰期間的系統流量。

---

## 🚀 快速上手指南

## 系統需求
請確保您的開發環境已安裝以下工具：
- **Docker** 與 **Docker Compose**
- **Go** (版本 1.26+)
- **Python** (版本 3.12，建議透過 Conda 建置)
- **Node.js** 與 **npm** (或 yarn/pnpm)

## 本地環境架設

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

可使用內建模擬器壓測 90,000 人、50 扇門、30 分鐘上班尖峰：

```bash
cd access-api
go run ./cmd/swipe-simulator
```

也可以直接使用專案腳本驗證與壓測：

```bash
./scripts/demo-access-api.sh
./scripts/verify-access-stack.sh
./scripts/run-access-load-test.sh
./scripts/run-access-load-test.sh --full
```

若想從 Docker Compose 啟動一路跑到壓力測試結束，最無腦的指令是：

```bash
./scripts/demo-access-api.sh
```

正式 90,000 人尖峰模擬：

```bash
./scripts/demo-access-api.sh --full
```

此模式會把 30 分鐘尖峰壓縮成約 3 分鐘執行，較適合本機 Docker Desktop。

壓測模擬器和腳本每次會自動使用新的員工 ID 前綴，避免 Redis 裡前一次壓測留下的 IN 狀態導致大量 Anti-Passback 拒絕。正式尖峰預設為 99.5% 進門刷卡與 0.5% 重複刷卡，因此結果應以 `GRANTED` 為主。

壓測過程會定期印出完成數、百分比、QPS、錯誤數、平均延遲毫秒數與最大延遲毫秒數。最後 summary 會顯示 `Under 50ms target`，可用 `PROGRESS_EVERY=5s` 調整輸出頻率。

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

若 demo 前想清空報表資料庫，只保留下一輪新刷卡資料：

```bash
./scripts/reset-reporting-db.sh --yes
```

若要一鍵執行完整 demo，包括啟動服務、清資料、基本刷卡、壓力測試與斷線恢復測試：

```bash
./scripts/demo-full-system.sh
```

正式 90,000 人尖峰壓測 demo：

```bash
./scripts/demo-full-system.sh --full
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

### 5. 可觀測性環境（Prometheus / Grafana）
目前已先架好 Prometheus 與 Grafana 的基礎環境，讓後續組員可以接著設計 dashboard、告警與更多 exporter。

啟動可觀測性環境：

```bash
docker-compose up -d prometheus grafana
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

Grafana 已自動 provision Prometheus datasource。Dashboard、告警規則、Kafka/Redis/PostgreSQL exporter 尚未實作，保留給後續可觀測性分工。

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
├── infra/               # Nginx、Redis Sentinel、Prometheus、Grafana 設定
├── k8s/                 # Kubernetes 部署與 HPA (水平擴展) 設定檔 
└── .gitignore           # 多語言環境過濾配置
```
