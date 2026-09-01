#!/usr/bin/env bash
# Smoke-test the deployed, Access-protected Worker API with curl.
#
# Usage:
#   BASE_URL="https://cortex-posture.example.com" \
#   CF_ACCESS_CLIENT_ID="<service-token-client-id>" \
#   CF_ACCESS_CLIENT_SECRET="<service-token-client-secret>" \
#   npm run smoke
#
# The service token is the one created in the README's
# "Custom Provider Setup" section. Cloudflare Access exchanges the
# CF-Access-Client-Id/Secret headers for a CF-Access-Jwt-Assertion header at
# the edge, which is the only credential the Worker itself accepts.
set -euo pipefail

: "${BASE_URL:?Set BASE_URL to the Worker URL, e.g. https://cortex-posture.example.com}"
: "${CF_ACCESS_CLIENT_ID:?Set CF_ACCESS_CLIENT_ID to the Access service token client ID}"
: "${CF_ACCESS_CLIENT_SECRET:?Set CF_ACCESS_CLIENT_SECRET to the Access service token client secret}"

auth=(
  -H "CF-Access-Client-Id: ${CF_ACCESS_CLIENT_ID}"
  -H "CF-Access-Client-Secret: ${CF_ACCESS_CLIENT_SECRET}"
)
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

expect "health" 200 "$(status "${BASE_URL}/health" "${auth[@]}")"
expect "dashboard page" 200 "$(status "${BASE_URL}/dashboard" "${auth[@]}")"
expect "api overview" 200 "$(status "${BASE_URL}/api/overview" "${auth[@]}")"
expect "api settings" 200 "$(status "${BASE_URL}/api/settings" "${auth[@]}")"
expect "api devices (all)" 200 \
  "$(status "${BASE_URL}/api/devices?status=all&limit=10" "${auth[@]}")"
expect "api devices (noncompliant)" 200 \
  "$(status "${BASE_URL}/api/devices?status=noncompliant" "${auth[@]}")"
expect "check (empty inventory)" 200 \
  "$(status -X POST -H 'content-type: application/json' -d '{"devices":[]}' "${BASE_URL}/check" "${auth[@]}")"
expect "rejects invalid device filter" 400 \
  "$(status "${BASE_URL}/api/devices?status=bogus" "${auth[@]}")"

unauthenticated=$(status "${BASE_URL}/api/overview")
if [ "$unauthenticated" = "200" ]; then
  echo "FAIL  unauthenticated api overview request was allowed (${unauthenticated})"
  failures=$((failures + 1))
else
  echo "PASS  unauthenticated api overview request rejected (${unauthenticated})"
fi

echo
echo "Sample /api/overview response:"
curl -s "${BASE_URL}/api/overview" "${auth[@]}" | head -c 4000
echo

if [ "$failures" -gt 0 ]; then
  echo
  echo "${failures} check(s) failed."
  exit 1
fi
