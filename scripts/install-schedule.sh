#!/bin/bash
#
# Install (or remove) the weekly launchd job that produces a digest.
#
#   ./scripts/install-schedule.sh            # every Monday 08:00
#   ./scripts/install-schedule.sh --day 5 --hour 7
#   ./scripts/install-schedule.sh --uninstall
#   ./scripts/install-schedule.sh --run-now   # trigger immediately, for testing
#
# Why launchd rather than cron: it is the supported mechanism on macOS, it
# survives reboots, it runs a missed calendar job when the machine next wakes
# (so a closed laptop still gets its issue), and it runs inside your login
# session — which matters because `claude` reads its OAuth token from the
# keychain.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="com.startup-finder.weekly"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

WEEKDAY=1   # 0=Sunday … 1=Monday
HOUR=8
MINUTE=0
ACTION=install

while [ $# -gt 0 ]; do
  case "$1" in
    --day)       WEEKDAY="$2"; shift 2 ;;
    --hour)      HOUR="$2"; shift 2 ;;
    --minute)    MINUTE="$2"; shift 2 ;;
    --uninstall) ACTION=uninstall; shift ;;
    --run-now)   ACTION=runnow; shift ;;
    -h|--help)   sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 1 ;;
  esac
done

if [ "$ACTION" = uninstall ]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "Removed $LABEL"
  exit 0
fi

if [ "$ACTION" = runnow ]; then
  [ -f "$PLIST" ] || { echo "Not installed. Run without --run-now first." >&2; exit 1; }
  launchctl kickstart -p "gui/$(id -u)/$LABEL"
  echo "Triggered $LABEL — follow along with: tail -f $REPO/logs/weekly-\$(date +%F).log"
  exit 0
fi

# launchd starts with a minimal PATH and no shell profile, so node (under nvm
# here) and claude would not be found. Bake the current locations in.
BIN_PATH="$(dirname "$(command -v node)"):$(dirname "$(command -v claude)"):/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"

for tool in node pnpm claude git; do
  command -v "$tool" >/dev/null 2>&1 || { echo "error: $tool not found on your PATH" >&2; exit 1; }
done

mkdir -p "$HOME/Library/LaunchAgents" "$REPO/logs"
chmod +x "$REPO/scripts/weekly.sh"

cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$LABEL</string>

    <key>ProgramArguments</key>
    <array>
        <string>$REPO/scripts/weekly.sh</string>
    </array>

    <key>WorkingDirectory</key>
    <string>$REPO</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>$BIN_PATH</string>
        <key>HOME</key>
        <string>$HOME</string>
        <!-- Set to 1 to push each issue to GitHub. Off by default: this repo
             is public and the reports show which companies you are tracking. -->
        <key>SF_PUSH</key>
        <string>0</string>
    </dict>

    <key>StartCalendarInterval</key>
    <dict>
        <key>Weekday</key><integer>$WEEKDAY</integer>
        <key>Hour</key><integer>$HOUR</integer>
        <key>Minute</key><integer>$MINUTE</integer>
    </dict>

    <key>StandardOutPath</key>
    <string>$REPO/logs/launchd.out.log</string>
    <key>StandardErrorPath</key>
    <string>$REPO/logs/launchd.err.log</string>

    <key>ProcessType</key>
    <string>Background</string>
</dict>
</plist>
PLIST_EOF

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"

DAYNAME=$(printf 'Sunday Monday Tuesday Wednesday Thursday Friday Saturday' | cut -d' ' -f$((WEEKDAY + 1)))
echo "Installed $LABEL"
echo "  runs      $DAYNAME at $(printf '%02d:%02d' "$HOUR" "$MINUTE")"
echo "  script    $REPO/scripts/weekly.sh"
echo "  logs      $REPO/logs/"
echo "  push      off (edit SF_PUSH in $PLIST to enable)"
echo
echo "Test it now:   ./scripts/install-schedule.sh --run-now"
echo "Remove it:     ./scripts/install-schedule.sh --uninstall"
