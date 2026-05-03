# Reporting API

這裡已從 Django 改成 FastAPI 骨架，目標是先把後端環境架好，讓後續組員可以接著實作：

- Kafka `access-events` 寫入 PostgreSQL。
- Reporting API 查詢端點。
- 前端 dashboard 需要的資料 API。

目前只提供健康檢查，不實作報表邏輯。

## 本地啟動

```bash
cd reporting-api
conda create -n tsmc python=3.12 -y
conda activate tsmc
pip install -r requirements.txt
cp .env.example .env
uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

健康檢查：

```bash
curl http://127.0.0.1:8000/api/health/
```

預期回應：

```json
{"status":"ok","service":"reporting-api","environment":"local"}
```

## 環境變數

主要設定放在 `.env`：

```text
APP_NAME=reporting-api
APP_ENV=local
APP_DEBUG=true
CORS_ORIGINS=http://127.0.0.1:5173,http://localhost:5173
POSTGRES_DB=access_control
POSTGRES_USER=root
POSTGRES_PASSWORD=replace-with-a-strong-password
POSTGRES_HOST=127.0.0.1
POSTGRES_PORT=5432
KAFKA_BROKERS=127.0.0.1:19092,127.0.0.1:29092,127.0.0.1:39092
KAFKA_ACCESS_EVENTS_TOPIC=access-events
```

## 專案結構

```text
reporting-api/
├── app/
│   ├── main.py              # FastAPI app 入口
│   ├── config.py            # 環境變數與連線設定
│   ├── database.py          # SQLAlchemy engine/session 骨架
│   ├── routers/
│   │   └── health.py        # 健康檢查
│   └── consumers/
│       └── README.md        # 預留 Kafka consumer 分工
├── .env.example
├── requirements.txt
└── README.md
```

## 後續分工

目前尚未實作任何 reporting 邏輯。後續組員可以從這幾個方向開始：

- 在 `app/consumers/` 新增 Kafka consumer。
- 在 `app/models.py` 或 `app/models/` 定義 PostgreSQL tables。
- 在 `app/routers/` 新增報表查詢 API。
