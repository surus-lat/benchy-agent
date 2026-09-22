# Handoff: benchy agent — marketing landing page (EN + ES)

## Overview

Public landing page for **benchy agent** (by Surus). Single scrolling page, invitation-only product, audience = universities and research groups. Two locales with identical layout and different copy/screenshot:

- `design/Landing Page.dc.html` — English
- `design/Landing Page ES.dc.html` — castellano rioplatense académico (voseo)

Primary conversion action is **Request access / Solicitar acceso**, an in-page anchor to the `#access` form. There is also a **Log in / Ingresar** entry point (same anchor today — wire it to the real auth route) and an outbound link to the engine at `https://benchy.lat`.

## About the design files

The files in `design/` are **design references created in HTML** — prototypes that show intended look, copy, and behavior. They are **not production code to copy directly**.

They are authored in a proprietary component format (`.dc.html`, with `support.js` as its runtime) that will not exist in your codebase: markup lives inside an `<x-dc>` element, `{{ }}` holes are template bindings, and `style-hover="…"` is a non-standard attribute for hover styles. **Do not port these mechanisms.**

The task is to **recreate these designs in the target codebase's existing environment** (Next.js/React, Astro, SvelteKit, etc.) using its established patterns, component conventions, and styling approach. If no frontend environment exists yet, pick the most appropriate one for a marketing page — a static-first framework (Astro or Next.js static export) is the natural fit, since the page has almost no runtime logic. Open the HTML files in a browser to see the real thing before implementing.

## Fidelity

**High fidelity.** Colors, typography, spacing, shadows, and copy are final. Recreate the UI closely using exact values below. The only deliberately illustrative content is the benchmark example data inside the feature panels (the `cite_statute` / `citar_norma` example, item rows, and score numbers) — real data can replace it, but keep the same shapes and column structure.

## Design tokens

From the brand system (`assets/benchy-agent-brand.css`, `assets/BRAND-HANDOFF.md` — authoritative source; the page uses a subset).

### Color

| Role | Hex | Usage |
|---|---|---|
| Paper | `#FBF9F7` | page background |
| Paper (card) | `#FFFFFF` | cards, inputs, chips |
| Surface | `#F6F2EE` | inset panels inside cards |
| Surface alt | `#F4F1EE` | subtle fills |
| Ink | `#2A2E3A` | headings, primary buttons, logo |
| Ink deep | `#1B1E27` | primary button hover |
| Ink soft | `#3A3F4D` | secondary UI text |
| Body | `#6B6660` | body copy |
| Muted | `#756E66` | captions, footnotes, mono labels |
| Line | `#E5DFD8` | borders |
| Line soft | `#EDE7E0` | inner dividers, header border |
| Divider soft | `#D9D2CA` | diagram connectors |
| Row divider | `#EDE7E0` | table row separators |
| Amber | `#F5A623` | accent: pip dot, rail progress, chips, key bars |
| Amber ink | `#C97A10` | amber-colored **text** (contrast-safe) |
| Amber wash | `#FBEFD9` | YAML node fill |
| Overlay 6% | `rgba(42,46,58,.06)` | secondary button fill |
| Overlay 12% | `rgba(42,46,58,.12)` | secondary button hover |

Amber is used **sparingly** — roughly six places on the page. Never use `#F5A623` for text; use `#C97A10`.

### Typography

- Sans: **Hanken Grotesk** (400/500/600/700) — Google Fonts. Stack: `'Hanken Grotesk', system-ui, sans-serif`
- Mono: **JetBrains Mono** (400/500) — Google Fonts. Stack: `'JetBrains Mono', ui-monospace, monospace`
- Mono is used for: the "agent" half of the logo, `benchy::engine`, the "INVITATION ONLY" eyebrow, code/config blocks, block labels, pipeline diagram nodes, and the item-row index numbers.

Type scale (all fluid; `clamp(min, preferred, max)`):

| Element | EN | ES |
|---|---|---|
| Hero H1 | `clamp(31px, 6vw, 56px)` / 500 / lh 1.08 / ls -0.03em | `clamp(29px, 5.4vw, 50px)` |
| Hero subtitle | `clamp(20px, 2.8vw, 36px)` / 500 / lh 1.2 / ls -0.02em | same |
| Hero paragraph | `clamp(18px, 1.55vw, 21px)` / 400 / lh 1.55 | same |
| Panel H2 | `clamp(24px, 2.4vw, 30px)` / 500 / ls -0.02em | same |
| Panel lede | 16px / lh 1.65 | same |
| Closer H2 | `clamp(28px, 3.6vw, 48px)` / 500 / lh 1.1 / ls -0.025em | same |
| Nav links | 17px (15px below 520px) | same |
| Body small | 14px / lh 1.6 | same |
| Footnote | 13px / lh 1.6 | same |
| Caption / mono label | 12px, mono, ls .1em where uppercase | same |

**The H1 floor matters**: on phones the headline must stay visibly larger than the subtitle. Keep the floors above the subtitle's 20px floor.

### Spacing, radius, shadow

- Page gutter: `clamp(16px, 4vw, 24px)`
- Max widths: hero / support / access `1280px`; feature rail `1152px`; platform screenshot `1440px`; captions `46rem`; body measure `34–44rem`
- Section rhythm: hero top `clamp(28px, 7vh, 80px)`; support band `clamp(40px, 7vh, 72px)`; platform shot `clamp(56px, 11vh, 120px)`; rail `112px`; access `112px`; closer `112px`; between rail panels `clamp(72px, 10vw, 128px)`
- Radius: pill `999px` (buttons, chips, inputs-adjacent), cards `14–16px`, inner blocks `8–10px`, platform frame `clamp(10px, 1.2vw, 18px)`
- Shadows:
  - card: `0 1px 2px rgba(42,46,58,.04), 0 12px 28px -12px rgba(42,46,58,.16)`
  - platform frame: `0 1px 2px rgba(42,46,58,.05), 0 40px 80px -28px rgba(42,46,58,.32)`
  - primary button: `0 8px 20px -8px rgba(42,46,58,.45)`
  - input: `inset 0 1px 2px rgba(42,46,58,.05)`

### Page ground (dot grid)

```css
background-color: #FBF9F7;
background-image: radial-gradient(rgba(42,46,58,.11) 1px, transparent 1px);
background-size: 24px 24px;
background-position: -1px -1px;
```

Applied to `body`. It reads as engineering graph paper and is part of the brand feel — keep it.

## Screens / views

One page, seven stacked sections in this order.

### 1. Header (sticky)

- `position: sticky; top: 0; z-index: 40`, full width, `padding: 9px 16px`, `display:flex; flex-wrap:wrap; justify-content:space-between; gap:10px 20px`
- Background `rgba(251,249,247,.92)` + `backdrop-filter: saturate(140%) blur(8px)`, bottom border `1px solid #EDE7E0`
- **Left, lockup** (links to top): `assets/pip-mark.svg` at `height: 1.18em` beside the wordmark — "benchy" in Hanken Grotesk 700, `letter-spacing:-.025em`, color `#2A2E3A`, at `font-size: 1em` of a 26px container; "agent" in JetBrains Mono 500 at `.53em`, color `#C97A10`; baseline-aligned, `gap: .22em`
- Then a GitHub icon-only link (21px official GitHub mark path, fill `#2A2E3A`, `opacity .75` → `1` on hover) → `https://github.com/surus-lat/benchy-agent`, `aria-label` + `title` set
- **Center**: `benchy::engine` → `https://benchy.lat`, JetBrains Mono 400 14px, `color: rgba(42,46,58,.45)` → `rgba(42,46,58,.85)` on hover, pill padding `6px 10px`. Deliberately low-emphasis — it is for engineering visitors, not the main audience. No arrow glyph.
- **Right**: `Log in / Ingresar` (pill, fill `rgba(42,46,58,.06)` → `.12` hover) and `Request access / Solicitar acceso` (pill, fill `#262626`→ use `#3A3F4D`/ink, white text, `#1B1E27` hover). Both 17px, `padding: 6px 16px`.

All three groups shrink and wrap rather than forcing overflow.

### 2. Hero (centered)

`max-width: 1280px`, centered column, `text-align: center`, top padding `clamp(28px,7vh,80px)`.

1. **H1**, two hard-broken lines, each its own block with `white-space: nowrap` on desktop:
   - EN: "Turn your research knowledge" / "into AI Benchmarks"
   - ES: "Convertí tu conocimiento" / "académico en benchmarks de IA"
2. **Subtitle** (margin-top 22px): EN "Shape the future of AI" · ES "Dale forma al futuro de la Inteligencia" — color `#756E66`
3. **Live pip divider** (margin-top 26px) — see *Interactions*
4. **Paragraph** (margin-top 22px, `max-width: 44rem`, color `#6B6660`):
   - EN: "Evaluate what AI knows, uncover its blind spots & biases, and build the data that shapes what comes next."
   - ES: "Evaluá qué sabe la IA, identificá sus puntos ciegos y sesgos, y construí los datos que definen lo que viene."
5. **Primary CTA** (margin-top 38px): pill, ink fill, white text, `padding: 14px 32px`, 16px → `#access`

### 3. AWS support band

`max-width: 1020px` (narrower than the rest so it reads as part of the hero block). White card, `1px solid #EDE7E0`, radius 14px, card shadow, `padding: 26px clamp(20px,3vw,32px)`. Two-column auto-fit grid, tracks `minmax(min(300px,100%),1fr)`, gap `28px 48px`.

- Left: official **Powered by AWS** badge — `https://d0.awsstatic.com/logos/powered-by-aws.png` at `height: 44px`, linked to `https://aws.amazon.com/what-is-cloud-computing` (this link/badge pairing is AWS's co-marketing requirement). Beside it, 14px: "Supported by **AWS** as a social impact project." / "Con el apoyo de **AWS** como proyecto de impacto social." ("AWS" in ink.)
- Right, 14px: "Compute credits and infrastructure are provided by Amazon Web Services, so access stays free for the universities and research groups we work with." / ES equivalent.

> Before launch, host the badge locally rather than hotlinking `awsstatic.com`, and have the social-impact wording reviewed against AWS trademark guidelines — that claim is ours, not part of the badge.

### 4. Platform screenshot (the show-off moment)

`max-width: 1440px`. A `figure` containing a framed image + caption.

- Frame: white, `1px solid #E5DFD8`, radius `clamp(10px,1.2vw,18px)`, `overflow: hidden`, the deep platform shadow
- Image: `assets/platform-author-research.png` (EN) / `assets/platform-author-research-es.png` (ES), `display:block; width:100%; height:auto` — 2688×1826 source
- Caption, centered, `max-width: 46rem`, 13px `#756E66`: "Authoring a doctoral-level benchmark: the question, the expert reference answer, and a weighted rubric the engine can score against." / ES equivalent
- Deliberately positioned **below the fold** — the first viewport is title + support band only.

### 5. Feature rail (the core section)

`max-width: 1152px`. Two-column grid: `minmax(150px,15rem) minmax(0,1fr)`, gap `clamp(28px,6vw,96px)`.

- **Left**: sticky index (`position: sticky; top: 96px`) listing the five panel titles. Each item is an anchor with `padding: 14px 0`, 16px, color `#756E66` (inactive) / `#2A2E3A` (active), plus a 1px `#E5DFD8` track under it holding a 2px amber (`#F5A623`) fill scaled by scroll progress. See *Interactions*.
- **Right**: five `article` panels, gap `clamp(72px,10vw,128px)`, each `scroll-margin-top: 112px`, each = H2 + lede + a visual + an optional 13px `#756E66` footnote.

Panel content (EN / ES titles):

1. **Build your benchmark / Definí tu benchmark** — lede: "Describe what you want to evaluate. Benchy Agent helps turn it into a precise program, scoring function, data definition, and AI-system configuration."
   Visual: a card whose header shows the user's request in quotes beside a small pip, then a 1px-gap grid (`background:#E5DFD8` showing through as hairlines) of four `#F6F2EE` cells labelled in mono amber-ink — `program`, `scoring`, `data`, `ai-system` (ES: `programa`, `puntaje`, `datos`, `sistema-de-ia`) — each holding 3 lines of mono config.
   Footnote: "The agent and the authoring UI write the same four blocks — nothing is inferred behind your back."
2. **Generate the exam / Generá el examen** — lede: "Generate synthetic benchmark data from your context, constrained and validated by the benchmark you defined."
   Visual: a card, header row "240 items generated from your corpus" / "236 valid · 4 rejected", then four item rows (`grid-template-columns: 2.5rem minmax(0,1fr) 6rem`, `padding: 12px 16px`, `border-bottom: 1px solid #EDE7E0`): mono index, truncating description (`text-overflow: ellipsis`), right-aligned 12px status. Row 003 is the **rejected** row — description and status both drop to `#756E66`.
   Footnote about validation-before-entry.
3. **AI-systems / Sistemas de IA** — lede: "Benchmark the thing you actually deploy: a model, AI-node, workflow, agent, or composed AI-system."
   Visual: five chips (white, `1px solid #E5DFD8`, radius 8px, `padding: 12px 14px`, 14px text, 10px amber square) in an auto-fit grid `minmax(min(200px,100%),1fr)`, then an inset `#F6F2EE` card with the mono line `one runtime contract  ──  adapters  ──  your system`.
4. **Run & score / Ejecutá y puntuá** — lede: "Run the exam. Benchy validates every output, scores each evaluation dimension, and produces the benchmark result."
   Visual: four score rows (`grid-template-columns: 9rem minmax(0,1fr) 3.5rem`, gap 16px): label, 10px bar, right-aligned tabular-nums value. First two bars amber `#F5A623` (0.81, 0.64), last two `#D9D2CA` (0.97, 0.06) — primary dimensions get the accent. Figcaption marks the run as illustrative.
5. **Explicit & reproducible / Explícito y reproducible** — lede + a second paragraph on the shared YAML.
   Visual: the pipeline diagram in an inset card — a stacked column of three white mono chips (`Human` / `Agent` / `UI`) then `→ YAML → compiler → engine`. The YAML node is the emphasis: `#FBEFD9` fill, `1px solid #F5A623`, ink text. Each arrow is grouped with the chip it points to so a wrap never orphans a connector.
   Footnote about one semantic source.

### 6. Access (`#access`) — the conversion block

`max-width: 1280px`, `scroll-margin-top: 96px`. White card, `1px solid #EDE7E0`, radius 16px, card shadow, `padding: clamp(24px,3vw,44px)`. Two-column auto-fit grid `minmax(min(300px,100%),1fr)`, gap `32px 64px`, `align-items: start`.

- Left: mono 12px `#C97A10` eyebrow "INVITATION ONLY" / "SOLO POR INVITACIÓN"; H2 "Built for universities and research groups" / "Pensado para universidades y grupos de investigación"; paragraph explaining per-institution access during early release.
- Right: two inputs (full width, `box-sizing: border-box`, `1px solid #E5DFD8`, radius 10px, `padding: 13px 16px`, 15px, inset shadow) — "Institutional email" / "Correo institucional", "University or research group" / "Universidad o grupo de investigación"; the primary CTA pill; then 13px `#756E66` "Already invited? **Log in**" / "¿Ya tenés una invitación? **Ingresar**".

**This form is presentational in the prototype.** It needs: real `<form>` semantics, `type="email"`, labels (visible or `sr-only`), required/format validation, submit → backend, and success/error states. See *Interactions*.

### 7. Closer + footer

- Closer: `min-height: 70svh`, centered column, `padding: 56px clamp(16px,4vw,24px)`. The large **idle pip mascot** (see below), then H2 "Shape the future of Intelligence" / "Dale forma al futuro de la Inteligencia" (`max-width: 42rem`, `text-wrap: balance`), then the primary CTA.
- Footer: `margin-top: auto`, `border-top: 1px solid #EDE7E0`, centered, `padding: 18px clamp(16px,4vw,24px)`, 12px `#6B6660` — a single link, "by SURUS" → `https://surus.lat`, underline on hover.

## Interactions & behavior

### Scroll-spy rail (desktop only, ≥881px)

On scroll and resize:

1. Take all five panels; the active one is the last whose `getBoundingClientRect().top <= window.innerHeight * 0.35`.
2. Progress through the active panel = `(0.35 * innerHeight − activeTop) / (nextPanelTop − activeTop)`, clamped 0–1 (falls back to the panel's own height for the last panel).
3. The active index item goes `#2A2E3A`, the rest `#756E66`; the active item's amber fill gets `transform: scaleX(progress)` with `transform-origin: left`; all others `scaleX(0)`.

Listener is `{ passive: true }`; it runs once on mount so a mid-page load is correct. In a framework, use `requestAnimationFrame` throttling or `IntersectionObserver` for the active panel plus a scroll handler for the fill.

### Closer mascot reveal

Starts at `opacity: 0; transform: translateY(14px)`, transitions `opacity .7s ease, transform .7s ease`. When the closer's top crosses `innerHeight * 0.8`, it goes to `opacity: 1; transform: none`. One-way (never re-hides). `IntersectionObserver` is the right primitive.

### The live pip (brand component, two states)

Bracket-and-dot mark built from DOM, not an image: two bracket halves (`border: Npx solid currentColor` with the inner side removed) flanking a fixed-width center that holds amber dots.

```css
@keyframes ba-pip-breathe { 0%,100% { transform: scale(1);   opacity: 1; }
                            50%     { transform: scale(.82); opacity: .68; } }
@keyframes ba-pip-march   { 0%,100% { opacity: .22; }
                            50%     { opacity: 1; } }
```

Two instances, both static-state (no cycling):

- **Hero divider — thinking.** 26px tall brackets (2.5px border, 6px wide), center 30px wide, three 7px amber dots, `gap: 4px`, each `animation: ba-pip-march 1.1s ease-in-out infinite` with delays `0 / .16s / .32s`.
- **Closer mascot — idle.** 62px tall brackets (4px border, 10px wide), center 56px wide, one 22px amber dot, `animation: ba-pip-breathe 3.2s ease-in-out infinite`.

Both carry `role="img"` and an `aria-label`. `assets/pip-mark.svg` (header) and `assets/pip-tile.svg` are the static equivalents; the brand system also ships `pip-state-*.svg` for asking/done/failed/running if you need more states elsewhere.

### Reduced motion

```css
@media (prefers-reduced-motion: reduce) {
  [data-pip-dot] { animation: none !important; opacity: 1 !important; }
}
```

Honor it for the pip and the closer reveal.

### Hover states

- Primary CTA: `#2A2E3A` → `#1B1E27`, text stays white
- Secondary pill: `rgba(42,46,58,.06)` → `rgba(42,46,58,.12)`
- Text links: `text-decoration: underline; text-underline-offset: 4px`
- `benchy::engine`: `rgba(42,46,58,.45)` → `rgba(42,46,58,.85)`
- GitHub icon: `opacity .75` → `1`
- Global link default is `color: inherit; text-decoration: none`, hover `#1B1E27` — set this explicitly so no browser-default blue appears in future copy.

### Anchors

All CTAs are `#access`; the rail index items are `#rail-1`…`#rail-5`. Keep smooth-scroll optional and respect reduced motion. External links carry `target="_blank" rel="noopener noreferrer"`.

## Responsive behavior

Desktop-first fluid layout; breakpoints only where fluid sizing can't express the change. Everything else uses `clamp()`, `auto-fit` + `minmax(min(Npx,100%),1fr)`, and `flex-wrap`.

| Breakpoint | Change |
|---|---|
| ≤880px | Feature rail collapses to one column; **the sticky index is hidden entirely** (it's a desktop scroll-spy affordance — as a full-width sticky block it would cover content); score rows become `minmax(0,1fr) 3.5rem` with the label spanning the full first row |
| ≤760px | Hero H1 lines drop `white-space: nowrap` and wrap freely; the platform frame becomes `overflow-x: auto` and the screenshot gets `min-width: 760px` so the dense UI stays legible and pannable instead of shrinking to texture |
| ≤560px | Item rows become `2.2rem minmax(0,1fr)` with the status moving under the description, left-aligned |
| ≤520px | Nav drops to 15px with a tighter 8px/14px gap |

Verified: no horizontal overflow at 360px or 908px. When you re-implement, re-verify at 360 / 390 / 768 / 1024 / 1440.

## State management

Almost none — this is a static marketing page.

- `activeRailPanel: 1–5` and `railProgress: 0–1`, both derived from scroll (not user state)
- `closerRevealed: boolean`, one-way
- Access form: `email`, `institution`, `status: idle | submitting | success | error`, `errors` — **not built in the prototype**, needs designing against your backend
- No data fetching, no routing, no persisted state. The two locales are separate content sets over one layout — wire them to your i18n solution; all copy is in the files, and note the Spanish is **rioplatense voseo** ("Convertí", "Evaluá", "Ejecutá", «comillas latinas»), not neutral Spanish.

## Accessibility notes

Carried over from the prototype, plus what's still owed:

- Done: `aria-label` on icon-only GitHub link, `role="img"` + label on both pips, `aria-label` on the rail nav, `alt` on both screenshots, reduced-motion handling, ≥4.5:1 contrast on all small text (amber text is always `#C97A10`, never `#F5A623`)
- Still owed: real form labels and validation messaging, visible focus rings on every interactive element (the prototype relies on browser defaults and inputs set `outline: none` — replace with a designed `:focus-visible` ring), a skip-link, and `lang` on `<html>` per locale (`en` / `es-AR`)

## Assets

In `assets/`:

| File | Use |
|---|---|
| `pip-mark.svg` | header lockup mark |
| `pip-tile.svg` | square tile version of the mark |
| `favicon.svg` | favicon |
| `platform-author-research.png` | EN platform screenshot, 2688×1826 |
| `platform-author-research-es.png` | ES platform screenshot |
| `benchy-agent-brand.css` | **brand primitives — authoritative token source** |
| `BRAND-HANDOFF.md` | brand documentation (logo usage, pip states, color roles) |

Not bundled, fetched remotely in the prototype:

- Powered by AWS badge — `https://d0.awsstatic.com/logos/powered-by-aws.png` (host locally before launch)
- Google Fonts — Hanken Grotesk + JetBrains Mono (self-host or use your font pipeline)
- GitHub mark — inline SVG path, already in the markup

The brand system also ships `pip-mark-inverse.svg`, `pip-mark-mono-ink.svg`, `pip-mark-mono-light.svg`, and `pip-state-{idle,thinking,asking,running,done,failed}.svg` — ask if you need them.

## Files

```
design_handoff_landing_page/
├── README.md                          ← this document
├── design/
│   ├── Landing Page.dc.html           ← EN design reference
│   ├── Landing Page ES.dc.html        ← ES design reference
│   └── support.js                     ← prototype runtime (reference only, do not port)
└── assets/
    ├── benchy-agent-brand.css
    ├── BRAND-HANDOFF.md
    ├── pip-mark.svg
    ├── pip-tile.svg
    ├── favicon.svg
    ├── platform-author-research.png
    └── platform-author-research-es.png
```

Open the two `design/*.dc.html` files in a browser (they need `support.js` as a sibling — it is) to see intended rendering and behavior. Read markup for structure, but re-express it in your framework's idiom.

## Open items for the implementer

1. Wire `Log in / Ingresar` to the real auth route — today it points at `#access`.
2. Build the access request form for real: validation, submit, success/error states, spam protection.
3. Host the AWS badge locally; confirm the social-impact wording against AWS trademark guidelines.
4. Replace the illustrative benchmark example data with real content when available (keep the column structures).
5. Confirm locale routing (`/` + `/es`, or domain-based) and set `lang` accordingly.
6. Add analytics on both CTAs and the engine link if wanted.
