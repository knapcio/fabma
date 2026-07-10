# Fabma — instructions for AI agents

You are a coding/design agent (Claude Code, Codex, etc.). Fabma is a local
design gallery where your human picks between design variants you made and
leaves pinned comments. This file tells you how to drive it. The human sees
everything in the Fabma app (or a browser); you talk to a local HTTP API.

(Humans: `fabma skill install [--codex]` teaches your agents this protocol
permanently — a Claude Code skill plus an optional ~/.codex/AGENTS.md section.)

Base URL: `http://localhost:4011` (default port).

## The loop — a conversation, not a one-shot

1. You design N variants as **self-contained HTML files** (inline `<style>`,
   no external assets except Google Fonts links, imagery as inline SVG/CSS).
2. You push them into a session. Your `note` shows up in the session's
   **discussion thread** — write it to the human ("Three takes: calm,
   editorial, bold. B is my favorite.").
3. The human compares variants, pins comments on the designs, may reply in
   the discussion, and clicks **Decide**.
4. You read the decision and continue — and when you iterate, **drop the
   next round into the SAME session** (`projectId` / `--session`) so the
   whole exchange stays one thread the human can scroll.
5. Between rounds you can post/read discussion messages any time — treat
   human messages as direction.

The human usually runs the Fabma desktop app — it hosts this API and shows
new sessions by itself the moment you create one. Plain HTTP is all you need.

## Raw HTTP way (works everywhere)

```bash
# is it running? ("flavor":"desktop" means the human has the app open)
curl -s http://localhost:4011/api/health
# not running and you have a fabma checkout: `node bin/fabma.js --no-open &`

# push variants (round 1 — creates the session)
curl -s -X POST http://localhost:4011/api/drop \
  -H 'content-type: application/json' \
  -d '{"title":"Header options","note":"Pick a direction","variants":[{"name":"Calm","html":"<!doctype html>…"},{"name":"Bold","html":"<!doctype html>…"}]}'
# → { "projectId": "…", "url": "…", "feedbackUrl": "…", "messagesUrl": "…" }

# wait for the verdict (long-polls up to 55s per call; repeat until decided)
curl -s "<feedbackUrl>?wait=55"
# → { "status": "decided",
#     "decision": { "variant": 1, "note": "this one, but calmer header", "decidedAt": "…" },
#     "variants": [ { "index": 0, "comments": [ { "text": "too dense", "x": 22, "y": 61 } ] }, … ] }

# round 2 goes into the SAME session: add "projectId" to the drop body
# (with the CLI: fabma drop ... --session <projectId>)

# discuss: post a message; read replies (?after=<lastSeenId>&wait=55 long-polls)
curl -s -X POST <messagesUrl> -H 'content-type: application/json' \
  -d '{"from":"agent","text":"Applied your pins — two takes on the calmer header."}'
curl -s "<messagesUrl>?after=<lastSeenId>&wait=55"
```

Comment coordinates `x`/`y` are percentages of the design canvas (from left
and top) — use them to locate what the human pointed at.

Tell the human something like: *"I dropped 3 header options into Fabma —
pick one and pin comments, I'm waiting."* If `flavor` was NOT `desktop`,
also open the session `url` in their browser.

## One-command way (if you have the fabma checkout / CLI)

```bash
fabma drop header-a.html header-b.html header-c.html \
  --title "Dashboard header options" \
  --note "Which direction for the new header?" \
  --wait
```

- Starts the server if it isn't running; brings the desktop app to the
  front (or opens the browser).
- `--wait` blocks until the human decides, then prints the decision JSON
  (picked variant index, their note, and every comment) to stdout.

## Full generation API (optional)

Fabma can also run generations itself by spawning `claude`/`codex` CLIs. You
normally don't need this — you ARE the agent — but a human may drive it, or
you can trigger it:

- `POST /api/projects` `{name, brief, mode: page|section|illustration}`
- `POST /api/projects/:pid/generations` `{prompt?, count, provider: claude-cli|codex-cli|anthropic-api, parent?, directionIds?}`
- `GET  /api/projects/:pid` — full tree including per-variant `path` (absolute
  file path — you can read/edit variant files directly on disk)
- `POST /api/projects/:pid/import` — screenshots (png/jpg) and/or HTML/SVG as
  `{files:[{name, dataBase64}], note}`; useful to seed a session with the
  real app's current look before proposing changes.

## Rules for the HTML you drop

- One self-contained document per variant; everything inline.
- No network calls: previews run under a CSP that blocks everything except
  Google Fonts. No external images/scripts — inline SVG and CSS only.
- Design desktop-first at 1440px; keep it sane down to 390px.
- If you are mocking changes to a real app, reproduce the app's current look
  faithfully and change only what you're proposing; label variants clearly
  via the `name` field.
