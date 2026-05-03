# Consumers

這個資料夾預留給後續組員實作 Kafka consumer。

目前 Access API 會把事件送到 Kafka topic：

```text
access-events
```

後續可在這裡新增 consumer，將 Kafka event 寫入 PostgreSQL。此階段刻意不實作，避免和 reporting 分工重疊。
