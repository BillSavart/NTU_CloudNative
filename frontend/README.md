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

## Django 串接

- 登入 API：`POST /api/login/`
- 健康檢查 API：`GET /api/health/`
- 開發模式下，Vite 會把 `/api/*` 代理到 `http://127.0.0.1:8000`。

請先啟動 Django，再啟動前端：

```bash
# terminal 1
cd ../reporting-api
python manage.py runserver

# terminal 2
cd frontend
npm run dev
```
