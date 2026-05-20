#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ASSUME_YES=false

usage() {
  cat <<'USAGE'
用法：
  ./scripts/reset-reporting-db.sh [--yes]

用途：
  清空 Reporting API demo 資料，讓下一次 demo 只顯示新產生的刷卡事件。

會清空：
  - access_events
  - user_department_scopes
  - user_accounts
  - employees
  - departments
  - Redis Stream access:events
  - Redis event dedupe keys

選項：
  --yes      不詢問確認，直接清空
  -h, --help 顯示說明
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --yes|-y)
      ASSUME_YES=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "未知參數：$1" >&2
      usage
      exit 2
      ;;
  esac
done

cd "$ROOT_DIR"

if [[ "$ASSUME_YES" != true ]]; then
  echo "這會清空 PostgreSQL demo 資料與 Redis recovery buffer。"
  read -r -p "確定要繼續嗎？輸入 yes： " answer
  if [[ "$answer" != "yes" ]]; then
    echo "已取消。"
    exit 0
  fi
fi

docker-compose exec -T db psql -U root -d access_control <<'SQL'
TRUNCATE TABLE access_events, user_department_scopes, user_accounts, employees, departments RESTART IDENTITY CASCADE;
SQL

docker-compose exec -T redis sh -c '
export REDISCLI_AUTH="$REDIS_PASSWORD"
redis-cli DEL access:events >/dev/null
redis-cli --scan --pattern "access:event-buffered:*" |
while IFS= read -r key; do
  [ -n "$key" ] && redis-cli DEL "$key" >/dev/null
done
'

echo "Reporting demo database reset complete."
