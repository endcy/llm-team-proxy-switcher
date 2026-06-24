#!/bin/bash

echo ""
echo "  ╔════════════════════════════════════════════════════════╗"
echo "  ║   llm-team-proxy-switcher - One-click Start           ║"
echo "  ╚════════════════════════════════════════════════════════╝"
echo ""

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# ─── Check Node.js ────────────────────────────────────────────
if ! command -v node &> /dev/null; then
    echo "  [ERROR] Node.js not found. Please install Node.js first."
    echo "  Download: https://nodejs.org/"
    echo ""
    exit 1
fi

echo "  Node.js: $(node -v)"
echo ""

# ── Check config.json ─────────────────────────────────────────
if [ ! -f "$SCRIPT_DIR/config.json" ]; then
    echo "  [WARN] config.json not found, creating default..."
    cat > "$SCRIPT_DIR/config.json" << 'EOF'
{
  "port": 9982,
  "bind": "0.0.0.0",
  "upstream": "",
  "providers": []
}
EOF
    echo "  [INFO] Default config.json created. Please edit it before use."
    echo ""
fi

# ─── PID / Log paths ───────────────────────────────────────────
PID_FILE="$SCRIPT_DIR/llm-proxy.pid"
LOG_DIR="$SCRIPT_DIR/log"
LOG_FILE="$LOG_DIR/llm-proxy.log"

PORT=$(grep -oE '"port"[[:space:]]*:[[:space:]]*[0-9]+' "$SCRIPT_DIR/config.json" 2>/dev/null | grep -oE '[0-9]+' | head -1)
PORT=${PORT:-9982}

stop_proxy() {
    local stopped=0

    # 1. Try PID file first
    if [ -f "$PID_FILE" ]; then
        PID=$(cat "$PID_FILE")
        if kill -0 "$PID" 2>/dev/null; then
            kill "$PID"
            sleep 1
            kill -0 "$PID" 2>/dev/null && kill -9 "$PID" 2>/dev/null
            echo "  [OK] Proxy stopped via PID file (PID $PID)."
            stopped=1
        fi
        rm -f "$PID_FILE"
    fi

    # 2. Fallback: find by port (covers manual nohup start)
    if [ "$stopped" -eq 0 ] && command -v lsof &>/dev/null; then
        PIDS=$(lsof -ti :"$PORT" 2>/dev/null)
        if [ -n "$PIDS" ]; then
            for P in $PIDS; do
                kill "$P" 2>/dev/null
                sleep 1
                kill -0 "$P" 2>/dev/null && kill -9 "$P" 2>/dev/null
                echo "  [OK] Proxy stopped via port :$PORT (PID $P)."
                stopped=1
            done
        fi
    fi

    if [ "$stopped" -eq 0 ]; then
        echo "  [INFO] No running proxy found."
    fi
}

# ─── Stop command ──────────────────────────────────────────────
if [ "$1" = "--stop" ] || [ "$1" = "-s" ]; then
    stop_proxy
    echo ""
    exit 0
fi

# ─── Restart command ───────────────────────────────────────────
if [ "$1" = "--restart" ] || [ "$1" = "-r" ]; then
    stop_proxy
    echo "  Restarting in background..."
    "$0" -d
    exit 0
fi

# ── Background mode? ──────────────────────────────────────────
BACKGROUND=false
if [ "$1" = "-d" ] || [ "$1" = "--daemon" ]; then
    BACKGROUND=true
fi

# ─── Stop if already running ───────────────────────────────────
if [ -f "$PID_FILE" ]; then
    OLD_PID=$(cat "$PID_FILE")
    if kill -0 "$OLD_PID" 2>/dev/null; then
        echo "  [INFO] Proxy already running (PID $OLD_PID)."
        echo "  Stop it first: ./start.sh --stop"
        echo ""
        exit 0
    else
        rm -f "$PID_FILE"
    fi
fi

# ─── Start ─────────────────────────────────────────────────────
if [ "$BACKGROUND" = true ]; then
    mkdir -p "$LOG_DIR"
    cd "$SCRIPT_DIR"
    nohup node proxy.js > "$LOG_FILE" 2>&1 &
    NEW_PID=$!
    echo "$NEW_PID" > "$PID_FILE"
    echo "  [OK] Proxy started in background (PID $NEW_PID)."
    echo "  Log:   $LOG_FILE"
    echo "  Stop:  ./start.sh --stop"
    echo "  View:  tail -f $LOG_FILE"
    echo ""
else
    cd "$SCRIPT_DIR"
    node proxy.js
    echo ""
    echo "  [INFO] Proxy stopped."
fi
