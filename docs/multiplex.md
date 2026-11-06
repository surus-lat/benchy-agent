# Modo multiplex: un Hermes, un profile por org

Fase 1 del roadmap de consolidación de benchy-agent: en vez de un servicio ECS
Fargate por org (agent-surus, agent-conicet, agent-untref), **un solo
contenedor** corre un gateway Hermes en modo multiplex y sirve todas las orgs,
una por profile de Hermes.

Estado: implementado y validado localmente en el sandbox (docker), sin tocar
prod. Este documento es la referencia de diseño, los gaps encontrados, y el
plan de rollout a staging.

## 1. Cómo se activa

El switch es declarativo: `/opt/benchy/orgs.yaml` (instalado desde
`apps/agent/orgs.yaml` en la imagen, override con `BENCHY_ORGS_YAML`).

- **orgs.yaml ausente o con 0–1 orgs `tier: shared`** → el contenedor se
  comporta exactamente como hoy (single-profile legacy). `04-benchy-multiplex`
  es un no-op y no toca nada.
- **≥2 orgs `tier: shared`** → modo multiplex: `04-benchy-multiplex`
  (cont-init, corre como root después de `03-benchy-setup` y antes del
  gateway) aprovisiona un profile por org.

`tier: dedicated` declara la intención de que esa org siga en su propio
contenedor (Fase 2); hoy el script simplemente la salta.

## 2. orgs.yaml

Schema (estable, lo consume también la Fase 2):

```yaml
orgs:
  - id: surus                      # identificador de org (secrets file <id>.env)
    profile: surus                 # profile de Hermes (id válido: [a-z0-9][a-z0-9_-]{0,63})
    hostnames:                     # TODOS los Host que mapean a esta org
      - surus.benchy.surus.lat
      - agent-surus.agents.getbenchy.lat
    secrets_arn: arn:aws:secretsmanager:us-east-1:354918377724:secret:benchy/org-surus
    mcps: [benchy]                 # allowlist de mcp_servers del template
    model: default                 # override de model.default ("default" = sin override)
    tier: shared                   # shared | dedicated
    limits:
      max_sessions: 10
      max_cron_workers: 2
```

Se soportan los dos patrones de hostname en uso: `<org>.benchy.surus.lat`
(pedido por diseño) y `agent-<org>.agents.getbenchy.lat` (ALB de producción,
verificado contra el ALB real).

### Secretos

Diseño objetivo: un secreto de Secrets Manager por org (`secrets_arn`,
`benchy/org-<id>`). Implementación de Fase 1: el task def monta el material ya
resuelto en `/opt/benchy/orgs/<id>.env` (mismo patrón que usa el 03 para
`/opt/benchy/agent.env`); el 04 lo instala como `.env` del profile
(`hermes:hermes 0600`). Debe contener `API_SERVER_KEY` (bearer del profile) y
`AWS_BEARER_TOKEN_BEDROCK`. El ARN queda declarado para que la Fase 2 lo
resuelva en el task def sin tocar la imagen.

**Fail-closed:** una org shared sin su `<id>.env` aborta el boot (FATAL). Un
deployment roto es mejor que uno degradado silenciosamente.

## 3. Boot (04-benchy-multiplex)

Por cada org shared, idempotente:

1. `hermes profile create <profile> --no-skills --no-alias` si no existe
   (fallback: crear el directorio).
2. `.env` del profile desde `/opt/benchy/orgs/<id>.env` + se pinea
   `BENCHY_WORKSPACE=<profile_dir>/workspace`.
3. `config.yaml` del profile renderizado desde el template de la imagen
   (`/opt/benchy/config.yaml`): override de `model.default`,
   `gateway.max_concurrent_sessions` desde `limits.max_sessions`, y allowlist
   de `mcp_servers` según `mcps:`.
4. `SOUL.md` pineado (misma persona que el default).
5. Reserva de skills core (`/opt/benchy/skills/*`) como directorios
   root-owned 0555 en el profile — nadie puede sombrearlos por profile
   (espejo del paso 4 de 03-benchy-setup).
6. Limpieza de artefactos stale del gateway (`gateway.pid`, `gateway.lock`,
   `gateway.sock`, `gateway.heartbeat`, `gateway.loop-tick.*.sock`) en el
   profile: en un container nuevo cualquiera de estos es stale por definición.

Además, en modo multiplex se sincronizan `API_SERVER_KEY` y
`AWS_BEARER_TOKEN_BEDROCK` del env del container hacia `$HERMES_HOME/.env`
(root). **Por qué:** en multiplex el gateway recarga la config primaria con un
scope de env del profile default y *una falta en el scope NO cae al env del
proceso* (`load_gateway_config_for_runner` en `gateway/run.py`). El bridge de
env `API_SERVER_KEY → api_server.enabled` (`gateway/config_env.py`) lee ese
scope: sin la key en el `.env` root, el adapter `api_server` nunca se
habilita y el listener 8642 no existe (verificado empíricamente; en modo
legacy la carga es sin scope y sí ve el env del proceso).

El gateway arranca después (CMD del container), detecta ≥2 profiles y entra en
multiplex standalone (veredicto registrado en `gateway_state.json` con
`served_profiles`).

## 4. Routing: cómo llega un request al profile correcto

Investigado en el fuente de Hermes (0.21.7, `gateway/platforms/api_server.py`
y `gateway/run_adapters.py`):

- El profile **default es dueño del único listener** (127.0.0.1:8642) y sirve
  a todos los profiles espejo bajo el prefijo de path **`/p/<profile>/...`**
  (`serves_profile_prefix` / `SHARED_LISTENER_MIRROR_PLATFORMS`).
- **Autenticación por profile:** el bridge de env deja la `API_SERVER_KEY` de
  cada profile secundario en el `extra` del adapter; el api_server valida el
  bearer del request contra la key DEL PROFILE del prefijo. La key root NO es
  aceptada en `/p/<org>/` y la key de una org NO es aceptada en otra
  (verificado: ambas devuelven 401).
- El proxy benchy (`apps/agent/proxy/benchy_proxy.py`) mapea
  `Host` → org vía `orgs.yaml` y forwardea a
  `http://127.0.0.1:8642/p/<profile>/`. Un Host desconocido devuelve 404
  fail-closed. En modo legacy (orgs.yaml ausente/1 org) el proxy no registra
  el middleware de tenancy y forwardea al upstream plano, como hoy.
- Los endpoints locales del proxy (`/health`, `/benchy/*`) no atraviesan el
  listener: se resuelven in-process. En multiplex el middleware fija el
  workspace de la org en un contextvar (`_workspace()` en
  `mcp/benchy_shared.py`), de modo que `/benchy/*` lee/escribe SIEMPRE dentro
  de `profiles/<profile>/workspace` de la org del Host. Los imports de los
  módulos `benchy_*` son in-process; el contextvar hace seguro el multiplex
  por request (asyncio single-thread).

## 5. Límites por org

| límite | estado | detalle |
|---|---|---|
| `max_sessions` | **implementado** | `gateway.max_concurrent_sessions` en el config.yaml renderizado del profile. El registry de admisión vive en `<profile_home>/runtime/active_sessions.json`, así que el cap es **por profile** (fuente: `hermes_cli/active_sessions.py`, `gateway/run_inbound.py`). Verificado en los configs renderizados. |
| `max_cron_workers` | **gap** | No existe knob de concurrencia de cron por profile en Hermes 0.21.7. El scheduler de cron es por profile (cada profile tiene su `cron/`), pero no hay cap de workers simultáneos. Opciones para Fase 2: enforce a nivel proxy/ingress de jobs, o contribuir el knob upstream. Se conserva el campo en orgs.yaml (schema estable) aunque hoy no se aplica. |

## 6. Aislamiento

Cada profile es un Hermes home completo bajo `$HERMES_HOME/profiles/<p>/`:
`config.yaml`, `.env` (0600 hermes), `workspace/`, `SOUL.md`, `skills/`,
`cron/`, `sessions/`, `state/`, cache y memoria propios. Profiles NO son un
security boundary de OS (mismo UID `hermes`, mismo filesystem): el aislamiento
es lógico (state + auth por profile + workspace por request), suficiente para
orgs que ya comparten el cluster, no para tenants hostiles.

## 7. Log split por org (diseño)

Hoy todo el stdout del container va a un solo log group de CloudWatch. Para
separar por org:

1. **Tag en origen (recomendado):** el gateway ya loguea con el profile en el
   contexto en varias líneas, pero no de forma garantizada. Propuesta: emitir
   logs estructurados (JSON) con campo `profile` en el api_server y en el
   proxy (el proxy YA conoce la org por request — añadir `"org": <id>` a sus
   líneas de log es trivial). Los logs del agente por turno viven además en
   `profiles/<p>/logs/`.
2. **CloudWatch:** un log group por servicio multiplex con **metric/subscription
   filters** sobre el campo `profile` (si JSON) o sobre el patrón
   `[profile=<p>]` en el mensaje. Cada filter alimenta el stream/dashboard de
   su org. No hace falta sidecar mientras el volumen de logs sea el actual.
3. **Alternativa sidecar (si hiciera falta):** un vector/fluent-bit en el
   mismo task leyendo `profiles/*/logs/*.log` del EFS y enrutando por path —
   más moving parts, solo justificado si se requiere retención distinta por
   org.

El proxy ya registra `org=<id>` en sus mensajes de request; extender ese tag
al resto de líneas es el paso 1.

## 8. Validación local (sandbox, docker)

Imagen `benchy-agent-multiplex:test` (overlay test-only sobre
`benchy-agent:latest` con los archivos de esta rama), volumen docker nuevo,
secrets fake por org en `/opt/benchy/orgs/`. 3 orgs: surus, conicet, untref.

| chequeo | resultado |
|---|---|
| boot multiplex | OK — 3 profiles creados vía `hermes profile create`; `served_profiles: [default, conicet, surus, untref]` en gateway_state.json |
| bind del gateway | OK — `/v1/models` 200 en ~25s (tras el fix del `.env` root, §3) |
| routing por Host | OK — las 3 orgs 200 con su key en `/v1/models`; ambos patrones de hostname |
| auth por profile | OK — key cruzada 401, key root en host de org 401, sin auth 401 |
| aislamiento workspace | OK — PUT vía surus escribe en `profiles/surus/workspace/`; GET vía conicet 404; GET vía surus 200; list por org solo ve lo suyo |
| state dirs por profile | OK — `profiles/<p>/{config.yaml,.env,workspace,SOUL.md,skills,cron,...}` |
| `max_concurrent_sessions` por profile | OK — presente en los config.yaml renderizados |
| restart del container | OK — `docker restart`, API 200 en ~5s, routing y workspace intactos, **0 lock refusals** |

Notas de validación:

- **Bug del lock:** el escenario prod (registros stale de OTRO container en
  EFS compartido con colisión de PID entre namespaces) no es reproducible con
  un solo container local. Lo que sí se validó: N restarts consecutivos del
  container con el volumen persistente → el gateway arranca siempre, sin
  "Refusing to start a second gateway". Además el 04 barre los artefactos de
  lock en los profiles en cada boot (§3.6). La higiene de los artefactos del
  ROOT (`/opt/data`) en EFS es dominio de la Fase 0 (deploy safety).
- **Churn conocido:** el runtime de Hermes sincroniza skills al profile en
  cada arranque; el 04 vuelve a borrar las que sombrean skills core
  (ver logs `[benchy-multiplex] removing profile ... shadow`). Es inofensivo
  pero ruidoso; si molesta, desactivar el sync para skills pineadas.
- **Primera creación de profiles es lenta** (~2–3 min para 3 orgs: el CLI
  siembra cada home de profile). Solo ocurre con volumen vacío; los restarts
  con volumen existente tardan ~5s.

Comandos y outputs clave: ver el cuerpo del PR.

## 9. Rollout a staging

> **Activation is opt-in:** multiplex mode only boots when the service task def sets
> `BENCHY_MULTIPLEX=1`. The image ships `orgs.yaml` as the canonical roster; without
> the env gate every dedicated per-org service would convert itself into a multiplex
> instance on its next deploy. The multiplex staging/prod services must set the
> variable; the dedicated per-org services must never set it.


Pre-requisitos: imagen `benchy-agent:<tag>` construida desde esta rama (push a
ECR), secrets `benchy/org-<id>` creados en Secrets Manager para las orgs de
prueba (o archivos `.env` vía el mecanismo actual del task def).

1. **Task def staging** (`benchy-agent-mux-staging`): misma familia que
   `agent-surus` con tres cambios: (a) imagen nueva; (b) EFS **nuevo y vacío**
   (montar el EFS de prod mezclaría state legacy con profiles — prohibido);
   (c) env/volumen con los `.env` por org en `/opt/benchy/orgs/` (hoy el
   equivalente al mecanismo de `/opt/benchy/agent.env`).
2. **Orgs:** 2 dummy (`muxtest-a`, `muxtest-b` en un orgs.yaml de staging, con
   secrets fake) + 1 real chica (untref, la de menor tráfico).
3. **Red:** target group nuevo + regla de ALB en staging para los hostnames de
   las 3 orgs apuntando al servicio multiplex. Prod sigue intacto en sus
   servicios actuales.
4. **Validación en staging:**
   - boot: logs `[benchy-multiplex]` + `served_profiles` en gateway_state.json;
   - routing E2E por Host contra el ALB (misma matriz de §8);
   - aislamiento: PUT/GET cruzado entre orgs;
   - `aws ecs stop-task` → la tarea de reemplazo arranca sin lock refusal
     (este SÍ ejercita EFS compartido entre tareas);
   - una sesión real del agente por org (turno con tool calls MCP);
   - cron: un job en cada profile, verificar que corre en su profile.
5. **Go/No-Go para Fase 2:**
   - GO: todos los chequeos anteriores verdes durante ≥1 semana, latencia
     p95 del proxy comparable al servicio dedicado (±20%), cero lock refusals
     en replacements de tarea, cero cruces de state entre orgs.
   - NO-GO: cualquier cruce de auth/state entre orgs, lock bug reproducido en
     replacement, o degradación de latencia >20% sostenida.
6. **Fase 2 (fuera de scope aquí):** migración org por org apuntando el ALB de
   prod al servicio multiplex, congela-descongela con el EFS legacy como
   rollback; `tier: dedicated` para cualquier org que necesite quedarse
   aislada; resolución de `secrets_arn` directa en task def; cierre del gap de
   `max_cron_workers`.
