#!/usr/bin/env bash
# Runs every end-to-end suite against BASE (default: the local dev server).
#   npm run dev            # in another terminal, on port 5173
#   bash e2e/run-all.sh
#   BASE=https://web-production-c4bbfc9c.up.railway.app/ bash e2e/run-all.sh
# Needs Playwright with Chromium: npm i -D playwright && npx playwright install chromium
cd "$(dirname "$0")"
fail=0
for t in e2e e2e-approvals e2e-steps e2e-agent e2e-focus e2e-voice e2e-fixes e2e-ask e2e-outbound e2e-calm-phone e2e-round3 e2e-round3b e2e-round4 e2e-story e2e-intro e2e-pages e2e-uis e2e-invoices e2e-bids e2e-due; do
  out=$(node "$t.cjs" 2>&1); code=$?
  n=$(echo "$out" | grep -cE '^ok -|^PASS')
  if [ $code -ne 0 ]; then fail=1; echo "FAIL $t ($n passed)"; echo "$out" | grep -E 'FAIL|Error' | head -3; else echo "ok   $t ($n checks)"; fi
done
exit $fail
