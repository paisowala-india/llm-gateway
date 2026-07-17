#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_DIR"

# Check if already running
if [ -f "gateway.pid" ]; then
  PID=$(cat gateway.pid)
  if kill -0 "$PID" 2>/dev/null; then
    echo "⚠️  Gateway already running (PID $PID)"
    echo "   Run: ./scripts/stop.sh"
    exit 1
  else
    rm -f gateway.pid
  fi
fi

echo "🚀 Starting LLM Gateway..."

# Check for API key env vars
if [ -z "$OPENAI_API_KEY" ] && [ -z "$ZAI_API_KEY" ] && [ -z "$ANTHROPIC_API_KEY" ]; then
  # OK if using a provider that doesn't need these
  echo "⚠️  Warning: No API key environment variables set"
  echo "   Set one of: OPENAI_API_KEY, ZAI_API_KEY, ANTHROPIC_API_KEY"
fi

node server.js &
GATEWAY_PID=$!
echo "$GATEWAY_PID" > gateway.pid

sleep 2

if kill -0 "$GATEWAY_PID" 2>/dev/null; then
  echo "✅ LLM Gateway started (PID $GATEWAY_PID)"
  echo "   URL: http://127.0.0.1:8888"
  echo "   Status: curl http://127.0.0.1:8888/gateway-status"
  echo ""
  echo "To stop: ./scripts/stop.sh"
else
  echo "❌ Failed to start"
  rm -f gateway.pid
  exit 1
fi