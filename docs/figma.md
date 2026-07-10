# Fabma ↔ Figma

Fabma deliberately avoids the Figma API — it's the token furnace this tool exists to escape. The bridges are simpler.

## Fabma → Figma

- **Illustrations**: generate in *Illustration* mode (single self-contained `<svg>`), then **Export → Copy SVG** and paste directly into Figma. Figma imports SVG natively — you get real vectors, layers and all. No plugin, no API, no tokens.
- **Pages/sections**: Figma has no native HTML import. The community plugin **html.to.design** does a good job on fabma's output (self-contained, no external assets) if you need a page inside Figma. Usually you won't — iterate in fabma, ship from fabma.

## Figma → Fabma

- Select any frame in Figma → **Export → SVG** → in fabma: **Import**, pick the file. It becomes a generation you can select and refine with AI ("keep this composition, rebuild it as a responsive section").
- Screenshots work too (PNG export or ⌘⇧4) — with a screenshot the AI recreates the look; with SVG it can also read the actual structure.

## Roadmap

Figma REST import (paste a frame URL, fabma pulls the rendered image + simplified structure as reference) is on the roadmap — as *reference input*, never as an editing surface.
