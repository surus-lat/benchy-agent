# benchy agent — brand handoff

Everything needed to build the landing page. Nothing here depends on a font being
installed for the *mark*: the logo is pure vector geometry.

## Fonts
- Display / wordmark: **Hanken Grotesk** (700)
- Mono / machine text: **JetBrains Mono** (400, 500)

```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Hanken+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;700&display=swap" rel="stylesheet">
```

## Colour
| Token | Hex | Use |
|---|---|---|
| `--ba-ink` | `#2A2E3A` | Text, brackets, dark panels |
| `--ba-amber` | `#F5A623` | The dot, accents on dark/large only |
| `--ba-amber-ink` | `#C97A10` | Amber **text** on light grounds (AA) |
| `--ba-amber-wash` | `#FBEFD9` | Tinted blocks, badges |
| `--ba-paper` | `#FBF9F7` | Card surface |
| `--ba-canvas` | `#F4F1EE` | Page background (with dotted grid) |
| `--ba-line` / `--ba-line-soft` | `#E5DFD8` / `#EDE7E0` | Borders |
| `--ba-body` | `#6B6660` | Body copy |
| `--ba-muted` | `#756E66` | Captions, eyebrows (min 11px) |
| `--ba-ok` / `--ba-fail` | `#1F8A5B` / `#B4342A` | DONE / FAILED only |

Never set body text in `#F5A623` on a light ground — use `#C97A10`.
Page background pattern: `radial-gradient(#D8D2CB 1px, transparent 1px)` at `22px 22px`.

## Assets (`/assets`)
| File | Use |
|---|---|
| `pip-mark.svg` | Primary mark, transparent, ink brackets |
| `pip-mark-inverse.svg` | On dark grounds |
| `pip-mark-mono-ink.svg` / `-mono-light.svg` | One-colour (print, stamps, partners) |
| `pip-tile.svg` | App icon / avatar, dark rounded tile |
| `favicon.svg` | 16px-optimised, thicker strokes |
| `pip-state-*.svg` | Static state marks (idle, thinking, running, asking, done, failed) |
| `benchy-agent-brand.css` | Tokens + `.ba-lockup` + `.ba-pip` component |

## Lockup
```html
<span class="ba-lockup" style="font-size:32px">
  <img class="ba-lockup__mark" src="/assets/pip-mark.svg" alt="">
  <span class="ba-lockup__words">
    <span class="ba-lockup__name">benchy</span>
    <span class="ba-lockup__suffix">agent</span>
  </span>
</span>
```
Scale the whole lockup with `font-size`. Variants: `.ba-lockup--stacked`, `.ba-lockup--on-dark`.
Clear space = one bracket height on every side. Below 24px, drop the wordmark and use the tile.

## Pip — the agent's presence
```html
<span class="ba-pip" data-state="thinking" style="--pip:8px"><i></i><i></i><i></i></span>
```
States: `idle` `thinking` `running` `asking` `done` `failed`. Always emit three `<i>`.
Size with `--pip` (the dot diameter): 5px inline in text, 8px in toolbars, 14px+ as a hero.
Add `.ba-pip--on-dark` on dark panels. Reduced-motion is handled.

**Rules:** brackets never move — only the interior animates. Green appears only on DONE,
red only on FAILED. One Pip per surface.

## Voice
Wordmark is always lowercase `benchy agent`. Mono for anything the machine says
(paths, counts, statuses, code); display sans for anything a human wrote.
