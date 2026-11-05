#!/usr/bin/env bash
# peel-org.sh — detach one org from the multiplex Benchy agent to its own
# dedicated ECS service (the escape hatch for tier: dedicated), and roll
# that back. Companion to docs/migration-multiplex.md.
#
#   scripts/peel-org.sh ORG [flags]
#
# Dry-run by default: prints every mutating AWS call without making it
# (read-only describes still run, so the plan reflects real state).
# Pass --apply to execute.
#
# Flags:
#   --apply                execute (default: dry-run)
#   --rollback             point the org's hostname back at the multiplex
#                          and scale the dedicated service to 0
#   --copy-only            run only the state-copy step (peel direction,
#                          or with --reverse the migration direction)
#   --reverse              with --copy-only: copy dedicated EFS -> multiplex
#                          profile (the inbound half of a migration)
#   --render-copy-taskdef  print the copy task definition JSON and exit
#   --render-org-taskdef   print the dedicated task definition JSON and exit
#   --create-efs           create the org's dedicated EFS first (new orgs
#                          born in the multiplex; migrated orgs already
#                          have one)
#   --skip-copy            don't copy state (operator copied it already)
#   --keep-service         with --rollback: leave the dedicated service
#                          running (only retarget the rule)
#
# Configuration: environment or a sourced env file (ENV_FILE, default
# scripts/peel-org.env — see scripts/peel-org.env.example). Identifiers
# (EFS ids, ARNs, subnets) are operational: keep the filled file out of
# git — this repository is public.
#
# Idempotent: describes before every create, converges every rule, cp -a
# for the copy. Re-running after a partial failure resumes where it left.
#
# After a successful peel the operator must still set the org to
#   tier: dedicated
# in orgs.yaml and redeploy the multiplex (the startup then skips the
# profile). The script prints that reminder; it deliberately does not edit
# orgs.yaml, which the multiplex workstream owns.

set -euo pipefail

say()  { printf "%s\n" "[peel] $*" >&2; }
die()  { printf '%s\n' "[peel] FATAL: $*" >&2; exit 1; }

# ---------------------------------------------------------------- args
ORG="${1:-}"; shift || true
[ -n "$ORG" ] || die "usage: peel-org.sh ORG [--apply] [--rollback] [--copy-only [--reverse]] [--render-copy-taskdef] [--render-org-taskdef] [--create-efs] [--skip-copy] [--keep-service]"
case "$ORG" in *[!a-z0-9-]*) die "ORG must be lowercase alnum/dash: '$ORG'";; esac

APPLY=0; ROLLBACK=0; COPY_ONLY=0; REVERSE=0; RENDER_COPY=0; RENDER_ORG=0
CREATE_EFS=0; SKIP_COPY=0; KEEP_SERVICE=0
for a in "$@"; do case "$a" in
  --apply) APPLY=1;; --rollback) ROLLBACK=1;; --copy-only) COPY_ONLY=1;;
  --reverse) REVERSE=1;; --render-copy-taskdef) RENDER_COPY=1;;
  --render-org-taskdef) RENDER_ORG=1;;
  --create-efs) CREATE_EFS=1;; --skip-copy) SKIP_COPY=1;;
  --keep-service) KEEP_SERVICE=1;; --help|-h) sed -n '2,40p' "$0"; exit 0;;
  *) die "unknown flag: $a";; esac; done

# ------------------------------------------------------------ config
ENV_FILE="${ENV_FILE:-$(dirname "$0")/peel-org.env}"
[ -f "$ENV_FILE" ] && { say "loading $ENV_FILE"; set -a; . "$ENV_FILE"; set +a; }

AWS_REGION="${AWS_REGION:-us-east-1}"
CLUSTER="${CLUSTER:-benchy}"
LOG_GROUP="${LOG_GROUP:-/ecs/benchy-agent}"
TASK_ROLE_NAME="${TASK_ROLE_NAME:-benchy-task}"
EXEC_ROLE_NAME="${EXEC_ROLE_NAME:-benchy-task-exec}"
CPU="${CPU:-1024}"; MEMORY="${MEMORY:-4096}"
COPY_IMAGE="${COPY_IMAGE:-public.ecr.aws/amazonlinux/amazonlinux:2023}"
PROFILES_ROOT="${PROFILES_ROOT:-profiles}"       # dir on the multiplex EFS
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-300}"
ORG_HOSTNAME="${ORG_HOSTNAME:-agent-${ORG}.agents.getbenchy.lat}"
SECRET_API_KEY="${SECRET_API_KEY:-/surus/benchy/agent-${ORG}/API_SERVER_KEY}"
SECRET_BEDROCK="${SECRET_BEDROCK:-/surus/benchy/agent-${ORG}/AWS_BEARER_TOKEN_BEDROCK}"

need() { [ -n "${!1:-}" ] || die "missing config: $1 (see scripts/peel-org.env.example)"; }

command -v aws >/dev/null || die "aws CLI not found"
command -v jq  >/dev/null || die "jq not found"

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
ECR_IMAGE="${ECR_IMAGE:-$ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/benchy-agent:latest}"
TASK_ROLE_ARN="${TASK_ROLE_ARN:-arn:aws:iam::$ACCOUNT_ID:role/$TASK_ROLE_NAME}"
EXECUTION_ROLE_ARN="${EXECUTION_ROLE_ARN:-arn:aws:iam::$ACCOUNT_ID:role/$EXEC_ROLE_NAME}"
ORG_UPPER="$(printf '%s' "$ORG" | tr 'a-z-' 'A-Z_')"
ORG_FS_ID="${ORG_FS_ID:-$(eval printf '%s' "\${ORG_${ORG_UPPER}_FS_ID:-}")}"

SVC="agent-$ORG"; TG_NAME="benchy-agent-$ORG"; COPY_FAMILY="benchy-peel-copy-$ORG"

# Mutating calls go through x(); describes run even in dry-run.
x() { if [ "$APPLY" = 1 ]; then say "+ $*"; "$@"; else say "[dry-run] $*"; fi; }

# ------------------------------------------------- copy task definition
# One shape serves both directions: source EFS read-only at /src,
# destination at /dst; the per-direction command is an override at run.
render_copy_taskdef() {
  local src_fs="$1" dst_fs="$2"
  cat <<JSON
{
  "family": "$COPY_FAMILY",
  "requiresCompatibilities": ["FARGATE"],
  "networkMode": "awsvpc",
  "cpu": "256", "memory": "512",
  "taskRoleArn": "$TASK_ROLE_ARN",
  "executionRoleArn": "$EXECUTION_ROLE_ARN",
  "volumes": [
    {"name": "src", "efsVolumeConfiguration": {"fileSystemId": "$src_fs", "rootDirectory": "/", "transitEncryption": "ENABLED"}},
    {"name": "dst", "efsVolumeConfiguration": {"fileSystemId": "$dst_fs", "rootDirectory": "/", "transitEncryption": "ENABLED"}}
  ],
  "containerDefinitions": [{
    "name": "copy", "image": "$COPY_IMAGE", "essential": true,
    "entryPoint": ["/bin/sh", "-c"],
    "command": ["echo override-me"],
    "mountPoints": [
      {"sourceVolume": "src", "containerPath": "/src", "readOnly": true},
      {"sourceVolume": "dst", "containerPath": "/dst", "readOnly": false}
    ],
    "logConfiguration": {"logDriver": "awslogs", "options": {
      "awslogs-group": "$LOG_GROUP", "awslogs-region": "$AWS_REGION",
      "awslogs-stream-prefix": "$COPY_FAMILY"}}
  }]
}
JSON
}

if [ "$RENDER_COPY" = 1 ]; then
  need MULTIPLEX_FS_ID
  [ -n "$ORG_FS_ID" ] || die "ORG_FS_ID / ORG_${ORG_UPPER}_FS_ID is required to render the copy task definition"
  if [ "$REVERSE" = 1 ]; then render_copy_taskdef "$ORG_FS_ID" "$MULTIPLEX_FS_ID"
  else render_copy_taskdef "$MULTIPLEX_FS_ID" "$ORG_FS_ID"; fi
  exit 0
fi

need MULTIPLEX_FS_ID; need MULTIPLEX_TG_ARN; need LISTENER_ARN
need SUBNET_IDS; need SECURITY_GROUP_ID
[ "$SKIP_COPY" = 1 ] || [ "$ROLLBACK" = 1 ] || [ -n "$ORG_FS_ID" ] || [ "$CREATE_EFS" = 1 ] \
  || die "no dedicated EFS for $ORG: set ORG_${ORG_UPPER}_FS_ID, or pass --create-efs"
IFS=',' read -ra SUBNETS <<< "$SUBNET_IDS"
SUBNET_ARGS="$(printf '%s ' "${SUBNETS[@]}")"

# ------------------------------------------------------------ create EFS
if [ "$CREATE_EFS" = 1 ]; then
  [ -z "$ORG_FS_ID" ] || die "--create-efs but ORG_FS_ID already set ($ORG_FS_ID)"
  say "creating dedicated EFS for $ORG"
  if [ "$APPLY" = 1 ]; then
    ORG_FS_ID="$(aws efs create-file-system --creation-token "benchy-$ORG-dedicated" \
      --encrypted --tags Key=Name,Value="benchy-agent-$ORG" Key=Project,Value=benchy \
      --region "$AWS_REGION" --query FileSystemId --output text)"
    say "created $ORG_FS_ID — waiting for availability"
    until [ "$(aws efs describe-file-systems --file-system-id "$ORG_FS_ID" \
        --query 'FileSystems[0].LifeCycleState' --output text)" = "available" ]; do sleep 5; done
    for sn in "${SUBNETS[@]}"; do
      aws efs create-mount-target --file-system-id "$ORG_FS_ID" --subnet-id "$sn" \
        --security-groups "${EFS_MOUNT_SG_ID:-$SECURITY_GROUP_ID}" --region "$AWS_REGION" >/dev/null
    done
    say "mount targets created — NOTE: the mount SG must allow tcp/2049 from the task SG"
  else
    say "[dry-run] aws efs create-file-system (+ mount targets in $SUBNET_IDS)"
    ORG_FS_ID="fs-DRYRUN"
  fi
fi

# ------------------------------------------------------------ state copy
copy_state() {
  local src_fs dst_fs cmd
  if [ "$REVERSE" = 1 ]; then
    src_fs="$ORG_FS_ID"; dst_fs="$MULTIPLEX_FS_ID"
    cmd="set -e; mkdir -p '/dst/$PROFILES_ROOT/$ORG'; cp -a /src/. '/dst/$PROFILES_ROOT/$ORG/'; echo COPY_OK; echo \"DST files: \$(find '/dst/$PROFILES_ROOT/$ORG' -type f | wc -l)\""
  else
    src_fs="$MULTIPLEX_FS_ID"; dst_fs="$ORG_FS_ID"
    cmd="set -e; cp -a '/src/$PROFILES_ROOT/$ORG/.' /dst/; echo COPY_OK; echo \"DST files: \$(find /dst -type f | wc -l)\""
  fi
  say "copying profile state ($([ "$REVERSE" = 1 ] && echo 'dedicated -> multiplex' || echo 'multiplex -> dedicated'))"
  if [ "$APPLY" = 1 ]; then
    render_copy_taskdef "$src_fs" "$dst_fs" > "/tmp/$COPY_FAMILY.json"
    aws ecs register-task-definition --cli-input-json "file:///tmp/$COPY_FAMILY.json" \
      --region "$AWS_REGION" --query 'taskDefinition.family' --output text >/dev/null
    TASK_ARN="$(aws ecs run-task --cluster "$CLUSTER" --task-definition "$COPY_FAMILY" \
      --launch-type FARGATE --region "$AWS_REGION" \
      --network-configuration "awsvpcConfiguration={subnets=[$(
        printf '"%s",' "${SUBNETS[@]}" | sed 's/,$//')],securityGroups=[\"$SECURITY_GROUP_ID\"],assignPublicIp=ENABLED}" \
      --overrides "{\"containerOverrides\":[{\"name\":\"copy\",\"command\":[$(
        jq -Rn --arg c "$cmd" '$c')]}]}" \
      --query 'tasks[0].taskArn' --output text)"
    say "copy task $TASK_ARN — waiting"
    aws ecs wait tasks-stopped --cluster "$CLUSTER" --tasks "$TASK_ARN" --region "$AWS_REGION"
    CODE="$(aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$TASK_ARN" --region "$AWS_REGION" \
      --query 'tasks[0].containers[0].exitCode' --output text)"
    [ "$CODE" = "0" ] || die "copy task exited $CODE — see $LOG_GROUP / $COPY_FAMILY"
    say "copy OK (verify file counts in $LOG_GROUP, stream prefix $COPY_FAMILY)"
  else
    say "[dry-run] register $COPY_FAMILY + run-task: $cmd"
  fi
}
[ "$SKIP_COPY" = 1 ] || [ "$ROLLBACK" = 1 ] || copy_state
[ "$COPY_ONLY" = 1 ] && { say "copy-only done"; exit 0; }

# ------------------------------------------------- dedicated task def
render_org_taskdef() {
  cat <<JSON
{
  "family": "$SVC",
  "requiresCompatibilities": ["FARGATE"],
  "networkMode": "awsvpc",
  "cpu": "$CPU", "memory": "$MEMORY",
  "taskRoleArn": "$TASK_ROLE_ARN",
  "executionRoleArn": "$EXECUTION_ROLE_ARN",
  "volumes": [{"name": "data", "efsVolumeConfiguration": {
    "fileSystemId": "$ORG_FS_ID", "rootDirectory": "/", "transitEncryption": "ENABLED"}}],
  "containerDefinitions": [{
    "name": "$SVC", "image": "$ECR_IMAGE", "essential": true,
    "portMappings": [{"containerPort": 8080, "hostPort": 8080, "protocol": "tcp"}],
    "environment": [
      {"name": "PORT", "value": "8080"},
      {"name": "AWS_REGION", "value": "$AWS_REGION"},
      {"name": "BENCHY_ORG", "value": "$ORG"}
    ],
    "secrets": [
      {"name": "API_SERVER_KEY", "valueFrom": "$SECRET_API_KEY"},
      {"name": "AWS_BEARER_TOKEN_BEDROCK", "valueFrom": "$SECRET_BEDROCK"}
    ],
    "mountPoints": [{"sourceVolume": "data", "containerPath": "/opt/data", "readOnly": false}],
    "healthCheck": {"command": ["CMD-SHELL", "curl -fsS http://127.0.0.1:8080/health || exit 1"],
      "interval": 30, "timeout": 10, "retries": 5, "startPeriod": 300},
    "logConfiguration": {"logDriver": "awslogs", "options": {
      "awslogs-group": "$LOG_GROUP", "awslogs-region": "$AWS_REGION",
      "awslogs-stream-prefix": "$SVC"}}
  }]
}
JSON
}

if [ "$RENDER_ORG" = 1 ]; then
  [ -n "$ORG_FS_ID" ] || die "ORG_FS_ID / ORG_${ORG_UPPER}_FS_ID is required to render the org task definition"
  render_org_taskdef
  exit 0
fi

# ------------------------------------------------------------- rollback
find_rule() {
  aws elbv2 describe-rules --listener-arn "$LISTENER_ARN" --region "$AWS_REGION" \
    --query "Rules[?Conditions[?Field=='host-header' && contains(HostHeaderConfig.Values, '$ORG_HOSTNAME')]].RuleArn" \
    --output text
}
rule_target() {
  aws elbv2 describe-rules --rule-arns "$1" --region "$AWS_REGION" \
    --query 'Rules[0].Actions[?Type==`forward`].ForwardConfig.TargetGroups[0].TargetGroupArn' --output text
}

if [ "$ROLLBACK" = 1 ]; then
  RULE_ARN="$(find_rule)"; [ -n "$RULE_ARN" ] || die "no listener rule for $ORG_HOSTNAME"
  CURRENT="$(rule_target "$RULE_ARN")"
  if [ "$CURRENT" = "$MULTIPLEX_TG_ARN" ]; then
    say "rule already points at the multiplex — nothing to do"
  else
    x aws elbv2 modify-rule --rule-arn "$RULE_ARN" --region "$AWS_REGION" \
      --actions "Type=forward,TargetGroupArn=$MULTIPLEX_TG_ARN"
  fi
  if [ "$KEEP_SERVICE" = 0 ]; then
    x aws ecs update-service --cluster "$CLUSTER" --service "$SVC" \
      --desired-count 0 --region "$AWS_REGION" --no-cli-pager >/dev/null
  fi
  [ "$APPLY" = 1 ] && curl -fsS --max-time 15 "https://$ORG_HOSTNAME/health" >/dev/null \
    && say "rollback verified: https://$ORG_HOSTNAME/health OK (served by the multiplex)"
  say "rollback done — set tier back to shared in orgs.yaml when ready"
  exit 0
fi

# ------------------------------------------------- target group + service
TG_ARN="$(aws elbv2 describe-target-groups --names "$TG_NAME" --region "$AWS_REGION" \
  --query 'TargetGroups[0].TargetGroupArn' --output text 2>/dev/null || true)"
if [ -z "$TG_ARN" ] || [ "$TG_ARN" = "None" ]; then
  VPC_ID="$(aws elbv2 describe-target-groups --target-group-arns "$MULTIPLEX_TG_ARN" \
    --region "$AWS_REGION" --query 'TargetGroups[0].VpcId' --output text)"
  say "creating target group $TG_NAME in $VPC_ID"
  if [ "$APPLY" = 1 ]; then
    TG_ARN="$(aws elbv2 create-target-group --name "$TG_NAME" --protocol HTTP --port 8080 \
      --target-type ip --vpc-id "$VPC_ID" --health-check-path /health \
      --health-check-interval-seconds 30 --healthy-threshold-count 2 \
      --matcher HttpCode=200 --region "$AWS_REGION" \
      --query 'TargetGroups[0].TargetGroupArn' --output text)"
  else TG_ARN="arn:aws:elasticloadbalancing:DRYRUN/$TG_NAME"; fi
else
  say "target group $TG_NAME already exists"
fi

say "registering task definition $SVC"
if [ "$APPLY" = 1 ]; then
  render_org_taskdef > "/tmp/$SVC-td.json"
  aws ecs register-task-definition --cli-input-json "file:///tmp/$SVC-td.json" \
    --region "$AWS_REGION" --query 'taskDefinition.taskDefinitionArn' --output text
else
  say "[dry-run] aws ecs register-task-definition (family $SVC, EFS $ORG_FS_ID at /opt/data)"
fi

SVC_STATE="$(aws ecs describe-services --cluster "$CLUSTER" --services "$SVC" --region "$AWS_REGION" \
  --query 'services[0].status' --output text 2>/dev/null || true)"
if [ "$SVC_STATE" = "ACTIVE" ]; then
  x aws ecs update-service --cluster "$CLUSTER" --service "$SVC" --desired-count 1 \
    --force-new-deployment --region "$AWS_REGION" --no-cli-pager >/dev/null
else
  say "creating service $SVC (was: ${SVC_STATE:-missing})"
  x aws ecs create-service --cluster "$CLUSTER" --service-name "$SVC" \
    --task-definition "$SVC" --desired-count 1 --launch-type FARGATE \
    --network-configuration "awsvpcConfiguration={subnets=[$(
      printf '"%s",' "${SUBNETS[@]}" | sed 's/,$//')],securityGroups=[\"$SECURITY_GROUP_ID\"],assignPublicIp=ENABLED}" \
    --load-balancers "targetGroupArn=$TG_ARN,containerName=$SVC,containerPort=8080" \
    --region "$AWS_REGION" --no-cli-pager >/dev/null
fi

# ------------------------------------------------- wait healthy + cutover
if [ "$APPLY" = 1 ]; then
  say "waiting for $TG_NAME to report healthy (timeout ${HEALTH_TIMEOUT}s)"
  deadline=$(( $(date +%s) + HEALTH_TIMEOUT ))
  while :; do
    STATE="$(aws elbv2 describe-target-health --target-group-arn "$TG_ARN" --region "$AWS_REGION" \
      --query 'TargetHealthDescriptions[0].TargetHealth.State' --output text 2>/dev/null || true)"
    [ "$STATE" = "healthy" ] && break
    [ "$(date +%s)" -lt "$deadline" ] || die "target not healthy after ${HEALTH_TIMEOUT}s (state: ${STATE:-none}) — service kept, rule NOT touched; investigate, then re-run"
    sleep 10
  done
fi

RULE_ARN="$(find_rule)"; [ -n "$RULE_ARN" ] || die "no listener rule for $ORG_HOSTNAME — cutover cannot proceed"
CURRENT="$(rule_target "$RULE_ARN")"
if [ "$CURRENT" = "$TG_ARN" ]; then
  say "rule already points at $TG_NAME — cutover already done"
else
  x aws elbv2 modify-rule --rule-arn "$RULE_ARN" --region "$AWS_REGION" \
    --actions "Type=forward,TargetGroupArn=$TG_ARN"
fi

if [ "$APPLY" = 1 ]; then
  curl -fsS --max-time 15 "https://$ORG_HOSTNAME/health" >/dev/null \
    || die "post-cutover health check failed — consider --rollback"
  say "verified: https://$ORG_HOSTNAME/health OK (served by the dedicated service)"
fi

say "peel complete. Remaining manual step:"
say "  set '- id: $ORG ... tier: dedicated' in orgs.yaml and redeploy the multiplex"
say "  (the startup will then skip this profile; its hostname keeps working)"
