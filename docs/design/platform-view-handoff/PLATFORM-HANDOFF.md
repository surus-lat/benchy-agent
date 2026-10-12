# benchy — platform screens for the landing page

Three ready-to-place product views. Each is the **app window only** (no hero copy),
so the landing page supplies its own headline around it.

| Screen | Use | Files |
|---|---|---|
| `production-define` | Task/extraction benchmarks — the original product story | `embeds/production-define.html` · `screens/platform-define-production.png` |
| `research-author-en` | **University launch.** Q&A + rubric authoring | `embeds/research-author-en.html` · `screens/platform-author-research-en.png` |
| `research-author-es` | Same screen, Rioplatense academic Spanish | `embeds/research-author-es.html` · `screens/platform-author-research-es.png` |

For the first release to universities, lead with **research-author-en**.

## Two ways to place it

**A · Live HTML (preferred).** Paste the contents of an `embeds/*.html` `.ba-screen`
div straight into the hero. It is pure inline-styled markup — no framework, no build.
Requirements: the two Google Fonts, and `assets/benchy-agent-brand.css` (supplies the
`.ba-pip` agent-status component and the brand tokens). Pip's states animate; reduced
motion is respected.

**B · Image.** The PNGs in `screens/` are 2x (2688px wide) with transparent surroundings
already cropped to the window. Use when the hero needs to tilt, mask, or scroll the shot.

## Sizing
The window is authored at **1440px**. Scale it, don't reflow it:

```html
<div class="ba-fit"><div class="ba-screen"><!-- window markup --></div></div>
```
```css
.ba-fit    { overflow: hidden; margin: 0 auto; max-width: 1440px; }
.ba-screen { width: 1440px; transform-origin: top left; transform: scale(var(--ba-fit, 1)); }
```
```js
var fit = document.querySelector('.ba-fit'), scr = fit.querySelector('.ba-screen');
function apply() {
  var s = Math.min(1, fit.clientWidth / 1440);
  fit.style.setProperty('--ba-fit', s);
  fit.style.height = scr.offsetHeight * s + 'px';   // transform alone leaves a gap
}
apply(); new ResizeObserver(apply).observe(fit);
```
Never put `max-width: 100%` on `.ba-screen` — it reflows the three-panel layout
and the panel headers collide. Scale the whole window; don't resize it.

Below ~900px, swap to the PNG — the three-panel layout is not designed to reflow to mobile.

## Rules
- Never recolour the window. Ink `#2A2E3A` carries structure; amber `#F5A623` marks only
  the active or pending thing; green `#1F8A5B` appears only on validated/done, red only on failure.
- Keep the agent moment visible. The amber-tinted Pip ask near the bottom right
  ("I split criterion 3 — keep it?") is the product's differentiator; if the hero crops
  the window, crop from the left, never from that panel.
- Don't crop the bottom status bar either — it carries "engine connected", which is what
  ties the agent to the Benchy engine.

## Copy shipped with the research screens
Headline: *Turn your research knowledge into AI benchmarks.*
Sub: *Evaluate what AI knows, uncover its blind spots, and build the data that shapes what comes next.*
Three-up under the window: *You write the questions only you can ask · The engine runs every
frontier model · Your rubric decides what counts as right.*

ES: *Convertí tu conocimiento de investigación en benchmarks de IA.* /
*Evaluá qué sabe la IA, descubrí sus puntos ciegos y construí los datos que dan forma a lo que viene.*

See `../BRAND-HANDOFF.md` for logo, Pip, tokens, and type.
