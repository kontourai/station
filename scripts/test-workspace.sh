#!/usr/bin/env bash
# Start server + UI on alternate ports for testing, then clean up on exit.
# Usage: ./scripts/test-workspace.sh
set -euo pipefail

PORT_SERVER=3142
PORT_UI=5174
PIDS=()

cleanup() {
  echo ""
  echo "Shutting down..."
  for pid in "${PIDS[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null
  echo "Done."
}
trap cleanup EXIT INT TERM

echo "=== Starting backend on port $PORT_SERVER ==="
PORT=$PORT_SERVER npm run dev:server > /tmp/station-test-server.log 2>&1 &
PIDS+=($!)

echo "=== Starting UI on port $PORT_UI ==="
VITE_API_BASE=http://localhost:$PORT_SERVER npm run dev:ui -- --port $PORT_UI > /tmp/station-test-ui.log 2>&1 &
PIDS+=($!)

# Wait for both to be ready
echo "Waiting for server..."
for i in $(seq 1 30); do
  if curl -sf http://localhost:$PORT_SERVER/api/agents > /dev/null 2>&1; then
    echo "  Server ready."
    break
  fi
  sleep 1
done

echo "Waiting for UI..."
for i in $(seq 1 30); do
  if curl -sf http://localhost:$PORT_UI > /dev/null 2>&1; then
    echo "  UI ready."
    break
  fi
  sleep 1
done

echo ""
echo "═══════════════════════════════════════════"
echo "  Test instance running"
echo "  UI:     http://localhost:$PORT_UI"
echo "  API:    http://localhost:$PORT_SERVER"
echo "═══════════════════════════════════════════"
echo ""
echo "Press Ctrl+C to stop, or use Playwright:"
echo "  npx playwright test --headed"
echo ""

# Keep alive until interrupted
wait
