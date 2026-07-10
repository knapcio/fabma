# Fabma — instructions for AI agents

You are a coding/design agent (Claude Code, Codex, etc.). Fabma is a local
app where your human reviews design variants you made: they compare, pin
comments on the designs, reply in a discussion, and pick one. You talk to a
local HTTP API at `http://localhost:4011`; the human sees everything in the
Fabma app.

(Humans: click **Teach my agents** in the app — or run
`fabma skill install --codex` from a checkout — to install this protocol
permanently.)

## The flow

1. **Health**: `GET /api/health` — `"flavor":"desktop"` means the app is open
   and sessions appear in it automatically. Not running? macOS `open -a Fabma`,
   or from a checkout `node bin/fabma.js --no-open &`.
2. **Project**: `GET /api/projects`. If one matches this codebase/feature,
   **ask the human** whether to use it; otherwise
   `POST /api/projects {"name","brief"}`. For throwaway one-offs skip this —
   a drop without `projectId` creates a disposable project.
3. **Context**: `GET /api/projects/<id>` — every session, generation,
   decision, pinned comment, and absolute file `path`s. Read earlier sessions
   before proposing; don't re-pitch what the human already rejected.
4. **Drop a session** (1–8 self-contained HTML variants):

   ```bash
   curl -s -X POST http://localhost:4011/api/drop \
     -H 'content-type: application/json' \
     -d '{"projectId":"<id, or omit>",
          "sessionId":"<only for round 2+ of a session>",
          "title":"Header options",
          "note":"Three takes — B is my favorite.",
          "variants":[{"name":"Calm","html":"<!doctype html>…"}]}'
   # → { projectId, sessionId, generationId, url, feedbackUrl, messagesUrl }
   ```

   Your `note` appears in the session's discussion — write it to the human.
5. **Let the human review — two modes**:
   - **Deferred (default)**: say *"I dropped 3 options into Fabma — pick one,
     pin comments, reply there, then tell me to continue"* and END YOUR TURN.
     When they say "continue": `GET <feedbackUrl>` and
     `GET <messagesUrl>?session=<sessionId>`.
   - **Blocking**: `GET <feedbackUrl>?wait=55` in a loop (or the CLI's
     `--wait`) — only when they said they'll decide right now.
6. **Iterate in the same session** (`sessionId`) so the exchange stays one
   thread. Post progress via
   `POST <messagesUrl> {"from":"agent","text":"…","sessionId":"<sid>"}`;
   treat human replies as direction.

The feedback JSON: `decision.variant` (0-based), `decision.note`, and
per-variant `comments` — each `{text, x, y}` with `x`/`y` as percentages from
the canvas's left/top: located feedback on that exact spot.

## CLI shortcut (from a fabma checkout)

```bash
node <fabma>/bin/fabma.js drop a.html b.html c.html \
  --project <projectId> --title "Header options" --note "…" \
  [--session <sessionId>] [--wait]
```

Starts the server if needed, surfaces the app, prints ids + URLs (and with
`--wait`, blocks and prints the decision JSON).

## Rules for the HTML you drop

- One self-contained document per variant: `<style>` inline, no external
  assets except Google Fonts links, imagery as inline SVG/CSS. No network
  calls — previews run under a CSP that blocks them.
- Desktop-first at 1440px; sane down to 390px. No JavaScript unless the
  design is meaningless without it. Real copy, never lorem ipsum.
- Name variants meaningfully — the name is their gallery label.
- Mocking a real app? Import a screenshot as baseline
  (`POST /api/projects/<id>/import {"files":[{name, dataBase64}], note}`),
  reproduce the current look faithfully, and change only what you propose.

## Also available

- Fabma can generate designs itself by spawning `claude`/`codex`:
  `POST /api/projects/<id>/generations {prompt?, count, provider:
  "claude-cli"|"codex-cli"|"anthropic-api", sessionId?, parent?, directionIds?}`.
- Exports per variant (HTML file, Elementor template/embed, SVG) hang off
  `/api/projects/<pid>/generations/<gid>/variants/<i>/…` — the human usually
  triggers these from the UI.
