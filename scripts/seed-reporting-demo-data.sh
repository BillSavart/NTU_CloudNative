#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$ROOT_DIR"
docker-compose exec -T reporting-api python -m app.seed

cat <<'EOF'
Demo users:
  admin / demo123
  executive / demo123
  manager / demo123
  employee / demo123
EOF
