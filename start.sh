#!/bin/bash

echo ""
echo "  ╔════════════════════════════════════════════════════════╗"
echo "  ║   llm-team-proxy-switcher - One-click Start           ║"
echo "  ╚════════════════════════════════════════════════════════╝"
echo ""

# Get script directory
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Check Node.js
if ! command -v node &> /dev/null; then
    echo "  [ERROR] Node.js not found. Please install Node.js first."
    echo "  Download: https://nodejs.org/"
    echo ""
    exit 1
fi

# Show Node.js version
echo "  Node.js: $(node -v)"
echo ""

# Check config.json
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

# Start proxy
echo "  Starting proxy..."
echo ""
cd "$SCRIPT_DIR"
node proxy.js

# If proxy exits, show message
echo ""
echo "  [INFO] Proxy stopped."
