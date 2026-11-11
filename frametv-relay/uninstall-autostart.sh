#!/bin/bash
# Stops the FrameTV relay from starting automatically at login.
LABEL="com.lifeos.frametv-relay"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/$LABEL.plist"
echo "FrameTV relay auto-start removed. Start it by hand with: npm start"
