# Consumers

這個資料夾放 Reporting API 的背景 consumer。

目前 Access API 會把事件送到 Kafka topic：

```text
access-events
```

`access_events.py` 會在 FastAPI startup 時啟動，讀取 Kafka `access-events`，把刷卡事件寫入 PostgreSQL 的 `access_events`，並更新 `employees.last_known_state`。

`redis_recovery.py` 會讀 Redis Stream `access:events`，用來補回 Kafka 或 Reporting API 中斷期間沒有進 DB 的資料。

兩個 consumer 都使用 `requestId` 去重；如果 Kafka 和 Redis 讀到同一筆 event，DB 不會重複插入。
