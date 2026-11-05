# Multiplex migration runbook — moving an org to the shared agent

Written for the operator moving one organization from its dedicated ECS
service (one Hermes container per org) to the multiplex agent (one Hermes
container, one Hermes profile per org), and back. Assumes no prior context
on this infrastructure; read top to bottom before touching anything.

Status as of 2026-11-05: **not yet rehearsed**. Steps marked
`[VALIDATE IN STAGING]` have never been executed against a live org and
must be rehearsed once in a staging environment before the first real
migration. Where this document and the AWS account disagree, AWS wins —
every data-gathering step names the read-only command that settles it.

Companion files:

- `scripts/peel-org.sh` — the escape hatch: detaches one org from the
  multiplex back to its own dedicated ECS service. Dry-run by default.
- `scripts/peel-org.env.example` — every resource identifier the script
  and this runbook need, as variables. The filled file lives in the ops
  vault, **never in git** (this repository is public).

## The two shapes

Today — one service per org:

```
Worker benchy-api ──► agent-<org>.agents.getbenchy.lat  (ALB benchy-agents, host rule)
                          └─► target group benchy-agent-<org>
                                └─► ECS service agent-<org> (cluster benchy, 1 task)
                                      Hermes gateway + proxy :8080, $HERMES_HOME=/opt/data
                                      volume: the org's own EFS, mounted at /
```

Target — one multiplex service, one Hermes profile per org:

```
Worker benchy-api ──► agent-<org>.agents.getbenchy.lat  (same ALB, same host rule)
                          └─► target group benchy-agent-multiplex
                                └─► ECS service agent-multiplex (cluster benchy, 1 task)
                                      proxy routes by Host header ──► Hermes profile <org>
                                      orgs.yaml declares every org; one profile dir per org
                                      volume: the multiplex EFS, profiles/<org>/ per org
```

An org with `tier: dedicated` in `orgs.yaml` keeps the first shape: the
multiplex startup skips it and it lives in its own service. Both shapes
coexist indefinitely; `tier` is the switch.

## The load-bearing invariant

**The public hostname never changes.** The Worker resolves each org to
`agent-<org>.agents.getbenchy.lat` from D1 (`orgAgentEndpoints`) and calls
it with the org's bearer key. Every cutover and rollback in this runbook
is a retarget of the ALB host-header rule for that hostname — the Worker,
D1, DNS, TLS certificate and the org's users never see a change. If a step
would change the hostname, the step is wrong.

## orgs.yaml contract

Owned by the multiplex workstream; reproduced here because this runbook
edits it. The startup reads it from the image / multiplex EFS
`[VALIDATE IN STAGING: exact path and reload semantics]`:

```yaml
orgs:
  - id: surus
    profile: surus
    hostnames: [agent-surus.agents.getbenchy.lat]
    secrets_arn: arn:aws:secretsmanager:us-east-1:<account>:secret:benchy/org-surus
    mcps: [benchy]
    model: default
    tier: shared        # shared | dedicated
    limits:
      max_sessions: 10
      max_cron_workers: 2
```

How `tier` governs startup:

- `shared` — the startup ensures `profiles/<id>/` exists on the multiplex
  EFS (importing from the org's declared source on first boot), fetches
  `secrets_arn` into the profile's environment, and the proxy serves the
  declared `hostnames` from this profile.
- `dedicated` — the startup **skips** the org: no profile is created, no
  secrets are fetched, and the proxy answers its hostnames with 503. The
  org is expected to be served by its own ECS service (this is the state
  `scripts/peel-org.sh` leaves behind — it prints the `orgs.yaml` edit the
  operator must commit).

`limits` is enforced by the multiplex `[VALIDATE IN STAGING: enforcement
point]`; it is the first knob to reach for when one org crowds out the
others, before peeling.

## 0. Inventory and identifiers

Everything below is parameterized. Fill a copy of
`scripts/peel-org.env.example` first; every command here assumes it is
sourced. All discovery commands are read-only:

```bash
aws sts get-caller-identity                                  # ACCOUNT_ID
aws ecs list-services --cluster benchy                       # service names
aws ecs describe-task-definition --task-definition agent-<org> \
  --query 'taskDefinition.{vols:volumes,secrets:containerDefinitions[0].secrets,env:containerDefinitions[0].environment}'
aws elbv2 describe-listeners \
  --load-balancer-arn "$ALB_ARN"                             # listener 443 ARN
aws elbv2 describe-rules --listener-arn "$LISTENER_ARN"      # host rules, one per org
aws elbv2 describe-target-groups --names benchy-agent-<org>  # health check: /health, ip:8080
```

Verified when this runbook was written (re-verify — drift happens): each
`agent-<org>` task runs 1 vCPU / 4 GiB, roles `benchy-task` /
`benchy-task-exec`, env `PORT=8080 AWS_REGION=us-east-1 BENCHY_ORG=<org>`,
two secrets (`API_SERVER_KEY`, `AWS_BEARER_TOKEN_BEDROCK`) from the org's
Secrets Manager entries, its EFS mounted at `/opt/data` with transit
encryption, logs to `/ecs/benchy-agent` with stream prefix `agent-<org>`,
health endpoint `/health` (unauthenticated), target type `ip`.

## 1. Pre-flight (per org)

Do every item; none is optional. Estimated elapsed time: 1–2 days, mostly
waiting for the backup and the communication window.

- [ ] **Back up the org's EFS.** Automatic backups are **not enabled** on
  these file systems today (verified: `describe-backup-policy` returns
  none). Either enable them and wait for the first recovery point:

  ```bash
  aws efs put-backup-policy --file-system-id "$ORG_FS_ID" \
    --backup-policy Status=ENABLED
  aws backup list-recovery-points-by-backup-vault --backup-vault-name Default \
    --by-resource-arn "arn:aws:elasticfilesystem:$AWS_REGION:$ACCOUNT_ID:file-system/$ORG_FS_ID"
  ```

  …or take a manual tar with a one-off task (the §2.2 copy pattern with
  `tar -czf /dst/<org>-<date>.tar.gz -C /src .` instead of `cp -a`) onto
  another EFS. Shipping the tar to S3 additionally needs the AWS CLI in
  the copy image and S3 permissions on the task role — neither is in
  place today. `[VALIDATE IN STAGING: restore one backup]` — an
  unrestored backup is a rumor.
- [ ] **Decide the state strategy (§2.1) and write it in the migration
  ticket.** Whole-directory copy is the default.
- [ ] **Verify the org's secrets exist and are readable.** The multiplex
  startup will fetch them by `secrets_arn`; a missing or mistyped ARN
  fails the org's profile at boot:

  ```bash
  aws secretsmanager describe-secret --secret-id "$ORG_SECRETS_ARN"
  aws secretsmanager get-secret-value --secret-id "$ORG_SECRETS_ARN" \
    --query 'SecretString' --output text | jq -e 'has("API_SERVER_KEY") and has("AWS_BEARER_TOKEN_BEDROCK")'
  ```

  (Print only the keys, never the values.) If the org still has two
  separate per-key secrets from the dedicated-service era, consolidate
  them into the single JSON secret `secrets_arn` points at, or extend the
  startup — pick one and record it. `[VALIDATE IN STAGING: exact secret
  schema the startup expects]`
- [ ] **Communicate the downtime window.** Expected impact: the org's
  agent unreachable for ~5–15 minutes during cutover; the web app stays
  up. Template:

  > El <fecha> entre <hh:mm> y <hh:mm> UTC migraremos el agente de <org> a
  > nueva infraestructura. Durante ese lapso el agente no responderá; la
  > interfaz web y los benchmarks ya generados siguen disponibles. No hace
  > falta ninguna acción de su parte.

- [ ] **Confirm the multiplex is healthy for its current orgs** — a
  migration into a sick multiplex migrates into a failure:
  `aws elbv2 describe-target-health --target-group-arn "$MULTIPLEX_TG_ARN"`,
  plus one chat against a hostname already on the multiplex.
- [ ] **Open a tracking ticket** with this checklist copied in; check
  items off with timestamps. Rollbacks are decided from it (§4).

## 2. Migration

### 2.1 What migrates, what does not

The dedicated service keeps the org's whole Hermes home at the root of
its EFS: `config.yaml`, `SOUL.md`, `skills/`, `memories/`, `workspace/`,
`cron/`, sessions and the state database. `config.yaml` and `SOUL.md` are
pinned by the image and re-installed on every boot — copying them is
harmless but pointless.

| Strategy | Command shape | Sessions | Cron jobs | When |
|---|---|---|---|---|
| **Whole-directory copy** (default) | copy `/` of the org EFS → `profiles/<org>/` on the multiplex EFS | Preserved | Preserved | Continuity matters; the org has live cron jobs |
| Selective copy | copy only `skills/ memories/ workspace/ cron/` | Lost | Preserved | Clean slate for conversations, keep the work |
| Minimal copy | copy only `skills/ memories/ workspace/` | Lost | Recreate by hand | New-start migrations |

Note: `hermes profile export` is **not** the mechanism here — the
dedicated services don't run profiles, and the standard export leaves
sessions and cron behind. Direct directory copy preserves everything a
profile export would, plus what it wouldn't. The export/import pair is
only relevant org→profile when the source is itself a profile.

`[VALIDATE IN STAGING]` the exact set of dotfiles and state files Hermes
keeps at `$HERMES_HOME` root (state DB, locks) and whether any of them is
machine-bound (§6).

### 2.2 Copy the state

Both EFS file systems are only reachable from inside the VPC, so the copy
runs as a one-off ECS task mounting both — the same mechanism
`scripts/peel-org.sh` uses in the other direction:

```bash
scripts/peel-org.sh --help   # the copy machinery lives here; for the
                             # inbound direction use --copy-only --reverse
```

`[VALIDATE IN STAGING: the reverse-copy flag is implemented]` — until it
is, run the copy by hand: register the copy task definition the script
renders (`--render-copy-taskdef`), swap source and destination, `aws ecs
run-task`, wait, and confirm exit code 0. Verify after the copy, from the
copy task's own logs and a file count on both sides:

```bash
# inside the copy task definition's command, before exit:
echo "SRC files: $(find /src -type f | wc -l)"; echo "DST files: $(find /dst -type f | wc -l)"
```

### 2.3 Declare the org

1. Add the org to `orgs.yaml` with `tier: shared`, its real hostnames,
   `secrets_arn`, and conservative `limits` (start at the schema
   defaults). Open it as a PR; the multiplex picks it up on its next
   deployment. `[VALIDATE IN STAGING: hot-reload vs redeploy]`
2. Render/verify the per-org environment the startup will materialize
   into `profiles/<org>/`: nothing by hand — the startup fetches
   `secrets_arn` and writes what the profile needs. If the profile dir
   was pre-populated by the copy (§2.2), confirm no stale `.env` in it
   contradicts `secrets_arn`.
3. Deploy the multiplex. The org's hostname still points at the
   dedicated service, so this deploy changes nothing for users yet.

### 2.4 Smoke checks (against the multiplex, before cutover)

Target the profile **directly**, not through the public hostname (which
still routes to the old service): the ALB has no path rules, so use the
multiplex task's own reachability — `aws ecs execute-command` into the
task if enabled, or temporarily attach a test listener rule with a
canary hostname. `[VALIDATE IN STAGING: canary path]`

- [ ] Health: `curl -fsS http://<task>:8080/health` → 200.
- [ ] One chat, with the org's `API_SERVER_KEY` as bearer and a
  `Host: agent-<org>.agents.getbenchy.lat` header — proves the proxy
  routes the hostname to the right profile and the profile's secrets
  work: `curl -fsS -H "Authorization: Bearer $API_SERVER_KEY" -H "Host:
  agent-<org>.agents.getbenchy.lat" http://<task>:8080/<chat endpoint>`
  Expect a normal Hermes reply; a 401 means the secrets wiring is wrong,
  a 503 means the profile wasn't created.
- [ ] One cron: add a trivial job to the profile, watch it fire in the
  task logs (`/ecs/benchy-agent`, multiplex stream), then remove it.
- [ ] Skills: confirm the core `benchy-*` skills resolve inside the
  profile (the image pins them read-only).

## 3. Cutover

1. Find the org's rule and retarget it to the multiplex target group:

   ```bash
   RULE_ARN=$(aws elbv2 describe-rules --listener-arn "$LISTENER_ARN" \
     --query "Rules[?Conditions[?Field=='host-header' && contains(HostHeaderConfig.Values, 'agent-<org>.agents.getbenchy.lat')]].RuleArn" \
     --output text)
   aws elbv2 modify-rule --rule-arn "$RULE_ARN" \
     --actions Type=forward,TargetGroupArn="$MULTIPLEX_TG_ARN"
   ```

2. **Scale the old service to 0 — do not delete it.** If a benchmark
   evaluation could be in flight, wait out the target-group draining
   period (300 s by default) first; see §6 for why:

   ```bash
   aws ecs update-service --cluster benchy --service agent-<org> --desired-count 0
   ```

   It stays at 0 for **7 days** as a hot rollback: its task definition,
   target group, EFS and secrets all remain in place.
3. Verify through the public hostname: `curl -fsS
   https://agent-<org>.agents.getbenchy.lat/health`, then repeat the §2.4
   chat check through the public URL, then watch the multiplex logs for
   the org's traffic for 15 minutes.
4. Record the cutover time and the rule ARN in the tracking ticket.

## 4. Rollback

Decide fast; the rollback is two API calls and ~2 minutes.

**Criteria — roll back when any holds:**

- The multiplex fails health checks for the org's hostname for > 5
  consecutive minutes after cutover.
- The org's chat smoke check fails and the cause is not understood within
  30 minutes.
- Data integrity doubt: anything in the org's workspace reads wrong,
  missing, or cross-org.
- The multiplex's other tenants degrade in a way attributable to the new
  profile.

**Do not roll back for:** slow first responses (cold profile), a single
failed cron tick with clear logs, or cosmetic log noise.

**Procedure:**

```bash
aws ecs update-service --cluster benchy --service agent-<org> --desired-count 1
aws elbv2 modify-rule --rule-arn "$RULE_ARN" \
  --actions Type=forward,TargetGroupArn="$ORG_TG_ARN"
aws elbv2 describe-target-health --target-group-arn "$ORG_TG_ARN"   # wait for healthy
curl -fsS https://agent-<org>.agents.getbenchy.lat/health
```

Order matters: service first, rule second — never point the rule at a
target group with no healthy tasks. Then set the org back to
`tier: dedicated` in `orgs.yaml` at leisure (the multiplex keeps 503ing
its hostname until then — harmless, the ALB no longer sends it traffic).
Post-mortem before retrying; a second failed migration of the same org
waits for the post-mortem's action items.

## 5. Post-migration

- **Monitoring, one week, reinforced.** Watch: target-group health of the
  multiplex; ALB 5xx by hostname; the multiplex log stream for the org's
  profile errors; Bedrock throttling; EFS throughput credits on the
  multiplex volume (all shared orgs now draw from one file system). If
  the org had per-service CloudWatch alarms, port them to per-profile
  log-metric filters or accept the gap consciously — record which.
- **Deferred deletion, after 7 clean days**, in this order: ALB rule →
  ECS service → target group → task definition revisions → **fresh EFS
  backup** → EFS file system → the dedicated-era secrets. Each step is
  one command; run them on separate days for the last three.
- **Runbook update.** File what surprised you; every `[VALIDATE IN
  STAGING]` marker that survived contact with a real org gets resolved or
  promoted to a known-limitation entry in §6.

## When an org goes the other way: tier dedicated

Run `scripts/peel-org.sh <org> --apply`. It copies the profile out to the
org's EFS, recreates the dedicated service/target-group/rule, cuts the
hostname over, and prints the `orgs.yaml` edit (`tier: dedicated`) that
makes it stick. Dry-run is the default; rehearse with `--dry-run` before
ever needing it for real.

**Decision criteria for moving an org to dedicated** — any one suffices:

| Trigger | Threshold |
|---|---|
| Sustained usage concentration | > 30 % of the multiplex's aggregate tokens or sessions for 2 consecutive weeks |
| Compliance / isolation | A formal request (contract, audit, data-residency) — no usage test applies |
| Independent deploys | The org's SLA requires deploy windows decoupled from the other tenants |
| Noisy neighbor | Two or more incidents in 30 days where the org saturated shared CPU/EFS/sessions and `limits` didn't contain it |
| Operational blast radius | The org's cron workload requires more workers than the multiplex budget allows per profile |

Moving **in** (dedicated → shared) is the default direction of this whole
runbook and needs no usage justification — only that none of the triggers
above currently holds for the org.

## 6. Risks and honest limits

- **Profiles are not an OS security boundary.** All shared orgs live in
  one container, one process user, one kernel. A sandbox escape or a
  credential read in one profile reaches every profile on the multiplex
  and the shared container environment. The image mitigates what it can
  (per-profile env, no terminal toolset for api_server), but if an org's
  threat model requires isolation, the answer is `tier: dedicated`, not a
  stronger profile.
- **What does not migrate** (whole-directory copy notwithstanding):
  - **Session history is fragile.** It copies with the directory, but if
    any session state keys off machine identity, container ID or absolute
    home path, it may not survive the move. Treat session continuity as
    best-effort, and say so in the downtime notice.
    `[VALIDATE IN STAGING: do copied sessions actually resume]`
  - **Bot/token locks that are machine-level.** Any lock or token cache
    bound to the old container identity stays behind. `[VALIDATE IN
    STAGING: does benchy have any — Telegram/Discord bot tokens are not
    part of this deployment today]`
  - **Per-org metric attribution.** CloudWatch logs used to carry the
    org's name in the stream prefix (`agent-<org>`); after migration all
    shared orgs write to the multiplex stream. Bedrock spend per org
    becomes unattributable unless the multiplex tags invocations by
    profile. Plan reporting accordingly.
  - **The old target group's connection draining state** — in-flight
    long requests at cutover finish against the old service only while it
    still has a task. Scale to 0 *after* retargeting and after draining
    (default 300 s) has had a chance; for chat workloads this is
    cosmetic, for a running benchmark evaluation it can truncate output.
    Prefer cutover windows outside active evaluations.
- **Single point of failure, doubled-edged.** The multiplex down means
  every shared org down; a multiplex deploy restarts every shared
  profile. That is the price of consolidation — `tier: dedicated` is the
  way out for orgs that can't pay it.
- **EFS is shared throughput.** One org's large workspace operations can
  consume burst credits the others need. Watch the credits (§5) the same
  way you'd watch CPU.
- **The old dedicated stack rots if kept forever.** Seven days at
  `desired=0` is a rollback path; seven months is an unpatched liability
  and a confusion source. The deferred-deletion checklist (§5) is part of
  the migration, not an optional epilogue.

## Glossary

- **multiplex** — the single ECS service running one Hermes container
  with one profile per org.
- **profile** — a Hermes profile: an isolated directory
  (`profiles/<org>/`) with its own config, skills, memory and state.
- **tier** — `orgs.yaml` field: `shared` (profile on the multiplex) or
  `dedicated` (own ECS service).
- **hot rollback** — the old service kept at `desired=0` with all
  resources intact, restorable in minutes.
- **peel** — moving an org out of the multiplex to dedicated
  (`scripts/peel-org.sh`).
