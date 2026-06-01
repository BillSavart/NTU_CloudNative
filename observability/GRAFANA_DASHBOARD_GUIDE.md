# Grafana Dashboard 重點指標說明

這份文件說明 `Access Control Observability` dashboard 中保留的重點線條。Dashboard 的設計目標不是列出所有 metrics，而是讓 demo 時能快速判斷：

- shift change 刷卡尖峰是否真的進入系統
- Access API、Kafka、Reporting API 的事件管線是否順暢
- 刷卡與報表查詢是否維持可接受延遲
- 登入活動是否正常
- 壓測期間是否有錯誤或品質下降
- API runtime / memory 是否有異常累積

多個 Access API / Reporting API instance 會產生多條 Prometheus time series。為了 demo 清楚，dashboard 會用 `sum(...)` 彙總成單一服務視角，避免同名線重複出現。


## 為什麼一開始會看到很多同名線

Prometheus 抓 metrics 時，不是只看指標名稱，還會保留每個指標上的 labels。例如同樣叫 `access_api_swipes_total`，如果 Access API 有多個 container / replica，Prometheus 其實會看到多筆 time series：

```text
access_api_swipes_total{instance="access-api-1:8080", job="access-api"}
access_api_swipes_total{instance="access-api-2:8080", job="access-api"}
access_api_swipes_total{instance="access-api-3:8080", job="access-api"}
```

如果 Grafana 的 legend 只寫 `Access swipes/sec`，但 Prometheus 回傳三筆 series，畫面上就會出現三條同名線。這不是資料錯誤，而是「同一個服務有多個 instance」造成的正常現象。

這次修正的原因是：demo dashboard 的目標是看整體系統狀態，不是逐台 container debug。因此像 Traffic、Failures、Memory、Runtime 這類服務層級指標，使用 `sum(...)` 彙總成一條線會更容易判讀。

修正前比較像 instance-level view：

```promql
rate(access_api_swipes_total[1m])
```

修正後改成 service-level view：

```promql
sum(rate(access_api_swipes_total[1m]))
```

這樣 `Access swipes/sec` 就代表整個 Access API 服務每秒刷卡量，而不是每個 replica 各畫一條線。

什麼時候才需要拆開 instance 看？通常是 debug 特定 container 問題時，例如某一台 Access API latency 特別高、memory 特別大、或某個 instance 沒有接到流量。demo 和 requirement 說明階段，使用彙總線比較適合。
## 1. Traffic

### Access swipes/sec

PromQL:

```promql
sum(rate(access_api_swipes_total[1m])) or vector(0)
```

意義：整個 Access API 服務每秒處理多少刷卡 request。

判讀方式：

- shift change 或刷卡壓測時，這條線應明顯上升。
- 若有送刷卡流量但沒有上升，代表流量沒有打到 Access API，或 Prometheus 沒有成功 scrape Access API。
- 若這條線上升但後面的 Kafka / Reporting 線沒有跟著動，代表問題可能在事件發布或消費管線。

選擇原因：這是最直接的 user activity，也是題目要求觀察 shift change spike 的核心指標。

### Reporting requests/sec

PromQL:

```promql
sum(rate(reporting_api_http_requests_total[1m])) or vector(0)
```

意義：整個 Reporting API 每秒收到多少 HTTP request。

判讀方式：

- 開首頁、報表中心、查詢出勤資料、登入等都會讓這條線上升。
- 若刷卡流量很高但 Reporting requests/sec 沒上升，表示目前壓力集中在刷卡入口，不是在報表查詢。
- 若 Reporting requests/sec 上升時 p95 latency 也上升，代表報表讀取路徑開始承壓。

選擇原因：Reporting 是題目指定的報表讀取路徑，這條線可以說明報表服務是否正在被使用。

## 2. Event Pipeline

這個 panel 只保留三條，分別對應事件管線的三個位置：Access API 內部佇列、Kafka topic、Reporting API consumer。

### Access event backlog

PromQL:

```promql
sum(access_api_event_queue_depth) or vector(0)
```

意義：所有 Access API instance 目前等待發布的事件總數。

判讀方式：

- 正常情況應接近 0。
- 尖峰時可以短暫上升，但應該很快回落。
- 若持續上升，表示 Access API 接得住刷卡 request，但事件發布到 Kafka 的速度跟不上。

選擇原因：這條線可以快速判斷事件是否卡在 Access API 內部。

### Kafka events appended/sec

PromQL:

```promql
clamp_min(sum(delta(kafka_topic_partition_current_offset{topic="access-events"}[1m])) / 60, 0)
```

意義：Kafka `access-events` topic 每秒新增多少事件。

判讀方式：

- 刷卡流量上升後，這條線應跟著上升。
- 若 Access swipes/sec 上升但 Kafka events appended/sec 沒動，可能是 Kafka topic、broker、publisher 或 exporter 有問題。
- 若 Kafka events appended/sec 上升但 Reporting consumed/sec 不上升，問題可能在 Reporting API consumer。

選擇原因：Kafka 是 Access API 和 Reporting API 之間的事件緩衝層，這條線證明事件真的進入管線。

### Reporting consumed/sec

PromQL:

```promql
sum(rate(reporting_api_consumer_processed_total[1m])) or vector(0)
```

意義：Reporting API consumer 每秒處理多少事件。

判讀方式：

- Kafka events appended/sec 上升後，這條線也應跟著上升。
- 若長時間為 0，代表 consumer 可能沒有啟動、連不上 Kafka / Redis recovery，或處理流程卡住。
- 若它明顯低於 Kafka events appended/sec，可能代表 Reporting API 消費速度跟不上。

選擇原因：這條線確認事件不是只進 Kafka，而是真的被 Reporting API 拿去處理。

## 3. Failures

### Access publish failures/sec

PromQL:

```promql
sum(rate(access_api_events_failed_total[1m])) or vector(0)
```

意義：Access API 發布事件失敗的速率。

判讀方式：

- 正常應維持 0。
- 若尖峰時上升，表示 publisher、Kafka 或 fallback 流程可能出問題。
- 若同時 Access event backlog 上升，代表事件可能正在堆積或重試。

選擇原因：刷卡 request 即使成功回應，事件仍必須可靠送到後端；這條線是 resilience 的關鍵失敗訊號。

### Reporting consumer failures/sec

PromQL:

```promql
sum(rate(reporting_api_consumer_failed_total[1m])) or vector(0)
```

意義：Reporting API consumer 處理事件失敗的速率。

判讀方式：

- 正常應維持 0。
- 若上升，可能是資料格式錯誤、DB 寫入失敗、consumer 處理邏輯異常。
- 若 Kafka events appended/sec 正常但 consumer failures/sec 上升，代表事件進得來，但報表端處理失敗。

選擇原因：這條線補足事件管線後半段的可靠性觀測。

## 4. API p95 Latency

p95 表示觀察時間窗內 95% request 都比該線顯示的時間更快。它比平均值更適合判斷大多數使用者的體感延遲。

### Access swipe p95

PromQL:

```promql
histogram_quantile(0.95, sum(rate(access_api_swipe_latency_seconds_bucket[5m])) by (le))
```

意義：Access API 刷卡決策流程的 p95 延遲。

判讀方式：

- shift change 壓測時最重要。
- 若 Access swipes/sec 上升後這條線也大幅上升，代表刷卡入口開始承壓。
- 若 k6 的 `p95 access_swipe` 高，但這條線低，可能是網路、frontend/proxy 或壓測端造成的外部延遲。

選擇原因：Access API 是開門/刷卡入口，服務本身需要有內部 latency 指標。

### Reporting p95 /api/reports/dashboard

PromQL:

```promql
histogram_quantile(0.95, sum(rate(reporting_api_http_request_duration_seconds_bucket{path=~"/api/reports/dashboard|/api/reports/report-center"}[5m])) by (le, path))
```

意義：首頁總覽資料 API 的 p95 延遲。

判讀方式：

- 使用者登入後看首頁總覽時，這條線會反映主要體感速度。
- 若 Reporting requests/sec 上升時這條線也上升，代表總覽查詢開始變慢。

選擇原因：首頁總覽是最容易被使用者看到的 Reporting read path。

### Reporting p95 /api/reports/report-center

意義：報表中心主要資料 API 的 p95 延遲。

判讀方式：

- 產生或預覽報表時，這條線反映報表資料查詢速度。
- 題目要求 sub-200ms reports 時，可以用這條線觀察是否接近或超過門檻。

選擇原因：這是最貼近 Reporting requirement 的核心報表查詢路徑。

## 5. Access Decision Ratio

### Denied ratio

PromQL:

```promql
(sum(rate(access_api_swipes_denied_total[5m])) or vector(0)) / clamp_min((sum(rate(access_api_swipes_total[5m])) or vector(0)), 1)
```

意義：刷卡 request 中被拒絕的比例。

判讀方式：

- 正常 demo 中可能維持低比例。
- 若突然升高，可能是測試資料、進出狀態、權限規則或異常刷卡行為造成。

選擇原因：只看 request 數不夠，還要知道刷卡結果是否健康。

## 6. k6 Requests/sec

這裡只保留三種 endpoint：`access_swipe`、`reporting_report_center`、`frontend_proxy_dashboard`。

### access_swipe
意義：k6 壓測送到刷卡 API 的 request rate。可對照 `Access swipes/sec`。

### reporting_report_center
意義：k6 壓測報表中心查詢的 request rate。可對照 `Reporting p95 /api/reports/report-center`。

### frontend_proxy_dashboard
意義：k6 經由 frontend proxy 查 dashboard API 的 request rate，比較接近真實使用者從前端進入系統的路徑。

選擇原因：三條線剛好代表寫入流量、報表讀取流量、前端入口流量。

## 7. k6 p95 Latency

### p95 access_swipe
意義：k6 從外部觀察到的刷卡 API p95 延遲。

### p95 reporting_report_center
意義：k6 從外部觀察到的報表中心 API p95 延遲。

### p95 frontend_proxy_dashboard
意義：k6 從 frontend proxy 觀察到的 dashboard API p95 延遲。

選擇原因：k6 是外部使用者視角，API p95 panel 是服務內部視角。兩者一起看，可以分辨問題在 API 本身還是入口路徑。

## 8. k6 Quality

### HTTP failed ratio
意義：k6 request 失敗比例。正常應接近 0。

### Check pass ratio
意義：k6 script 中檢查條件通過的比例。正常應接近 1。

選擇原因：壓測不能只看快不快，也要看結果是否正確。

## 9. Login Activity

### Login success/sec
意義：每秒成功登入數，可對應題目提到的 user login activity。

### Login failed/sec
意義：每秒登入失敗數，包括錯帳密、未授權或服務端錯誤。

選擇原因：比拆成每個 HTTP status 更容易 demo，也更符合「登入活動」的判讀方式。

## 10. Reporting API Memory Usage

### Reporting memory in use

PromQL:

```promql
sum(process_resident_memory_bytes{job="reporting-api"}) or vector(0)
```

意義：所有 Reporting API instance 實際使用中的記憶體總量。

判讀方式：大量報表查詢時可能上升；若停止流量後仍持續上升，可能要懷疑 memory leak 或 cache 過度累積。

選擇原因：Reporting API 需要查詢與整理報表資料，記憶體是很直覺的資源健康指標。

## 11. Access API Runtime Load

### Access goroutines

PromQL:

```promql
sum(access_api_runtime_goroutines) or vector(0)
```

意義：所有 Access API instance 的 goroutine 總量。

判讀方式：尖峰時可短暫上升；若流量停止後仍不下降，可能有 goroutine leak 或背景工作卡住。

### Access heap alloc MiB

PromQL:

```promql
sum(access_api_runtime_alloc_bytes) / 1048576
```

意義：所有 Access API instance 目前配置中的 heap 記憶體總量。

判讀方式：壓測時可能波動；若與 request rate 同步上升後能回落，通常正常，若持續累積就要注意。

選擇原因：goroutines 看併發/背景工作壓力，heap alloc 看記憶體壓力，兩者觀察面向不同。

## Demo 建議判讀順序

1. 看 `Access swipes/sec` 是否出現 shift change spike。
2. 看 `Kafka events appended/sec` 和 `Reporting consumed/sec` 是否跟上。
3. 看 `Access event backlog` 是否只是短暫上升後回落。
4. 看 `Access publish failures/sec` 與 `Reporting consumer failures/sec` 是否維持 0。
5. 看 `Access swipe p95` 與 `Reporting p95 /api/reports/report-center` 是否仍可接受。
6. 若有跑 k6，看 `HTTP failed ratio` 是否接近 0、`Check pass ratio` 是否接近 1。
7. 用 `Login success/sec` / `Login failed/sec` 補充 user login activity。