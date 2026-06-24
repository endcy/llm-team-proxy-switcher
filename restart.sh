#!/bin/bash
# One-click restart script for llm-team-proxy-switcher
# Stops any running proxy (via PID file or by port), then starts in background.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo ""
echo "  ╔════════════════════════════════════════════════════════╗"
echo "  ║   llm-team-proxy-switcher - Restart                    ║"
echo "  ╚════════════════════════════════════════════════════════╝"
echo ""

# Stop existing proxy (no error if not running)
./start.sh --stop

# Start in background
./start.sh -d
