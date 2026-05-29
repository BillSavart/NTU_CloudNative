#!/usr/bin/env bash
# Patch fake data (extra denied / executive events) into the RUNNING prod stack.
# Prod counterpart of scripts/patch_fake_data.sh — execs into the live
# reporting-api container instead of building a base-compose stack.
#
# Run after scripts/fake_data_prod.sh.
#   PATCH_DENIED_EVENTS=12000 ./scripts/patch_data_prod.sh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
# shellcheck source=scripts/lib-compose.sh
. scripts/lib-compose.sh

echo "Patching fake data in PostgreSQL..."
"${COMPOSE[@]}" exec -T \
  -e PATCH_DENIED_EVENTS="${PATCH_DENIED_EVENTS:-12000}" \
  reporting-api python -m app.patch_fake_data

echo "Fake data patch completed."
