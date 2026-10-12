#!/bin/sh
# Rotates the Bedrock API key every org's agent uses (IAM user
# benchy-agent-bedrock, scoped to the allowed models). Zero downtime:
#   1. create a new long-term key (365 days)        4. wait until each agent is healthy
#   2. prove it works against Bedrock               5. delete every older key
#   3. set it on every agent-* Railway service
# The secret is never printed or written to disk. Run from apps/agent (linked
# to the Railway project `benchy-agent`); needs aws, railway, python3, curl.
set -eu
USER_NAME=benchy-agent-bedrock
SERVICE=bedrock.amazonaws.com
cd "$(dirname "$0")"

say() { echo "[rotate] $*"; }

# A user may hold at most 2 keys per service: drop inactive ones first.
for id in $(aws iam list-service-specific-credentials --user-name $USER_NAME --service-name $SERVICE \
    --query "ServiceSpecificCredentials[?Status=='Inactive'].ServiceSpecificCredentialId" --output text); do
  aws iam delete-service-specific-credential --user-name $USER_NAME --service-specific-credential-id "$id"
  say "deleted inactive key $id"
done
old_ids=$(aws iam list-service-specific-credentials --user-name $USER_NAME --service-name $SERVICE \
  --query "ServiceSpecificCredentials[].ServiceSpecificCredentialId" --output text)
[ "$(echo "$old_ids" | wc -w)" -lt 2 ] || { echo "[rotate] two active keys exist; delete one first" >&2; exit 1; }

created=$(aws iam create-service-specific-credential --user-name $USER_NAME --service-name $SERVICE \
  --credential-age-days 365 --output json)
new_id=$(printf '%s' "$created" | python3 -c "import sys,json;print(json.load(sys.stdin)['ServiceSpecificCredential']['ServiceSpecificCredentialId'])")
KEY=$(printf '%s' "$created" | python3 -c "import sys,json;c=json.load(sys.stdin)['ServiceSpecificCredential'];print(c.get('ServiceApiKeyValue') or c['ServiceCredentialSecret'])")
unset created
say "created key $new_id (expires in 365 days)"

# IAM propagation can take a few seconds.
ok=""
for i in 1 2 3 4 5 6; do
  if curl -sf https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1/chat/completions \
      -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
      -d '{"model":"deepseek.v3.2","messages":[{"role":"user","content":"ok"}],"max_tokens":5}' >/dev/null; then ok=1; break; fi
  sleep 5
done
[ -n "$ok" ] || { echo "[rotate] new key does not work; old key left in place" >&2; aws iam delete-service-specific-credential --user-name $USER_NAME --service-specific-credential-id "$new_id"; exit 1; }
say "new key verified against Bedrock"

services=$(railway status --json | python3 -c "import sys,json;print(' '.join(e['node']['name'] for e in json.load(sys.stdin)['services']['edges'] if e['node']['name'].startswith('agent-')))")
for svc in $services; do
  printf '%s' "$KEY" | railway variable set AWS_BEARER_TOKEN_BEDROCK --stdin --service "$svc" >/dev/null
  say "set on $svc (redeploying)"
done
unset KEY

for svc in $services; do
  domain=$(railway variables --kv --service "$svc" | sed -n 's/^RAILWAY_PUBLIC_DOMAIN=//p')
  # Wait for the redeploy to replace the old container, then for health.
  sleep 60
  for i in $(seq 1 60); do
    status=$(railway deployment list --service "$svc" 2>/dev/null | sed -n '2p')
    case "$status" in *SUCCESS*) curl -sf "https://$domain/health" >/dev/null && break ;; *FAILED*|*CRASHED*) echo "[rotate] $svc deploy failed; old key still valid — investigate" >&2; exit 1 ;; esac
    sleep 10
  done
  say "$svc healthy on the new key"
done

for id in $old_ids; do
  aws iam delete-service-specific-credential --user-name $USER_NAME --service-specific-credential-id "$id"
  say "deleted old key $id"
done
say "done — next rotation before $(date -v+365d +%Y-%m-%d 2>/dev/null || date -d '+365 days' +%Y-%m-%d)"
