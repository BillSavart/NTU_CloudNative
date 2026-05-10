# Reporting API

這裡已從 Django 改成 FastAPI，負責把 Kafka `access-events` 事件寫入 PostgreSQL，並提供報表查詢 API 的基礎。

目前已包含：

- Kafka `access-events` consumer。
- Redis Stream recovery consumer，可從 `access:events` 補回中斷期間資料。
- Alembic schema migrations。
- Access event 落庫與 `requestId` 去重。
- 最近刷卡事件與即時統計查詢 API。

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
KAFKA_CONSUMER_ENABLED=true
KAFKA_CONSUMER_GROUP_ID=reporting-api
KAFKA_AUTO_OFFSET_RESET=earliest
REDIS_ADDR=127.0.0.1:6379
REDIS_PASSWORD=replace-with-a-strong-password
REDIS_DB=0
REDIS_EVENT_STREAM_KEY=access:events
REDIS_RECOVERY_ENABLED=true
REDIS_RECOVERY_GROUP=reporting-api
REDIS_RECOVERY_CONSUMER_NAME=reporting-api-1
REDIS_RECOVERY_BLOCK_MS=5000
REDIS_RECOVERY_BATCH_SIZE=100
```

## DB 設計

目前 schema 由 Alembic migration 管理，FastAPI 啟動時會自動執行 `alembic upgrade head`：

- `departments`：部門階層，保留給後續主管權限與階層報表。
- `employees`：員工主檔與目前最後狀態，consumer 遇到新 `employeeId` 會自動建立 minimal row。
- `user_accounts`：登入使用者與角色，角色分為 `EMPLOYEE`、`MANAGER`、`EXECUTIVE`、`ADMIN`。
- `user_department_scopes`：設定使用者可看的部門範圍，可選擇是否包含子部門。
- `access_events`：刷卡事件事實表，使用 `request_id` unique constraint 防止 Kafka 重送造成重複寫入。

核心查詢索引：

- `access_events.employee_id + occurred_at`
- `access_events.decision + occurred_at`
- `access_events.occurred_at`
- `employees.department_id`
- `employees.manager_employee_id`
- `user_department_scopes.user_id`
- `user_department_scopes.department_id`

## 權限設計

目前先把報表分權限需要的資料結構放好，登入流程之後再接：

- `ADMIN`、`EXECUTIVE`：可看全部部門。
- `MANAGER`：透過 `user_department_scopes` 指定可看的部門，預設可包含子部門。
- `EMPLOYEE`：預設只能看自己所屬部門或後續 API 再限制成只看個人資料。

`app/permissions.py` 提供 `get_visible_department_ids()`，之後報表查詢可以用它取得使用者可看的部門清單；回傳 `None` 代表可看全部部門。

## Kafka consumer 行為

Reporting API 啟動時會：

1. 執行 Alembic migrations，讓 PostgreSQL schema 升到最新版。
2. 啟動背景 Kafka consumer 讀取 `KAFKA_ACCESS_EVENTS_TOPIC`。
3. 啟動背景 Redis Stream recovery consumer 讀取 `REDIS_EVENT_STREAM_KEY`。
4. 將 Go Access API 發出的 event 寫入 `access_events`。
5. 更新 `employees.last_known_state` 與 `employees.last_seen_at`。
6. Kafka DB commit 成功後才 commit Kafka offset；Redis DB commit 成功後才 `XACK`。

若 Kafka、Redis 或 DB 暫時不可用，consumer 會在背景重試，不會讓 FastAPI process 直接退出。Kafka 與 Redis recovery 可能讀到同一筆 event；DB 使用 `request_id` 去重，所以不會重複寫入。

## API 端點

健康檢查與 consumer 狀態：

```bash
curl http://127.0.0.1:8000/api/health/
```

即時彙總：

```bash
curl http://127.0.0.1:8000/api/reports/access/summary
```

最近刷卡事件：

```bash
curl 'http://127.0.0.1:8000/api/reports/access/events?limit=20'
```

## DB migration

Reporting API image 會包含 `alembic.ini` 與 `migrations/`，容器啟動時會自動套用 migration。若要手動執行：

```bash
docker-compose exec reporting-api alembic upgrade head
```

新增 schema 變更時，請新增 Alembic revision，不要再用 `Base.metadata.create_all()` 當正式 schema 管理方式。

## Demo 前清空資料

如果希望每次 demo 都只看到新資料，可以從專案根目錄執行：

```bash
./scripts/reset-reporting-db.sh --yes
```

這會清空 `access_events`、`user_department_scopes`、`user_accounts`、`employees`、`departments`，但不會刪除 PostgreSQL volume，也不會動 Kafka 或 Redis。

## 專案結構

```text
reporting-api/
├── app/
│   ├── main.py              # FastAPI app 入口
│   ├── config.py            # 環境變數與連線設定
│   ├── database.py          # SQLAlchemy engine/session 骨架
│   ├── models.py            # PostgreSQL schema
│   ├── permissions.py       # 報表權限與部門階層查詢工具
│   ├── repositories.py      # Kafka event parsing / DB writes / report reads
│   ├── routers/
│   │   ├── health.py        # 健康檢查
│   │   └── reports.py       # 報表查詢 API
│   └── consumers/
│       ├── access_events.py # Kafka -> PostgreSQL consumer
│       ├── redis_recovery.py # Redis Stream -> PostgreSQL recovery consumer
│       └── README.md
├── .env.example
├── alembic.ini
├── migrations/              # Alembic migration scripts
├── requirements.txt
└── README.md
```

## 後續分工

後續可以從這幾個方向接著做：

- 匯入正式員工、部門、主管階層資料。
- 補 CEO/CFO/manager 角色權限。
- 增加部門、日期區間、異常事件等報表 API。
