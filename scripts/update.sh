#!/usr/bin/env bash
# npm run update: brings this install up to date. Safe to re-run.
# Steps: checks (clean working tree, upstream, fast-forward possible, app not running outside the
# service), database backup, git pull --ff-only, stop the service, npm ci, migrations, dashboard
# build, restart the service if it is installed. Any failure stops it with a message and nothing
# after that step runs.
#
# Every step before npm ci works without node_modules (plain shell, git, launchctl): npm ci deletes
# node_modules first, so after a failed or interrupted install the next run must still reach it.
#
# The whole script is one function, read in full before it runs, so a pull that rewrites this file
# cannot change what the running update does.
set -euo pipefail

main() {
  cd "$(dirname "$0")/.."

  step() { printf 'update: %s\n' "$*"; }
  stop() { printf 'update: STOPPED: %s\n' "$*" >&2; exit 1; }

  # The data directory and the auto-start service, as src/config/paths.ts and src/ops/service.ts name them.
  local data_dir="${LINKEDIN_OUTREACH_DATA_DIR:-$HOME/Library/Application Support/linkedin-outreach}"
  local lock="$data_dir/app.lock"
  local service
  service="gui/$(id -u)/com.linkedin-outreach.app"

  # The auto-start service's process id, or nothing when it has none.
  service_pid() {
    { launchctl print "$service" 2>/dev/null || true; } | awk -F' = ' '$1 == "\tpid" && $2 ~ /^[0-9]+$/ { print $2; exit }'
  }
  # The process id in app.lock when that process is alive (decision 54: the app holds it while it
  # runs, on any port), nothing when there is no live holder, "unknown" when it holds no process id.
  lock_holder() {
    local pid
    [ -e "$lock" ] || return 0
    pid="$(cat "$lock" 2>/dev/null || true)"
    case "$pid" in
      '' | *[!0-9]*) echo unknown ;;
      *) if kill -0 "$pid" 2>/dev/null; then echo "$pid"; fi ;;
    esac
  }
  # Stops the auto-start service's app (SIGTERM: a clean exit, which launchd does not restart) and
  # waits up to 30 s for it to be gone. Without a process it does nothing.
  stop_service() {
    local i
    [ -n "$(service_pid)" ] || return 0
    launchctl kill SIGTERM "$service" >/dev/null || return 1
    for i in $(seq 60); do
      [ -n "$(service_pid)" ] || return 0
      sleep 0.5
    done
    return 1
  }

  # 1. Checks. Nothing is changed until they pass (git fetch only updates the remote branch's record).
  git rev-parse --is-inside-work-tree >/dev/null 2>&1 || stop "$(pwd) is not a git checkout. Nothing was changed"
  if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
    stop "the working tree has local changes (see git status). Nothing was changed. Ask before discarding them"
  fi
  local branch upstream before after holder
  branch="$(git symbolic-ref --short -q HEAD)" || stop "no branch is checked out. Nothing was changed"
  upstream="$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null)" ||
    stop "branch $branch has no upstream to pull from. Nothing was changed"
  git fetch --quiet || stop "git fetch failed (no network?). Nothing was changed"
  if ! git merge-base --is-ancestor HEAD "$upstream"; then
    stop "$branch has commits that $upstream does not, so a fast-forward pull is not possible. Nothing was changed"
  fi
  holder="$(lock_holder)"
  if [ "$holder" = unknown ]; then
    stop "$lock does not hold a process id. If no copy of the app is running, delete it and run npm run update again. Nothing was changed"
  fi
  if [ -n "$holder" ] && [ "$holder" != "$(service_pid)" ]; then
    stop "the app is running outside the auto-start service (process $holder holds $lock). Stop it (Ctrl+C in its terminal) and run npm run update again. Nothing was changed"
  fi
  before="$(git rev-parse --short HEAD)"
  step "checks passed on $branch at $before"

  # 2. Backup. npm ci writes node_modules/.package-lock.json only once an install has finished;
  # without it the packaged backup cannot run (tsx or better-sqlite3 may be missing).
  if [ -f node_modules/.package-lock.json ]; then
    npm run --silent backup || stop "the database backup failed. Nothing else was changed"
  elif [ ! -f "$data_dir/app.db" ]; then
    step "no database at $data_dir/app.db yet, nothing to back up"
  else
    # The app is stopped first (after a failed install it already is), so the files are complete.
    stop_service || stop "could not stop the auto-start service for the backup. Nothing else was changed"
    [ -z "$(lock_holder)" ] || stop "the app is still running ($lock), so the database cannot be copied. Nothing else was changed"
    local aside suffix
    aside="$data_dir/app.db.before-update-$(date -u +%Y-%m-%dT%H-%M-%SZ)"
    for suffix in "" -wal -shm; do
      if [ -f "$data_dir/app.db$suffix" ]; then
        cp -p "$data_dir/app.db$suffix" "$aside$suffix" || stop "copying the database aside failed. Nothing else was changed"
      fi
    done
    step "dependencies are missing or incomplete (an earlier npm ci did not finish); the app is stopped, so the database was copied aside with cp: $aside"
  fi

  # 3. Code
  git pull --ff-only --quiet || stop "git pull --ff-only failed. The backup was made; nothing else was changed"
  after="$(git rev-parse --short HEAD)"
  step "code $before -> $after"

  # 4. Stop the app while dependencies and the database change under it
  stop_service || stop "could not stop the auto-start service. The code is at $after; dependencies, database and dashboard are unchanged"

  local stopped="The app is stopped; once this is fixed run npm run update again"
  npm ci --no-audit --no-fund --loglevel=error || stop "npm ci failed. The code is at $after. $stopped"
  step "dependencies installed (npm ci)"
  npm run --silent migrate || stop "migrations failed. $stopped. The backup from step 2 is named above"
  npm run --silent build:ui >/dev/null || stop "the dashboard build failed. $stopped"
  step "dashboard built"

  # 5. Start again
  npm run --silent service:restart || stop "the auto-start service did not restart. Run npm run doctor"
  step "done: $before -> $after. If the app runs in a terminal instead of at login, start it with npm start"
}

main "$@"
exit
