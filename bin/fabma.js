#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
	console.log(`
  fabma — the AI-native design playground

  Usage
    fabma [workspace] [options]           start the playground
    fabma drop <files...> [options]       push HTML variants into a fresh
                                          session (starts the server if needed)
    fabma skill install [--codex]         teach your agents to use fabma:
                                          installs the Claude Code skill, and
                                          with --codex adds a section to
                                          ~/.codex/AGENTS.md
    fabma skill print                     print the agent snippet to paste
                                          into any AGENTS.md / CLAUDE.md

  Start options
    -p, --port <n>    Port (default: 4011 — 0xFAB, or $FABMA_PORT)
    --no-open         Don't open the browser

  Drop options (for agents and scripts)
    --title <text>    Session title shown to the human
    --note <text>     What you want feedback on
    --wait            Block until the human decides, print the decision JSON
    -p, --port <n>    Port of the running playground (default: 4011)

  Providers (auto-detected)
    claude            Claude Code CLI on PATH, logged in
    codex             Codex CLI on PATH, logged in
    ANTHROPIC_API_KEY Anthropic API without any CLI
`);
	process.exit(0);
}

if (args[0] === 'drop') {
	drop(args.slice(1)).catch((err) => {
		console.error(`fabma drop failed: ${err.message}`);
		process.exit(1);
	});
} else if (args[0] === 'skill') {
	skill(args.slice(1));
} else {
	let workspace;
	let port;
	let open = true;
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		if (arg === '--no-open') open = false;
		else if (arg === '--port' || arg === '-p') port = Number(args[++i]);
		else if (!arg.startsWith('-')) workspace = arg;
	}
	const { start } = await import('../server/index.js');
	start({ workspace, port: port || undefined, open });
}

function skill(rest) {
	const os = process.env.HOME || process.env.USERPROFILE;
	const root = path.resolve(__dirname, '..');
	const template = fs.readFileSync(path.join(root, 'skill', 'SKILL.md'), 'utf8')
		.replaceAll('{{FABMA_DIR}}', root);

	const snippet = `<!-- fabma-skill -->
## Fabma — human design review
When the user wants design options/mockups to choose from, write each option as a
self-contained HTML file (inline CSS, no external assets beyond Google Fonts links,
desktop-first 1440px, real copy), then run:
\`node ${root}/bin/fabma.js drop a.html b.html --title "…" --wait\`
It shows a local gallery, blocks until the human picks a variant and pins comments,
then prints their decision as JSON (variant index, note, comments with % coordinates).
Full protocol: http://localhost:4011/agent.md — start the server if needed with
\`node ${root}/bin/fabma.js --no-open &\`.
<!-- /fabma-skill -->`;

	if (rest[0] === 'print') {
		console.log(snippet);
		return;
	}
	if (rest[0] !== 'install') {
		console.error('usage: fabma skill install [--codex] | fabma skill print');
		process.exit(1);
	}

	const skillDir = path.join(os, '.claude', 'skills', 'fabma');
	fs.mkdirSync(skillDir, { recursive: true });
	fs.writeFileSync(path.join(skillDir, 'SKILL.md'), template);
	console.log(`Claude Code skill installed: ${path.join(skillDir, 'SKILL.md')}`);

	if (rest.includes('--codex')) {
		const codexDir = path.join(os, '.codex');
		if (!fs.existsSync(codexDir)) {
			console.log('~/.codex not found — is Codex installed? Skipped. Use `fabma skill print` to add it manually.');
			return;
		}
		const agentsFile = path.join(codexDir, 'AGENTS.md');
		const current = fs.existsSync(agentsFile) ? fs.readFileSync(agentsFile, 'utf8') : '';
		const updated = current.includes('<!-- fabma-skill -->')
			? current.replace(/<!-- fabma-skill -->[\s\S]*?<!-- \/fabma-skill -->/, snippet)
			: `${current.trimEnd()}\n\n${snippet}\n`;
		fs.writeFileSync(agentsFile, updated);
		console.log(`Codex instructions ${current.includes('<!-- fabma-skill -->') ? 'updated' : 'added'}: ${agentsFile}`);
	}
}

async function drop(rest) {
	const files = [];
	let title;
	let note;
	let wait = false;
	let port = Number(process.env.FABMA_PORT) || 4011;
	for (let i = 0; i < rest.length; i += 1) {
		const arg = rest[i];
		if (arg === '--title') title = rest[++i];
		else if (arg === '--note') note = rest[++i];
		else if (arg === '--wait') wait = true;
		else if (arg === '--port' || arg === '-p') port = Number(rest[++i]);
		else files.push(arg);
	}
	if (!files.length) throw new Error('no files given — usage: fabma drop a.html b.html [--title t] [--wait]');

	const base = `http://localhost:${port}`;
	await ensureServer(base, port);

	const variants = files.map((file) => ({
		name: path.basename(file).replace(/\.html?$/i, ''),
		html: fs.readFileSync(file, 'utf8'),
	}));
	const response = await fetch(`${base}/api/drop`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ title, note, variants }),
	});
	if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
	const session = await response.json();

	console.log(`Session ready: ${session.url}`);
	console.log(`Feedback:      ${session.feedbackUrl}`);

	// If the Fabma desktop app is serving, it shows the session by itself —
	// just bring it to front. Otherwise open the browser.
	const health = await fetch(`${base}/api/health`).then((r) => r.json()).catch(() => ({}));
	if (health.flavor === 'desktop' && process.platform === 'darwin') {
		spawn('open', ['-a', 'Fabma'], { stdio: 'ignore', detached: true }).unref();
	} else {
		openBrowser(session.url);
	}

	if (!wait) return;
	console.error('Waiting for the human to pick a variant…');
	for (;;) {
		const poll = await fetch(`${session.feedbackUrl}?wait=55`);
		const feedback = await poll.json();
		if (feedback.status === 'decided') {
			console.log(JSON.stringify(feedback, null, 2));
			return;
		}
	}
}

async function ensureServer(base, port) {
	if (await healthy(base)) return;
	const server = spawn(process.execPath, [path.join(__dirname, 'fabma.js'), '--no-open', '--port', String(port)], {
		detached: true,
		stdio: 'ignore',
	});
	server.unref();
	for (let i = 0; i < 20; i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 500));
		if (await healthy(base)) return;
	}
	throw new Error(`could not start the fabma server on port ${port}`);
}

async function healthy(base) {
	try {
		const response = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1500) });
		return response.ok;
	} catch {
		return false;
	}
}

function openBrowser(url) {
	const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
	try {
		spawn(cmd, [url], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' }).unref();
	} catch { /* URL is printed */ }
}
