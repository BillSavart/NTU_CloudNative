#!/usr/bin/env bash
# Start/stop the live swipe generator on the running prod stack (GCP VM).
#
#   ./scripts/live_swipes_prod.sh           # start (background, survives reboot)
#   ./scripts/live_swipes_prod.sh stop      # stop & remove it
#   LIVE_SWIPES_PER_MIN=120 ./scripts/live_swipes_prod.sh   # faster
#
# It POSTs real swipes to the Access API so the dashboards show continuous
# entering/leaving during a demo. Needs seed + fake data already loaded.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
# shellcheck source=scripts/lib-compose.sh
. scripts/lib-compose.sh

case "${1:-start}" in
  start)
    echo "==> Starting live swipe generator (${LIVE_SWIPES_PER_MIN:-60}/min)"
    "${COMPOSE[@]}" --profile live up -d live-swiper
    echo "==> Tail logs with: docker compose <files> logs -f live-swiper"
    ;;
  stop)
    echo "==> Stopping live swipe generator"
    "${COMPOSE[@]}" --profile live rm -sf live-swiper
    ;;
  *)
    echo "usage: $0 [start|stop]" >&2
    exit 2
    ;;
esac
