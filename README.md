# NTU_CloudNative: Distributed Physical Access Control System 🏢

本專案為台積電「Cloud Native Development and Best Practice」課程之學期實作專案。目標是開發一個分散式實體門禁系統，精確記錄 9 萬名員工的進出（In/Out）狀況，並為審計與追蹤生成詳盡報表。

## 📖 專案背景與核心挑戰

本系統設計旨在解決以下核心衝突：
* **高效能決策 (Write-heavy)**：系統需在毫秒級內決定是否開門（Access API 需優化至 50ms 以下）。
* **深度洞察報表 (Read-heavy)**：需同時為執行長 (CEO/CFO) 與經理生成複雜的階層式出勤報表（需優化至 200ms 以下）。

### 系統核心特性
* **防跟隨機制 (Anti-Passback)**：使用者在未「退出」前無法再次「進入」，透過 Redis Cache 進行即時驗證。
* **非同步緩衝**：進出紀錄透過訊息元件（Message Broker）進行非同步緩衝，再寫入資料庫以確保資料完整性。
* **系統韌性 (Resilience)**：即使資料庫故障，系統仍須能維持開門功能，並將事件緩衝至資料庫恢復。
* **權限控管與階層報表**：管理員自動擁有其轄下團隊與所有子團隊的數據檢視權限。

## 🛠 關鍵技術架構 (Tech Stack)

* **Infrastructure**: Docker, Docker Compose, Kubernetes (K8s).
* **Write Path (Access API)**: Go (Gin/Fiber) + Redis (Cache System).
* **Event Broker**: RabbitMQ / Kafka (用於解耦開門決策與報表寫入). （待定）
* **Read Path (Reporting API)**: Python 3.12 (Django) + PostgreSQL.
* **Frontend Dashboard**: React + TypeScript (Vite 6.0.1) + Bootstrap 5.
* **Observability**: Prometheus + Grafana (視覺化「換班 Shift Change」期間的流量尖峰). 

---

## 🚀 快速上手指南 (Local Setup)

## 系統需求
請確保您的開發環境已安裝以下工具：
- **Docker** 與 **Docker Compose**
- **Go** (版本 1.26+)
- **Python** (版本 3.12，建議透過 Conda 建置)
- **Node.js** 與 **npm** (或 yarn/pnpm)

## 本地環境架設

### 1. 基礎設施服務 (資料庫與快取)
本專案需要 PostgreSQL 與 Redis 才能運作，這些服務已包裝在 Docker 中。
1. 在專案根目錄開啟終端機。
2. 建立 Docker 用環境變數檔：
   ```bash
   cp .env.example .env
   ```
   請將 `.env` 內的 `POSTGRES_PASSWORD` 改為你自己的密碼。
3. 在背景啟動服務：
   ```bash
   docker-compose up -d
   ```
   *這將會啟動 PostgreSQL（Port 5432，資料庫 `access_control`）與 Redis（Port 6379）。*

### 2. Access API (Go)
1. 開啟新的終端機並進入 `access-api` 目錄：
   ```bash
   cd access-api
   ```
2. 下載 Go 模組依賴套件：
   ```bash
   go mod download
   ```
3. 執行 Go 伺服器：
   ```bash
   go run main.go
   ```
4. 測試 API 運作狀態：
   開啟瀏覽器或在新的終端機輸入以下指令尋找 `ping` 路由，確認伺服器啟動成功：
   ```bash
   curl http://localhost:8080/ping
   ```
   *您應會看見包含 `{"message":"pong","status":"Access API is running"}` 的 JSON 回應。*

### 3. Reporting API (Python/Django)
此專案的 Python 需求為 **3.12**，以下將以 Conda 環境示範架設步驟。
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
   請至少修改 `DJANGO_SECRET_KEY` 與 `POSTGRES_PASSWORD`。
5. 確保 PostgreSQL 已啟動（若尚未啟動）：
   ```bash
   cd ..
   docker-compose up -d db
   cd reporting-api
   ```
6. 執行資料庫遷移：
   ```bash
   python manage.py migrate
   ```
7. 建立 Django 管理員帳號（superuser）：
   ```bash
   python manage.py createsuperuser
   ```
8. 啟動 Django 開發伺服器：
   ```bash
   python manage.py runserver
   ```

### Reporting API 安全設定重點
- `SECRET_KEY` 改由 `reporting-api/.env` 的 `DJANGO_SECRET_KEY` 提供。
- 開發模式預設開啟 `DJANGO_DEBUG=True`，部署前請改為 `False`。
- `/api/login/` 已啟用 CSRF 防護，前端會先呼叫 `/api/csrf/` 取得 cookie 再送登入請求。

### 4. 前端 (React / Vite)
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

## 開發流程
若要在本地完整運行整個應用程式，您需要：
1. 確保 Docker 容器已啟動。
2. 開啟一個終端機執行 Access API (Go)。
3. 開啟一個終端機執行 Reporting API (Django)。
4. 開啟一個終端機執行前端 (Vite)。

## 📂 專案結構說明

```text
NTU_CloudNative/
├── docker-compose.yml   # 本地開發資料庫與 Redis 配置
├── access-api/          # Go: 處理 In/Out 決策、Anti-Passback 邏輯
├── reporting-api/       # Django: 處理複雜階層查詢與報表 API 
├── frontend/            # React + TS: 主管報表視覺化儀表板 
├── k8s/                 # Kubernetes 部署與 HPA (水平擴展) 設定檔 
└── .gitignore           # 多語言環境過濾配置
```