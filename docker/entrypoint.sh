#!/bin/sh
set -eu

export NODE_ENV="${NODE_ENV:-production}"
export API_PORT="${API_PORT:-3000}"
export DATABASE_PATH="${DATABASE_PATH:-/data/db/omnidrop.sqlite}"
export TMP_DIR="${TMP_DIR:-/data/tmp}"
export ARTIFACTS_DIR="${ARTIFACTS_DIR:-/data/artifacts}"
export RCLONE_PATH="${RCLONE_PATH:-rclone}"

mkdir -p /data/db /data/tmp /data/artifacts

echo "[omnidrop] starting API..."
node /app/apps/api/dist/index.js &
API_PID=$!

echo "[omnidrop] starting Worker..."
node /app/apps/worker/dist/index.js &
WORKER_PID=$!

# Wait for API health before nginx (best-effort)
i=0
until curl -fsS "http://127.0.0.1:${API_PORT}/api/v1/health" >/dev/null 2>&1; do
  i=$((i + 1))
  if [ "$i" -gt 60 ]; then
    echo "[omnidrop] API health check timed out" >&2
    break
  fi
  sleep 0.5
done

echo "[omnidrop] starting nginx..."
nginx -g "daemon off;" &
NGINX_PID=$!

term() {
  echo "[omnidrop] shutting down..."
  kill -TERM "$NGINX_PID" 2>/dev/null || true
  kill -TERM "$API_PID" 2>/dev/null || true
  kill -TERM "$WORKER_PID" 2>/dev/null || true
  wait "$API_PID" 2>/dev/null || true
  wait "$WORKER_PID" 2>/dev/null || true
  wait "$NGINX_PID" 2>/dev/null || true
  exit 0
}
trap term INT TERM

# Exit if any critical process dies
while true; do
  if ! kill -0 "$API_PID" 2>/dev/null; then
    echo "[omnidrop] API exited" >&2
    term
    exit 1
  fi
  if ! kill -0 "$WORKER_PID" 2>/dev/null; then
    echo "[omnidrop] Worker exited" >&2
    term
    exit 1
  fi
  if ! kill -0 "$NGINX_PID" 2>/dev/null; then
    echo "[omnidrop] nginx exited" >&2
    term
    exit 1
  fi
  sleep 2
done
