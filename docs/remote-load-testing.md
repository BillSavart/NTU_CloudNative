# 從外部機器安全執行 k6（remote load testing）

在 VM 上跑 k6 會跟被測服務搶同一顆 4 vCPU，量出來的 max QPS 會被低估。這份文件說明
怎麼**從你自己的筆電**（原生 k6）對 prod VM 跑壓測，並把指標送進**現有的 VM Grafana**，
全程**不對公網開任何 port**。

入口腳本：[`scripts/k6_remote.sh`](../scripts/k6_remote.sh)（在筆電上跑）。

## 它為什麼是安全的

prod 的 `access-lb`(8080) 與 `prometheus`(9090) 都只綁在 VM 的 `127.0.0.1`，外網本來就進不來。
runner 會開兩條 **SSH local-forward tunnel**，流量全程走加密的 SSH，**不需要動 firewall、
不需要把任何服務暴露到公網**：

```
筆電 k6  --(tunnel A)-->  localhost:18080 -> VM 127.0.0.1:8080  (access-lb，負載)
筆電 k6  --(tunnel B)-->  localhost:19090 -> VM 127.0.0.1:9090  (Prometheus，remote-write)
```

k6 打 `http://localhost:18080/api/access/swipe`，並把自己的指標 remote-write 到
`http://localhost:19090/api/v1/write`（native histogram，與 VM 內 k6 設定一致），
所以 Grafana 既有的「k6 Requests/sec / p95 Latency / Quality」三個 panel 會直接亮。

## 前置需求

- 筆電已安裝原生 k6：`brew install k6`
- 對 VM 的 SSH 權限
- 本機有這個 repo（k6 腳本從本地讀）

## 設定（環境變數）

| 變數 | 必填 | 說明 |
|---|---|---|
| `VM_HOST` | ✅ | VM 的 SSH host / IP |
| `VM_USER` | ✅ | VM 的 SSH 使用者 |
| `DEPLOY_PATH` | ✅ | repo 在 VM 上的路徑（chaos 需要對它下 docker compose） |
| `VM_SSH_KEY` |  | SSH 私鑰路徑（預設用 agent / 預設金鑰） |
| `LOCAL_ACCESS_PORT` |  | 本機負載埠，預設 `18080` |
| `LOCAL_PROM_PORT` |  | 本機 remote-write 埠，預設 `19090` |

```bash
export VM_HOST=YOUR.VM.IP
export VM_USER=ubuntu
export DEPLOY_PATH=/opt/ntu_cloudnative   # VM 上 repo 路徑
export VM_SSH_KEY=~/.ssh/your_key          # 視情況
```

## 三種測試

### 測試 1：固定 500 QPS / 5 分鐘

```bash
./scripts/k6_remote.sh constant
# 調整：RATE=800 DURATION=3m ./scripts/k6_remote.sh constant
```

只打 access swipe。跑完看 k6 summary 的 `http_req_duration`（p95/p99）與 `http_reqs .../s`，
Grafana 用 `testid=access-constant-500` 篩該時間窗即可看 latency 曲線。跑完會**自動清掉**這次
寫進 prod 的測試 access events（同 prefix），避免污染 demo dashboard；要保留資料（例如反覆調 QPS）
可加 `K6_CLEANUP=false`。

> 注意：HTTPS 模式（`ENABLE_HTTPS=true`）下 Prometheus 不對 VM host 開 port，runner 會自動
> 改用 prometheus 容器 IP 做 remote-write tunnel，無需手動處理。

### 測試 2：階梯 ramp-up 找 max QPS

```bash
./scripts/k6_remote.sh rampup
# 調整：START_RATE=200 STEP=300 STEP_DURATION=30s MAX_RATE=5000 ./scripts/k6_remote.sh rampup
```

用 `ramping-arrival-rate` 把目標速率一階一階往上加。**max QPS = Grafana「k6 Requests/sec」
曲線打平、同時 p95 翹起、Quality 的 failed ratio 開始 >0 的那一點**。如果到 `MAX_RATE` 還沒
打平，就把 `MAX_RATE` 加大再跑一輪。

> 壓的時候同時看「Access API Runtime Load」(goroutine/heap)、VM CPU、以及 access-api 的
> Kafka publisher queue depth — queue 塞滿（`PUBLISHER_QUEUE_SIZE=100000`）也是一種上限。

### 測試 3：Chaos — 斷 DB + Kafka，驗證 Redis 撐決策 + 恢復回寫

```bash
./scripts/k6_remote.sh chaos
# 調整：RATE=80 CHAOS_OUTAGE=60 CHAOS_SETTLE=45 ./scripts/k6_remote.sh chaos
```

流程（runner 全自動）：

1. 開始穩定刷卡（預設 50/s，3 分鐘）。
2. `CHAOS_START_DELAY`（預設 40s）後，透過 SSH 在 VM 上 `stop db kafka-1 kafka-2 kafka-3`
   （**Redis / sentinel 不動**）。
3. 斷線 `CHAOS_OUTAGE`（預設 45s）。這段期間 access-api 仍靠 Redis 做 anti-passback 決策，
   每筆事件寫進 Redis recovery stream（`eventBuffered=true`、`kafkaQueued=false`）。
4. 恢復服務、等 reporting-api healthy，再等 `CHAOS_SETTLE`（預設 30s）讓 recovery consumer
   把 Redis stream 補進 Postgres。
5. **自動驗證**：比對「k6 統計的 buffered 筆數」vs「Postgres `access_events` 實際筆數」，
   印出 `PASS`（persisted ≥ buffered）或 `REVIEW`。
6. 清掉本次 prefix 的測試資料。

**期間 Grafana 的 k6 failed/checks、Event Pipeline、consumer processed/sec 會抖動是預期的**；
重點是恢復後 pipeline 補齊、`access_events` 數量對得上。

#### 為什麼斷線期間不會掉資料

事件緩衝在 Redis stream `access:events`，上限 `EVENT_STREAM_MAXLEN=1,000,000`
（[access-api/config.go:46](../access-api/config.go:46)）。以預設 50/s 計，要 ~5.5 小時才會碰到上限，
所以一般幾十秒~幾分鐘的斷線完全在安全範圍。只有在「非常高速率 × 非常長斷線」時才需要把速率
調低或注意這個上限。

## 成本

GCP **ingress（打進 VM）免費**，只有 **egress（response 回傳）** 計費，約 `$0.12/GB`。
swipe response 約 200 bytes，就算 2000 req/s 跑 5 分鐘也只有 ~120 MB ≈ 幾分美金。
**流量成本可忽略**；真正花錢的是 VM 開機時數，跟壓測無關。

## 疑難排解

- **tunnel did not become ready**：確認 VM 的 stack 有起（`access-lb`、`prometheus` 在跑）、
  SSH 能連、`DEPLOY_PATH` 正確。
- **Grafana 沒資料**：把時間範圍框到壓測那段；`testid` 變數選對應值或 `All`。
- **chaos 顯示 REVIEW（persisted < buffered）**：加大 `CHAOS_SETTLE` 再跑，或檢查 reporting-api
  的 redis recovery consumer log。
- runner 結束（含中途 Ctrl-C）都會自動還原 VM 服務並關閉 tunnel。
