#!/usr/bin/env bash
# npm run setup: prepares this Mac to run the app. Safe to re-run.
# Steps: Node >= 22, Google Chrome, dependencies, data directory, migrations, dashboard build.
set -euo pipefail

cd "$(dirname "$0")/.."

CHROME_APP="/Applications/Google Chrome.app"

step() { printf 'setup: %s\n' "$*"; }
fail() { printf 'setup: FAILED: %s\n' "$*" >&2; exit 1; }

# 1. Node
if ! command -v node >/dev/null 2>&1; then
  fail "node not found. Install Node 22 LTS (for example: brew install node@22), then run npm run setup again"
fi
node_major="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$node_major" -lt 22 ]; then
  fail "node $(node -v) is too old; need 22 or newer. Install Node 22 LTS (for example: brew install node@22), then run npm run setup again"
fi
step "node $(node -v) ok"

# 2. Google Chrome
if [ -d "$CHROME_APP" ]; then
  step "google chrome found at $CHROME_APP"
else
  if ! command -v brew >/dev/null 2>&1; then
    fail "Google Chrome is missing and Homebrew is not installed. Either install Homebrew (https://brew.sh) and run npm run setup again, or download Chrome from https://www.google.com/chrome/, drag it into /Applications, and run npm run setup again"
  fi
  step "google chrome missing; installing with: brew install --cask google-chrome"
  brew install --cask google-chrome || true
  # Homebrew can hold a stale record of a Chrome that was deleted by hand; then the plain install does nothing.
  [ -d "$CHROME_APP" ] || brew install --cask --force google-chrome
  [ -d "$CHROME_APP" ] || fail "brew finished but $CHROME_APP is still missing"
  step "google chrome installed at $CHROME_APP"
fi

# 3. Dependencies
if [ -d node_modules ]; then
  npm install --no-audit --no-fund --loglevel=error
  step "dependencies up to date (npm install)"
else
  npm ci --no-audit --no-fund --loglevel=error
  step "dependencies installed (npm ci)"
fi

# 4. Data directory and 5. migrations
step "$(npx --no-install tsx scripts/migrate.ts data-dir)"
step "$(npx --no-install tsx scripts/migrate.ts migrate)"

# 6. Dashboard
npm run --silent build:ui >/dev/null
step "dashboard built (npm run build:ui)"

step "done. Next: npm run doctor"
