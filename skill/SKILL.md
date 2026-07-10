---
name: fabma
description: Present design options to the human in Fabma, a local design playground, and wait for their pick and pinned comments. Use whenever the user wants UI/design variants to choose from ("give me a few options", "mock this up", "which direction should this go"), wants to review a design visually before you implement it, or mentions fabma. Knows how to start the server, drop variants, and read the decision.
---

# Fabma: show design options, get a human verdict

Fabma is a local design gallery at `http://localhost:4011`. You push
self-contained HTML variants; the human compares them side by side, pins
comments directly on the designs, and picks one; you receive the verdict as
JSON and continue working.

Fabma checkout on this machine: `{{FABMA_DIR}}`

## When to reach for it

- The user asks for design options, mockups, or directions for anything visual.
- Before a significant UI change: mock 2–4 variants that look like the real
  app and let the human pick, instead of guessing.
- The user says "drop it in fabma" or asks to review designs.

## The loop

1. **Check it's up**: `curl -s http://localhost:4011/api/health`
   - `"flavor":"desktop"` means the Fabma app is open — your session will
     appear in it automatically.
   - Not running? Start it: `node {{FABMA_DIR}}/bin/fabma.js --no-open &`
     (or ask the human to open the Fabma app).
2. **Write each variant** as ONE self-contained HTML file (rules below).
3. **Drop them and wait**:

   ```bash
   node {{FABMA_DIR}}/bin/fabma.js drop a.html b.html c.html \
     --title "Dashboard header options" \
     --note "Which direction for the new header?" \
     --wait
   ```

   This surfaces the gallery for the human and **blocks until they decide**,
   then prints the decision JSON to stdout. Tell the human something like:
   *"I dropped 3 header options into Fabma — pick one and pin comments, I'm
   waiting."*
4. **Parse the result**: `decision.variant` (0-based index), `decision.note`,
   and per-variant `comments` — each `{text, x, y}` with `x`/`y` as
   percentages from the left/top of the canvas. Treat pins as precise,
   located feedback on that exact spot.
5. **Continue the conversation**: implement the picked design, or apply the
   feedback and drop the next round **into the same session** with
   `--session <projectId>` (the drop output prints it) — the whole exchange
   stays one thread. Your `--note` appears in the session's discussion panel;
   write it to the human. Variant files live on disk under `~/Fabma/projects/…`
   (the API returns absolute `path`s) if you want to read or reuse them.
6. **Discuss when useful**: the human can reply in the discussion panel.
   Read replies with `curl -s "<messagesUrl>?after=<lastSeenId>&wait=55"` and
   post your own with `POST <messagesUrl> {"from":"agent","text":"…"}`.
   Treat human messages as direction.

If `--wait` gets interrupted, re-poll: `curl -s "<feedbackUrl>?wait=55"`
until `"status":"decided"` (the drop output printed `feedbackUrl`).

## Rules for the variant HTML

- One self-contained document per variant: `<style>` inline in `<head>`, no
  external assets except Google Fonts `<link>` tags, imagery as inline SVG /
  CSS gradients. No network calls — previews run under a CSP that blocks them.
- Desktop-first at 1440px wide; must stay sane down to 390px. No JavaScript
  unless the design is meaningless without it.
- Real, specific copy — never lorem ipsum.
- Name files meaningfully (`calm-editorial.html`) — the filename becomes the
  variant's label in the gallery.
- Mocking a real app? Reproduce its current look faithfully and change only
  what you're proposing. You can also import a screenshot into Fabma as a
  baseline reference (see the full API).

## Full API

`curl -s http://localhost:4011/agent.md` documents everything else: raw HTTP
drops (no CLI needed), adding comments, importing screenshots/HTML/SVG as
references, and Fabma's own generation engine — it can spawn `claude`/`codex`
itself via `POST /api/projects` + `POST /api/projects/:id/generations` with
`provider: "claude-cli" | "codex-cli"`.
