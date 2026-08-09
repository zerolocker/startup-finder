#!/bin/bash
#
# One newsletter issue: run the pipeline, archive the result, optionally push.
#
# Designed to be run unattended by launchd (see install-schedule.sh), but it is
# an ordinary script — run it by hand any time to produce an issue now.
#
# Environment:
#   SF_DAYS      lookback window in days           (default 8)
#   SF_LIMIT     companies sent to the LLM screen  (default 120)
#   SF_RESEARCH  companies given a dossier         (default 15)
#   SF_BUDGET    plan-usage cap in $-equivalents   (default 6)
#   SF_PUSH      1 to `git push` after committing  (default 0)
#   SF_NOTIFY    1 for a macOS notification        (default 1)
#
# SF_PUSH defaults to OFF on purpose: this repo is public, and the reports say
# which companies you are interested in. Turn it on only if you are comfortable
# publishing that on a schedule.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

DAYS="${SF_DAYS:-8}"
LIMIT="${SF_LIMIT:-120}"
RESEARCH="${SF_RESEARCH:-15}"
BUDGET="${SF_BUDGET:-6}"
PUSH="${SF_PUSH:-0}"
NOTIFY="${SF_NOTIFY:-1}"

STAMP="$(date +%Y-%m-%d)"
LOG_DIR="$REPO/logs"
LOG="$LOG_DIR/weekly-$STAMP.log"
mkdir -p "$LOG_DIR"

# Everything below is logged; the terminal still sees it when run by hand.
exec > >(tee -a "$LOG") 2>&1

say() { printf '\n[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }

notify() {
  [ "$NOTIFY" = "1" ] || return 0
  command -v osascript >/dev/null 2>&1 || return 0
  # Escape double quotes so a company name cannot break the AppleScript string.
  local msg=${2//\"/\\\"}
  osascript -e "display notification \"${msg}\" with title \"startup-finder\" subtitle \"$1\"" || true
}

fail() {
  say "FAILED: $*"
  notify "Run failed" "$* — see logs/weekly-$STAMP.log"
  exit 1
}

# --- preflight -------------------------------------------------------------
# launchd gives a minimal PATH, and node here lives under nvm. Fail loudly with
# a fixable message rather than dying with "command not found" in a log nobody
# reads.
command -v node   >/dev/null 2>&1 || fail "node not on PATH (PATH=$PATH)"
command -v pnpm   >/dev/null 2>&1 || fail "pnpm not on PATH (PATH=$PATH)"
command -v claude >/dev/null 2>&1 || fail "claude CLI not on PATH (PATH=$PATH)"
command -v git    >/dev/null 2>&1 || fail "git not on PATH (PATH=$PATH)"

say "startup-finder weekly issue — $STAMP"
say "days=$DAYS limit=$LIMIT research=$RESEARCH budget=$BUDGET push=$PUSH"

# --- run -------------------------------------------------------------------
pnpm sf run \
  --days "$DAYS" \
  --limit "$LIMIT" \
  --research "$RESEARCH" \
  --budget "$BUDGET" \
  || fail "pipeline returned non-zero"

DIGEST="reports/$STAMP-digest.md"
[ -f "$DIGEST" ] || DIGEST="reports/latest.md"
[ -f "$DIGEST" ] || fail "no digest was written"

# --- archive ---------------------------------------------------------------
# Dated files in reports/ are the back issues; git is the durable archive.
if [ -n "$(git status --porcelain data reports)" ]; then
  git add data reports
  git commit -q -m "Digest $STAMP

Automated weekly run: --days $DAYS --research $RESEARCH --budget $BUDGET."
  say "committed $(git rev-parse --short HEAD)"

  if [ "$PUSH" = "1" ]; then
    git push -q && say "pushed to $(git remote get-url origin)"
  else
    say "not pushing (SF_PUSH=0). Commit is local only."
  fi
else
  say "no changes to commit — sources produced nothing new"
fi

# --- report back -----------------------------------------------------------
TOP="$(grep -m1 -E '^\| .* \| \*\*[0-9]+\*\* \|' "$DIGEST" 2>/dev/null \
  | sed -E 's/.*\*\*([0-9]+)\*\* \| \[([^]]+)\].*/\2 (fit \1)/' || true)"
COUNT="$(grep -c -E '^\| .* \| \*\*[0-9]+\*\* \|' "$DIGEST" 2>/dev/null || echo 0)"

say "done — $COUNT featured, top match: ${TOP:-none}"
notify "Issue $STAMP ready" "${COUNT} companies. Top: ${TOP:-none}"
