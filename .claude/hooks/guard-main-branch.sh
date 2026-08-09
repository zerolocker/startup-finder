#!/bin/bash
#
# PreToolUse(Bash) hook: refuse `git commit` and `git push` while on main.
#
# Work belongs on a branch and lands through a pull request, so changes are
# reviewable and revertible as a unit. See CLAUDE.md, "Branch and PR, never
# commit to main".
#
# Reads the hook payload on stdin and, when it should block, emits the
# PreToolUse deny JSON. Anything else exits 0 and the command proceeds.
#
# Escape hatch: prefix the command with SF_ALLOW_MAIN_COMMIT=1 to bypass. That
# is deliberately explicit — an agent has to opt in visibly, and the user can
# see it in the transcript.

set -uo pipefail

payload=$(cat)
cmd=$(printf '%s' "$payload" | jq -r '.tool_input.command // ""' 2>/dev/null) || exit 0
[ -n "$cmd" ] || exit 0

# Explicit opt-out, visible in the command itself.
case "$cmd" in
  *SF_ALLOW_MAIN_COMMIT=1*) exit 0 ;;
esac

# Match `git commit` / `git push` as an actual subcommand — including after a
# pipe, a `&&`, or global flags like `git -C dir push`. Avoids firing on
# incidental mentions such as `git log --grep 'commit'`.
printf '%s' "$cmd" \
  | grep -Eq '(^|[;&|(]|[[:space:]])git([[:space:]]+-[^[:space:]]+([[:space:]]+[^[:space:]-][^[:space:]]*)?)*[[:space:]]+(commit|push)([[:space:]]|$)' \
  || exit 0

branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null) || exit 0
[ "$branch" = "main" ] || exit 0

# Deny, and tell the agent exactly how to proceed.
cat <<'JSON'
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "Blocked: you are on `main`, and this repo requires changes to land through a pull request.\n\nDo this instead:\n  git checkout -b <type>/<short-description>\n  # re-run your commit\n  git push -u origin HEAD\n  gh pr create --fill\n\nIf the work is already committed on main, move it:\n  git branch <type>/<short-description>\n  git reset --hard origin/main\n  git checkout <type>/<short-description>\n\nDeliberate exception (rare — say why): prefix the command with SF_ALLOW_MAIN_COMMIT=1"
  }
}
JSON
exit 0
