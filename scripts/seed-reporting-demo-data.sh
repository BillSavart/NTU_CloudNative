#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$ROOT_DIR"
exec_args=(exec -T)
for env_name in \
  DEMO_BASIC_EMPLOYEE_ID \
  DEMO_RECOVERY_EMPLOYEE_ID \
  DEMO_LOAD_EMPLOYEE_PREFIX \
  DEMO_LOAD_EMPLOYEES
do
  if [[ -n "${!env_name:-}" ]]; then
    exec_args+=(-e "$env_name=${!env_name}")
  fi
done

docker-compose "${exec_args[@]}" reporting-api python -m app.seed

cat <<'EOF'
Demo users:
  admin / demo123
  executive / demo123
  manager / demo123
  employee / demo123
EOF
