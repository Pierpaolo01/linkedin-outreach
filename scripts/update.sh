#!/usr/bin/env bash
# npm run update: brings this install up to date. Safe to re-run.
# Steps: checks (clean working tree, upstream, fast-forward possible, app not running outside the
# service), database backup, git pull --ff-only, stop the service, npm ci, migrations, dashboard
# build, restart the service if it is installed. Any failure stops it with a message and nothing
# after that step runs.
#
# The whole script is one function, read in full before it runs, so a pull that rewrites this file
# cannot change what the running update does.
set -euo pipefail

main() {
  cd "$(dirname "$0")/.."

  step() { printf 'update: %s\n' "$*"; }
  stop() { printf 'update: STOPPED: %s\n' "$*" >&2; exit 1; }

  # 1. Checks. Nothing is changed until they pass (git fetch only updates the remote branch's record).
  git rev-parse --is-inside-work-tree >/dev/null 2>&1 || stop "$(pwd) is not a git checkout. Nothing was changed"
  if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
    stop "the working tree has local changes (see git status). Nothing was changed. Ask before discarding them"
  fi
  local branch upstream before after
  branch="$(git symbolic-ref --short -q HEAD)" || stop "no branch is checked out. Nothing was changed"
  upstream="$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null)" ||
    stop "branch $branch has no upstream to pull from. Nothing was changed"
  git fetch --quiet || stop "git fetch failed (no network?). Nothing was changed"
  if ! git merge-base --is-ancestor HEAD "$upstream"; then
    stop "$branch has commits that $upstream does not, so a fast-forward pull is not possible. Nothing was changed"
  fi
  npm run --silent service:preflight ||
    stop "the app is running outside the auto-start service. Stop it (Ctrl+C in its terminal) and run npm run update again. Nothing was changed"
  before="$(git rev-parse --short HEAD)"
  step "checks passed on $branch at $before"

  # 2. Backup
  npm run --silent backup || stop "the database backup failed. Nothing else was changed"

  # 3. Code
  git pull --ff-only --quiet || stop "git pull --ff-only failed. The backup was made; nothing else was changed"
  after="$(git rev-parse --short HEAD)"
  step "code $before -> $after"

  # 4. Stop the app while dependencies and the database change under it
  npm run --silent service:stop || stop "could not stop the auto-start service. The code is at $after; dependencies, database and dashboard are unchanged"

  local stopped="The app is stopped; once this is fixed run npm run update again"
  npm ci --no-audit --no-fund --loglevel=error || stop "npm ci failed. The code is at $after. $stopped"
  step "dependencies installed (npm ci)"
  npm run --silent migrate || stop "migrations failed. $stopped. The backup from step 2 is listed by npm run doctor"
  npm run --silent build:ui >/dev/null || stop "the dashboard build failed. $stopped"
  step "dashboard built"

  # 5. Start again
  npm run --silent service:restart || stop "the auto-start service did not restart. Run npm run doctor"
  step "done: $before -> $after. If the app runs in a terminal instead of at login, start it with npm start"
}

main "$@"
exit
