import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Single source of truth for what we teach agents. The CLI installer and the
// in-app installer both use this. When fabma runs from the packaged desktop
// app there is no usable checkout on disk (the code lives inside app.asar),
// so the generated skill speaks raw HTTP instead of `node …/bin/fabma.js`.

export function skillContext(rootDir) {
	const cliUsable = !!rootDir && !rootDir.includes('app.asar');
	return {
		cliUsable,
		root: rootDir,
		dropCmd: cliUsable
			? `node ${rootDir}/bin/fabma.js drop a.html b.html --title "…" --note "…" --wait`
			: 'POST /api/drop (see the HTTP examples below)',
		startCmd: cliUsable
			? `node ${rootDir}/bin/fabma.js --no-open &`
			: 'ask the human to open the Fabma app (macOS: `open -a Fabma`)',
	};
}

export function buildSkillMarkdown(ctx) {
	return `---
name: fabma
description: Present design options to the human in Fabma, a local design playground, and read back their pick, pinned comments, and replies. Use whenever the user wants UI/design variants to choose from ("give me a few options", "mock this up", "which direction should this go"), wants to review a design visually before you implement it, or mentions fabma. Knows how to start the app, pick the right project, run sessions, and continue after the human reviews.
---

# Fabma: you design, the human decides

Fabma is a local design gallery at \`http://localhost:4011\`. You push
self-contained HTML variants into a **session**; the human compares them,
pins comments on the designs, replies in the session's discussion, and picks
one; you read the verdict and continue.

## The etiquette

1. **Is it up?** \`curl -s http://localhost:4011/api/health\` —
   \`"flavor":"desktop"\` means the app is open (sessions appear in it by
   themselves). Not running? macOS: \`open -a Fabma\`${ctx.cliUsable ? ` or start headless:
   \`${ctx.startCmd}\`` : ' and wait for health to pass'}.
2. **Pick the project.** \`curl -s http://localhost:4011/api/projects\` — if a
   project matching this codebase/feature exists, **ask the human** whether to
   use it; otherwise create one:
   \`POST /api/projects {"name":"<repo or feature>","brief":"<the locked context>"}\`.
   Skipping a project entirely is fine for quick one-offs (a drop without
   projectId makes a disposable session).
3. **Read the history first.** \`GET /api/projects/<id>\` returns every session,
   generation, decision, and pinned comment, plus absolute file \`path\`s of
   all variants — earlier sessions are context for what the human already
   chose and said. Don't re-propose what they rejected.
4. **Design and drop a session.** Each variant is ONE self-contained HTML file
   (rules below).${ctx.cliUsable ? `

   \`\`\`bash
   node ${ctx.root}/bin/fabma.js drop a.html b.html c.html \\
     --project <projectId> \\
     --title "Header options" --note "Three takes — B is my favorite." \\
     [--session <sessionId>]   # add a round to an existing session
     [--wait]                  # only when the human wants to decide right now
   \`\`\`
   The output prints projectId/sessionId (reuse them for later rounds),
   feedbackUrl and messagesUrl.` : `

   \`\`\`bash
   curl -s -X POST http://localhost:4011/api/drop \\
     -H 'content-type: application/json' \\
     -d '{"projectId":"<id or omit>","sessionId":"<for round 2+, else omit>",
          "title":"Header options","note":"Three takes — B is my favorite.",
          "variants":[{"name":"Calm","html":"<!doctype html>…"}]}'
   # → { projectId, sessionId, generationId, url, feedbackUrl, messagesUrl }
   \`\`\``}
   Your \`note\` lands in the session's discussion — write it to the human.
5. **Let the human review on their clock.** Two modes:
   - **Blocking**: ${ctx.cliUsable ? '`--wait` / ' : ''}\`GET <feedbackUrl>?wait=55\` in a loop —
     only when they said they'll decide now.
   - **Deferred (default)**: tell them *"I dropped 3 options into Fabma —
     pick, pin comments, reply there, and tell me to continue"* and END YOUR
     TURN. When they say "continue", read \`GET <feedbackUrl>\` and
     \`GET <messagesUrl>?session=<sessionId>\` and act on everything you find.
6. **Iterate in the same session** (same sessionId) so the exchange stays one
   thread. Post progress notes via
   \`POST <messagesUrl> {"from":"agent","text":"…","sessionId":"<sid>"}\`;
   treat human replies as direction.

The decision JSON: \`decision.variant\` (0-based), \`decision.note\`, and
per-variant \`comments\` — each \`{text, x, y}\` with x/y as **percentages from
the canvas's left/top**, i.e. located feedback on that exact spot.

## Rules for the variant HTML

- One self-contained document per variant: \`<style>\` inline in \`<head>\`, no
  external assets except Google Fonts links, imagery as inline SVG/CSS
  gradients. No network calls — previews block them.
- Desktop-first at 1440px; must stay sane down to 390px. No JavaScript unless
  the design is meaningless without it. Real copy, never lorem ipsum.
- Name variants meaningfully — the name becomes their label in the gallery.
- Mocking a real app? Import a screenshot as a baseline
  (\`POST /api/projects/<id>/import\`), reproduce the current look faithfully,
  and change only what you're proposing.

## Full API

\`curl -s http://localhost:4011/agent.md\` — imports, exports, retries, and
Fabma's own generation engine (it can spawn \`claude\`/\`codex\` itself).
`;
}

export function buildCodexSnippet(ctx) {
	return `<!-- fabma-skill -->
## Fabma — human design review
When the user wants design options/mockups to choose from, write each option as a
self-contained HTML file (inline CSS, no external assets beyond Google Fonts links,
desktop-first 1440px, real copy) and push them into the local Fabma app:
${ctx.cliUsable
		? `\`node ${ctx.root}/bin/fabma.js drop a.html b.html --project <id> --title "…" --note "…"\``
		: '`POST http://localhost:4011/api/drop {"projectId?","sessionId?","title","note","variants":[{name,html}]}`'}
Pick the project via GET /api/projects (ask the human if one already fits; create with
POST /api/projects otherwise) and read prior sessions via GET /api/projects/<id> first.
Then tell the human to review in Fabma and END YOUR TURN; when they say "continue",
read GET <feedbackUrl> (their pick + pinned comments with % coordinates) and
GET <messagesUrl>?session=<sid> (their replies) and act on them. Iterate into the
same sessionId. Full protocol: http://localhost:4011/agent.md${ctx.cliUsable ? ` — start the
server if needed: \`node ${ctx.root}/bin/fabma.js --no-open &\`` : ' (macOS: `open -a Fabma`)'}.
<!-- /fabma-skill -->`;
}

// Installs for Claude Code (~/.claude/skills/fabma) and optionally appends an
// idempotent block to ~/.codex/AGENTS.md. Returns human-readable result lines.
export function installSkill(rootDir, { codex = false } = {}) {
	const home = os.homedir();
	const ctx = skillContext(rootDir);
	const results = [];

	const skillDir = path.join(home, '.claude', 'skills', 'fabma');
	fs.mkdirSync(skillDir, { recursive: true });
	fs.writeFileSync(path.join(skillDir, 'SKILL.md'), buildSkillMarkdown(ctx));
	results.push(`Claude Code skill installed: ${path.join(skillDir, 'SKILL.md')}`);

	if (codex) {
		const codexDir = path.join(home, '.codex');
		if (!fs.existsSync(codexDir)) {
			results.push('~/.codex not found — is Codex installed? Skipped its AGENTS.md.');
		} else {
			const agentsFile = path.join(codexDir, 'AGENTS.md');
			const current = fs.existsSync(agentsFile) ? fs.readFileSync(agentsFile, 'utf8') : '';
			const snippet = buildCodexSnippet(ctx);
			const updated = current.includes('<!-- fabma-skill -->')
				? current.replace(/<!-- fabma-skill -->[\s\S]*?<!-- \/fabma-skill -->/, snippet)
				: `${current.trimEnd()}\n\n${snippet}\n`;
			fs.writeFileSync(agentsFile, updated);
			results.push(`Codex instructions ${current.includes('<!-- fabma-skill -->') ? 'updated' : 'added'}: ${agentsFile}`);
		}
	}
	return results;
}
