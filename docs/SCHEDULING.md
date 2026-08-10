# Running it like a newsletter

_Produce an issue on a schedule, keep the back issues, get told when it's ready._

---

## Quick start

```bash
./scripts/install-schedule.sh          # every Monday at 08:00
./scripts/install-schedule.sh --run-now  # produce an issue right now, to test
```

That's it. Each run writes `reports/YYYY-MM-DD-digest.md` plus a dashboard,
commits them, and posts a macOS notification with the top match.

```bash
./scripts/install-schedule.sh --day 5 --hour 7   # Fridays at 07:00
./scripts/install-schedule.sh --uninstall
```

## Where the back issues live

Nothing extra is needed — the app already writes dated files and everything
under `data/` and `reports/` is committed ([ADR-007](DECISIONS.md)):

```
reports/2026-08-09-digest.md      this week's issue
reports/2026-08-02-digest.md      last week's
reports/latest.md                 always the newest — bookmark this one
```

Git is the archive. `git log --oneline -- reports/` lists every issue, and
`git log -p -- data/companies.jsonl` shows how a company's record changed over
time.

## Publishing is off by default

`scripts/weekly.sh` commits locally but does **not** push, because this repo is
public and the reports show which companies you are tracking, on a schedule,
under your name.

To turn pushing on, set `SF_PUSH` to `1` in
`~/Library/LaunchAgents/com.startup-finder.weekly.plist` and reload:

```bash
./scripts/install-schedule.sh   # re-run to reload after editing
```

Consider making the repo private first (`gh repo edit --visibility private`).

## Why launchd, not cron

`cron` on macOS needs a Full Disk Access grant, gets a minimal environment, and
silently skips runs while the machine is asleep. `launchd`:

- survives reboots,
- runs a **missed** calendar job when the machine next wakes, so a closed laptop
  still gets its issue,
- runs inside your login session, which matters because `claude` reads its OAuth
  token from the keychain — a job outside the session cannot authenticate.

## Tuning the issue

`scripts/weekly.sh` reads these, all optional:

| Variable | Default | What it does |
|---|---:|---|
| `SF_DAYS` | auto | Lookback window. Left unset, each run covers everything since the last one — so a laptop that was closed for three weeks catches up instead of skipping them. Set a number to pin it. |
| `SF_LIMIT` | 120 | Companies sent to the LLM screen. |
| `SF_RESEARCH` | 15 | Companies given a full dossier. |
| `SF_BUDGET` | 6 | Plan-usage cap in $-equivalents. |
| `SF_PUSH` | 0 | `1` to push after committing. |
| `SF_NOTIFY` | 1 | `0` to suppress the macOS notification. |

Set them in the plist's `EnvironmentVariables`, or inline for a one-off:

```bash
SF_DAYS=14 SF_BUDGET=10 ./scripts/weekly.sh
```

## When it doesn't run

Logs are in `logs/` (gitignored):

```bash
tail -f logs/weekly-$(date +%F).log   # the run itself
cat logs/launchd.err.log              # launchd-level failures
launchctl list | grep startup-finder  # is it registered?
```

The most common failure is `PATH`. launchd starts with a minimal environment and
this machine's `node` lives under nvm, so the installer bakes the resolved
directories into the plist. If you switch node versions with nvm, re-run
`./scripts/install-schedule.sh` to refresh them. `weekly.sh` preflights `node`,
`pnpm`, `claude`, and `git` and fails with the offending `PATH` rather than dying
obscurely.

A run that finds nothing new exits cleanly and commits nothing — that is a quiet
week in the feeds, not an error.

## Not built

Email delivery. It would mean sending mail on your behalf unattended, which
needs credentials and a deliberate decision about what leaves the machine. The
notification plus `reports/latest.md` covers the "tell me it's ready" part
without that. If you want real email, say so and it is a small addition.
