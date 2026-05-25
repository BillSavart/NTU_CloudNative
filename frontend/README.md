# Frontend (React + TypeScript + Vite)

此前端目前已改為 Bootstrap 版型，首頁為「出勤管理系統」登入頁。

## 使用技術

- React 19
- TypeScript
- Vite
- Bootstrap 5
- React Router

## 本地啟動

```bash
cd frontend
npm install
npm run dev
```

## 版面說明

- 主要畫面使用 Bootstrap 工具類別與元件（`card`、`form-control`、`btn` 等）建構。
- 全域樣式由 `bootstrap/dist/css/bootstrap.min.css` 載入。
- Logo 圖片來源：`src/assets/tsmc_logo.png`。

## 前端結構（重構後）

- `src/App.tsx`：應用入口，負責掛載頁面。
- `src/pages/LoginPage.tsx`：登入頁容器（頁面層）。
- `src/components/auth/LoginCard.tsx`：登入卡片與標題區塊。
- `src/components/auth/LoginForm.tsx`：登入表單區塊。

此結構可在後續擴充時，平滑加入其他頁面（例如 Dashboard、Reports、Users）與路由設定。

## 路由

- `/login`：出勤管理系統登入頁。
- 其他未定義路徑會自動導回 `/login`。

## Reporting API 串接

- Reporting API 已從 Django 改成 FastAPI。
- 健康檢查 API：`GET /api/health/`
- 開發模式下，Vite 會把 `/api/*` 代理到 `http://127.0.0.1:8000`。
- 登入與報表 API 尚未實作，會留給後續分工。

請先啟動 FastAPI，再啟動前端：

```bash
# terminal 1
cd ../reporting-api
uvicorn app.main:app --reload --host 127.0.0.1 --port 8000

# terminal 2
cd frontend
npm run dev
```

---

## 如何登入

前端登入頁：`/login`

### Demo 快速登入（前端假登入）

在登入頁輸入：

- `employeeId`: `frontend`
- `password`: `123`

會直接在前端通過（不呼叫 API），方便做 UI demo。

### 連 Reporting API 登入（建議）

前端會呼叫：

- `GET /api/csrf/`（取得 CSRF cookie）
- `POST /api/login/`（送出帳密）

Reporting API demo 帳號（見 `reporting-api/API.md`）例如：

- `admin / demo123`
- `manager / demo123`
- `employee / demo123`

> 注意：Vite dev server 會把 `/api/*` proxy 到 `http://127.0.0.1:8000`（見 `frontend/vite.config.ts`）。

## 目前有哪些頁面（路由）與用途

側邊欄目前包含：

- `/dashboard`：首頁總覽（KPI + 即時刷卡事件 + 異常捷徑）
- `/employee/my-attendance`：我的出勤（個人上下班紀錄與工時摘要）
- `/analytics`：部門分析（轄下部門出勤比較與趨勢）
- `/alerts`：異常合規（超時工時與高風險出勤事件）
- `/employee/reports`：報表中心（報表匯出與下載 UI）
- `/login`：登入頁

### 已接 API

- 登入：`frontend/src/services/auth.ts`
  - `GET /api/csrf/`
  - `POST /api/login/`
- 即時刷卡事件：`frontend/src/services/accessEvents.ts`
  - `GET /api/reports/access/events?limit=...&offset=0`
  - `frontend/src/pages/Dashboard.tsx` 每 5 秒輪詢更新

### 目前仍是假資料（待補 API）

- Dashboard KPI（今日出勤/遲到/缺勤/超時）：`frontend/src/pages/Dashboard.tsx`
- 待處理異常捷徑數字：`frontend/src/pages/Dashboard.tsx`
- 我的出勤 KPI 與明細：`frontend/src/pages/employee/MyAttendance.tsx`
- 部門分析 KPI 與部門比較表：`frontend/src/pages/DepartmentAnalytics.tsx`
- 異常合規清單：`frontend/src/pages/ComplianceAlerts.tsx`（`seedAlerts`）
- 報表中心下載：`frontend/src/pages/employee/Reports.tsx`（目前只有 UI）

## 如何模擬刷卡（產生即時事件）

Access API（Go/Gin）提供刷卡端點：

- `POST http://127.0.0.1:8080/api/access/swipe`

Reporting API 會從 Kafka/Redis recovery 消費事件後寫入 PostgreSQL，前端 Dashboard 會從
`GET /api/reports/access/events` 看到最新事件。

### PowerShell 範例（IN/OUT）

```powershell
# IN
$body = @{
  employeeId = "EMP001"
  gateId = "GATE_01"
  direction = "IN"
} | ConvertTo-Json

Invoke-RestMethod `
  -Uri "http://127.0.0.1:8080/api/access/swipe" `
  -Method POST `
  -ContentType "application/json" `
  -Body $body

# OUT（同一個 employeeId）
$body = @{
  employeeId = "EMP001"
  gateId = "GATE_01"
  direction = "OUT"
} | ConvertTo-Json

Invoke-RestMethod `
  -Uri "http://127.0.0.1:8080/api/access/swipe" `
  -Method POST `
  -ContentType "application/json" `
  -Body $body
```

### 常見注意事項

- 如果 Dashboard 顯示 `Failed to load access events (502)`，通常是 `reporting-api` 正在重啟或尚未啟動。
- 若事件有進來但部門顯示 `-`，請確認 `employees.department_id` 是否有值，且 `reporting-api` 已更新到會回 `departmentId` 的版本。
