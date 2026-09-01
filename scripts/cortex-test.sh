#!/usr/bin/env bash
# Test the Palo Alto Cortex XDR API exactly the way the Worker calls it.
#
# 1. Validates the API key through POST /api_keys/validate/ (advanced keys).
# 2. Calls POST /public_api/v1/endpoints/get_endpoint and shows each
#    endpoint's last_content_update_time, its age, and whether the Worker
#    would consider it noncompliant.
#
# Usage:
#   CORTEX_BASE_URL="https://api-tenant.xdr.us.paloaltonetworks.com" \
#   CORTEX_API_KEY="<api-key>" \
#   CORTEX_API_KEY_ID="<key-id>" \
#   npm run cortex-test [hostname]
#
# Optional:
#   CORTEX_KEY_TYPE=standard   tenant issues standard security keys
#   MAX_CONTENT_AGE_DAYS=7     threshold used for the stale/fresh verdict
set -euo pipefail

: "${CORTEX_BASE_URL:?Set CORTEX_BASE_URL to the Cortex API HTTPS origin}"
: "${CORTEX_API_KEY:?Set CORTEX_API_KEY to the Cortex API key}"
: "${CORTEX_API_KEY_ID:?Set CORTEX_API_KEY_ID to the Cortex API key ID}"

hostname_arg="${1:-}"
key_type="${CORTEX_KEY_TYPE:-advanced}"
base="${CORTEX_BASE_URL%/}"

sign_headers() {
  # Builds the same advanced-key signature the Worker sends, with a fresh
  # 64-character alphanumeric nonce and millisecond timestamp per request:
  #   Authorization = sha256(api_key + nonce + timestamp)
  local timestamp nonce signature
  timestamp=$(node -e 'console.log(Date.now())')
  HEADERS=(
    --header "content-type: application/json"
    --header "x-xdr-auth-id: ${CORTEX_API_KEY_ID}"
  )
  if [ "$key_type" != "advanced" ]; then
    HEADERS+=(--header "authorization: ${CORTEX_API_KEY}")
  else
    nonce=$(node -e 'const a="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";console.log([...crypto.getRandomValues(new Uint8Array(64))].map(b=>a[b%a.length]).join(""))')
    signature=$(printf '%s' "${CORTEX_API_KEY}${nonce}${timestamp}" | openssl dgst -sha256 -hex | awk '{ print $NF }')
    HEADERS+=(
      --header "authorization: ${signature}"
      --header "x-xdr-nonce: ${nonce}"
      --header "x-xdr-timestamp: ${timestamp}"
    )
  fi
}

if [ "$key_type" = "advanced" ]; then
  sign_headers
  validate_code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "${base}/api_keys/validate/" "${HEADERS[@]}" --data '{}')
  echo "POST ${base}/api_keys/validate/ -> HTTP ${validate_code}"
  if [ "$validate_code" != "200" ]; then
    echo "Cortex rejected the API key. Check CORTEX_API_KEY and CORTEX_API_KEY_ID."
    exit 1
  fi
fi

if [ -n "$hostname_arg" ]; then
  hostname_json=$(printf '%s' "$hostname_arg" | node -e 'let s="";process.stdin.on("data",d=>(s+=d));process.stdin.on("end",()=>process.stdout.write(JSON.stringify(s.trim().toLowerCase())))')
  body='{"request_data":{"search_from":0,"search_to":5,"sort":{"field":"last_seen","keyword":"DESC"},"filters":[{"field":"hostname","operator":"in","value":['"$hostname_json"']}]}}'
else
  body='{"request_data":{"search_from":0,"search_to":5,"sort":{"field":"last_seen","keyword":"DESC"}}}'
fi

sign_headers
response=$(curl -s --show-error -w '\n%{http_code}' -X POST "${base}/public_api/v1/endpoints/get_endpoint" "${HEADERS[@]}" --data "$body")
http_code="${response##*$'\n'}"
body_json="${response%$'\n'*}"

echo "POST ${base}/public_api/v1/endpoints/get_endpoint -> HTTP ${http_code}"

if [ "$http_code" != "200" ]; then
  printf '%s\n' "$body_json" | head -c 2000
  echo
  exit 1
fi

printf '%s' "$body_json" | MAX_AGE_DAYS="${MAX_CONTENT_AGE_DAYS:-7}" node -e '
let raw = "";
process.stdin.on("data", (chunk) => (raw += chunk));
process.stdin.on("end", () => {
  const maxAgeDays = Number(process.env.MAX_AGE_DAYS || 7);
  let reply;
  try {
    reply = JSON.parse(raw);
  } catch {
    console.log(raw.slice(0, 2000));
    process.exitCode = 1;
    return;
  }
  if (reply.reply && reply.reply.err_msg) {
    console.log("Cortex error: " + reply.reply.err_msg);
    process.exitCode = 1;
    return;
  }
  const endpoints = (reply.reply && reply.reply.endpoints) || [];
  if (endpoints.length === 0) {
    console.log("No endpoints returned" + (reply.reply && reply.reply.total_count !== undefined ? " (total_count=" + reply.reply.total_count + ")" : "") + ".");
    return;
  }
  for (const endpoint of endpoints) {
    const rawTime = Number(endpoint.last_content_update_time || 0);
    const updated = rawTime > 0 && rawTime < 1e12 ? rawTime * 1000 : rawTime;
    const hostname = endpoint.endpoint_name || endpoint.host_name || "(no hostname)";
    if (!updated) {
      console.log(hostname + "  last_content_update_time missing (device stays allowed)");
      continue;
    }
    const ageDays = (Date.now() - updated) / 86400000;
    const verdict = ageDays > maxAgeDays ? "STALE (would be denied)" : "fresh";
    console.log(
      hostname +
        "  last_content_update_time=" + new Date(updated).toISOString() +
        "  age=" + ageDays.toFixed(1) + "d  " + verdict
    );
  }
});
'
