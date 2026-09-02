#!/usr/bin/env bash
# Smoke-test the deployed Worker API with curl.
#
# Usage:
#   BASE_URL="https://cortex-posture.example.com" npm run smoke
set -euo pipefail

: "${BASE_URL:?Set BASE_URL to the Worker URL, e.g. https://cortex-posture.example.com}"

failures=0

status() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

expect() {
  local label="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    printf 'PASS  %s (%s)\n' "$label" "$actual"
  else
    printf 'FAIL  %s (expected %s, got %s)\n' "$label" "$expected" "$actual"
    failures=$((failures + 1))
  fi
}

echo "Worker: ${BASE_URL}"

expect "health" 200 "$(status "${BASE_URL}/health")"
expect "dashboard page" 200 "$(status "${BASE_URL}/dashboard")"
expect "api overview" 200 "$(status "${BASE_URL}/api/overview")"
expect "api settings" 200 "$(status "${BASE_URL}/api/settings")"
expect "api devices (all)" 200 \
  "$(status "${BASE_URL}/api/devices?status=all&limit=10")"
expect "api devices (noncompliant)" 200 \
  "$(status "${BASE_URL}/api/devices?status=noncompliant")"
expect "api devices (search)" 200 \
  "$(status "${BASE_URL}/api/devices?search=desktop&limit=10")"
expect "api debug log" 200 "$(status "${BASE_URL}/api/debug-log")"
expect "refresh unknown device rejected" 404 \
  "$(status -X POST -H 'content-type: application/json' -d '{"deviceId":"does-not-exist"}' "${BASE_URL}/api/devices/refresh")"
expect "delete unknown device rejected" 404 \
  "$(status -X POST -H 'content-type: application/json' -d '{"deviceId":"does-not-exist"}' "${BASE_URL}/api/devices/delete")"
expect "check (empty inventory)" 200 \
  "$(status -X POST -H 'content-type: application/json' -d '{"devices":[]}' "${BASE_URL}/check")"
expect "rejects invalid device filter" 400 \
  "$(status "${BASE_URL}/api/devices?status=bogus")"

echo
echo "Sample /api/overview response:"
curl -s "${BASE_URL}/api/overview" | head -c 4000
echo

if [ "$failures" -gt 0 ]; then
  echo
  echo "${failures} check(s) failed."
  exit 1
fi
