# Fabma → Elementor

Three paths, honest trade-offs.

## 1. Embed blob (most reliable)

**Export → Copy embed for an HTML widget.** In Elementor, drop an **HTML widget** anywhere and paste. You get the whole design in one widget: Google Fonts links + the design's markup wrapped in a unique class + CSS scoped under that class.

- Works on free Elementor, any recent version.
- Visually exact, including responsive breakpoints (media queries are scoped too).
- Not editable as Elementor widgets — edit the design in fabma, re-copy.

## 2. Importable template

**Export → Download template (containers)** — or *(legacy sections)* if your site has flexbox containers disabled. Import via **Templates → Saved Templates → Import**, then insert into a page. Each top-level `<section>` of the design becomes its own container/section wrapping an HTML widget, so you can reorder or interleave them with native blocks.

Caveats:

- CSS classes are scoped per export, but **DOM ids are not rewritten** — avoid inserting the *same* design twice on one page.
- Your theme's global styles can still bleed into embedded markup (typically link colors or heading resets). The scoped CSS usually wins; if something looks off, raise specificity in the design or use the blob path.
- `custom_css` isn't used anywhere — everything works on **free** Elementor.

## 3. Native widgets (AI, experimental)

**Export → Convert to native widgets.** A provider run translates the design into real `heading` / `text-editor` / `button` / `spacer` / `divider` widgets with container backgrounds and padding, falling back to an HTML widget for blocks that native widgets can't express (SVG art, overlapping layers). The result is structurally validated (element tree, widget types, unique ids) before download.

This gives you a template you can actually edit in Elementor — but it's a lossy translation by nature. Treat it as a head start, not a guarantee. If it imports oddly, use path 1 or 2 and report the case.

## Fonts

Google Fonts `<link>` tags ride along inside the first widget. If your site already loads the same family, the duplicate link is harmless. For offline-only sites, regenerate the design with a note like "system font stacks only".
