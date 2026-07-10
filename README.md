<p align="center"><img src="docs/assets/banner.svg" alt="fabma — the AI-native design playground" width="100%"></p>

**Fabma is where your coding agent shows you designs — and you decide.** Claude Code or Codex designs real, rendered variants; you compare them in the app, pin comments on the designs, reply in the discussion, pick a winner; your agent reads the verdict and keeps working. No Figma round-trips, no API keys, no cloud — it runs on the agent subscriptions you already have, and your designs are plain HTML files on disk.

<p align="center"><img src="docs/assets/ui.png" alt="Fabma app" width="100%"></p>

## How it works

1. **Install the app** — download the DMG from [Releases](https://github.com/knapcio/fabma/releases), drag to Applications, right-click → Open the first time (unsigned for now).
2. **Teach your agents** — click **✳ Teach my agents** on the welcome screen (installs a Claude Code skill + a Codex `AGENTS.md` section). Or tell your agent: *"clone github.com/knapcio/fabma and run `node bin/fabma.js skill install --codex`"*.
3. **Work normally.** When a feature needs design, your agent opens Fabma, picks the right project (it asks you if one already exists), and drops a **session** with its proposals — the app brings it up by itself.
4. **You review on your clock** — compare variants, click a design to pin comments, reply in the session's discussion, hit **Decide**.
5. **Say "continue"** in your chat — the agent reads your pick, pins, and replies, then implements or drops the next round *into the same session*.

Sessions live inside projects, so one project holds all the design conversations for an app — and your agent reads earlier sessions before proposing, so it never re-pitches what you rejected.

You can also drive Fabma yourself: **＋ New project** → brief in → four art directions out (it spawns your `claude`/`codex` CLIs in parallel) → pin, refine, branch.

## What you need

- macOS (Apple Silicon DMG) — or run from source: `git clone … && npm install && npm run app` (Node 18+)
- At least one provider, auto-detected: **Claude Code** CLI, **Codex** CLI, or `ANTHROPIC_API_KEY` → details in [docs/providers.md](docs/providers.md)

## Getting designs out

- **HTML** — every variant is one self-contained file; copy or download it.
- **WordPress / Elementor** — paste-ready embed for an HTML widget, an importable template, or experimental AI conversion to native widgets → [docs/elementor.md](docs/elementor.md)
- **Figma** — illustration variants are pure SVG: copy, paste into Figma, done. Figma → Fabma works too (export a frame as SVG, import) → [docs/figma.md](docs/figma.md)
- **Back to your agent** — "Copy handoff prompt" bundles the chosen mockup, baseline, decision, and pins as a spec.

## Good to know

- Local-first: serves on 127.0.0.1 only, no telemetry; workspace is plain files in `~/Fabma` (git-friendly, agent-editable).
- Generated designs render in sandboxed iframes under a strict CSP — they can't touch the API or the network.
- How it's built, the design-medium argument, and the data model: [docs/internals.md](docs/internals.md). The full agent protocol: [AGENT.md](AGENT.md) (served at `/agent.md`).

## Roadmap

MCP server mode · signed/notarized DMG + auto-update · `npx fabma` · Figma REST import · PNG export · baseline overlay/diff · design tokens per project.

MIT © Fabma contributors.
