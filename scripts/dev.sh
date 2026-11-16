#!/usr/bin/env bash
# Starts a local Postgres with pgvector and runs every test suite.
#
#   bash scripts/dev.sh            # set up, then run everything
#   bash scripts/dev.sh db         # only make sure the database is up
#   bash scripts/dev.sh server     # unit and integration tests for the API
#   bash scripts/dev.sh demo       # the 12 demo-mode Playwright suites
#   bash scripts/dev.sh live       # the live-mode Playwright suites (fake providers)
#
# The database owner is timmy_owner / timmy on localhost:5432, with two
# databases: timmy_dev (for running the app) and timmy_test (wiped by the tests).
set -uo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"
export PGHOST=${PGHOST:-localhost} PGPORT=${PGPORT:-5432}
OWNER_URL="postgres://timmy_owner:timmy@$PGHOST:$PGPORT"
LOG_DIR=${TMPDIR:-/tmp}/timmy-dev
mkdir -p "$LOG_DIR"
# Node's fetch only uses the session's HTTPS proxy when told to.
[ -n "${HTTPS_PROXY:-}" ] && export NODE_USE_ENV_PROXY=1
# Playwright is installed globally in cloud sessions; make `require('playwright')` find it.
if ! node -e 'require.resolve("playwright")' 2>/dev/null; then
  for d in /opt/node-tools/node_modules "$(npm root -g 2>/dev/null)"; do [ -d "$d/playwright" ] && export NODE_PATH="$d${NODE_PATH:+:$NODE_PATH}" && break; done
fi

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
# Runs as the postgres system user over the local socket, where no password is asked.
as_postgres() { if [ "$(id -u)" = 0 ]; then su postgres -c "env -u PGHOST -u PGPORT $1" </dev/null; else sudo -u postgres env -u PGHOST -u PGPORT bash -c "$1" </dev/null; fi; }

ensure_db() {
  if ! pg_isready -q -h "$PGHOST" -p "$PGPORT"; then
    if command -v pg_ctlcluster >/dev/null; then
      ver=$(ls /usr/lib/postgresql 2>/dev/null | sort -n | tail -1)
      if [ -n "$ver" ] && ! ls "/usr/share/postgresql/$ver/extension/vector.control" >/dev/null 2>&1; then
        say "Installing pgvector for Postgres $ver"
        (apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "postgresql-$ver-pgvector") >"$LOG_DIR/apt.log" 2>&1 || { echo "could not install pgvector; see $LOG_DIR/apt.log"; return 1; }
      fi
      pg_ctlcluster "$ver" main start 2>/dev/null || true
    elif command -v docker >/dev/null && docker info >/dev/null 2>&1; then
      docker run -d --name timmy-pg -e POSTGRES_PASSWORD=postgres -p "$PGPORT:5432" pgvector/pgvector:pg16 >/dev/null
    else
      echo "No Postgres found. Install Postgres 16 with pgvector, or Docker."; return 1
    fi
    for _ in $(seq 1 30); do pg_isready -q -h "$PGHOST" -p "$PGPORT" && break; sleep 1; done
  fi
  pg_isready -q -h "$PGHOST" -p "$PGPORT" || { echo "Postgres did not start"; return 1; }
  if ! psql "$OWNER_URL/postgres" -Atc 'select 1' >/dev/null 2>&1; then
    if command -v pg_ctlcluster >/dev/null; then
      as_postgres "psql -p $PGPORT -qAtc \"create role timmy_owner superuser login password 'timmy'\"" >/dev/null 2>&1 || true
    else
      PGPASSWORD=postgres psql -h "$PGHOST" -p "$PGPORT" -U postgres -qAtc "create role timmy_owner superuser login password 'timmy'" >/dev/null 2>&1 || true
    fi
  fi
  for db in timmy_dev timmy_test; do
    psql "$OWNER_URL/postgres" -Atc "select 1 from pg_database where datname='$db'" | grep -q 1 || psql "$OWNER_URL/postgres" -qc "create database $db" >/dev/null
  done
  psql "$OWNER_URL/timmy_test" -Atc "select 'pgvector ' || default_version from pg_available_extensions where name='vector'"
}

deps() {
  [ -d node_modules ] || npm ci --no-audit --no-fund >/dev/null
  [ -d server/node_modules ] || (cd server && npm ci --no-audit --no-fund >/dev/null)
}

wait_for() { for _ in $(seq 1 60); do curl -sf -o /dev/null "$1" && return 0; sleep 0.5; done; echo "nothing answered at $1"; return 1; }
stop_on() { pid=$(lsof -ti tcp:"$1" 2>/dev/null || true); [ -n "$pid" ] && kill $pid 2>/dev/null; sleep 0.3; }

run_server_tests() {
  say "Type checks"
  npx tsc --noEmit && (cd server && npx tsc --noEmit) || return 1
  say "API unit and integration tests"
  (cd server && DATABASE_URL="$OWNER_URL/timmy_test" npx vitest run)
}

run_demo() {
  say "Demo mode: the 12 Playwright suites"
  stop_on 5173
  (npx vite --port 5173 --strictPort >"$LOG_DIR/vite.log" 2>&1 &)
  wait_for http://localhost:5173/ || return 1
  bash e2e/run-all.sh; code=$?
  stop_on 5173
  return $code
}

run_live() {
  say "Live mode: Playwright suites against the API with fake providers"
  stop_on 8787
  psql "$OWNER_URL/postgres" -qc "drop database if exists timmy_e2e with (force)" -c "create database timmy_e2e" >/dev/null
  VITE_TIMMY_LIVE=1 npx vite build --outDir "$LOG_DIR/dist-live" --emptyOutDir >"$LOG_DIR/build-live.log" 2>&1 || { tail -20 "$LOG_DIR/build-live.log"; return 1; }
  start_api || return 1
  BASE=http://localhost:8787/ bash e2e/live/run-all.sh; code=$?
  # One suite needs the setting production uses once Timmy can deliver mail: an address must be confirmed before sign-in.
  TIMMY_REQUIRE_EMAIL_VERIFICATION=1 start_api || return 1
  out=$(cd e2e/live && BASE=http://localhost:8787/ node live-verify.cjs 2>&1); vcode=$?
  if [ $vcode -ne 0 ]; then code=1; echo "FAIL live-verify"; echo "$out" | grep -vE '^ok -' | head -6; else echo "ok   live-verify ($(echo "$out" | grep -cE '^ok -') checks)"; fi
  stop_on 8787
  return $code
}

# Starts the API on port 8787 with the stand-in providers, serving the live app that was just built.
# Environment variables set on the call (such as TIMMY_REQUIRE_EMAIL_VERIFICATION=1) reach the server.
start_api() {
  stop_on 8787
  (cd server && DATABASE_URL="$OWNER_URL/timmy_e2e" TIMMY_ENV=development TIMMY_FAKE_PROVIDERS=1 TIMMY_TEST_HOOKS=1 TIMMY_SEND_HOLD_SECONDS=${TIMMY_SEND_HOLD_SECONDS:-4} PORT=8787 PUBLIC_URL=http://localhost:8787 WEB_DIST="$LOG_DIR/dist-live" npx tsx src/index.ts >"$LOG_DIR/api.log" 2>&1 &)
  wait_for http://localhost:8787/api/health || { tail -20 "$LOG_DIR/api.log"; return 1; }
}

case "${1:-all}" in
  db) ensure_db ;;
  server) ensure_db && deps && run_server_tests ;;
  demo) deps && run_demo ;;
  live) ensure_db && deps && run_live ;;
  all)
    ensure_db && deps || exit 1
    fail=0
    run_server_tests || fail=1
    run_demo || fail=1
    run_live || fail=1
    say "$([ $fail = 0 ] && echo 'Everything passed' || echo 'Something failed (see above)')"
    exit $fail ;;
  *) echo "usage: scripts/dev.sh [db|server|demo|live|all]"; exit 2 ;;
esac
