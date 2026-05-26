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
- `user_accounts`：登入使用者與角色，角色分為 `EMPLOYEE`、`MANAGER`、`EXECUTIVE`、`ADMIN`；目前 seed/fake data 不再建立 `admin` 帳號。
- `user_department_scopes`：設定使用者可看的部門範圍，可選擇是否包含子部門。
- `access_events`：刷卡事件事實表，使用 `request_id` unique constraint 防止 Kafka 重送造成重複寫入，並提供 nullable `remark` 欄位存放出勤異常備註。

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

前端串接時可以直接看完整 contract：

- [API.md](./API.md)

健康檢查與 consumer 狀態：

```bash
curl http://127.0.0.1:8000/api/health/
```

### Auth

前端現有登入頁可直接使用：

```bash
curl http://127.0.0.1:8000/api/csrf/
curl -X POST http://127.0.0.1:8000/api/login/ \
  -H 'Content-Type: application/json' \
  -d '{"employeeId":"fab_1_manager","password":"demo123"}'
```

也提供較新的 auth path：

```bash
curl -X POST http://127.0.0.1:8000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"employeeId":"fab_1_manager","password":"demo123"}'

curl http://127.0.0.1:8000/api/auth/me
curl -X POST http://127.0.0.1:8000/api/auth/logout
```

Demo users 可用：

```text
executive / demo123
fab_1_manager / demo123
fab_2_manager / demo123
fab_3_manager / demo123
fab_4_manager / demo123
fab_5_manager / demo123
rd_1_manager / demo123
it_1_manager / demo123
pe_1_manager / demo123
ee_1_manager / demo123
employee / demo123
```

建立 22 個 fab、各 fab 的 `RD/IT/PE/EE` 部門、管理者帳號、90,000 名員工與一年出勤歷史：

```bash
./scripts/fake_data.sh
```

Windows PowerShell:

```powershell
.\scripts\fake_data.ps1
```

如果只是要做小規模驗證，可以調低資料量：

```bash
FAKE_EMPLOYEE_COUNT=140 FAKE_OPERATING_DAYS=7 FAKE_ATTENDANCE_EMPLOYEES=50 FAKE_MOVEMENT_PCT=65 FAKE_MAX_MOVES_PER_DAY=3 ./scripts/fake_data.sh
```

```powershell
.\scripts\fake_data.ps1 -EmployeeCount 140 -OperatingDays 7 -AttendanceEmployees 50 -MovementPct 65 -MaxMovesPerDay 3
```

Fake data 規則：

- 每位一般員工的 `manager_employee_id` 只會指到自己部門的小主管，例如 `EE_1` 員工會指到 `ee_1_manager` 的員工編號。
- 小主管會指到所屬 fab 的大主管；fab 大主管會指到 executive。
- 每天第一筆上班與最後一筆下班使用 `gate_{fab}_A`。
- 白天會有一批員工在 `gate_{fab}_B` 到 `gate_{fab}_E` 之間進出，讓多門資料有存在感。
- `FAKE_MOVEMENT_PCT` / `-MovementPct` 可調整每天有日間多門穿梭紀錄的員工比例；`FAKE_MAX_MOVES_PER_DAY` / `-MaxMovesPerDay` 可調整每人每日最多穿梭次數。
- 不會產生 00:00-08:00 的刷卡紀錄；加班資料會在當天 23:59 前刷出，不會變成過夜留廠。

### Reports

即時彙總：

```bash
curl http://127.0.0.1:8000/api/reports/access/summary
```

Dashboard 首頁資料：

```bash
curl 'http://127.0.0.1:8000/api/reports/dashboard?departmentId=fab_1'
```

最近刷卡事件：

```bash
curl 'http://127.0.0.1:8000/api/reports/access/events?departmentId=fab_1&decision=DENIED&limit=20&offset=0'
```

部門樹：

```bash
curl http://127.0.0.1:8000/api/reports/departments/tree
```

部門 summary：

```bash
curl http://127.0.0.1:8000/api/reports/departments/fab_1/summary
```

員工目前狀態：

```bash
curl 'http://127.0.0.1:8000/api/reports/employees/current-state?departmentId=fab_1&state=IN'
```

異常事件與趨勢圖：

```bash
curl 'http://127.0.0.1:8000/api/reports/anomalies?limit=20'
curl http://127.0.0.1:8000/api/reports/timeseries
```

## DB migration

Reporting API image 會包含 `alembic.ini` 與 `migrations/`，容器啟動時會自動套用 migration。若要手動執行：

```bash
docker-compose exec reporting-api alembic upgrade head
```

新增 schema 變更時，請新增 Alembic revision，不要再用 `Base.metadata.create_all()` 當正式 schema 管理方式。

## Setup 與假資料

如果需要啟動完整 Docker Compose stack、套用 migration、清空舊 reporting 資料，並跑不殘留資料的 smoke test：

```bash
./scripts/setup.sh
```

Windows PowerShell:

```powershell
.\scripts\setup.ps1
```

`setup` 會清空 `access_events`、`user_department_scopes`、`user_accounts`、`employees`、`departments`，且不會寫入正式 demo/fake data；需要留下營運感資料時，再執行 `fake_data` 腳本。

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
