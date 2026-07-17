#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_DIR"

if [ ! -f "gateway.pid" ]; then
  echo "⚠️  Gateway not running (no PID file)"
  exit 0
fi

PID=$(cat gateway.pid)

if ! kill -0 "$PID" 2>/dev/null; then
  echo "⚠️  Gateway not running (stale PID file)"
  rm -f gateway.pid
  exit 0
fi

echo "🛑 Stopping AI Proxy Gateway (PID $PID)..."
kill -TERM "$PID"

# Wait for graceful shutdown
for i in {1..10}; do
  if ! kill -0 "$PID" 2>/dev/null; then
    rm -f gateway.pid
    echo "✅ Gateway stopped"
    exit 0
  fi
  sleep 1
done

# Force kill if still running
echo "⚠️  Force killing..."
kill -9 "$PID" 2>/dev/null || true
rm -f gateway.pid
echo "✅ Gateway stopped (forced)"