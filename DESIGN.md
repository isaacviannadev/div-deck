# Design

World: **Placa de impressão** — the site speaks the language of a 3D-printing slicer
(Bambu Studio / OrcaSlicer), because both decks are printed, their faces are swappable and
their colours are filaments. The page is a print job: prepare, preview, objects, process, print.

## Scene and theme
A maker at the desk in daylight, slicer open next to the editor: **light**. Never the dark
neon product-page look.

## Colour (Full palette, named roles)
| Role | Token | Value | Use |
|---|---|---|---|
| Viewport | `--vp` / `--vp-2` | #e8ebee → #d3d8dd | the 3D view and large fields (gradient top → bottom) |
| Panel | `--panel` | #ffffff | slicer side panels, dialogs |
| Panel 2 | `--panel-2` | #f3f5f6 | rows, inputs, quiet fields |
| Line | `--line` | #d3d8dd | 1px hairlines, panel borders |
| Ink | `--ink` | #1b1f24 | text |
| Ink 2 | `--ink-2` | #59616b | secondary text (≥4.5:1 on panel) |
| Plate | `--plate` | #a97f45 | textured PEI build plate (speckled), the hero's ground object |
| Go | `--go` | #00ae42 / hover #009a3a | the primary action only ("Baixar o app", "Imprimir") |
| Filaments | `--f-*` | cyan #00a3e0, magenta #e0367e, yellow #f2c200, orange #ff6b1a, violet #7a5cff, black #25282d, white #f4f4f4 | profiles, faces, swatches; one swatch = one profile/face |

Colour lives in objects (plate, swatches, keys), not in decoration. No gradients on text, no glow.

## Type
- Display: **Archivo** (variable width/weight). Headlines at wdth 112–125, weight 750–850,
  tracking −0.02em; section titles 2.2–3.6rem; max 5.5rem.
- Labels/readouts: Archivo at wdth 75–85, weight 600, tabular numerals (`font-feature-settings: "tnum"`):
  layer counters, parameter values, units.
- Body: system UI stack (`-apple-system, Segoe UI, Roboto, sans-serif`), 16–18px, measure ≤ 68ch.
- Monospace only for real values: key names, paths, URLs.

## Components (slicer grammar)
- **Top bar**: mark + name, tab strip (Preparar · Pré-visualizar · Objetos · Processo · Imprimir), model
  segmented control (DIV Deck MX | DIV Deck Pro), green action button.
- **Viewport**: light gradient field with the build plate and the deck in 3D; vertical **layer slider**
  on the right with a readout ("Camada 186 / 214 · 37,2 mm"); the deck prints bottom→top as the
  slider moves (clipping plane + glowing nozzle line).
- **Panel**: white, 1px line, 10px radius, header row with title and small controls; no shadows except
  floating panels over the viewport (offset 0 8px, blur 24px, 12% ink).
- **Parameter row**: label left, value right (tabular), unit in ink-2; groups collapse with a chevron.
- **Filament chip**: round swatch + name + material ("PLA translúcido").
- **Checklist step**: status dot (pending/active/done) + title + one line.
- **Warning row** (FAQ): amber triangle, title, expandable answer.
- Buttons: green filled (primary), white with 1px line (secondary), text link (tertiary). 8px radius.

## Motion
One authored moment: the layer print in the hero (scroll and drag scrub the slider, keys light up at
the last layer, then profiles change like filament swaps). Elsewhere only state transitions
(120–200ms, ease-out). `prefers-reduced-motion`: the deck is shown fully printed, no scrub.

## Layout
12-column grid, max 1240px; panels dock like a slicer (left list, right detail). Generous section
spacing (120–160px), tight inside panels (8/12/16px rhythm). Mobile: panels stack, the layer slider
becomes horizontal under the viewport.
