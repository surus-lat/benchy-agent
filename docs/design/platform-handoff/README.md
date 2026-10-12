# Handoff: benchy agent — plataforma (`/app`)

## Qué es esto

Prototipo navegable de la plataforma completa en `design/Plataforma.dc.html`. Abrilo en el navegador; necesita `support.js` al lado (ya está incluido). Es una **referencia de diseño**, no código para portar: el formato `.dc.html`, los `{{ }}` y `style-hover` son del prototipo. Hay que reconstruirlo en `apps/web` (Vite + React + wouter + Tailwind 4 + shadcn) siguiendo el patrón de `apps/web/src/pages/app/agent-app.tsx` y `app.css`, que ya usan los mismos tokens.

**Fidelidad alta**: colores, tipografía, espaciados, copy y estados son finales. Los datos son de prueba, pero tienen la forma real de `benchmark.yaml`, `exam.jsonl` y `runs/*.json`.

## Los cables pelados

Todos los datos están en constantes al principio del bloque de lógica del `.dc.html`, y cada una dice de dónde sale. Leyenda:

- ✅ la ruta ya existe en el Worker
- ⚠️ el dato existe, pero solo lo ve el agente (vía MCP); falta una ruta HTTP
- ❌ no hay backend

| Pantalla | Dato | Fuente | Estado |
|---|---|---|---|
| Barra superior / Cuenta | nombre, correo, organización | `useSession()` (better-auth) + tabla de orgs por `session.orgId` | ✅ |
| Benchmarks (home + sidebar) | lista de benchmarks | `GET /api/workspace/files`, agrupado por carpeta; una carpeta con `benchmark.yaml` es un benchmark | ✅ |
| | nombre, task/domain/language | parsear `<slug>/benchmark.yaml` (`GET /api/workspace/file`) | ✅ (falta definir dónde vive el nombre legible: hoy el YAML no tiene `title`) |
| | ítems | contar líneas de `<slug>/exam.jsonl` | ✅ |
| | mejor puntaje / última corrida | el `runs/*.json` más nuevo → `benchmark_score` y mtime | ✅ |
| | estado válido / con errores | `benchy_validate` | ⚠️ exponer `POST /api/workspace/validate?path=` |
| Definición | chat | `GET /api/conversations/:id/messages`, `POST /api/conversations` (solo al primer mensaje), `POST /api/conversations/:id/turns` | ✅ |
| | "El agente pregunta" (burbuja ámbar con botones) | hoy la respuesta es markdown plano | ⚠️ necesita un marcador estructurado en la respuesta del agente (por ejemplo, un bloque `ask` con opciones) |
| | panel `benchmark.yaml` | `GET /api/workspace/file?path=<slug>/benchmark.yaml`; refrescar después de cada turno (como hace hoy `refreshFiles`) | ✅ |
| Examen | filas | `exam.jsonl`, una línea `{"input","expected"}` cada una | ✅ |
| | válido / rechazado + código y ruta | validación de cada fila contra el programa | ⚠️ exponerlo desde el motor, o validar en el cliente con el programa compilado |
| Sistemas de IA | modelos disponibles | `benchy_models` | ⚠️ `GET /api/models` |
| | qué sistemas entran en la comparación | hoy es una instrucción al agente (escribe una variante de `ai-system` por modelo) | ⚠️ definir si es un archivo (`<slug>/systems.yaml`) o un mensaje al agente |
| Corridas | progreso por sistema | `benchy_run` es un turno bloqueante y no informa progreso | ⚠️ mientras no haya streaming, usar barras indeterminadas (ya diseñadas). El estado "terminado" sale de que aparezca un `runs/*.json` nuevo |
| Resultados | puntaje, resumen, fallas | `runs/<stem>-<ts>.json` → `benchmark_score`, `summary{examples,valid,invalid_outputs,execution_errors}`, `results[]{status, field_scores, prediction, error}` | ✅ |
| | puntaje por campo | promedio de `field_scores` por campo | ✅ (cálculo en el cliente) |
| | comparación entre modelos | agrupar los `runs/*.json` que comparten benchmark y difieren en `ai-system.model` | ✅ (falta una convención de nombres para saber qué corridas forman una comparación) |
| Historial | versiones del YAML, autor, diff, puntaje | — | ❌ opciones: git en el volumen del workspace, o una tabla en D1 con un snapshot por escritura |
| Cuenta | link mágico / passkey / Google | better-auth (`@better-auth/passkey` ya instalado); `/api/auth-providers` dice qué proveedores están activos | ✅ |
| | idioma | — | ❌ preferencia de usuario; puede vivir en localStorage hasta que haya columna |
| | Salir | `signOut()` de `@/lib/auth-client`, después `location.href = "/"` | ✅ |

### Errores

Reutilizá `errorText()` de `apps/web/src/pages/app/api.ts`: ya tiene el copy para `AGENT_NOT_PROVISIONED`, `AGENT_TIMEOUT`, `AGENT_UNAVAILABLE`, `TURN_IN_PROGRESS`, `UNAUTHENTICATED` y `NETWORK`. El prototipo muestra `AGENT_NOT_PROVISIONED` como banner ámbar en toda la app; el resto aparece en línea, bajo el hilo del chat (como hoy).

## Estados para revisar

El prototipo tiene un control **Estado de datos** en Tweaks:

- **con datos**: el flujo completo
- **vacío**: home sin benchmarks (pip en reposo + CTA "Empezar con el agente")
- **agente no activo**: banner `AGENT_NOT_PROVISIONED`

Dentro del prototipo:

- Examen: filtro Todos / Válidos / Rechazados
- Sistemas: interruptores por modelo
- "Ejecutar comparación" simula la corrida (3 s por modelo) y termina en "Ver resultados"
- Definición: el chat responde y la pregunta del agente tiene botones

## Estructura y navegación

- Barra superior: lockup, organización, correo, botón Cuenta.
- Sidebar (248px): "+ Nuevo benchmark", "Todos los benchmarks" y la lista de benchmarks de la org, con un punto de estado (verde válido / rojo con errores / gris borrador). El ítem activo usa el mismo patrón que `.ba-chat-item.is-active` (fondo `#F6F2EE` + filete ámbar a la izquierda).
- Dentro de un benchmark: encabezado (nombre, ruta del YAML, insignia `✓ benchy_validate`, "Ejecutar comparación") y seis pestañas. La activa lleva un subrayado ámbar de 2px.
- Rutas sugeridas: `/app` (home), `/app/b/:slug/:tab` (tab = `definicion|examen|sistemas|corridas|resultados|historial`), `/app/cuenta`. Las conversaciones siguen yendo en `?c=` como hoy.

## Responsive

- Hasta 1040px, Definición apila el chat sobre el YAML.
- Hasta 860px se oculta la sidebar y el ☰ de la barra superior lleva a la home. Si preferís un drawer, seguí el patrón de `app.css` (`.ba-chats` con `translateX`).
- Hasta 640px se ocultan la organización y el correo en la barra superior y la cabecera de la tabla de la home.
- La tabla de puntaje por campo hace scroll horizontal (mínimo 620px).

## Tokens

Los mismos que `app.css` / `benchy-agent-brand.css`:

- Colores: ink `#2A2E3A`, ink-deep `#1B1E27`, ink-soft `#3A3F4D`, body `#6B6660`, muted `#756E66`, paper `#FBF9F7`, surface `#F6F2EE`, line `#E5DFD8`, line-soft `#EDE7E0`, amber `#F5A623`, amber-ink `#C97A10`, amber-wash `#FBEFD9`, fail `#B4342A`
- Agregados en este diseño: ok `#1F6E4A` (texto) / `#1F8A5B` (punto), fondo ok `#EEF7F2` con borde `#CFE6D9`, fondo fail `#FBEDEB` con borde `#F0CFCB`
- Tipografías: Hanken Grotesk + JetBrains Mono
- Animaciones: `ba-march` y `ba-breathe` para el pip, `ba-indet` (barra indeterminada) nueva. Las tres respetan `prefers-reduced-motion`.

Reglas de la marca que hay que mantener:

- El ámbar marca solo lo activo o pendiente: pestaña, ítem activo, pregunta del agente, sistema en curso, mejor puntaje.
- El verde aparece solo en validado/terminado; el rojo, solo en fallas.

## Archivos

```
design_handoff_platform/
├── README.md
├── design/
│   ├── Plataforma.dc.html   ← prototipo (los datos y los cables están en la lógica, arriba)
│   └── support.js           ← runtime del prototipo; no portar
└── assets/
    ├── pip-mark.svg
    └── favicon.svg
```

## Pendientes para el backend (en orden de impacto)

1. `POST /api/workspace/validate` → `benchy_validate`. Habilita los estados de la home y la insignia del encabezado.
2. `GET /api/models` → `benchy_models`.
3. Un formato estructurado para las preguntas del agente.
4. Una convención para agrupar corridas en una comparación.
5. Progreso de corridas (streaming o polling sobre `runs/`).
6. Historial de versiones del YAML.
