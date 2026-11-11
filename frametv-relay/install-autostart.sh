#!/bin/bash
# Makes the FrameTV relay start automatically whenever you log in to this Mac,
# and restart itself if it ever crashes. Safe to run again any time (it just
# reinstalls). Undo with: ./uninstall-autostart.sh
#
# Usage:  cd frametv-relay && ./install-autostart.sh
set -euo pipefail

LABEL="com.lifeos.frametv-relay"
DIR="$(cd "$(dirname "$0")" && pwd)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/frametv-relay.log"
NODE="$(command -v node || true)"

if [ -z "$NODE" ]; then
  echo "Node.js isn't installed. Install it (https://nodejs.org or 'brew install node') and run this again."
  exit 1
fi

cd "$DIR"
npm install --silent

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>$DIR/server.js</string>
  </array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
EOF

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"

sleep 2
if curl -fsS http://localhost:8787/health >/dev/null; then
  echo "✓ FrameTV relay is running and will start automatically at login."
  echo "  Log file: $LOG"
else
  echo "✗ Installed, but the relay isn't answering yet. Check the log: $LOG"
  echo "  (If it says 'Operation not permitted', macOS is blocking access to this folder —"
  echo "   System Settings → Privacy & Security → Full Disk Access → add 'node' from $NODE.)"
  exit 1
fi
