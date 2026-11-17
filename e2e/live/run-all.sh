#!/usr/bin/env bash
# Runs the live-mode suites against BASE: the API serving the app built with VITE_TIMMY_LIVE=1,
# with TIMMY_FAKE_PROVIDERS=1 and TIMMY_TEST_HOOKS=1. `bash scripts/dev.sh live` sets all of that up.
cd "$(dirname "$0")"
fail=0
for t in live-signup live-mail live-mailbox live-ask live-settings live-isolation live-holds live-coldmail live-morning live-filing live-calendar live-outlook live-pages live-versions live-decisions live-types live-automations live-chat live-outside live-files; do
  [ -f "$t.cjs" ] || continue
  out=$(node "$t.cjs" 2>&1); code=$?
  n=$(echo "$out" | grep -cE '^ok -')
  if [ $code -ne 0 ]; then fail=1; echo "FAIL $t ($n passed)"; echo "$out" | grep -vE '^ok -' | head -6; else echo "ok   $t ($n checks)"; fi
done
exit $fail
